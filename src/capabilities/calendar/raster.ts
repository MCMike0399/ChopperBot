import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/**
 * Rasterize the first page of a PDF to PNG bytes via poppler's `pdftoppm`
 * (installed at /usr/bin on the Pi, on the systemd service PATH).
 *
 * Why: Discord renders PNG attachments inline as a preview, but shows PDFs as
 * non-previewing download cards — so the published month calendar uses the PNG
 * as its hero image (the PDF rides along for print quality). Throws on failure;
 * the publisher catches it and falls back to PDF-only so publishing never
 * breaks if poppler is missing.
 */
export async function pdfToPng(pdfBytes: Uint8Array, dpi = 150): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'chopper-cal-'));
  const pdfPath = join(dir, 'page.pdf');
  const outRoot = join(dir, 'page');
  try {
    await writeFile(pdfPath, pdfBytes);
    await execFileP('pdftoppm', ['-png', '-r', String(dpi), '-singlefile', pdfPath, outRoot], {
      maxBuffer: 96 * 1024 * 1024,
      timeout: 30_000,
    });
    return new Uint8Array(await readFile(`${outRoot}.png`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
