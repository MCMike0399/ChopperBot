import type { Client } from 'discord.js';
import { log } from '../../log.js';
import type { InstagramMonitorStore, MonitoredAccount } from './store.js';
import { InstagramAuthError, type InstagramFetcher, type RecentPost } from './fetcher.js';
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

// After an auth-class failure we suspend ALL IG polling for this long, even
// for accounts that haven't yet hit AUTH_PAUSE_THRESHOLD individually. Stops
// the bot from working through the account list one-by-one while IG is already
// flagging the session — that pattern is itself an automation signal.
const AUTH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

// Don't spam the admin channel: at most one auth-expired alert every 6h. The
// operator only needs one message to know to act; later failures just stack
// silently until the operator fixes it.
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
}

/**
 * Returns true when the current local time in `America/Mexico_City` falls
 * inside the quiet-hours window. Exported for tests.
 */
export function inQuietHours(nowMs: number, tz = QUIET_HOURS_TZ): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(new Date(nowMs));
  // Intl can render midnight as "24" depending on engine; normalise to 0–23.
  const hour = parseInt(hourStr, 10) % 24;
  return hour >= QUIET_HOURS_START_HOUR && hour < QUIET_HOURS_END_HOUR;
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
  /** Rate-limit for the admin-channel alert: at most one per 6 h. */
  private lastAuthAlertAtMs = 0;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly tickMs = DEFAULT_TICK_MS,
  ) {
    this.classify = deps.classify ?? classifyPost;
    this.publish = deps.publish ?? defaultPublishPost;
    this.fetchCover = deps.fetchCover ?? defaultFetchCover;
  }

  start(): void {
    if (this.intervalHandle) return;
    // Zero out backoff counters so any leftover post-outage state (e.g. accounts
    // that hit AUTH_PAUSE_THRESHOLD before this restart, or sat at 8-hour
    // exponential backoff) gets a clean slate. Operator-set `paused=1` is left
    // intact — that's intentional, not a side effect of the prior failure.
    const cleared = this.deps.store.clearFailureBackoff();
    log.info(
      {
        source: this.deps.fetcher.source(),
        tickMs: this.tickMs,
        pollIntervalMs: this.pollIntervalMs,
        cleared_backoff_rows: cleared.cleared,
      },
      'instagram_monitor.scheduler.start',
    );
    setImmediate(() => void this.tickOnce().catch(() => {}));
    this.intervalHandle = setInterval(() => {
      void this.tickOnce().catch((err) => {
        log.error({ err }, 'instagram_monitor.tick_failed');
      });
    }, this.tickMs);
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
      if (inQuietHours(now)) {
        log.debug({}, 'instagram_monitor.tick.quiet_hours');
        return;
      }
      if (now < this.authCooldownUntilMs) {
        log.debug(
          { until: this.authCooldownUntilMs },
          'instagram_monitor.tick.auth_cooldown',
        );
        return;
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
      const isAuth = err instanceof InstagramAuthError;
      this.deps.store.markPollFailure(acc.id, now, { auth: isAuth });
      if (isAuth) {
        // IG session is dead (401/403, checkpoint_required, challenge_required,
        // require_login). Halt polling for AUTH_FAILURE_COOLDOWN_MS so we
        // don't continue working through the account list on a flagged
        // session — that pattern itself is automation signal.
        this.authCooldownUntilMs = now + AUTH_FAILURE_COOLDOWN_MS;
        log.error(
          { account: acc.username, err: String(err) },
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
            log.warn(
              { err: notifyErr },
              'instagram_monitor.auth_notify_failed',
            );
          }
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
