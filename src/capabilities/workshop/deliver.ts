import { basename } from "node:path";
import { AttachmentBuilder } from "discord.js";
import { log } from "../../log.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import { checkWorkshopFile } from "./artifact-check.js";
import { uploadToStorage } from "./storage.js";
import type { WorkshopFileRecord, WorkshopStore } from "./store.js";
import {
   batchForSend,
   listUndeliveredDeliverables,
   MAX_ATTACHMENTS_PER_MESSAGE,
   type SessionWorkspace,
   type WorkspaceFile,
} from "./workspace.js";

/**
 * The ONE place a workspace file becomes a Discord attachment.
 *
 * Before this module the watcher had two copies of the same bookkeeping (the
 * explicit `workshop_send_file` path and the auto-delivery net), and the net
 * sent one message per file — five consecutive "📎 casi se me pasa adjuntarlo"
 * messages in a single turn (live 2026-11-16) — plus, once a LibreOffice copy
 * lived in `recalc/`, the SAME basename twice with different sizes.
 *
 * Both entry points now share {@link attachBatch}: check, send, record the
 * manifest row, push the durable MinIO copy. The difference is only grouping:
 * a model-queued send keeps its own caption per file (that caption is part of
 * the answer the member reads), while the net delivers everything in a few
 * grouped messages with one honest caption.
 */

/** Minimal channel port — just what sending needs, so tests fake it cheaply. */
export interface DeliverChannel {
   isSendable(): boolean;
   send(payload: {
      content?: string;
      files?: AttachmentBuilder[];
   }): Promise<{ id: string }>;
}

/** The manifest surface delivery touches (real store, or a test double). */
export interface DeliverStore {
   recordFile(input: {
      channelId: string;
      relPath: string;
      messageId: string;
      bytes: number;
      nowMs: number;
   }): void;
   setStorageKey(
      channelId: string,
      relPath: string,
      storageKey: string | null,
   ): void;
   fileManifest(channelId: string): Array<Pick<WorkshopFileRecord, "rel_path">>;
}

export interface DeliverPort {
   channelId: string;
   channel: DeliverChannel;
   workspace: SessionWorkspace;
   store: DeliverStore;
   storage?: ObjectStorage | null;
   venvDir: string | null;
   now: () => number;
}

export interface DeliverOutcome {
   /** rel_paths that reached the channel this call. */
   sent: string[];
   /** rel_paths the artifact check refused (the member gets a short notice). */
   blocked: string[];
   /** rel_paths whose upload threw (network/Discord failure). */
   failed: string[];
}

export interface DeliverItem {
   relPath: string;
   caption: string | null;
}

/**
 * Attach one group of files as ONE message, then record each file in the
 * manifest (the ledger the model reads next turn) and upload its primary copy.
 * `files` must already have passed the artifact check.
 */
async function attachBatch(
   port: DeliverPort,
   files: Array<{ relPath: string }>,
   content: string | undefined,
   logTag:
      "workshop.file_sent" | "workshop.file_auto_send" = "workshop.file_sent",
): Promise<{ id: string } | null> {
   if (!port.channel.isSendable()) return null;
   const attachments = files.map(
      (f) =>
         new AttachmentBuilder(port.workspace.absolute(f.relPath), {
            name: basename(f.relPath),
         }),
   );
   const sent = await port.channel.send({ content, files: attachments });
   for (const f of files) {
      const bytes = port.workspace.stat(f.relPath).bytes;
      port.store.recordFile({
         channelId: port.channelId,
         relPath: f.relPath,
         messageId: sent.id,
         bytes,
         nowMs: port.now(),
      });
      if (port.storage) {
         await uploadToStorage(port.storage, port.store, {
            channelId: port.channelId,
            relPath: f.relPath,
            bytes: port.workspace.readBytes(f.relPath),
         });
      }
      log.info({ channelId: port.channelId, file: f.relPath }, logTag);
   }
   return sent;
}

/**
 * Run the structural check and partition into what may ship. Blocked files are
 * never attached and never recorded (a later rewrite can still be delivered).
 */
