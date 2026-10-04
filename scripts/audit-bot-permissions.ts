/**
 * Read-only least-privilege audit: REST GETs only, no gateway or content reads.
 * npx tsx scripts/audit-bot-permissions.ts [--without <roleId>]
 * Prints IDs, effective permission bits and minimal bot-role allow-overwrites.
 * Settings come from production stores; nothing is written to Discord or SQLite.
 */
import "dotenv/config";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import {
   REST,
   Routes,
   PermissionFlagsBits as P,
   PermissionsBitField,
} from "discord.js";
import type {
   APIGuildChannel,
   APIGuildMember,
   APIRole,
   APIUser,
} from "discord.js";
import { config } from "../src/config.js";
import { CalendarStore } from "../src/capabilities/calendar/store.js";
import { WorkshopStore } from "../src/capabilities/workshop/store.js";
import { EventIntakeStore } from "../src/capabilities/event_intake/store.js";
import { FileScannerStore } from "../src/capabilities/file_scanner/store.js";
import { MinutasStore } from "../src/capabilities/minutas/store.js";
import {
   ModerationStore,
   MODERATION_GUILD_ID,
   LOG_CHANNEL_IDS,
} from "../src/moderation/store.js";

const args = process.argv.slice(2);
if (
   args.length &&
   (args.length !== 2 ||
      args[0] !== "--without" ||
      !/^\d{17,20}$/.test(args[1]))
)
   throw new Error("Uso: audit-bot-permissions.ts [--without <roleId>]");
