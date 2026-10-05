import {
   PermissionFlagsBits as P,
   Routes,
   type Client,
   type APIGuildMember,
} from "discord.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import type {
   ToolSource,
   ToolSpec,
   ToolHandlerResult,
} from "../../tools/source.js";
import { createDiscordConversationProvider } from "../../discord/conversation.js";
import { transcriptCacheFor } from "../../discord/transcript-cache.js";
import { isEventTurn } from "../mod-authority.js";

const schema = z.object({ query: z.string().trim().min(1).max(100) }).strict();
const normalize = (name: string) =>
   name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/^@/, "")
      .trim();
const OPERATIONAL =
   P.Administrator |
   P.ManageGuild |
   P.ManageRoles |
   P.ManageChannels |
   P.BanMembers |
   P.KickMembers |
   P.ModerateMembers |
   P.ManageMessages |
   P.ViewAuditLog |
   P.ManageEvents |
   P.ManageThreads |
   P.ManageWebhooks;

/** Resolve from the readable transcript first, never through a full member list.
 * Current access and public-role filtering apply even to an exact ID lookup.
 */
export class MemberLookupToolSource implements ToolSource {
   readonly name = "server_member_lookup";
   private calls = 0;
   constructor(
      private readonly getClient: () => Client,
      private readonly db: Database.Database | null,
      private readonly guildId: string,
      private readonly callerId: string,
      private readonly channelId: string,
   ) {}
   async systemPromptSection(): Promise<string> {
      return "";
   }
   tools(): ToolSpec[] {
      return [
         {
            name: this.name,
            description:
               "Resuelve una persona por ID, mención real o nombre visto en este canal. Devuelve candidatos con ID, nombre visible, mención real y solo roles públicos. Cobertura parcial; no adivines entre candidatos.",
            inputSchema: {
               type: "object",
               properties: { query: { type: "string" } },
               required: ["query"],
               additionalProperties: false,
            },
         },
      ];
   }
   async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
      const parsed = schema.safeParse(input);
      if (name !== this.name || !parsed.success)
         return { status: "error", payload: { error: "Consulta inválida." } };
      if (++this.calls > 4)
         return {
            status: "error",
            payload: {
               error: "El límite de búsquedas de este turno se agotó.",
            },
         };
      try {
         const client = this.getClient(),
            guild = await client.guilds.fetch(this.guildId);
         const provider = createDiscordConversationProvider(
            this.getClient,
            this.guildId,
            this.callerId,
            this.channelId,
            client.user?.id ?? null,
         );
         const identities = await transcriptCacheFor(client).identities(
            provider,
            this.channelId,
         );
         const q = normalize(parsed.data.query),
            id = /^<?@!?(\d{17,20})>?$|^(\d{17,20})$/.exec(q);
         let ids = id
            ? [id[1] ?? id[2]]
            : identities
                 .filter((m) => normalize(m.name).includes(q))
                 .map((m) => m.id);
         let searched = false,
            searchAvailable = true;
         if (!ids.length && !id) {
            searched = true;
            try {
               const results = (await client.rest.get(
                  Routes.guildMembersSearch(guild.id),
                  {
                     query: new URLSearchParams({
                        query: parsed.data.query,
                        limit: "8",
                     }),
                  },
               )) as APIGuildMember[];
               ids = results.flatMap((m) => (m.user?.id ? [m.user.id] : []));
            } catch (err) {
               if ((err as { status?: number }).status !== 403) throw err;
               searchAvailable = false;
            }
         }
         const channels = await guild.channels.fetch();
         const caller = await guild.members.fetch({
            user: this.callerId,
            force: true,
         });
         const matches = [];
         for (const memberId of [...new Set(ids)].slice(0, 8)) {
            const member = await guild.members.fetch({
               user: memberId,
               force: true,
            });
            const roles = member.roles.cache
               .filter((role) => {
                  if (member.id === client.user?.id) return false; // bot operational detail stays in its workspace
                  if (
                     role.id === guild.id ||
                     role.managed ||
                     (role.permissions.bitfield & OPERATIONAL) !== 0n ||
                     isEventTurn(this.db, {
                        memberRoles: [{ id: role.id, name: role.name }],
                        isBot: false,
                     })
                  )
                     return false;
                  return ![...channels.values()].some(
                     (channel) =>
                        channel &&
                        !channel.permissionsFor(caller)?.has(P.ViewChannel) &&
                        channel.permissionOverwrites.cache
                           .get(role.id)
                           ?.allow.has(P.ViewChannel),
                  );
               })
               .map((r) => ({ id: r.id, name: r.name }))
               .sort((a, b) => a.id.localeCompare(b.id));
            matches.push({
               id: member.id,
               display_name: member.displayName,
               mention: `<@${member.id}>`,
               public_roles: roles,
            });
         }
         await provider.checkAccess!(this.channelId);
         return {
            status: "success",
            payload: {
               matches,
               ambiguous: matches.length > 1,
               complete: false,
               source: searched ? "rest_search" : "readable_channel_cache",
               search_available: searchAvailable,
               note: "Cobertura parcial. Un resultado vacío no prueba que esa persona no exista.",
            },
         };
      } catch {
         return {
            status: "error",
            payload: {
               error: "No pude verificar el acceso o resolver esa persona.",
            },
         };
      }
   }
}
