import type { Client } from 'discord.js';
import { log } from '../../log.js';
import { EVENT_WINDOW_MS, type InstagramMonitorStore, type MonitoredAccount } from './store.js';
import {
  InstagramAuthError,
  InstagramRateLimitError,
  type InstagramFetcher,
  type RecentPost,
} from './fetcher.js';
import { classifyPost, type Classification } from './classifier.js';
import { fetchCover as defaultFetchCover, publishPost as defaultPublishPost, type PublishResult } from './publisher.js';

// Base polling cadence per account. Raised from 20 min → 60 min on 2026-05-29
// after IG checkpointed the throwaway session: lower request volume + irregular
// gaps reduce the automation signal. With ACCOUNTS_PER_TICK=1 and a 60s tick we
// can still keep ~60 accounts on cadence at this interval.
export const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_TICK_MS = 60 * 1000;
// One account per tick (≤1 outbound IG request per minute) so we never fire a
// synchronized burst that looks like a bot.
const ACCOUNTS_PER_TICK = 1;
// Up to +50% of the poll interval of random, per-account jitter on each
// account's next-due time, so the accounts decorrelate and polls scatter
// irregularly across the window rather than marching in lockstep.
export const POLL_JITTER_FRACTION = 0.5;
const MAX_PUSHES_PER_ACCOUNT_PER_TICK_PER_CHANNEL = 5;

// Quiet hours: skip polling between these wall-clock hours in America/Mexico_City.
// Real users don't browse IG at 4 AM — a 24/7 cadence is one of the loudest
// automation signals. Cuts ~21% of daily request volume per account at zero
// product impact (any posts published overnight surface naturally on the
// 07:00 resume).
const QUIET_HOURS_TZ = 'America/Mexico_City';
const QUIET_HOURS_START_HOUR = 2;
const QUIET_HOURS_END_HOUR = 7;
// Per-day deterministic jitter (± minutes) applied to the quiet-hour
// boundaries, so the monitor doesn't resume at exactly 07:00 every single day
// (a perfectly fixed daily edge is itself a weak automation tell). Stable
// within a local date, reshuffles the next day.
const QUIET_BOUNDARY_JITTER_MIN = 20;

// After an auth-class failure we suspend ALL IG polling for this long, even
// for accounts that haven't yet hit AUTH_PAUSE_THRESHOLD individually. Stops
// the bot from working through the account list one-by-one while IG is already
// flagging the session — that pattern is itself an automation signal.
const AUTH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

// A 429/throttle is worse than a one-off auth blip: IG is actively rate-limiting
// us and continuing to poll escalates toward a ban. On a throttle we suspend ALL
// polling for an escalating cooldown (base 2h, ×2 per throttle in the window,
// capped at 12h) — longer than the auth cooldown.
const RATE_LIMIT_COOLDOWN_BASE_MS = 2 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 12 * 60 * 60 * 1000;

// Circuit-breaker trip threshold for throttles (counted within EVENT_WINDOW_MS,
// 6h): a 429 is IP/session-wide, so ≥2 in the window trips the PERSISTENT global
// stop (manual resume only). Session-level auth failures (require_login /
// checkpoint / challenge) trip immediately; account-specific 401/403 never trip
// the global stop (they auto-pause the single offending account instead).
const RATE_LIMIT_TRIP_COUNT = 2;

// Rolling window for the daily request budget.
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

// Don't spam the admin channel: at most one alert (auth / circuit / budget)
// every 6h per category. The operator only needs one message to know to act.
const AUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Function signatures injected by the capability; tests can swap them. */
export type ClassifyFn = (
  account: string,
  post: RecentPost,
  opts: { cover?: { bytes: Uint8Array; mimeType: string; format: 'jpeg' }; nowMs: number },
) => Promise<Classification>;
export type PublishFn = (
  client: Client,
  channelId: string,
  account: string,
  post: RecentPost,
  classification: Classification,
  coverBytes: Uint8Array | null,
) => Promise<PublishResult>;
export type FetchCoverFn = (url: string) => Promise<Uint8Array | null>;

