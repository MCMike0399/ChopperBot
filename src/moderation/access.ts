import {
   PermissionFlagsBits as P,
   type Client,
   type GuildBasedChannel,
} from "discord.js";
import type Database from "better-sqlite3";
import { isModTurn } from "../capabilities/mod-authority.js";
import { verifyAudienceContainment } from "../discord/audience.js";
import {
   ModerationStore,
   DEFAULT_MODERATION_CHANNEL_ID,
   MODERATION_GUILD_ID,
} from "./store.js";

/** Default reads remain possible before migration; writes never use this fallback. */
export function moderationSettings(
   db: Database.Database | null,
   guildId: string,
) {
   try {
      if (db) return new ModerationStore(db).settings(guildId);
   } catch {
      /* unmigrated tests/degraded boot */
   }
   return {
      moderation_channel_id:
         guildId === MODERATION_GUILD_ID ? DEFAULT_MODERATION_CHANNEL_ID : null,
      escalation_ping_role_ids: [] as string[],
   };
}

/** Scoped to one turn. Every protected tool read rechecks settings/authority/access;
 * delivery repeats the proof for every restricted source consumed by the model.
 */
export class PartnerAccess {
   private consumed = new Set<string | null>();

   constructor(
      private readonly getClient: () => Client,
      private readonly db: Database.Database | null,
      private readonly guildId: string,
      private readonly userId: string,
      private readonly destinationId: string,
   ) {}

   async workspace(): Promise<boolean> {
      try {
         if (
            moderationSettings(this.db, this.guildId).moderation_channel_id !==
            this.destinationId
         )
            return false;
         const guild = await this.getClient().guilds.fetch(this.guildId);
         const [member, bot, channel] = await Promise.all([
            guild.members.fetch({ user: this.userId, force: true }),
            guild.members.fetchMe({ force: true }),
            guild.channels.fetch(this.destinationId, { force: true }),
         ]);
         return (
            !!channel &&
            [0, 5].includes(channel.type) &&
            isModTurn(this.db, {
               isBot: member.user.bot,
               memberRoles: member.roles.cache.map((r) => ({
                  id: r.id,
                  name: r.name,
               })),
               isAdministrator: member.permissions.has(P.Administrator),
            }) &&
            !!channel
               .permissionsFor(member)
               ?.has([P.ViewChannel, P.ReadMessageHistory]) &&
            !!channel
               .permissionsFor(bot)
               ?.has([P.ViewChannel, P.ReadMessageHistory]) &&
            !channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel)
         );
      } catch {
         return false;
      }
   }

   async permits(
      source: GuildBasedChannel | null,
      remember = true,
   ): Promise<boolean> {
      if (!(await this.workspace())) return false;
      const guild = await this.getClient().guilds.fetch(this.guildId);
      const destination = await guild.channels.fetch(this.destinationId, {
         force: true,
      });
      if (
         !destination ||
         !(await verifyAudienceContainment(guild, source, destination))
      )
         return false;
      if (remember) this.consumed.add(source?.id ?? null);
      return true;
   }

   async verifyDelivery(): Promise<boolean> {
      if (!this.consumed.size) return this.workspace();
      try {
         const guild = await this.getClient().guilds.fetch(this.guildId);
         for (const id of this.consumed) {
            const source = id
               ? await guild.channels.fetch(id, { force: true })
               : null;
            if ((id && !source) || !(await this.permits(source, false)))
               return false;
         }
         return true;
      } catch {
         return false;
      }
   }
}
