import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import {
  InstagramMonitorStore,
  INSTAGRAM_MONITOR_MIGRATIONS,
  pollJitterMs,
  computeCadenceInterval,
  computeGovernorStretch,
  effectiveBaseIntervalMs,
  nextDueAtMs,
  CADENCE_MIN_INTERVAL_MS,
  CADENCE_MAX_INTERVAL_MS,
  CADENCE_INTERVAL_FACTOR,
  type MonitoredAccount,
} from '../store.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'instagram_monitor').migrate(
    'instagram_monitor',
    INSTAGRAM_MONITOR_MIGRATIONS,
  );
  return { store: new InstagramMonitorStore(mem.db()), mem };
}

describe('InstagramMonitorStore', () => {
  test('upsertAccount is idempotent on username', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U1' });
    const b = store.upsertAccount({ username: 'foo', added_by: 'U2' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.account.id).toBe(b.account.id);
    expect(b.account.added_by).toBe('U1');
    mem.close();
  });

  test('accounts are global: usernames are unique across the table', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U1' });
    store.upsertAccount({ username: 'bar', added_by: 'U1' });
    expect(store.listAccounts()).toHaveLength(2);
    expect(store.listAccounts().map((a) => a.username).sort()).toEqual(['bar', 'foo']);
    mem.close();
  });

  test('dueAccounts respects paused, last_polled_at, backoff', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'never_polled', added_by: 'U' });
    const a = store.upsertAccount({ username: 'fresh', added_by: 'U' });
    const b = store.upsertAccount({ username: 'stale', added_by: 'U' });
    const p = store.upsertAccount({ username: 'paused', added_by: 'U' });
    store.setPaused('paused', true);

    const now = 100_000_000;
    store.markPollSuccess(a.account.id, now - 5 * 60_000, 'A1'); // 5 min ago — not due
    store.markPollSuccess(b.account.id, now - 30 * 60_000, 'B1'); // 30 min ago — due
    store.markPollSuccess(p.account.id, now - 60 * 60_000, 'P1');

    const due = store.dueAccounts(now, 20 * 60_000, 10);
    const names = due.map((d) => d.username).sort();
    expect(names).toEqual(['never_polled', 'stale']);
    mem.close();
  });

  test('exponential backoff on consecutive_failures', async () => {
    const { store, mem } = await newStore();
    const r = store.upsertAccount({ username: 'x', added_by: 'U' });
    const now = 1_000_000_000;
    store.markPollFailure(r.account.id, now - 10 * 60_000); // 10 min ago
    // After 1 failure, next due = 10min + 20min*2^1 = 50min from poll. So not due at +10min.
    const dueWithBackoff = store.dueAccounts(now, 20 * 60_000, 10).map((d) => d.username);
    expect(dueWithBackoff).not.toContain('x');
    // 60 minutes after the failed poll, it should be due.
    const dueLater = store
      .dueAccounts(now + 60 * 60_000, 20 * 60_000, 10)
      .map((d) => d.username);
    expect(dueLater).toContain('x');
    mem.close();
  });

  test('pollJitterMs is bounded random and off-able', () => {
    const max = 600_000;
    const cycle = 1_700_000_000_000;
    // Bounded to [0, max).
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const j = pollJitterMs(1, cycle, max);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(max);
      samples.push(j);
    }
    // Random (not deterministic): 100 draws from a 600_000-wide range with
    // <2 unique values has astronomically low probability (~1e-300).
    expect(new Set(samples).size).toBeGreaterThan(1);
    // Disabled paths return 0 deterministically:
    // - max <= 0 (caller turned jitter off)
    // - last_polled_at == null (never-polled accounts skip jitter so their
    //   first poll fires immediately)
    expect(pollJitterMs(1, cycle, 0)).toBe(0);
    expect(pollJitterMs(1, null, max)).toBe(0);
  });

  test('dueAccounts: per-account jitter (sized to the interval) defers a just-due account', async () => {
    const { store, mem } = await newStore();
    const r = store.upsertAccount({ username: 'x', added_by: 'U' });
    const interval = 20 * 60_000;
    const now = 1_000_000_000;

    // Polled "now": dueAt = now + interval + jitter > now → never due, any draw.
    store.markPollSuccess(r.account.id, now, 'A');
    for (let i = 0; i < 30; i++) {
      expect(store.dueAccounts(now, interval, 10).map((a) => a.username)).not.toContain('x');
    }

    // Polled 2× the interval ago: the jitter ceiling is interval/2, so
    // dueAt ≤ now - interval/2 < now → always due, any draw.
    store.markPollSuccess(r.account.id, now - 2 * interval, 'A');
    for (let i = 0; i < 30; i++) {
      expect(store.dueAccounts(now, interval, 10).map((a) => a.username)).toContain('x');
    }

    // Polled exactly one interval ago: dueAt = now + jitter, jitter ∈ [0, interval/2).
    // Jitter is real → across many draws it's deferred (not always due).
    store.markPollSuccess(r.account.id, now - interval, 'A');
    let deferred = 0;
    for (let i = 0; i < 50; i++) {
      if (!store.dueAccounts(now, interval, 10).map((a) => a.username).includes('x')) deferred++;
    }
    expect(deferred).toBeGreaterThan(0);
    mem.close();
  });

  test('hasSeen + recordSeen + recentPushed are still per-channel for fan-out dedup', async () => {
    const { store, mem } = await newStore();
    expect(store.hasSeen('C', 'P1')).toBe(false);
    store.recordSeen({
      channel_id: 'C',
      ig_post_id: 'P1',
      account_username: 'foo',
      caption: 'cap',
      media_type: 'image',
      posted_at: 1,
      classification_json: null,
      pushed: true,
      discord_message_id: 'D1',
    });
    store.recordSeen({
      channel_id: 'C',
      ig_post_id: 'P2',
      account_username: 'foo',
      caption: 'cap2',
      media_type: 'image',
      posted_at: 2,
      classification_json: null,
      pushed: false,
      discord_message_id: null,
    });
    expect(store.hasSeen('C', 'P1')).toBe(true);
    expect(store.hasSeen('C', 'P2')).toBe(true);
    const pushed = store.recentPushed('C', 10);
    expect(pushed.map((p) => p.ig_post_id)).toEqual(['P1']);
    // A different channel sees neither — that's the no-backfill guarantee.
    expect(store.hasSeen('OTHER', 'P1')).toBe(false);
    expect(store.recentPushed('OTHER', 10)).toHaveLength(0);
    mem.close();
  });

  test('resetLastPost clears the dedup anchor', async () => {
    const { store, mem } = await newStore();
    const r = store.upsertAccount({ username: 'x', added_by: 'U' });
    store.markPollSuccess(r.account.id, 1, 'A1');
    expect(store.getAccount('x')?.last_post_id).toBe('A1');
    store.resetLastPost('x');
    const after = store.getAccount('x');
    expect(after?.last_post_id).toBeNull();
    expect(after?.last_polled_at).toBeNull();
    mem.close();
  });
});

