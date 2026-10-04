import { ChannelType, PermissionFlagsBits as P, type Client } from "discord.js";
import { z } from "zod";
import type {
   ToolSource,
   ToolSpec,
   ToolHandlerResult,
} from "../../tools/source.js";
import type { CapabilityTurnContext } from "../capability.js";
import { stripBotMention } from "../../discord/handlers.js";
import { ModerationStore } from "../../moderation/store.js";
import { sendModerationLine } from "../../moderation/trail.js";
import { log } from "../../log.js";

/** Deliberately high threshold: only current first-person incident reports or
 * serious sanction requests. The model decides credibility, code excludes
 * obvious jokes and binds all identities. Never scans ambient/history text.
 */
export function escalationCandidate(text: string | undefined): boolean {
   if (!text || /jaj+a*|\bxd\b|broma|😂|🤣/i.test(text)) return false;
   return /acos[oa]|amenaz|doxx?|raid|hostig|filtr.*(?:datos|direcci[oó]n)|banea|banear|timeout|sanci[oó]n/i.test(
      text,
   );
}

const argsSchema = z
   .object({
      summary: z.string().min(10).max(350),
      severity: z.enum(["alta", "urgente"]),
      target_id: z
         .string()
         .regex(/^\d{17,20}$/)
         .optional(),
   })
   .strict();

/**
 * The summary is model-written from member text, so it must not be able to
 * forge the code-set lines (Reportó/Gravedad), carry links or mention tokens,
 * or restyle the note. One plain line: no newlines, URLs, mentions or markdown.
 */
