import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { InstagramMonitorStore, INSTAGRAM_MONITOR_MIGRATIONS } from '../store.js';

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'instagram_monitor').migrate(
    'instagram_monitor',
    INSTAGRAM_MONITOR_MIGRATIONS,
  );
  return { store: new InstagramMonitorStore(mem.db()), mem };
}

describe('InstagramMonitorStore', () => {
  test('upsertAccount is idempotent on (channel, username)', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ channel_id: 'C1', username: 'foo', added_by: 'U1' });
    const b = store.upsertAccount({ channel_id: 'C1', username: 'foo', added_by: 'U2' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.account.id).toBe(b.account.id);
    expect(b.account.added_by).toBe('U1');
    mem.close();
  });

  test('channel isolation: same username on different channels is distinct', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ channel_id: 'C1', username: 'foo', added_by: 'U1' });
    store.upsertAccount({ channel_id: 'C2', username: 'foo', added_by: 'U1' });
    expect(store.listAccountsForChannel('C1')).toHaveLength(1);
    expect(store.listAccountsForChannel('C2')).toHaveLength(1);
    mem.close();
  });

  test('dueAccounts respects paused, last_polled_at, backoff', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ channel_id: 'C', username: 'never_polled', added_by: 'U' });
    const a = store.upsertAccount({ channel_id: 'C', username: 'fresh', added_by: 'U' });
    const b = store.upsertAccount({ channel_id: 'C', username: 'stale', added_by: 'U' });
    const p = store.upsertAccount({ channel_id: 'C', username: 'paused', added_by: 'U' });
    store.setPaused('C', 'paused', true);

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
    const r = store.upsertAccount({ channel_id: 'C', username: 'x', added_by: 'U' });
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

  test('hasSeen + recordSeen + recentPushed only returns pushed=1', async () => {
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
    mem.close();
  });

  test('resetLastPost clears the dedup anchor', async () => {
    const { store, mem } = await newStore();
    const r = store.upsertAccount({ channel_id: 'C', username: 'x', added_by: 'U' });
    store.markPollSuccess(r.account.id, 1, 'A1');
    expect(store.getAccount('C', 'x')?.last_post_id).toBe('A1');
    store.resetLastPost('C', 'x');
    const after = store.getAccount('C', 'x');
    expect(after?.last_post_id).toBeNull();
    expect(after?.last_polled_at).toBeNull();
    mem.close();
  });
});
