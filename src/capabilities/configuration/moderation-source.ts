import { PermissionFlagsBits as P, type Client } from "discord.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type {
   ToolSource,
   ToolSpec,
   ToolHandlerResult,
} from "../../tools/source.js";
import { ModerationStore, LOG_CHANNEL_IDS } from "../../moderation/store.js";
import { isModTurn } from "../mod-authority.js";
import { verifyAudienceContainment } from "../../discord/audience.js";

const snowflake = z.string().regex(/^\d{17,20}$/);
const argsSchema = z
   .object({
      action: z.enum(["status", "set_channel", "set_escalation_pings"]),
      channel_id: snowflake.optional(),
      role_ids: z.array(snowflake).max(4).optional(),
   })
   .strict();

/** Framework-owned moderation workspace; gated again at execution, not only availability. */
export class ConfigModerationSource implements ToolSource {
   readonly name = "config_moderation";
   constructor(
      private readonly db: Database.Database,
      private readonly client: Client,
      private readonly guildId: string | null,
      private readonly userId: string,
      private readonly callerChannelId: string,
   ) {}

   async systemPromptSection(): Promise<string> {
      return "";
   }

   tools(): ToolSpec[] {
      return [
         {
            name: "config_moderation",
            description:
               "Configura el espacio de moderación, sin reinicio. status muestra canal y pings. set_channel requiere channel_id de este servidor, restringido y con audiencia verificada. set_escalation_pings reemplaza role_ids por una lista de hasta 4 IDs; [] deja los avisos sin ping. Los IDs deben ser roles de moderación existentes, nunca @everyone. No cambia roles ni permisos.",
            inputSchema: {
               type: "object",
               properties: {
                  action: {
                     type: "string",
                     enum: ["status", "set_channel", "set_escalation_pings"],
                  },
                  channel_id: { type: "string" },
                  role_ids: {
                     type: "array",
                     items: { type: "string" },
                     maxItems: 4,
                  },
               },
               required: ["action"],
               additionalProperties: false,
            },
         },
      ];
   }

   async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
      const args = argsSchema.safeParse(input);
      if (name !== this.name || !args.success || !this.guildId)
         return fail("Configuración inválida.");
      try {
         const guild = await this.client.guilds.fetch(this.guildId);
         const member = await guild.members.fetch({
            user: this.userId,
            force: true,
         });
         const callerChannel = await guild.channels.fetch(
            this.callerChannelId,
            { force: true },
         );
         if (
            !isModTurn(this.db, {
               isBot: member.user.bot,
               memberRoles: member.roles.cache.map((r) => ({
                  id: r.id,
                  name: r.name,
               })),
               isAdministrator: member.permissions.has(P.Administrator),
            }) ||
            !callerChannel
               ?.permissionsFor(member)
               ?.has([P.ViewChannel, P.ReadMessageHistory])
         )
            return fail("Autoridad de moderación no confirmada.");
         const store = new ModerationStore(this.db),
            current = store.settings(this.guildId);
         const a = args.data;
         if (a.action === "status")
            return {
               status: "success",
               payload: {
                  ...current,
                  actions_30_days: store.summary(this.guildId),
               },
            };
         if (a.action === "set_channel") {
            if (!a.channel_id) return fail("channel_id es obligatorio.");
            if (LOG_CHANNEL_IDS.has(a.channel_id))
               return fail(
                  "Un canal de logs no puede ser el espacio de trabajo de moderación.",
               );
            const destination = await guild.channels.fetch(a.channel_id, {
               force: true,
            });
            if (
               !destination ||
               destination
                  .permissionsFor(guild.roles.everyone)
                  ?.has(P.ViewChannel) ||
               !(await verifyAudienceContainment(guild, null, destination))
            )
               return fail(
                  "No pude probar que el canal tiene una audiencia restringida adecuada para moderación.",
               );
            store.setSettings(
               this.guildId,
               a.channel_id,
               current.escalation_ping_role_ids,
            );
         } else {
            if (!a.role_ids)
               return fail("role_ids es obligatorio; [] desactiva los pings.");
            const roles = await guild.roles.fetch();
            for (const id of a.role_ids) {
               const role = roles.get(id);
               if (
                  !role ||
                  id === guild.id ||
                  !isModTurn(this.db, {
                     memberRoles: [{ id, name: role.name }],
                     isAdministrator: role.permissions.has(P.Administrator),
                  })
               )
                  return fail(
                     "Solo IDs de roles de moderación existentes pueden recibir pings.",
                  );
            }
            if (!current.moderation_channel_id)
               return fail("Configura primero el canal de moderación.");
            store.setSettings(
               this.guildId,
               current.moderation_channel_id,
               a.role_ids,
            );
         }
         return { status: "success", payload: store.settings(this.guildId) };
      } catch {
         return fail(
            "No pude verificar o guardar la configuración de moderación.",
         );
      }
   }
}

function fail(error: string): ToolHandlerResult {
   return { status: "error", payload: { error } };
}
