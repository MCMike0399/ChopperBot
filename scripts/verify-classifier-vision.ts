/**
 * End-to-end proof of the IG classifier's NEW vision path against LIVE Bedrock.
 * Exercises the exact production code: sniff a real JPEG's format (as the
 * scheduler does) → classifyPost(..., { cover }) → medium tier (Haiku) → parse.
 *
 * The flyer's decisive facts live ONLY in the image (thin caption), mirroring
 * the moderator's failure case. PASS = the classifier reads the flyer.
 *
 * Usage:  LOG_LEVEL=warn npx tsx scripts/verify-classifier-vision.ts
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { classifyPost } from '../src/capabilities/instagram_monitor/classifier.js';
import { sniffImageFormat } from '../src/attachments/attachable.js';
import type { RecentPost } from '../src/capabilities/instagram_monitor/fetcher.js';

const execFileP = promisify(execFile);

/** Render a real JPEG flyer whose qué/cuándo/dónde is only in the image. */
async function makeFlyerJpeg(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([900, 1125]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 900, height: 1125, color: rgb(0.05, 0.07, 0.15) });
  const lines: Array<[string, number, typeof bold, ReturnType<typeof rgb>]> = [
    ['ASAMBLEA VECINAL', 56, bold, rgb(1, 0.85, 0.2)],
    ['contra la gentrificacion', 30, reg, rgb(1, 1, 1)],
    ['Sabado 28 de junio', 40, bold, rgb(0.5, 0.85, 1)],
    ['5:00 PM', 40, bold, rgb(0.5, 0.85, 1)],
    ['Parque Hundido, Col. Roma', 30, bold, rgb(1, 0.5, 0.55)],
    ['Trae tu mantita y tu rabia', 24, reg, rgb(0.9, 0.9, 0.9)],
    ['#BarrioQueResiste', 24, bold, rgb(1, 0.5, 0.55)],
  ];
  let y = 940;
  for (const [t, size, f, color] of lines) {
    const w = f.widthOfTextAtSize(t, size);
    page.drawText(t, { x: (900 - w) / 2, y, size, font: f, color });
    y -= size + 50;
  }
  const pdf = await doc.save();
  const dir = await mkdtemp(join(tmpdir(), 'verify-cls-'));
  try {
    const p = join(dir, 'f.pdf');
    await writeFile(p, pdf);
    // -jpeg → a REAL JPEG, exactly what IG's CDN serves.
    await execFileP('pdftoppm', ['-jpeg', '-r', '110', '-singlefile', p, join(dir, 'f')], { maxBuffer: 64 << 20 });
    return new Uint8Array(await readFile(join(dir, 'f.jpg')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const bytes = await makeFlyerJpeg();
  const format = sniffImageFormat(bytes); // the scheduler's exact step
  console.log(`flyer: ${bytes.byteLength} bytes, sniffed format = ${format}`);
  if (format !== 'jpeg') throw new Error(`expected jpeg, sniffed ${format}`);

  const post: RecentPost = {
    igPostId: '999',
    shortcode: 'VERIFY1',
    caption: 'Nos vemos ahí, compas 💜', // deliberately thin — facts are in the image
    takenAtMs: Date.parse('2026-06-23T18:00:00Z'),
    mediaType: 'image',
    displayUrl: 'n/a',
  };

  const c = await classifyPost('antigentrificacion.cdmx', post, {
    cover: { bytes, mimeType: `image/${format}`, format },
    nowMs: Date.now(),
  });

  console.log('\n=== classification (real Bedrock, medium tier) ===');
  console.log(JSON.stringify(c, null, 2));

  const readImage =
    /asamblea|gentrificaci/i.test(c.title + c.summary) &&
    (c.where ?? '').length > 0 &&
    (c.when ?? '').includes('2026-06-28');
  console.log(`\n${readImage ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — classifier ${readImage ? 'READ the flyer (date+place came only from the image)' : 'did NOT extract the image-only facts'}`);
  process.exit(readImage ? 0 : 1);
}

main().catch((e) => { console.error('verify crashed:', e); process.exit(1); });
