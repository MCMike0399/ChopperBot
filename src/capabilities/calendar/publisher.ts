import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AttachmentBuilder, type Client } from 'discord.js';
import { log } from '../../log.js';
import type { CalendarStore } from './store.js';
import { renderMonthPdf, hasTemplateFor, templateFileFor } from './render.js';
import { buildCalendar, type IcsEvent } from './ics.js';
import type { OccurrenceOverride } from './recurrence.js';
import { pdfToPng } from './raster.js';
import { monthWindowUtc, monthKeyOfUtc } from './grid.js';
import { formatInTimezone } from './time.js';

/** Rasterization DPI for the inline PNG (1440×810pt → ~3000×1688px). */
const PNG_DPI = 150;
let rasterWarned = false;

const MONTH_NAMES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export interface PublishSummary {
  /** Artifacts (re)posted, e.g. ["2026-06", "ics"]. */
  posted: string[];
  /** Month cards removed because they're no longer wanted. */
  removed: string[];
  /** Months requested but missing a template (skipped). */
  skipped: string[];
  ok: boolean;
  error?: string;
}

/**
 * Publishes the global calendar to the output channel and refreshes the ICS.
 * Implemented by {@link OutputChannelPublisher}; the interface lets the tool
 * source/capability inject a fake in tests (where there's no Discord client).
 */
export interface CalendarPublisher {
  /** The configured output channel id, or null if none is set. */
  outputChannelId(): string | null;
  /**
   * Reconcile the output channel with the current DB state: post/update the
   * desired month cards + ICS, and delete cards that are no longer wanted.
   * Best-effort — never throws. Idempotent.
   */
  reconcile(): Promise<PublishSummary>;
}

/** The minimal event shape {@link desiredMonthKeys} needs. */
export interface MonthCardEvent {
  start_at: number;
  recurrence_freq: string | null;
}

/**
 * Which months should have a card in the output channel right now — the pure
 * core of the publisher's reconcile, so the board's shape is testable without
 * Discord. The board is a **live board, not an archive**:
 *
 *  - the CURRENT month, always (that's where a recurring series shows, and it
 *    guarantees the month-rollover publish has something to post even before
 *    anyone books anything — the caption reads "sin eventos por ahora");
 *  - every FUTURE month containing a ONE-OFF event, so something already booked
 *    ahead is visible;
 *  - never a PAST month, and never a future month that only a recurring series
 *    would fill (one weekly event must not blast a card for every remaining
 *    month of the year).
 *
 * Months without a calibrated template are dropped — there's nothing to render.
 * Month keys are "YYYY-MM", so string comparison is chronological.
 */
export function desiredMonthKeys(events: readonly MonthCardEvent[], nowMs: number): string[] {
  const current = monthKeyOfUtc(nowMs);
  const set = new Set<string>();
  if (hasTemplateFor(current)) set.add(current);
  for (const e of events) {
    if (e.recurrence_freq !== null) continue; // recurring never spawns future cards
    const k = monthKeyOfUtc(e.start_at);
    if (k <= current) continue;              // past months are pruned; current already added
    if (hasTemplateFor(k)) set.add(k);
  }
  return [...set].sort();
}

/** Verdict of {@link monthPublishAction} — what the rollover watcher should do. */
export type MonthPublishAction = 'publish' | 'already_published' | 'no_template';

/**
 * Whether the current month's board still needs posting.
 *
 * This is the whole month-rollover trigger, kept pure and stateless on purpose:
 * there is no "last rollover" timestamp to drift, go stale across a restart, or
 * need a migration. {@link desiredMonthKeys} always keeps a card for the current
 * month, and `calendar_published` holds one row per posted card — so a MISSING
 * `pdf:<currentMonth>` row means exactly "this month hasn't been published yet".
 *
 * Consequences worth keeping true: a restart can't double-post (the row lives in
 * SQLite), and a publish that fails leaves the row absent so the next check
 * retries by itself.
 */
