import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Client } from "discord.js";
import { log } from "../../log.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import { ARTIFACTS, MIN_BURST_BYTES } from "./constants.js";
import {
   planBatches,
   readLedger,
   transcribeBatch,
   type PendingBurst,
} from "./live.js";
import {
   buildTimeline,
   renderTranscript,
   type ChatNote,
   type SpeechBurst,
} from "./draft.js";
import {
   generateMinutes,
   renderMinutesPost,
   type MinutesMeta,
} from "./minutes.js";
import { minioPrefixFor, type SessionManifest } from "./session.js";
import type { MinutasSessionRow, MinutasStore } from "./store.js";
import { publishMinutes } from "./publisher.js";
import type { Transcriber } from "./transcriber.js";

export interface FinalizeDeps {
   store: MinutasStore;
   storage: ObjectStorage | null;
   transcriber: Transcriber;
   sessionsDir: string;
   client: Client;
}

export interface FinalizeResult {
   sessionId: string;
   empty: boolean;
   publishedUrl: string | null;
   minioPrefix: string | null;
}

interface ChatLine {
   t: number;
   author: string;
   content: string;
}

/**
 * Turn a closed session's on-disk capture into the published minutes:
 * PCM bursts → WAV → whisper → merged timeline draft → LLM minutes →
 * #minutas post → structured upload to MinIO → local cleanup. Driven purely
 * by the session dir + DB row, so it works the same for a normal
 * `/chopperbot-leave` and for the boot sweep recovering a crashed session.
 */
export async function finalizeSession(
   deps: FinalizeDeps,
   sessionId: string,
): Promise<FinalizeResult> {
   const row = deps.store.getSession(sessionId);
   if (!row) throw new Error(`finalizeSession: no DB row for ${sessionId}`);
   const dir = join(deps.sessionsDir, sessionId);
   if (!existsSync(dir))
      throw new Error(`finalizeSession: no session dir ${dir}`);

   const manifest = await readManifest(dir, row);

   // ── 1. Transcribe every captured burst ────────────────────────────────────
   const bursts = await transcribeBursts(deps, dir, manifest);

   // ── 2. Merge speech + chat into the draft timeline ────────────────────────
   const chat = await readChat(dir, manifest.startedAt);
   const timeline = buildTimeline(bursts, chat);
   const transcriptMd = renderTranscript(timeline);
   await writeFile(
      join(dir, ARTIFACTS.transcript),
      timeline.map((e) => JSON.stringify(e)).join("\n") +
         (timeline.length ? "\n" : ""),
   );
   await writeFile(join(dir, ARTIFACTS.draft), transcriptMd + "\n");

   const participants = Object.values(manifest.participants);
   const durationMs = (row.ended_at ?? Date.now()) - manifest.startedAt;
   const stats = {
      bursts: bursts.length,
      speechSegments: timeline.filter((e) => e.kind === "speech").length,
      chatLines: chat.length,
      participants: participants.length,
      durationMs,
   };

   // ── 3. Empty session → no minutes, nothing published ──────────────────────
   if (timeline.length === 0) {
      const prefix = minioPrefixFor(row);
      const uploaded = await uploadAll(deps, dir, row, prefix);
      if (uploaded) {
         await rm(dir, { recursive: true, force: true });
      }
      deps.store.updateSession(sessionId, {
         status: "done",
         stats_json: JSON.stringify({
            ...stats,
            empty: true,
            minioUploaded: uploaded,
         }),
         minio_prefix: prefix,
      });
      log.info({ sessionId }, "minutas.finalized_empty");
      return {
         sessionId,
         empty: true,
         publishedUrl: null,
         minioPrefix: prefix,
      };
   }

   // ── 4. LLM minutes ────────────────────────────────────────────────────────
   const meta = buildMeta(row, manifest, participants, durationMs);
   // Full transcript is archive-only (MinIO): rendered here so the internal copy
   // carries the header, but never attached to the Discord post.
   await writeFile(
      join(dir, ARTIFACTS.transcriptDoc),
      `${renderTranscriptHeader(meta)}\n\n${transcriptMd}\n`,
   );
   const minutesBody = await generateMinutes(transcriptMd, meta);
   const minutesMd = `${renderMinutesPost(minutesBody, meta)}\n`;
   await writeFile(join(dir, ARTIFACTS.minutes), minutesMd);

   // ── 5. Publish ────────────────────────────────────────────────────────────
   let publishedUrl: string | null = null;
   let summaryMessageId: string | null = null;
   const outputChannelId = deps.store.getOutputChannelId();
   if (outputChannelId) {
      const published = await publishMinutes({
         client: deps.client,
         channelId: outputChannelId,
         docText: renderMinutesPost(minutesBody, meta),
         minutesMd,
         fileBaseName: sessionId,
      });
      publishedUrl = published.url;
      summaryMessageId = published.messageId;
   } else {
      log.warn(
         { sessionId },
         "minutas.no_output_channel — minutes generated but not published",
      );
   }

   // ── 6. Durable upload + local cleanup ─────────────────────────────────────
   const prefix = minioPrefixFor(row);
   const uploaded = await uploadAll(deps, dir, row, prefix);
   if (uploaded) {
      await rm(dir, { recursive: true, force: true });
   } else {
      log.warn(
         { sessionId, dir },
         "minutas.local_copy_kept (MinIO unavailable or partial upload)",
      );
   }

   deps.store.updateSession(sessionId, {
      status: "done",
      summary_message_id: summaryMessageId,
      minio_prefix: prefix,
      stats_json: JSON.stringify({
         ...stats,
         empty: false,
         minioUploaded: uploaded,
      }),
   });
   log.info(
      { sessionId, publishedUrl, minioPrefix: prefix, stats },
      "minutas.finalized",
   );
   return { sessionId, empty: false, publishedUrl, minioPrefix: prefix };
}

