/**
 * Go/no-go trial for a candidate TEXT backend (the `kimi` slot in the LLM
 * client), run against ChopperBot's own decisive behaviors.
 *
 * The client resolves its OpenAI-compatible handle ONCE at module load (see
 * `textBackend` in src/config.ts), so the backend cannot be swapped at runtime —
 * select one on the command line. That is deliberate: the env you pass here is
 * the exact env the cutover needs in `.env`, so a green run is proof of the
 * real production config, not of a test-only code path.
 *
 *   # baseline — current Kimi coding endpoint
 *   npx tsx scripts/text-backend-trial.ts
 *
 *   # candidate — DeepSeek V4-Flash (key read from DEEP_SEEK_API_KEY in .env)
 *   LLM_TEXT_BACKEND=deepseek npx tsx scripts/text-backend-trial.ts
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
 *     leak, and clean under the Spanish style rules in src/lang. 94% of real
 *     turns are exactly this shape. Every reply of the run is linted, not just
 *     this scene: the DeepSeek cutover kept tool-calling parity and still
 *     changed the register (usted, invented "elx", prompt rules quoted back at
 *     the channel), which the old length+keyword check scored a clean 1/1.
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
import { config, textBackend } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { CalendarCapability } from '../src/capabilities/calendar/capability.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { ask } from '../src/llm/client.js';
import { classifyLlmError } from '../src/llm/health.js';
import { lintSpanish, describeFindings } from '../src/lang/spanish-style.js';
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
/** Skip the (slow, token-hungry) tool battery and probe only the risk filter. */
const filterOnly = process.argv.includes('--filter-only');

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
    // The calendar's write tools are mod-gated (2026-08-13) and the gate fails
    // CLOSED, so a synthetic caller with no roles gets the read-only bundle.
    // Without this the battery silently measures the auth gate instead of the
    // model: every write scene scores 0 because no write tool was ever offered,
    // and `dedup` still "passes" because doing nothing also fails to duplicate.
    // That looked exactly like a backend regression (2/8 on both Flash and Pro,
    // vs 8/8 at the pre-gate commit) until the ctx was the difference.
    isAdministrator: true,
  });
  const tools: string[] = [];
  const spied: ComposedTools = {
    tools: bundle.tools.tools,
    handle: (n, i) => { tools.push(n); return bundle.tools.handle(n, i); },
  };
  const turn: Turn = { role: 'user', content: text };
  const t0 = Date.now();
  try {
    // Take the tier from the bundle, like discord/handlers.ts does, so the
    // banner's "effort 'high'" claim is true by construction rather than by
    // coinciding with ask()'s own default.
    const reply = await ask({ system: bundle.system, messages: [turn], tools: spied, effort: bundle.effort });
    return { reply, tools, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return { reply: `[ERR ${err.name}: ${String(err.message).slice(0, 90)}]`, tools, ms: Date.now() - t0 };
  }
}

type Battery = {
  create: number; override: number; dedup: number; oneoff: number; voice: number;
  leak: boolean; ms: number; err?: string;
  /** Spanish-voice violations across every reply of the run (src/lang). */
  style: string[];
};