/**
 * Called when the bot detects an IG auth failure (`InstagramAuthError` thrown
 * by the fetcher). Used to surface a message in the admin/config Discord
 * channel so the operator knows to refresh cookies — the prior watcher that
 * did this from launchd does not exist on the Pi. The scheduler rate-limits
 * its own calls (one alert per 6 h) so this can be a thin Discord-send closure
 * that doesn't worry about deduplication.
 */
export type NotifyAuthExpiredFn = (info: {
  account: string;
  reason: string;
}) => Promise<void>;

/** Posted to the admin channel when the PERSISTENT circuit breaker trips. */
export type NotifyCircuitBrokenFn = (reason: string) => Promise<void>;

/** Posted to the admin channel when the daily request budget is exhausted. */
export type NotifyBudgetExhaustedFn = (info: {
  requests24h: number;
  budget: number;
}) => Promise<void>;

export interface SchedulerDeps {
  store: InstagramMonitorStore;
  fetcher: InstagramFetcher;
  client: Client;
  /**
   * Returns the Discord channel ids currently bound to the instagram_monitor
   * capability. Called fresh each tick so re-bindings take effect without a
   * scheduler restart.
   */
  getBoundChannels: () => string[];
  /** Override for tests. Defaults to the real classifier. */
  classify?: ClassifyFn;
  /** Override for tests. Defaults to the real publisher. */
  publish?: PublishFn;
  /** Override for tests. Defaults to the real fetchCover. */
  fetchCover?: FetchCoverFn;
  /** Posted to the admin Discord channel on auth failures. Optional in tests. */
  notifyAuthExpired?: NotifyAuthExpiredFn;
  /** Posted when the persistent circuit breaker trips. Optional in tests. */
  notifyCircuitBroken?: NotifyCircuitBrokenFn;
  /** Posted when the daily request budget is hit. Optional in tests. */
  notifyBudgetExhausted?: NotifyBudgetExhaustedFn;
  /**
   * Hard ceiling on outbound IG HTTP requests in a rolling 24h window. When
   * hit, polling soft-pauses (auto-recovers as the window drains) and the
   * operator is alerted. `0`/unset disables the budget (tests leave it off).
   */
  dailyRequestBudget?: number;
  /**
   * Probability in [0,1) of skipping an entire tick at random, so polling
   * isn't a perfect metronome. `0`/unset disables it — tests leave it off to
   * stay deterministic; production sets a small value (~0.08).
   */
  tickSkipProbability?: number;
}

/** Deterministic per-local-date jitter in [-QUIET_BOUNDARY_JITTER_MIN,
 * +QUIET_BOUNDARY_JITTER_MIN] minutes, salted so the start and end edges move
 * independently. Stable within a day (no flicker), reshuffles the next day. */
