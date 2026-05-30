import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';

/**
 * Monitored Instagram account. Accounts are GLOBAL — there is one row per
 * username, and posts are fanned out at detection time to every channel
 * currently bound to the `instagram_monitor` capability.
 *
 * Dedup is still per-channel (see {@link SeenPost} below), so a channel
 * bound after the account already has post history sees only newly-detected
 * posts (no backfill).
 */
export interface MonitoredAccount {
  id: number;
  username: string;
  /** Discord user who first added this account. Kept for audit, never used for filtering. */
  added_by: string;
  added_at: number;
  paused: number;
  last_polled_at: number | null;
  last_post_id: string | null;
  /**
   * Capture time (`takenAtMs`) of the post `last_post_id` points at. The dedup
   * anchor's *timestamp*, not just its id. Used to gate detection by time when
   * IG returns a window that omits the anchor post, and to guarantee the anchor
   * never moves backward in time. Null only for fresh/legacy rows.
   */
  last_post_at: number | null;
  consecutive_failures: number;
  /**
   * Auth-class failures (IG session bad / checkpoint / challenge) in a row.
   * Reset on any successful poll, and also on `clearFailureBackoff()` at
   * scheduler start so a freshly-restarted bot retries immediately after the
   * operator refreshes cookies. Used by {@link InstagramMonitorStore.dueAccounts}
   * as a hard gate — accounts with ≥ {@link AUTH_PAUSE_THRESHOLD} are skipped
   * entirely (no more "marching into a wall" once IG has flagged the session).
   * Separate from `consecutive_failures` so a transient DNS hiccup doesn't
   * trip the auto-pause.
   */
  consecutive_auth_failures: number;
  /**
   * Cached adaptive poll interval (ms), learned from this account's posting
   * cadence (see {@link computeCadenceInterval}). NULL = not enough history yet
   * → {@link InstagramMonitorStore.dueAccounts} falls back to the global default.
   * Refreshed opportunistically when new posts are detected and by a daily sweep.
   */
  poll_interval_ms: number | null;
  /** Observed posts/day over the cadence window (for the status digest + governor). NULL until computed. */
  posts_per_day: number | null;
  /** When the cadence columns above were last recomputed (ms). NULL = never. */
  cadence_updated_at: number | null;
}

export interface SeenPost {
  ig_post_id: string;
  account_username: string;
  channel_id: string;
  caption: string | null;
  media_type: string | null;
  posted_at: number | null;
  detected_at: number;
  classification_json: string | null;
  pushed: number;
  discord_message_id: string | null;
}

/**
 * Global runtime/circuit-breaker state (one row, id=1). Shared between the
 * scheduler (writes the breaker + heartbeat) and the admin tool (reads for the
 * `status` action, clears the breaker via `resume_monitor`).
 */
export interface RuntimeState {
  global_stop: number;
  stop_reason: string | null;
  stopped_at: number | null;
  recent_auth_json: string | null;
  recent_429_json: string | null;
  auth_cooldown_until: number | null;
  rate_cooldown_until: number | null;
  budget_pause_until: number | null;
  requests_24h: number | null;
  heartbeat_at: number | null;
  /** Global budget-governor multiplier on every account's poll interval (≥1). 1.0 = inactive. */
  poll_stretch: number;
  /** When the daily status digest was last posted (ms). NULL = never. */
  last_digest_at: number | null;
}