describe('InstagramMonitorStore — global runtime / circuit breaker (v5)', () => {
  test('v5 migration seeds a single un-stopped runtime row', async () => {
    const { store, mem } = await newStore();
    const r = store.getRuntime();
    expect(r.global_stop).toBe(0);
    expect(store.isGlobalStopped()).toBe(false);
    mem.close();
  });

  test('tripGlobalStop engages the kill-switch and keeps the first reason', async () => {
    const { store, mem } = await newStore();
    store.tripGlobalStop('first reason', 1_000);
    store.tripGlobalStop('second reason', 2_000);
    const r = store.getRuntime();
    expect(store.isGlobalStopped()).toBe(true);
    expect(r.stop_reason).toBe('first reason');
    expect(r.stopped_at).toBe(1_000);
    mem.close();
  });

  test('clearGlobalStop is the only way back, and clears event windows', async () => {
    const { store, mem } = await newStore();
    store.tripGlobalStop('boom', 1_000);
    store.recordAuthEvent(1_000);
    store.clearGlobalStop();
    const r = store.getRuntime();
    expect(store.isGlobalStopped()).toBe(false);
    expect(r.stop_reason).toBeNull();
    expect(r.recent_auth_json).toBeNull();
    mem.close();
  });

  test('clearFailureBackoff does NOT clear the persistent global stop', async () => {
    // The whole point of the separate runtime table: a restart (which calls
    // clearFailureBackoff) must not silently un-stop a tripped breaker.
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollFailure(a.account.id, 1, { auth: true });
    store.tripGlobalStop('flagged', 1_000);
    store.clearFailureBackoff();
    expect(store.getAccount('foo')?.consecutive_auth_failures).toBe(0); // counters cleared
    expect(store.isGlobalStopped()).toBe(true); // breaker survives
    mem.close();
  });

  test('event windowing counts within the window and prunes older entries', async () => {
    const { store, mem } = await newStore();
    const base = 10_000_000_000;
    expect(store.record429Event(base)).toBe(1);
    expect(store.record429Event(base + 1_000)).toBe(2);
    // 7h later: the first two have aged out of the 6h window.
    const count = store.record429Event(base + 7 * 60 * 60 * 1000);
    expect(count).toBe(1);
    mem.close();
  });

  test('writeHeartbeat is readable via getRuntime', async () => {
    const { store, mem } = await newStore();
    store.writeHeartbeat({
      authCooldownUntil: 111,
      rateCooldownUntil: 222,
      budgetPauseUntil: 333,
      requests24h: 7,
      nowMs: 444,
    });
    const r = store.getRuntime();
    expect(r.auth_cooldown_until).toBe(111);
    expect(r.rate_cooldown_until).toBe(222);
    expect(r.budget_pause_until).toBe(333);
    expect(r.requests_24h).toBe(7);
    expect(r.heartbeat_at).toBe(444);
    mem.close();
  });
});

