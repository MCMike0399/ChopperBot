/**
 * Spanish-friendly date formatting for the IG monitor post cards.
 *
 * Two distinct date sources, two distinct policies:
 *
 * - `formatEventWhen` renders the LLM-extracted event date (`Classification.when`).
 *   It preserves the **wall-clock time stated in the post** and never converts
 *   time zones. This is deliberate: the classifier emits offsets that can be
 *   wrong (it tends to write -05:00 for CDMX, but Mexico dropped DST in 2023 and
 *   is UTC-06:00 year-round), so converting would shift the displayed hour. The
 *   number on the flyer is what the reader needs, so we show exactly that.
 *
 * - `formatPostedAt` renders a real UTC instant (`RecentPost.takenAtMs` from the
 *   IG API), so it *can* be safely converted — we show it in Mexico City time.
 */

import {
  AUTH_PAUSE_THRESHOLD,
  effectiveBaseIntervalMs,
  nextDueAtMs,
  type MonitoredAccount,
  type RuntimeState,
} from './store.js';

const WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

const MONTHS_FULL = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const MONTHS_ABBR = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

const CDMX_TZ = 'America/Mexico_City';

/**
 * Friendly Spanish rendering of an event date string, preserving the stated
 * wall-clock time (no time-zone conversion). Accepts `YYYY-MM-DD`, with an
 * optional `T`/space + `HH:MM` and any trailing offset (ignored). The year is
 * only shown when it differs from the current year. Returns the trimmed input
 * verbatim if it doesn't look like a date, so a misbehaving model never breaks
 * the card.
 *
 *   2026-05-26T16:00:00-05:00  ->  martes 26 de mayo, 16:00 h
 *   2026-05-30                 ->  sábado 30 de mayo
 *   2027-01-01T09:00           ->  viernes 1 de enero de 2027, 09:00 h
 */
export function formatEventWhen(iso: string, nowMs: number = Date.now()): string {
  const raw = iso.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return raw;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return raw;

  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const currentYear = new Date(nowMs).getUTCFullYear();
  let datePart = `${weekday} ${day} de ${MONTHS_FULL[month - 1]}`;
  if (year !== currentYear) datePart += ` de ${year}`;

  const hasTime = m[4] !== undefined;
  return hasTime ? `${datePart}, ${m[4]}:${m[5]} h` : datePart;
}

/**
 * Friendly Spanish rendering of a UTC instant in Mexico City local time.
 *
 *   1716661263000  ->  25 may 2026, 14:31
 */
export function formatPostedAt(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CDMX_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const day = Number(pick('day'));
  const month = Number(pick('month'));
  return `${day} ${MONTHS_ABBR[month - 1]} ${pick('year')}, ${pick('hour')}:${pick('minute')}`;
}

// ---- Status digest (admin channel) --------------------------------------

/**
 * Human Spanish duration, up to two units: "2 h 14 min", "3 d 5 h", "45 min".
 * Used by the "polling resumed" alert ("estuvo pausado ~X").
 */
export function formatDurationEs(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return 'menos de 1 min';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  return parts.slice(0, 2).join(' ');
}

/** Compact age/interval for the digest table: "45m", "6h", "2d", "<1m". */
export function formatAgeEs(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 120) return `${m}m`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export interface StatusDigestInput {
  runtime: RuntimeState;
  accounts: MonitoredAccount[];
  /** IG_DAILY_REQUEST_BUDGET (0 = no limit configured). */
  dailyRequestBudget: number;
  /** DEFAULT_POLL_INTERVAL_MS — the fallback for accounts without a learned cadence. */
  defaultPollIntervalMs: number;
  nowMs: number;
}

const DIGEST_MAX_LEN = 1900;
/** Room reserved (chars) for the closing fence + footer + truncation note. */
const DIGEST_RESERVE = 110;

/**
 * Build the daily status digest as Discord-ready lines (joined with `\n`).
 * Shared by the scheduler's 21:00 digest and the admin `digest_now` / `status`
 * preview so the two never drift. Reads the adaptive cadence columns
 * defensively (they may be null until the first sweep) — never throws on
 * missing data, and stays under Discord's 2000-char limit (truncates the
 * least-interesting accounts with a "+N más" tail).
 */