export function monthPublishAction(
  currentMonthKey: string,
  isPublished: (pubKey: string) => boolean,
): MonthPublishAction {
  if (!hasTemplateFor(currentMonthKey)) return 'no_template';
  return isPublished(`pdf:${currentMonthKey}`) ? 'already_published' : 'publish';
}

export interface OutputChannelPublisherDeps {
  client: Client;
  store: CalendarStore;
  projectRoot: string;
  /** Resolves the output channel id at call time (DB setting → config fallback). */
  getOutputChannelId: () => string | null;
}

/** The minimal slice of a Discord text channel the publisher needs. */
interface SendableTextChannel {
  send(options: { content: string; files: AttachmentBuilder[] }): Promise<{ id: string }>;
  messages: {
    fetch(id: string): Promise<{
      id: string;
      edit(options: { content: string; files: AttachmentBuilder[]; attachments: [] }): Promise<unknown>;
    }>;
    delete(id: string): Promise<unknown>;
  };
}

/**
 * Posts one message per month (the rendered PDF) and one for the ICS, editing
 * them in place on subsequent changes so the output channel stays a tidy live
 * board instead of an append log. Message ids are tracked in
 * `calendar_published` so edits survive restarts.
 */
export class OutputChannelPublisher implements CalendarPublisher {
  constructor(private readonly deps: OutputChannelPublisherDeps) {}

  outputChannelId(): string | null {
    return this.deps.getOutputChannelId();
  }

  private desiredMonths(): string[] {
    return desiredMonthKeys(this.deps.store.listAll(), Date.now());
  }

