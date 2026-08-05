// Verify the ticket mod-ping against the REAL live guild, read-only:
//   1. resolve the approver roles of the ticket guild and report which ones the
//      bot can actually NOTIFY (mentionable, or MentionEveryone) — the silent
//      ones are the whole failure mode this feature has to avoid,
//   2. show the exact text appended to a proposal,
//   3. drive the REAL model with the ticket-conversation prompt on a "no le sé
//      al flyer, ¿me ayudan?" turn and check it emits the mention verbatim.
// Posts NOTHING to Discord and creates NO calendar event. Spends a little Kimi
// budget on step 3 (skip it with --no-model).
//
//   npx tsx scripts/verify-event-intake-mentions.ts [guildId]
import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { config } from '../src/config.js';
import { EventIntakeStore } from '../src/capabilities/event_intake/store.js';
import { appendModPing, DEFAULT_MOD_ROLES, resolveModMentions } from '../src/discord/mod-roles.js';
import { renderTicketConversationPrompt } from '../src/capabilities/event_intake/preamble.js';
import { ask } from '../src/llm/client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUILD_ID = process.argv.find((a) => /^\d{17,20}$/.test(a)) ?? '1435843683541979248';
const RUN_MODEL = !process.argv.includes('--no-model');

async function main(): Promise<void> {
  const db = new Database(resolve(ROOT, config.CHOPPERBOT_DATA_DIR, 'chopperbot.db'), {
    readonly: true,
  });
  const tokens = new EventIntakeStore(db).getModRoles();
  console.log(
    `Approver tokens: ${tokens.length > 0 ? tokens.join(', ') : `(none configured → defaults: ${DEFAULT_MOD_ROLES.join(', ')})`}`,
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((r) => (client.isReady() ? r() : client.once('clientReady', () => r())));

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const roles = await guild.roles.fetch();
    const me = await guild.members.fetchMe();
    const canMentionAny = me.permissions.has(PermissionFlagsBits.MentionEveryone);
    console.log(`Guild: ${guild.name} — bot MentionEveryone: ${canMentionAny ? 'yes' : 'no'}`);

    const mentions = resolveModMentions(
      roles.map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
      tokens,
      { canMentionAny },
    );

    console.log('\n— Approver roles present in this guild —');
    for (const r of mentions.matched) {
      const ok = mentions.notifyIds.includes(r.id);
      console.log(`  ${ok ? '🔔' : '🔕'} ${r.name} (${r.id})${ok ? '' : '  ← mention would NOT notify'}`);
    }
    const missing = (tokens.length > 0 ? tokens : [...DEFAULT_MOD_ROLES]).filter(
      (t) => /^\d{17,20}$/.test(t) && !roles.has(t),
    );
    if (missing.length > 0) console.log(`  ⚠️  configured but absent from the guild: ${missing.join(', ')}`);

    if (mentions.notifies) {
      console.log(`\n✅ Proposals will notify: ${mentions.text}`);
    } else if (mentions.matched.length > 0) {
      console.log(
        `\n❌ NO approver role can be notified. Mark one mentionable (role settings → "Allow anyone to @mention this role") or grant the bot "Mention @everyone, @here and all roles".`,
      );
    } else {
      console.log('\n❌ No approver role resolved at all — check `config_eventintake action:status`.');
    }

    console.log('\n— Tail appended to every proposal —');
    console.log(appendModPing('«…texto de la propuesta…»', mentions));
    console.log('\n— Tail appended when a mod approves (exempt from the cooldown) —');
    console.log(appendModPing('«…confirmación del evento creado…»', mentions, 'created'));

    if (!RUN_MODEL) return;

    console.log('\n— Real model turn: requester asks for flyer help (the case from the live test) —');
    const system = renderTicketConversationPrompt({
      now: new Date(),
      parsed: {
        title: 'Conversatorio: Los DataCenters y su impacto en el ambiente y la sociedad',
        dayRaw: 'martes 11 de agosto',
        timeRaw: '8pm',
        speaker: 'Burbuja',
        flyerSelf: false,
        pairs: [],
      },
      requesterId: '187289179871248384',
      isMod: false,
      modMention: mentions.notifies ? mentions.text : '',
    });
    const reply = await ask({
      system,
      messages: [{ role: 'user', content: 'ah fah pued pedirle a lxs mods que me ayuden con el flyer no le sé a eso' }],
      tools: { tools: [], handle: async () => ({ status: 'error', payload: {} }) },
    });
    console.log(`\n${reply}\n`);
    const pinged = mentions.notifyIds.filter((id) => reply.includes(`<@&${id}>`));
    console.log(
      pinged.length > 0
        ? `✅ the reply pings ${pinged.length} approver role(s) — mods get notified`
        : '~ the reply did not ping the mods (model variance; the proposal ping is deterministic either way)',
    );
  } finally {
    await client.destroy();
    db.close();
  }
}

void main();
