/**
 * Live probe of the DeepSeek V4-Flash API — both surfaces, side by side.
 *
 * Two questions this answers before any backend swap:
 *   1. Does the RESPONSES API (https://api-docs.deepseek.com/guides/responses_api/)
 *      buy ChopperBot anything over chat/completions? Docs say Responses is
 *      V4-Flash-only, has NO image/file input, and silently ignores
 *      previous_response_id/store/conversation — so the stateful features that
 *      justify Responses elsewhere do not exist here.
 *   2. Does chat/completions — the surface src/llm/client.ts already speaks —
 *      behave identically for our shapes (tools, Spanish, reasoning tiers)?
 *
 * Also measures the two things that decide the bill and the blast radius:
 *   cache  — repeat a long stable prefix; `cached_tokens` should light up on the
 *            second call. Cache-hit input is $0.0028/M vs $0.14/M — a 50×
 *            difference, and our system prompts are a long stable prefix.
 *   filter — the RevZ political prompts. If V4-Flash refuses with an error shape
 *            isContentFilterRejection() misses, the turn is misclassified as a
 *            config error: admins get paged, the member sees an English string.
 *
 * Reads DEEP_SEEK_API_KEY (or DEEPSEEK_API_KEY) from .env. Spends a trivial
 * amount of real credit. Posts nothing, writes nothing, touches no SQLite.
 *
 *   npx tsx scripts/probe-deepseek-api.ts
 */
import 'dotenv/config';
import OpenAI from 'openai';
import { deflateSync } from 'node:zlib';

const KEY = process.env.DEEP_SEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('Set DEEP_SEEK_API_KEY (or DEEPSEEK_API_KEY) in .env first.');
  process.exit(1);
}

const MODEL = process.env.DEEPSEEK_MODEL_ID ?? 'deepseek-v4-flash';
const client = new OpenAI({ apiKey: KEY, baseURL: 'https://api.deepseek.com' });

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', Y = '\x1b[33m', X = '\x1b[0m';
const ok = (s: string) => `${G}✓${X} ${s}`;
const bad = (s: string) => `${R}✗${X} ${s}`;

/** Per-million rates from the official pricing page (cache-miss / cache-hit / output). */
const RATE = { miss: 0.14, hit: 0.0028, out: 0.28 };

let spentIn = 0, spentCached = 0, spentOut = 0;
const bill = (u: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | undefined) => {
  if (!u) return;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  spentIn += input - cached; spentCached += cached; spentOut += u.output_tokens ?? u.completion_tokens ?? 0;
};

const CALENDAR_TOOL = {
  name: 'calendar_create_event',
  description: 'Crea un evento en el calendario de la comunidad.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      start_at_iso: { type: 'string', description: 'ISO 8601 con offset' },
      location: { type: 'string' },
      recurrence_freq: { type: 'string', enum: ['weekly', 'monthly'] },
    },
    required: ['title', 'start_at_iso'],
    additionalProperties: false,
  },
} as const;

const TOOL_PROMPT =
  'Hoy es lunes 22 de junio de 2026, 21:00 en America/Mexico_City. ' +
  'Crea el evento "Club de cine" todos los jueves a las 8 pm en la sala de cine.';

async function section(title: string): Promise<void> {
  console.log(`\n${'─'.repeat(72)}\n${title}`);
}

// ── 1. Responses API: basic ──────────────────────────────────────────────────
async function responsesBasic(): Promise<void> {
  await section('1. Responses API — basic call');
  const t0 = Date.now();
  try {
    const r = await client.responses.create({
      model: MODEL,
      instructions: 'Eres ChopperBot, el asistente de una comunidad de izquierda. Responde en español, breve.',
      input: '¿de qué va este servidor y qué puedo hacer aquí?',
      max_output_tokens: 500,
    } as never) as never as { output_text: string; usage?: never; store?: boolean; status?: string };
    const u = (r as { usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number }; input_tokens_details?: { cached_tokens?: number } } }).usage;
    bill(u);
    console.log(ok(`${Date.now() - t0}ms · status=${r.status} · store=${String(r.store)}`));
    console.log(`   in=${u?.input_tokens} (cached ${u?.input_tokens_details?.cached_tokens ?? 0}) out=${u?.output_tokens} (reasoning ${u?.output_tokens_details?.reasoning_tokens ?? 0})`);
    console.log(`   ${D}${String(r.output_text).slice(0, 120).replace(/\s+/g, ' ')}${X}`);
  } catch (e) {
    console.log(bad(`${(e as { status?: number }).status} ${(e as Error).message.slice(0, 160)}`));
  }
}

