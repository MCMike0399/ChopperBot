/**
 * Read-only live diagnosis of the workshop capability's Discord-side setup:
 * settings, welcome message presence, and the bot's permissions in the welcome
 * channel and the sessions category. Posts nothing, creates nothing.
 *
 *   npx tsx scripts/verify-workshop.ts
 */
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

const db = new Database('data/chopperbot.db', { readonly: true });
const settings = db
  .prepare('SELECT * FROM workshop_settings WHERE id = 1')
  .get() as Record<string, unknown> | undefined;
const sessions = db
  .prepare(`SELECT COUNT(*) AS n FROM workshop_sessions WHERE status = 'active'`)
  .get() as { n: number };
db.close();

console.log('── settings (DB) ──');
console.log(settings);
console.log('active sessions:', sessions.n);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const NEEDED_WELCOME = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['AddReactions', PermissionFlagsBits.AddReactions],
  ['ManageMessages (quitar reacciones ajenas)', PermissionFlagsBits.ManageMessages],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
] as const;
const NEEDED_CATEGORY = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['ManageChannels (crear/eliminar canales)', PermissionFlagsBits.ManageChannels],
  ['ManageRoles (fijar permisos privados)', PermissionFlagsBits.ManageRoles],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['AttachFiles', PermissionFlagsBits.AttachFiles],
] as const;

client.once('clientReady', async () => {
  try {
    const welcomeId = String(settings?.welcome_channel_id ?? '');
    const categoryId = String(settings?.category_id ?? '');

    const welcome = welcomeId ? await client.channels.fetch(welcomeId).catch(() => null) : null;
    const category = categoryId ? await client.channels.fetch(categoryId).catch(() => null) : null;

    if (welcome && welcome.type === ChannelType.GuildText) {
      const me = welcome.guild.members.me!;
      console.log(`\n── permisos en #${welcome.name} (bienvenida) ──`);
      for (const [label, bit] of NEEDED_WELCOME) {
        console.log(`${welcome.permissionsFor(me).has(bit) ? '✅' : '❌'} ${label}`);
      }
      const msgId = String(settings?.welcome_message_id ?? '');
      const msg = msgId ? await welcome.messages.fetch(msgId).catch(() => null) : null;
      console.log(
        msg
          ? `✅ mensaje de bienvenida presente (${msgId}), reacciones: ${[...msg.reactions.cache.values()].map((r) => `${r.emoji.name}×${r.count}`).join(' ')}`
          : `❌ mensaje de bienvenida NO encontrado (${msgId || 'sin id'})`,
      );
    } else {
      console.log(`❌ canal de bienvenida inaccesible: ${welcomeId || '(no configurado)'}`);
    }

    if (category && category.type === ChannelType.GuildCategory) {
      const me = category.guild.members.me!;
      console.log(`\n── permisos en categoría "${category.name}" (sesiones) ──`);
      for (const [label, bit] of NEEDED_CATEGORY) {
        console.log(`${category.permissionsFor(me).has(bit) ? '✅' : '❌'} ${label}`);
      }
    } else {
      console.log(`❌ categoría inaccesible: ${categoryId || '(no configurada)'}`);
    }
  } finally {
    await client.destroy();
  }
});

await client.login(config.DISCORD_TOKEN);