function acct(p: Partial<MonitoredAccount>): MonitoredAccount {
  return {
    id: 1,
    username: 'a',
    added_by: 'U',
    added_at: 0,
    paused: 0,
    last_polled_at: null,
    last_post_id: null,
    last_post_at: null,
    consecutive_failures: 0,
    consecutive_auth_failures: 0,
    poll_interval_ms: null,
    posts_per_day: null,
    cadence_updated_at: null,
    ...p,
  };
}

/** `count` post times, newest first, spaced `gapMs` apart. Span = (count-1)*gapMs
 * — keep it above CADENCE_MIN_SPAN_MS (3d) for the trust gate to pass. */
function gapSeries(newest: number, count: number, gapMs: number): number[] {
  return Array.from({ length: count }, (_, i) => newest - i * gapMs);
}

describe('adaptive cadence — computeCadenceInterval', () => {
  test('regular cadence → median gap × factor (in range)', () => {
    const newest = 2_000_000_000_000;
    const ts = gapSeries(newest, 14, 6 * HOUR); // every 6h, span 78h (> 3d)
    const { intervalMs, postsPerDay } = computeCadenceInterval(ts, newest);
    expect(intervalMs).toBe(6 * HOUR * CADENCE_INTERVAL_FACTOR); // 3h
    expect(postsPerDay).toBeCloseTo(4, 5);
  });

  test('too few samples → null (cold start)', () => {
    const newest = 2_000_000_000_000;
    const ts = [0, 1, 2, 3].map((i) => newest - i * 6 * HOUR); // only 4
    expect(computeCadenceInterval(ts, newest).intervalMs).toBeNull();
  });

  test('enough samples but span too short → null (burst guard)', () => {
    const newest = 2_000_000_000_000;
    const ts = [0, 15, 30, 45, 60].map((m) => newest - m * 60_000); // 5 posts in 1h
    expect(computeCadenceInterval(ts, newest).intervalMs).toBeNull();
  });

  test('median is robust to a burst + one huge gap, floored at MIN', () => {
    const newest = 2_000_000_000_000;
    const ts = [
      newest,
      newest - 1 * 60_000,
      newest - 2 * 60_000,
      newest - 3 * 60_000,
      newest - 4 * 60_000,
      newest - 30 * DAY,
    ];
    expect(computeCadenceInterval(ts, newest).intervalMs).toBe(CADENCE_MIN_INTERVAL_MS);
  });

  test('recency decay stretches a quieted account toward MAX', () => {
    const newest = 2_000_000_000_000;
    const ts = gapSeries(newest, 14, 6 * HOUR);
    // Evaluate 5 days after the last post (silence ≫ median gap).
    expect(computeCadenceInterval(ts, newest + 5 * DAY).intervalMs).toBe(CADENCE_MAX_INTERVAL_MS);
  });

  test('non-positive / degenerate inputs → null', () => {
    expect(computeCadenceInterval([], 0).intervalMs).toBeNull();
    const t = 1_000_000_000;
    // all identical → no positive gaps
    expect(computeCadenceInterval([t, t, t, t, t], t).intervalMs).toBeNull();
  });
});

