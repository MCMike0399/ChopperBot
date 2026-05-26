import type { Client } from 'discord.js';
import { log } from '../../log.js';
import type { InstagramMonitorStore, MonitoredAccount } from './store.js';
import type { InstagramFetcher, RecentPost } from './fetcher.js';
import { classifyPost, type Classification } from './classifier.js';
import { fetchCover as defaultFetchCover, publishPost as defaultPublishPost, type PublishResult } from './publisher.js';

export const DEFAULT_POLL_INTERVAL_MS = 20 * 60 * 1000;
export const DEFAULT_TICK_MS = 60 * 1000;
const ACCOUNTS_PER_TICK = 3;
const MAX_PUSHES_PER_ACCOUNT_PER_TICK_PER_CHANNEL = 5;

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
}

export class InstagramMonitorScheduler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private disposed = false;
  private readonly classify: ClassifyFn;
  private readonly publish: PublishFn;
  private readonly fetchCover: FetchCoverFn;

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
    log.info(
      { source: this.deps.fetcher.source(), tickMs: this.tickMs, pollIntervalMs: this.pollIntervalMs },
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
      const due = this.deps.store.dueAccounts(Date.now(), this.pollIntervalMs, ACCOUNTS_PER_TICK);
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
      this.deps.store.markPollFailure(acc.id, Date.now());
      log.warn(
        { account: acc.username, err, failures: acc.consecutive_failures + 1 },
        'instagram_monitor.fetch.failed',
      );
      return;
    }

    if (posts.length === 0) {
      this.deps.store.markPollSuccess(acc.id, Date.now(), null);
      return;
    }

    // Posts arrive newest-first. Walk forward to collect everything strictly
    // newer than the dedup anchor.
    const newPostsNewestFirst: RecentPost[] = [];
    for (const p of posts) {
      if (acc.last_post_id !== null && p.igPostId === acc.last_post_id) break;
      newPostsNewestFirst.push(p);
    }

    const newestPostId = posts[0].igPostId;

    // First-ever poll: no anchor → don't backfill anything, just seed.
    if (acc.last_post_id === null) {
      log.info(
        { account: acc.username, seeded_to: newestPostId, posts: posts.length },
        'instagram_monitor.first_poll_seed',
      );
      this.deps.store.markPollSuccess(acc.id, Date.now(), newestPostId);
      return;
    }

    if (newPostsNewestFirst.length === 0) {
      this.deps.store.markPollSuccess(acc.id, Date.now(), newestPostId);
      return;
    }

    const boundChannels = this.deps.getBoundChannels();
    // No channels bound right now: still advance the anchor so a future
    // binding doesn't get this batch as backfill. Skip the per-post work.
    if (boundChannels.length === 0) {
      log.info(
        { account: acc.username, new_posts: newPostsNewestFirst.length, advanced_to: newestPostId },
        'instagram_monitor.no_bound_channels.advance_anchor',
      );
      this.deps.store.markPollSuccess(acc.id, Date.now(), newestPostId);
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

    this.deps.store.markPollSuccess(acc.id, Date.now(), newestPostId);
  }
}