// ── 2. Responses API: reasoning effort tiers ─────────────────────────────────
async function responsesEffort(): Promise<void> {
  await section('2. Responses API — reasoning.effort tiers (ChopperBot uses medium/high)');
  for (const effort of ['low', 'medium', 'high'] as const) {
    const t0 = Date.now();
    try {
      const r = await client.responses.create({
        model: MODEL,
        input: 'Un evento semanal empieza el jueves 25 de junio de 2026 a las 20:00. ¿En qué fecha cae la cuarta repetición? Responde solo la fecha.',
        reasoning: { effort },
        max_output_tokens: 2000,
      } as never) as never as { output_text: string };
      const u = (r as { usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } }).usage;
      bill(u);
      console.log(ok(`effort=${effort.padEnd(6)} ${String(Date.now() - t0).padStart(6)}ms · out=${u?.output_tokens} (reasoning ${u?.output_tokens_details?.reasoning_tokens ?? 0}) · ${D}${String(r.output_text).slice(0, 60).replace(/\s+/g, ' ')}${X}`));
    } catch (e) {
      console.log(bad(`effort=${effort} → ${(e as { status?: number }).status} ${(e as Error).message.slice(0, 120)}`));
    }
  }
}

// ── 3. Responses API: function calling ───────────────────────────────────────
async function responsesTools(): Promise<void> {
  await section('3. Responses API — function calling');
  const t0 = Date.now();
  try {
    const r = await client.responses.create({
      model: MODEL,
      input: TOOL_PROMPT,
      tools: [{ type: 'function', ...CALENDAR_TOOL }],
      tool_choice: 'auto',
      max_output_tokens: 1000,
    } as never) as never as { output: Array<{ type: string; name?: string; arguments?: string }> };
    bill((r as { usage?: never }).usage);
    const calls = (r.output ?? []).filter((o) => o.type === 'function_call');
    if (calls.length === 0) {
      console.log(bad(`no function_call emitted in ${Date.now() - t0}ms`));
      console.log(`   ${D}output types: ${(r.output ?? []).map((o) => o.type).join(', ')}${X}`);
      return;
    }
    for (const c of calls) {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(c.arguments ?? '{}'); } catch { /* reported below */ }
      console.log(ok(`${Date.now() - t0}ms · ${c.name} · args ${parsed ? 'parse OK' : `${R}UNPARSEABLE${X}`}`));
      console.log(`   ${D}${JSON.stringify(parsed ?? c.arguments)}${X}`);
      if (parsed) {
        const iso = String(parsed.start_at_iso ?? '');
        const d = new Date(iso);
        const wd = Number.isNaN(d.getTime()) ? '?' : new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
        const good = /Thursday/.test(wd) && /20:00/.test(wd) && parsed.recurrence_freq === 'weekly';
        console.log(`   ${good ? ok('semantics: Thursday 20:00 weekly') : bad(`semantics: got "${wd}" freq=${String(parsed.recurrence_freq)}`)}`);
      }
    }
  } catch (e) {
    console.log(bad(`${(e as { status?: number }).status} ${(e as Error).message.slice(0, 160)}`));
  }
}

// ── 4. Responses API: streaming ──────────────────────────────────────────────
async function responsesStream(): Promise<void> {
  await section('4. Responses API — streaming');
  const t0 = Date.now();
  let firstDelta = 0, deltas = 0, text = '';
  const seen = new Set<string>();
  try {
    const stream = await client.responses.create({
      model: MODEL,
      input: 'Cuenta del 1 al 5 separado por comas.',
      stream: true,
      max_output_tokens: 200,
    } as never) as never as AsyncIterable<{ type: string; delta?: string; sequence_number?: number }>;
    for await (const ev of stream) {
      seen.add(ev.type);
      if (ev.type === 'response.output_text.delta') {
        if (!firstDelta) firstDelta = Date.now() - t0;
        deltas++; text += ev.delta ?? '';
      }
    }
    console.log(ok(`${deltas} text deltas · first at ${firstDelta}ms · total ${Date.now() - t0}ms`));
    console.log(`   terminal event: ${[...seen].find((t) => /response\.(completed|incomplete|failed)/.test(t)) ?? `${R}none${X}`}`);
    console.log(`   ${D}${text.slice(0, 80).replace(/\s+/g, ' ')}${X}`);
  } catch (e) {
    console.log(bad(`${(e as { status?: number }).status} ${(e as Error).message.slice(0, 160)}`));
  }
}

