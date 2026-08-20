import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import {
   MINUTAS_MIGRATIONS,
   MinutasStore,
   type MinutasSessionRow,
} from "../store.js";
import type { ObjectStorage } from "../../../storage/object-storage.js";
import type { Transcriber } from "../transcriber.js";

// The LLM call is mocked — everything else (ffmpeg PCM→WAV, burst manifests,
// chat merge, draft render, MinIO upload layout, Discord post, DB lifecycle)
// runs for real.
vi.mock("../minutes.js", async (importOriginal) => {
   const actual = await importOriginal<typeof import("../minutes.js")>();
   return {
      ...actual,
      generateMinutes: vi.fn(async () =>
         [
            "## Resumen",
            "Minuta simulada de la sesión.",
            "## Temas tratados",
            "- El foro de octubre.",
            "## Acuerdos y decisiones",
            "Sin acuerdos formales.",
            "## Compromisos",
            "Sin compromisos.",
         ].join("\n"),
      ),
   };
});

const hasFfmpeg =
   spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

class FakeStorage implements ObjectStorage {
   readonly backend = "fake";
   readonly objects = new Map<string, Uint8Array>();
   async put(key: string, bytes: Uint8Array): Promise<void> {
      this.objects.set(key, bytes);
   }
   async get(key: string): Promise<Uint8Array | null> {
      return this.objects.get(key) ?? null;
   }
   async delete(): Promise<void> {}
   async deletePrefix(): Promise<number> {
      return 0;
   }
   async ensureReady(): Promise<boolean> {
      return true;
   }
}

class FakeTranscriber implements Transcriber {
   calls: string[] = [];
   isAvailable(): boolean {
      return true;
   }
   async transcribe(wavPath: string, outBase: string) {
      // Emulate whisper-cli's -oj artifact so the upload layout is realistic.
      await writeFile(`${outBase}.json`, JSON.stringify({ transcription: [] }));
      const name = wavPath.split("/").pop()!;
      this.calls.push(name);
      // Finalize batches per speaker: each batch here holds one burst, so the
      // segment times are relative to that burst's own audio.
      if (name.startsWith("batch-001-"))
         return [{ startMs: 0, endMs: 2000, text: "abro la asamblea de hoy" }];
      if (name.startsWith("batch-002-"))
         return [
            {
               startMs: 0,
               endMs: 1500,
               text: "propongo hacer el foro el sábado",
            },
         ];
      return [];
   }
}

function fakeClient(sent: Array<Record<string, unknown>>): Client {
   return {
      channels: {
         fetch: async () => ({
            isSendable: () => true,
            isVoiceBased: () => false,
            send: async (payload: Record<string, unknown>) => {
               sent.push(payload);
               return {
                  id: `msg-${sent.length}`,
                  url: `https://discord.com/channels/g/c/msg-${sent.length}`,
               };
            },
         }),
      },
   } as unknown as Client;
}

const T0 = Date.UTC(2026, 7, 16, 17, 0, 0); // 2026-08-16 11:00 CDMX
const SESSION_ID = "20260816-1100-ab12";
const OUTPUT_CHANNEL = "1503986918784766072";

async function newHarness() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "minutas").migrate(
      "minutas",
      MINUTAS_MIGRATIONS,
   );
   const store = new MinutasStore(mem.db());
   store.setOutputChannelId(OUTPUT_CHANNEL);
   const sessionsDir = await mkdtemp(join(tmpdir(), "minutas-test-"));
   const storage = new FakeStorage();
   const sent: Array<Record<string, unknown>> = [];
   const { finalizeSession } = await import("../pipeline.js");
   const deps = {
      store,
      storage,
      transcriber: new FakeTranscriber(),
      sessionsDir,
      client: fakeClient(sent),
   };
   return { mem, store, sessionsDir, storage, sent, finalizeSession, deps };
}

function sessionRow(over: Partial<MinutasSessionRow> = {}): MinutasSessionRow {
   return {
      id: SESSION_ID,
      guild_id: "g1",
      channel_id: "vc1",
      channel_name: "🔊 Ágora 🔊",
      title: "Asamblea de prueba",
      started_by: "u1",
      started_by_tag: "ana#0001",
      started_at: T0,
      ended_at: T0 + 60_000,
      status: "processing",
      transcribe_after: null,
      end_reason: "/chopperbot-leave",
      minio_prefix: null,
      summary_message_id: null,
      participants_json: '["Ana","Beto"]',
      stats_json: null,
      error: null,
      ...over,
   };
}

