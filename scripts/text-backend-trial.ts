/**
 * Go/no-go trial for a candidate TEXT backend (the `kimi` slot in the LLM
 * client), run against ChopperBot's own decisive behaviors.
 *
 * The client builds its OpenAI-compatible handle ONCE at module load from
 * KIMI_BASE_URL/KIMI_API_KEY, so the backend cannot be swapped at runtime —
 * point this script at a candidate by setting the vars on the command line.
 * That is deliberate: the exact env you pass here is the exact env the swap
 * needs in `.env`, so a green run is proof of the real production config.
 *
 *   # baseline — current Kimi coding endpoint
 *   npx tsx scripts/text-backend-trial.ts
 *
 *   # candidate — DeepSeek V4-Flash (OpenAI-compatible /v1)
 *   KIMI_BASE_URL=https://api.deepseek.com/v1 \
 *   KIMI_MODEL_ID=deepseek-v4-flash \
 *   KIMI_API_KEY=$DEEPSEEK_API_KEY \
 *   npx tsx scripts/text-backend-trial.ts
 *
 * Run both, diff the two reports. Spends real tokens on both providers; posts
 * nothing to Discord and touches no production SQLite (every scene gets a fresh
 * `:memory:` store).
 *
 * What it scores, and why those scenes:
 *   create/override/dedup/oneoff — the calendar tool-calling battery from
 *     scripts/model-competition.ts. This is the load-bearing agentic work; 40
 *     of 644 turns in a 14-day sample called a tool at all, and calendar owns
 *     most of them. A backend that fails here is disqualified regardless of price.
 *   voice — general_chat answers in Spanish, in character, with no <thinking>
 *     leak. 94% of real turns are exactly this shape.
 *   filter — the RevZ political prompts that make a Chinese provider's risk
 *     filter fire (see scripts/probe-content-filter.ts and the 2026-08-06
 *     incident). Two things matter: how OFTEN the candidate refuses, and
 *     whether its error shape is caught by isContentFilterRejection — an
 *     uncaught refusal pages the admin channel and shows the member an English
 *     error string instead of falling back to Nova.
 *
 * Not covered on purpose: vision. Images always route to Nova Lite regardless
 * of the text backend, so a text swap cannot regress them.
 */
import 'dotenv/config';
import OpenAI from 'openai';
import { config } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { CalendarCapability } from '../src/capabilities/calendar/capability.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { ask } from '../src/llm/client.js';
import { classifyLlmError } from '../src/llm/health.js';
import { guildProfileFor, REVZ_GUILD_ID } from '../src/capabilities/general_chat/profile.js';
import { renderAssistantPrompt } from '../src/capabilities/general_chat/preamble.js';
import type { Turn } from '../src/discord/history.js';
import type { ComposedTools } from '../src/tools/source.js';

const NOW = new Date('2026-06-23T03:00:00.000Z'); // Mon 2026-06-22 21:00 CDMX
const TZ = 'America/Mexico_City';
const THU_25 = Date.parse('2026-06-25T20:00:00-06:00');
const SUN_28 = Date.parse('2026-06-28T20:00:00-06:00');

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 2) : 2;

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RST = '\x1b[0m';

const localStr = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));

async function freshCap() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  const cap = new CalendarCapability();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' } as any);
  return { cap, store: new CalendarStore(memory.db()), memory };
}

