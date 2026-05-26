import { describe, test, expect, beforeEach, vi } from 'vitest';

const originalEnv = { ...process.env };

describe('getAuthorizedChannelIds', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test('parses valid DISCORD_AUTHORIZED_CHANNELS JSON', async () => {
    process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
      { guildId: '12345678901234567890', guildName: 'Test Server', channels: ['11111111111111111111', '22222222222222222222'] },
      { guildId: '98765432109876543210', channels: ['33333333333333333333'] },
    ]);
    delete process.env.DISCORD_CHANNEL_ID;

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const channels = getAuthorizedChannelIds();

    expect(channels.size).toBe(3);
    expect(channels.has('11111111111111111111')).toBe(true);
    expect(channels.has('22222222222222222222')).toBe(true);
    expect(channels.has('33333333333333333333')).toBe(true);
  });

  test('falls back to legacy DISCORD_CHANNEL_ID when DISCORD_AUTHORIZED_CHANNELS is absent', async () => {
    delete process.env.DISCORD_AUTHORIZED_CHANNELS;
    process.env.DISCORD_CHANNEL_ID = '44444444444444444444';

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const channels = getAuthorizedChannelIds();

    expect(channels.size).toBe(1);
    expect(channels.has('44444444444444444444')).toBe(true);
  });

  test('returns empty Set when neither config is present', async () => {
    delete process.env.DISCORD_AUTHORIZED_CHANNELS;
    delete process.env.DISCORD_CHANNEL_ID;

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const channels = getAuthorizedChannelIds();

    expect(channels.size).toBe(0);
  });

  test('throws on invalid JSON', async () => {
    process.env.DISCORD_AUTHORIZED_CHANNELS = 'not valid json';
    delete process.env.DISCORD_CHANNEL_ID;

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();

    expect(() => getAuthorizedChannelIds()).toThrow();
  });

  test('throws on invalid schema (missing channels)', async () => {
    process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
      { guildName: 'Test Server' },
    ]);
    delete process.env.DISCORD_CHANNEL_ID;

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();

    expect(() => getAuthorizedChannelIds()).toThrow();
  });

  test('parses config without guildId (optional)', async () => {
    process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
      { channels: ['11111111111111111111', '22222222222222222222'] },
    ]);
    delete process.env.DISCORD_CHANNEL_ID;

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const channels = getAuthorizedChannelIds();

    expect(channels.size).toBe(2);
  });

  test('throws on invalid channel ID format', async () => {
    process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
      { guildId: '12345678901234567890', channels: ['invalid'] },
    ]);
    delete process.env.DISCORD_CHANNEL_ID;

    const { getAuthorizedChannelIds, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();

    expect(() => getAuthorizedChannelIds()).toThrow();
  });
});

describe('getChannelCapabilityMap', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test('priority 1: DISCORD_CHANNEL_CAPABILITIES wins when present', async () => {
    process.env.DISCORD_CHANNEL_CAPABILITIES = JSON.stringify([
      {
        guildId: '11111111111111111111',
        channels: [
          { id: '22222222222222222222', capability: 'instagram_monitor' },
          { id: '33333333333333333333', capability: 'calendar' },
        ],
      },
    ]);
    // Even if the legacy var is set, the new one wins.
    process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
      { channels: ['44444444444444444444'] },
    ]);
    delete process.env.DISCORD_CHANNEL_ID;

    const { getChannelCapabilityMap, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const map = getChannelCapabilityMap();

    expect(map.size).toBe(2);
    expect(map.get('22222222222222222222')).toBe('instagram_monitor');
    expect(map.get('33333333333333333333')).toBe('calendar');
    expect(map.has('44444444444444444444')).toBe(false);
  });

  test('priority 2: legacy DISCORD_AUTHORIZED_CHANNELS routes all to DEFAULT_CAPABILITY', async () => {
    delete process.env.DISCORD_CHANNEL_CAPABILITIES;
    process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
      { channels: ['11111111111111111111', '22222222222222222222'] },
    ]);
    process.env.DEFAULT_CAPABILITY = 'instagram_monitor';
    delete process.env.DISCORD_CHANNEL_ID;

    const { getChannelCapabilityMap, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const map = getChannelCapabilityMap();

    expect(map.size).toBe(2);
    expect(map.get('11111111111111111111')).toBe('instagram_monitor');
    expect(map.get('22222222222222222222')).toBe('instagram_monitor');
  });

  test('priority 3: legacy DISCORD_CHANNEL_ID routes single channel to DEFAULT_CAPABILITY', async () => {
    delete process.env.DISCORD_CHANNEL_CAPABILITIES;
    delete process.env.DISCORD_AUTHORIZED_CHANNELS;
    process.env.DISCORD_CHANNEL_ID = '44444444444444444444';
    process.env.DEFAULT_CAPABILITY = 'instagram_monitor';

    const { getChannelCapabilityMap, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();
    const map = getChannelCapabilityMap();

    expect(map.size).toBe(1);
    expect(map.get('44444444444444444444')).toBe('instagram_monitor');
  });

  test('throws on duplicate channel id across guilds in DISCORD_CHANNEL_CAPABILITIES', async () => {
    process.env.DISCORD_CHANNEL_CAPABILITIES = JSON.stringify([
      { channels: [{ id: '22222222222222222222', capability: 'instagram_monitor' }] },
      { channels: [{ id: '22222222222222222222', capability: 'calendar' }] },
    ]);
    delete process.env.DISCORD_CHANNEL_ID;

    const { getChannelCapabilityMap, _resetChannelCache } = await import('../config.js');
    _resetChannelCache();

    expect(() => getChannelCapabilityMap()).toThrow(/appears more than once/);
  });
});