async function fabricateSessionDir(
   sessionsDir: string,
   opts: { withAudio?: boolean; withChat?: boolean },
) {
   const dir = join(sessionsDir, SESSION_ID);
   await mkdir(join(dir, "audio"), { recursive: true });
   await mkdir(join(dir, "transcript"), { recursive: true });
   await writeFile(
      join(dir, "session.json"),
      JSON.stringify({
         id: SESSION_ID,
         guildId: "g1",
         channelId: "vc1",
         channelName: "🔊 Ágora 🔊",
         title: "Asamblea de prueba",
         startedBy: "u1",
         startedByTag: "ana#0001",
         startedAt: T0,
         participants: { u1: "Ana", u2: "Beto", u3: "Carla" },
      }),
   );
   if (opts.withAudio) {
      // 2 s and 1.5 s of 16 kHz mono s16le silence (32 KB/s).
      await writeFile(join(dir, "audio", "001-Ana.pcm"), Buffer.alloc(64_000));
      await writeFile(join(dir, "audio", "002-Beto.pcm"), Buffer.alloc(48_000));
      await writeFile(
         join(dir, "bursts.jsonl"),
         [
            JSON.stringify({
               seq: 1,
               userId: "u1",
               speaker: "Ana",
               file: "audio/001-Ana.pcm",
               startedAtMs: 0,
            }),
            JSON.stringify({
               seq: 2,
               userId: "u2",
               speaker: "Beto",
               file: "audio/002-Beto.pcm",
               startedAtMs: 5_000,
            }),
         ].join("\n") + "\n",
      );
   }
   if (opts.withChat) {
      await writeFile(
         join(dir, "chat.jsonl"),
         JSON.stringify({
            t: T0 + 12_000,
            userId: "u3",
            author: "Carla",
            content: "yo apoyo lo del foro",
         }) + "\n",
      );
   }
   return dir;
}

