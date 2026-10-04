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
      /** True only for a verified moderator inside the restricted workspace. */
      detailed: boolean,
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
               ? PERMISSIONS.some(
                    // ViewAuditLog alone reads; it is not a moderation power.
                    (p) =>
                       p !== "ViewAuditLog" &&
                       me.permissions.has(PermissionFlagsBits[p]),
                 )
               : null,
         };
         this.cache.set(guildId, snapshot);
      }
      const detail = detailed
         ? `${snapshot.text}
Acciones implementadas, solo con solicitud explícita actual verificada en código:
@ChopperBot banea a @persona por motivo.
@ChopperBot timeout @persona 1h por motivo (también silencia a @persona 30m por motivo; m/h/d, predeterminado 1h, máximo 7d).
@ChopperBot quita el timeout a @persona.
@ChopperBot borra <enlace real del mensaje> por motivo (un solo mensaje; no borro mensajes de este espacio de moderación).
Timeouts y borrado se solicitan aquí en el espacio restringido. Solo una mención real o un enlace; nunca por historial, recomendación, condición ("si…", "tal vez") o confirmación implícita. Protejo al dueño, bots, quien lo pide y staff de eventos (incluida Gestión); compruebo jerarquía y permisos en vivo. El borrado necesita ViewChannel y ManageMessages de quien lo pide en el canal objetivo. Solo promete ejecutar cuando la herramienta correspondiente está adjunta este turno.`
         : `${snapshot.hasPermissions === true ? "Tengo permisos de moderación, pero solo actúo cuando el equipo de moderación me lo pide explícitamente." : snapshot.hasPermissions === false ? "No tengo permisos efectivos de moderación en este servidor ahora; no prometas acciones." : "No pude verificar mis permisos actuales; no inventes que tengo o no tengo autoridad."} No compartas el detalle operativo ni instrucciones para sancionar.`;
      // Role names and permission values are operational details: only the
      // restricted moderator workspace sees them, never a public channel.
      return `# Mis permisos y acciones reales
${detail}
Nunca sanciono por iniciativa propia. Nunca envío ni retransmito órdenes a Nekotina, Sapphire, Carl-bot ni a otros bots. No ofrezco avisos de entrada: el equipo decidió mantener el intent privilegiado GuildMembers desactivado y puede revisarlo. Ante un pedido de avisos de entrada, nómbralo como “intent privilegiado GuildMembers”; no lo llames permiso o rol del servidor.`;
   }
}
