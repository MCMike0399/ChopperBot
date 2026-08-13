/**
 * Delete a calendar event exactly the way the capability's own delete handler
 * does — remove the linked Discord scheduled event FIRST (the link lives on
 * the calendar row), then delete the row, then reconcile the output channel —
 * plus optionally delete one related bot message (e.g. a manual announcement
 * that referenced the event, which the ledger doesn't track).
 *
 *   npx tsx scripts/delete-calendar-event.ts <eventId>
 *   npx tsx scripts/delete-calendar-event.ts 33 --also-delete-message 1435843684628172953/1537579742650306661
 *   npx tsx scripts/delete-calendar-event.ts 33 --no-publish
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { CALENDAR_MIGRATIONS, CalendarStore } from '../src/capabilities/calendar/store.js';
import { OutputChannelPublisher } from '../src/capabilities/calendar/publisher.js';
import { createEventSyncer } from '../src/capabilities/calendar/discord-events.js';
import { formatInTimezone } from '../src/capabilities/calendar/time.js';

const args = process.argv.slice(2);
const NO_PUBLISH = args.includes('--no-publish');
const msgIdx = args.indexOf('--also-delete-message');
const msgArg = msgIdx >= 0 ? args[msgIdx + 1] : null;
const eventId = Number(args.find((a) => !a.startsWith('--') && a !== msgArg));

async function main(): Promise<void> {
  if (!Number.isInteger(eventId)) {
    console.error(
      'Uso: npx tsx scripts/delete-calendar-event.ts <eventId> [--also-delete-message <channelId>/<messageId>] [--no-publish]',
    );
    process.exit(1);
  }

  const dbPath = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const memory = new SqliteMemoryStore({ path: dbPath });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new CalendarStore(memory.db());

  const event = store.get(eventId);
  if (!event) {
    console.error(`No existe el evento #${eventId}.`);
    memory.close();
    process.exit(1);
  }
  console.log(`Eliminando #${event.id} ${event.title} (${formatInTimezone(event.start_at)}, recurrencia: ${event.recurrence_freq ?? 'no'})`);
  console.log(`  evento de Discord enlazado: ${event.discord_event_id ?? '(ninguno)'}`);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise<void>((res, rej) => {
    client.once('clientReady', () => res());
    client.once('error', rej);
    void client.login(config.DISCORD_TOKEN).catch(rej);
  });

  // The guild is derived from the output channel, exactly as the runtime does
  // with the channel the turn arrived in.
  const outputChannelId = store.getOutputChannelId() ?? config.CALENDAR_OUTPUT_CHANNEL_ID ?? null;
  const outChannel = outputChannelId ? await client.channels.fetch(outputChannelId).catch(() => null) : null;
  const guildId = outChannel && 'guildId' in outChannel ? (outChannel.guildId as string) : null;
  if (!guildId) {
    console.error('No pude resolver el servidor (canal de salida inaccesible).');
    await client.destroy();
    memory.close();
    process.exit(1);
  }

  // 1) Discord event first — the link lives on the row we're about to delete.
  if (event.discord_event_id) {
    const syncer = createEventSyncer({ client, guildId, store });
    const outcome = await syncer.remove(eventId);
    console.log(
      outcome.ok
        ? `  evento de Discord: ${outcome.action === 'deleted' ? 'eliminado ✅' : 'ya no existía'}`
        : `  ⚠️ no pude eliminar el evento de Discord: ${outcome.message}`,
    );
  }

  // 2) The row (overrides go with it, per store.delete).
  store.delete(eventId);
  console.log('  fila del calendario: eliminada ✅');

  // 3) A related message (manual announcement), if given.
  if (msgArg) {
    const [channelId, messageId] = msgArg.split('/');
    try {
      const ch = await client.channels.fetch(channelId!);
      if (ch && ch.isTextBased()) {
        await (ch as { messages: { delete(id: string): Promise<unknown> } }).messages.delete(messageId!);
        console.log(`  mensaje ${messageId}: eliminado ✅`);
      }
    } catch (err) {
      console.log(`  ⚠️ no pude eliminar el mensaje ${messageId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 4) Republish the board + ICS.
  if (NO_PUBLISH) {
    console.log('--no-publish: tarjetas/ICS NO republicados.');
  } else {
    const publisher = new OutputChannelPublisher({
      client,
      store,
      projectRoot: process.cwd(),
      getOutputChannelId: () => store.getOutputChannelId() ?? config.CALENDAR_OUTPUT_CHANNEL_ID ?? null,
    });
    const summary = await publisher.reconcile();
    console.log(
      `Republicación: ${summary.ok ? `ok — publicados [${summary.posted.join(', ')}]` : `FALLÓ: ${summary.error}`}` +
        (summary.removed.length > 0 ? `, retirados [${summary.removed.join(', ')}]` : ''),
    );
  }

  await client.destroy();
  memory.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
