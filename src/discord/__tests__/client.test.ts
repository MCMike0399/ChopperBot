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