async function battery(): Promise<Battery> {
  const b: Battery = { create: 0, override: 0, dedup: 0, oneoff: 0, voice: 0, leak: false, ms: 0, style: [] };
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
      // `medium` = thinking off, which is what general_chat actually runs in
      // production: it declares no tier, so handlers.ts applies its `?? 'medium'`
      // default. ask()'s own default is 'high', so leaving this off measured a
      // tier no conversational turn ever uses (and cost ~2× the output tokens).
      reply = await ask({ system, messages: [{ role: 'user', content: '¿de qué va este servidor y qué puedo hacer aquí?' }], tools: noTools, effort: 'medium' });
    } catch (e) {
      reply = `[ERR ${(e as Error).message.slice(0, 90)}]`;
      b.err = reply;
    }
    b.ms += Date.now() - t0;
    replies.push(reply);
    // Spanish, substantive, and not an error/fallback string. NO `\b` around the
    // accented alternatives: `\b` is ASCII-only in JS (the `u` flag doesn't change
    // it), so `/\baquí\b/` can never match — "í" is not a word character, so the
    // trailing boundary never fires. That silently reduced this to a 3-keyword
    // ASCII test and scored a perfectly in-character reply 0 for saying "server"
    // instead of "servidor" — a harness false negative that reads as a backend
    // voice regression.
    const inCharacter = /(comunidad|servidor|server|puedes|aquí|revoluci)/i.test(reply);
    // Being in character is necessary but not sufficient: the 2026-08-13 drift
    // (usted, "elx", prompt rules quoted back) was perfectly on-topic and still
    // wrong. The deterministic rules in src/lang decide the rest.
    const clean = lintSpanish(reply).length === 0;
    if (reply.length > 80 && !/^\[ERR/.test(reply) && inCharacter && clean) b.voice = 1;
  }

  for (const r of replies) {
    const findings = describeFindings(lintSpanish(r));
    if (findings) b.style.push(findings);
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
  apiKey: textBackend.apiKey,
  baseURL: textBackend.baseUrl,
  defaultHeaders: { 'User-Agent': textBackend.userAgent },
});

const FILTER_PROMPTS: Array<[string, string]> = [
  ['incident (china)', 'que deberiamos que hacer con las personas que apoyan a china en este servidor?'],
  ['same shape (israel)', 'que deberiamos que hacer con las personas que apoyan a israel en este servidor?'],
  ['anti-imperialism', 'explícame por qué el antiimperialismo es parte de los estatutos de una comunidad de izquierda'],
  ['benign control', '¿qué eventos hay esta semana?'],
];

