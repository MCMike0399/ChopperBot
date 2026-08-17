// Deliver a real flyer image into an existing event-intake ticket:
//   inspect DB + Discord → delete leftover [VERIFY-flyer] 1×1 posts →
//   upload the image in Agitprop → fulfill (mirror + Discord cover) → re-inspect.
//
//   npx tsx scripts/deliver-event-intake-flyer.ts <ticketChannelId> <imagePath> [--inspect-only]
import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
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
import { listImageAttachments } from '../src/attachments/resolver.js';

const TAG = '[VERIFY-flyer]';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const INSPECT_ONLY = process.argv.includes('--inspect-only');
const TICKET_CHANNEL = args[0];
const IMAGE_PATH = args[1];

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

function summarizeAttachment(m: Message): string {
  const images = listImageAttachments(m);
  if (images.length === 0) {
    const names = [...m.attachments.values()].map((a) => `${a.name}:${a.size}b`).join(', ');
    return names ? `non-image[${names}]` : 'no-attachment';
  }
  return images
    .map((img) => `${img.name ?? '?'} ${img.contentType ?? ''} ${img.url.slice(0, 80)}…`)
    .join(' | ');
}

async function dumpChannel(label: string, ch: TextChannel, limit: number): Promise<Message[]> {
  const msgs = [...(await ch.messages.fetch({ limit })).values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );
  console.log(`\n--- ${label} (last ${msgs.length}) ---`);
  for (const m of msgs) {
    const att = summarizeAttachment(m);
    const text = (m.content || '').replace(/\n/g, ' ⏎ ').slice(0, 160);
    console.log(`  ${m.id} <@${m.author.id}> ${m.author.bot ? 'bot' : 'user'} att=${att} | ${text}`);
  }
  return msgs;
}

