import {
   PermissionFlagsBits as P,
   Routes,
   type Client,
   type Message,
} from "discord.js";
import type Database from "better-sqlite3";
import type { CapabilityTurnContext } from "../capability.js";
import { eventRoleTokens, isModTurn } from "../mod-authority.js";
import { isModCaller } from "../../discord/mod-roles.js";
import { stripBotMention } from "../../discord/handlers.js";
import { isHedgedReason } from "./moderation-tools.js";
import { LOG_CHANNEL_IDS, ModerationStore } from "../../moderation/store.js";
import { verifyAudienceContainment } from "../../discord/audience.js";
import { PartnerAccess } from "../../moderation/access.js";
import { sanitizeEscalationSummary } from "./escalation-tools.js";
import type {
   ToolSource,
   ToolSpec,
   ToolHandlerResult,
} from "../../tools/source.js";
import { log } from "../../log.js";

export type ActionRequest =
   | {
        action: "timeout" | "timeout_removed";
        targetId: string;
        durationMs: number | null;
        reason: string;
     }
   | {
        action: "message_deleted";
        targetId: string;
        channelId: string;
        reason: string;
     };
export const MAX_TIMEOUT_MS = 7 * 86_400_000;

/**
 * Only the current standalone imperative and real IDs can authorize an effect.
 * Deletion is link-only: a reply form could only ever reach messages inside
 * the workspace itself (the only place these tools attach).
 */
