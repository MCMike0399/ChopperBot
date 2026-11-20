import type { Client, Message } from "discord.js";
import { log } from "../../log.js";
import { deleteMaliciousMessage } from "./actions.js";
import {
   appendMaliciousFooter,
   renderLine,
   renderScanMessage,
   type FileLine,
   type LineStatus,
} from "./format.js";
import type { FileScanner } from "./scanner.js";
import type { FileScannerStore, PendingScanRow } from "./store.js";

/**
 * Delay before each successive re-check of a still-running analysis, indexed by
 * the attempts already made. Starts soon (a VT analysis usually finishes within
 * a couple of minutes of the poll budget), then backs off to 10 min so a slow
 * file costs a handful of lookups instead of hammering the daily budget.
 */
export const PENDING_BACKOFF_MS = [60_000, 120_000, 180_000, 300_000, 600_000];

/** Attempts before we stop waiting and say so on the card (~1.5 h). */
export const PENDING_MAX_ATTEMPTS = 10;

/** When the row checked `attempts` times should be tried again. */
export function nextPendingCheck(attempts: number, nowMs: number): number {
   const idx = Math.min(Math.max(attempts, 0), PENDING_BACKOFF_MS.length - 1);
   return nowMs + PENDING_BACKOFF_MS[idx];
}

export interface PendingReconcilerDeps {
   scanner: FileScanner;
   store: FileScannerStore;
   client: Client;
   /** Delete the upload message when a late verdict turns out malicious. */
   deleteMalicious: boolean;
   /** Sweep cadence. */
   tickMs?: number;
   /** Rows checked per sweep (keeps one sweep from hogging the VT queue). */
   maxPerTick?: number;
   maxAttempts?: number;
   now?: () => number;
}

/** Minimal shape of a channel that can fetch/hold messages (real or faked). */
interface MessageChannel {
   messages: { fetch(id: string): Promise<Message> };
   send?: (content: string) => Promise<unknown>;
   isSendable?: () => boolean;
}

function isMessageChannel(c: unknown): c is MessageChannel {
   return (
      !!c &&
      typeof (c as MessageChannel).messages?.fetch === "function" &&
      typeof (c as { send?: unknown }).send === "function"
   );
}

/**
 * Closes the loop on analyses that outlived the synchronous poll budget.
 *
 * A fresh upload that VirusTotal hasn't finished analyzing yields `pending`;
 * before this existed, that was the end of the story — the card sat on "aún lo
 * está analizando" forever even though VirusTotal finished the job minutes
 * later (only a later re-upload ever surfaced the verdict). The watcher now
 * persists those scans in `file_scanner_pending`; this sweeper re-checks each
 * one by hash (one budgeted lookup, no upload), and when the verdict lands it
 * edits the original card in place — and, for a malicious file, deletes the
 * upload message exactly like the synchronous path does. Rows survive restarts,
 * so a deploy mid-wait doesn't strand anything.
 */
export class PendingReconciler {
   private readonly now: () => number;
   private readonly tickMs: number;
   private readonly maxPerTick: number;
   private readonly maxAttempts: number;
   private timer: NodeJS.Timeout | null = null;
   private sweeping = false;

   constructor(private readonly deps: PendingReconcilerDeps) {
      this.now = deps.now ?? (() => Date.now());
      this.tickMs = deps.tickMs ?? 30_000;
      this.maxPerTick = deps.maxPerTick ?? 3;
      this.maxAttempts = deps.maxAttempts ?? PENDING_MAX_ATTEMPTS;
   }

   start(): void {
      if (this.timer) return;
      this.timer = setInterval(() => void this.sweep(), this.tickMs);
      this.timer.unref?.();
      log.info(
         {
            tickMs: this.tickMs,
            maxPerTick: this.maxPerTick,
            maxAttempts: this.maxAttempts,
            waiting: this.deps.store.pendingCount(),
         },
         "file_scanner.pending.reconciler_started",
      );
      // Sweep once right away: rows that were pending across a restart shouldn't
      // wait a full tick (or worse, until the next message arrives).
      void this.sweep();
   }

   stop(): void {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
   }

   /** One pass over the due rows. Returns how many were checked. Safe to call directly (tests). */
   async sweep(): Promise<number> {
      if (this.sweeping) return 0;
      this.sweeping = true;
      try {
         const due = this.deps.store.duePending(this.now(), this.maxPerTick);
         for (const row of due) await this.check(row);
         return due.length;
      } catch (err) {
         log.error({ err }, "file_scanner.pending.sweep_error");
         return 0;
      } finally {
         this.sweeping = false;
      }
   }

