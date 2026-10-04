import { AuditLogEvent, PermissionFlagsBits, type Client } from "discord.js";
import { z } from "zod";
import type {
   ToolSource,
   ToolSpec,
   ToolHandlerResult,
} from "../../tools/source.js";
import type { PartnerAccess } from "../../moderation/access.js";

const LABELS: Record<number, string> = {
   1: "Actualización del servidor",
   10: "Canal creado",
   11: "Canal actualizado",
   12: "Canal eliminado",
   13: "Permiso de canal creado",
   14: "Permiso de canal actualizado",
   15: "Permiso de canal eliminado",
   20: "Expulsión",
   21: "Depuración de miembros",
   22: "Ban",
   23: "Ban retirado",
   24: "Miembro actualizado (incluye timeout)",
   25: "Roles de miembro actualizados",
   26: "Movimiento de voz",
   27: "Desconexión de voz",
   28: "Bot añadido",
   30: "Rol creado",
   31: "Rol actualizado",
   32: "Rol eliminado",
   40: "Invitación creada",
   41: "Invitación actualizada",
   42: "Invitación eliminada",
   50: "Webhook creado",
   51: "Webhook actualizado",
   52: "Webhook eliminado",
   60: "Emoji creado",
   61: "Emoji actualizado",
   62: "Emoji eliminado",
   72: "Mensaje eliminado",
   73: "Mensajes eliminados en conjunto",
   74: "Mensaje fijado",
   75: "Mensaje desfijado",
   80: "Integración creada",
   81: "Integración actualizada",
   82: "Integración eliminada",
   83: "Stage creado",
   84: "Stage actualizado",
   85: "Stage eliminado",
   90: "Sticker creado",
   91: "Sticker actualizado",
   92: "Sticker eliminado",
   100: "Evento creado",
   101: "Evento actualizado",
   102: "Evento eliminado",
   110: "Hilo creado",
   111: "Hilo actualizado",
   112: "Hilo eliminado",
   121: "Permiso de comando actualizado",
   140: "Regla AutoMod creada",
   141: "Regla AutoMod actualizada",
   142: "Regla AutoMod eliminada",
   143: "Mensaje bloqueado por AutoMod",
   144: "Alerta de AutoMod",
   145: "Timeout de AutoMod",
   146: "Interacción bloqueada por AutoMod",
};
const id = z.string().regex(/^\d{17,20}$/);
const argsSchema = z
   .object({
      action_type: z
         .number()
         .int()
         .refine((n) => typeof AuditLogEvent[n] === "string")
         .optional(),
      actor_id: id.optional(),
      target_id: id.optional(),
      before: id.optional(),
   })
   .strict();

/** Partner-only audit read. One page/50 slots and 15k serialized chars; never an archive. */
export class AuditLogToolSource implements ToolSource {
   readonly name = "moderation_audit";
   private pages = 3;
   constructor(
      private readonly getClient: () => Client,
      private readonly guildId: string,
      private readonly access: PartnerAccess,
   ) {}

   async systemPromptSection(): Promise<string> {
      return "";
   }

   tools(): ToolSpec[] {
      return [
         {
            name: "server_audit_log",
            description:
               "Lee una página del registro de auditoría del servidor (retención aproximada 45 días). Solo en el espacio de moderación verificado. Filtra por tipo numérico de acción, actor, objetivo y cursor before. Tipos: 22 ban, 23 retiro de ban, 24 miembro/timeout, 72 mensaje eliminado, 26 movimiento de voz, 27 desconexión, 145 timeout AutoMod. No aplica sanciones.",
            inputSchema: {
               type: "object",
               properties: {
                  action_type: { type: "integer" },
                  actor_id: { type: "string" },
                  target_id: { type: "string" },
                  before: { type: "string" },
               },
               additionalProperties: false,
            },
         },
      ];
   }

   async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
      const args = argsSchema.safeParse(input);
      if (name !== "server_audit_log" || !args.success || this.pages-- <= 0)
         return {
            status: "error",
            payload: {
               error: "Consulta de auditoría inválida o límite del turno alcanzado.",
            },
         };
      try {
         if (!(await this.access.permits(null))) throw new Error("audience");
         const guild = await this.getClient().guilds.fetch(this.guildId);
         const bot = await guild.members.fetchMe({ force: true });
         if (!bot.permissions.has(PermissionFlagsBits.ViewAuditLog))
            throw new Error("permission");
         const a = args.data;
         const page = await guild.fetchAuditLogs({
            limit: 50,
            type: a.action_type,
            user: a.actor_id,
            before: a.before,
         });
         const entries = [];
         let chars = 0,
            truncated = false,
            cursor: string | null = a.before ?? null;
         for (const entry of page.entries.values()) {
            const target =
               typeof entry.target === "object" &&
               entry.target &&
               "id" in entry.target
                  ? String(entry.target.id)
                  : entry.targetId;
            const row = {
               id: entry.id,
               action_type: entry.action,
               action:
                  LABELS[entry.action] ?? `Acción registrada (${entry.action})`,
               actor_id: entry.executorId,
               target_id: target,
               timestamp_utc: new Date(entry.createdTimestamp).toISOString(),
               reason: entry.reason?.slice(0, 500) ?? null,
               changes: JSON.stringify(entry.changes ?? []).slice(0, 1_000),
            };
            if (!a.target_id || target === a.target_id) {
               const cost = JSON.stringify(row).length;
               if (chars + cost > 15_000) {
                  truncated = true;
                  break;
               }
               chars += cost;
               entries.push(row);
            }
            cursor = entry.id;
         }
         return {
            status: "success",
            payload: {
               retention_days_approx: 45,
               scanned: page.entries.size,
               complete: !truncated && page.entries.size < 50,
               truncated,
               next_before: cursor,
               note: "Solo las entradas y filtros leídos; no demuestra ausencia de incidentes ni conserva lo borrado. Cita ID y fecha UTC de auditoría y enlaza mensajes del historial que sustenten los hechos. La auditoría no ofrece enlaces directos a mensajes: no los inventes.",
               entries,
            },
         };
      } catch {
         return {
            status: "error",
            payload: {
               error: "Auditoría no disponible para la autoridad o audiencia actual de este canal.",
            },
         };
      }
   }
}
