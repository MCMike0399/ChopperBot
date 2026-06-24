/**
 * Effort-tier model bake-off for ChopperBot (2026-06-23).
 *
 * Goal: pick the right Bedrock model for each effort tier
 *   high   → calendar/chat (already Sonnet; not re-litigated here)
 *   medium → IG post classification + summary writing
 *   low    → cheap/bulk image understanding (flyer text extraction)
 *
 * Three experiments, all spend REAL Bedrock budget (run with LOG_LEVEL=warn):
 *   A. VISION — synthesize a dense Spanish "report this group" flyer (the exact
 *      failure the moderator hit: text in the image, not the caption) and score
 *      each candidate on extracting the embedded group name + platform.
 *   B. CLASSIFY — replay REAL captions from data/chopperbot.db through each
 *      candidate and compare relevance/type against the stored Sonnet output.
 *   C. CHAT — a casual Spanish message; print replies to judge tone/friendliness.
 *
 * Usage:  LOG_LEVEL=warn npx tsx scripts/effort-experiment.ts
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from '../src/config.js';
import { ask } from '../src/llm/client.js';
import { SYSTEM_PROMPT, parseClassificationReply } from '../src/capabilities/instagram_monitor/classifier.js';
import { composeToolSources } from '../src/tools/source.js';
import { ImageAttachable } from '../src/attachments/attachable.js';
import type { Turn } from '../src/discord/history.js';

const execFileP = promisify(execFile);
const DB_PATH = join(process.cwd(), 'data', 'chopperbot.db');

// Candidates per tier. We override BEDROCK_MODEL_ID directly (ask() reads it for
// effort 'high'); for the experiment we just point that var at each candidate.
const VISION_CANDIDATES = [
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.amazon.nova-pro-v1:0',
  'us.amazon.nova-lite-v1:0',
];
const CLASSIFY_CANDIDATES = [
  'us.anthropic.claude-sonnet-4-6', // reference (matches stored labels)
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.amazon.nova-pro-v1:0',
];
const CHAT_CANDIDATES = VISION_CANDIDATES;

const NOW = Date.now();
const noTools = composeToolSources([]);

/** Run one plain ask against a specific model id (via effort 'high' → BEDROCK_MODEL_ID). */
async function askModel(modelId: string, system: string, turn: Turn): Promise<string> {
  config.BEDROCK_MODEL_ID = modelId;
  try {
    return await ask({ system, messages: [turn], tools: noTools, effort: 'high' });
  } catch (e) {
    return `[ERR ${(e as Error).name}: ${String((e as Error).message).slice(0, 100)}]`;
  }
}

