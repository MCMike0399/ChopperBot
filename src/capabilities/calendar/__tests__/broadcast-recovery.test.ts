import { describe, test, expect, vi } from 'vitest';
import { createBroadcaster } from '../broadcast-channels.js';

vi.mock('../../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const target = { id: 'channel', name: 'anuncios', kind: 'text' as const };
function setup(channel: any) {
  const fetch = vi.fn().mockResolvedValue(channel);
  const client = { user: { id: 'BOT' }, channels: { fetch } };
  return { broadcaster: createBroadcaster({ client: client as any, guildId: 'GUILD' }), fetch };
}

describe('fresh Discord delivery receipt checks', () => {
  test('bypasses stale channel/message caches', async () => {
    const messageFetch = vi.fn().mockResolvedValue({ id: 'receipt' });
    const { broadcaster, fetch } = setup({ guildId: 'GUILD', isTextBased: () => true, messages: { fetch: messageFetch } });
    expect(await broadcaster.checkReceipt!(target, 'receipt')).toBe('present');
    expect(fetch).toHaveBeenCalledWith('channel', { force: true });
    expect(messageFetch).toHaveBeenCalledWith({ message: 'receipt', cache: false, force: true });
  });
  test.each([[10008, 'deleted'], [10003, 'deleted'], [50013, 'unknown'], [50001, 'unknown'], ['timeout', 'unknown']])('Discord error %s means %s', async (code, expected) => {
    const { broadcaster } = setup({ guildId: 'GUILD', isTextBased: () => true, messages: { fetch: vi.fn().mockRejectedValue({ code }) } });
    expect(await broadcaster.checkReceipt!(target, 'receipt')).toBe(expected);
  });
  test('a forum receipt is its thread, including an archived thread', async () => {
    const { broadcaster, fetch } = setup({ guildId: 'GUILD', parentId: target.id, archived: true });
    expect(await broadcaster.checkReceipt!({ ...target, kind: 'forum' }, 'thread')).toBe('present');
    expect(fetch).toHaveBeenCalledWith('thread', { force: true });
  });
  test('a missing or cross-guild channel cannot prove deletion', async () => {
    for (const channel of [null, { guildId: 'OTHER' }]) {
      const { broadcaster } = setup(channel);
      expect(await broadcaster.checkReceipt!(target, 'receipt')).toBe('unknown');
    }
  });
});

describe('forum intentional repost and pre-send recovery', () => {
  const input = { target: { ...target, kind: 'forum' as const }, content: 'Synthetic proof', mentions: { everyone: false, roleIds: [] }, imageUrl: null, threadTitle: 'Session', token: 'new-draft' };
  test('an explicit repost creates a new thread despite an existing matching title', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'new-thread' });
    const fetchActive = vi.fn().mockResolvedValue({ threads: new Map([['old', { id: 'old', name: 'Session', ownerId: 'BOT' }]]) });
    const { broadcaster } = setup({ threads: { create, fetchActive } });
    expect(await broadcaster.post({ ...input, repost: true })).toEqual({ ok: true, messageId: 'new-thread' });
    expect(create).toHaveBeenCalledTimes(1);
  });
  test('a human-owned matching title cannot silently block a new bot announcement', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'new-thread' });
    const { broadcaster } = setup({ threads: { create, fetchActive: async () => ({ threads: new Map([['human', { id: 'human', name: 'Session', ownerId: 'HUMAN' }]]) }) } });
    expect(await broadcaster.post(input)).toEqual({ ok: true, messageId: 'new-thread' });
  });
  test('ordinary retries still adopt our existing matching forum post', async () => {
    const create = vi.fn();
    const { broadcaster } = setup({ threads: { create, fetchActive: async () => ({ threads: new Map([['old', { id: 'old', name: 'Session', ownerId: 'BOT' }]]) }) } });
    expect(await broadcaster.post(input)).toEqual({ ok: true, messageId: 'old' });
    expect(create).not.toHaveBeenCalled();
  });
  test.each([[403, true], [500, false], [undefined, false]])('HTTP %s has retrySafe=%s', async (status, retrySafe) => {
    const { broadcaster } = setup({ isTextBased: () => true, messages: { fetch: async () => new Map() }, send: async () => { throw Object.assign(new Error('rejected'), { status }); } });
    expect(await broadcaster.post({ ...input, target })).toMatchObject({ ok: false, retrySafe });
  });
});
