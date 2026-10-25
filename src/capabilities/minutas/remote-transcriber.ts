import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch, type RequestInit, type Response } from "undici";
import type { Transcriber, TranscriptSegment } from "./transcriber.js";

export interface RemoteTranscriberOptions {
   url: string;
   tokenFile: string;
   timeoutMs?: number;
   retryMs?: number;
   maxAttempts?: number;
}

/** Stateless compute client: durable input and validated output stay on the Pi.
 * Bounded failures let FailoverTranscriber take over rather than stall a meeting. */
export class RemoteTranscriber implements Transcriber {
   private queue: Promise<unknown> = Promise.resolve();
   private readonly dispatcher = new Agent({
      connect: { timeout: 5_000 },
      headersTimeout: 3 * 60 * 60 * 1000,
      bodyTimeout: 3 * 60 * 60 * 1000,
   });

   constructor(private readonly options: RemoteTranscriberOptions) {
      const url = new URL(options.url);
      if (
         url.username ||
         url.password ||
         url.search ||
         url.hash ||
         !(
            url.protocol === "https:" ||
            (url.protocol === "http:" &&
               ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
         )
      )
         throw new Error(
            "Remote transcription requires HTTPS or a loopback tunnel",
         );
   }

   isAvailable(): boolean {
      return true;
   }

   transcribe(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]> {
      const run = this.queue.then(() => this.run(wavPath, outBase, opts));
      this.queue = run.catch(() => {});
      return run;
   }

   private async run(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]> {
      const size = (await stat(wavPath)).size;
      if (size === 0 || size > 256 * 1024 * 1024)
         throw new Error("Invalid transcription audio size");
      const token = (await readFile(this.options.tokenFile, "utf8")).trim();
      if (token.length < 32)
         throw new Error("Invalid remote transcription credential");
      const signal = AbortSignal.timeout(
         // 16 kHz mono s16 WAV. Allow twice audio duration + startup, with a
         // minute floor and the existing three-hour ceiling for long bursts.
         this.options.timeoutMs ??
            Math.min(
               3 * 60 * 60 * 1000,
               Math.max(60_000, Math.ceil((size / 32_000) * 2_000 + 30_000)),
            ),
      );
      const maxAttempts = this.options.maxAttempts ?? 2;
      const parameters: Record<string, string> = {};
      if (opts?.prompt) parameters.prompt = opts.prompt;
      if (opts?.noContext) parameters.context = "0";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
         signal.throwIfAborted();
         const body = createReadStream(wavPath);
         let response: Response;
         try {
            response = await fetch(this.options.url, {
               method: "POST",
               dispatcher: this.dispatcher,
               redirect: "error",
               headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "audio/wav",
                  "Content-Length": String(size),
                  "X-Workload-Parameters": Buffer.from(
                     JSON.stringify(parameters),
                  ).toString("base64"),
               },
               body: body as unknown as RequestInit["body"],
               duplex: "half",
               signal,
            } as RequestInit);
         } catch (error) {
            signal.throwIfAborted();
            // Transcription has no external side effects. A lost response can
            // safely repeat computation; only a validated response reaches the ledger.
            if (attempt === maxAttempts) throw error;
            await delay(this.options.retryMs ?? 1_000, undefined, { signal });
            continue;
         } finally {
            body.destroy();
         }
         if ([429, 502, 503, 504].includes(response.status)) {
            await response.body?.cancel();
            if (attempt === maxAttempts)
               throw new Error(`Remote transcription HTTP ${response.status}`);
            await delay(this.options.retryMs ?? 1_000, undefined, { signal });
            continue;
         }
         // No retry for configuration/auth errors; the caller can use local compute.
         if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Remote transcription HTTP ${response.status}`);
         }
         const reader = response.body?.getReader();
         if (!reader) throw new Error("Missing transcription response");
         const chunks: Uint8Array[] = [];
         let length = 0;
         try {
            while (true) {
               const chunk = await reader.read();
               if (chunk.done) break;
               length += chunk.value.length;
               if (length > 4 * 1024 * 1024)
                  throw new Error("Transcription output too large");
               chunks.push(chunk.value);
            }
         } finally {
            await reader.cancel();
         }
         const raw = Buffer.concat(chunks).toString("utf8");
         const segments = parseRemoteTranscript(JSON.parse(raw));
         const temp = `${outBase}.json.remote-tmp`;
         try {
            await writeFile(temp, raw, { mode: 0o600 });
            await rename(temp, `${outBase}.json`);
         } finally {
            await rm(temp, { force: true });
         }
         return segments;
      }
      throw new Error("Remote transcription attempts exhausted");
   }
}

export function parseRemoteTranscript(raw: unknown): TranscriptSegment[] {
   if (
      !raw ||
      typeof raw !== "object" ||
      !("transcription" in raw) ||
      !Array.isArray(raw.transcription)
   )
      throw new Error("Invalid remote transcription");
   return raw.transcription
      .map((item: unknown) => {
         const t = item as {
            text?: unknown;
            offsets?: { from?: unknown; to?: unknown };
         } | null;
         const start = t?.offsets?.from,
            end = t?.offsets?.to;
         if (
            typeof t?.text !== "string" ||
            typeof start !== "number" ||
            typeof end !== "number" ||
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            end < start
         )
            throw new Error("Invalid remote transcription segment");
         return {
            startMs: Math.round(start),
            endMs: Math.round(end),
            text: t.text.trim(),
         };
      })
      .filter((s) => s.text.length > 0);
}
