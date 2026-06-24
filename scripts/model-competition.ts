/**
 * Open-weight model competition for ChopperBot's calendar + IG workload.
 * Winner must be **image-capable** (the IG classifier needs vision).
 *
 * For each model we set config.BEDROCK_MODEL_ID at runtime and run a battery of
 * ISOLATED checks (fresh seeded SQLite store each), so there's no cross-scene
 * cascade noise. Scores the decisive behaviors Kimi handled and Nova/Haiku
 * struggled with:
 *   create   — recurring series, right weekday + 20:00 (8 pm) + location, exactly one row
 *   override — edit a SINGLE occurrence of a series (occurrence-scope, series intact)
 *   dedup    — do NOT create a duplicate of an event already on the calendar
 *   oneoff   — one-off "mañana" at the right date/time
 *   vision   — name the dominant color of a red image  (GATING for the winner)
 *   clean    — no <thinking> leak in any reply
 *
 * Usage:  LOG_LEVEL=warn npx tsx scripts/model-competition.ts
 */
import 'dotenv/config';
import { deflateSync } from 'node:zlib';
import { config } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { CalendarCapability } from '../src/capabilities/calendar/capability.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { ask } from '../src/llm/client.js';
import type { Turn } from '../src/discord/history.js';
import type { ComposedTools } from '../src/tools/source.js';
import { ImageAttachable } from '../src/attachments/attachable.js';

const NOW = new Date('2026-06-23T03:00:00.000Z'); // Mon 2026-06-22 21:00 CDMX
const TZ = 'America/Mexico_City';
const THU_25 = Date.parse('2026-06-25T20:00:00-06:00');
const SUN_28 = Date.parse('2026-06-28T20:00:00-06:00');
const RUNS = 2; // repeat the flaky battery to gauge consistency

// Open-weight, vision-capable, tool-use contenders + Claude Haiku as reference.
const MODELS: Array<{ id: string; ref?: boolean }> = [
  { id: 'qwen.qwen3-vl-235b-a22b' },
  { id: 'us.meta.llama4-maverick-17b-instruct-v1:0' },
  { id: 'us.meta.llama4-scout-17b-instruct-v1:0' },
  { id: 'us.mistral.pixtral-large-2502-v1:0' },
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', ref: true }, // reference
];

const localStr = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// --- valid solid-color PNG (Bedrock rejects 1x1) ---
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array) { const t = Uint8Array.from([...type].map((c) => c.charCodeAt(0))); const body = new Uint8Array(t.length + data.length); body.set(t); body.set(data, t.length); const out = new Uint8Array(4 + body.length + 4); const dv = new DataView(out.buffer); dv.setUint32(0, data.length); out.set(body, 4); dv.setUint32(4 + body.length, crc32(body)); return out; }
function redPng(size = 64) { const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, size); dv.setUint32(4, size); ihdr[8] = 8; ihdr[9] = 2; const raw = new Uint8Array(size * (1 + size * 3)); for (let y = 0; y < size; y++) { const row = y * (1 + size * 3); for (let x = 0; x < size; x++) { const p = row + 1 + x * 3; raw[p] = 220; raw[p + 1] = 25; raw[p + 2] = 25; } } const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]); const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]; const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { png.set(p, o); o += p.length; } return png; }
const RED = redPng();

async function freshCap() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  const cap = new CalendarCapability();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' } as any);
  return { cap, store: new CalendarStore(memory.db()), memory };
}

/** Send a single user message (optionally with an image) to a fresh-or-seeded cap. */
async function send(cap: CalendarCapability, text: string, img?: ImageAttachable): Promise<{ reply: string; tools: string[] }> {
  const bundle = await cap.buildTurn({ channelId: 'C', guildId: 'G', userId: 'U', userTag: 'mod', now: NOW });
  const tools: string[] = [];
  const spied: ComposedTools = { tools: bundle.tools.tools, handle: (n, i) => { tools.push(n); return bundle.tools.handle(n, i); } };
  const turn: Turn = { role: 'user', content: text, ...(img ? { attachments: [img] } : {}) };
  try {
    const reply = await ask({ system: bundle.system, messages: [turn], tools: spied });
    return { reply, tools };
  } catch (e) {
    return { reply: `[ERR ${(e as Error).name}: ${String((e as Error).message).slice(0, 80)}]`, tools };
  }
}

type Check = { create: number; override: number; dedup: number; oneoff: number; vision: number; leak: boolean; err?: string };

