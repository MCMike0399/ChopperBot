import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
   RemoteTranscriber,
   parseRemoteTranscript,
} from "../remote-transcriber.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
   await Promise.all(
      servers
         .splice(0)
         .map((s) => new Promise<void>((r) => s.close(() => r()))),
   );
   await Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
   );
});

async function fixture(handler: Parameters<typeof createServer>[0]) {
   const server = createServer(handler);
   servers.push(server);
   await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
   const address = server.address() as { port: number };
   const dir = await mkdtemp(join(tmpdir(), "remote-transcriber-"));
   dirs.push(dir);
   await writeFile(join(dir, "token"), "x".repeat(48));
   await writeFile(join(dir, "audio.wav"), "synthetic audio");
   return {
      dir,
      client: new RemoteTranscriber({
         url: `http://127.0.0.1:${address.port}/workloads/v1/transcription/run`,
         tokenFile: join(dir, "token"),
         retryMs: 1,
         timeoutMs: 3000,
      }),
   };
}

it("retries capacity refusal, sends options and retains raw output for loop detection", async () => {
   let calls = 0;
   const raw = {
      transcription: [{ offsets: { from: 0, to: 1000 }, text: " hola " }],
   };
   const { dir, client } = await fixture((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${"x".repeat(48)}`);
      const params = JSON.parse(
         Buffer.from(
            req.headers["x-workload-parameters"] as string,
            "base64",
         ).toString(),
      );
      expect(params).toEqual({ prompt: "Vocabulary", context: "0" });
      req.resume();
      if (++calls === 1) {
         res.writeHead(429);
         res.end();
      } else {
         res.setHeader("Content-Type", "application/json");
         res.end(JSON.stringify(raw));
      }
   });
   await expect(
      client.transcribe(join(dir, "audio.wav"), join(dir, "out"), {
         prompt: "Vocabulary",
         noContext: true,
      }),
   ).resolves.toEqual([{ startMs: 0, endMs: 1000, text: "hola" }]);
   expect(JSON.parse(await readFile(join(dir, "out.json"), "utf8"))).toEqual(
      raw,
   );
   expect(calls).toBe(2);
});

it("does not retry authentication errors or silently fall back to local CPU", async () => {
   let calls = 0;
   const { dir, client } = await fixture((req, res) => {
      ++calls;
      req.resume();
      res.writeHead(401);
      res.end();
   });
   await expect(
      client.transcribe(join(dir, "audio.wav"), join(dir, "out")),
   ).rejects.toThrow("HTTP 401");
   expect(calls).toBe(1);
   expect(await readFile(join(dir, "audio.wav"), "utf8")).toBe(
      "synthetic audio",
   );
});

it("recovers a transient worker failure before acknowledging the audio", async () => {
   let calls = 0;
   const { dir, client } = await fixture((req, res) => {
      req.resume();
      if (++calls === 1) {
         res.writeHead(503);
         res.end();
      } else res.end(JSON.stringify({ transcription: [] }));
   });
   await expect(
      client.transcribe(join(dir, "audio.wav"), join(dir, "out")),
   ).resolves.toEqual([]);
   expect(calls).toBe(2);
});

it("rejects malformed output instead of ledgering missing speech as silence", () => {
   for (const value of [
      {},
      null,
      { transcription: [{}] },
      { transcription: [{ text: "bad", offsets: { from: 20, to: 10 } }] },
   ])
      expect(() => parseRemoteTranscript(value)).toThrow();
   expect(parseRemoteTranscript({ transcription: [] })).toEqual([]);
});

it("requires encrypted transport except for an existing loopback tunnel", () => {
   expect(
      () =>
         new RemoteTranscriber({
            url: "http://example.com/run",
            tokenFile: "token",
         }),
   ).toThrow();
   expect(
      () =>
         new RemoteTranscriber({
            url: "https://user:pass@example.com/run",
            tokenFile: "token",
         }),
   ).toThrow();
});