export function parseActionRequest(
   text: string | undefined,
   guildId: string,
): ActionRequest | null {
   if (!text || /[\n\r`"?¿]|<@&|jaj+a*|\bxd\b|broma|😂|🤣/iu.test(text))
      return null;
   const command = text.trim().replace(/^por favor[,:]?\s+/i, "");
   const reason = (s?: string) =>
      s?.trim() || "Solicitud explícita de moderación.";
   const timeout = command.match(
      /^(?:timeout|timeoutea|silencia)\s+(?:a\s+)?<@!?(\d{17,20})>(?:\s+(\d+)(m|h|d))?(?:\s+por\s+(.{1,300}))?[.!]?$/i,
   );
   const remove = command.match(
      /^quita\s+el\s+timeout\s+(?:a\s+)?<@!?(\d{17,20})>(?:\s+por\s+(.{1,300}))?[.!]?$/i,
   );
   if (timeout || remove) {
      if ((text.match(/<@!?\d+>/g) ?? []).length !== 1 || /https?:/i.test(text))
         return null;
      const why = timeout ? timeout[4] : remove![2];
      // "por spam 24h": a duration after the reason would be silently ignored.
      if (isHedgedReason(why) || /\d+\s*[mhd]\.?$/i.test(why ?? ""))
         return null;
      if (remove)
         return {
            action: "timeout_removed",
            targetId: remove[1],
            durationMs: null,
            reason: reason(remove[2]),
         };
      const durationMs = timeout![2]
         ? Number(timeout![2]) *
           { m: 60_000, h: 3_600_000, d: 86_400_000 }[
              timeout![3].toLowerCase()
           ]!
         : 3_600_000;
      if (
         !Number.isSafeInteger(durationMs) ||
         durationMs <= 0 ||
         durationMs > MAX_TIMEOUT_MS
      )
         return null;
      return {
         action: "timeout",
         targetId: timeout![1],
         durationMs,
         reason: reason(timeout![4]),
      };
   }
   const link = command.match(
      /^borra\s+https:\/\/(?:www\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})(?:\s+por\s+(.{1,300}))?[.!]?$/i,
   );
   if (link && link[1] === guildId && !isHedgedReason(link[4]))
      return {
         action: "message_deleted",
         targetId: link[3],
         channelId: link[2],
         reason: reason(link[4]),
      };
   return null;
}

export interface ActionExecutor {
   /** Returns private, code-built deletion evidence only after a successful effect. */
   execute(request: ActionRequest): Promise<string | void>;
}

/** Rechecks consent, live authority, permissions and hierarchy at the effect. */
export function createDiscordActionExecutor(
   getClient: () => Client,
   db: Database.Database,
   ctx: CapabilityTurnContext & { guildId: string; messageId: string },
   request: ActionRequest,
): ActionExecutor {
   return {
      async execute() {
         if (
            !(await new PartnerAccess(
               getClient,
               db,
               ctx.guildId,
               ctx.userId,
               ctx.channelId,
            ).workspace())
         )
            throw new Error("La persona ya no tiene autorización.");
         const client = getClient(),
            guild = await client.guilds.fetch(ctx.guildId);
         const source = await guild.channels.fetch(ctx.channelId, {
            force: true,
         });
         const caller = await guild.members.fetch({
            user: ctx.userId,
            force: true,
         });
         const bot = await guild.members.fetchMe({ force: true });
         const authority = (member: typeof caller) => ({
            isBot: member.user.bot,
            memberRoles: member.roles.cache.map((r) => ({
               id: r.id,
               name: r.name,
            })),
            isAdministrator: member.permissions.has(P.Administrator),
         });
         if (!source?.isTextBased() || !("messages" in source))
            throw new Error("Canal no disponible.");
         if (
            !isModTurn(db, authority(caller)) ||
            !source
               .permissionsFor(caller)
               ?.has([P.ViewChannel, P.ReadMessageHistory]) ||
            !source
               .permissionsFor(bot)
               ?.has([P.ViewChannel, P.ReadMessageHistory])
         )
            throw new Error("La persona ya no tiene autorización.");
         const trigger = await source.messages.fetch({
            message: ctx.messageId,
            force: true,
            cache: false,
         });
         const current = parseActionRequest(
            stripBotMention(client, trigger.content, guild).trim(),
            guild.id,
         );
         if (
            trigger.author.id !== ctx.userId ||
            trigger.author.bot ||
            trigger.editedTimestamp ||
            trigger.webhookId ||
            JSON.stringify(current) !== JSON.stringify(request)
         )
            throw new Error("La solicitud cambió o no es explícita.");
         const auditReason =
            `Moderador ${ctx.userId}; solicitud ${ctx.messageId}: ${sanitizeEscalationSummary(request.reason)}`.slice(
               0,
               512,
            );
         let targetId = request.targetId;
         let deletion: { message: Message; evidence: string } | null = null;
         if (request.action === "message_deleted") {
            const trailEvidence = db
               .prepare(
                  `SELECT 1 FROM framework_moderation_trail
               WHERE guild_id = ? AND channel_id = ? AND trigger_message_id = ? LIMIT 1`,
               )
               .get(guild.id, request.channelId, request.targetId);
            if (trailEvidence)
               throw new Error("Objetivo protegido o jerarquía insuficiente.");
            if (LOG_CHANNEL_IDS.has(request.channelId))
               throw new Error("Objetivo protegido o jerarquía insuficiente.");
            const channel = await guild.channels.fetch(request.channelId, {
               force: true,
            });
            if (channel?.isThread() && channel.parentId)
               await guild.channels.fetch(channel.parentId, { force: true });
            if (
               !channel?.isTextBased() ||
               !("messages" in channel) ||
               !channel
                  .permissionsFor(caller)
                  ?.has([
                     P.ViewChannel,
                     P.ReadMessageHistory,
                     P.ManageMessages,
                  ]) ||
               !channel
                  .permissionsFor(bot)
                  ?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages])
            )
               throw new Error("La persona ya no tiene autorización.");
            if (channel.isThread() && channel.type === 12) {
               for (const member of [caller, bot])
                  if (!channel.permissionsFor(member)?.has(P.ManageThreads))
                     await channel.members.fetch(member.id);
            }
            const destinationId = new ModerationStore(db).settings(
               guild.id,
            ).moderation_channel_id;
            // The workspace's own discussion is not a deletion target.
            if (request.channelId === destinationId)
               throw new Error("Objetivo protegido o jerarquía insuficiente.");
            const destination = destinationId
               ? await guild.channels.fetch(destinationId, { force: true })
               : null;
            // Public threads inherit their parent's audience; private threads
            // have membership of their own and cannot use that proof.
            const evidenceSource = channel.isThread()
               ? channel.type === 12
                  ? null
                  : channel.parent
               : channel;
            if (
               !destination ||
               !evidenceSource ||
               !(await verifyAudienceContainment(
                  guild,
                  evidenceSource,
                  destination,
               ))
            )
               throw new Error("La persona ya no tiene autorización.");
            const message = await channel.messages.fetch({
               message: request.targetId,
               force: true,
               cache: false,
            });
            if (
               message.author.bot ||
               message.webhookId ||
               !message.deletable ||
               message.id === trigger.id
            )
               throw new Error("Objetivo protegido o jerarquía insuficiente.");
            targetId = message.author.id;
            deletion = {
               message,
               evidence: `Autor: ${targetId} · Canal: ${channel.id} · Fecha UTC: ${message.createdAt.toISOString()}\nExtracto citado: «${sanitizeEscalationSummary(message.content).slice(0, 200)}»`,
            };
         }
         // A deleted message's author may have left or been banned (the
         // commonest raid cleanup): no member means no hierarchy to protect,
         // but the requester, owner and bot stay off-limits.
         const target = await guild.members
            .fetch({ user: targetId, force: true })
            .catch((err: unknown) => {
               if (
                  request.action === "message_deleted" &&
                  (err as { code?: unknown })?.code === 10007
               )
                  return null;
               throw err;
            });
         if (
            target === null &&
            [caller.id, bot.id, guild.ownerId].includes(targetId)
         )
            throw new Error("Objetivo protegido o jerarquía insuficiente.");
         if (
            target !== null &&
            (target.id === caller.id ||
               target.id === bot.id ||
               target.id === guild.ownerId ||
               target.user.bot ||
               isModCaller(authority(target), eventRoleTokens(db)) ||
               (caller.id !== guild.ownerId &&
                  caller.roles.highest.comparePositionTo(
                     target.roles.highest,
                  ) <= 0) ||
               bot.roles.highest.comparePositionTo(target.roles.highest) <= 0 ||
               (request.action !== "message_deleted" &&
                  (!bot.permissions.has(P.ModerateMembers) ||
                     !target.moderatable)))
         )
            throw new Error("Objetivo protegido o jerarquía insuficiente.");
         if (
            request.action === "timeout_removed" &&
            !target?.isCommunicationDisabled()
         )
            throw new Error("No tiene un timeout activo.");
         if (deletion && request.action === "message_deleted")
            await client.rest.delete(
               Routes.channelMessage(request.channelId, deletion.message.id),
               { reason: auditReason },
            );
         else if (request.action !== "message_deleted")
            await target!.timeout(request.durationMs, auditReason);
         log.info(
            {
               guildId: guild.id,
               moderatorId: caller.id,
               targetId,
               messageId: ctx.messageId,
               action: request.action,
            },
            "moderation.action_executed",
         );
         return deletion?.evidence;
      },
   };
}

/** One effect attempt per turn; model arguments cannot change the bound request. */
export class ActionToolSource implements ToolSource {
   readonly name = "moderator_explicit_action";
   private attempted = false;
   constructor(
      private readonly request: ActionRequest,
      private readonly executor: ActionExecutor,
   ) {}
   async systemPromptSection(): Promise<string> {
      return "";
   }
   tools(): ToolSpec[] {
      return [
         {
            name: actionToolName(this.request),
            description: `Ejecuta únicamente la solicitud actual ${this.request.action} para el ID ${this.request.targetId}. Objetivo, duración y motivo están fijados por código.`,
            inputSchema: {
               type: "object",
               properties: {
                  target_id: { type: "string", enum: [this.request.targetId] },
               },
               required: ["target_id"],
               additionalProperties: false,
            },
         },
      ];
   }
   async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
      const args = input as Record<string, unknown> | null;
      if (
         name !== actionToolName(this.request) ||
         !args ||
         args.target_id !== this.request.targetId ||
         Object.keys(args).some((k) => k !== "target_id") ||
         this.attempted
      )
         return {
            status: "error",
            payload: { error: "No hay autorización para esa acción." },
         };
      this.attempted = true;
      try {
         await this.executor.execute(this.request);
         return {
            status: "success",
            payload: {
               action: this.request.action,
               target_id: this.request.targetId,
               executed: true,
               reason: this.request.reason,
               ...(this.request.action !== "message_deleted"
                  ? { duration_ms: this.request.durationMs }
                  : {}),
            },
         };
      } catch (err) {
         log.warn(
            { err, action: this.request.action },
            "moderation.action_refused",
         );
         return {
            status: "error",
            payload: {
               error: "No se pudo confirmar la acción. Revisa solicitud, autoridad y jerarquía; no afirmes que se aplicó.",
            },
         };
      }
   }
}

export function actionToolName(request: ActionRequest): string {
   return {
      timeout: "server_timeout_member",
      timeout_removed: "server_remove_timeout",
      message_deleted: "server_delete_message",
   }[request.action];
}
