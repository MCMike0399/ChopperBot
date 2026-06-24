/**
 * Live end-to-end smoke test against real Amazon Bedrock (Converse API).
 *
 * Validates the full production LLM path:
 *   1. src/llm/client.ts authenticates to Bedrock with ACCESS_KEY_ID /
 *      SECRET_ACCESS_KEY / AWS_REGION and a plain no-tools turn returns text.
 *   2. A multi-step tool-calling turn: the model emits a tool_use, the loop
 *      runs the handler, sends the toolResult back, and the model synthesizes
 *      a final answer (this is the calendar/config agent loop in miniature).
 *   3. An image attachment is accepted (vision) — the IG flyer path.
 *   4. The REAL IG post classifier (classifyPost) returns valid JSON for both
 *      a relevant convocatoria and an irrelevant meme — exercising the exact
 *      code that runs in the Instagram monitor.
 *
 * Usage:  npx tsx scripts/live-bedrock-smoke.ts
 *
 * Does NOT run inside `pnpm test` (that suite mocks the AWS SDK). This script
 * makes real Bedrock calls and spends a small amount of token budget.
 */
import 'dotenv/config';
import { deflateSync } from 'node:zlib';
import { config } from '../src/config.js';
import { ask } from '../src/llm/client.js';
import { composeToolSources, type ToolSource } from '../src/tools/source.js';
import { ImageAttachable } from '../src/attachments/attachable.js';
import { classifyPost } from '../src/capabilities/instagram_monitor/classifier.js';
import type { RecentPost } from '../src/capabilities/instagram_monitor/fetcher.js';

// Build a valid solid-color RGB PNG of size×size. Bedrock/Nova rejects
// degenerate 1×1 images ("may not meet the required format"), so we synthesize
// a real one (a 64×64 here) the way a downloaded IG flyer cover would look.
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const len = data.length;
  const out = new Uint8Array(4 + body.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc32(body));
  return out;
}
function makeSolidPng(size: number, r: number, g: number, b: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}
const RED_PNG = makeSolidPng(64, 220, 30, 30);

const greenCheck = '\x1b[32m✓\x1b[0m';
const redX = '\x1b[31m✗\x1b[0m';
let failures = 0;
function pass(label: string, detail?: string) {
  console.log(`${greenCheck} ${label}${detail ? '  ' + detail : ''}`);
}
function fail(label: string, err: unknown) {
  failures++;
  console.log(`${redX} ${label}`);
  console.log('   ', err instanceof Error ? err.message : String(err));
}
const short = (s: string) => (s.length > 90 ? s.slice(0, 90) + '…' : s);

// A trivial echo tool to exercise the tool_use → toolResult round-trip.
const echoSource: ToolSource = {
  name: 'echo',
  async systemPromptSection() {
    return 'You have an `echo` tool that returns the string you pass to it.';
  },
  tools() {
    return [
      {
        name: 'echo',
        description: 'Return the input text unchanged. Call this when the user asks to echo a literal value.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The text to echo back.' } },
          required: ['text'],
        },
      },
    ];
  },
  async handle(_name, input) {
    const obj = input as { text?: unknown };
    if (typeof obj?.text !== 'string') return { status: 'error', payload: { error: 'text must be a string' } };
    return { status: 'success', payload: { echoed: obj.text } };
  },
};

function fakePost(over: Partial<RecentPost> = {}): RecentPost {
  return {
    igPostId: '1',
    shortcode: 'ABC123',
    caption: '',
    takenAtMs: Date.parse('2026-06-20T18:00:00Z'),
    mediaType: 'image',
    displayUrl: 'https://example.com/x.jpg',
    ...over,
  };
}

async function main() {
  console.log('=== Live Bedrock smoke test ===');
  console.log('Region:', config.AWS_REGION);
  console.log('Model: ', config.BEDROCK_MODEL_ID);
  console.log('Key:   ', config.ACCESS_KEY_ID ? config.ACCESS_KEY_ID.slice(0, 6) + '…' : '(MISSING)');
  console.log();

  // 1. Plain text round-trip.
  try {
    const out = await ask({
      system: 'You are a terse assistant. Reply in fewer than 15 words.',
      messages: [{ role: 'user', content: 'Say "bedrock smoke ok" verbatim, then stop.' }],
      tools: composeToolSources([]),
    });
    out ? pass('plain text turn', short(out)) : fail('plain text turn', new Error('empty response'));
  } catch (err) {
    fail('plain text turn', err);
  }

  // 2. Tool-calling round-trip.
  try {
    const out = await ask({
      system:
        'You have an `echo` tool. When asked to echo something, call `echo` with the exact text, then report what it returned.',
      messages: [{ role: 'user', content: 'Use the echo tool to echo "bedrock-tool-ok" exactly, then tell me what it returned.' }],
      tools: composeToolSources([echoSource]),
    });
    out.toLowerCase().includes('bedrock-tool-ok')
      ? pass('tool-calling turn', short(out))
      : fail('tool-calling turn — echoed string missing', out);
  } catch (err) {
    fail('tool-calling turn', err);
  }

  // 3. Image attachment (vision).
  try {
    const img = new ImageAttachable('red.png', 'image/png', RED_PNG, 'png');
    const out = await ask({
      system: 'You can see images. Be terse.',
      messages: [{ role: 'user', content: 'What is the dominant color of the attached image? Reply with one word.', attachments: [img] }],
      tools: composeToolSources([]),
    });
    out ? pass('image attachment turn', short(out)) : fail('image attachment turn', new Error('empty response'));
  } catch (err) {
    fail('image attachment turn', err);
  }

  // 4. The REAL IG classifier — relevant convocatoria.
  try {
    const c = await classifyPost(
      'colectiva_demo',
      fakePost({
        caption:
          '📣 CONVOCATORIA: Asamblea feminista este sábado 21 de junio, 17:00 hrs en el Zócalo de la CDMX. Trae pancartas. ¡Te esperamos!',
      }),
      { nowMs: Date.parse('2026-06-19T12:00:00Z') },
    );
    if (c.reason) fail('classifier (convocatoria)', new Error(c.reason));
    else if (c.relevant && (c.type === 'convocatoria' || c.type === 'evento'))
      pass('classifier (convocatoria)', `type=${c.type} when=${c.when ?? '∅'} where=${short(c.where ?? '∅')}`);
    else fail('classifier (convocatoria) — expected relevant convocatoria/evento', JSON.stringify(c));
  } catch (err) {
    fail('classifier (convocatoria)', err);
  }

  // 4b. The REAL IG classifier — irrelevant meme.
  try {
    const c = await classifyPost(
      'colectiva_demo',
      fakePost({ shortcode: 'MEME1', caption: 'jajaja buen lunes 😂😂 #meme #frase' }),
      { nowMs: Date.parse('2026-06-19T12:00:00Z') },
    );
    if (c.reason) fail('classifier (meme)', new Error(c.reason));
    else if (!c.relevant) pass('classifier (meme)', `correctly not relevant (type=${c.type})`);
    else fail('classifier (meme) — expected not relevant', JSON.stringify(c));
  } catch (err) {
    fail('classifier (meme)', err);
  }

  console.log();
  if (failures === 0) {
    console.log(`${greenCheck} All live Bedrock smoke checks passed.`);
    process.exit(0);
  } else {
    console.log(`${redX} ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