async function battery(): Promise<Check> {
  const c: Check = { create: 0, override: 0, dedup: 0, oneoff: 0, vision: 0, leak: false };
  const replies: string[] = [];

  // create
  {
    const { cap, store, memory } = await freshCap();
    const { reply } = await send(cap, 'crea el evento "Club de cine" todos los jueves a las 8 pm en la sala de cine, para ver Andor');
    replies.push(reply);
    const w = store.listAll().filter((e) => e.recurrence_freq === 'weekly' && /cine|andor/i.test(e.title));
    if (w.length === 1 && /Thursday/.test(localStr(w[0].start_at)) && /20:00/.test(localStr(w[0].start_at)) && (w[0].location ?? '').length > 0) c.create = 1;
    memory.close();
  }
  // override
  {
    const { cap, store, memory } = await freshCap();
    const master = store.create({ created_by: 'S', title: 'Club de cine', start_at: THU_25, recurrence_freq: 'weekly', location: 'Sala de cine' });
    const { reply } = await send(cap, 'En la serie "Club de cine", SOLO el jueves 25 de junio cambia el título a "Club de cine: tanta verdad". Las demás semanas quedan igual.');
    replies.push(reply);
    const ov = store.overridesByMaster().get(master.id)?.size ?? 0;
    const fresh = store.get(master.id);
    if (ov >= 1 && fresh?.recurrence_freq === 'weekly' && store.listAll().length === 1) c.override = 1;
    memory.close();
  }
  // dedup
  {
    const { cap, store, memory } = await freshCap();
    store.create({ created_by: 'S', title: 'Círculo de estudios: Repensar la pobreza', start_at: SUN_28, recurrence_freq: 'weekly', location: 'Salón de círculo de estudio' });
    const { reply } = await send(cap, 'crea el evento "Círculo de Estudio: Repensar la Pobreza", todos los domingos a las 8 pm en Salón de Círculo de Estudio');
    replies.push(reply);
    if (store.listAll().length === 1) c.dedup = 1;
    memory.close();
  }
  // oneoff
  {
    const { cap, store, memory } = await freshCap();
    const { reply } = await send(cap, 'crea un evento único para mañana: "Asamblea ordinaria", a las 8 pm, en sala de juntas');
    replies.push(reply);
    const o = store.listAll().filter((e) => !e.recurrence_freq && /asamblea/i.test(e.title));
    if (o.length === 1 && /Tuesday/.test(localStr(o[0].start_at)) && /20:00/.test(localStr(o[0].start_at))) c.oneoff = 1;
    memory.close();
  }
  // vision (gating)
  {
    const { cap, memory } = await freshCap();
    const { reply } = await send(cap, 'Responde SOLO con el color dominante de esta imagen, en una palabra.', new ImageAttachable('r.png', 'image/png', RED, 'png'));
    replies.push(reply);
    if (/rojo|red/i.test(reply)) c.vision = 1;
    if (/\[ERR/.test(reply)) c.err = reply;
    memory.close();
  }

  c.leak = replies.some((r) => /<\/?thinking/i.test(r));
  return c;
}

async function main() {
  console.log('=== Open-weight model competition (image-capable) ===');
  console.log(`now(local): ${localStr(NOW.getTime())} · ${RUNS} runs/model · scores summed over runs\n`);
  const dim = '\x1b[2m', rst = '\x1b[0m';

  const results: Array<{ id: string; ref: boolean; create: number; override: number; dedup: number; oneoff: number; vision: number; leaks: number; total: number; visionOk: boolean }> = [];

  for (const m of MODELS) {
    config.BEDROCK_MODEL_ID = m.id;
    const agg = { create: 0, override: 0, dedup: 0, oneoff: 0, vision: 0, leaks: 0 };
    let lastErr = '';
    for (let r = 0; r < RUNS; r++) {
      const c = await battery();
      agg.create += c.create; agg.override += c.override; agg.dedup += c.dedup; agg.oneoff += c.oneoff; agg.vision += c.vision;
      if (c.leak) agg.leaks++;
      if (c.err) lastErr = c.err;
    }
    const total = agg.create + agg.override + agg.dedup + agg.oneoff; // calendar reasoning, out of 4*RUNS
    const visionOk = agg.vision > 0;
    results.push({ id: m.id, ref: !!m.ref, ...agg, total, visionOk });
    console.log(
      `${m.ref ? `${dim}[ref]${rst} ` : '      '}${m.id.padEnd(46)} ` +
      `create ${agg.create}/${RUNS}  override ${agg.override}/${RUNS}  dedup ${agg.dedup}/${RUNS}  oneoff ${agg.oneoff}/${RUNS}  ` +
      `vision ${agg.vision}/${RUNS}  ${agg.leaks ? `${'\x1b[31m'}leak×${agg.leaks}${rst}` : 'clean'}` +
      (lastErr ? `  ${dim}${lastErr}${rst}` : ''),
    );
  }

  // Winner: open-weight, vision-capable, highest calendar score; tiebreak fewer leaks then more vision.
  const eligible = results.filter((r) => !r.ref && r.visionOk);
  eligible.sort((a, b) => b.total - a.total || a.leaks - b.leaks || b.vision - a.vision);
  console.log();
  if (eligible.length === 0) {
    console.log('\x1b[31mNo open-weight contender passed the vision gate.\x1b[0m');
  } else {
    const w = eligible[0];
    const ref = results.find((r) => r.ref);
    console.log(`🏆 Winner (open-weight, image-capable): \x1b[32m${w.id}\x1b[0m`);
    console.log(`   calendar ${w.total}/${4 * RUNS}, vision ${w.vision}/${RUNS}, leaks ${w.leaks}`);
    if (ref) console.log(`   ${dim}reference Haiku: calendar ${ref.total}/${4 * RUNS}, vision ${ref.vision}/${RUNS}, leaks ${ref.leaks}${rst}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('competition crashed:', e); process.exit(1); });
