/**
 * Calendar capability smoke test against the REAL text model (Kimi — the
 * calendar runs on the `high` text tier). Replays real Discord conversations:
 * a recurring series, a single-occurrence override, one-off create + delete,
 * duplicate detection, plain chat, and the **bounded-series** scenes added
 * 2026-08-03 (Scenes 8–10) that guard the regression below.
 *
 * Scene 9 replays an actual production failure (journal, 2026-07-10): a mod
 * booked a weekly book club and the bot created FOUR separate one-off rows,
 * because the tools only offered "weekly → forever". The hard check is
 * therefore "ONE row, bounded" — not just "some event exists".
 *
 * Drives the actual CalendarCapability + ask() against an in-memory SQLite
 * store. No Discord client → the publisher is a no-op (publishing "disabled"),
 * but every create/update/delete still hits the DB, so we verify the model
 * picked the right tools by inspecting the store.
 *
 * Reply-chain fidelity: each `@ChopperBot ...` starts a FRESH chain (empty
 * history — the model must rely on the upcoming-events snapshot baked into the
 * system prompt), and bare follow-ups continue the chain.
 *
 * Usage:  LOG_LEVEL=warn npx tsx scripts/calendar-bedrock-smoke.ts
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { CalendarCapability } from '../src/capabilities/calendar/capability.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { countOccurrencesUntil } from '../src/capabilities/calendar/recurrence.js';
import { ask } from '../src/llm/client.js';
import type { Turn } from '../src/discord/history.js';
import type { ComposedTools } from '../src/tools/source.js';

// Frozen "now" = Monday 2026-06-22 21:00 America/Mexico_City (UTC-6), matching
// the original conversation: "mañana" = Tue 23, "jueves" = Thu 25.
const NOW = new Date('2026-06-23T03:00:00.000Z');
const TZ = 'America/Mexico_City';

const g = '\x1b[32m', y = '\x1b[33m', r = '\x1b[31m', dim = '\x1b[2m', rst = '\x1b[0m';
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

function localStr(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

const memory = new SqliteMemoryStore({ path: ':memory:' });
const cap = new CalendarCapability();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' } as any);
const store = new CalendarStore(memory.db());

const byTitle = (re: RegExp) => store.listAll().filter((e) => re.test(e.title));
const overrideCountFor = (masterId: number) =>
  store.overridesByMaster().get(masterId)?.size ?? 0;

// One Discord chain. `say()` rebuilds the turn (fresh snapshot) each message,
// threads history within the chain, and records which tools the model called.
function newChain() {
  const history: Turn[] = [];
  return async function say(user: string, userTag = 'mod'): Promise<{ reply: string; tools: string[] }> {
    const bundle = await cap.buildTurn({
      channelId: 'INPUT', guildId: 'G1', userId: `U_${userTag}`, userTag, now: NOW,
    });
    const tools: string[] = [];
    const spied: ComposedTools = {
      tools: bundle.tools.tools,
      handle: (n, i) => {
        tools.push(n);
        return bundle.tools.handle(n, i);
      },
    };
    history.push({ role: 'user', content: user });
    let reply: string;
    try {
      reply = await ask({ system: bundle.system, messages: history, tools: spied });
    } catch (err) {
      reply = `[ask() threw: ${err instanceof Error ? err.message : String(err)}]`;
    }
    history.push({ role: 'assistant', content: reply });
    console.log(`\n${dim}user(${userTag}):${rst} ${user}`);
    console.log(`${dim}bot:${rst} ${reply.replace(/\n/g, '\n     ')}`);
    if (tools.length) console.log(`${dim}     tools: ${tools.join(', ')}${rst}`);
    return { reply, tools };
  };
}

async function main() {
  console.log('=== Calendar capability smoke (Bedrock) ===');
  console.log(`Model: ${config.BEDROCK_MODEL_ID}   now(local): ${localStr(NOW.getTime())}\n`);

  // ── Scene 1: create a recurring series, with a missing-location clarification ──
  console.log('── Scene 1: crear serie semanal (Club de cine), aclarando lugar ──');
  {
    const say = newChain();
    await say('crea el evento de club de cine todos los jueves a las 8:00 para ver andor de star wars');
    await say('sala de cine');
    // A more cautious model may ask for the start date instead of inferring the
    // next Thursday. Supply it only if the series isn't created yet — fair to
    // both the inferring (Nova) and asking (Haiku) styles.
    if (byTitle(/cine|andor/i).filter((e) => e.recurrence_freq === 'weekly').length === 0) {
      await say('empieza este jueves 25 de junio');
    }
    const cine = byTitle(/cine|andor/i);
    const weekly = cine.filter((e) => e.recurrence_freq === 'weekly');
    check(weekly.length >= 1, 'serie semanal de cine creada', `${weekly.length} match(es): ${cine.map((e) => `#${e.id} "${e.title}"`).join('; ')}`);
    if (weekly[0]) {
      const ls = localStr(weekly[0].start_at);
      check(/Thursday/.test(ls) && /20:00/.test(ls), 'arranca jueves 20:00', ls);
      const loc = weekly[0].location ?? '';
      if (/cine|sala/i.test(loc)) check(true, 'lugar capturado', loc);
      else warn('lugar no capturado como se esperaba', `location=${JSON.stringify(loc)}`);
      if (cine.length > 1) warn('se creó más de un evento de cine', `total=${cine.length}`);
    }
  }

  // ── Scene 2: edit a SINGLE occurrence (occurrence-scope override) ──
  console.log('\n── Scene 2: editar solo una ocurrencia (24→corrige a 25 jun) ──');
  {
    const master = byTitle(/cine|andor/i).find((e) => e.recurrence_freq === 'weekly');
    const before = master ? overrideCountFor(master.id) : 0;
    const say = newChain();
    await say('el evento de andor ahora veremos un poquito de tanta verdad solo el 24 de junio');
    await say('sí el 25 me equivoqué xd');
    if (!master) { check(false, 'no hay serie de cine para editar'); }
    else {
      const after = overrideCountFor(master.id);
      if (after > before) check(true, 'override de una sola ocurrencia creado', `master #${master.id}, overrides=${after}`);
      else warn('no se registró un override de ocurrencia', `overrides=${after} (¿editó la serie completa?)`);
      // The whole series must NOT have been retitled/retimed.
      const fresh = store.get(master.id)!;
      check(fresh.recurrence_freq === 'weekly', 'la serie sigue siendo semanal (no se rompió)', `freq=${fresh.recurrence_freq}`);
    }
  }

  // ── Scene 3: republish on demand ──
  console.log('\n── Scene 3: republicar el calendario ──');
  {
    const say = newChain();
    const { tools } = await say('republica el calendario');
    check(tools.includes('calendar_publish'), 'llamó a calendar_publish', tools.join(', ') || '(ninguna)');
  }

  // ── Scene 4: one-off event for "mañana" ──
  console.log('\n── Scene 4: evento único para mañana (Asamblea ordinaria) ──');
  {
    const say = newChain();
    await say('publica un nuevo evento unico mañana de asamblea ordinaria a las 8pm en sala de juntas');
    const asamblea = byTitle(/asamblea/i);
    const oneOff = asamblea.filter((e) => !e.recurrence_freq);
    check(oneOff.length === 1, 'evento único de asamblea creado', asamblea.map((e) => `#${e.id} "${e.title}" freq=${e.recurrence_freq ?? 'one-off'}`).join('; ') || '(ninguno)');
    if (oneOff[0]) check(/Tuesday/.test(localStr(oneOff[0].start_at)) && /20:00/.test(localStr(oneOff[0].start_at)), 'es martes 23 a las 20:00', localStr(oneOff[0].start_at));
  }

  // ── Scene 5: delete that one-off ──
  console.log('\n── Scene 5: borrar la asamblea de mañana ──');
  {
    const say = newChain();
    await say('borra el evento de asamblea ordinaria de mañana');
    // The prompt REQUIRES confirming the exact event once before deleting, so a
    // "¿lo borro?" here is correct behavior, not a miss — answer it.
    if (byTitle(/asamblea/i).length > 0) await say('sí');
    check(byTitle(/asamblea/i).length === 0, 'la asamblea fue eliminada', byTitle(/asamblea/i).map((e) => `#${e.id}`).join(', ') || 'sin eventos de asamblea');
  }

  // ── Scene 6: duplicate detection (pre-seed an existing weekly Sunday event) ──
  console.log('\n── Scene 6: detección de duplicado (Círculo de Estudio ya existe) ──');
  {
    store.create({
      created_by: 'SEED',
      title: 'Círculo de estudios: Repensar la pobreza',
      start_at: Date.parse('2026-06-28T20:00:00-06:00'), // next Sunday 20:00 CST
      location: 'Salón de círculo de estudio',
      recurrence_freq: 'weekly',
    });
    const before = byTitle(/repensar la pobreza/i).length;
    const say = newChain();
    const { reply } = await say(
      'crea el evento llamado "Círculo de Estudio: Repensar la Pobreza", todos los domingos a las 8:00 p.m. en el canal de "Salón de Círculo de Estudio".',
    );
    const after = byTitle(/repensar la pobreza/i).length;
    check(after === before, 'no creó un duplicado', `antes=${before} después=${after}`);
    if (/exist|ya (está|hay)|duplicad/i.test(reply)) check(true, 'avisó que ya existe');
    else warn('no dijo explícitamente "ya existe" (pero no duplicó)', '');
  }

  // ── Scene 7: plain conversational acks (no DB mutation) ──
  console.log('\n── Scene 7: charla simple (sin tocar el calendario) ──');
  {
    const say = newChain();
    const a = await say('gracias, todo bien');
    const b = await say('eres genial');
    const mutators = ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event'];
    const touched = [...a.tools, ...b.tools].filter((t) => mutators.includes(t));
    check(touched.length === 0, 'no ejecutó tools que muten el calendario', touched.join(', ') || 'ninguna');
    check(a.reply.length > 0 && b.reply.length > 0, 'respondió en ambos turnos');
  }

  // ── Scene 8: bounded series from an explicit count ("6 sesiones") ──
  console.log('\n── Scene 8: serie acotada por número de sesiones ──');
  {
    const say = newChain();
    await say('crea un taller de serigrafía cada jueves a las 7 pm, son 6 sesiones, empieza este jueves');
    const taller = byTitle(/serigraf/i);
    check(taller.length === 1, 'creó UNA sola fila (no una por sesión)', taller.map((e) => `#${e.id} ${e.recurrence_freq ?? 'one-off'}`).join('; ') || '(ninguna)');
    const s = taller.find((e) => e.recurrence_freq === 'weekly');
    if (!s) check(false, 'es una serie semanal', taller.map((e) => e.recurrence_freq ?? 'one-off').join(', '));
    else {
      check(s.recurrence_until !== null, 'la serie quedó ACOTADA (no indefinida)', s.recurrence_until ? localStr(s.recurrence_until) : 'recurrence_until=null');
      const n = countOccurrencesUntil(s.start_at, 'weekly', s.recurrence_until);
      check(n === 6, 'son exactamente 6 ocurrencias', `n=${n}`);
    }
  }

  // ── Scene 9: "todos los martes de julio" — the 4-one-off-rows regression ──
  console.log('\n── Scene 9: rango implícito por mes (regresión de las 4 filas) ──');
  {
    const say = newChain();
    await say('crea el círculo de lectura "Raíz que no desaparece" todos los martes de julio a las 8pm');
    const circ = byTitle(/ra[íi]z que no desaparece/i);
    check(circ.length === 1, 'creó UNA sola fila, no una por martes', circ.map((e) => `#${e.id} ${e.recurrence_freq ?? 'one-off'} ${localStr(e.start_at)}`).join('; ') || '(ninguna)');
    const s = circ.find((e) => e.recurrence_freq === 'weekly');
    if (!s) check(false, 'es una serie semanal', circ.map((e) => e.recurrence_freq ?? 'one-off').join(', '));
    else {
      check(s.recurrence_until !== null, '"de julio" se interpretó como RANGO', s.recurrence_until ? `hasta ${localStr(s.recurrence_until)}` : 'recurrence_until=null (quedó indefinida)');
      const n = countOccurrencesUntil(s.start_at, 'weekly', s.recurrence_until);
      if (n === 4 || n === 5) check(true, 'cubre los martes de julio', `n=${n}`);
      else warn('número de martes inesperado', `n=${n}`);
      if (!/Tuesday/.test(localStr(s.start_at))) warn('no arranca en martes', localStr(s.start_at));
    }
  }

  // ── Scene 10: no range hint → asks once, accepts "indefinida" ──
  console.log('\n── Scene 10: sin pista de rango → pregunta una vez, acepta indefinida ──');
  {
    const say = newChain();
    const first = await say('crea la asamblea permanente todos los sábados a las 8pm');
    const askedRange = /hasta cu[áa]ndo|cu[áa]ntas sesiones|indefinid/i.test(first.reply);
    if (askedRange) check(true, 'preguntó por el rango (una vez)');
    else warn('no preguntó por el rango', 'aceptable si la creó indefinida de una');
    if (byTitle(/asamblea permanente/i).length === 0) await say('indefinida');
    const perm = byTitle(/asamblea permanente/i);
    check(perm.length === 1, 'creó UNA sola fila', perm.map((e) => `#${e.id}`).join('; ') || '(ninguna)');
    const s = perm.find((e) => e.recurrence_freq === 'weekly');
    if (!s) check(false, 'es una serie semanal', perm.map((e) => e.recurrence_freq ?? 'one-off').join(', '));
    else check(s.recurrence_until === null, 'quedó INDEFINIDA (no la bloqueó ni la acotó sola)', `until=${s.recurrence_until}`);
  }

  // ── Final calendar state ──
  console.log('\n── Estado final del calendario ──');
  for (const e of store.listAll()) {
    console.log(`  #${e.id} ${dim}|${rst} "${e.title}" ${dim}|${rst} ${e.recurrence_freq ?? 'one-off'} ${dim}|${rst} ${localStr(e.start_at)} ${dim}|${rst} ${e.location ?? '—'} ${dim}| overrides=${overrideCountFor(e.id)}${rst}`);
  }

  console.log();
  if (failures === 0) console.log(`${g}✓ All calendar smoke checks passed.${rst}`);
  else console.log(`${r}✗ ${failures} hard check(s) failed${rst} (see ~ warnings for soft model-behavior notes).`);
  memory.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Calendar smoke crashed:', err);
  process.exit(1);
});