export function sanitizeEscalationSummary(summary: string): string {
   return summary
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(?:@[!&]?|#|\/[^:>]*:)\d+>/g, "[mención]")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[enlace omitido]")
      .replace(/[\\*_`~|>#\[\]()«»]/g, "")
      .replace(/@(everyone|here)/gi, "$1")
      .replace(/\s+/g, " ")
      .trim();
}

export function renderEscalation(
   ctx: CapabilityTurnContext,
   targetId: string,
   summary: string,
   severity: string,
): string {
   return `**Reporte para revisión humana**\nQué (resumen del bot, texto citado): «${sanitizeEscalationSummary(summary)}»\nDónde: <#${ctx.channelId}> · https://discord.com/channels/${ctx.guildId}/${ctx.channelId}/${ctx.messageId}\nReportó: <@${ctx.userId}>${targetId ? ` · Objetivo citado: <@${targetId}>` : ""}\nGravedad (interpretación del bot, no un hecho verificado): ${severity}.\nSe orientó al flujo de tickets; no se aplicó ninguna sanción.`;
}

/** At effect time, the real trigger must still match and source must be community-visible. */
export async function canEscalateFrom(
   client: Client,
   ctx: CapabilityTurnContext,
): Promise<boolean> {
   try {
      if (!ctx.guildId) return false;
      const guild = await client.guilds.fetch(ctx.guildId);
      const channel = await guild.channels.fetch(ctx.channelId, {
         force: true,
      });
      const [member, bot] = await Promise.all([
         guild.members.fetch({ user: ctx.userId, force: true }),
         guild.members.fetchMe({ force: true }),
      ]);
      const community =
         guild.roles.cache.get("1436225305898389604") ?? guild.roles.everyone;
      return (
         !!channel &&
         // A private thread's audience is its members, not the parent's: its
         // content must never be summarized into the mods channel.
         channel.type !== ChannelType.PrivateThread &&
         !member.user.bot &&
         !!channel
            .permissionsFor(community)
            ?.has([P.ViewChannel, P.ReadMessageHistory]) &&
         !!channel
            .permissionsFor(member)
            ?.has([P.ViewChannel, P.ReadMessageHistory]) &&
         !!channel
            .permissionsFor(bot)
            ?.has([P.ViewChannel, P.ReadMessageHistory])
      );
   } catch {
      return false;
   }
}

export class EscalationToolSource implements ToolSource {
   readonly name = "moderation_escalation";
   private attempted = false;
   constructor(
      private readonly getClient: () => Client,
      private readonly store: ModerationStore,
      private readonly ctx: CapabilityTurnContext,
   ) {}

   async systemPromptSection(): Promise<string> {
      return "";
   }

   tools(): ToolSpec[] {
      return [
         {
            name: "server_escalate_report",
            description:
               "Avisa al equipo de moderación de un reporte serio del mensaje ACTUAL (acoso, amenazas, doxxing, raid). Solo alta/urgente y confianza alta; no bromas, peticiones casuales ni historial. Primero orienta a tickets. No sanciona. El código fija reportante/canal/enlace/objetivos y limita duplicados.",
            inputSchema: {
               type: "object",
               properties: {
                  summary: { type: "string", maxLength: 350 },
                  severity: { type: "string", enum: ["alta", "urgente"] },
                  target_id: {
                     type: "string",
                     description:
                        "Solo un ID mencionado en el mensaje actual; omite si no hay objetivo.",
                  },
               },
               required: ["summary", "severity"],
               additionalProperties: false,
            },
         },
      ];
   }

   async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
      const args = argsSchema.safeParse(input),
         c = this.ctx;
      if (
         name !== "server_escalate_report" ||
         !args.success ||
         this.attempted ||
         !c.guildId ||
         !c.messageId ||
         !escalationCandidate(c.requestText)
      )
         return failure("No hay un reporte actual elegible.");
      const targets = [
         ...(c.requestText ?? "").matchAll(/<@!?(\d{17,20})>/g),
      ].map((m) => m[1]);
      const target =
         args.data.target_id ?? (targets.length === 1 ? targets[0] : "");
      if (target && !targets.includes(target))
         return failure("El objetivo no aparece en el mensaje actual.");
      this.attempted = true;
      if (!(await canEscalateFrom(this.getClient(), c)))
         return failure("El canal o el reporte ya no están disponibles.");
      const guild = await this.getClient().guilds.fetch(c.guildId);
      const channel = await guild.channels.fetch(c.channelId, { force: true });
      if (!channel?.isTextBased() || !("messages" in channel))
         return failure("Canal no disponible.");
      try {
         const trigger = await channel.messages.fetch({
            message: c.messageId,
            force: true,
            cache: false,
         });
         if (
            trigger.author.id !== c.userId ||
            trigger.author.bot ||
            trigger.webhookId ||
            trigger.editedTimestamp ||
            stripBotMention(this.getClient(), trigger.content, guild).trim() !==
               c.requestText
         )
            return failure("El mensaje cambió o fue eliminado.");
      } catch {
         return failure("El mensaje cambió o fue eliminado.");
      }
      const rowId = this.store.reserveEscalation({
         guildId: c.guildId,
         actorId: c.userId,
         targetId: target,
         action: "escalation",
         reason: args.data.summary,
         triggerMessageId: c.messageId,
         channelId: c.channelId,
         outcome: "refused:delivery_unconfirmed",
         timestamp: Date.now(),
      });
      if (rowId === null)
         return {
            status: "success",
            payload: {
               sent: false,
               deduped_or_rate_limited: true,
               note: "No se envió otro aviso. Mantén la orientación a tickets; no prometas notificaciones.",
            },
         };
      try {
         const pingSent = await sendModerationLine(
            this.getClient(),
            this.store,
            c.guildId,
            renderEscalation(c, target, args.data.summary, args.data.severity),
            args.data.severity === "urgente",
            `e${c.messageId}`,
         );
         this.store.finish(
            rowId,
            pingSent ? "escalated:ping_sent" : "escalated",
         );
         log.info(
            {
               guildId: c.guildId,
               triggerMessageId: c.messageId,
               severity: args.data.severity,
               pingSent,
            },
            "moderation.report_escalated",
         );
         return {
            status: "success",
            payload: {
               sent: true,
               ping_sent: pingSent,
               note: "Se envió un aviso para revisión humana, sin sanción.",
            },
         };
      } catch {
         return failure(
            "No pude confirmar el envío del aviso; no afirmes que llegó. Usa el flujo de tickets.",
         );
      }
   }
}

function failure(error: string): ToolHandlerResult {
   return { status: "error", payload: { error } };
}