describe.skipIf(!hasFfmpeg)("minutas finalize pipeline", () => {
   let harness: Awaited<ReturnType<typeof newHarness>>;
   beforeEach(async () => {
      harness = await newHarness();
   });
   afterEach(() => harness.mem.close());

   test("full path: PCM → WAV → draft → LLM → Discord post → MinIO layout → DB done → local cleanup", async () => {
      const { store, sessionsDir, storage, sent, finalizeSession, deps } =
         harness;
      store.createSession(sessionRow());
      const dir = await fabricateSessionDir(sessionsDir, {
         withAudio: true,
         withChat: true,
      });

      const result = await finalizeSession(deps, SESSION_ID);

      // Result + DB lifecycle.
      expect(result.empty).toBe(false);
      expect(result.publishedUrl).toBe(
         "https://discord.com/channels/g/c/msg-1",
      );
      const row = store.getSession(SESSION_ID)!;
      expect(row.status).toBe("done");
      expect(row.summary_message_id).toBe("msg-1");
      expect(row.minio_prefix).toBe(`minutas/g1/2026-08-16/${SESSION_ID}/`);
      const stats = JSON.parse(row.stats_json!);
      expect(stats).toMatchObject({
         bursts: 2,
         chatLines: 1,
         empty: false,
         minioUploaded: true,
      });

      // The Discord post: header + body, files attached, no mentions allowed.
      expect(sent).toHaveLength(1);
      const post = sent[0]!;
      expect(String(post.content)).toContain(
         "# 📜 Minuta — Asamblea de prueba",
      );
      expect(String(post.content)).toContain("## Resumen");
      expect(String(post.content)).toContain("Ana, Beto, Carla");
      expect(post.allowedMentions).toEqual({ parse: [] });
      // Only the minuta is attached — the full transcript is archive-only (user
      // decision 2026-08-17: a verbatim who-said-what does not belong pinned in
      // the channel).
      const files = post.files as Array<{ name: string }>;
      expect(files.map((f) => f.name)).toEqual([`minuta-${SESSION_ID}.md`]);

      // The draft merged speech + chat in absolute-time order.
      const draft = await readFile(join(dir, "draft.md"), "utf8").catch(
         () => null,
      );
      expect(draft).toBeNull(); // local dir cleaned after a full upload
      const draftObj = storage.objects.get(`${row.minio_prefix}draft.md`);
      expect(draftObj).toBeTruthy();
      const draftText = Buffer.from(draftObj!).toString("utf8");
      expect(draftText).toContain("[00:00] Ana: abro la asamblea de hoy");
      expect(draftText).toContain(
         "[00:05] Beto: propongo hacer el foro el sábado",
      );
      expect(draftText).toContain(
         "[00:12] 💬 Carla (chat): yo apoyo lo del foro",
      );

      // Structured MinIO layout: per-speaker BATCH wavs (one whisper call per
      // speaker), the whisper raws, the ledger, and never raw PCM.
      const keys = [...storage.objects.keys()].sort();
      expect(keys).toEqual(
         [
            "audio/batch-001-Ana.wav",
            "audio/batch-002-Beto.wav",
            "bursts.jsonl",
            "chat.jsonl",
            "draft.md",
            "minuta.md",
            "session.json",
            "transcript.jsonl",
            "transcript/batch-001-Ana.json",
            "transcript/batch-002-Beto.json",
            "transcripts-live.jsonl",
            "transcripcion.md",
         ]
            .sort()
            .map((k) => `${row.minio_prefix}${k}`)
            .sort(),
      );
      // Raw PCM stays out of the bucket (superseded by the WAV).
      expect(keys.some((k) => k.endsWith(".pcm"))).toBe(false);
      expect(existsSync(dir)).toBe(false);
   });

   test("live-transcribed bursts are consumed from the ledger — whisper only runs for the remainder", async () => {
      const { store, sessionsDir, sent, finalizeSession, deps } = harness;
      store.createSession(sessionRow());
      const dir = await fabricateSessionDir(sessionsDir, {
         withAudio: true,
         withChat: false,
      });
      // Ana's burst was already transcribed DURING the meeting.
      await writeFile(
         join(dir, "transcripts-live.jsonl"),
         JSON.stringify({
            file: "audio/001-Ana.pcm",
            userId: "u1",
            speaker: "Ana",
            startedAtMs: 0,
            segments: [
               { startMs: 0, endMs: 2000, text: "abro la asamblea de hoy" },
            ],
         }) + "\n",
      );

      const result = await finalizeSession(deps, SESSION_ID);

      expect(result.empty).toBe(false);
      expect(sent).toHaveLength(1);
      // Only Beto's batch went through whisper at finalize time.
      const fake = deps.transcriber as FakeTranscriber;
      expect(fake.calls).toEqual(["batch-002-Beto.wav"]);
      // Ana's ledgered text still made the timeline.
      const stats = JSON.parse(store.getSession(SESSION_ID)!.stats_json!);
      expect(stats).toMatchObject({ bursts: 2, speechSegments: 2 });
   });

   test("empty session: no LLM call, no post, DB done with empty stats", async () => {
      const { store, sessionsDir, storage, sent, finalizeSession, deps } =
         harness;
      store.createSession(sessionRow());
      await fabricateSessionDir(sessionsDir, {
         withAudio: false,
         withChat: false,
      });

      const result = await finalizeSession(deps, SESSION_ID);

      expect(result.empty).toBe(true);
      expect(result.publishedUrl).toBeNull();
      expect(sent).toHaveLength(0);
      const row = store.getSession(SESSION_ID)!;
      expect(row.status).toBe("done");
      expect(JSON.parse(row.stats_json!)).toMatchObject({
         empty: true,
         bursts: 0,
         chatLines: 0,
      });
      // The manifests still archive (an empty session is also a record).
      expect(storage.objects.has(`${row.minio_prefix}session.json`)).toBe(true);
   });

   test("storage disabled: minutes still publish; local dir kept as the only copy", async () => {
      const { store, sessionsDir, sent, finalizeSession, deps } = harness;
      store.createSession(sessionRow());
      const dir = await fabricateSessionDir(sessionsDir, {
         withAudio: true,
         withChat: false,
      });

      const result = await finalizeSession(
         { ...deps, storage: null },
         SESSION_ID,
      );

      expect(result.empty).toBe(false);
      expect(sent).toHaveLength(1);
      expect(existsSync(dir)).toBe(true);
      expect(
         JSON.parse(store.getSession(SESSION_ID)!.stats_json!).minioUploaded,
      ).toBe(false);
   });
});
