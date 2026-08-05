/**
 * Preview (and optionally send) the daily same-day event announcement, against
 * the LIVE database and the LIVE Discord guild.
 *
 * Read-only by default: it logs in, resolves today's events to their Discord
 * scheduled events exactly as the runtime watcher does, drives the real model to
 * write the announcement, and prints the message it WOULD post — posting nothing
 * and recording nothing. A reconcile in the wrong channel is embarrassing; an
 * @everyone in the wrong channel is worse, so previewing is the default.
 *
 *   npx tsx scripts/verify-calendar-announce.ts              # preview today
 *   npx tsx scripts/verify-calendar-announce.ts --post       # actually announce
 *   npx tsx scripts/verify-calendar-announce.ts --post --repost   # ignore the ledger
 *
 * It also prints the permission diagnosis, which is usually the real answer to
 * "why is there no link in the announcement": the bot can only see Discord
 * events whose channel it can view unless it holds "Gestionar eventos".
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { CALENDAR_MIGRATIONS, CalendarStore } from '../src/capabilities/calendar/store.js';
import { CalendarAnnouncer } from '../src/capabilities/calendar/announcer.js';
import { resolveAnnounceSettings } from '../src/capabilities/calendar/announce-settings.js';
import { diagnoseEventAccess, fetchScheduledEvents } from '../src/capabilities/calendar/discord-events.js';
import { formatInTimezone } from '../src/capabilities/calendar/time.js';

const POST = process.argv.includes('--post');
const REPOST = process.argv.includes('--repost');
/** Ignore the 10:00 gate — the point of a preview is not waiting for it. */
const FORCE = true;

async function main(): Promise<void> {
  const dbPath = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const memory = new SqliteMemoryStore({ path: dbPath });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new CalendarStore(memory.db());

  const settings = resolveAnnounceSettings(store);
  const announceChannelId = settings.channelId;
  console.log('=== Anuncio diario de eventos ===');
  console.log(`hora local ahora      : ${formatInTimezone(Date.now())}`);
  console.log(`canal de anuncios     : ${announceChannelId ?? '(sin configurar)'}`);
  console.log(`hora de anuncio        : ${settings.hour}:00 (America/Mexico_City)`);
  console.log(`menciones              : ${JSON.stringify(settings.mentions)}`);
  console.log(`modo                   : ${POST ? (REPOST ? 'PUBLICAR (re-anunciando)' : 'PUBLICAR') : 'PREVIEW (no publica)'}`);
  if (!announceChannelId) {
    console.log('\nNada que hacer: configura el canal con `config_calendar action:set_announce_channel`.');
    memory.close();
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise<void>((res, rej) => {
    client.once('clientReady', () => res());
    client.once('error', rej);
    void client.login(config.DISCORD_TOKEN).catch(rej);
  });
  console.log(`\nconectado como         : ${client.user?.tag}`);

  const channel = await client.channels.fetch(announceChannelId).catch(() => null);
  const guildId = channel && 'guildId' in channel ? (channel.guildId as string | null) : null;
  console.log(`canal                  : ${channel && 'name' in channel ? `#${channel.name}` : '(no accesible)'}`);
  if (!guildId) {
    console.log('El canal de anuncios no es de un servidor accesible — abortando.');
    await client.destroy();
    memory.close();
    return;
  }

  // ── Permissions: usually the real reason a link is missing ────────────────
  const diag = await diagnoseEventAccess(client, guildId);
  console.log('\n--- Permisos de eventos de Discord ---');
  console.log(`puede CREAR eventos    : ${diag.canManageEvents ? '✅ sí' : '❌ no (falta "Gestionar eventos")'}`);
  if (diag.hiddenEventChannels.length > 0) {
    console.log(
      `canales de voz ocultos : ${diag.hiddenEventChannels.length} → ${diag.hiddenEventChannels
        .map((c) => c.name)
        .join(', ')}`,
    );
    console.log('   (los eventos que viven en esos canales NO aparecen en mi lista)');
  }
  for (const p of diag.problems) console.log(`   ⚠️  ${p.replace(/\*\*/g, '')}`);

  const events = await fetchScheduledEvents(client, guildId);
  console.log(`\n--- Eventos de Discord visibles (${events?.length ?? 'error'}) ---`);
  for (const e of events ?? []) {
    console.log(`  ${e.id}  ${formatInTimezone(e.startAtMs)}  ${e.recurring ? '🔁' : '  '}  ${e.name}`);
  }

  // ── The announcement itself, through the exact runtime code path ──────────
  const announcer = new CalendarAnnouncer({
    client,
    store,
    getAnnounceChannelId: () => announceChannelId,
    getAnnounceMentions: () => settings.mentions,
    getModRoles: () => [],
    // A preview must not page the mods; a real --post run may.
    getManagementChannelId: () => null,
    getAnnounceHour: () => settings.hour,
  });

  const report = await announcer.run({ force: FORCE, dryRun: !POST, ignoreLedger: REPOST || !POST });
  console.log('\n--- Eventos de HOY ---');
  if (report.announced.length === 0) {
    console.log(`  (ninguno) razón: ${report.reason ?? 'sin eventos hoy'}`);
  }
  for (const a of report.announced) {
    console.log(`\n#${a.eventId} ${a.title}`);
    console.log(`  cuándo        : ${a.startAtLocal}`);
    console.log(`  evento Discord: ${a.discordEventId ?? '(ninguno)'} [${a.link}]`);
    if (a.discordEventUrl) console.log(`  enlace        : ${a.discordEventUrl}`);
    console.log(`  publicado     : ${a.posted ? `✅ ${a.messageId}` : POST ? `❌ ${a.error ?? 'no'}` : '— (preview)'}`);
    console.log('  ──── mensaje ────');
    console.log(
      a.text
        .split('\n')
        .map((l) => `  │ ${l}`)
        .join('\n'),
    );
  }

  if (report.nudged.length > 0) {
    console.log('\n--- Sin evento de Discord (hoy/mañana) ---');
    for (const n of report.nudged) console.log(`  #${n.eventId} ${n.title} — ${n.startAtLocal}`);
    console.log('  → en producción esto avisa a lxs mods en el canal de gestión del calendario.');
  }

  await client.destroy();
  memory.close();
  console.log(`\n${POST ? 'Listo (publicado).' : 'Listo (nada publicado).'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
