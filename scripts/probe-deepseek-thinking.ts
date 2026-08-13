/**
 * Probe: does deepseek-v4-flash honour a per-request thinking/effort knob, and
 * what does each setting cost in reasoning tokens + latency + tool-calling?
 *
 * The docs say `thinking: {type, reasoning_effort}` is supported on v4-flash.
 * The repo's older probe used a TOP-LEVEL `reasoning_effort`. Test both shapes:
 * an unknown param that is silently ignored is the dangerous outcome, because
 * it looks like it works while changing nothing.
 */
import OpenAI from 'openai';
import { config } from 'dotenv';
config({ override: false });

const key = process.env.DEEPSEEK_API_KEY ?? process.env.DEEP_SEEK_API_KEY!;
const client = new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com/v1' });
const MODEL = 'deepseek-v4-flash';

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'calendar_create_event',
      description: 'Crea un evento en el calendario.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start_at: { type: 'string', description: 'ISO 8601' },
          location: { type: 'string' },
        },
        required: ['title', 'start_at'],
      },
    },
  },
];

const PROMPT =
  'Agenda el Círculo de estudios el próximo jueves a las 20:00 en la Casa del Pueblo. Hoy es lunes 2026-08-17.';

const REPS = 3;

/** Run a variant REPS times and report the mean — a single sample cannot tell
 *  an honoured knob from an ignored one, because DeepSeek silently ignores an
 *  invalid `reasoning_effort` (the `banana` control returns 200, not 400). */
async function variant(label: string, extra: Record<string, unknown>) {
  const ms: number[] = [];
  const out: number[] = [];
  const think: number[] = [];
  let tools = '—';
  let toolOk = 0;
  for (let i = 0; i < REPS; i++) {
    const one = await once(extra);
    if (!one) continue;
    ms.push(one.ms);
    out.push(one.out);
    think.push(one.think);
    tools = one.tools;
    if (one.tools.includes('calendar_create_event')) toolOk++;
  }
  const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1);
  console.log(
    `${label.padEnd(34)} ${String(mean(ms)).padStart(6)}ms  out=${String(mean(out)).padStart(4)}` +
      `  reasoning_tok=${String(mean(think)).padStart(4)}  tool_ok=${toolOk}/${REPS}  [${think.join(',')}]`,
  );
}

async function once(extra: Record<string, unknown>) {
  const t0 = Date.now();
  try {
    const r: any = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: 'Eres ChopperBot. Usa las herramientas cuando corresponda.' },
        { role: 'user', content: PROMPT },
      ],
      tools: TOOLS,
      ...extra,
    } as any);
    const msg = r.choices[0]?.message;
    const u = r.usage ?? {};
    return {
      ms: Date.now() - t0,
      out: u.completion_tokens ?? 0,
      think: u.completion_tokens_details?.reasoning_tokens ?? 0,
      tools: (msg?.tool_calls ?? []).map((c: any) => c.function?.name).join(',') || '—',
    };
  } catch (e: any) {
    console.log(`   ERROR ${e.status ?? ''} ${String(e.message).slice(0, 110)}`);
    return null;
  }
}

async function main() {
  console.log(`model: ${MODEL}\n`);
  await variant('baseline (no knob)', {});
  await variant('thinking enabled/high', { thinking: { type: 'enabled', reasoning_effort: 'high' } });
  await variant('thinking enabled/low', { thinking: { type: 'enabled', reasoning_effort: 'low' } });
  await variant('thinking enabled/max', { thinking: { type: 'enabled', reasoning_effort: 'max' } });
  await variant('thinking disabled', { thinking: { type: 'disabled' } });
  await variant('top-level reasoning_effort=low', { reasoning_effort: 'low' });
  await variant('top-level reasoning_effort=high', { reasoning_effort: 'high' });
  await variant('bogus knob (control)', { thinking: { type: 'enabled', reasoning_effort: 'banana' } });
}

void main();