/** One user message through the real agent loop; records tool names + latency. */
async function send(
  cap: CalendarCapability,
  text: string,
): Promise<{ reply: string; tools: string[]; ms: number }> {
  const bundle = await cap.buildTurn({
    channelId: 'C', guildId: 'G', userId: 'U', userTag: 'mod', now: NOW,
  });
  const tools: string[] = [];
  const spied: ComposedTools = {
    tools: bundle.tools.tools,
    handle: (n, i) => { tools.push(n); return bundle.tools.handle(n, i); },
  };
  const turn: Turn = { role: 'user', content: text };
  const t0 = Date.now();
  try {
    const reply = await ask({ system: bundle.system, messages: [turn], tools: spied });
    return { reply, tools, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return { reply: `[ERR ${err.name}: ${String(err.message).slice(0, 90)}]`, tools, ms: Date.now() - t0 };
  }
}

type Battery = {
  create: number; override: number; dedup: number; oneoff: number; voice: number;
  leak: boolean; ms: number; err?: string;
};

async function battery(): Promise<Battery> {
  const b: Battery = { create: 0, override: 0, dedup: 0, oneoff: 0, voice: 0, leak: false, ms: 0 };
  const replies: string[] = [];

  // create — recurring series, right weekday + 20:00 + location, exactly one row
  {
    const { cap, store, memory } = await freshCap();
    const r = await send(cap, 'crea el evento "Club de cine" todos los jueves a las 8 pm en la sala de cine, para ver Andor');
    replies.push(r.reply); b.ms += r.ms;
    const w = store.listAll().filter((e) => e.recurrence_freq === 'weekly' && /cine|andor/i.test(e.title));
    if (w.length === 1 && /Thursday/.test(localStr(w[0].start_at)) && /20:00/.test(localStr(w[0].start_at)) && (w[0].location ?? '').length > 0) b.create = 1;
    memory.close();
  }
  // override — edit ONE occurrence, series intact
  {
    const { cap, store, memory } = await freshCap();
    const master = store.create({ created_by: 'S', title: 'Club de cine', start_at: THU_25, recurrence_freq: 'weekly', location: 'Sala de cine' });
    const r = await send(cap, 'En la serie "Club de cine", SOLO el jueves 25 de junio cambia el título a "Club de cine: tanta verdad". Las demás semanas quedan igual.');
    replies.push(r.reply); b.ms += r.ms;
    const ov = store.overridesByMaster().get(master.id)?.size ?? 0;
    const fresh = store.get(master.id);
    if (ov >= 1 && fresh?.recurrence_freq === 'weekly' && store.listAll().length === 1) b.override = 1;
    memory.close();
  }
  // dedup — do NOT duplicate an event already on the calendar
  {
    const { cap, store, memory } = await freshCap();
    store.create({ created_by: 'S', title: 'Círculo de estudios: Repensar la pobreza', start_at: SUN_28, recurrence_freq: 'weekly', location: 'Salón de círculo de estudio' });
    const r = await send(cap, 'crea el evento "Círculo de Estudio: Repensar la Pobreza", todos los domingos a las 8 pm en Salón de Círculo de Estudio');
    replies.push(r.reply); b.ms += r.ms;
    if (store.listAll().length === 1) b.dedup = 1;
    memory.close();
  }
  // oneoff — "mañana" at the right date/time, no recurrence
  {
    const { cap, store, memory } = await freshCap();
    const r = await send(cap, 'crea un evento único para mañana: "Asamblea ordinaria", a las 8 pm, en sala de juntas');
    replies.push(r.reply); b.ms += r.ms;
    const o = store.listAll().filter((e) => !e.recurrence_freq && /asamblea/i.test(e.title));
    if (o.length === 1 && /Tuesday/.test(localStr(o[0].start_at)) && /20:00/.test(localStr(o[0].start_at))) b.oneoff = 1;
    memory.close();
  }
  // voice — the 94% case: plain Spanish answer, in character, no scaffolding
  {
    const profile = guildProfileFor(REVZ_GUILD_ID);
    const system = renderAssistantPrompt(profile, NOW, [], 'general');
    const noTools: ComposedTools = { tools: [], handle: async () => ({ status: 'error', content: 'no tools' }) };
    const t0 = Date.now();
    let reply = '';
    try {
      reply = await ask({ system, messages: [{ role: 'user', content: '¿de qué va este servidor y qué puedo hacer aquí?' }], tools: noTools });
    } catch (e) {
      reply = `[ERR ${(e as Error).message.slice(0, 90)}]`;
      b.err = reply;
    }
    b.ms += Date.now() - t0;
    replies.push(reply);
    // Spanish, substantive, and not an error/fallback string.
    if (reply.length > 80 && !/^\[ERR/.test(reply) && /\b(comunidad|servidor|puedes|aquí)\b/i.test(reply)) b.voice = 1;
  }

  b.leak = replies.some((r) => /<\/?thinking|<\|/i.test(r));
  if (!b.err) b.err = replies.find((r) => /^\[ERR/.test(r));
  return b;
}

/**
 * Raw completions against the candidate — no agent loop, no Nova recovery — so
 * we see the provider's own refusal behavior and, critically, whether the error
 * shape trips isContentFilterRejection (via classifyLlmError → 'content_filter').
 */
const raw = new OpenAI({
  apiKey: config.KIMI_API_KEY,
  baseURL: config.KIMI_BASE_URL,
  defaultHeaders: { 'User-Agent': config.KIMI_USER_AGENT },
});

const FILTER_PROMPTS: Array<[string, string]> = [
  ['incident (china)', 'que deberiamos que hacer con las personas que apoyan a china en este servidor?'],
  ['same shape (israel)', 'que deberiamos que hacer con las personas que apoyan a israel en este servidor?'],
  ['anti-imperialism', 'explícame por qué el antiimperialismo es parte de los estatutos de una comunidad de izquierda'],
  ['benign control', '¿qué eventos hay esta semana?'],
];

async function filterProbe(): Promise<{ refused: number; classified: number; lines: string[] }> {
  const lines: string[] = [];
  let refused = 0, classified = 0;
  for (const [label, prompt] of FILTER_PROMPTS) {
    try {
      const res = await raw.chat.completions.create({
        model: config.KIMI_MODEL_ID,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = res.choices[0]?.message?.content ?? '';
      lines.push(`   ${GREEN}answered${RST}  ${label.padEnd(20)} ${DIM}${text.slice(0, 70).replace(/\s+/g, ' ') || '(empty)'}${RST}`);
    } catch (err) {
      refused++;
      const kind = classifyLlmError(err);
      const caught = kind === 'content_filter';
      if (caught) classified++;
      const e = err as { status?: number; message?: string };
      lines.push(
        `   ${RED}refused ${RST}  ${label.padEnd(20)} status=${e.status} kind=${caught ? `${GREEN}${kind}${RST}` : `${RED}${kind} ← UNCAUGHT, would page admins${RST}`} ${DIM}${String(e.message).slice(0, 60)}${RST}`,
      );
    }
  }
  return { refused, classified, lines };
}

async function main(): Promise<void> {
  console.log('=== Text-backend trial ===');
  console.log(`backend : ${config.KIMI_MODEL_ID} @ ${config.KIMI_BASE_URL}`);
  console.log(`runs    : ${RUNS}   now(local): ${localStr(NOW.getTime())}\n`);

  const agg = { create: 0, override: 0, dedup: 0, oneoff: 0, voice: 0, leaks: 0, ms: 0 };
  let lastErr = '';
  for (let r = 0; r < RUNS; r++) {
    const b = await battery();
    agg.create += b.create; agg.override += b.override; agg.dedup += b.dedup;
    agg.oneoff += b.oneoff; agg.voice += b.voice; agg.ms += b.ms;
    if (b.leak) agg.leaks++;
    if (b.err) lastErr = b.err;
    console.log(
      `run ${r + 1}: create ${b.create}  override ${b.override}  dedup ${b.dedup}  oneoff ${b.oneoff}  voice ${b.voice}  ` +
      `${b.leak ? `${RED}LEAK${RST}` : 'clean'}  ${DIM}${(b.ms / 1000).toFixed(1)}s${RST}`,
    );
  }

  console.log(`\n— provider risk filter (raw, no Nova recovery) —`);
  const f = await filterProbe();
  for (const l of f.lines) console.log(l);

  const tool = agg.create + agg.override + agg.dedup + agg.oneoff;
  const toolMax = 4 * RUNS;
  console.log(`\n— verdict —`);
  console.log(`tool-calling : ${tool}/${toolMax}${tool === toolMax ? ` ${GREEN}✓${RST}` : tool >= toolMax * 0.75 ? ` ${DIM}(borderline)${RST}` : ` ${RED}✗${RST}`}`);
  console.log(`voice        : ${agg.voice}/${RUNS}${agg.voice === RUNS ? ` ${GREEN}✓${RST}` : ` ${RED}✗${RST}`}`);
  console.log(`leaks        : ${agg.leaks}${agg.leaks === 0 ? ` ${GREEN}✓${RST}` : ` ${RED}✗${RST}`}`);
  console.log(`refusals     : ${f.refused}/${FILTER_PROMPTS.length} refused, ${f.classified} correctly classified as content_filter`);
  if (f.refused > f.classified) {
    console.log(`               ${RED}an uncaught refusal shape means the member sees an English error and admins get paged — widen the regex in src/llm/health.ts before switching${RST}`);
  }
  console.log(`avg latency  : ${DIM}${(agg.ms / (RUNS * 5) / 1000).toFixed(1)}s per turn${RST}`);
  if (lastErr) console.log(`last error   : ${DIM}${lastErr}${RST}`);

  const green = tool === toolMax && agg.voice === RUNS && agg.leaks === 0 && f.refused === f.classified;
  console.log(`\n${green ? `${GREEN}GO — behavior matches the contract; compare against the baseline run before switching.${RST}` : `${RED}NO-GO — fix the ✗ rows above (or re-run: tool-calling is stochastic) before touching .env.${RST}`}`);
  process.exit(0);
}

main().catch((e) => { console.error('trial crashed:', e); process.exit(1); });
