/**
 * Live e2e for the workshop big-document flow: a REAL agent turn (`ask()`,
 * real text backend, real sandbox) with the full WorkshopToolSource over a
 * throwaway workspace seeded with a real document. Verifies the model
 * discovers and uses the doc tools (index → search/read) instead of trying to
 * swallow the document whole, and that a coherent grounded answer comes back.
 *
 *   npx tsx scripts/e2e-workshop-doc.ts /path/to/doc.pdf "¿Qué dice sobre X?"
 *   npx tsx scripts/e2e-workshop-doc.ts minio:<channelId>/<relPath> "pregunta"
 *
 * Spends real tokens on the selected LLM_TEXT_BACKEND; touches no session
 * state and posts nothing to Discord.
 */
import "dotenv/config";
import {
   mkdtempSync,
   mkdirSync,
   writeFileSync,
   rmSync,
   readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ask } from "../src/llm/client.js";
import { composeToolSources } from "../src/tools/source.js";
import { SessionWorkspace } from "../src/capabilities/workshop/workspace.js";
import {
   WorkshopToolSource,
   type SessionActions,
} from "../src/capabilities/workshop/tools.js";
import { renderWorkshopPrompt } from "../src/capabilities/workshop/preamble.js";
import { sandboxAvailable } from "../src/capabilities/workshop/sandbox.js";
import { createObjectStorage } from "../src/storage/index.js";
import { textBackend } from "../src/config.js";

const source = process.argv[2];
const question =
   process.argv[3] ?? "¿Qué dice este documento sobre su tema principal?";
if (!source) {
   console.error(
      'usage: npx tsx scripts/e2e-workshop-doc.ts <file|minio:channel/relPath> "pregunta"',
   );
   process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "e2e-workshop-"));
try {
   let fileName: string;
   let bytes: Uint8Array;
   if (source.startsWith("minio:")) {
      const storage = createObjectStorage();
      if (!storage) throw new Error("MinIO no configurado.");
      const key = `workshop/${source.slice("minio:".length)}`;
      const got = await storage.get(key);
      if (!got) throw new Error(`Objeto no encontrado: ${key}`);
      bytes = got;
      fileName = basename(key);
      storage.destroy?.();
   } else {
      bytes = readFileSync(source);
      fileName = basename(source);
   }
   const ws = new SessionWorkspace(root);
   ws.ensure();
   mkdirSync(join(root, "uploads"), { recursive: true });
   const rel = `uploads/${/\.(pdf|docx|txt|md)$/i.test(fileName) ? fileName : `${fileName}.pdf`}`;
   writeFileSync(join(root, rel), bytes);

   const sends: string[] = [];
   const actions: SessionActions = {
      queueSendFile: (p) => void sends.push(p),
      queueClear: () => {},
      queueClose: () => {},
      clearContextNow: () => {},
      renameChannel: async () => ({ ok: true }),
   };
   const venvDir = resolve("data/workshop/venv");
   const tools = composeToolSources([
      new WorkshopToolSource({
         workspace: ws,
         actions,
         venvDir,
         maxTimeoutMs: 60_000,
         deliveredPaths: () => new Set([rel]),
      }),
   ]);
   const system = renderWorkshopPrompt({
      now: new Date(),
      userTag: "e2e-tester",
      userId: "0",
      channelName: "taller-e2e",
      files: ws.list(),
      sandboxAvailable: sandboxAvailable(),
      venvAvailable: true,
      savedUploads: [rel],
      summary: null,
      deliveredPaths: new Set([rel]),
   });

   const toolCalls: string[] = [];
   console.log(`backend=${textBackend.provider} model=${textBackend.modelId}`);
   console.log(
      `doc: ${rel} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) — pregunta: ${question}\n`,
   );
   const t0 = Date.now();
   const reply = await ask({
      system,
      messages: [{ role: "user", content: question }],
      tools,
      onPhase: (phase, detail) => {
         if (phase === "tool" && detail) {
            toolCalls.push(detail);
            console.log(`  → tool: ${detail}`);
         }
      },
   });
   console.log(
      `\n[${((Date.now() - t0) / 1000).toFixed(1)}s] tools used: ${toolCalls.join(", ") || "(none)"}`,
   );
   console.log(`\n--- reply ---\n${reply}\n-------------`);

   const usedDocTools = toolCalls.some((t) => t.startsWith("workshop_doc_"));
   const noRawFullRead =
      !toolCalls.includes("workshop_read_file") ||
      toolCalls.filter((t) => t === "workshop_read_file").length <= 2;
   console.log(
      `\ndoc tools used: ${usedDocTools ? "✅" : "❌"} · no raw full-document reads: ${noRawFullRead ? "✅" : "❌"} · reply non-empty: ${reply.trim().length > 100 ? "✅" : "❌"}`,
   );
   if (!usedDocTools || !reply.trim()) process.exitCode = 1;
} finally {
   rmSync(root, { recursive: true, force: true });
}