  async reconcile(): Promise<PublishSummary> {
    const channelId = this.deps.getOutputChannelId();
    if (!channelId) return { posted: [], removed: [], skipped: [], ok: false, error: 'no_output_channel' };
    const summary: PublishSummary = { posted: [], removed: [], skipped: [], ok: true };
    try {
      const channel = await this.deps.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        return { posted: [], removed: [], skipped: [], ok: false, error: 'output_channel_not_sendable' };
      }
      const sendable = channel as unknown as SendableTextChannel;
      const events = this.deps.store.listAll();
      const overrides = this.deps.store.overridesByMaster();
      const desired = this.desiredMonths();

      // 1) Render PDF + PNG hero for each desired month concurrently (pdftoppm
      // runs as separate processes), then post/update sequentially.
      const payloads = await Promise.all(
        desired.map(async (monthKey) => {
          const file = templateFileFor(monthKey)!; // desired months are template-gated
          const templateBytes = new Uint8Array(await readFile(resolve(this.deps.projectRoot, 'calendar', file)));
          const pdf = await renderMonthPdf({ monthKey, events, overrides, templateBytes });
          const files: AttachmentBuilder[] = [];
          try {
            const png = await pdfToPng(pdf, PNG_DPI);
            files.push(new AttachmentBuilder(Buffer.from(png), { name: `Calendario-Revolucion-Z-${monthKey}.png` }));
          } catch (err) {
            if (!rasterWarned) {
              rasterWarned = true;
              log.warn({ err }, 'calendar.raster_failed (falling back to PDF; is pdftoppm installed?)');
            }
          }
          if (files.length === 0) {
            files.push(new AttachmentBuilder(Buffer.from(pdf), { name: `Calendario-Revolucion-Z-${monthKey}.pdf` }));
          }
          return { monthKey, files };
        }),
      );
      for (const p of payloads) {
        await this.sendOrEdit(sendable, channelId, `pdf:${p.monthKey}`, {
          content: monthCaption(p.monthKey, this.countInMonth(p.monthKey)),
          files: p.files,
        });
        summary.posted.push(p.monthKey);
      }

      // 2) Delete any tracked month card that is no longer desired (recurring-only
      // future months, or months whose events were removed) so the channel only
      // ever shows the current month + months with one-off events.
      const desiredSet = new Set(desired);
      for (const row of this.deps.store.listPublished()) {
        if (!row.pub_key.startsWith('pdf:')) continue;
        const monthKey = row.pub_key.slice(4);
        if (desiredSet.has(monthKey)) continue;
        if (row.channel_id === channelId) await this.deleteMessage(sendable, row.message_id);
        this.deps.store.clearPublished(row.pub_key);
        summary.removed.push(monthKey);
      }

      // 3) Refresh the master ICS (with per-occurrence exceptions).
      const icsOverrides = new Map(
        [...overrides].map(([id, m]) => [id, [...m.values()]] as [number, OccurrenceOverride[]]),
      );
      await this.publishIcs(sendable, channelId, events, icsOverrides);
      summary.posted.push('ics');
      log.info({ posted: summary.posted, removed: summary.removed }, 'calendar.publish');
      return summary;
    } catch (err) {
      log.error({ err }, 'calendar.publish_failed');
      return { ...summary, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async deleteMessage(channel: SendableTextChannel, messageId: string): Promise<void> {
    try {
      await channel.messages.delete(messageId);
    } catch {
      /* already deleted / no perms — best-effort */
    }
  }

  private countInMonth(monthKey: string): number {
    const [y, m] = monthKey.split('-').map(Number);
    const { startMs, endMs } = monthWindowUtc(y, m);
    return this.deps.store.listOccurrences(startMs, endMs - 1).length;
  }

  private async publishIcs(
    channel: SendableTextChannel,
    channelId: string,
    events: IcsEvent[],
    overrides: ReadonlyMap<number, OccurrenceOverride[]>,
  ): Promise<void> {
    const text = buildCalendar(
      events.map((e) => ({
        id: e.id, title: e.title, description: e.description, location: e.location,
        start_at: e.start_at, end_at: e.end_at,
        recurrence_freq: e.recurrence_freq, recurrence_until: e.recurrence_until,
      })),
      { nowMs: Date.now(), overrides },
    );
    const att = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: 'revolucion-z.ics' });
    await this.sendOrEdit(channel, channelId, 'ics', {
      content:
        '📥 **Lleva el calendario a tu celular** — descarga `revolucion-z.ics` y ábrelo para agregar todos los eventos a tu app de calendario (Google, Apple, Outlook).',
      files: [att],
    });
  }

  /**
   * Edit the tracked message for `pubKey` in place, or post a new one (and
   * track it) if there's none or the old one was deleted.
   */
  private async sendOrEdit(
    channel: SendableTextChannel,
    channelId: string,
    pubKey: string,
    payload: { content: string; files: AttachmentBuilder[] },
  ): Promise<void> {
    const tracked = this.deps.store.getPublished(pubKey);
    if (tracked && tracked.channel_id === channelId) {
      try {
        const existing = await channel.messages.fetch(tracked.message_id);
        await existing.edit({ content: payload.content, files: payload.files, attachments: [] });
        this.deps.store.setPublished(pubKey, channelId, existing.id);
        return;
      } catch {
        // Message deleted or uneditable → fall through to a fresh post.
        this.deps.store.clearPublished(pubKey);
      }
    }
    const sent = await channel.send({ content: payload.content, files: payload.files });
    this.deps.store.setPublished(pubKey, channelId, sent.id);
  }
}

function monthCaption(monthKey: string, eventCount: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const name = MONTH_NAMES_ES[m - 1];
  const titled = name.charAt(0).toUpperCase() + name.slice(1);
  const count = eventCount === 0
    ? 'sin eventos por ahora'
    : eventCount === 1
      ? '1 evento'
      : `${eventCount} eventos`;
  const stamp = formatInTimezone(Date.now());
  return `📅 **Calendario Revolución Z — ${titled} ${y}** (${count})\n*Actualizado: ${stamp}*`;
}
