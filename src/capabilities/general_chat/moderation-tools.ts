import { PermissionFlagsBits, type Client } from "discord.js";
import type Database from "better-sqlite3";
import type {
   ToolHandlerResult,
   ToolSource,
   ToolSpec,
} from "../../tools/source.js";
import { eventRoleTokens, isModTurn } from "../mod-authority.js";
import { isModCaller } from "../../discord/mod-roles.js";
import { stripBotMention } from "../../discord/handlers.js";
import { log } from "../../log.js";

export interface BanRequest {
   targetId: string;
   reason: string;
}

/**
 * Only a standalone, current imperative naming ONE member authorizes a ban.
 * Questions, conditionals, quotes, reply history and model interpretation do
 * not. Broader natural-language requests get directed to this explicit syntax.
 */
export function parseBanRequest(text: string | undefined): BanRequest | null {
   if (!text || /[\n\r`]|https?:|<@&/i.test(text)) return null;
   const match = text
      .trim()
      .match(
         /^(?:por favor[,:]?\s+)?(?:banea|banee|banear|baneá|ban)\s+(?:a\s+)?<@!?(\d{17,20})>(?:\s+(?:por|for|motivo:|reason:)\s+(.{1,300}))?[.!]?$/i,
      );
   if (!match || (text.match(/<@!?\d+>/g) ?? []).length !== 1) return null;
   return {
      targetId: match[1],
      reason: match[2]?.trim() || "Solicitud explícita de moderación.",
   };
}

export async function verifyLiveModerator(
   getClient: () => Client,
   guildId: string,
   userId: string,
   db: Database.Database | null,
): Promise<boolean> {
   try {
      const guild = await getClient().guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      return isModTurn(db, {
         isBot: member.user?.bot,
         memberRoles: member.roles.cache.map((r) => ({
            id: r.id,
            name: r.name,
         })),
         isAdministrator: member.permissions.has(
            PermissionFlagsBits.Administrator,
         ),
      });
   } catch {
      return false;
   }
}

export interface BanExecutor {
   execute(request: BanRequest): Promise<void>;
}

export function createDiscordBanExecutor(
   getClient: () => Client,
   guildId: string,
   userId: string,
   channelId: string,
   messageId: string,
   db: Database.Database | null,
   request: BanRequest,
): BanExecutor {
   return {
      async execute() {
         const client = getClient();
         const guild = await client.guilds.fetch(guildId);
         // Re-fetch the actual trigger: deleted/edited requests revoke consent.
         const channel = await guild.channels.fetch(channelId, { force: true });
         if (!channel?.isTextBased() || !("messages" in channel))
            throw new Error("Canal no disponible.");
         const caller = await guild.members.fetch({
            user: userId,
            force: true,
         });
         if (
            !isModTurn(db, {
               isBot: caller.user?.bot,
               memberRoles: caller.roles.cache.map((r) => ({
                  id: r.id,
                  name: r.name,
               })),
               isAdministrator: caller.permissions.has(
                  PermissionFlagsBits.Administrator,
               ),
            }) ||
            !channel
               .permissionsFor(caller)
               ?.has([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
               ])
         ) {
            throw new Error("La persona ya no tiene autorización.");
         }
         const trigger = await channel.messages.fetch({
            message: messageId,
            force: true,
            cache: false,
         });
         const raw = stripBotMention(client, trigger.content, guild).trim();
         const currentRequest = parseBanRequest(raw);
         if (
            trigger.author.id !== userId ||
            trigger.editedTimestamp ||
            trigger.webhookId ||
            !currentRequest ||
            currentRequest.targetId !== request.targetId ||
            currentRequest.reason !== request.reason
         )
            throw new Error("La solicitud cambió o no es explícita.");
         const target = await guild.members.fetch({
            user: request.targetId,
            force: true,
         });
         const bot = await guild.members.fetchMe({ force: true });
         if (
            target.id === userId ||
            target.id === bot.id ||
            target.id === guild.ownerId ||
            target.user.bot ||
            isModCaller(
               {
                  isBot: target.user.bot,
                  memberRoles: target.roles.cache.map((r) => ({
                     id: r.id,
                     name: r.name,
                  })),
                  isAdministrator: target.permissions.has(
                     PermissionFlagsBits.Administrator,
                  ),
               },
               // Protect the wider events tier: Gestión is staff, not a target
               // the bot should ever be the instrument against.
               eventRoleTokens(db),
            ) ||
            (caller.id !== guild.ownerId &&
               caller.roles.highest.comparePositionTo(target.roles.highest) <=
                  0) ||
            !bot.permissions.has(PermissionFlagsBits.BanMembers) ||
            !target.bannable
         ) {
            throw new Error("Objetivo protegido o jerarquía insuficiente.");
         }
         // No history deletion: ban is the ONLY requested effect.
         await guild.members.ban(target.id, {
            deleteMessageSeconds: 0,
            reason:
               `Moderador ${userId}; solicitud ${messageId}: ${request.reason}`.slice(
                  0,
                  512,
               ),
         });
         log.info(
            { guildId, moderatorId: userId, targetId: target.id, messageId },
            "moderation.member_banned",
         );
      },
   };
}

/** Bound to the exact target/reason from the current moderator message. */
export class BanToolSource implements ToolSource {
   readonly name = "moderator_explicit_ban";
   private attempted = false;
   constructor(
      private request: BanRequest,
      private executor: BanExecutor,
   ) {}
   async systemPromptSection(): Promise<string> {
      return "";
   }
   tools(): ToolSpec[] {
      return [
         {
            name: "server_ban_member",
            description: `Ejecuta la solicitud explícita ACTUAL de moderación: banear únicamente el ID ${this.request.targetId}. El objetivo y motivo están fijados por el mensaje, no por el modelo. No borra mensajes.`,
            inputSchema: {
               type: "object",
               properties: {
                  user_id: { type: "string", enum: [this.request.targetId] },
               },
               required: ["user_id"],
               additionalProperties: false,
            },
         },
      ];
   }
   async handle(tool: string, input: unknown): Promise<ToolHandlerResult> {
      const args = input as Record<string, unknown> | null;
      if (
         tool !== "server_ban_member" ||
         !args ||
         args.user_id !== this.request.targetId ||
         Object.keys(args).some((k) => k !== "user_id") ||
         this.attempted
      ) {
         return {
            status: "error",
            payload: { error: "No hay autorización para esa acción." },
         };
      }
      this.attempted = true;
      try {
         await this.executor.execute(this.request);
         return {
            status: "success",
            payload: {
               banned_user_id: this.request.targetId,
               messages_deleted: false,
            },
         };
      } catch (err) {
         log.warn(
            { err, targetId: this.request.targetId },
            "moderation.ban_refused",
         );
         return {
            status: "error",
            payload: {
               error: "No se pudo confirmar el ban. Revisa la solicitud, autoridad y jerarquía; no afirmes que se aplicó.",
            },
         };
      }
   }
}