// ── Internals ───────────────────────────────────────────────────────────────

async function readManifest(
   dir: string,
   row: MinutasSessionRow,
): Promise<SessionManifest> {
   try {
      const raw = JSON.parse(
         await readFile(join(dir, ARTIFACTS.sessionMeta), "utf8"),
      );
      return raw as SessionManifest;
   } catch {
      // A crash before the first manifest write still finalizes, from the DB row.
      return {
         id: row.id,
         guildId: row.guild_id,
         channelId: row.channel_id,
         channelName: row.channel_name ?? row.channel_id,
         title: row.title,
         startedBy: row.started_by,
         startedByTag: row.started_by_tag,
         startedAt: row.started_at,
         participants: JSON.parse(row.participants_json || "{}") as Record<
            string,
            string
         >,
      };
   }
}

/**
 * Ledger-first transcription: bursts already transcribed live (or by a prior
 * finalize attempt) are consumed as-is; the remainder goes through the same
 * per-speaker concatenated batches (`transcribeBatch`) the live worker uses —
 * one whisper invocation per batch instead of one per burst, which removes the
 * ~8.5 s fixed cost that made per-burst transcription 29% overhead on the
 * 2026-08-16 assembly.
 */
async function transcribeBursts(
   deps: FinalizeDeps,
   dir: string,
   manifest: SessionManifest,
): Promise<SpeechBurst[]> {
   const audioDir = join(dir, ARTIFACTS.audioDir);
   const manifestLines = await readBurstManifest(dir);
   const onDisk = existsSync(audioDir)
      ? (await readdir(audioDir)).filter((f) => f.endsWith(".pcm"))
      : [];
   const byFile = new Map(manifestLines.map((l) => [basename(l.file), l]));
   const ledger = readLedger(dir);

   const bursts: SpeechBurst[] = [];
   const pending: PendingBurst[] = [];
   for (const pcm of onDisk.sort()) {
      const line = byFile.get(pcm);
      if (!line) continue; // not in the manifest (e.g. a batch concat leftover)
      const done = ledger.get(line.file);
      if (done) {
         bursts.push({
            userId: done.userId,
            speaker: done.speaker,
            startedAtMs: done.startedAtMs,
            segments: done.segments,
         });
         continue;
      }
      const { size } = await stat(join(audioDir, pcm));
      if (size < MIN_BURST_BYTES) continue;
      pending.push({
         seq: line.seq,
         userId: line.userId,
         speaker: line.speaker,
         file: line.file,
         startedAtMs: line.startedAtMs,
         bytes: size,
      });
   }

   if (pending.length > 0 && !deps.transcriber.isAvailable()) {
      log.warn(
         { dir, pending: pending.length },
         "minutas.transcriber_unavailable — bursts left untranscribed",
      );
      for (const b of pending) {
         bursts.push({
            userId: b.userId,
            speaker: b.speaker,
            startedAtMs: b.startedAtMs,
            segments: [],
         });
      }
   } else {
      for (const batch of planBatches(pending)) {
         try {
            const entries = await transcribeBatch(deps.transcriber, dir, batch);
            for (const e of entries) {
               bursts.push({
                  userId: e.userId,
                  speaker: e.speaker,
                  startedAtMs: e.startedAtMs,
                  segments: e.segments,
               });
            }
         } catch (err) {
            log.warn(
               { err, batch: batch.name },
               "minutas.burst_transcribe_failed",
            );
            for (const b of batch.bursts) {
               bursts.push({
                  userId: b.userId,
                  speaker: b.speaker,
                  startedAtMs: b.startedAtMs,
                  segments: [],
               });
            }
         }
      }
   }
   void manifest; // participants already folded into speakers by the manifest lines
   return bursts.sort((a, z) => a.startedAtMs - z.startedAtMs);
}