async function main(): Promise<void> {
  if (!TICKET_CHANNEL) {
    fail('usage: npx tsx scripts/deliver-event-intake-flyer.ts <ticketChannelId> <imagePath> [--inspect-only]');
  }
  if (!INSPECT_ONLY && !IMAGE_PATH) {
    fail('image path required unless --inspect-only');
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const dbPath = resolve(here, '..', config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const db = new Database(dbPath);
  const store = new EventIntakeStore(db);
  const calendarStore = new CalendarStore(db);

  const ticket = store.getTicket(TICKET_CHANNEL);
  if (!ticket) fail(`no ticket row for ${TICKET_CHANNEL}`);
  const parsed = EventIntakeStore.parseForm(ticket);
  if (!parsed) fail('could not parse stored form');

  console.log('=== DB ticket ===');
  console.log({
    title: parsed.title,
    status: ticket.status,
    created_event_id: ticket.created_event_id,
    flyer_status: ticket.flyer_status,
    flyer_notes: ticket.flyer_notes,
    flyer_request_message_id: ticket.flyer_request_message_id,
    flyer_image_channel_id: ticket.flyer_image_channel_id,
    flyer_image_message_id: ticket.flyer_image_message_id,
  });

  const created = ticket.created_event_id ? calendarStore.get(ticket.created_event_id) : null;
  console.log('=== DB calendar (created + siblings sharing discord_event_id) ===');
  const siblings = created?.discord_event_id
    ? calendarStore.listAll().filter((e) => e.discord_event_id === created.discord_event_id)
    : created
      ? [created]
      : [];
  for (const e of siblings) {
    console.log({
      id: e.id,
      title: e.title,
      start_at: new Date(e.start_at).toISOString(),
      discord_event_id: e.discord_event_id,
      flyer_channel_id: e.flyer_channel_id,
      flyer_image_message_id: e.flyer_image_message_id,
    });
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((r) => (client.isReady() ? r() : client.once('ready', () => r())));

  const agitpropId = store.getAgitpropChannelId() ?? DEFAULT_AGITPROP_CHANNEL_ID;
  const ticketCh = await fetchText(client, TICKET_CHANNEL);
  const agitprop = await fetchText(client, agitpropId);

  const ticketMsgs = await dumpChannel(`ticket #${TICKET_CHANNEL}`, ticketCh, 20);
  await dumpChannel(`agitprop #${agitpropId}`, agitprop, 15);

  if (created?.discord_event_id && ticket.guild_id) {
    const guild = await client.guilds.fetch(ticket.guild_id);
    const ev = await guild.scheduledEvents.fetch(created.discord_event_id).catch(() => null);
    console.log('\n=== Discord scheduled event ===');
    console.log({
      id: created.discord_event_id,
      name: ev?.name ?? null,
      status: ev?.status ?? null,
      image: ev?.coverImageURL({ size: 1024 }) ?? null,
      url: ev ? `https://discord.com/events/${ticket.guild_id}/${ev.id}` : null,
    });
  }

  if (INSPECT_ONLY) {
    client.destroy();
    db.close();
    return;
  }

  const st = statSync(IMAGE_PATH);
  if (st.size < 10_000) fail(`image looks too small (${st.size} bytes) — refusing to post a stub`);
  const buf = readFileSync(IMAGE_PATH);
  const filename = basename(IMAGE_PATH).toLowerCase().endsWith('.png')
    ? 'flyer.jpg'
    : basename(IMAGE_PATH);
  console.log(`\n=== Delivering ${IMAGE_PATH} (${st.size} bytes as ${filename}) ===`);

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
    // Remove the 1×1 verify posts so they don't look like "the flyer".
    const toSweep = [...ticketMsgs, ...(await agitprop.messages.fetch({ limit: 20 })).values()];
    for (const m of toSweep) {
      const isVerify =
        m.content.includes(TAG) ||
        [...m.attachments.values()].some((a) => (a.name ?? '').includes('verify-flyer'));
      if (!isVerify) continue;
      await m.delete().catch(() => {});
      ok(`deleted leftover verify message ${m.id}`);
    }

    let card: Message | null = null;
    if (ticket.flyer_request_message_id) {
      card = await agitprop.messages.fetch(ticket.flyer_request_message_id).catch(() => null);
    }

    const posted = card
      ? await card.reply({
          files: [new AttachmentBuilder(buf, { name: filename })],
        })
      : await agitprop.send({
          files: [new AttachmentBuilder(buf, { name: filename })],
        });
    const imageMsg = (await posted.fetch()) as Message;
    const imgs = listImageAttachments(imageMsg);
    if (imgs.length === 0) fail('uploaded file was not detected as an image');
    ok(`uploaded flyer in Agitprop (${imgs[0]!.name}, ${imgs[0]!.contentType})`);

    if (ticket.flyer_status !== 'requested' && ticket.flyer_request_message_id) {
      store.markFlyerRequested(TICKET_CHANNEL, ticket.flyer_request_message_id, ticket.flyer_notes);
    }

    const fulfilled = await flyerService.fulfillFlyer(TICKET_CHANNEL, imageMsg, 'agitprop');
    if (!fulfilled) fail('fulfillFlyer returned false');
    store.setFlyerNotes(TICKET_CHANNEL, null);
    ok('fulfillFlyer succeeded (mirror + cover)');

    const after = store.getTicket(TICKET_CHANNEL)!;
    if (after.flyer_status !== 'delivered') fail(`expected delivered, got ${after.flyer_status}`);
    if (after.flyer_image_message_id !== imageMsg.id) {
      fail(`pointer mismatch: db=${after.flyer_image_message_id} posted=${imageMsg.id}`);
    }
    ok(`DB pointer → ${after.flyer_image_channel_id}/${after.flyer_image_message_id}`);

    const recentTicket = await ticketCh.messages.fetch({ limit: 8 });
    const mirror = [...recentTicket.values()].find(
      (m) => m.content.includes('Flyer del evento') && listImageAttachments(m).length > 0,
    );
    if (!mirror) fail('no mirrored flyer with an image in the ticket');
    const mirrored = listImageAttachments(mirror)[0]!;
    ok(`ticket mirror ${mirror.id} (${mirrored.name}, ${mirrored.contentType})`);

    if (created?.discord_event_id && ticket.guild_id) {
      const guild = await client.guilds.fetch(ticket.guild_id);
      const ev = await guild.scheduledEvents.fetch(created.discord_event_id).catch(() => null);
      const cover = ev?.coverImageURL({ size: 1024 }) ?? null;
      if (!cover) fail('Discord scheduled event still has no cover image');
      ok(`Discord event cover set: ${cover.slice(0, 80)}…`);
    }

    console.log('\n🎨 Real flyer delivered and verified.');
  } finally {
    client.destroy();
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
