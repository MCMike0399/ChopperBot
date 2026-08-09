/**
 * Triage aid: render the EXACT system prompt the next workshop turn of a
 * session will get (workspace listing + delivery ledger + summary), without
 * sending anything. Verifies what the model "sees" — e.g. whether a file
 * shows ✅ entregado or ⚠️ NO entregado.
 *
 *   npx tsx scripts/preview-workshop-prompt.ts <channelId> [--full]
 */
import 'dotenv/config';
import { join, resolve } from 'node:path';
import { config } from '../src/config.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { WorkshopStore } from '../src/capabilities/workshop/store.js';
import { SessionWorkspace, workspaceDirFor } from '../src/capabilities/workshop/workspace.js';
import { renderWorkshopPrompt } from '../src/capabilities/workshop/preamble.js';
import { sandboxAvailable } from '../src/capabilities/workshop/sandbox.js';
import { existsSync } from 'node:fs';

const channelId = process.argv[2];
const FULL = process.argv.includes('--full');
if (!channelId) {
  console.error('usage: npx tsx scripts/preview-workshop-prompt.ts <channelId> [--full]');
  process.exit(1);
}

const dataDir = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR);
const mem = new SqliteMemoryStore({ path: join(dataDir, 'chopperbot.db') });

function main(): void {
  const store = new WorkshopStore(mem.db());
  const session = store.getSession(channelId);
  if (!session) {
    console.error(`❌ no hay sesión de workshop para el canal ${channelId}`);
    process.exit(1);
  }
  const ws = new SessionWorkspace(workspaceDirFor(dataDir, channelId));
  const venvDir = join(dataDir, 'workshop', 'venv');
  const prompt = renderWorkshopPrompt({
    now: new Date(),
    userTag: session.user_tag,
    userId: session.user_id,
    channelName: null,
    files: ws.list(),
    sandboxAvailable: sandboxAvailable(),
    venvAvailable: existsSync(join(venvDir, 'bin', 'python3')),
    savedUploads: [],
    summary: session.summary,
    deliveredPaths: new Set(store.fileManifest(channelId).map((f) => f.rel_path)),
  });

  if (FULL) {
    console.log(prompt);
    return;
  }
  // Default: just the workspace ledger block (the triage-relevant part).
  const block = prompt.split('# Workspace de la sesión')[1]?.split('\n# ')[0] ?? '(sin bloque)';
  console.log(`# Workspace de la sesión${block}`);
  console.log(`\n(summary en el prompt: ${session.summary ? `${session.summary.length} chars` : 'no'})`);
}

try {
  main();
} finally {
  mem.close();
}