// ── 5. chat/completions — the surface ChopperBot already speaks ──────────────
async function chatCompletions(): Promise<void> {
  await section('5. chat/completions — the surface src/llm/client.ts already speaks');
  const t0 = Date.now();
  try {
    const r = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: TOOL_PROMPT }],
      tools: [{ type: 'function', function: CALENDAR_TOOL as never }],
    });
    bill(r.usage as never);
    const msg = r.choices[0]?.message;
    const calls = msg?.tool_calls ?? [];
    console.log(ok(`${Date.now() - t0}ms · finish=${r.choices[0]?.finish_reason} · tool_calls=${calls.length}`));
    const u = r.usage as unknown as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
    console.log(`   usage keys: ${Object.keys(r.usage ?? {}).join(', ')}`);
    console.log(`   prompt=${u?.prompt_tokens} (cache hit ${u?.prompt_cache_hit_tokens ?? 'n/a'}) completion=${u?.completion_tokens}`);
    for (const c of calls) {
      const fn = (c as { function?: { name?: string; arguments?: string } }).function;
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(fn?.arguments ?? '{}'); } catch { /* reported */ }
      console.log(`   ${parsed ? ok(`${fn?.name} args parse OK`) : bad(`${fn?.name} UNPARSEABLE`)}  ${D}${JSON.stringify(parsed ?? fn?.arguments)}${X}`);
    }
    // Does it also emit reasoning_content, like Kimi K2.7 Thinking does?
    const rc = (msg as { reasoning_content?: string } | undefined)?.reasoning_content;
    console.log(`   reasoning_content: ${rc ? `${Y}present (${rc.length} chars) — the degenerate-output guard must keep handling this${X}` : 'absent'}`);
  } catch (e) {
    console.log(bad(`${(e as { status?: number }).status} ${(e as Error).message.slice(0, 160)}`));
  }
}

// ── 5b. chat/completions: effort tiers + the full tool ROUND-TRIP ───────────
async function chatEffortAndLoop(): Promise<void> {
  await section('5b. chat/completions — reasoning_effort + tool round-trip (the real loop shape)');

  // ChopperBot drives effort tiers ('medium'/'high') on every turn. The docs
  // show reasoning_effort for v4-pro but say nothing about v4-flash, so measure
  // it: a 400 here means the tier plumbing in askKimi needs a guard.
  for (const effort of ['low', 'high'] as const) {
    const t0 = Date.now();
    try {
      const r = await client.chat.completions.create({
        model: MODEL, max_tokens: 2000, reasoning_effort: effort,
        messages: [{ role: 'user', content: 'Un evento semanal empieza el jueves 25 de junio de 2026. ¿Qué fecha es la cuarta repetición? Solo la fecha.' }],
      } as never);
      bill(r.usage as never);
      console.log(ok(`reasoning_effort=${effort.padEnd(4)} ${String(Date.now() - t0).padStart(6)}ms · ${D}${(r.choices[0]?.message?.content ?? '').slice(0, 50).replace(/\s+/g, ' ')}${X}`));
    } catch (e) {
      console.log(bad(`reasoning_effort=${effort} → ${(e as { status?: number }).status} ${(e as Error).message.slice(0, 110)}`));
    }
  }

  // The single-call test above proves the model EMITS a tool call. It does not
  // prove the loop CLOSES — feeding the result back and getting a final answer
  // is where wire-shape mismatches actually bite (tool_call_id echo, assistant
  // message replay, reasoning_content round-tripping).
  try {
    const first = await client.chat.completions.create({
      model: MODEL, max_tokens: 1000,
      messages: [{ role: 'user', content: TOOL_PROMPT }],
      tools: [{ type: 'function', function: CALENDAR_TOOL as never }],
    });
    bill(first.usage as never);
    const assistant = first.choices[0]?.message;
    const call = assistant?.tool_calls?.[0];
    if (!call) { console.log(bad('round-trip: no tool call to feed back')); return; }
    const second = await client.chat.completions.create({
      model: MODEL, max_tokens: 1000,
      messages: [
        { role: 'user', content: TOOL_PROMPT },
        assistant as never,
        { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'ok', event_id: 'evt_123', title: 'Club de cine' }) },
      ],
      tools: [{ type: 'function', function: CALENDAR_TOOL as never }],
    });
    bill(second.usage as never);
    const text = second.choices[0]?.message?.content ?? '';
    const closed = text.trim().length > 0 && second.choices[0]?.finish_reason === 'stop';
    console.log(closed
      ? ok(`round-trip closed · finish=${second.choices[0]?.finish_reason} · ${D}${text.slice(0, 70).replace(/\s+/g, ' ')}${X}`)
      : bad(`round-trip did NOT close · finish=${second.choices[0]?.finish_reason} · content=${JSON.stringify(text.slice(0, 60))}`));
  } catch (e) {
    console.log(bad(`round-trip: ${(e as { status?: number }).status} ${(e as Error).message.slice(0, 140)}`));
  }
}

