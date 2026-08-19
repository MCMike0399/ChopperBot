export const MINUTAS_CAPABILITY_ID = 'minutas';

/** Slash command names (Discord: lowercase, hyphens ok, 1–32 chars). */
export const JOIN_COMMAND = 'chopperbot-join';
export const LEAVE_COMMAND = 'chopperbot-leave';

/** A burst closes after this much continuous silence from the speaker. */
export const SILENCE_END_MS = 1500;

/** What Discord sends on the wire: 48 kHz stereo Opus. */
export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_CHANNELS = 2;

/**
 * Rebuild the Opus decoder after this many CONSECUTIVE packet failures.
 * libopus itself recovers fine packet-to-packet, but a decoder that has truly
 * wedged would otherwise poison the rest of the burst.
 */
export const DECODER_REBUILD_AFTER_ERRORS = 5;

/**
 * Consecutive bursts that captured nothing before we shout. This is the guard
 * for the 2026-08-16 failure: the decoder died mid-assembly and recording went
 * on producing empty bursts for minutes with only warn-level logs to show for
 * it. Silent partial data loss is the worst outcome for a minutes tool.
 */
export const CAPTURE_FAILURE_ALARM_AFTER = 3;

/** PCM format the burst recorder writes: signed 16-bit LE mono at 16 kHz. */
export const PCM_BYTES_PER_SECOND = 16000 * 2;

/**
 * Whisper cost model, MEASURED 2026-08-17 on real assembly audio (Pi 5,
 * ggml-small): wall ≈ 8.5 s per invocation + 0.82 × seconds of audio. Fitted
 * from 2 s→9.9 s, 10 s→12.8 s, 30 s→30.5 s, 197.6 s→168 s; validated against
 * the 2026-08-16 assembly (predicted 76 min, observed ~74). Used by
 * measureSessionDir logs of leftover whisper at finalize time.
 */
export const WHISPER_FIXED_SEC_PER_BURST = 8.5;
export const WHISPER_SEC_PER_AUDIO_SEC = 0.82;

/**
 * Live transcription (during the meeting) + burst concatenation. Bursts are
 * batched PER SPEAKER — attribution rides on which batch a segment came from,
 * so batches never mix voices — with a silence gap between bursts so whisper
 * tends to break segments at the joins. A batch flushes once a speaker has
 * this much pending audio (or this many bursts); whatever is left when the
 * session closes is small and finalize picks it up via the ledger.
 */
export const LIVE_FLUSH_AUDIO_SEC = 45;
export const LIVE_FLUSH_MAX_BURSTS = 8;
export const BATCH_GAP_MS = 1000;
/** Cap one whisper invocation's audio (finalize-time batches of a whole assembly). */
export const MAX_BATCH_AUDIO_SEC = 600;

/**
 * Bursts shorter than this are skipped at transcribe time. Kept deliberately
 * low: whisper costs a full 30 s window per invocation regardless of length,
 * but discarding real speech is worse than paying for it. At 1 s this dropped
 * 32% of captured bursts in the 2026-08-16 assembly (72 of 228) — plenty of
 * them real short answers ("sí, de acuerdo").
 */
export const MIN_BURST_BYTES = PCM_BYTES_PER_SECOND / 2; // 0.5 s

/** Grace period before an emptied voice channel auto-ends its session. */
export const EMPTY_CHANNEL_GRACE_MS = 60_000;

/** Per-session artifact layout (both on disk and under the MinIO prefix). */
export const ARTIFACTS = {
  sessionMeta: 'session.json',
  chat: 'chat.jsonl',
  bursts: 'bursts.jsonl',
  transcript: 'transcript.jsonl',
  draft: 'draft.md',
  minutes: 'minuta.md',
  /** Rendered full transcript. Archive-only — never attached to the Discord post. */
  transcriptDoc: 'transcripcion.md',
  /**
   * Live-transcription ledger: one line per burst already transcribed during
   * the meeting (file, speaker, timeline position, segments). Finalize treats
   * it as the source of truth and only transcribes bursts missing from it —
   * that is what makes mid-meeting transcription crash-safe.
   */
  liveLedger: 'transcripts-live.jsonl',
  audioDir: 'audio',
  whisperDir: 'transcript',
} as const;
