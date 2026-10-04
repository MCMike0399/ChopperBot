import { PermissionFlagsBits as P, type Client } from "discord.js";
import type {
   BanExecutor,
   BanRequest,
} from "../capabilities/general_chat/moderation-tools.js";
import { log } from "../log.js";
import { verifyAudienceContainment } from "../discord/audience.js";
import { ModerationStore, LOG_CHANNEL_IDS, type TrailEntry } from "./store.js";

export function renderModLog(entry: TrailEntry): string {
   return `**Acción de moderación: ban ejecutado**\nSolicitó: <@${entry.actorId}> · Objetivo: <@${entry.targetId}>\nSolicitud: https://discord.com/channels/${entry.guildId}/${entry.channelId}/${entry.triggerMessageId}\nResultado: ejecutado. Motivo: ${entry.reason.slice(0, 300)}`;
}

/** Delivery is separate from the effect; a failed log never replays a sanction. */
export async function sendModerationLine(
   client: Client,
   store: ModerationStore,
   guildId: string,
   content: string,
   ping = false,
   nonce?: string,
): Promise<void> {
   const settings = store.settings(guildId);
   if (
      !settings.moderation_channel_id ||
      LOG_CHANNEL_IDS.has(settings.moderation_channel_id)
   )
      throw new Error("workspace_missing");
   const guild = await client.guilds.fetch(guildId);
   const channel = await guild.channels.fetch(settings.moderation_channel_id, {
      force: true,
   });
   const bot = await guild.members.fetchMe({ force: true });
   if (
      !channel?.isTextBased() ||
      !("send" in channel) ||
      channel.isThread() ||
      channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel) ||
      !channel.permissionsFor(bot)?.has([P.ViewChannel, P.SendMessages]) ||
      !(await verifyAudienceContainment(guild, null, channel))
   )
      throw new Error("workspace_audience_unverified");
   const roles = ping ? settings.escalation_ping_role_ids : [];
   if (roles.some((id) => !guild.roles.cache.has(id)))
      throw new Error("ping_role_unresolved");
   await channel.send({
      content: `${roles.map((id) => `<@&${id}>`).join(" ")}${roles.length ? "\n" : ""}${content}`,
      allowedMentions: { parse: [], users: [], roles, repliedUser: false },
      ...(nonce ? { nonce, enforceNonce: true } : {}),
   });
}

function refusalCode(err: unknown): string {
   const text = err instanceof Error ? err.message : "";
   if (text.includes("ya no tiene autorización")) return "authority_revoked";
   if (text.includes("solicitud cambió")) return "request_changed";
   if (text.includes("Objetivo protegido"))
      return "protected_target_or_hierarchy";
   if (text.includes("Canal no disponible")) return "channel_unavailable";
   return "effect_unconfirmed";
}

/** Persistent one-attempt reservation supplements BanToolSource's per-turn flag. */
export function withBanTrail(
   executor: BanExecutor,
   store: ModerationStore,
   entry: TrailEntry,
   sendLog: (line: string) => Promise<void>,
): BanExecutor {
   return {
      async execute(request: BanRequest) {
         const id = store.record({
            ...entry,
            outcome: "refused:effect_unconfirmed",
         });
         if (id === null)
            throw new Error("Esta solicitud ya fue intentada; no se repite.");
         try {
            await executor.execute(request);
         } catch (err) {
            store.finish(id, `refused:${refusalCode(err)}`);
            throw err;
         }
         store.finish(id, "executed");
         try {
            await sendLog(renderModLog(entry));
         } catch (err) {
            log.error(
               { err, trailId: id },
               "moderation.mod_log_delivery_failed",
            );
         }
      },
   };
}
