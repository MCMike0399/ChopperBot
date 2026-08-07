import { AttachmentBuilder } from 'discord.js';
import { basename } from 'node:path';
import type { WorkshopFileRecord, WorkshopStore } from './store.js';
import type { SessionWorkspace } from './workspace.js';

/**
 * "Limpiar" keeps the files — and this module makes that VISIBLE: after the
 * purge it re-posts every manifest file (user uploads + bot deliverables) in a
 * single 📁 message, points the manifest at the new message and deletes the
 * old carrier messages, so the channel is a real clean slate instead of a
 * scattering of surviving upload messages.
 *
 * Discord remains the durable store: the new message becomes each file's
 * carrier (rehydration re-downloads from it if the local copy is GC'd). A
 * file too big for the bot's upload cap can't be re-attached, so its original
 * carrier message is kept and the listing says where to find it. Old carriers
 * are deleted ONLY after their file landed on a new message — a failed send
 * leaves duplication, never data loss.
 */

/** Discord allows at most this many attachments per message. */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Long listings are truncated in the message text (the files still attach). */
const MAX_LIST_LINES = 20;

export interface ArchivePlan {
  /** Files that fit the send cap and will ride the new 📁 message. */
  attach: WorkshopFileRecord[];
  /** Files over the cap: their original carrier message must survive. */
  keepInPlace: WorkshopFileRecord[];
}

/** Pure partition — unit-tested. */
export function planArchive(records: WorkshopFileRecord[], maxSendBytes: number): ArchivePlan {
  const attach: WorkshopFileRecord[] = [];
  const keepInPlace: WorkshopFileRecord[] = [];
  for (const rec of records) {
    (rec.bytes <= maxSendBytes ? attach : keepInPlace).push(rec);
  }
  return { attach, keepInPlace };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function listLines(records: WorkshopFileRecord[]): string[] {
  return records.map((r) => `• \`${r.rel_path}\` (${formatBytes(r.bytes)})`);
}

/**
 * The 📁 message text: files grouped into uploads vs generated, capped so the
 * content stays well under Discord's 2000-char limit. Pure — unit-tested.
 */
export function renderArchiveContent(plan: ArchivePlan, maxSendBytes: number): string {
  const uploads = plan.attach.filter((r) => r.rel_path.startsWith('uploads/'));
  const generated = plan.attach.filter((r) => !r.rel_path.startsWith('uploads/'));
  const lines: string[] = ['📁 **Archivos del taller** — sobrevivieron la limpieza:'];
  if (uploads.length > 0) lines.push('📥 **Subidos por ti**', ...listLines(uploads));
  if (generated.length > 0) lines.push('🛠️ **Generados aquí**', ...listLines(generated));
  if (plan.keepInPlace.length > 0) {
    lines.push(
      `📌 **Siguen en su mensaje original** (pesan más de ${formatBytes(maxSendBytes)}, el tope de subida):`,
      ...listLines(plan.keepInPlace),
    );
  }
  if (lines.length > MAX_LIST_LINES + 2) {
    const kept = lines.slice(0, MAX_LIST_LINES);
    kept.push(`• … y ${lines.length - MAX_LIST_LINES} más`);
    return kept.join('\n');
  }
  return lines.join('\n');
}

/** The narrow Discord surface the driver needs (a TextChannel satisfies it). */
export interface ArchiveChannel {
  send(payload: { content: string; files?: AttachmentBuilder[] }): Promise<{ id: string }>;
  messages: { delete(messageId: string): Promise<unknown> };
}

export interface ArchiveDeps {
  channelId: string;
  store: Pick<WorkshopStore, 'fileManifest' | 'recordFile' | 'removeFileRecord'>;
  workspace: SessionWorkspace;
  channel: ArchiveChannel;
  nowMs: () => number;
  maxSendBytes: number;
}

export interface ArchiveResult {
  attached: number;
  keptInPlace: number;
  postedMessageIds: string[];
  oldCarriersDeleted: number;
}

/**
 * Post the consolidated 📁 message(s) for a session's manifest files, re-point
 * the manifest at them and delete the old carrier messages that are no longer
 * needed. The caller rehydrates missing local copies first; a file that is
 * STILL missing after that is truly gone and its record is dropped. Throws on
 * Discord failure — the caller treats the whole op as best-effort.
 */
export async function archiveSessionFiles(deps: ArchiveDeps): Promise<ArchiveResult> {
  const { store, workspace, channel, channelId, nowMs, maxSendBytes } = deps;
  // Fresh bytes from disk (the local copy may have been restored just now).
  const records = store
    .fileManifest(channelId)
    .filter((rec) => {
      if (workspace.exists(rec.rel_path)) return true;
      // Truly gone (no local copy and rehydration already dropped the record's
      // carrier) — don't list a file nobody can recover.
      store.removeFileRecord(channelId, rec.rel_path);
      return false;
    })
    .map((rec) => ({ ...rec, bytes: workspace.stat(rec.rel_path).bytes }));

  const result: ArchiveResult = { attached: 0, keptInPlace: 0, postedMessageIds: [], oldCarriersDeleted: 0 };
  if (records.length === 0) return result;

  const plan = planArchive(records, maxSendBytes);
  result.keptInPlace = plan.keepInPlace.length;

  if (plan.attach.length > 0) {
    const oldCarrierIds = new Set(records.map((r) => r.message_id));
    for (let i = 0; i < plan.attach.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
      const batch = plan.attach.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE);
      const content =
        i === 0 ? renderArchiveContent(plan, maxSendBytes) : '📁 **Archivos del taller** (cont.)';
      const files = batch.map(
        (rec) => new AttachmentBuilder(workspace.absolute(rec.rel_path), { name: basename(rec.rel_path) }),
      );
      const sent = await channel.send({ content, files });
      result.postedMessageIds.push(sent.id);
      for (const rec of batch) {
        store.recordFile({
          channelId,
          relPath: rec.rel_path,
          messageId: sent.id,
          bytes: rec.bytes,
          nowMs: nowMs(),
        });
        result.attached += 1;
      }
    }

    // Delete old carriers that no manifest record still points at (the previous
    // 📁 message included). keepInPlace records were never re-pointed, so their
    // carriers survive — that's their durable copy.
    const stillReferenced = new Set([
      ...store.fileManifest(channelId).map((r) => r.message_id),
    ]);
    for (const oldId of oldCarrierIds) {
      if (stillReferenced.has(oldId) || result.postedMessageIds.includes(oldId)) continue;
      await channel.messages.delete(oldId).catch(() => {});
      result.oldCarriersDeleted += 1;
    }
  } else {
    // Everything is over the send cap: post the listing alone so the user knows
    // where each file lives (the original carriers stay untouched).
    await channel
      .send({ content: renderArchiveContent(plan, maxSendBytes) })
      .then((m) => result.postedMessageIds.push(m.id));
  }
  return result;
}
