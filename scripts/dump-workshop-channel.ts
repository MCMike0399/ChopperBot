/**
 * Read-only dump of a workshop session channel's recent messages — triage aid.
 * Prints author, timestamp, attachments and (truncated) content, oldest first.
 *
 *   npx tsx scripts/dump-workshop-channel.ts <channelId> [limit]
 */
import { Client, GatewayIntentBits, ChannelType, Partials } from 'discord.js';
import { config } from '../src/config.js';

const channelId = process.argv[2];
const limit = Number(process.argv[3] ?? 60);
if (!channelId) {
  console.error('usage: npx tsx scripts/dump-workshop-channel.ts <channelId> [limit]');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message],
});

client.once('clientReady', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`channel ${channelId} is not a text channel`);
    }
    const batch = await channel.messages.fetch({ limit });
    const msgs = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of msgs) {
      const who = m.author?.bot ? 'BOT' : (m.author?.username ?? m.author?.id ?? '?');
      const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const atts = [...m.attachments.values()].map((a) => `📎${a.name}(${a.size}B)`).join(' ');
      const content = (m.content ?? '').replace(/\n/g, ' ⏎ ');
      const trimmed = content.length > 500 ? `${content.slice(0, 500)}…[${content.length} chars]` : content;
      console.log(`[${when}] ${who}: ${trimmed} ${atts}`);
    }
    console.log(`--- ${msgs.length} messages ---`);
  } catch (err) {
    console.error('FAILED:', err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

await client.login(config.DISCORD_TOKEN);
