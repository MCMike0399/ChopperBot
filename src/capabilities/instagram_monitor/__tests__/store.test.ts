import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import {
  InstagramMonitorStore,
  INSTAGRAM_MONITOR_MIGRATIONS,
  pollJitterMs,
} from '../store.js';

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

  test('dueAccounts: jitter can defer an account that would be due without it', async () => {
    const { store, mem } = await newStore();
    const r = store.upsertAccount({ username: 'x', added_by: 'U' });
    const interval = 20 * 60_000;
    const now = 1_000_000_000;
    // Polled exactly one interval ago: due when jitter is off (dueAt == now).
    store.markPollSuccess(r.account.id, now - interval, 'A');
    expect(store.dueAccounts(now, interval, 10, 0).map((a) => a.username)).toContain('x');
    // Polled "now": never due regardless of jitter (dueAt strictly in future).
    store.markPollSuccess(r.account.id, now, 'A');
    expect(store.dueAccounts(now, interval, 10, interval).map((a) => a.username)).not.toContain(
      'x',
    );
    // Polled beyond interval + max jitter: always due.
    store.markPollSuccess(r.account.id, now - interval - interval - 1, 'A');
    expect(store.dueAccounts(now, interval, 10, interval).map((a) => a.username)).toContain('x');
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