async function readBurstManifest(dir: string) {
   try {
      const raw = await readFile(join(dir, ARTIFACTS.bursts), "utf8");
      return raw
         .split("\n")
         .filter((l) => l.trim())
         .map((l) => JSON.parse(l) as import("./session.js").BurstManifestLine);
   } catch {
      return [];
   }
}

async function readChat(
   dir: string,
   sessionStartMs: number,
): Promise<ChatNote[]> {
   try {
      const raw = await readFile(join(dir, ARTIFACTS.chat), "utf8");
      return raw
         .split("\n")
         .filter((l) => l.trim())
         .map((l) => JSON.parse(l) as ChatLine)
         .map((l) => ({
            atMs: l.t - sessionStartMs,
            author: l.author,
            content: l.content,
         }));
   } catch {
      return [];
   }
}

function buildMeta(
   row: MinutasSessionRow,
   manifest: SessionManifest,
   participants: string[],
   durationMs: number,
): MinutesMeta {
   const startedAt = new Date(manifest.startedAt);
   const dateLabel = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      dateStyle: "long",
   }).format(startedAt);
   const minutes = Math.max(1, Math.round(durationMs / 60_000));
   const durationLabel =
      minutes >= 60
         ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
         : `${minutes} min`;
   return {
      title: row.title ?? manifest.channelName ?? "sesión de voz",
      channelName: manifest.channelName ?? row.channel_id,
      dateLabel,
      durationLabel,
      participants,
   };
}

function renderTranscriptHeader(meta: MinutesMeta): string {
   return [
      `# Transcripción — ${meta.title}`,
      `Canal: ${meta.channelName} · Fecha: ${meta.dateLabel} · Duración: ${meta.durationLabel}`,
      `Participantes: ${meta.participants.join(", ") || "—"}`,
      "",
      "_Transcripción automática (whisper.cpp local); puede tener errores._",
      "_Las líneas 💬 son comentarios del chat del canal: contexto de la sesión, no parte del acta publicada._",
   ].join("\n");
}

/**
 * Upload the whole session dir under `minutas/<guild>/<date>/<session>/`
 * (audio as WAV, whisper raws, manifests, draft, minutes). Best-effort per
 * file; returns true only when every artifact landed — the local dir is kept
 * as the fallback copy otherwise. Storage disabled → false + local kept.
 */
async function uploadAll(
   deps: FinalizeDeps,
   dir: string,
   row: MinutasSessionRow,
   prefix: string | null,
): Promise<boolean> {
   const storage = deps.storage;
   if (!storage || !prefix) return false;
   const files: string[] = [];
   const walk = async (rel: string): Promise<void> => {
      const abs = join(dir, rel);
      if (!existsSync(abs)) return;
      const entries = await readdir(abs, { withFileTypes: true });
      for (const e of entries) {
         const child = rel ? `${rel}/${e.name}` : e.name;
         if (e.isDirectory()) await walk(child);
         else if (e.isFile() && !e.name.endsWith(".pcm")) files.push(child);
      }
   };
   await walk("");
   let ok = true;
   for (const rel of files) {
      try {
         const bytes = await readFile(join(dir, rel));
         await storage.put(`${prefix}${rel}`, new Uint8Array(bytes));
      } catch (err) {
         ok = false;
         log.warn(
            { err, key: `${prefix}${rel}`, sessionId: row.id },
            "minutas.minio_upload_failed",
         );
      }
   }
   log.info(
      { sessionId: row.id, prefix, files: files.length, ok },
      "minutas.minio_uploaded",
   );
   return ok;
}
