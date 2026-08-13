import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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

describe('boot validation (LLM text backend + AWS credential pair)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockExit() {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  }

  test('LLM_TEXT_BACKEND=bedrock boots with NO KIMI_API_KEY', async () => {
    delete process.env.KIMI_API_KEY;
    process.env.LLM_TEXT_BACKEND = 'bedrock';

    const { config } = await import('../config.js');
    expect(config.LLM_TEXT_BACKEND).toBe('bedrock');
    expect(config.KIMI_API_KEY).toBeUndefined();
  });

  test('default kimi backend exits when KIMI_API_KEY is missing', async () => {
    delete process.env.KIMI_API_KEY;
    delete process.env.LLM_TEXT_BACKEND;
    mockExit();

    await expect(import('../config.js')).rejects.toThrow('exit:1');
  });

  test('ACCESS_KEY_ID without SECRET_ACCESS_KEY exits (both-or-neither)', async () => {
    process.env.ACCESS_KEY_ID = 'solo-key';
    delete process.env.SECRET_ACCESS_KEY;
    mockExit();

    await expect(import('../config.js')).rejects.toThrow('exit:1');
  });

  test('both AWS keys unset boots (default credential chain mode)', async () => {
    delete process.env.ACCESS_KEY_ID;
    delete process.env.SECRET_ACCESS_KEY;

    const { config } = await import('../config.js');
    expect(config.ACCESS_KEY_ID).toBeUndefined();
    expect(config.SECRET_ACCESS_KEY).toBeUndefined();
  });

  // The 2026-08-23 Kimi→DeepSeek cutover is meant to be ONE env var. These pin
  // that: selecting deepseek must repoint key/url/model together, and must fail
  // loudly rather than silently falling back to the Kimi endpoint with the
  // wrong credentials.
  test('LLM_TEXT_BACKEND=deepseek resolves textBackend to the DeepSeek endpoint', async () => {
    process.env.LLM_TEXT_BACKEND = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-test';
    delete process.env.DEEP_SEEK_API_KEY;

    const { textBackend } = await import('../config.js');
    expect(textBackend.provider).toBe('deepseek');
    expect(textBackend.apiKey).toBe('sk-deepseek-test');
    expect(textBackend.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(textBackend.modelId).toBe('deepseek-v4-flash');
    // ONE model for every text tier — no second, pricier id. V4-Pro measured
    // identical to Flash on the tool battery while being slower and 3.1×.
    expect(textBackend.supportsThinkingSwitch).toBe(true);
  });

  test('DEEP_SEEK_API_KEY is accepted as an alias (the spelling already in .env)', async () => {
    process.env.LLM_TEXT_BACKEND = 'deepseek';
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEP_SEEK_API_KEY = 'sk-alias-test';

    const { textBackend } = await import('../config.js');
    expect(textBackend.apiKey).toBe('sk-alias-test');
  });

  test('LLM_TEXT_BACKEND=deepseek exits when neither key spelling is set', async () => {
    process.env.LLM_TEXT_BACKEND = 'deepseek';
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEP_SEEK_API_KEY;
    mockExit();

    await expect(import('../config.js')).rejects.toThrow('exit:1');
  });

  test('default kimi backend leaves textBackend on the Kimi endpoint', async () => {
    delete process.env.LLM_TEXT_BACKEND;
    process.env.KIMI_API_KEY = 'sk-kimi-test';

    // Mirror the KIMI_ vars rather than the schema defaults: vitest.setup.ts
    // pre-fills KIMI_MODEL_ID, so asserting the literal default would pin the
    // test harness instead of the resolver.
    const { config, textBackend } = await import('../config.js');
    expect(textBackend.provider).toBe('kimi');
    expect(textBackend.apiKey).toBe('sk-kimi-test');
    expect(textBackend.baseUrl).toBe(config.KIMI_BASE_URL);
    expect(textBackend.modelId).toBe(config.KIMI_MODEL_ID);
    // Moonshot 400s on unexpected params (it already does for `temperature`),
    // so the DeepSeek-only `thinking` switch must never be sent there.
    expect(textBackend.supportsThinkingSwitch).toBe(false);
  });
});
