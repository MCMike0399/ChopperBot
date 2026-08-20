import type { TranscriptSegment } from "./transcriber.js";

/** One speaker's transcribed burst, positioned on the session timeline. */
export interface SpeechBurst {
   userId: string;
   speaker: string;
   /** Session-relative start of the audio, ms. Whisper offsets sum onto this. */
   startedAtMs: number;
   segments: TranscriptSegment[];
}

/** A text-chat comment captured in the voice channel during the session. */
export interface ChatNote {
   atMs: number;
   author: string;
   content: string;
}

/** One line of the merged draft: a speech utterance or a chat comment. */
export interface DraftEntry {
   atMs: number;
   kind: "speech" | "chat";
   speaker: string;
   text: string;
}

/** Merge same-speaker utterances separated by less than this into one line. */
const MERGE_GAP_MS = 4_000;
/** …but never build a line longer than this (readability + LLM digestion). */
const MERGE_MAX_CHARS = 600;

export function fmtClock(ms: number): string {
   const total = Math.max(0, Math.round(ms / 1000));
   const h = Math.floor(total / 3600);
   const m = Math.floor((total % 3600) / 60);
   const s = total % 60;
   const mm = String(m).padStart(2, "0");
   const ss = String(s).padStart(2, "0");
   return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Flatten per-speaker bursts + chat comments into one chronological timeline.
 * Speaker attribution comes from Discord (each burst belongs to exactly one
 * user) — no diarization guessing. Consecutive utterances by the same speaker
 * separated by a short gap are merged so the draft reads like speech, not
 * like whisper's 30-second window boundaries.
 */
export function buildTimeline(
   bursts: SpeechBurst[],
   chat: ChatNote[],
): DraftEntry[] {
   const entries: DraftEntry[] = [];
   for (const burst of bursts) {
      for (const seg of burst.segments) {
         const text = seg.text.trim();
         if (!text) continue;
         entries.push({
            atMs: burst.startedAtMs + seg.startMs,
            kind: "speech",
            speaker: burst.speaker,
            text,
         });
      }
   }
   for (const note of chat) {
      const text = note.content.trim();
      if (!text) continue;
      entries.push({
         atMs: note.atMs,
         kind: "chat",
         speaker: note.author,
         text,
      });
   }
   // Chronological; on a tie the spoken word lands before the typed comment.
   entries.sort(
      (a, b) =>
         a.atMs - b.atMs ||
         (a.kind === b.kind ? 0 : a.kind === "speech" ? -1 : 1),
   );

   const merged: DraftEntry[] = [];
   for (const e of entries) {
      const prev = merged[merged.length - 1];
      if (
         prev &&
         prev.kind === "speech" &&
         e.kind === "speech" &&
         prev.speaker === e.speaker &&
         e.atMs - prev.atMs <= MERGE_GAP_MS &&
         prev.text.length + e.text.length + 1 <= MERGE_MAX_CHARS
      ) {
         prev.text = `${prev.text} ${e.text}`;
         continue;
      }
      merged.push({ ...e });
   }
   return merged;
}

/**
 * The human/LLM-readable draft: one timestamped line per entry, chat comments
 * marked so the minutes writer can weigh them as comments, not as speech.
 */
export function renderTranscript(entries: DraftEntry[]): string {
   return entries
      .map((e) =>
         e.kind === "chat"
            ? `[${fmtClock(e.atMs)}] 💬 ${e.speaker} (chat): ${e.text}`
            : `[${fmtClock(e.atMs)}] ${e.speaker}: ${e.text}`,
      )
      .join("\n");
}
