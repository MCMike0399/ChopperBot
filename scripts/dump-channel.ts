/**
 * Read-only dump of a channel's recent messages (author, time, text, attachments,
 * embeds summary) for triage. Prints oldest → newest.
 *
 *   npx tsx scripts/dump-channel.ts <channelId> [limit]
 */
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';

const [channelId, limitArg] = process.argv.slice(2);
const limit = Math.min(Number(limitArg) || 50, 100);

async function main(): Promise<void> {
  if (!channelId) {
    console.error('Uso: npx tsx scripts/dump-channel.ts <channelId> [limit]');
    process.exit(1);
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await new Promise<void>((res, rej) => {
    client.once('clientReady', () => res());
    client.once('error', rej);
    void client.login(config.DISCORD_TOKEN).catch(rej);
  });
  const ch = await client.channels.fetch(channelId);
  if (!ch || !ch.isTextBased() || !('messages' in ch)) {
    console.error('Canal no accesible o no es de texto.');
    await client.destroy();
    process.exit(1);
  }
  console.log(`# ${'name' in ch ? ch.name : channelId} — últimos ${limit} mensajes\n`);
  const msgs = await (ch as {
    messages: { fetch(o: { limit: number }): Promise<Map<string, unknown>> };
  }).messages.fetch({ limit });
  const sorted = [...msgs.values()].sort((a, b) => {
    const ma = a as { id: string };
    const mb = b as { id: string };
    return BigInt(ma.id) < BigInt(mb.id) ? -1 : 1;
  });
  for (const raw of sorted) {
    const m = raw as {
      id: string;
      createdAt: Date;
      author?: { id: string; username: string; bot?: boolean } | null;
      content: string;
      attachments: { size: number; values(): Iterable<unknown> };
      embeds: Array<{ description?: string | null; fields?: Array<{ name: string; value: string }> }>;
    };
    const t = m.createdAt.toISOString().slice(5, 16).replace('T', ' ');
    const who = `${m.author?.username ?? '?'}${m.author?.bot ? ' [bot]' : ''}`;
    console.log(`--- ${t}Z ${who} (${m.id})`);
    if (m.content) console.log(m.content);
    for (const a of m.attachments.values()) {
      const att = a as { url: string; name?: string };
      console.log(`[adjunto: ${att.name ?? '?'}] ${att.url}`);
    }
    for (const e of m.embeds) {
      if (e.description) console.log(`[embed] ${e.description.slice(0, 500)}`);
      for (const f of e.fields ?? []) console.log(`[campo] ${f.name}: ${f.value.slice(0, 200)}`);
    }
  }
  await client.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