describe('adaptive cadence — effectiveBaseIntervalMs / nextDueAtMs', () => {
  test('effective interval applies default + stretch, clamped to MAX', () => {
    expect(effectiveBaseIntervalMs({ poll_interval_ms: null }, 60 * 60_000, 1)).toBe(60 * 60_000);
    expect(effectiveBaseIntervalMs({ poll_interval_ms: null }, 60 * 60_000, 2)).toBe(120 * 60_000);
    expect(effectiveBaseIntervalMs({ poll_interval_ms: 3 * HOUR }, 60 * 60_000, 3)).toBe(
      CADENCE_MAX_INTERVAL_MS,
    );
    // invalid stretch falls back to 1
    expect(effectiveBaseIntervalMs({ poll_interval_ms: 2 * HOUR }, 60 * 60_000, 0)).toBe(2 * HOUR);
  });

  test('nextDueAtMs mirrors the due formula without jitter; null when never polled', () => {
    expect(nextDueAtMs(acct({ poll_interval_ms: 2 * HOUR, last_polled_at: null }), 60 * 60_000, 1)).toBeNull();
    expect(
      nextDueAtMs(acct({ poll_interval_ms: 2 * HOUR, last_polled_at: 1_000_000 }), 60 * 60_000, 1),
    ).toBe(1_000_000 + 2 * HOUR);
  });
});

describe('adaptive cadence — budget governor', () => {
  test('stretch keeps projected at/under the headroom ceiling; preserves ratio', () => {
    const accounts = [acct({ poll_interval_ms: HOUR }), acct({ poll_interval_ms: HOUR })];
    const { stretch, projected } = computeGovernorStretch(accounts, {
      callsPerPoll: 1,
      dailyRequestBudget: 10,
      defaultIntervalMs: HOUR,
      activeFraction: 1,
      headroom: 1,
    });
    expect(projected).toBeCloseTo(48, 5); // 2 × 24 polls/day × 1 call
    expect(stretch).toBeCloseTo(4.8, 5); // 48 / 10
  });

  test('disabled when budget ≤ 0; excludes paused / auth-blocked', () => {
    const accounts = [
      acct({ poll_interval_ms: HOUR, paused: 1 }),
      acct({ poll_interval_ms: HOUR, consecutive_auth_failures: 5 }),
    ];
    expect(
      computeGovernorStretch(accounts, {
        callsPerPoll: 1,
        dailyRequestBudget: 0,
        defaultIntervalMs: HOUR,
        activeFraction: 1,
        headroom: 1,
      }).stretch,
    ).toBe(1);
    expect(
      computeGovernorStretch(accounts, {
        callsPerPoll: 1,
        dailyRequestBudget: 10,
        defaultIntervalMs: HOUR,
        activeFraction: 1,
        headroom: 1,
      }).projected,
    ).toBe(0);
  });
});

