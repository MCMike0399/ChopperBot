import { createHash } from "node:crypto";
import { log } from "../../log.js";
import type { FileScannerStore, Verdict, VerdictStats } from "./store.js";
import {
   VirusTotalAuthError,
   VirusTotalClient,
   verdictFrom,
} from "./virustotal.js";
import {
   BudgetExhaustedError,
   QueueFullError,
   ScanRateLimiter,
} from "./rate-limiter.js";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const PEEK_TIMEOUT_MS = 10_000;
const PEEK_BYTES = 256;

/** How the verdict was obtained (for logging + friendly wording). */
export type VerdictSource = "cache" | "hash" | "analysis";

export type ScanOutcome =
   | {
        kind: "verdict";
        verdict: Verdict;
        stats: VerdictStats;
        sha256: string;
        source: VerdictSource;
     }
   /** Fresh upload didn't finish analyzing within the poll budget. */
   | { kind: "pending"; sha256: string }
   /** Hash lookup missed and the file is over VirusTotal's upload cap. */
   | { kind: "too_large"; sha256: string }
   | { kind: "budget_exhausted" }
   | { kind: "queue_full" }
   | { kind: "error"; message: string; authError?: boolean };

export interface ScannerDeps {
   client: VirusTotalClient;
   limiter: ScanRateLimiter;
   store: FileScannerStore;
   maliciousThreshold: number;
   maxPolls: number;
   /** Injectable for tests. */
   now?: () => number;
   sleep?: (ms: number) => Promise<void>;
}

/**
 * Orchestrates a single file scan, spending as little VirusTotal budget as
 * possible:
 *   1. SHA-256 the bytes locally.
 *   2. Return instantly from our own verdict cache if we've seen the hash.
 *   3. Ask VirusTotal by hash — most files are already known → instant verdict,
 *      no upload, no polling.
 *   4. Only if unknown (404): upload, then poll the analysis (each call spaced
 *      by the rate limiter) up to `maxPolls` before giving up as `pending`.
 * Every VirusTotal call passes through {@link ScanRateLimiter}, so this method
 * can block for a while when the queue is busy — that is intentional.
 */
export class FileScanner {
   private readonly now: () => number;
   private readonly sleep: (ms: number) => Promise<void>;

   constructor(private readonly deps: ScannerDeps) {
      this.now = deps.now ?? (() => Date.now());
      this.sleep =
         deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
   }

   static sha256(bytes: Uint8Array): string {
      return createHash("sha256").update(bytes).digest("hex");
   }

   async scanBytes(
      bytes: Uint8Array,
      meta: { fileName: string; uploader: string | null },
      opts: { allowUpload?: boolean } = {},
   ): Promise<ScanOutcome> {
      const allowUpload = opts.allowUpload !== false;
      const sha256 = FileScanner.sha256(bytes);
      const { store, client, limiter, maliciousThreshold, maxPolls } =
         this.deps;

      // 2. Local cache hit → zero VirusTotal calls.
      const cached = store.getScan(sha256);
      if (cached) {
         const stats: VerdictStats = {
            malicious: cached.malicious,
            suspicious: cached.suspicious,
            harmless: cached.harmless,
            undetected: cached.undetected,
            total:
               cached.malicious +
               cached.suspicious +
               cached.harmless +
               cached.undetected,
         };
         store.recordScan({
            sha256,
            fileName: meta.fileName,
            size: bytes.byteLength,
            verdict: cached.verdict,
            stats,
            uploader: meta.uploader,
            nowMs: this.now(),
         });
         log.info(
            { sha256, verdict: cached.verdict },
            "file_scanner.scan.cache_hit",
         );
         return {
            kind: "verdict",
            verdict: cached.verdict,
            stats,
            sha256,
            source: "cache",
         };
      }

      try {
         // 3. Hash lookup.
         const hashStats = await limiter.schedule("lookup", () =>
            client.lookupByHash(sha256),
         );
         if (hashStats) {
            return this.finalize(
               sha256,
               hashStats,
               meta,
               bytes.byteLength,
               "hash",
            );
         }

         if (!allowUpload) {
            log.info(
               { sha256, bytes: bytes.byteLength },
               "file_scanner.scan.too_large",
            );
            return { kind: "too_large", sha256 };
         }

         // 4. Unknown file → upload + poll.
         const analysisId = await limiter.schedule("upload", () =>
            client.uploadFile(bytes, meta.fileName),
         );
         log.info({ sha256, analysisId }, "file_scanner.scan.uploaded");
         for (let poll = 0; poll < maxPolls; poll++) {
            const result = await limiter.schedule("analysis", () =>
               client.getAnalysis(analysisId),
            );
            if (result.status === "completed" && result.stats) {
               return this.finalize(
                  sha256,
                  result.stats,
                  meta,
                  bytes.byteLength,
                  "analysis",
               );
            }
         }
         log.warn({ sha256, maxPolls }, "file_scanner.scan.still_pending");
         return { kind: "pending", sha256 };
      } catch (err) {
         if (err instanceof BudgetExhaustedError)
            return { kind: "budget_exhausted" };
         if (err instanceof QueueFullError) return { kind: "queue_full" };
         if (err instanceof VirusTotalAuthError) {
            log.error({ err }, "file_scanner.scan.auth_error");
            return { kind: "error", message: err.message, authError: true };
         }
         log.error({ err, sha256 }, "file_scanner.scan.error");
         return {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
         };
      }
   }

   private finalize(
      sha256: string,
      stats: VerdictStats,
      meta: { fileName: string; uploader: string | null },
      size: number,
      source: VerdictSource,
   ): ScanOutcome {
      const verdict = verdictFrom(stats, this.deps.maliciousThreshold);
      this.deps.store.recordScan({
         sha256,
         fileName: meta.fileName,
         size,
         verdict,
         stats,
         uploader: meta.uploader,
         nowMs: this.now(),
      });
      log.info({ sha256, verdict, source, ...stats }, "file_scanner.scan.done");
      return { kind: "verdict", verdict, stats, sha256, source };
   }
}

/** Download an attachment's bytes with a hard timeout (mirrors attachments/resolver.ts). */
export async function downloadAttachment(url: string): Promise<Uint8Array> {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
   try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
         throw new Error(
            `Failed to download attachment: ${res.status} ${res.statusText}`,
         );
      }
      return new Uint8Array(await res.arrayBuffer());
   } finally {
      clearTimeout(timer);
   }
}

/**
 * Read only the first bytes of an attachment (Range request). Returns null if
 * the CDN ignores Range (we refuse to slurp a 40 MB video just to sniff magic)
 * or if the request fails.
 */
export async function peekMagicBytes(
   url: string,
   n = PEEK_BYTES,
): Promise<Uint8Array | null> {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), PEEK_TIMEOUT_MS);
   try {
      const res = await fetch(url, {
         headers: { Range: `bytes=0-${n - 1}` },
         signal: controller.signal,
      });
      if (res.status === 206) {
         return new Uint8Array(await res.arrayBuffer());
      }
      if (res.status === 200) {
         const len = Number(res.headers.get("content-length") ?? "");
         if (!Number.isFinite(len) || len > n * 4) {
            controller.abort();
            return null;
         }
         const buf = new Uint8Array(await res.arrayBuffer());
         return buf.subarray(0, n);
      }
      return null;
   } catch {
      return null;
   } finally {
      clearTimeout(timer);
   }
}
