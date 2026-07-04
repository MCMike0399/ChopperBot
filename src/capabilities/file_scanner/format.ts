import type { ScanOutcome } from './scanner.js';
import type { VerdictStats } from './store.js';

/** Image formats the bot already handles via vision — never sent to VirusTotal. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const IMAGE_MIME_PREFIX = 'image/';

/** Per-file line state as the scan progresses (edited in place). */
export type LineStatus = { phase: 'queued' } | { phase: 'scanning' } | ScanOutcome;

export interface FileLine {
  fileName: string;
  status: LineStatus;
}

/**
 * True if an attachment is an image (by content-type or extension). Images are
 * skipped to protect the limited VirusTotal quota — they're rarely malicious
 * and are already understood by the vision path.
 */
export function isImageAttachment(name: string, contentType: string | null): boolean {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith(IMAGE_MIME_PREFIX)) return true;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

const VT_LINK = (sha256: string) => `<https://www.virustotal.com/gui/file/${sha256}>`;
const code = (s: string) => '`' + s.replace(/`/g, '') + '`';

function verdictLine(fileName: string, o: Extract<ScanOutcome, { kind: 'verdict' }>): string {
  const { verdict, stats, sha256, source } = o;
  const flagged = stats.malicious + stats.suspicious;
  const cached = source === 'cache' ? ' · _resultado en caché_' : '';
  switch (verdict) {
    case 'malicious':
      return (
        `🛑 ${code(fileName)} — **¡MALICIOSO!** ${stats.malicious}/${stats.total} motores lo detectan como dañino. ` +
        `**No lo abras ni lo descargues.**\n   🔗 ${VT_LINK(sha256)}${cached}`
      );
    case 'suspicious':
      return (
        `⚠️ ${code(fileName)} — **sospechoso**: ${flagged}/${stats.total} motores lo marcaron. Trátalo con cuidado.\n` +
        `   🔗 ${VT_LINK(sha256)}${cached}`
      );
    case 'clean':
      return `✅ ${code(fileName)} — limpio (0/${stats.total} motores lo marcan como dañino).${cached}`;
  }
}

/** One status line for a single file, given its current phase/outcome. */
export function renderLine({ fileName, status }: FileLine): string {
  if ('phase' in status) {
    return status.phase === 'queued'
      ? `⏳ ${code(fileName)} — en cola…`
      : `🔬 ${code(fileName)} — analizando con VirusTotal…`;
  }
  switch (status.kind) {
    case 'verdict':
      return verdictLine(fileName, status);
    case 'pending':
      return (
        `⏳ ${code(fileName)} — VirusTotal aún lo está analizando. Revisa el resultado en un momento:\n` +
        `   🔗 ${VT_LINK(status.sha256)}`
      );
    case 'budget_exhausted':
      return `😴 ${code(fileName)} — alcancé el límite diario de análisis de VirusTotal. Intenta de nuevo más tarde.`;
    case 'queue_full':
      return `🕒 ${code(fileName)} — hay muchos archivos en cola ahora mismo. Vuelve a subirlo en un rato.`;
    case 'error':
      return `⚠️ ${code(fileName)} — no pude analizarlo (error técnico). Intenta de nuevo más tarde.`;
  }
}

/** The full scan message body (header + one line per file). Edited in place. */
export function renderScanMessage(lines: FileLine[]): string {
  const header = '🔎 **Análisis de seguridad (VirusTotal)**';
  const anyMalicious = lines.some((l) => !('phase' in l.status) && l.status.kind === 'verdict' && l.status.verdict === 'malicious');
  const body = lines.map(renderLine).join('\n');
  const footer = anyMalicious
    ? '\n\n@here ⚠️ Se detectó un archivo potencialmente peligroso. Modera con precaución.'
    : '';
  return `${header}\n${body}${footer}`;
}

/** Compact admin-facing status block (shared by config_filescanner status). */
export function formatScannerStatus(input: {
  enabled: boolean;
  watchedChannels: string[];
  used24h: number;
  budget: number;
  minIntervalMs: number;
  counts: { total: number; malicious: number; suspicious: number; clean: number };
  recent: { fileName: string | null; verdict: string; lastSeenAt: number }[];
  nowMs: number;
}): string[] {
  const {
    enabled,
    watchedChannels,
    used24h,
    budget,
    minIntervalMs,
    counts,
    recent,
    nowMs,
  } = input;
  const lines: string[] = [];
  lines.push('🛡️ **File scanner (VirusTotal)**');
  lines.push(enabled ? 'Estado: **activo**' : 'Estado: **inactivo** (falta `VIRUSTOTAL_API_KEY`)');
  lines.push(
    watchedChannels.length > 0
      ? `Canales vigilados: ${watchedChannels.map(renderWatchTarget).join(', ')}`
      : 'Canales vigilados: _ninguno_ (usa `set_channels`)',
  );
  lines.push(`Presupuesto 24 h: ${used24h}/${budget} peticiones · espaciado ${Math.round(minIntervalMs / 1000)}s`);
  lines.push(
    `Análisis en caché: ${counts.total} (🛑 ${counts.malicious} · ⚠️ ${counts.suspicious} · ✅ ${counts.clean})`,
  );
  if (recent.length > 0) {
    lines.push('', 'Últimos análisis:');
    for (const r of recent) {
      const emoji = r.verdict === 'malicious' ? '🛑' : r.verdict === 'suspicious' ? '⚠️' : '✅';
      lines.push(`• ${emoji} ${r.fileName ?? '(sin nombre)'} — hace ${formatAgoEs(nowMs - r.lastSeenAt)}`);
    }
  }
  return lines;
}

/** Render a watched-target token (channel id, `all`, or `guild:<id>`) for humans. */
export function renderWatchTarget(token: string): string {
  if (token === 'all') return '**todos los canales visibles**';
  if (token.startsWith('guild:')) return `**todo el servidor** (guild \`${token.slice(6)}\`)`;
  return `<#${token}>`;
}

/** Verdict-stats one-liner, reused where a compact summary is handy. */
export function statsSummary(stats: VerdictStats): string {
  return `mal ${stats.malicious} · susp ${stats.suspicious} · limpio ${stats.harmless} · s/detección ${stats.undetected}`;
}

function formatAgoEs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