function quietBoundaryJitterMin(nowMs: number, tz: string, salt: string): number {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
  const seed = `${date}:${salt}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (h % (2 * QUIET_BOUNDARY_JITTER_MIN + 1)) - QUIET_BOUNDARY_JITTER_MIN;
}

/**
 * Returns true when the current local time in `America/Mexico_City` falls
 * inside the quiet-hours window, whose start/end edges carry a small
 * deterministic per-day jitter. Exported for tests.
 */
export function inQuietHours(nowMs: number, tz = QUIET_HOURS_TZ): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const minutesOfDay = hour * 60 + minute;
  const start = QUIET_HOURS_START_HOUR * 60 + quietBoundaryJitterMin(nowMs, tz, 'start');
  const end = QUIET_HOURS_END_HOUR * 60 + quietBoundaryJitterMin(nowMs, tz, 'end');
  return minutesOfDay >= start && minutesOfDay < end;
}

export class InstagramMonitorScheduler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private disposed = false;
  private readonly classify: ClassifyFn;
  private readonly publish: PublishFn;
  private readonly fetchCover: FetchCoverFn;
  /** Set to `nowMs + AUTH_FAILURE_COOLDOWN_MS` on any auth-class failure.
   * `tickOnce()` skips polling while this is in the future. Cleared on
   * successful poll (via the auth counter reset cascading through). In-memory
   * only — a restart resets it, which is the desired flow after the operator
   * refreshes cookies. */
  private authCooldownUntilMs = 0;
  /** Set to `nowMs + escalating` on a 429/throttle. `tickOnce()` skips polling
   * while in the future. In-memory only — a restart resumes (the persistent
   * breaker is the thing that survives restart). */
  private rateLimitCooldownUntilMs = 0;
  /** Rate-limits for the admin-channel alerts: at most one per 6 h, per kind. */
  private lastAuthAlertAtMs = 0;
  private lastCircuitAlertAtMs = 0;
  private lastBudgetAlertAtMs = 0;
  /** Timestamps of outbound IG HTTP requests in the rolling 24h window. */
  private requestTimestamps: number[] = [];
  private readonly dailyRequestBudget: number;
  private readonly tickSkipProbability: number;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly tickMs = DEFAULT_TICK_MS,
  ) {
    this.classify = deps.classify ?? classifyPost;
    this.publish = deps.publish ?? defaultPublishPost;
    this.fetchCover = deps.fetchCover ?? defaultFetchCover;
    this.dailyRequestBudget = deps.dailyRequestBudget ?? 0;
    this.tickSkipProbability = deps.tickSkipProbability ?? 0;
    // Wire the fetcher's per-request observer into our rolling 24h counter (for
    // the daily-budget guardrail). Done here (not in start()) so it's active
    // even when tests drive tickOnce() directly.
    this.deps.fetcher.observeRequests?.(() => this.recordRequest());
  }

  start(): void {
    if (this.intervalHandle) return;
    // Zero out backoff counters so any leftover post-outage state (e.g. accounts
    // that hit AUTH_PAUSE_THRESHOLD before this restart, or sat at 8-hour
    // exponential backoff) gets a clean slate. Operator-set `paused=1` is left
    // intact — that's intentional, not a side effect of the prior failure.
    // NOTE: clearFailureBackoff() deliberately does NOT touch the persistent
    // global-stop row, so a circuit breaker tripped before the restart stays
    // tripped (resume is manual-only via the admin tool).
    const cleared = this.deps.store.clearFailureBackoff();
    const runtime = this.deps.store.getRuntime();
    log.info(
      {
        source: this.deps.fetcher.source(),
        tickMs: this.tickMs,
        pollIntervalMs: this.pollIntervalMs,
        cleared_backoff_rows: cleared.cleared,
        daily_request_budget: this.dailyRequestBudget || null,
        global_stop: runtime.global_stop === 1,
        stop_reason: runtime.stop_reason,
      },
      runtime.global_stop === 1
        ? 'instagram_monitor.scheduler.start.global_stopped'
        : 'instagram_monitor.scheduler.start',
    );
    setImmediate(() => void this.tickOnce().catch(() => {}));
    this.intervalHandle = setInterval(() => {
      void this.tickOnce().catch((err) => {
        log.error({ err }, 'instagram_monitor.tick_failed');
      });
    }, this.tickMs);
  }

  /** Record one outbound IG request and prune the rolling 24h window. */
  private recordRequest(): void {
    const now = Date.now();
    this.requestTimestamps.push(now);
    const cutoff = now - REQUEST_WINDOW_MS;
    if (this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
    }
  }

  /** Count of outbound IG requests in the last 24h (prunes as a side effect). */
  private requests24h(now: number): number {
    const cutoff = now - REQUEST_WINDOW_MS;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
    return this.requestTimestamps.length;
  }

  /** Trip the PERSISTENT circuit breaker (manual resume only) and alert the
   * operator once per 6h. Idempotent — re-tripping keeps the first reason. */
  private async tripBreaker(reason: string, now: number): Promise<void> {
    const already = this.deps.store.isGlobalStopped();
    this.deps.store.tripGlobalStop(reason, now);
    log.error({ reason }, 'instagram_monitor.circuit_broken');
    if (
      !already &&
      this.deps.notifyCircuitBroken &&
      now - this.lastCircuitAlertAtMs >= AUTH_ALERT_COOLDOWN_MS
    ) {
      this.lastCircuitAlertAtMs = now;
      try {
        await this.deps.notifyCircuitBroken(reason);
      } catch (err) {
        log.warn({ err }, 'instagram_monitor.circuit_notify_failed');
      }
    }
  }

  /** Mirror in-memory cooldowns + 24h request count into the runtime row so
   * the admin `status` tool can observe them. Best-effort. */
  private heartbeat(now: number): void {
    try {
      const used = this.requests24h(now);
      let budgetPauseUntil: number | null = null;
      if (
        this.dailyRequestBudget > 0 &&
        used >= this.dailyRequestBudget &&
        this.requestTimestamps.length > 0
      ) {
        budgetPauseUntil = this.requestTimestamps[0] + REQUEST_WINDOW_MS;
      }
      this.deps.store.writeHeartbeat({
        authCooldownUntil: this.authCooldownUntilMs || null,
        rateCooldownUntil: this.rateLimitCooldownUntilMs || null,
        budgetPauseUntil,
        requests24h: used,
        nowMs: now,
      });
    } catch (err) {
      log.debug({ err }, 'instagram_monitor.heartbeat_failed');
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Exposed for testing — drive the loop step by step. */
  async tickOnce(): Promise<void> {
    if (this.tickInFlight || this.disposed) return;
    this.tickInFlight = true;
    const t0 = Date.now();
    try {
      const now = Date.now();
      // 1. Persistent kill-switch (survives restart): nothing polls until the
      // operator runs `config_instagram action:resume_monitor`.
      const runtime = this.deps.store.getRuntime();
      if (runtime.global_stop === 1) {
        log.warn(
          { reason: runtime.stop_reason },
          'instagram_monitor.tick.global_stop',
        );
        return;
      }
      if (inQuietHours(now)) {
        log.debug({}, 'instagram_monitor.tick.quiet_hours');
        return;
      }
      // 2. Occasionally skip a whole tick so polling isn't a perfect metronome.
      if (this.tickSkipProbability > 0 && Math.random() < this.tickSkipProbability) {
        log.debug({}, 'instagram_monitor.tick.random_skip');
        return;
      }
      if (now < this.authCooldownUntilMs) {
        log.debug(
          { until: this.authCooldownUntilMs },
          'instagram_monitor.tick.auth_cooldown',
        );
        return;
      }
      if (now < this.rateLimitCooldownUntilMs) {
        log.debug(
          { until: this.rateLimitCooldownUntilMs },
          'instagram_monitor.tick.rate_limit_cooldown',
        );
        return;
      }
      // 3. Daily request budget (soft, auto-recovering as the window drains).
      if (this.dailyRequestBudget > 0) {
        const used = this.requests24h(now);
        if (used >= this.dailyRequestBudget) {
          log.warn(
            { used, budget: this.dailyRequestBudget },
            'instagram_monitor.budget_exhausted',
          );
          if (
            this.deps.notifyBudgetExhausted &&
            now - this.lastBudgetAlertAtMs >= AUTH_ALERT_COOLDOWN_MS
          ) {
            this.lastBudgetAlertAtMs = now;
            try {
              await this.deps.notifyBudgetExhausted({
                requests24h: used,
                budget: this.dailyRequestBudget,
              });
            } catch (err) {
              log.warn({ err }, 'instagram_monitor.budget_notify_failed');
            }
          }
          return;
        }
      }
      const jitterMaxMs = Math.floor(this.pollIntervalMs * POLL_JITTER_FRACTION);
      const due = this.deps.store.dueAccounts(
        now,
        this.pollIntervalMs,
        ACCOUNTS_PER_TICK,
        jitterMaxMs,
      );
      if (due.length === 0) return;
      log.info({ due: due.length }, 'instagram_monitor.tick');
      for (const acc of due) {
        if (this.disposed) return;
        await this.processAccount(acc);
      }
    } finally {
      this.tickInFlight = false;
      this.heartbeat(Date.now());
      log.debug({ ms: Date.now() - t0 }, 'instagram_monitor.tick.done');
    }
  }

  private async processAccount(acc: MonitoredAccount): Promise<void> {
    const t0 = Date.now();
    let posts: RecentPost[];
    try {
      posts = await this.deps.fetcher.fetchRecentPosts(acc.username);
      log.info(
        { account: acc.username, count: posts.length, ms: Date.now() - t0 },
        'instagram_monitor.fetch.ok',
      );
    } catch (err) {
      const now = Date.now();

      // 429 / throttle: IG is rate-limiting us. Treat as a global SOFT block —
      // halt ALL polling for an escalating cooldown, and trip the persistent
      // breaker if it recurs. Continuing to poll while throttled is exactly
      // what turns a throttle into a ban.
      if (err instanceof InstagramRateLimitError) {
        this.deps.store.markPollFailure(acc.id, now, { auth: false });
        const count = this.deps.store.record429Event(now);
        const escalated = Math.min(
          RATE_LIMIT_COOLDOWN_BASE_MS * 2 ** Math.min(count - 1, 3),
          RATE_LIMIT_COOLDOWN_MAX_MS,
        );
        const cooldown = Math.max(err.retryAfterMs ?? 0, escalated);
        this.rateLimitCooldownUntilMs = Math.max(
          this.rateLimitCooldownUntilMs,
          now + cooldown,
        );
        log.warn(
          { account: acc.username, count, cooldownMs: cooldown, err: String(err) },
          'instagram_monitor.rate_limited',
        );
        if (count >= RATE_LIMIT_TRIP_COUNT) {
          await this.tripBreaker(
            `IG throttled ${count}× within ${Math.round(EVENT_WINDOW_MS / 3_600_000)}h — polling stopped to avoid a ban`,
            now,
          );
        }
        return;
      }

      const isAuth = err instanceof InstagramAuthError;
      this.deps.store.markPollFailure(acc.id, now, { auth: isAuth });
      if (isAuth) {
        // Distinguish a SESSION-level failure (cookies dead / account
        // challenged — affects every account) from an account-specific 401/403
        // (a private/restricted/blocked single handle). Treating an
        // account-specific 401 as session death would halt ALL polling and trip
        // the kill-switch over one bad handle — observed in practice with two
        // restricted accounts among a dozen healthy ones.
        if (err.sessionLevel) {
          this.authCooldownUntilMs = now + AUTH_FAILURE_COOLDOWN_MS;
          const count = this.deps.store.recordAuthEvent(now);
          log.error(
            { account: acc.username, reason: err.reason, count, err: String(err) },
            'instagram_monitor.auth.expired',
          );
          // Tell the operator via Discord, rate-limited to once per 6 h.
          if (
            this.deps.notifyAuthExpired &&
            now - this.lastAuthAlertAtMs >= AUTH_ALERT_COOLDOWN_MS
          ) {
            this.lastAuthAlertAtMs = now;
            try {
              await this.deps.notifyAuthExpired({
                account: acc.username,
                reason: String(err),
              });
            } catch (notifyErr) {
              log.warn({ err: notifyErr }, 'instagram_monitor.auth_notify_failed');
            }
          }
          // A session flag/death is the catastrophic case → engage the
          // persistent kill-switch (manual resume only), per the "safest" choice.
          await this.tripBreaker(
            `IG flagged the session (${err.reason}) while polling @${acc.username} — polling stopped`,
            now,
          );
        } else {
          // Account-specific 401/403: don't halt the whole monitor. The
          // per-account auth counter still climbs, so dueAccounts() auto-pauses
          // this handle at AUTH_PAUSE_THRESHOLD while everyone else keeps polling.
          log.warn(
            {
              account: acc.username,
              reason: err.reason,
              auth_failures: acc.consecutive_auth_failures + 1,
            },
            'instagram_monitor.account_auth_failed',
          );
        }
      } else {
        log.warn(
          { account: acc.username, err, failures: acc.consecutive_failures + 1 },
          'instagram_monitor.fetch.failed',
        );
      }
      return;
    }

    if (posts.length === 0) {
      this.deps.store.markPollSuccess(acc.id, Date.now(), null);
      return;
    }

    // Instagram returns PINNED posts first, out of chronological order, so the
    // raw array order is not a reliable "newest first". Sort by capture time
    // so the dedup anchor tracks the genuinely-newest post and pinned-but-old
    // posts can't freeze detection.
    const ordered = [...posts].sort((a, b) => b.takenAtMs - a.takenAtMs);
    const newest = ordered[0];

    // First-ever poll: no anchor → don't backfill anything, just seed.
    if (acc.last_post_id === null) {
      log.info(
        { account: acc.username, seeded_to: newest.igPostId, posts: posts.length },
        'instagram_monitor.first_poll_seed',
      );
      this.deps.store.markPollSuccess(acc.id, Date.now(), newest.igPostId, newest.takenAtMs);
      return;
    }

    // Collect everything newer than the dedup anchor. Normally the anchor post
    // is still in the returned window, so we walk down to it — this also
    // correctly handles pinned-but-old posts that IG lists first (they sort to
    // the bottom and stay below the anchor). But IG sometimes returns a stale
    // or paginated window that OMITS the anchor post; treating that whole batch
    // as "new" is exactly what resurrects weeks-old posts. So when the anchor
    // is absent we fall back to a strict capture-time gate against the anchor's
    // recorded timestamp (or re-seed without backfill if we never recorded one).
    const anchorIdx = ordered.findIndex((p) => p.igPostId === acc.last_post_id);
    let newPostsNewestFirst: RecentPost[];
    if (anchorIdx >= 0) {
      newPostsNewestFirst = ordered.slice(0, anchorIdx);
      // Defence-in-depth: even with the anchor present, never resurrect a post
      // at or older than the recorded anchor *time*. This matters when
      // last_post_id points at a post OLDER than last_post_at — an
      // inconsistency the v3 migration backfill (last_post_at = MAX(seen
      // posted_at)) can leave on rows that were mid-bug. A no-op for the common
      // consistent row, where everything above the anchor is already newer.
      if (acc.last_post_at !== null) {
        const floor = acc.last_post_at;
        newPostsNewestFirst = newPostsNewestFirst.filter((p) => p.takenAtMs > floor);
      }
    } else if (acc.last_post_at !== null) {
      newPostsNewestFirst = ordered.filter((p) => p.takenAtMs > (acc.last_post_at as number));
      log.warn(
        {
          account: acc.username,
          anchor: acc.last_post_id,
          anchor_at: acc.last_post_at,
          batch_newest_at: newest.takenAtMs,
          candidates: newPostsNewestFirst.length,
        },
        'instagram_monitor.anchor_missing.time_gated',
      );
    } else {
      // Legacy row: anchor id set but no recorded time, and it's not in the
      // window. Re-seed to the newest without backfilling.
      log.warn(
        { account: acc.username, anchor: acc.last_post_id, reseed_to: newest.igPostId },
        'instagram_monitor.anchor_missing.reseed',
      );
      this.deps.store.markPollSuccess(acc.id, Date.now(), newest.igPostId, newest.takenAtMs);
      return;
    }

    // Advance the anchor strictly forward in capture time: a stale/older window
    // must never pull it backward (that re-arms the whole backfill on the next
    // poll). With no recorded time yet (fresh seed / legacy row) adopt newest.
    const next =
      acc.last_post_at === null || newest.takenAtMs >= acc.last_post_at
        ? { id: newest.igPostId, at: newest.takenAtMs }
        : { id: acc.last_post_id, at: acc.last_post_at };

    if (newPostsNewestFirst.length === 0) {
      this.deps.store.markPollSuccess(acc.id, Date.now(), next.id, next.at);
      return;
    }

    const boundChannels = this.deps.getBoundChannels();
    // No channels bound right now: still advance the anchor so a future
    // binding doesn't get this batch as backfill. Skip the per-post work.
    if (boundChannels.length === 0) {
      log.info(
        { account: acc.username, new_posts: newPostsNewestFirst.length, advanced_to: next.id },
        'instagram_monitor.no_bound_channels.advance_anchor',
      );
      this.deps.store.markPollSuccess(acc.id, Date.now(), next.id, next.at);
      return;
    }

    // Process oldest-first so Discord receives them in real-world order.
    const chronological = [...newPostsNewestFirst].reverse();
    const pushedByChannel = new Map<string, number>();

    for (const post of chronological) {
      if (this.disposed) return;

      // Classify once per post; same outcome for every channel that gets it.
      const coverBytes = await this.fetchCover(post.displayUrl);
      const classification = await this.classify(acc.username, post, {
        // Cover image omitted from the classifier prompt — caption-only
        // classification is sufficient for our categories and saves tokens.
        nowMs: Date.now(),
      });

      for (const channelId of boundChannels) {
        if (this.disposed) return;
        if (this.deps.store.hasSeen(channelId, post.igPostId)) continue;

        if (!classification.relevant) {
          this.deps.store.recordSeen({
            channel_id: channelId,
            ig_post_id: post.igPostId,
            account_username: acc.username,
            caption: post.caption || null,
            media_type: post.mediaType,
            posted_at: post.takenAtMs,
            classification_json: JSON.stringify(classification),
            pushed: false,
            discord_message_id: null,
          });
          continue;
        }

        const pushedHere = pushedByChannel.get(channelId) ?? 0;
        if (pushedHere >= MAX_PUSHES_PER_ACCOUNT_PER_TICK_PER_CHANNEL) {
          this.deps.store.recordSeen({
            channel_id: channelId,
            ig_post_id: post.igPostId,
            account_username: acc.username,
            caption: post.caption || null,
            media_type: post.mediaType,
            posted_at: post.takenAtMs,
            classification_json: JSON.stringify({ skipped: 'rate_limited_per_channel' }),
            pushed: false,
            discord_message_id: null,
          });
          continue;
        }

        const result = await this.publish(
          this.deps.client,
          channelId,
          acc.username,
          post,
          classification,
          coverBytes,
        );
        this.deps.store.recordSeen({
          channel_id: channelId,
          ig_post_id: post.igPostId,
          account_username: acc.username,
          caption: post.caption || null,
          media_type: post.mediaType,
          posted_at: post.takenAtMs,
          classification_json: JSON.stringify(classification),
          pushed: result.ok,
          discord_message_id: result.messageId,
        });
        if (result.ok) pushedByChannel.set(channelId, pushedHere + 1);
      }

      if (!classification.relevant) {
        log.info(
          { account: acc.username, shortcode: post.shortcode, type: classification.type },
          'instagram_monitor.classify.skip',
        );
      }
    }

    this.deps.store.markPollSuccess(acc.id, Date.now(), next.id, next.at);
  }
}