// ---------------------------------------------------------------------------
// Flyer synthesis: a realistic activist "report & remove a group" call-to-action
// where the decisive facts (group name + platform) live ONLY in the image.
// ---------------------------------------------------------------------------
async function makeFlyerPng(): Promise<{ bytes: Uint8Array; format: 'png' }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([900, 1125]); // 4:5 IG portrait
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 900, height: 1125, color: rgb(0.08, 0.04, 0.12) });

  const lines: Array<{ t: string; size: number; f: typeof bold; color: ReturnType<typeof rgb> }> = [
    { t: 'REPORTA Y DIFUNDE', size: 56, f: bold, color: rgb(1, 0.85, 0.2) },
    { t: 'Ayudanos a eliminar este grupo', size: 30, f: reg, color: rgb(1, 1, 1) },
    { t: 'Grupo: "Mostrando mi mujer real"', size: 34, f: bold, color: rgb(1, 0.4, 0.45) },
    { t: 'Plataforma: Facebook', size: 32, f: bold, color: rgb(0.5, 0.8, 1) },
    { t: 'Es un grupo donde se comparten fotos', size: 24, f: reg, color: rgb(0.9, 0.9, 0.9) },
    { t: 'intimas de mujeres SIN su consentimiento.', size: 24, f: reg, color: rgb(0.9, 0.9, 0.9) },
    { t: 'Pasos para reportarlo:', size: 26, f: bold, color: rgb(1, 0.85, 0.2) },
    { t: '1. Entra al grupo en Facebook', size: 22, f: reg, color: rgb(0.85, 0.85, 0.85) },
    { t: '2. Toca los tres puntos y "Reportar grupo"', size: 22, f: reg, color: rgb(0.85, 0.85, 0.85) },
    { t: '3. Comparte esta publicacion', size: 22, f: reg, color: rgb(0.85, 0.85, 0.85) },
    { t: '#NiUnaMas  #BastaDeViolenciaDigital', size: 22, f: bold, color: rgb(1, 0.4, 0.45) },
  ];
  let y = 1010;
  for (const l of lines) {
    const w = l.f.widthOfTextAtSize(l.t, l.size);
    page.drawText(l.t, { x: (900 - w) / 2, y, size: l.size, font: l.f, color: l.color });
    y -= l.size + 34;
  }
  const pdf = await doc.save();

  const dir = await mkdtemp(join(tmpdir(), 'effort-flyer-'));
  try {
    const p = join(dir, 'f.pdf');
    await writeFile(p, pdf);
    await execFileP('pdftoppm', ['-png', '-r', '110', '-singlefile', p, join(dir, 'f')], { maxBuffer: 64 << 20 });
    const bytes = new Uint8Array(await readFile(join(dir, 'f.png')));
    return { bytes, format: 'png' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

async function experimentVision() {
  console.log('\n=== A. VISION — read text embedded in a flyer image ===');
  console.log(`${D}(the moderator's exact failure: facts are in the image, not the caption)${X}\n`);
  const flyer = await makeFlyerPng();
  const img = new ImageAttachable('flyer.png', 'image/png', flyer.bytes, 'png');
  const prompt =
    'Esta es la imagen (portada) de un post de Instagram. Transcribe TODO el texto visible, ' +
    'y luego responde en una línea: ¿cómo se llama el grupo y en qué plataforma está?';
  for (const m of VISION_CANDIDATES) {
    const reply = await askModel(m, 'Eres un asistente que lee imágenes con precisión.', {
      role: 'user',
      content: prompt,
      attachments: [img],
    });
    const grupo = /mostrando mi mujer real/i.test(reply);
    const plat = /facebook/i.test(reply);
    const verdict = grupo && plat ? `${G}PASS${X}` : `${R}FAIL${X}`;
    console.log(`${verdict}  ${m}   grupo:${grupo ? '✓' : '✗'} plataforma:${plat ? '✓' : '✗'}`);
    console.log(`${D}${reply.replace(/\n+/g, ' ').slice(0, 220)}${X}\n`);
  }
}

interface SampleRow {
  account_username: string;
  caption: string | null;
  media_type: string | null;
  posted_at: number | null;
  ig_post_id: string;
  classification_json: string;
}

function loadSamples(): SampleRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Balanced sample: relevant + non-relevant, distinct captions, recent.
    const rel = db
      .prepare(
        `SELECT account_username, caption, media_type, posted_at, ig_post_id, classification_json
         FROM instagram_monitor_seen_posts
         WHERE classification_json IS NOT NULL
           AND json_extract(classification_json,'$.relevant')=1
           AND caption IS NOT NULL AND length(caption)>40
         GROUP BY ig_post_id ORDER BY detected_at DESC LIMIT 14`,
      )
      .all() as SampleRow[];
    const irr = db
      .prepare(
        `SELECT account_username, caption, media_type, posted_at, ig_post_id, classification_json
         FROM instagram_monitor_seen_posts
         WHERE classification_json IS NOT NULL
           AND json_extract(classification_json,'$.relevant')=0
           AND caption IS NOT NULL AND length(caption)>40
         GROUP BY ig_post_id ORDER BY detected_at DESC LIMIT 10`,
      )
      .all() as SampleRow[];
    return [...rel, ...irr];
  } finally {
    db.close();
  }
}

async function experimentClassify() {
  console.log('\n=== B. CLASSIFY — replay real captions, compare vs stored Sonnet labels ===\n');
  const samples = loadSamples();
  const gold = samples.map((s) => parseClassificationReply(s.classification_json));
  console.log(`${samples.length} real posts (${gold.filter((g) => g?.relevant).length} relevant per stored labels)\n`);

  for (const m of CLASSIFY_CANDIDATES) {
    let relAgree = 0, typeAgree = 0, parseFail = 0, leaks = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const userText = [
        `Cuenta: @${s.account_username}`,
        `Fecha del post (UTC): ${new Date(s.posted_at ?? NOW).toISOString()}`,
        `Tipo de medio: ${s.media_type ?? 'image'}`,
        '',
        'Caption:',
        s.caption || '(sin caption)',
      ].join('\n');
      const raw = await askModel(m, SYSTEM_PROMPT, { role: 'user', content: userText });
      if (/<\/?think/i.test(raw)) leaks++;
      const out = parseClassificationReply(raw);
      if (!out) { parseFail++; continue; }
      const g = gold[i];
      if (g && out.relevant === g.relevant) relAgree++;
      if (g && out.type === g.type) typeAgree++;
    }
    const n = samples.length;
    console.log(
      `${m.padEnd(46)} relAgree ${relAgree}/${n}  typeAgree ${typeAgree}/${n}  ` +
        `parseFail ${parseFail}  ${leaks ? `${R}leak×${leaks}${X}` : 'clean'}`,
    );
  }
}

async function experimentChat() {
  console.log('\n=== C. CHAT — friendliness/tone on a casual Spanish message ===\n');
  const sys =
    'Eres ChopperBot, un bot amigable de un servidor de Discord de colectivos activistas en México. ' +
    'Hablas en español, con calidez y cercanía, sin ser meloso.';
  const turn: Turn = { role: 'user', content: 'oye chopper, ando bajoneado hoy :( cuéntame algo que me suba el ánimo' };
  for (const m of CHAT_CANDIDATES) {
    const reply = await askModel(m, sys, turn);
    console.log(`${G}— ${m}${X}`);
    console.log(`${reply.slice(0, 400)}\n`);
  }
}

async function main() {
  console.log('ChopperBot effort-tier bake-off · real Bedrock · real DB captions');
  await experimentVision();
  await experimentClassify();
  await experimentChat();
  process.exit(0);
}

main().catch((e) => { console.error('experiment crashed:', e); process.exit(1); });