export function formatStatusDigest(input: StatusDigestInput): string[] {
  const { runtime, accounts, dailyRequestBudget, defaultPollIntervalMs, nowMs } = input;
  const stretch =
    Number.isFinite(runtime.poll_stretch) && runtime.poll_stretch > 0 ? runtime.poll_stretch : 1;

  const head: string[] = ['📊 **Instagram monitor — resumen diario**'];
  head.push(`Estado: ${describeState(runtime, nowMs)}`);

  const used = runtime.requests_24h ?? 0;
  if (dailyRequestBudget > 0) {
    const margin = dailyRequestBudget - used;
    head.push(
      `Peticiones 24 h: ${used} / ${dailyRequestBudget} · ${
        margin > 0 ? `margen ${margin}` : 'sin margen (en pausa)'
      }`,
    );
  } else {
    head.push(`Peticiones 24 h: ${used} (sin límite)`);
  }
  if (stretch > 1.001) {
    head.push(
      `Ajuste de presupuesto: ×${stretch.toFixed(2)} (intervalos estirados para respetar el presupuesto)`,
    );
  }

  const pausedCount = accounts.filter((a) => a.paused === 1).length;
  const blockedCount = accounts.filter(
    (a) => a.consecutive_auth_failures >= AUTH_PAUSE_THRESHOLD,
  ).length;
  head.push(`Cuentas: ${accounts.length} (pausadas ${pausedCount} · bloqueadas ${blockedCount})`);

  // Interesting-first so truncation drops healthy accounts, not problem ones.
  const sorted = [...accounts].sort((a, b) => {
    const r = interestRank(a) - interestRank(b);
    return r !== 0 ? r : (a.last_polled_at ?? 0) - (b.last_polled_at ?? 0);
  });

  const widths = [20, 6, 5, 6, 6, 3];
  const lines = [
    ...head,
    '```',
    digestRow(['cuenta', 'cad', 'int', 'últ', 'próx', 'st'], widths),
    digestRow(widths.map((w) => '─'.repeat(w)), widths),
  ];

  let shown = 0;
  for (const a of sorted) {
    const r = digestRow(
      [
        a.username,
        cadenceCell(a),
        formatAgeEs(effectiveBaseIntervalMs(a, defaultPollIntervalMs, stretch)),
        a.last_post_at ? formatAgeEs(Math.max(0, nowMs - a.last_post_at)) : '—',
        nextCell(a, defaultPollIntervalMs, stretch, nowMs),
        stCell(a),
      ],
      widths,
    );
    if (shown > 0 && [...lines, r].join('\n').length > DIGEST_MAX_LEN - DIGEST_RESERVE) {
      const remaining = sorted.length - shown;
      lines.push(`… y ${remaining} cuenta${remaining === 1 ? '' : 's'} más`);
      break;
    }
    lines.push(r);
    shown++;
  }

  lines.push('```');
  lines.push('Detalle: `config_instagram action:list` · `action:status`');
  return lines;
}

/** 0 = most interesting (kept under truncation), higher = dropped first. */
function interestRank(a: MonitoredAccount): number {
  if (a.consecutive_auth_failures >= AUTH_PAUSE_THRESHOLD) return 0;
  if (a.paused === 1) return 1;
  if (a.consecutive_failures > 0) return 2;
  return 3;
}

function describeState(r: RuntimeState, now: number): string {
  if (r.global_stop === 1) {
    return `🔴 DETENIDO (interruptor de seguridad)${r.stop_reason ? `: ${r.stop_reason}` : ''}`;
  }
  const future = (ms: number | null) => (ms && ms > now ? ms : null);
  const rate = future(r.rate_cooldown_until);
  const budget = future(r.budget_pause_until);
  const auth = future(r.auth_cooldown_until);
  if (rate) return `🟡 pausado — límite de peticiones (429), reanuda en ${formatAgeEs(rate - now)}`;
  if (budget) return `🟡 pausado — presupuesto diario, reanuda en ${formatAgeEs(budget - now)}`;
  if (auth) return `🟡 pausado — sesión, reanuda en ${formatAgeEs(auth - now)}`;
  return '🟢 sondeando con normalidad';
}

/** Cadence cell from posts/day; `?` when not yet learned or absent. */
function cadenceCell(a: MonitoredAccount): string {
  const ppd = a.posts_per_day;
  if (ppd == null || !Number.isFinite(ppd) || ppd <= 0) return '?';
  if (ppd >= 1) return `${ppd < 10 ? ppd.toFixed(1) : String(Math.round(ppd))}/d`;
  const days = 1 / ppd;
  return `~${days < 10 ? days.toFixed(1) : String(Math.round(days))}d`;
}

function nextCell(
  a: MonitoredAccount,
  defaultMs: number,
  stretch: number,
  now: number,
): string {
  if (a.paused === 1 || a.consecutive_auth_failures >= AUTH_PAUSE_THRESHOLD) return '—';
  const nd = nextDueAtMs(a, defaultMs, stretch);
  if (nd === null || nd <= now) return 'due';
  return formatAgeEs(nd - now);
}

function stCell(a: MonitoredAccount): string {
  if (a.paused === 1) return 'P';
  if (a.consecutive_auth_failures >= AUTH_PAUSE_THRESHOLD) return 'A';
  if (a.consecutive_failures > 0) return `!${Math.min(a.consecutive_failures, 9)}`;
  return '·';
}

/** Pad/truncate cells to fixed widths and join (monospace inside a code fence). */
function digestRow(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => {
      const w = widths[i];
      return c.length > w ? `${c.slice(0, w - 1)}…` : c.padEnd(w);
    })
    .join('  ');
}
