import { PermissionFlagsBits, type Client } from "discord.js";

const PERMISSIONS = [
   "Administrator",
   "BanMembers",
   "ManageMessages",
   "ModerateMembers",
   "ViewAuditLog",
] as const;
const TTL_MS = 60_000;

/** Deterministic guild snapshot; caller detail policy is rendered separately. */
export class BotSelfKnowledge {
   private cache = new Map<
      string,
      { expires: number; text: string; hasPermissions: boolean | null }
   >();

   async block(
      client: Client,
      guildId: string,
      moderator: boolean,
      now = Date.now(),
   ): Promise<string> {
      let snapshot = this.cache.get(guildId);
      if (!snapshot || snapshot.expires <= now) {
         const guild = client.guilds.cache.get(guildId);
         const me = guild?.members?.me;
         const roles = me?.roles.cache
            .filter((r) => r.id !== guildId)
            .map((r) => r.name)
            .sort();
         const text = me
            ? `Mis roles reales: ${JSON.stringify(roles)}. Permisos efectivos: ${PERMISSIONS.map((p) => `${p}=${me.permissions.has(PermissionFlagsBits[p]) ? "sí" : "no"}`).join(", ")}.`
            : "No pude verificar mis roles y permisos actuales; no afirmes que carezco de ellos.";
         snapshot = {
            expires: now + TTL_MS,
            text,
            hasPermissions: me
               ? PERMISSIONS.some((p) =>
                    me.permissions.has(PermissionFlagsBits[p]),
                 )
               : null,
         };
         this.cache.set(guildId, snapshot);
      }
      const detail = moderator
         ? `${snapshot.text}
Hoy solo ejecuto bans por solicitud explícita actual, verificada en código: @ChopperBot banea a @persona por motivo. Una sola mención real; nunca por historial o una recomendación. Protejo al dueño, bots, quien lo pide y staff de eventos (incluida Gestión); compruebo jerarquía y permisos en vivo. No borro mensajes ni hago timeouts todavía.`
         : `${snapshot.hasPermissions === true ? "Tengo permisos de moderación, pero solo actúo cuando el equipo de moderación me lo pide explícitamente." : snapshot.hasPermissions === false ? "No tengo permisos efectivos de moderación en este servidor ahora; no prometas acciones." : "No pude verificar mis permisos actuales; no inventes que tengo o no tengo autoridad."} No compartas el detalle operativo ni instrucciones para sancionar.`;
      // Role names and permission values are operational details, so only staff sees them.
      return `# Mis permisos y acciones reales
${detail}
Nunca sanciono por iniciativa propia. Nunca envío ni retransmito órdenes a Nekotina, Sapphire, Carl-bot ni a otros bots. Moderación puede pedirme directamente lo que ya está implementado; no prometas timeouts ni avisos de entrada. Los avisos de entrada necesitan el intent privilegiado GuildMembers, hoy desactivado; habilitarlo es una decisión del equipo. Ante un pedido de avisos de entrada, nómbralo como “intent privilegiado GuildMembers”; no lo llames permiso o rol del servidor.`;
   }
}
