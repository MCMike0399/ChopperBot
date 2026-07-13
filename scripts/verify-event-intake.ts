// Verify the event_intake proposal path against REAL live data, read-only:
//   1. fetch a real Ticket Tool form message,
//   2. run the detector + parser on it,
//   3. build the proposal prompt + a READ-ONLY calendar tool bundle over the
//      live DB and call real Bedrock to produce the proposal (conflict check
//      included).
// Posts NOTHING to Discord and creates NO calendar event. Spends a little
// Bedrock budget (like the other smoke scripts). Logs out cleanly.
//
//   npx tsx scripts/verify-event-intake.ts [channelId]
import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { parseTicketForm, isEventForm, extractRequesterId, type MessageLike } from '../src/capabilities/event_intake/parse.js';
import { renderProposalPrompt } from '../src/capabilities/event_intake/preamble.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { CalendarToolSource } from '../src/capabilities/calendar/source.js';
import { composeToolSources } from '../src/tools/source.js';
import { ask } from '../src/llm/client.js';

const CHANNEL_ID = process.argv[2] ?? '1526039206441386066';
const READ_TOOLS = ['calendar_search_events', 'calendar_list_upcoming', 'calendar_get_event'];

function toMessageLike(m: {
  author: { id: string; bot: boolean } | null;
  content: string;
  embeds: Array<{ description: string | null; fields: Array<{ name: string; value: string }> }>;
}): MessageLike {
  return {
    authorId: m.author?.id ?? null,
    authorBot: m.author?.bot ?? false,
    content: m.content ?? '',
    embeds: m.embeds.map((e) => ({ description: e.description, fields: e.fields })),
  };
}

async function main(): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((r) => (client.isReady() ? r() : client.once('ready', () => r())));

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased()) throw new Error(`channel ${CHANNEL_ID} not text-based`);
    const msgs = await channel.messages.fetch({ limit: 25 });

    const formMsg = [...msgs.values()].find((m) =>
      isEventForm(toMessageLike(m), config.EVENT_INTAKE_TICKET_BOT_ID),
    );
    if (!formMsg) {
      console.log('❌ No Ticket Tool form message detected in this channel.');
      return;
    }
    console.log(`✅ Detected form from ${formMsg.author?.tag} (${formMsg.author?.id})`);
    const parsed = parseTicketForm(toMessageLike(formMsg))!;
    const requesterId = extractRequesterId(formMsg.content ?? '', [
      config.EVENT_INTAKE_TICKET_BOT_ID,
      client.user!.id,
    ]);
    console.log('\n--- parsed form ---');
    console.log(JSON.stringify({ ...parsed, pairs: parsed.pairs.length }, null, 2));
    console.log('requesterId:', requesterId);

    // Read-only calendar bundle over the LIVE db (WAL → safe concurrent read).
    const here = dirname(fileURLToPath(import.meta.url));
    const dbPath = resolve(here, '..', config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
    const db = new Database(dbPath, { readonly: true });
    const source = new CalendarToolSource(new CalendarStore(db), 'verify', Date.now(), undefined, {
      include: READ_TOOLS,
      allowWrite: false,
    });

    console.log('\n--- generating proposal (real Bedrock, conflict-checks live calendar) ---\n');
    const proposal = await ask({
      system: renderProposalPrompt(new Date(), parsed, requesterId),
      messages: [{ role: 'user', content: 'Genera la propuesta para esta solicitud.' }],
      tools: composeToolSources([source]),
    });
    console.log(proposal);
    db.close();
  } finally {
    await client.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