describe('adaptive cadence — store integration', () => {
  test('v6/v7 columns default correctly (null cadence, stretch 1) + roundtrip', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const a = store.getAccount('foo')!;
    expect(a.poll_interval_ms).toBeNull();
    expect(a.posts_per_day).toBeNull();
    expect(a.cadence_updated_at).toBeNull();
    const rt = store.getRuntime();
    expect(rt.poll_stretch).toBe(1);
    expect(rt.last_digest_at).toBeNull();
    store.writePollStretch(2.5);
    store.writeLastDigestAt(999);
    expect(store.getRuntime().poll_stretch).toBe(2.5);
    expect(store.getRuntime().last_digest_at).toBe(999);
    mem.close();
  });

  test('recomputeCadence dedups per-channel posts (interval not halved) and caches it', async () => {
    const { store, mem } = await newStore();
    const r = store.upsertAccount({ username: 'foo', added_by: 'U' });
    const newest = 2_000_000_000_000;
    const postedAts = gapSeries(newest, 14, 6 * HOUR);
    postedAts.forEach((at, i) => {
      for (const ch of ['C1', 'C2']) {
        store.recordSeen({
          channel_id: ch,
          ig_post_id: `P${i}`,
          account_username: 'foo',
          caption: null,
          media_type: 'image',
          posted_at: at,
          classification_json: null,
          pushed: true,
          discord_message_id: null,
        });
      }
    });
    store.recomputeCadence(r.account.id, newest);
    const a = store.getAccount('foo')!;
    expect(a.poll_interval_ms).toBe(3 * HOUR); // deduped median 6h × 0.5
    expect(a.posts_per_day).toBeCloseTo(4, 5); // 4, not 8 — proves the GROUP BY dedup
    expect(a.cadence_updated_at).toBe(newest);
    mem.close();
  });

  test('dueAccounts uses the cached per-account interval', async () => {
    const { store, mem } = await newStore();
    const fast = store.upsertAccount({ username: 'fast', added_by: 'U' });
    const slow = store.upsertAccount({ username: 'slow', added_by: 'U' });
    const now = 1_000_000_000;
    mem
      .db()
      .prepare('UPDATE instagram_monitor_accounts SET poll_interval_ms = ? WHERE id = ?')
      .run(10 * 60_000, fast.account.id);
    store.markPollSuccess(fast.account.id, now - 20 * 60_000, 'A'); // 20m ago
    store.markPollSuccess(slow.account.id, now - 20 * 60_000, 'B'); // 20m ago
    // fast (10m interval, ≤5m jitter) is due; slow (60m default) is not.
    const due = store.dueAccounts(now, 60 * 60_000, 10).map((a) => a.username);
    expect(due).toContain('fast');
    expect(due).not.toContain('slow');
    mem.close();
  });

  test('recomputeAllCadence populates cadence + writes the governor stretch', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const newest = 2_000_000_000_000;
    gapSeries(newest, 14, 6 * HOUR).forEach((at, i) =>
        store.recordSeen({
          channel_id: 'C1',
          ig_post_id: `P${i}`,
          account_username: 'foo',
          caption: null,
          media_type: 'image',
          posted_at: at,
          classification_json: null,
          pushed: true,
          discord_message_id: null,
        }),
      );
    const res = store.recomputeAllCadence(newest, {
      callsPerPoll: 1.5,
      dailyRequestBudget: 120,
      defaultIntervalMs: 60 * 60_000,
      activeFraction: 0.73,
    });
    expect(res.swept).toBe(1);
    expect(store.getAccount('foo')!.poll_interval_ms).toBe(3 * HOUR);
    // one 3h-interval account ≈ 9 calls/day ≪ 96 ceiling → no stretch
    expect(res.stretch).toBe(1);
    expect(store.getRuntime().poll_stretch).toBe(1);
    mem.close();
  });
});
