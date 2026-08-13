/**
 * Drive one of the calendar's REAL tool handlers from the command line — same
 * validations, same occurrence-override semantics, same republish and
 * Discord-event propagation a mod's chat message would get. Use this for
 * surgical fixes (e.g. "tonight's Club de cine is Persepolis at 9pm") when
 * driving the bot through Discord isn't practical.
 *
 *   npx tsx scripts/calendar-tool.ts <toolName> '<json payload>' [--sync-discord]
 *
 * e.g.:
 *   npx tsx scripts/calendar-tool.ts calendar_update_event '{"id":12,"description":null}'
 *   npx tsx scripts/calendar-tool.ts calendar_set_session_theme \
 *     '{"id":12,"occurrence_date_iso":"2026-08-13","title":"Club de cine: Persepolis"}' --sync-discord
 *
 * The payload is exactly the tool input. `--sync-discord` runs
 * `calendar_sync_discord_event` for the same id after the update (create/link
 * the Discord scheduled event for the next occurrence).
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { CALENDAR_MIGRATIONS, CalendarStore } from '../src/capabilities/calendar/store.js';
import { OutputChannelPublisher } from '../src/capabilities/calendar/publisher.js';
import { CalendarToolSource } from '../src/capabilities/calendar/source.js';
import { createEventSyncer } from '../src/capabilities/calendar/discord-events.js';

const args = process.argv.slice(2);
const SYNC = args.includes('--sync-discord');
const positional = args.filter((a) => !a.startsWith('--'));
const [toolName, jsonArg] = positional;

async function main(): Promise<void> {
  if (!toolName || !jsonArg) {
    console.error('Uso: npx tsx scripts/calendar-tool.ts <toolName> \'<json payload>\' [--sync-discord]');
    process.exit(1);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonArg) as Record<string, unknown>;
  } catch {
    console.error('El payload no es JSON válido.');
    process.exit(1);
  }
  const id = Number(payload.id ?? payload.event_id);
  if (!Number.isInteger(id)) {
    console.error('El payload necesita un "id" (o "event_id") numérico.');
    process.exit(1);
  }

  const dbPath = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const memory = new SqliteMemoryStore({ path: dbPath });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new CalendarStore(memory.db());
  if (!store.get(id)) {
    console.error(`No existe el evento #${id}.`);
    memory.close();
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise<void>((res, rej) => {
    client.once('clientReady', () => res());
    client.once('error', rej);
    void client.login(config.DISCORD_TOKEN).catch(rej);
  });

  const outputChannelId = store.getOutputChannelId() ?? config.CALENDAR_OUTPUT_CHANNEL_ID ?? null;
  const outChannel = outputChannelId ? await client.channels.fetch(outputChannelId).catch(() => null) : null;
  const guildId = outChannel && 'guildId' in outChannel ? (outChannel.guildId as string) : null;
  if (!guildId) {
    console.error('No pude resolver el servidor (canal de salida inaccesible).');
    await client.destroy();
    memory.close();
    process.exit(1);
  }

  const publisher = new OutputChannelPublisher({
    client,
    store,
    projectRoot: process.cwd(),
    getOutputChannelId: () => outputChannelId,
  });
  const source = new CalendarToolSource(store, 'script', Date.now(), publisher, {
    syncer: createEventSyncer({ client, guildId, store }),
    // The image-URL allowlist exists so a MODEL can't fetch invented URLs; here
    // the operator is the authority, so a payload image_url is pre-allowed.
    allowedImageUrls: typeof payload.image_url === 'string' ? [payload.image_url] : [],
  });

  // A payload with only an id means "no calendar edit — just the --sync-discord".
  const onlyId = Object.keys(payload).every((k) => k === 'id' || k === 'event_id');
  if (!onlyId) {
    const result = await source.handle(toolName, payload);
    console.log(JSON.stringify(result.payload ?? result, null, 2));
    if (result.status !== 'success') {
      await client.destroy();
      memory.close();
      process.exit(1);
    }
  }

  if (SYNC) {
    const synced = await source.handle('calendar_sync_discord_event', { event_id: id });
    console.log('--- calendar_sync_discord_event ---');
    console.log(JSON.stringify(synced.payload ?? synced, null, 2));
  }

  await client.destroy();
  memory.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
