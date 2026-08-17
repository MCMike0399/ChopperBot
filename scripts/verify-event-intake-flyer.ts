// Live proof for the Agitprop flyer subsystem.
//
// MUST be given an explicit ticket id. Refuses tickets that already have a
// created calendar event, so a 1×1 PNG cannot land on a live community flyer.
//
//   npx tsx scripts/verify-event-intake-flyer.ts <ticketChannelId> [--dry-run]
import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import { config } from '../src/config.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { EventIntakeStore } from '../src/capabilities/event_intake/store.js';
import { FlyerService } from '../src/capabilities/event_intake/flyer-service.js';
import { DEFAULT_AGITPROP_CHANNEL_ID } from '../src/capabilities/event_intake/constants.js';
import { resolveAgitpropMentionsInGuild } from '../src/capabilities/event_intake/roles.js';
import { createEventSyncer } from '../src/capabilities/calendar/discord-events.js';
import { formatInTimezone } from '../src/capabilities/calendar/time.js';

const TAG = '[VERIFY-flyer]';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY_RUN = process.argv.includes('--dry-run');
const TICKET_CHANNEL = args[0];
if (!TICKET_CHANNEL) {
  fail('usage: npx tsx scripts/verify-event-intake-flyer.ts <ticketChannelId> [--dry-run]');
}

/** Smallest valid PNG (1×1 transparent pixel). */
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`✅ ${msg}`);
}

async function fetchText(client: Client, id: string): Promise<TextChannel> {
  const ch = await client.channels.fetch(id);
  if (!ch?.isTextBased() || ch.isDMBased()) fail(`channel ${id} not text-based`);
  return ch as TextChannel;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dbPath = resolve(here, '..', config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const db = new Database(dbPath);
  const store = new EventIntakeStore(db);
  const calendarStore = new CalendarStore(db);

  const ticket = store.getTicket(TICKET_CHANNEL);
  if (!ticket) fail(`no ticket row for ${TICKET_CHANNEL}`);
  const parsed = EventIntakeStore.parseForm(ticket);
  if (!parsed) fail('could not parse stored form');
  if (parsed.flyerSelf !== false) {
    fail(`ticket ${TICKET_CHANNEL} has flyerSelf=${String(parsed.flyerSelf)} — pick a flyerSelf=false ticket`);
  }
  if (ticket.status === 'created' || ticket.created_event_id) {
    fail(
      `refusing ticket ${TICKET_CHANNEL}: it already has a live calendar event ` +
        `(status=${ticket.status}, event=${ticket.created_event_id}). ` +
        'Use a proposed/unused ticket so a 1×1 PNG cannot replace a real flyer.',
    );
  }
  if (ticket.flyer_status === 'requested') {
    fail(`ticket already has an open flyer job — cancel it first or pick another channel`);
  }
  if (ticket.flyer_status === 'delivered') {
    fail(`ticket already has a delivered flyer — pick another channel`);
  }

  const agitpropId = store.getAgitpropChannelId() ?? DEFAULT_AGITPROP_CHANNEL_ID;
  console.log(`Ticket: ${TICKET_CHANNEL} («${parsed.title}»)`);
  console.log(`Agitprop channel: ${agitpropId}`);
  if (DRY_RUN) {
    console.log('Dry run — would open → fulfill → cancel. Exiting.');
    db.close();
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((r) => (client.isReady() ? r() : client.once('ready', () => r())));

  const flyerService = new FlyerService({
    client,
    store,
    calendarStore,
    getAgitpropChannelId: () => agitpropId,
    resolveAgitpropMentions: (ch) =>
      resolveAgitpropMentionsInGuild(ch.guild, ch, store.getAgitpropRoles()),
    makeSyncer: (guildId) =>
      createEventSyncer({
        client,
        guildId,
        store: calendarStore,
        now: () => Date.now(),
        formatLocal: formatInTimezone,
      }),
  });

  try {
    // ── 1. Open job ─────────────────────────────────────────────────────
    console.log('\n--- 1. openFlyerJob ---');
    const opened = await flyerService.openFlyerJob({
      ticketChannelId: TICKET_CHANNEL,
      guildId: ticket.guild_id ?? client.guilds.cache.first()?.id ?? '',
      parsed,
      requesterId: ticket.requester_id,
      notes: `${TAG} prueba automática — ignorar`,
    });
    if (!opened) fail('openFlyerJob returned false');

    const afterOpen = store.getTicket(TICKET_CHANNEL)!;
    if (afterOpen.flyer_status !== 'requested') fail(`expected flyer_status=requested, got ${afterOpen.flyer_status}`);
    ok(`DB flyer_status=requested (card id ${afterOpen.flyer_request_message_id})`);

    const agitprop = await fetchText(client, agitpropId);
    const cardMsg = await agitprop.messages.fetch(afterOpen.flyer_request_message_id!);
    if (!cardMsg.content.includes('Solicitud de flyer')) fail('Agitprop card missing expected text');
    ok('Agitprop request card posted');

    const ticketCh = await fetchText(client, TICKET_CHANNEL);
    const recentTicket = await ticketCh.messages.fetch({ limit: 8 });
    const notice = [...recentTicket.values()].find((m) => m.content.includes('Comisión de Agitprop'));
    if (!notice) fail('ticket notice about Agitprop not found');
    ok('Ticket notice posted');

    // ── 2. Fulfill via image reply ──────────────────────────────────────
    console.log('\n--- 2. fulfillFlyer (image reply) ---');
    const imagePost = await cardMsg.reply({
      content: TAG,
      files: [new AttachmentBuilder(TINY_PNG, { name: 'verify-flyer.png' })],
    });
    // Re-fetch so attachments are populated for listImageAttachments.
    const imageMsg = (await imagePost.fetch()) as Message;
    const fulfilled = await flyerService.fulfillFlyer(TICKET_CHANNEL, imageMsg, 'agitprop');
    if (!fulfilled) fail('fulfillFlyer returned false');

    const afterFulfill = store.getTicket(TICKET_CHANNEL)!;
    if (afterFulfill.flyer_status !== 'delivered') {
      fail(`expected flyer_status=delivered, got ${afterFulfill.flyer_status}`);
    }
    if (!afterFulfill.flyer_image_message_id) fail('flyer_image_message_id not set');
    ok(`DB flyer_status=delivered (image msg ${afterFulfill.flyer_image_message_id})`);

    const cardAfter = await agitprop.messages.fetch(afterOpen.flyer_request_message_id!);
    if (!cardAfter.content.includes('Flyer entregado')) fail('Agitprop card not marked delivered');
    ok('Agitprop card edited to delivered');

    const recentAfter = await ticketCh.messages.fetch({ limit: 10 });
    const mirror = [...recentAfter.values()].find((m) => m.content.includes('Flyer del evento'));
    if (!mirror) fail('mirrored flyer not found in ticket');
    ok('Flyer mirrored to ticket');

    // ── 3. Cleanup — delivered jobs stay delivered (cancel only works while open)
    console.log('\n--- 3. cleanup ---');
    const finalRow = store.getTicket(TICKET_CHANNEL)!;
    if (finalRow.flyer_status === 'delivered') {
      ok('Flyer delivered — job correctly stays delivered (cancel only applies while requested)');
    } else {
      await flyerService.cancelFlyerJob(TICKET_CHANNEL, 'ticket');
      if (store.getTicket(TICKET_CHANNEL)!.flyer_status !== 'cancelled') {
        fail('cleanup: expected flyer_status=cancelled');
      }
      ok('Flyer job cancelled');
    }

    console.log('\n🎨 All flyer live checks passed.');
  } finally {
    client.destroy();
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