// ── 6. Context cache — the 50× price lever ──────────────────────────────────
async function cacheProbe(): Promise<void> {
  await section('6. Context cache — cache-hit input is $0.0028/M vs $0.14/M (50×)');
  // A long, stable system prefix, exactly like a capability system prompt.
  const prefix =
    'Eres ChopperBot, el asistente de la comunidad Revolución Z. ' +
    'Reglas de la comunidad y contexto operativo:\n' +
    Array.from({ length: 120 }, (_, i) => `${i + 1}. Regla operativa número ${i + 1}: responde en español, con criterio propio, sin tecnicismos, y respeta los estatutos de la comunidad.`).join('\n');
  for (const attempt of [1, 2]) {
    const t0 = Date.now();
    try {
      const r = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 100,
        messages: [
          { role: 'system', content: prefix },
          { role: 'user', content: 'Saluda en una frase.' },
        ],
      });
      bill(r.usage as never);
      const u = r.usage as unknown as { prompt_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
      const hit = u?.prompt_cache_hit_tokens ?? 0;
      const pct = u?.prompt_tokens ? Math.round((hit / u.prompt_tokens) * 100) : 0;
      console.log(`   call ${attempt}: ${String(Date.now() - t0).padStart(5)}ms · prompt=${u?.prompt_tokens} · cache hit=${hit} (${pct}%) miss=${u?.prompt_cache_miss_tokens ?? 'n/a'}`);
    } catch (e) {
      console.log(bad(`call ${attempt}: ${(e as Error).message.slice(0, 120)}`));
    }
  }
  console.log(`   ${D}a hit on call 2 means our long capability prompts bill at 1/50th on every repeat turn${X}`);
}

// ── 7. Risk filter — the blast-radius question ──────────────────────────────
async function filterProbe(): Promise<void> {
  await section('7. Risk filter — does V4-Flash refuse RevZ-shaped political prompts?');
  const { classifyLlmError } = await import('../src/llm/health.js');
  const prompts: Array<[string, string]> = [
    ['incident (china)', 'que deberiamos que hacer con las personas que apoyan a china en este servidor?'],
    ['same shape (israel)', 'que deberiamos que hacer con las personas que apoyan a israel en este servidor?'],
    ['anti-imperialism', 'explícame por qué el antiimperialismo es parte de los estatutos de una comunidad de izquierda'],
    ['tiananmen (control)', '¿qué pasó en la plaza de Tiananmen en 1989?'],
    ['benign control', '¿qué eventos hay esta semana?'],
  ];
  let refused = 0, uncaught = 0, empty = 0;
  for (const [label, prompt] of prompts) {
    try {
      const r = await client.chat.completions.create({
        model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }],
      });
      bill(r.usage as never);
      const text = r.choices[0]?.message?.content ?? '';
      if (!text.trim()) { empty++; console.log(`   ${Y}EMPTY   ${X} ${label.padEnd(20)} ${D}no content — inconclusive${X}`); }
      else console.log(`   ${G}answered${X} ${label.padEnd(20)} ${D}${text.slice(0, 62).replace(/\s+/g, ' ')}${X}`);
    } catch (e) {
      refused++;
      const kind = classifyLlmError(e);
      const caught = kind === 'content_filter';
      if (!caught) uncaught++;
      console.log(`   ${R}refused ${X} ${label.padEnd(20)} status=${(e as { status?: number }).status} kind=${caught ? `${G}${kind}${X}` : `${R}${kind} ← UNCAUGHT${X}`} ${D}${(e as Error).message.slice(0, 60)}${X}`);
    }
  }
  console.log(`\n   ${refused} refused · ${uncaught} uncaught by isContentFilterRejection · ${empty} empty`);
  if (uncaught > 0) console.log(`   ${R}BLOCKER: widen the regex in src/llm/health.ts before switching .env${X}`);
}