const without = args[1] ?? null;
const guildId = MODERATION_GUILD_ID;
const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
const db = new Database(resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"), {
   readonly: true,
   fileMustExist: true,
});
try {
   const results = await Promise.allSettled([
      rest.get(Routes.user()),
      rest.get(Routes.guildRoles(guildId)),
      rest.get(Routes.guildChannels(guildId)),
   ]);
   for (const result of results)
      if (result.status === "rejected") throw result.reason;
   const [user, roles, channels] = results.map(
      (r) => (r as PromiseFulfilledResult<unknown>).value,
   ) as [APIUser, APIRole[], APIGuildChannel[]];
   const member = (await rest.get(
      Routes.guildMember(guildId, user.id),
   )) as APIGuildMember;
   if (without && !member.roles.includes(without))
      throw new Error("El bot no tiene ese rol.");
   const managed = roles.find((r) => r.tags?.bot_id === user.id);
   if (!managed) throw new Error("Rol administrado del bot no resuelto.");
   const retained = member.roles.filter((id) => id !== without);
   const base = (ids: string[]) =>
      roles
         .filter((r) => r.id === guildId || ids.includes(r.id))
         .reduce((bits, r) => bits | BigInt(r.permissions), 0n);
   const effective = (channel: APIGuildChannel, ids: string[]) => {
      let bits = base(ids);
      if (bits & P.Administrator) return PermissionsBitField.All;
      const overwrites = channel.permission_overwrites ?? [];
      const apply = (allow: bigint, deny: bigint) => {
         bits = (bits & ~deny) | allow;
      };
      const everyone = overwrites.find((o) => o.id === guildId && o.type === 0);
      if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny));
      const roleOverwrites = overwrites.filter(
         (o) => o.type === 0 && ids.includes(o.id),
      );
      apply(
         roleOverwrites.reduce((b, o) => b | BigInt(o.allow), 0n),
         roleOverwrites.reduce((b, o) => b | BigInt(o.deny), 0n),
      );
      const individual = overwrites.find(
         (o) => o.type === 1 && o.id === user.id,
      );
      if (individual) apply(BigInt(individual.allow), BigInt(individual.deny));
      return bits;
   };
   const names = (bits: bigint) =>
      Object.entries(P)
         .filter(([, bit]) => (bits & bit) !== 0n)
         .map(([name]) => name);
   const text = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
   const requirements = new Map<
      string,
      { bits: bigint; features: Set<string> }
   >();
   const need = (
      id: string | null | undefined,
      bits: bigint,
      feature: string,
   ) => {
      if (!id) return;
      const row = requirements.get(id) ?? {
         bits: 0n,
         features: new Set<string>(),
      };
      row.bits |= bits;
      row.features.add(feature);
      requirements.set(id, row);
   };
   const calendar = new CalendarStore(db),
      workshop = new WorkshopStore(db).getSettings(),
      intake = new EventIntakeStore(db),
      scanner = new FileScannerStore(db);
   const bindings = db
      .prepare("SELECT channel_id, capability_id FROM configuration_bindings")
      .all() as { channel_id: string; capability_id: string }[];
   const watched = scanner.getWatchedChannels(),
      media = scanner.getMediaChannels();
   // Preserve existing channel coverage. Forums use thread permissions; voice
   // channels also have a message surface. Logs are read-only assistant sources.
   for (const channel of channels) {
      if (channel.type === 4) continue;
      if (LOG_CHANNEL_IDS.has(channel.id))
         need(
            channel.id,
            P.ViewChannel | P.ReadMessageHistory,
            "moderation_evidence",
         );
      else if (channel.type === 15 || channel.type === 16)
         need(
            channel.id,
            text |
               P.SendMessagesInThreads |
               P.CreatePublicThreads |
               P.AddReactions,
            "general_chat_threads",
         );
      else
         need(
            channel.id,
            text | P.AddReactions | P.SendMessagesInThreads,
            "general_chat",
         );
      if (!watched.length || watched.includes(channel.id))
         need(
            channel.id,
            text | (channel.type === 15 ? P.SendMessagesInThreads : 0n),
            media.includes(channel.id) ? "file_scanner_media" : "file_scanner",
         );
      if (channel.type === 2 || channel.type === 13)
         need(
            channel.id,
            P.ViewChannel | P.Connect | P.Speak,
            "minutas_voice_stage",
         );
   }
   need(
      calendar.getOutputChannelId() ?? config.CALENDAR_OUTPUT_CHANNEL_ID,
      text | P.AttachFiles | P.EmbedLinks,
      "calendar_output",
   );
   need(
      calendar.getAnnounceChannelId() ?? config.CALENDAR_ANNOUNCE_CHANNEL_ID,
      text | P.EmbedLinks | P.MentionEveryone,
      "calendar_announce",
   );
   for (const binding of bindings)
      need(
         binding.channel_id,
         text |
            P.EmbedLinks |
            (binding.capability_id === "instagram_monitor"
               ? P.AttachFiles
               : 0n),
         binding.capability_id,
      );
   need(
      workshop.welcome_channel_id,
      // Discord split pinning out of ManageMessages: the welcome/session
      // panels are pinned, and that failure is swallowed at runtime.
      text | P.ManageMessages | P.PinMessages | P.AddReactions,
      "workshop_welcome",
   );
   need(
      workshop.category_id,
      text |
         P.ManageChannels |
         P.ManageRoles |
         P.ManageMessages |
         P.PinMessages |
         P.AttachFiles |
         P.EmbedLinks |
         P.AddReactions,
      "workshop_private_channels",
   );
   for (const id of intake.getWatchedCategories())
      need(id, text | P.EmbedLinks, "event_intake_tickets");
   need(
      intake.getAgitpropChannelId() ?? "1483639272413200606",
      text | P.AttachFiles | P.EmbedLinks,
      "event_intake_agitprop",
   );
   need(
      new MinutasStore(db).getOutputChannelId(),
      text | P.AttachFiles,
      "minutas_output",
   );
   need(
      new ModerationStore(db).settings(guildId).moderation_channel_id,
      text | P.ViewAuditLog | P.ManageMessages,
      "moderation_workspace",
   );
   const guildRequired =
      P.BanMembers |
      P.ModerateMembers |
      P.ManageMessages |
      P.ManageEvents |
      P.ManageChannels |
      P.ManageRoles |
      P.ViewAuditLog;
   const guildMissing = guildRequired & ~base(retained);
   const moderationRole = roles.find((r) => r.id === "1436055845392879778");
   console.log(
      JSON.stringify({
         guild_id: guildId,
         bot_id: user.id,
         managed_role_id: managed.id,
         without,
         administrator_now: !!(base(member.roles) & P.Administrator),
         administrator_after: !!(base(retained) & P.Administrator),
         guild_missing: names(guildMissing),
         moderation_role_missing: names(
            guildRequired & ~BigInt(moderationRole?.permissions ?? "0"),
         ),
      }),
   );
   let gaps = 0;
   const fixes = new Map<string, bigint>();
   for (const [id, requirement] of requirements) {
      const channel = channels.find((c) => c.id === id);
      if (!channel) {
         const external = (await rest
            .get(Routes.channel(id))
            .catch(() => null)) as APIGuildChannel | null;
         if (external?.guild_id && external.guild_id !== guildId) {
            console.log(
               JSON.stringify({
                  channel_id: id,
                  guild_id: external.guild_id,
                  status: "outside_audited_guild",
                  features: [...requirement.features],
               }),
            );
            continue;
         }
         gaps++;
         console.log(
            JSON.stringify({
               channel_id: id,
               error: "channel_not_resolved",
               features: [...requirement.features],
            }),
         );
         continue;
      }
      const now = effective(channel, member.roles),
         after = effective(channel, retained);
      // ViewChannel absence implicitly blocks all channel operations.
      const missing = requirement.bits & ~after;
      console.log(
         JSON.stringify({
            channel_id: id,
            current: now.toString(),
            projected: after.toString(),
            missing: names(missing),
            features: [...requirement.features],
         }),
      );
      if (!missing) continue;
      gaps++;
      const parent = channels.find((c) => c.id === channel.parent_id);
      const signature = (c: APIGuildChannel) =>
         JSON.stringify(
            [...(c.permission_overwrites ?? [])].sort((a, b) =>
               a.id.localeCompare(b.id),
            ),
         );
      const fixId =
         parent && signature(parent) === signature(channel)
            ? parent.id
            : channel.id;
      const memberDeny = channel.permission_overwrites?.find(
         (o) => o.id === user.id && o.type === 1,
      );
      if (memberDeny && BigInt(memberDeny.deny) & missing) {
         console.log(
            JSON.stringify({
               channel_id: id,
               fix: "remove_bot_member_deny_bits",
               deny_bits: (BigInt(memberDeny.deny) & missing).toString(),
            }),
         );
      } else fixes.set(fixId, (fixes.get(fixId) ?? 0n) | missing);
   }
   console.log(`\nLista para administración (guild ${guildId}):`);
   for (const [id, bits] of fixes)
      console.log(
         `- [ ] ${id}: permitir ${names(bits).join(", ")} (bits ${bits}) al rol ${managed.id}; conservar los otros bits.`,
      );
   if (without)
      console.log(
         `- [ ] Quitar ${without} del miembro ${user.id}; conservar 1436055845392879778.`,
      );
   console.log(
      JSON.stringify({
         channel_gaps: gaps,
         guild_gaps: names(guildMissing),
         fixes: fixes.size,
         note: "Private-thread membership is checked at runtime; this channel audit does not prove membership in private threads.",
      }),
   );
} finally {
   db.close();
}
