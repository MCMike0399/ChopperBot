/**
 * Sancus Ops capability smoke — end-to-end against REAL Kimi + REAL CloudWatch
 * Logs Insights (read-only Nautilus wide events) + real read-only GitHub.
 *
 * Replays the 2026-07-17 production failure ("@ChopperBot sstatus"), where the
 * model ANNOUNCED it would query prod ("Voy a consultar prod…") and stopped
 * without calling any tool — the user never got an answer. The regression
 * check: every ops question MUST produce ≥1 real tool call and the reply must
 * carry results, never an unfulfilled announcement of intent.
 *
 * Read-only by construction: nautilus_query = Logs Insights StartQuery/
 * GetQueryResults over the 3 Nautilus log groups; github = GET-only REST.
 * Notes tools write only to the in-memory SQLite of this run.
 *
 * Usage:  LOG_LEVEL=warn npx tsx scripts/sancus-ops-smoke.ts
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { SancusOpsCapability } from '../src/capabilities/sancus_ops/capability.js';
import { ask } from '../src/llm/client.js';
import type { Turn } from '../src/discord/history.js';
import type { ComposedTools } from '../src/tools/source.js';

const g = '\x1b[32m', r = '\x1b[31m', y = '\x1b[33m', dim = '\x1b[2m', rst = '\x1b[0m';
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (ok) console.log(`  ${g}✓${rst} ${label}${detail ? `  ${dim}${detail}${rst}` : ''}`);
  else {
    failures++;
    console.log(`  ${r}✗ ${label}${rst}${detail ? `  ${detail}` : ''}`);
  }
};
const warn = (label: string, detail = '') =>
  console.log(`  ${y}~ ${label}${rst}${detail ? `  ${dim}${detail}${rst}` : ''}`);

/** An answer that promises a future query it can no longer run. */
const ANNOUNCE_ONLY = /\b(voy a (consultar|revisar|checar|verificar)|déjame (consultar|revisar|checar)|un momento|enseguida (consulto|reviso))\b/i;

const memory = new SqliteMemoryStore({ path: ':memory:' });
const cap = new SancusOpsCapability();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await cap.init({ memory: new NamespacedMemory(memory, cap.id) } as any);

async function say(user: string): Promise<{ reply: string; tools: string[] }> {
  const bundle = await cap.buildTurn({
    channelId: 'OPS', guildId: 'G1', userId: 'U_smoke', userTag: 'smoke', now: new Date(),
  });
  const tools: string[] = [];
  const spied: ComposedTools = {
    tools: bundle.tools.tools,
    handle: (n, i) => {
      tools.push(n);
      return bundle.tools.handle(n, i);
    },
  };
  const messages: Turn[] = [{ role: 'user', content: user }];
  let reply: string;
  try {
    reply = await ask({ system: bundle.system, messages, tools: spied });
  } catch (err) {
    reply = `[ask() threw: ${err instanceof Error ? err.message : String(err)}]`;
  }
  console.log(`\n${dim}user:${rst} ${user}`);
  console.log(`${dim}bot:${rst} ${reply.replace(/\n/g, '\n     ')}`);
  console.log(`${dim}     tools: ${tools.join(', ') || '(ninguna)'}${rst}`);
  return { reply, tools };
}

async function main() {
  console.log('=== Sancus Ops capability smoke (Kimi + Logs Insights reales) ===');
  console.log(`Model: ${config.KIMI_MODEL_ID}\n`);

  // ── Scene 1: the exact 2026-07-17 failure — a terse status ask ──
  console.log('── Scene 1: "sstatus" (la falla original) ──');
  {
    const { reply, tools } = await say('sstatus');
    check(tools.includes('nautilus_query'), 'ejecutó nautilus_query (no solo lo anunció)', tools.join(', '));
    check(!ANNOUNCE_ONLY.test(reply) || tools.length > 0, 'la respuesta no es un anuncio sin ejecución');
    check(reply.length > 40 && !reply.startsWith('[ask() threw'), 'entregó una respuesta sustantiva');
  }

  // ── Scene 2: errores en dev, última hora ──
  console.log('\n── Scene 2: errores en dev (última hora) ──');
  {
    const { reply, tools } = await say('¿hubo errores en dev en la última hora?');
    check(tools.includes('nautilus_query'), 'consultó Nautilus', tools.join(', '));
    check(!ANNOUNCE_ONLY.test(reply) || tools.length > 0, 'sin anuncios vacíos');
  }

  // ── Scene 3: pregunta de GitHub (PRs abiertos) ──
  console.log('\n── Scene 3: PRs abiertos del backend ──');
  {
    const { reply, tools } = await say('¿qué PRs están abiertos en el backend?');
    if (tools.includes('github')) check(true, 'usó la herramienta github', tools.join(', '));
    else warn('no llamó a github (¿token no disponible en este entorno?)', tools.join(', ') || '(ninguna)');
    check(reply.length > 0, 'respondió');
  }

  // ── Scene 4: charla simple — no debe disparar consultas innecesarias ──
  console.log('\n── Scene 4: agradecimiento (sin herramientas requeridas) ──');
  {
    const { reply } = await say('gracias!');
    check(reply.length > 0 && !reply.startsWith('[ask() threw'), 'respondió sin fallar');
  }

  console.log();
  if (failures === 0) console.log(`${g}✓ All sancus_ops smoke checks passed.${rst}`);
  else console.log(`${r}✗ ${failures} check(s) failed.${rst}`);
  memory.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('sancus-ops smoke crashed:', err);
  process.exit(1);
});
