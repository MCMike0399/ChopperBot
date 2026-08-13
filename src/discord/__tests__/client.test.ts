import { describe, test, expect, beforeEach, vi } from 'vitest';
import { GatewayIntentBits } from 'discord.js';

const originalEnv = { ...process.env };

describe('createClient — conditional MessageContent intent', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test('requests MessageContent by default', async () => {
    delete process.env.DISCORD_MESSAGE_CONTENT_INTENT;
    const { createClient } = await import('../client.js');
    const client = createClient();
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
    await client.destroy();
  });

  test("omits MessageContent when DISCORD_MESSAGE_CONTENT_INTENT=false (app lacks the Dev-Portal toggle)", async () => {
    process.env.DISCORD_MESSAGE_CONTENT_INTENT = 'false';
    const { createClient } = await import('../client.js');
    const client = createClient();
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    await client.destroy();
  });
});

/**
 * The bot-wide mention policy. Without an explicit default, discord.js omits
 * `allowed_mentions` and Discord parses EVERY mention class in whatever the
 * model wrote — and the bot now holds Administrator, so every role is pingable.
 * This is the code gate behind a rule that used to live only in prompt text.
 */
describe('createClient — mention policy', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test('defaults to users-only: @everyone/@here and role pings are denied bot-wide', async () => {
    const { createClient } = await import('../client.js');
    const client = createClient();
    const allowed = client.options.allowedMentions;
    expect(allowed).toBeDefined();
    expect(allowed?.parse).toEqual(['users']);
    expect(allowed?.parse).not.toContain('everyone');
    expect(allowed?.parse).not.toContain('roles');
    // The reply ping is normal bot behavior and must survive the lockdown.
    expect(allowed?.repliedUser).toBe(true);
    await client.destroy();
  });
});
