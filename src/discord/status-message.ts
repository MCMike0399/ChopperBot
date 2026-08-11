import type { Message } from 'discord.js';
import { log } from '../log.js';
import type { AskPhase } from '../llm/client.js';

/**
 * Web-LLM-style live progress for long agent turns (workshop sessions).
 *
 * Instead of a bare typing indicator + a tiny reaction, the bot posts ONE
 * status line as a Discord subtext message ("-# 🐍 Ejecutando código · paso 3
 * · 45s"), EDITS it in place as the turn progresses, and finally **morphs the
 * same message into the reply** — the spinner becomes the answer, no
 * delete-then-send flicker, no leftover noise. Aborted turns delete it;
 * failed turns edit it into the Spanish error.
 *
 * Edits are throttled (Discord rate-limits message edits) and every Discord
 * call is best-effort: a missing permission degrades to silence, never to a
 * broken turn.
 */

/** Minimum spacing between edits. */
const MIN_EDIT_INTERVAL_MS = 1500;

/** Friendly Spanish label for a tool call in progress. Exported for tests. */
export function toolLabel(toolName: string | undefined): string {
  if (!toolName) return '🛠️ Trabajando';
  if (toolName === 'workshop_run_python') return '🐍 Ejecutando código';
  if (toolName === 'workshop_doc_index') return '📚 Indexando el documento';
  if (toolName === 'workshop_doc_search') return '🔎 Buscando en el documento';
  if (toolName === 'workshop_doc_read') return '📖 Leyendo el documento';
  if (toolName === 'workshop_read_file') return '📖 Leyendo archivos';
  if (toolName === 'workshop_write_file') return '✍️ Escribiendo archivo';
  if (toolName === 'workshop_list_files') return '🗂️ Revisando el workspace';
  if (toolName === 'workshop_send_file') return '📎 Preparando tu archivo';
  if (toolName === 'workshop_rename_session') return '🏷️ Renombrando el canal';
  if (toolName.startsWith('workshop_')) return '🛠️ Gestionando la sesión';
  if (toolName.startsWith('calendar_')) return '📅 Consultando el calendario';
  if (toolName.startsWith('server_')) return '🗺️ Consultando canales';
  return `🛠️ Trabajando (${toolName})`;
}

/**
 * Compose the status line. Discord's `-# ` prefix renders as small gray
 * subtext — visually a spinner line, not a message. Pure — exported for tests.
 */
export function composeStatusText(input: {
  phase: AskPhase;
  toolName?: string;
  step: number;
  elapsedMs: number;
}): string {
  const base = input.phase === 'tool' ? toolLabel(input.toolName) : '🤔 Pensando…';
  const parts = [base];
  if (input.step > 0) parts.push(`paso ${input.step}`);
  const secs = Math.floor(input.elapsedMs / 1000);
  if (secs >= 20) {
    parts.push(secs < 120 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60 ? ` ${secs % 60}s` : ''}`);
  }
  return `-# ${parts.join(' · ')}`;
}

/**
 * How the status message reaches the channel. `post` places the FIRST message
 * (public channels pass a reply-sender so the bot's answer stays in the user's
 * reply chain — `buildHistory` walks it); `send` places follow-up chunks.
 */
export interface StatusMessageTarget {
  post: (content: string) => Promise<Message>;
  send: (content: string) => Promise<Message>;
}

type SendableChannel = StatusMessageTarget | { send: (content: string) => Promise<Message> };

/**
 * Normalize either shape into a target. The channel's `send` MUST be invoked as
 * a method — passing `channel.send` as a bare reference loses `this` and every
 * call throws inside discord.js (live 2026-08-06: that bug silently dropped
 * every workshop reply, because the failure was swallowed by a `.catch`).
 */
function asTarget(channel: SendableChannel): StatusMessageTarget {
  if ('post' in channel) return channel;
  return {
    post: (content) => channel.send(content),
    send: (content) => channel.send(content),
  };
}

export class LiveStatusMessage {
  private readonly target: StatusMessageTarget;
  private message: Message | null = null;
  private lastEditAt = 0;
  private pendingText: string | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private lastShownText = '';
  private finished = false;

  constructor(channel: SendableChannel) {
    this.target = asTarget(channel);
  }

  /** Post the initial status line. Failure → the instance degrades to no-op. */
  async start(text: string): Promise<void> {
    if (this.finished) return; // the turn already ended (fast turn won the race)
    this.lastShownText = text;
    this.lastEditAt = Date.now();
    this.message = await this.target.post(text).catch((err) => {
      // A missing permission is expected; anything else is a real defect and
      // must not stay invisible (see asTarget's note).
      log.warn({ err }, 'status_message.start_failed');
      return null;
    });
    // If the turn finished while the post was in flight, don't leave it behind.
    if (this.finished && this.message) {
      const stale = this.message;
      this.message = null;
      void stale.delete().catch(() => {});
    }
  }

  get active(): boolean {
    return this.message !== null && !this.finished;
  }

  /** Throttled in-place edit; the newest text always wins eventually. */
  update(text: string): void {
    if (!this.active || text === this.lastShownText) return;
    this.pendingText = text;
    const since = Date.now() - this.lastEditAt;
    if (since >= MIN_EDIT_INTERVAL_MS) {
      this.flush();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flush(), MIN_EDIT_INTERVAL_MS - since);
    }
  }

  private flush(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.active || this.pendingText === null) return;
    const text = this.pendingText;
    this.pendingText = null;
    this.lastShownText = text;
    this.lastEditAt = Date.now();
    void this.message!.edit(text).catch(() => {});
  }

  /**
   * Morph the status message into the reply: the first chunk replaces the
   * status text, remaining chunks are plain sends. Returns the LAST message
   * of the reply (the reply anchor), or null if everything failed.
   */
  async finishAsReply(parts: string[]): Promise<Message | null> {
    this.stopPending();
    this.finished = true;
    if (parts.length === 0) return null;
    let anchor: Message | null = null;
    if (this.message) {
      anchor = await this.message.edit(parts[0]).catch((err) => {
        log.warn({ err }, 'status_message.finish_edit_failed');
        return null;
      });
    }
    if (!anchor) {
      // No status message (never posted, perms, deleted) → normal first post.
      anchor = await this.target.post(parts[0]).catch((err) => {
        // The turn produced an answer and we failed to deliver it — never silent.
        log.error({ err }, 'status_message.reply_delivery_failed');
        return null;
      });
    }
    for (let i = 1; anchor && i < parts.length; i++) {
      anchor = await this.target.send(parts[i]).catch(() => anchor);
    }
    return anchor;
  }

  /** Turn failed: the status line becomes the (Spanish) error message. */
  async fail(text: string): Promise<void> {
    this.stopPending();
    this.finished = true;
    if (this.message) {
      await this.message.edit(text).catch(() => {});
    } else {
      await this.target.post(text).catch(() => {});
    }
  }

  /** Turn superseded (interrupt): remove the status line entirely. */
  async discard(): Promise<void> {
    this.stopPending();
    this.finished = true;
    if (this.message) {
      await this.message.delete().catch(() => {});
      this.message = null;
    }
  }

  private stopPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingText = null;
  }
}
