// One-off verification: drive the LLM-health alert end-to-end so the operator
// can confirm it lands in the admin channel without waiting for a real Kimi
// outage. Exercises the EXACT production path: LlmHealthMonitor with the same
// sendAdminAlert sink app.ts wires, fed a synthetic deterministic error and
// then a success (so both the failure alert and the recovery notice post).
//
// Run:  npx tsx scripts/verify-llm-alert.ts
//
// IMPORTANT: this connects a second session with the same bot token. Discord
// allows this (the running bot keeps its connection), but the verify script
// must `destroy()` cleanly to avoid leaving a ghost gateway connection.
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { sendAdminAlert } from '../src/discord/admin-alert.js';
import { LlmHealthMonitor } from '../src/llm/health.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

await client.login(config.DISCORD_TOKEN);
await new Promise<void>((resolve) => {
  if (client.isReady()) return resolve();
  client.once('ready', () => resolve());
});

console.log(`logged in as ${client.user?.tag}`);
console.log(`posting synthetic LLM alert to admin channel ${process.env.CHOPPERBOT_CONFIG_CHANNEL_ID}…`);

const sent: Promise<void>[] = [];
const monitor = new LlmHealthMonitor();
monitor.setSink((lines) => {
  const p = sendAdminAlert(client, lines, 'llm.alert.verify');
  sent.push(p);
  return p;
});

const syntheticError = Object.assign(
  new Error(
    '400 SYNTHETIC TEST (verify-llm-alert.ts) — not a real Kimi failure. If you can read this in the admin channel, the LLM-health alert works end to end.',
  ),
  { status: 400 },
);
monitor.reportFailure(syntheticError);
monitor.reportSuccess(); // also exercises the recovery notice

await Promise.all(sent);
console.log('alerts sent; disconnecting');
await client.destroy();
