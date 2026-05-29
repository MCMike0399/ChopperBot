// Read-only verification: list the most recent messages in the admin/config
// channel, so the operator can confirm IG auth alerts (organic and test) landed
// without scrolling Discord. Logs out cleanly afterwards.
// Run:  tsx scripts/verify-admin-channel-recent.ts [limit]
import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';

const limit = Math.max(1, Math.min(20, parseInt(process.argv[2] ?? '5', 10)));
const channelId = process.env.CHOPPERBOT_CONFIG_CHANNEL_ID;
if (!channelId) throw new Error('CHOPPERBOT_CONFIG_CHANNEL_ID not set');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

await client.login(config.DISCORD_TOKEN);
await new Promise<void>((resolve) => {
  if (client.isReady()) return resolve();
  client.once('ready', () => resolve());
});

const channel = await client.channels.fetch(channelId);
if (!channel || channel.type !== ChannelType.GuildText) {
  console.error(`channel ${channelId} not a guild text channel`);
  await client.destroy();
  process.exit(1);
}

const msgs = await channel.messages.fetch({ limit });
const ordered = Array.from(msgs.values()).sort(
  (a, b) => a.createdTimestamp - b.createdTimestamp,
);
console.log(`last ${ordered.length} messages in #${channel.name}:\n`);
for (const m of ordered) {
  const when = new Date(m.createdTimestamp).toISOString();
  const author = m.author.bot ? `${m.author.username}(bot)` : m.author.username;
  const firstLine = m.content.split('\n')[0];
  console.log(`[${when}] ${author}: ${firstLine}`);
  if (m.content.includes('Instagram monitor') || m.content.includes('TEST_ACCOUNT')) {
    // Print the full body for auth-related messages so they're verifiable
    const rest = m.content.split('\n').slice(1).join('\n');
    if (rest.trim()) console.log(rest);
    console.log('---');
  }
}

await client.destroy();