/**
 * Cheapest possible call, purely to separate the failure modes before we run
 * anything expensive or draw conclusions from the results:
 *   401 → the key is wrong; 402 → the key is FINE but the account has no
 *   credit. Without this, a zero-balance account makes every section below
 *   fail and section 7 falsely reports a content-filter BLOCKER (a 402 is
 *   correctly classified `deterministic`, not `content_filter`).
 */
async function preflight(): Promise<boolean> {
  try {
    await client.chat.completions.create({
      model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
    });
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 402) {
      console.log(`\n${R}Account has no balance (402).${X} The key itself authenticated fine — a bad key returns 401.`);
      console.log(`${D}Top up at https://platform.deepseek.com/top_up, then re-run this probe.${X}`);
      console.log(`${D}Nothing below can be measured until then, so stopping here rather than printing misleading results.${X}`);
      return false;
    }
    if (status === 401) {
      console.log(`\n${R}Key rejected (401).${X} Check DEEP_SEEK_API_KEY in .env.`);
      return false;
    }
    console.log(`\n${R}Preflight failed:${X} ${status} ${(e as Error).message.slice(0, 160)}`);
    return false;
  }
}

// ── 8. Vision — can DeepSeek take over Nova's job at all? ───────────────────
/**
 * Nova Lite exists in this codebase for ONE reason: Kimi is text-only, so every
 * turn carrying an image routes to Bedrock (src/llm/client.ts:192), including
 * the Instagram classifier's image posts. Replacing Nova therefore requires
 * image input, and the Responses API docs say plainly that image/file inputs
 * are not supported. This sends a solid red PNG and checks whether the model
 * actually SEES it — a 400 is a clean no, but a 200 that fails to name the
 * colour is worse: it means the API accepts images and silently ignores them.
 */
function redPng(size = 64): Uint8Array {
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => { const t = Uint8Array.from([...type].map((c) => c.charCodeAt(0))); const body = new Uint8Array(t.length + data.length); body.set(t); body.set(data, t.length); const out = new Uint8Array(4 + body.length + 4); const dv = new DataView(out.buffer); dv.setUint32(0, data.length); out.set(body, 4); dv.setUint32(4 + body.length, crc32(body)); return out; };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, size); dv.setUint32(4, size); ihdr[8] = 8; ihdr[9] = 2;
  const rawPx = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) { const row = y * (1 + size * 3); for (let x = 0; x < size; x++) { const p = row + 1 + x * 3; rawPx[p] = 220; rawPx[p + 1] = 25; rawPx[p + 2] = 25; } }
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(rawPx))), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

async function visionProbe(): Promise<void> {
  await section('8. Vision — could DeepSeek replace Nova Lite on image turns?');
  const b64 = Buffer.from(redPng()).toString('base64');
  for (const model of [MODEL, 'deepseek-v4-pro']) {
    try {
      const r = await client.chat.completions.create({
        model, max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Responde SOLO con el color dominante de esta imagen, en una palabra.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ] as never,
        }],
      });
      bill(r.usage as never);
      const txt = r.choices[0]?.message?.content ?? '';
      const sees = /rojo|red/i.test(txt);
      console.log(sees
        ? ok(`${model} — SEES the image · ${D}"${txt.slice(0, 60).replace(/\s+/g, ' ')}"${X}`)
        : `   ${Y}⚠ ${model} — HTTP 200 but did NOT identify red: the image was accepted and ignored${X}\n     ${D}"${txt.slice(0, 80).replace(/\s+/g, ' ')}"${X}`);
    } catch (e) {
      console.log(bad(`${model} — ${(e as { status?: number }).status} ${(e as Error).message.slice(0, 120)}`));
    }
  }
  console.log(`   ${D}no vision here ⇒ Nova Lite must stay for image turns and the IG classifier${X}`);
}

async function main(): Promise<void> {
  console.log(`=== DeepSeek API probe ===\nmodel: ${MODEL} @ https://api.deepseek.com`);
  if (!(await preflight())) process.exit(1);
  await responsesBasic();
  await responsesEffort();
  await responsesTools();
  await responsesStream();
  await chatCompletions();
  await chatEffortAndLoop();
  await cacheProbe();
  await filterProbe();
  await visionProbe();

  const cost = (spentIn * RATE.miss + spentCached * RATE.hit + spentOut * RATE.out) / 1e6;
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`tokens: ${spentIn} uncached-in · ${spentCached} cached-in · ${spentOut} out`);
  console.log(`this probe cost ≈ $${cost.toFixed(5)}`);
  process.exit(0);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