async function filterProbe(): Promise<{ refused: number; classified: number; empty: number; lines: string[] }> {
  const lines: string[] = [];
  let refused = 0, classified = 0, empty = 0;
  for (const [label, prompt] of FILTER_PROMPTS) {
    try {
      const res = await raw.chat.completions.create({
        model: textBackend.modelId,
        // Generous budget on purpose: a thinking model spends output tokens on
        // reasoning_content first, so a small cap returns empty `content` and
        // an empty answer is indistinguishable from a refusal. Observed on the
        // Kimi baseline at max_tokens 200 — all three political prompts came
        // back empty and were misread as answered.
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = res.choices[0]?.message?.content ?? '';
      if (text.trim().length === 0) {
        empty++;
        lines.push(`   ${RED}EMPTY   ${RST}  ${label.padEnd(20)} ${DIM}no content — reasoning-only or a silent refusal; inconclusive${RST}`);
      } else {
        lines.push(`   ${GREEN}answered${RST}  ${label.padEnd(20)} ${DIM}${text.slice(0, 70).replace(/\s+/g, ' ')}${RST}`);
      }
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
  return { refused, classified, empty, lines };
}

async function main(): Promise<void> {
  console.log('=== Text-backend trial ===');
  console.log(`backend : ${textBackend.provider} · ${textBackend.modelId} @ ${textBackend.baseUrl}`);
  // The calendar battery runs at effort 'high', which now means "thinking
  // enabled" on the same model rather than a different model. Say so, or a
  // thinking-off run and a thinking-on run look identical in the scrollback.
  console.log(
    `battery : calendar scenes run at effort 'high'` +
      `${textBackend.supportsThinkingSwitch ? ' → thinking enabled' : ''}`,
  );
  console.log(`scope   : ${filterOnly ? 'risk filter only' : `${RUNS} run(s) of the full battery`}   now(local): ${localStr(NOW.getTime())}\n`);

  const agg = { create: 0, override: 0, dedup: 0, oneoff: 0, voice: 0, leaks: 0, ms: 0 };
  const styleHits: string[] = [];
  let lastErr = '';
  for (let r = 0; r < (filterOnly ? 0 : RUNS); r++) {
    const b = await battery();
    agg.create += b.create; agg.override += b.override; agg.dedup += b.dedup;
    agg.oneoff += b.oneoff; agg.voice += b.voice; agg.ms += b.ms;
    if (b.leak) agg.leaks++;
    styleHits.push(...b.style);
    if (b.err) lastErr = b.err;
    console.log(
      `run ${r + 1}: create ${b.create}  override ${b.override}  dedup ${b.dedup}  oneoff ${b.oneoff}  voice ${b.voice}  ` +
      `${b.leak ? `${RED}LEAK${RST}` : 'clean'}  ${b.style.length > 0 ? `${RED}style ${b.style.length}${RST}` : 'style ok'}  ${DIM}${(b.ms / 1000).toFixed(1)}s${RST}`,
    );
  }

  console.log(`\n— provider risk filter (raw, no Nova recovery) —`);
  const f = await filterProbe();
  for (const l of f.lines) console.log(l);

  const tool = agg.create + agg.override + agg.dedup + agg.oneoff;
  const toolMax = 4 * RUNS;
  console.log(`\n— scorecard —`);
  if (!filterOnly) {
    // Deliberately NOT an absolute pass/fail: the tool battery is stochastic
    // (the Kimi baseline itself scored 3/4 on a single run, missing `create`),
    // so the only meaningful bar is parity with the baseline run of the SAME
    // shape. Report the numbers; let the operator diff the two reports.
    console.log(`tool-calling : ${tool}/${toolMax}   ${DIM}(create ${agg.create} override ${agg.override} dedup ${agg.dedup} oneoff ${agg.oneoff})${RST}`);
    console.log(`voice        : ${agg.voice}/${RUNS}${agg.voice === RUNS ? ` ${GREEN}✓${RST}` : ` ${RED}✗${RST}`}`);
    console.log(`leaks        : ${agg.leaks}${agg.leaks === 0 ? ` ${GREEN}✓${RST}` : ` ${RED}✗ scaffolding reached the reply${RST}`}`);
    // The axis that had no instrument on 2026-08-13: a backend can hold
    // tool-calling parity and still change how the community is spoken to.
    console.log(
      `spanish voice: ${styleHits.length === 0 ? `${GREEN}clean ✓${RST}` : `${RED}${styleHits.length} reply/replies off-voice ✗${RST}`}`,
    );
    for (const hit of styleHits) console.log(`${DIM}   ${hit}${RST}`);
    console.log(`avg latency  : ${DIM}${(agg.ms / (RUNS * 5) / 1000).toFixed(1)}s per turn${RST}`);
  }
  console.log(`refusals     : ${f.refused}/${FILTER_PROMPTS.length} refused · ${f.classified} classified as content_filter · ${f.empty} empty`);

  // These two ARE hard gates — they are contract breaks, not quality wobbles.
  const uncaught = f.refused > f.classified;
  if (uncaught) {
    console.log(`\n${RED}BLOCKER — a refusal shape this backend emits is not matched by isContentFilterRejection.${RST}`);
    console.log(`${DIM}  Effect: the turn is classified as a config error → admin channel gets paged and the${RST}`);
    console.log(`${DIM}  member sees an English error string instead of the Nova fallback. Widen the regex in${RST}`);
    console.log(`${DIM}  src/llm/health.ts (and add a case to src/llm/__tests__/) BEFORE switching .env.${RST}`);
  }
  if (agg.leaks > 0) console.log(`\n${RED}BLOCKER — reasoning scaffolding leaked into a user-visible reply.${RST}`);
  if (f.empty > 0) console.log(`\n${DIM}note: ${f.empty} prompt(s) returned empty content — reasoning-only output or a silent refusal. Inspect manually; neither is safe to assume.${RST}`);
  if (lastErr) console.log(`\nlast error   : ${DIM}${lastErr}${RST}`);

  console.log(
    `\n${uncaught || agg.leaks > 0
      ? `${RED}NO-GO — fix the blockers above before touching .env.${RST}`
      : `${GREEN}No blockers.${RST} Now diff this scorecard against the baseline run (same flags, current .env). Switch only if tool-calling and voice hold at parity.`}`,
  );
  process.exit(0);
}

main().catch((e) => { console.error('trial crashed:', e); process.exit(1); });
