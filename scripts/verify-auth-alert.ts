// One-off verification: drive the IG-auth-expired alert end-to-end so the
// operator can confirm it actually lands in the admin channel without having
// to wait for a real auth failure (or worse, deliberately corrupting cookies).
//
// Hits the EXACT same code path as the scheduler does on InstagramAuthError:
// `postAuthExpiredAlert(client, account, reason)`. Logs in as the bot, sends
// the alert, then disconnects.
//
// Run:  tsx scripts/verify-auth-alert.ts
//
// IMPORTANT: this connects a second session with the same bot token. Discord
// allows this (the running bot keeps its connection), but the verify script
// must `destroy()` cleanly to avoid leaving a ghost gateway connection.
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { postAuthExpiredAlert } from '../src/capabilities/instagram_monitor/capability.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

await client.login(config.DISCORD_TOKEN);
await new Promise<void>((resolve) => {
  if (client.isReady()) return resolve();
  client.once('ready', () => resolve());
});

console.log(`logged in as ${client.user?.tag}`);
console.log(`posting test alert to admin channel ${process.env.CHOPPERBOT_CONFIG_CHANNEL_ID}…`);

await postAuthExpiredAlert(
  client,
  'TEST_ACCOUNT (verify-auth-alert.ts)',
  'Synthetic test — drove the alert helper directly. Not a real IG auth failure. If you can read this in the admin channel, the auth-expired alert mechanism works end to end.',
);

console.log('alert sent; disconnecting');
await client.destroy();