export const INSTAGRAM_MONITOR_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS instagram_monitor_accounts (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id            TEXT    NOT NULL,
        username              TEXT    NOT NULL,
        added_by              TEXT    NOT NULL,
        added_at              INTEGER NOT NULL,
        paused                INTEGER NOT NULL DEFAULT 0,
        last_polled_at        INTEGER,
        last_post_id          TEXT,
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (channel_id, username)
      );
      CREATE INDEX IF NOT EXISTS instagram_monitor_accounts_channel
        ON instagram_monitor_accounts (channel_id, paused);

      CREATE TABLE IF NOT EXISTS instagram_monitor_seen_posts (
        ig_post_id           TEXT    NOT NULL,
        account_username     TEXT    NOT NULL,
        channel_id           TEXT    NOT NULL,
        caption              TEXT,
        media_type           TEXT,
        posted_at            INTEGER,
        detected_at          INTEGER NOT NULL,
        classification_json  TEXT,
        pushed               INTEGER NOT NULL DEFAULT 0,
        discord_message_id   TEXT,
        PRIMARY KEY (ig_post_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS instagram_monitor_seen_posts_account_time
        ON instagram_monitor_seen_posts (account_username, detected_at DESC);
      CREATE INDEX IF NOT EXISTS instagram_monitor_seen_posts_channel_pushed_time
        ON instagram_monitor_seen_posts (channel_id, pushed, detected_at DESC);
    `,
  },
  {
    // v2 — accounts go GLOBAL. Drop channel_id from the accounts table.
    // Existing rows are deduped by username, keeping the earliest add
    // (preserves added_by + last_post_id of whoever set it up first).
    // seen_posts stays per-channel — that's the dedup substrate for
    // fan-out, and it's what gives "new channel binding gets no backfill".
    version: 2,
    up: `
      CREATE TABLE instagram_monitor_accounts_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        username              TEXT    NOT NULL,
        added_by              TEXT    NOT NULL,
        added_at              INTEGER NOT NULL,
        paused                INTEGER NOT NULL DEFAULT 0,
        last_polled_at        INTEGER,
        last_post_id          TEXT,
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (username)
      );

      INSERT OR IGNORE INTO instagram_monitor_accounts_new
        (username, added_by, added_at, paused, last_polled_at, last_post_id, consecutive_failures)
      SELECT username, added_by, added_at, paused, last_polled_at, last_post_id, consecutive_failures
      FROM instagram_monitor_accounts
      ORDER BY added_at ASC, id ASC;

      DROP TABLE instagram_monitor_accounts;
      ALTER TABLE instagram_monitor_accounts_new RENAME TO instagram_monitor_accounts;

      CREATE INDEX IF NOT EXISTS instagram_monitor_accounts_paused
        ON instagram_monitor_accounts (paused);
    `,
  },
  {
    // v3 — record the dedup anchor's capture time alongside its id.
    //
    // The old detection walked the fetched feed until it hit the anchor *id*
    // and treated everything above it as new. That breaks catastrophically
    // when IG returns a stale/paginated window that OMITS the anchor post:
    // the walk never finds it, classifies the entire (old) batch as new, and
    // backfills weeks-old posts — and `markPollSuccess` then moves the anchor
    // BACKWARD to that batch's (older) newest. Tracking the anchor's timestamp
    // lets the scheduler time-gate the anchor-missing case and refuse to
    // regress the anchor.
    //
    // Backfill from each account's newest already-seen post so existing rows
    // get a correct anchor time immediately (accounts with no seen history
    // stay NULL → the scheduler re-seeds them without backfilling).
    version: 3,
    up: `
      ALTER TABLE instagram_monitor_accounts ADD COLUMN last_post_at INTEGER;

      UPDATE instagram_monitor_accounts
        SET last_post_at = (
          SELECT MAX(s.posted_at)
          FROM instagram_monitor_seen_posts s
          WHERE s.account_username = instagram_monitor_accounts.username
        );
    `,
  },
  {
    // v4 — auth-class failure counter, separate from general `consecutive_failures`.
    // Lets the scheduler distinguish "the IG session is dead" from "the network
    // burped" so we can auto-stop polling a checkpointed session without also
    // shutting things down on a transient DNS hiccup.
    version: 4,
    up: `
      ALTER TABLE instagram_monitor_accounts
        ADD COLUMN consecutive_auth_failures INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v5 — global runtime state, separate from the per-account table.
    //
    // A single row (id=1) holding the PERSISTENT circuit-breaker / kill-switch
    // (`global_stop`). This deliberately lives in its own table because
    // `clearFailureBackoff()` (run on every scheduler start) zeroes the
    // per-account failure counters — but a tripped breaker MUST survive a
    // restart (otherwise restarting the service would silently un-stop a
    // monitor that IG just flagged). The scheduler reads `global_stop` first
    // thing each tick and only the admin `resume_monitor` action clears it.
    //
    // The `recent_*_json` columns hold windowed event timestamps the breaker
    // uses to decide when to trip (e.g. ≥2 throttles in 6h). The heartbeat
    // columns are written by the scheduler each tick so the admin `status`
    // tool can observe the scheduler's in-memory cooldowns and 24h request
    // count (which live in a different object it can't reach directly).
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS instagram_monitor_runtime (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        global_stop          INTEGER NOT NULL DEFAULT 0,
        stop_reason          TEXT,
        stopped_at           INTEGER,
        recent_auth_json     TEXT,
        recent_429_json      TEXT,
        auth_cooldown_until  INTEGER,
        rate_cooldown_until  INTEGER,
        budget_pause_until   INTEGER,
        requests_24h         INTEGER,
        heartbeat_at         INTEGER
      );
      INSERT OR IGNORE INTO instagram_monitor_runtime (id, global_stop) VALUES (1, 0);
    `,
  },
  {
    // v6 — adaptive per-account polling cadence. The flat 60-min cadence wastes
    // the daily request budget polling rare accounts as often as hyperactive
    // ones. These columns cache an interval LEARNED from each account's
    // `posted_at` history (see computeCadenceInterval) so polling concentrates
    // where posts actually happen. NULL poll_interval_ms => dueAccounts uses the
    // global default, so existing rows behave exactly as before until the first
    // sweep populates them (no backfill needed — the history is already in
    // seen_posts).
    version: 6,
    up: `
      ALTER TABLE instagram_monitor_accounts ADD COLUMN poll_interval_ms   INTEGER;
      ALTER TABLE instagram_monitor_accounts ADD COLUMN posts_per_day      REAL;
      ALTER TABLE instagram_monitor_accounts ADD COLUMN cadence_updated_at INTEGER;
    `,
  },
  {
    // v7 — global runtime fields for the budget governor + status digest.
    // `poll_stretch` is a single multiplier the governor raises above 1.0 to
    // keep projected daily requests under budget as accounts are added (applied
    // by dueAccounts on top of each account's cadence interval). `last_digest_at`
    // gates the once-per-day status digest. Both live on the singleton runtime
    // row next to the heartbeat columns the scheduler already writes.
    version: 7,
    up: `
      ALTER TABLE instagram_monitor_runtime ADD COLUMN poll_stretch   REAL NOT NULL DEFAULT 1.0;
      ALTER TABLE instagram_monitor_runtime ADD COLUMN last_digest_at INTEGER;
    `,
  },
];

/** Window over which the circuit breaker counts soft-block events (6h). */
export const EVENT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Threshold of consecutive auth-class failures (per account) at which
 * {@link InstagramMonitorStore.dueAccounts} stops returning the account. Reset
 * on any successful poll, and zeroed by `clearFailureBackoff()` on scheduler
 * start, so the operator's "refresh cookies + restart" flow re-enables polling
 * with zero per-account toggling.
 */
export const AUTH_PAUSE_THRESHOLD = 5;

/**
 * Failure backoff ceiling: next allowed poll is min(base * 2^failures, max(MAX_BACKOFF, base)).
 * This is the cap on the *exponential* backoff for a flapping account, NOT the
 * cadence ceiling — they used to be equal (both 6h) but were decoupled when
 * {@link CADENCE_MAX_INTERVAL_MS} was raised to 12h (a rare account legitimately
 * polls slower than the backoff ceiling). The `max(MAX_BACKOFF, base)` guard
 * keeps a base interval > 6h from being silently capped here.
 */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Adaptive cadence (per-account poll interval learned from posted_at) ----
// Balanced profile: active accounts poll ~hourly or faster, rare accounts stretch
// toward a 12h ceiling. Longer intervals raise detection LATENCY, not coverage —
// the feed returns 10–16 posts, so we only ever risk a miss if an account posts
// faster than the floor allows, which the coverage clamp + MIN floor bound.
// The per-account interval is purely a budget-allocation lever: IG rate-limits on
// the SESSION's aggregate request rate (governed by IG_DAILY_REQUEST_BUDGET), not
// per-account, so stretching a rare account's interval is free of extra ban risk.
/** Trailing window of post history considered when estimating cadence. */
export const CADENCE_WINDOW_MS = 60 * DAY_MS;
/** Cap on most-recent distinct posts sampled (bounds work for hyperactive accounts). */
export const CADENCE_MAX_SAMPLES = 50;
/** Need at least this many distinct posts before trusting a cadence (burst guard #1). */
export const CADENCE_MIN_SAMPLES = 5;
/** …spanning at least this long, so a sub-day burst isn't read as a sustained
 * cadence (burst guard #2). 24h accepts real multi-day cadences (e.g. an account
 * with 26 posts over ~2.9d) while still rejecting a 5-posts-in-an-afternoon flurry;
 * the MIN_SAMPLES gate already rejects the tiny (<5-post) bursts. */
export const CADENCE_MIN_SPAN_MS = 1 * DAY_MS;
/** Poll at this fraction of the median inter-post gap (≈ Nyquist: sample faster than the event rate). */
export const CADENCE_INTERVAL_FACTOR = 0.5;
/** Hard floor — never poll one account faster than this (anti-detection). */
export const CADENCE_MIN_INTERVAL_MS = 45 * 60 * 1000;
/**
 * Ceiling — even a dormant account is polled at least this often (twice a day).
 *
 * Raised 6h → 12h (2026-05-30) after the live data showed the 6h cap was the
 * binding constraint on genuinely-rare accounts and was wasting the request
 * budget: e.g. `semillasderebeldia` (median inter-post gap ~20h) wants a ~10h
 * interval and `revueltasperiodico` (~26h gap) wants ~13h, yet both were pinned
 * at 6h — polled ~2× more often than their cadence warrants. Those wasted polls
 * starved the budget the *active* accounts need, and the surplus of MAX-clamped
 * accounts forced the budget governor to over-stretch everyone else (see
 * {@link computeGovernorStretch}). Decoupled from {@link MAX_BACKOFF_MS} (still
 * 6h) — `dueAccounts`' backoff cap already used `max(MAX_BACKOFF, base)` so a
 * base interval above 6h was never silently capped. Coverage is unaffected: the
 * feed returns 10–16 items and {@link CADENCE_MAX_POSTS_PER_INTERVAL} bounds how
 * many a rare account can accumulate in one interval, so a longer ceiling only
 * adds latency, never a miss.
 */
export const CADENCE_MAX_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Fallback interval (now 12h, kept == {@link CADENCE_MAX_INTERVAL_MS}) for
 * accounts whose cadence isn't known yet (too few posts / too little history).
 * Conservative on purpose: an account with little data is empirically a rare
 * poster, so polling it slowly frees the request budget for the accounts we KNOW
 * are active. Polling slowly does NOT slow learning — cadence is learned from
 * detected POSTS, and a long interval can't miss a rare account's posts (the
 * feed window holds 10–16). New accounts speed up automatically once they accrue
 * enough history for {@link computeCadenceInterval} to trust a cadence. */
export const CADENCE_COLD_START_INTERVAL_MS = CADENCE_MAX_INTERVAL_MS;
/** Recency decay: start stretching once silence exceeds this multiple of the median gap. */
export const CADENCE_DECAY_START = 2;
/** …capping the stretch multiplier here so a quieted account drifts to MAX, not beyond. */
export const CADENCE_DECAY_MAX_MULT = 4;
/** Coverage safety: keep interval ≤ this × median gap so we can't accumulate more posts than the feed returns. */
export const CADENCE_MAX_POSTS_PER_INTERVAL = 6;
/** Recompute an account's cadence at most this often in the daily sweep. */
export const CADENCE_TTL_MS = 24 * 60 * 60 * 1000;
/** Budget governor targets this fraction of IG_DAILY_REQUEST_BUDGET as the
 * steady-state ceiling. Leaves ~25% headroom to absorb (a) the one-time
 * pk-resolve burst on restart (~1 extra call/account, in-window for 24h) and
 * (b) the ~50% warmup variance. (The governor's old MAX-clamp under-correction
 * — formerly absorbed here too — is gone: {@link computeGovernorStretch} is now
 * clamp-aware and solves for a stretch whose *realized* projection hits this
 * ceiling.) */
export const CADENCE_BUDGET_HEADROOM = 0.75;

/**
 * Median of a non-empty numeric array (does not mutate the input). Used for the
 * robust inter-post gap — resistant to a single burst or one huge gap that
 * would skew a mean.
 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Derive an adaptive poll interval from an account's recent post times.
 *
 * @param sortedDescPostedAt Distinct post capture times (`takenAtMs`), NEWEST
 *   first. Must already be deduped across channels (see
 *   {@link InstagramMonitorStore.recomputeCadence}).
 * @returns `{ intervalMs }` clamped to [MIN, MAX], or `intervalMs: null` when
 *   there isn't enough trustworthy history (caller then uses the global default).
 *
 * Pipeline: trust gate (min samples + min span) → median inter-post gap →
 * `gap × FACTOR` → recency decay (stretch toward MAX when the account has gone
 * quiet) → coverage clamp → final clamp to [MIN, MAX] (the floor/ceiling win
 * last, so the anti-detection MIN is never violated).
 */
export function computeCadenceInterval(
  sortedDescPostedAt: number[],
  nowMs: number,
): { intervalMs: number | null; postsPerDay: number | null } {
  const ts = sortedDescPostedAt.filter((n) => Number.isFinite(n));
  const n = ts.length;
  if (n < CADENCE_MIN_SAMPLES) return { intervalMs: null, postsPerDay: null };

  const newest = ts[0];
  const oldest = ts[n - 1];
  const span = newest - oldest;
  if (span < CADENCE_MIN_SPAN_MS) return { intervalMs: null, postsPerDay: null };

  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const g = ts[i] - ts[i + 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return { intervalMs: null, postsPerDay: null };

  const medianGap = median(gaps);
  if (medianGap <= 0) return { intervalMs: null, postsPerDay: null };

  const postsPerDay = (n - 1) / (span / DAY_MS);

  let interval = medianGap * CADENCE_INTERVAL_FACTOR;

  // Recency decay: a healthy median can keep an account on a tight interval long
  // after it actually went quiet. Once silence exceeds DECAY_START× the median
  // gap, stretch the interval proportionally (capped) so we stop wasting polls.
  const silence = nowMs - newest;
  if (silence > CADENCE_DECAY_START * medianGap) {
    const mult = Math.min(silence / medianGap / CADENCE_DECAY_START, CADENCE_DECAY_MAX_MULT);
    interval *= mult;
  }

  // Coverage safety: don't let the interval grow past what the feed window can
  // hold (defensive — with FACTOR 0.5 and decay ≤4× this never binds).
  interval = Math.min(interval, CADENCE_MAX_POSTS_PER_INTERVAL * medianGap);

  // Floor + ceiling win last.
  interval = Math.min(Math.max(interval, CADENCE_MIN_INTERVAL_MS), CADENCE_MAX_INTERVAL_MS);

  return { intervalMs: Math.round(interval), postsPerDay };
}

/**
 * The effective base poll interval for an account: its learned cadence (or the
 * global default if not yet learned), scaled by the global budget-governor
 * `stretch`, clamped to the cadence ceiling. Shared by {@link InstagramMonitorStore.dueAccounts}
 * and the status-digest next-poll estimate so the two never drift.
 */
export function effectiveBaseIntervalMs(
  account: { poll_interval_ms: number | null },
  defaultMs: number,
  stretch: number,
): number {
  const s = Number.isFinite(stretch) && stretch > 0 ? stretch : 1;
  const base = (account.poll_interval_ms ?? defaultMs) * s;
  return Math.min(base, CADENCE_MAX_INTERVAL_MS);
}

/**
 * Earliest next-poll time for an account (ms), using the same formula as
 * {@link InstagramMonitorStore.dueAccounts} but WITHOUT the random jitter — an
 * honest "no sooner than" estimate for the status digest. `null` = never polled
 * (due immediately).
 */
export function nextDueAtMs(
  account: MonitoredAccount,
  defaultMs: number,
  stretch: number,
): number | null {
  if (account.last_polled_at === null) return null;
  const base = effectiveBaseIntervalMs(account, defaultMs, stretch);
  return (
    account.last_polled_at +
    Math.min(base * 2 ** Math.min(account.consecutive_failures, 10), Math.max(MAX_BACKOFF_MS, base))
  );
}

/**
 * Budget governor: return a global `stretch` (≥1) that, applied to every
 * account's interval (then clamped to {@link CADENCE_MAX_INTERVAL_MS} by
 * {@link effectiveBaseIntervalMs}), keeps the *realized* projected daily IG
 * request count at or below `dailyRequestBudget × headroom`. A single multiplier
 * preserves the active-vs-rare allocation; the hard budget gate in the scheduler
 * stays the authoritative backstop, this just makes hitting it rare.
 * `dailyRequestBudget ≤ 0` (tests) disables the governor (stretch 1).
 *
 * **Clamp-aware** (changed 2026-05-30): the projection accounts for the fact
 * that `interval × stretch` saturates at the cadence ceiling. An account already
 * at (or stretched to) MAX contributes a FIXED request rate the stretch can't
 * reduce — so the old `projected / ceiling` closed form under-corrected whenever
 * accounts sat at the clamp (it assumed every interval scaled with stretch),
 * letting realized spend overshoot the ceiling. We instead binary-search the
 * smallest stretch whose realized (post-clamp) projection meets the ceiling.
 * `projected` is that realized figure — the requests we actually expect to make.
 */
export function computeGovernorStretch(
  accounts: MonitoredAccount[],
  opts: {
    callsPerPoll: number;
    dailyRequestBudget: number;
    defaultIntervalMs: number;
    activeFraction: number;
    headroom: number;
  },
): { stretch: number; projected: number } {
  if (opts.dailyRequestBudget <= 0) return { stretch: 1, projected: 0 };
  const intervals = accounts
    .filter((a) => a.paused !== 1 && a.consecutive_auth_failures < AUTH_PAUSE_THRESHOLD)
    .map((a) => a.poll_interval_ms ?? opts.defaultIntervalMs)
    .filter((iv) => iv > 0);

  // Realized daily requests if every interval is stretched by `s`, then clamped
  // to the cadence ceiling (mirrors effectiveBaseIntervalMs).
  const callsPerDay = opts.activeFraction * DAY_MS * opts.callsPerPoll;
  const projectedAt = (s: number): number =>
    intervals.reduce(
      (sum, iv) => sum + callsPerDay / Math.min(iv * s, CADENCE_MAX_INTERVAL_MS),
      0,
    );

  const ceiling = opts.dailyRequestBudget * opts.headroom;
  const base = projectedAt(1);
  if (ceiling <= 0 || intervals.length === 0 || base <= ceiling) {
    return { stretch: 1, projected: base };
  }

  // Beyond this stretch the fastest account is already pinned at MAX, so
  // `projectedAt` is flat — no point searching further (and it bounds the loop).
  const hi = CADENCE_MAX_INTERVAL_MS / Math.min(...intervals);
  if (projectedAt(hi) >= ceiling) {
    // Even fully clamped we can't reach the ceiling (too many accounts for the
    // budget). Stretch as far as it still helps; the hard budget gate backstops.
    return { stretch: hi, projected: projectedAt(hi) };
  }
  let lo = 1;
  let high = hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + high) / 2;
    if (projectedAt(mid) > ceiling) lo = mid;
    else high = mid;
  }
  return { stretch: high, projected: projectedAt(high) };
}

/**
 * Up to +this fraction of an account's own poll interval is added as random,
 * per-account jitter on each next-due time, so accounts decorrelate and polls
 * scatter irregularly rather than marching in lockstep. Lives here (next to
 * {@link pollJitterMs}) so {@link InstagramMonitorStore.dueAccounts} can size
 * jitter to each account's adaptive interval without importing from scheduler.
 */
export const POLL_JITTER_FRACTION = 0.5;

/**
 * Per-account jitter in [0, maxJitterMs). Added to an account's next-due time
 * so polls scatter irregularly across the interval instead of marching in
 * lockstep — anti-bot signal vs. IG's pattern detectors.
 *
 * Truly random (Math.random) rather than seeded: from IG's side the gap
 * between consecutive polls is what matters, not whether our internal seed
 * was deterministic. A fresh draw per tick widens the effective distribution
 * (a tick can defer or surface an account based on the roll), at the price of
 * a small amount of tick-level flicker that's harmless — once `dueAccounts`
 * picks an account, `last_polled_at` advances and it's not due again for
 * roughly another interval anyway.
 *
 * The id/lastPolledAt args are kept on the signature for API stability; only
 * `lastPolledAt === null` is meaningful (a never-polled account skips jitter
 * so its first poll fires immediately).
 */
export function pollJitterMs(
  _id: number,
  lastPolledAt: number | null,
  maxJitterMs: number,
): number {
  if (maxJitterMs <= 0 || lastPolledAt === null) return 0;
  return Math.floor(Math.random() * maxJitterMs);
}

export interface AddAccountInput {
  username: string;
  added_by: string;
}

export class InstagramMonitorStore {
  constructor(private readonly db: Database.Database) {}

  /** Returns the new row, or the existing row if already present. */
  upsertAccount(input: AddAccountInput): { account: MonitoredAccount; created: boolean } {
    const existing = this.getAccount(input.username);
    if (existing) return { account: existing, created: false };
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO instagram_monitor_accounts
           (username, added_by, added_at, paused, consecutive_failures)
         VALUES (?, ?, ?, 0, 0)`,
      )
      .run(input.username, input.added_by, now);
    const account = this.getAccount(input.username);
    if (!account) throw new Error('Failed to read back inserted account');
    return { account, created: true };
  }

  removeAccount(username: string): MonitoredAccount | null {
    const existing = this.getAccount(username);
    if (!existing) return null;
    this.db
      .prepare(`DELETE FROM instagram_monitor_accounts WHERE username = ?`)
      .run(username);
    return existing;
  }

  setPaused(username: string, paused: boolean): MonitoredAccount | null {
    const existing = this.getAccount(username);
    if (!existing) return null;
    this.db
      .prepare(`UPDATE instagram_monitor_accounts SET paused = ? WHERE username = ?`)
      .run(paused ? 1 : 0, username);
    return this.getAccount(username);
  }

  getAccount(username: string): MonitoredAccount | null {
    const row = this.db
      .prepare(`SELECT * FROM instagram_monitor_accounts WHERE username = ?`)
      .get(username) as MonitoredAccount | undefined;
    return row ?? null;
  }

  listAccounts(): MonitoredAccount[] {
    return this.db
      .prepare(`SELECT * FROM instagram_monitor_accounts ORDER BY username ASC`)
      .all() as MonitoredAccount[];
  }

  /**
   * Accounts due for polling: paused=0 AND consecutive_auth_failures below the
   * auto-stop threshold AND (never polled OR enough time has elapsed). Each
   * account's interval is its LEARNED cadence (`poll_interval_ms`) — or
   * `defaultIntervalMs` when not yet learned — scaled by the global budget-governor
   * `poll_stretch`, with exponential backoff on `consecutive_failures` and
   * per-account jitter on top. Ordered oldest-first so naturally-staggered polls
   * don't burst.
   */
  dueAccounts(
    nowMs: number,
    defaultIntervalMs: number,
    limit: number,
  ): MonitoredAccount[] {
    const stretch = this.getRuntime().poll_stretch ?? 1;
    const rows = this.db
      .prepare(
        `SELECT * FROM instagram_monitor_accounts
         WHERE paused = 0
           AND consecutive_auth_failures < ?
         ORDER BY COALESCE(last_polled_at, 0) ASC`,
      )
      .all(AUTH_PAUSE_THRESHOLD) as MonitoredAccount[];
    const out: MonitoredAccount[] = [];
    for (const r of rows) {
      const base = effectiveBaseIntervalMs(r, defaultIntervalMs, stretch);
      // Backoff cap is max(MAX_BACKOFF, base) so a base interval above the 6h
      // backoff ceiling isn't silently capped — now that the cadence ceiling is
      // 12h (> MAX_BACKOFF), this guard binds for rare accounts: a 12h-cadence
      // account with failures still polls every ~12h, not exponentially slower.
      const dueAt =
        (r.last_polled_at ?? 0) +
        Math.min(base * 2 ** Math.min(r.consecutive_failures, 10), Math.max(MAX_BACKOFF_MS, base)) +
        pollJitterMs(r.id, r.last_polled_at, Math.floor(base * POLL_JITTER_FRACTION));
      if (r.last_polled_at === null || nowMs >= dueAt) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  markPollSuccess(
    id: number,
    nowMs: number,
    newLastPostId: string | null,
    newLastPostAt: number | null = null,
  ): void {
    if (newLastPostId === null) {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?,
               consecutive_failures = 0,
               consecutive_auth_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, id);
    } else {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?, last_post_id = ?, last_post_at = ?,
               consecutive_failures = 0,
               consecutive_auth_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, newLastPostId, newLastPostAt, id);
    }
  }

  /**
   * Record a poll failure. Pass `{ auth: true }` for auth-class failures (the
   * IG session is bad: 401/403, checkpoint_required, challenge_required,
   * require_login). Auth failures also increment {@link MonitoredAccount.consecutive_auth_failures}
   * and, at the {@link AUTH_PAUSE_THRESHOLD}, cause `dueAccounts` to skip the
   * account until a successful poll resets the counter (or `clearFailureBackoff`
   * is called at restart).
   */
  markPollFailure(id: number, nowMs: number, opts: { auth?: boolean } = {}): void {
    if (opts.auth) {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?,
               consecutive_failures = consecutive_failures + 1,
               consecutive_auth_failures = consecutive_auth_failures + 1
           WHERE id = ?`,
        )
        .run(nowMs, id);
    } else {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?,
               consecutive_failures = consecutive_failures + 1
           WHERE id = ?`,
        )
        .run(nowMs, id);
    }
  }

  /**
   * Zero out both failure counters across every account. Called by the
   * scheduler on `start()` so that the operator's "refresh cookies and restart"
   * flow re-enables polling immediately — no per-account unpause needed, no
   * waiting for an 8-hour exponential backoff window to elapse.
   */
  clearFailureBackoff(): { cleared: number } {
    const info = this.db
      .prepare(
        `UPDATE instagram_monitor_accounts
         SET consecutive_failures = 0,
             consecutive_auth_failures = 0
         WHERE consecutive_failures > 0 OR consecutive_auth_failures > 0`,
      )
      .run();
    return { cleared: info.changes };
  }

  /** Reset the dedup anchor so the next poll re-classifies the most recent posts. */
  resetLastPost(username: string): MonitoredAccount | null {
    const existing = this.getAccount(username);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE instagram_monitor_accounts
         SET last_post_id = NULL, last_post_at = NULL, last_polled_at = NULL
         WHERE username = ?`,
      )
      .run(username);
    return this.getAccount(username);
  }

  hasSeen(channelId: string, igPostId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM instagram_monitor_seen_posts
         WHERE channel_id = ? AND ig_post_id = ?`,
      )
      .get(channelId, igPostId);
    return row !== undefined;
  }

  recordSeen(input: {
    channel_id: string;
    ig_post_id: string;
    account_username: string;
    caption: string | null;
    media_type: string | null;
    posted_at: number | null;
    classification_json: string | null;
    pushed: boolean;
    discord_message_id: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO instagram_monitor_seen_posts
           (ig_post_id, account_username, channel_id, caption, media_type, posted_at,
            detected_at, classification_json, pushed, discord_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ig_post_id,
        input.account_username,
        input.channel_id,
        input.caption,
        input.media_type,
        input.posted_at,
        Date.now(),
        input.classification_json,
        input.pushed ? 1 : 0,
        input.discord_message_id,
      );
  }

  recentPushed(channelId: string, limit: number): SeenPost[] {
    return this.db
      .prepare(
        `SELECT * FROM instagram_monitor_seen_posts
         WHERE channel_id = ? AND pushed = 1
         ORDER BY detected_at DESC
         LIMIT ?`,
      )
      .all(channelId, limit) as SeenPost[];
  }

  // ---- Adaptive cadence (v6) ----------------------------------------------

  /**
   * Recompute and cache one account's adaptive poll interval from its recent
   * `seen_posts` history. Dedups on `ig_post_id` (seen_posts is per-channel, so
   * each post appears once per bound channel — without the GROUP BY the gaps
   * would collapse to zero and halve the cadence). Writes `poll_interval_ms` /
   * `posts_per_day` / `cadence_updated_at`. Leaves the interval NULL when there
   * isn't enough trustworthy history (caller falls back to the default).
   */
  recomputeCadence(id: number, nowMs: number): void {
    const row = this.db
      .prepare(`SELECT username FROM instagram_monitor_accounts WHERE id = ?`)
      .get(id) as { username: string } | undefined;
    if (!row) return;
    const since = nowMs - CADENCE_WINDOW_MS;
    const posts = this.db
      .prepare(
        `SELECT posted_at FROM (
           SELECT ig_post_id, MAX(posted_at) AS posted_at
           FROM instagram_monitor_seen_posts
           WHERE account_username = ? AND posted_at IS NOT NULL AND posted_at >= ?
           GROUP BY ig_post_id
         )
         ORDER BY posted_at DESC
         LIMIT ?`,
      )
      .all(row.username, since, CADENCE_MAX_SAMPLES) as { posted_at: number }[];
    const { intervalMs, postsPerDay } = computeCadenceInterval(
      posts.map((p) => p.posted_at),
      nowMs,
    );
    this.db
      .prepare(
        `UPDATE instagram_monitor_accounts
         SET poll_interval_ms = ?, posts_per_day = ?, cadence_updated_at = ?
         WHERE id = ?`,
      )
      .run(intervalMs, postsPerDay, nowMs, id);
  }

  /**
   * Daily sweep: recompute cadence for every account whose estimate is stale
   * (NULL or older than {@link CADENCE_TTL_MS}), then recompute and persist the
   * global budget-governor {@link RuntimeState.poll_stretch}. One transaction.
   * Returns a small summary for logging.
   */
  recomputeAllCadence(
    nowMs: number,
    opts: {
      callsPerPoll: number;
      dailyRequestBudget: number;
      defaultIntervalMs: number;
      activeFraction: number;
      headroom?: number;
    },
  ): { swept: number; stretch: number; projected: number } {
    const headroom = opts.headroom ?? CADENCE_BUDGET_HEADROOM;
    return this.db.transaction(() => {
      let swept = 0;
      for (const a of this.listAccounts()) {
        if (a.cadence_updated_at === null || nowMs - a.cadence_updated_at >= CADENCE_TTL_MS) {
          this.recomputeCadence(a.id, nowMs);
          swept++;
        }
      }
      const { stretch, projected } = computeGovernorStretch(this.listAccounts(), {
        callsPerPoll: opts.callsPerPoll,
        dailyRequestBudget: opts.dailyRequestBudget,
        defaultIntervalMs: opts.defaultIntervalMs,
        activeFraction: opts.activeFraction,
        headroom,
      });
      this.writePollStretch(stretch);
      return { swept, stretch, projected };
    })();
  }

  // ---- Global runtime / circuit breaker (v5) ------------------------------

  /** Read the singleton runtime row. The row is guaranteed to exist (seeded by
   * the v5 migration), but we coerce defensively for older test DBs. */
  getRuntime(): RuntimeState {
    const row = this.db
      .prepare(`SELECT * FROM instagram_monitor_runtime WHERE id = 1`)
      .get() as RuntimeState | undefined;
    return (
      row ?? {
        global_stop: 0,
        stop_reason: null,
        stopped_at: null,
        recent_auth_json: null,
        recent_429_json: null,
        auth_cooldown_until: null,
        rate_cooldown_until: null,
        budget_pause_until: null,
        requests_24h: null,
        heartbeat_at: null,
        poll_stretch: 1,
        last_digest_at: null,
      }
    );
  }

  /** Whether the persistent kill-switch is engaged. */
  isGlobalStopped(): boolean {
    return this.getRuntime().global_stop === 1;
  }

  /** Engage the persistent kill-switch. Idempotent — a second trip keeps the
   * original reason/timestamp so we don't lose the first cause. */
  tripGlobalStop(reason: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_runtime
         SET global_stop = 1,
             stop_reason = COALESCE(stop_reason, ?),
             stopped_at = COALESCE(stopped_at, ?)
         WHERE id = 1`,
      )
      .run(reason, nowMs);
  }

  /** Clear the kill-switch (the only way back — driven by `resume_monitor`).
   * Also clears the windowed event arrays so a resumed monitor starts fresh. */
  clearGlobalStop(): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_runtime
         SET global_stop = 0, stop_reason = NULL, stopped_at = NULL,
             recent_auth_json = NULL, recent_429_json = NULL
         WHERE id = 1`,
      )
      .run();
  }

  /** Append `nowMs` to the auth-failure window, prune entries older than
   * {@link EVENT_WINDOW_MS}, and return the resulting count. */
  recordAuthEvent(nowMs: number): number {
    return this.appendEvent('recent_auth_json', nowMs);
  }

  /** Append `nowMs` to the 429 window, prune, and return the resulting count. */
  record429Event(nowMs: number): number {
    return this.appendEvent('recent_429_json', nowMs);
  }

  private appendEvent(column: 'recent_auth_json' | 'recent_429_json', nowMs: number): number {
    const runtime = this.getRuntime();
    const raw = column === 'recent_auth_json' ? runtime.recent_auth_json : runtime.recent_429_json;
    let arr: number[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed.filter((n) => typeof n === 'number');
      } catch {
        arr = [];
      }
    }
    arr.push(nowMs);
    const cutoff = nowMs - EVENT_WINDOW_MS;
    arr = arr.filter((t) => t >= cutoff);
    this.db
      .prepare(`UPDATE instagram_monitor_runtime SET ${column} = ? WHERE id = 1`)
      .run(JSON.stringify(arr));
    return arr.length;
  }

  /** Scheduler heartbeat: mirror the in-memory cooldowns + 24h request count
   * into the runtime row so the admin `status` tool can observe them. */
  writeHeartbeat(h: {
    authCooldownUntil: number | null;
    rateCooldownUntil: number | null;
    budgetPauseUntil: number | null;
    requests24h: number;
    nowMs: number;
  }): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_runtime
         SET auth_cooldown_until = ?, rate_cooldown_until = ?, budget_pause_until = ?,
             requests_24h = ?, heartbeat_at = ?
         WHERE id = 1`,
      )
      .run(h.authCooldownUntil, h.rateCooldownUntil, h.budgetPauseUntil, h.requests24h, h.nowMs);
  }

  /** Persist the budget-governor stretch multiplier (read by {@link dueAccounts}). */
  writePollStretch(stretch: number): void {
    this.db
      .prepare(`UPDATE instagram_monitor_runtime SET poll_stretch = ? WHERE id = 1`)
      .run(stretch);
  }

  /** Stamp the last-posted time of the daily status digest (once-per-day gate). */
  writeLastDigestAt(nowMs: number): void {
    this.db
      .prepare(`UPDATE instagram_monitor_runtime SET last_digest_at = ? WHERE id = 1`)
      .run(nowMs);
  }
}