   private async check(row: PendingScanRow): Promise<void> {
      const now = this.now();
      const fileName = row.file_name ?? "(sin nombre)";
      const attempts = row.attempts + 1;
      const outcome = await this.deps.scanner.recheckByHash(row.sha256, {
         fileName,
         uploader: row.uploader,
      });

      if (!outcome) {
         if (attempts >= this.maxAttempts) {
            log.warn(
               { sha256: row.sha256, attempts, fileName },
               "file_scanner.pending.expired",
            );
            await this.renderResolution(
               row,
               { kind: "unresolved", sha256: row.sha256 },
               false,
            );
            this.deps.store.resolvePending(row.sha256);
            return;
         }
         this.deps.store.reschedulePending(row.sha256, {
            attempts,
            nextCheckAt: nextPendingCheck(attempts, now),
            lastCheckedAt: now,
         });
         log.info(
            { sha256: row.sha256, attempts, fileName },
            "file_scanner.pending.rescheduled",
         );
         return;
      }

      let deleted = false;
      if (outcome.verdict === "malicious") {
         deleted = await this.deleteSource(row, fileName);
      }
      await this.renderResolution(row, outcome, deleted);
      this.deps.store.resolvePending(row.sha256);
      log.info(
         {
            sha256: row.sha256,
            verdict: outcome.verdict,
            attempts,
            deleted,
            fileName,
         },
         "file_scanner.pending.resolved",
      );
   }

   /** Delete the original upload now that a late verdict says malicious. */
   private async deleteSource(
      row: PendingScanRow,
      fileName: string,
   ): Promise<boolean> {
      try {
         const channel = await this.deps.client.channels.fetch(
            row.source_channel_id,
         );
         if (!isMessageChannel(channel)) {
            log.warn(
               { channelId: row.source_channel_id, sha256: row.sha256 },
               "file_scanner.pending.source_unavailable",
            );
            return false;
         }
         const message = await channel.messages.fetch(row.source_message_id);
         return await deleteMaliciousMessage(message, {
            enabled: this.deps.deleteMalicious,
            fileName,
         });
      } catch (err) {
         log.warn(
            { err, channelId: row.source_channel_id, sha256: row.sha256 },
            "file_scanner.pending.source_unavailable",
         );
         return false;
      }
   }

   /**
    * Rewrite the pending line of the original card into its final verdict. The
    * pending block is regenerated with `renderLine` (the one renderer), so the
    * replacement is exact instead of a loose text match; if the card is gone or
    * was never posted, a fresh message carries the verdict instead of losing it.
    */
   private async renderResolution(
      row: PendingScanRow,
      status: LineStatus,
      deleted: boolean,
   ): Promise<void> {
      const fileName = row.file_name ?? "(sin nombre)";
      const pendingText = renderLine({
         fileName,
         status: { kind: "pending", sha256: row.sha256 },
      });
      const resolvedLine = renderLine({ fileName, status, deleted });

      let channel: unknown = null;
      try {
         channel = await this.deps.client.channels.fetch(row.card_channel_id);
      } catch (err) {
         log.warn(
            { err, channelId: row.card_channel_id },
            "file_scanner.pending.card_unavailable",
         );
      }
      const cardChannel = isMessageChannel(channel) ? channel : null;

      if (cardChannel && row.card_message_id) {
         try {
            const card = await cardChannel.messages.fetch(row.card_message_id);
            if (!card.content.includes(pendingText)) {
               log.info(
                  { sha256: row.sha256, cardMessageId: row.card_message_id },
                  "file_scanner.pending.card_stale",
               );
            } else {
               let content = card.content.replace(pendingText, resolvedLine);
               if (
                  typeof status === "object" &&
                  "kind" in status &&
                  status.kind === "verdict" &&
                  status.verdict === "malicious"
               ) {
                  content = appendMaliciousFooter(content);
               }
               await card.edit(content);
               log.info(
                  { sha256: row.sha256, cardMessageId: row.card_message_id },
                  "file_scanner.pending.card_updated",
               );
               return;
            }
         } catch (err) {
            log.warn(
               { err, cardMessageId: row.card_message_id },
               "file_scanner.pending.card_edit_failed",
            );
         }
      }

      // No card to edit (it failed to post, was deleted, or was rewritten):
      // post the verdict on its own so the result isn't lost.
      if (!cardChannel?.send) return;
      const lines: FileLine[] = [{ fileName, status, deleted }];
      try {
         await cardChannel.send(renderScanMessage(lines));
      } catch (err) {
         log.warn(
            { err, channelId: row.card_channel_id, sha256: row.sha256 },
            "file_scanner.pending.card_send_failed",
         );
      }
   }
}