async function checkAll(
   port: DeliverPort,
   items: DeliverItem[],
): Promise<{ ok: DeliverItem[]; blocked: DeliverItem[] }> {
   const ok: DeliverItem[] = [];
   const blocked: DeliverItem[] = [];
   for (const item of items) {
      const check = await checkWorkshopFile(
         port.workspace,
         item.relPath,
         port.venvDir,
      );
      if (check.ok) {
         ok.push(item);
      } else {
         blocked.push(item);
         log.warn(
            {
               channelId: port.channelId,
               file: item.relPath,
               check,
            },
            "workshop.file_check_failed",
         );
      }
   }
   return { ok, blocked };
}

/** One short notice for everything the check refused — never one per file. */
async function notifyBlocked(
   port: DeliverPort,
   blocked: DeliverItem[],
): Promise<void> {
   if (blocked.length === 0 || !port.channel.isSendable()) return;
   const names = blocked.map((b) => `\`${basename(b.relPath)}\``).join(", ");
   await port.channel
      .send({
         content: `⚠️ No adjunté ${names}: no pasó la revisión del archivo. Pídeme corregirlo.`,
      })
      .catch(() => {});
}

/**
 * Deliver the files the MODEL queued with `workshop_send_file`: one message per
 * file so each keeps its own caption (it is part of the reply the member reads).
 */
export async function deliverQueuedFiles(
   port: DeliverPort,
   items: DeliverItem[],
): Promise<DeliverOutcome> {
   const outcome: DeliverOutcome = { sent: [], blocked: [], failed: [] };
   if (items.length === 0) return outcome;
   const { ok, blocked } = await checkAll(port, items);
   for (const item of ok) {
      try {
         const sent = await attachBatch(
            port,
            [item],
            item.caption ?? undefined,
         );
         if (sent) outcome.sent.push(item.relPath);
      } catch (err) {
         outcome.failed.push(item.relPath);
         log.warn({ err, file: item.relPath }, "workshop.file_send_failed");
         await port.channel
            .send({
               content: `⚠️ No pude subir \`${basename(item.relPath)}\` — inténtalo de nuevo.`,
            })
            .catch(() => {});
      }
   }
   await notifyBlocked(port, blocked);
   outcome.blocked.push(...blocked.map((b) => b.relPath));
   return outcome;
}

export interface AutoDeliverInput {
   /** Workspace snapshot taken BEFORE the turn (path → mtime). */
   before: Map<string, number>;
   /** rel_paths already delivered (manifest + everything queued this turn). */
   skip: ReadonlySet<string>;
   maxBytes: number;
   maxAttachments?: number;
}

/**
 * Auto-delivery safety net: attach whatever deliverable THIS turn created or
 * rewrote and nobody queued. Grouped — the member gets one message with the
 * files (plus continuation messages only past Discord's attachment cap) and one
 * honest caption, instead of one ping per file.
 */
export async function autoDeliverForgotten(
   port: DeliverPort,
   input: AutoDeliverInput,
): Promise<{ sent: string[]; blocked: string[] }> {
   const forgotten: WorkspaceFile[] = listUndeliveredDeliverables(
      input.before,
      port.workspace.list(),
      input.skip,
      input.maxBytes,
   );
   if (forgotten.length === 0) return { sent: [], blocked: [] };

   const { ok, blocked } = await checkAll(
      port,
      forgotten.map((f) => ({ relPath: f.path, caption: null })),
   );
   const batches = batchForSend(
      ok,
      input.maxAttachments ?? MAX_ATTACHMENTS_PER_MESSAGE,
   );
   const sent: string[] = [];
   for (const [index, batch] of batches.entries()) {
      const names = batch.map((b) => `\`${basename(b.relPath)}\``).join(", ");
      const content =
         index === 0
            ? `📎 Te dejo adjunto lo que se generó en esta vuelta: ${names}`
            : `📎 …y esto más: ${names}`;
      try {
         const message = await attachBatch(
            port,
            batch,
            content,
            "workshop.file_auto_send",
         );
         if (message) sent.push(...batch.map((b) => b.relPath));
      } catch (err) {
         log.warn(
            { err, files: batch.map((b) => b.relPath) },
            "workshop.file_auto_send_failed",
         );
      }
   }
   await notifyBlocked(port, blocked);
   return { sent, blocked: blocked.map((b) => b.relPath) };
}
