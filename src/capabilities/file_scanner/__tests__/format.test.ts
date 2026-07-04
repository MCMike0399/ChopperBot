import { describe, test, expect } from 'vitest';
import { toStats, verdictFrom } from '../virustotal.js';
import { isImageAttachment, renderScanMessage, renderWatchTarget, type FileLine } from '../format.js';
import { selectScannable } from '../watcher.js';

describe('verdictFrom', () => {
  const s = (m: number, su = 0) => toStats({ malicious: m, suspicious: su, harmless: 60, undetected: 5 });
  test('threshold maps to malicious / suspicious / clean', () => {
    expect(verdictFrom(s(3), 2)).toBe('malicious');
    expect(verdictFrom(s(2), 2)).toBe('malicious');
    expect(verdictFrom(s(1), 2)).toBe('suspicious'); // below malicious threshold but flagged
    expect(verdictFrom(s(0, 1), 2)).toBe('suspicious'); // suspicious-only
    expect(verdictFrom(s(0, 0), 2)).toBe('clean');
  });
  test('toStats totals the categories', () => {
    expect(toStats({ malicious: 1, suspicious: 2, harmless: 3, undetected: 4 }).total).toBe(10);
  });
});

describe('isImageAttachment', () => {
  test('detects by extension and content-type', () => {
    expect(isImageAttachment('cat.png', null)).toBe(true);
    expect(isImageAttachment('cat.JPEG', null)).toBe(true);
    expect(isImageAttachment('noext', 'image/webp')).toBe(true);
    expect(isImageAttachment('doc.pdf', 'application/pdf')).toBe(false);
    expect(isImageAttachment('setup.exe', null)).toBe(false);
  });
});

describe('selectScannable', () => {
  const opts = { maxFileBytes: 1000, maxFiles: 2 };
  test('skips images, empty and oversized; caps count', () => {
    const picked = selectScannable(
      [
        { name: 'a.png', size: 10, url: 'u', contentType: 'image/png' }, // image → skip
        { name: 'b.exe', size: 0, url: 'u', contentType: null }, // empty → skip
        { name: 'c.zip', size: 5000, url: 'u', contentType: null }, // too big → skip
        { name: 'd.pdf', size: 500, url: 'u', contentType: 'application/pdf' }, // keep
        { name: 'e.js', size: 500, url: 'u', contentType: null }, // keep
        { name: 'f.docx', size: 500, url: 'u', contentType: null }, // over cap → skip
      ],
      opts,
    );
    expect(picked.map((a) => a.name)).toEqual(['d.pdf', 'e.js']);
  });
});

describe('renderWatchTarget', () => {
  test('renders channel ids, all, and guild wildcards', () => {
    expect(renderWatchTarget('123456789012345678')).toBe('<#123456789012345678>');
    expect(renderWatchTarget('all')).toContain('todos los canales');
    expect(renderWatchTarget('guild:1435843683541979248')).toContain('todo el servidor');
    expect(renderWatchTarget('guild:1435843683541979248')).toContain('1435843683541979248');
  });
});

describe('renderScanMessage', () => {
  const line = (status: FileLine['status']): FileLine => ({ fileName: 'f.exe', status });
  test('malicious verdict is loud and adds an @here mod ping', () => {
    const msg = renderScanMessage([
      line({ kind: 'verdict', verdict: 'malicious', stats: { malicious: 40, suspicious: 0, harmless: 10, undetected: 5, total: 55 }, sha256: 'HASH', source: 'hash' }),
    ]);
    expect(msg).toContain('🛑');
    expect(msg).toContain('40/55');
    expect(msg).toContain('virustotal.com/gui/file/HASH');
    expect(msg).toContain('@here');
  });
  test('clean verdict is reassuring, no ping', () => {
    const msg = renderScanMessage([
      line({ kind: 'verdict', verdict: 'clean', stats: { malicious: 0, suspicious: 0, harmless: 70, undetected: 3, total: 73 }, sha256: 'H', source: 'cache' }),
    ]);
    expect(msg).toContain('✅');
    expect(msg).toContain('en caché');
    expect(msg).not.toContain('@here');
  });
  test('in-progress phases render friendly Spanish', () => {
    expect(renderScanMessage([line({ phase: 'queued' })])).toContain('en cola');
    expect(renderScanMessage([line({ phase: 'scanning' })])).toContain('analizando');
  });
});
