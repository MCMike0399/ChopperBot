import type Database from "better-sqlite3";
import type { Client, Guild } from "discord.js";
import { log } from "../../log.js";
import { composeToolSources, type ToolSource } from "../../tools/source.js";
import { CalendarStore } from "../calendar/store.js";
import { CalendarToolSource } from "../calendar/source.js";
import type {
   Capability,
   CapabilityInitDeps,
   CapabilityTurnBundle,
   CapabilityTurnContext,
} from "../capability.js";
import { CONFIGURATION_CAPABILITY_ID } from "../configuration/constants.js";
import { GENERAL_CHAT_CAPABILITY_ID } from "./constants.js";
import {
   renderAssistantPrompt,
   renderGeneralChatPrompt,
   renderModerationPartnerPrompt,
   type CapabilityBindingSnapshot,
   type CapabilitySnapshotEntry,
} from "./preamble.js";
import { guildProfileFor } from "./profile.js";
import {
   createDiscordDirectoryProvider,
   ServerDirectoryToolSource,
} from "./server-tools.js";
import { loadHowToBlock } from "./howto.js";
import { createDiscordConversationProvider } from "../../discord/conversation.js";
import { ConversationToolSource } from "./conversation-tools.js";
import { isModTurn } from "../mod-authority.js";
import {
   BanToolSource,
   createDiscordBanExecutor,
   parseBanRequest,
   verifyLiveModerator,
} from "./moderation-tools.js";
import { BotSelfKnowledge } from "../../moderation/self-knowledge.js";
import { PartnerAccess, moderationSettings } from "../../moderation/access.js";
import { ModerationStore } from "../../moderation/store.js";
import { withBanTrail, sendModerationLine } from "../../moderation/trail.js";
import { AuditLogToolSource } from "./audit-tools.js";
import {
   EscalationToolSource,
   escalationCandidate,
   canEscalateFrom,
} from "./escalation-tools.js";
import {
   ActionToolSource,
   parseActionRequest,
   createDiscordActionExecutor,
   actionToolName,
} from "./action-tools.js";
import { withActionTrail } from "../../moderation/trail.js";
import { verifyAudienceContainment } from "../../discord/audience.js";
import { MemberLookupToolSource } from "./member-tools.js";

/** Read-only calendar tools the assistant gets in guilds with a profile, so
 * "¿qué eventos hay esta semana?" is answerable from any channel. Writes stay
 * in the calendar channel / ticket funnel — never here. */
const ASSISTANT_CALENDAR_TOOLS = [
   "calendar_list_upcoming",
   "calendar_search_events",
   "calendar_get_event",
] as const;

/**
 * Baseline mode for ChopperBot — the community assistant. Not bound to any
 * channel: runs as the fallback whenever the bot is @-mentioned in a channel
 * with no specialized capability bound, inside a guild the bot is already in.
 *
 * In a guild WITH a profile (see profile.ts — today: Revolución Z) it answers
 * as a member of the collective: the system prompt carries the curated
 * community primer (identity, Estatutos, structure, key channels) and the turn
 * gets read-only calendar tools. In any other guild it keeps the original
 * behavior: a generic intro + redirect prompt with no tools.
 *
 * Both variants embed a per-turn snapshot of the other registered capabilities
 * and the channels they live in, so the LLM can redirect users to the right
 * place (e.g. "eso vive en #chat-gestión"). The `configuration` capability is
 * intentionally excluded from the snapshot (admin-only), and this capability
 * never lists itself.
 */
export class GeneralChatCapability implements Capability {
   readonly id = GENERAL_CHAT_CAPABILITY_ID;
   /** Ban writes have an independent gate tied to the current mod message. */
   readonly channelContext = true;
   readonly description =
      "Asistente de la comunidad: conversa con contexto reciente, consulta calendario e historial y ayuda a moderación a revisar hechos y recomendaciones.";

   private getDiscordClient: CapabilityInitDeps["getDiscordClient"] = undefined;
   private getRegistry: CapabilityInitDeps["getRegistry"] = undefined;
   private getRouter: CapabilityInitDeps["getRouter"] = undefined;
   /** Shared DB handle for the read-only calendar tools. The calendar tables
    * are created by CalendarCapability's own migrations, which init()s earlier
    * in app.ts's candidates list — same reuse pattern as event_intake. */
   private db: Database.Database | null = null;
   private readonly selfKnowledge = new BotSelfKnowledge();

   async init(deps: CapabilityInitDeps): Promise<void> {
      await deps.memory.migrate(this.id, []);
      this.getDiscordClient = deps.getDiscordClient;
      this.getRegistry = deps.getRegistry;
      this.getRouter = deps.getRouter;
      this.db = deps.memory.db();
      log.info({ capability: this.id }, "GeneralChatCapability initialized");
   }

   async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
      if (!this.getDiscordClient || !this.getRegistry || !this.getRouter) {
         throw new Error(
            "GeneralChatCapability missing handles (registry/router/client). Was init() called?",
         );
      }
      const snapshot = this.buildCapabilitySnapshot(
         this.getRegistry(),
         this.getRouter(),
         this.getDiscordClient(),
      );

      const profile = guildProfileFor(ctx.guildId);
      if (!profile) {
         return {
            system: renderGeneralChatPrompt(ctx.now, snapshot),
            tools: composeToolSources([]),
            // Lowest tier — thinking OFF. This is the community's chat surface and
            // therefore essentially all the turn volume; it is conversational, and
            // its tools are read-only lookups that need no multi-step plan. Left
            // undeclared it would silently take `ask()`'s `high` default and double
            // the billed output of the busiest path in the bot.
            effort: "low",
         };
      }

      const sources: ToolSource[] = [];
      if (profile.calendarReadTools && this.db) {
         sources.push(
            new CalendarToolSource(
               new CalendarStore(this.db),
               ctx.userId,
               ctx.now.getTime(),
               undefined,
               {
                  include: ASSISTANT_CALENDAR_TOOLS,
                  allowWrite: false,
                  guildId: ctx.guildId ?? undefined,
               },
            ),
         );
      }
      let liveHowTo: string | null = null;
      const moderator = isModTurn(this.db, ctx);
      const parsedBan = moderator ? parseBanRequest(ctx.requestText) : null;
      // Only a request the ban tool can actually serve may be promised in the prompt.
      const banRequest =
         parsedBan && ctx.messageId && this.db ? parsedBan : null;
      const client = this.getDiscordClient();
      const access =
         ctx.guildId &&
         moderator &&
         moderationSettings(this.db, ctx.guildId).moderation_channel_id ===
            ctx.channelId
            ? new PartnerAccess(
                 () => client,
                 this.db,
                 ctx.guildId,
                 ctx.userId,
                 ctx.channelId,
              )
            : null;
      const partner = access && (await access.workspace()) ? access : null;
      const parsedAction = ctx.guildId
         ? parseActionRequest(ctx.requestText, ctx.guildId)
         : null;
      // New effects are restricted to the verified staff workspace. Public
      // ban compatibility is unchanged; public timeout jokes expose no tool.
      const actionRequest =
         partner && parsedAction && ctx.messageId && this.db
            ? parsedAction
            : null;
      // Operational detail (roles, permissions, command syntax) only inside the
      // restricted workspace — a moderator asking in #general gets the short form.
      const knowledge = ctx.guildId
         ? await this.selfKnowledge.block(client, ctx.guildId, !!partner)
         : "";
      if (profile.serverDirectoryTools && ctx.guildId) {
         const getClient = this.getDiscordClient;
         sources.push(
            new MemberLookupToolSource(
               () => client,
               this.db,
               ctx.guildId,
               ctx.userId,
               ctx.channelId,
            ),
         );
         sources.push(
            new ConversationToolSource(
               createDiscordConversationProvider(
                  () => getClient(),
                  ctx.guildId,
                  ctx.userId,
                  ctx.channelId,
                  getClient().user?.id ?? null,
                  partner ?? undefined,
               ),
               ctx.channelId,
               ctx.now.getTime(),
               ctx.messageId,
               moderator,
               () =>
                  verifyLiveModerator(
                     () => getClient(),
                     ctx.guildId!,
                     ctx.userId,
                     this.db,
                  ),
            ),
         );
         if (partner)
            sources.push(
               new AuditLogToolSource(() => client, ctx.guildId, partner),
            );
         if (actionRequest && ctx.messageId && this.db) {
            const store = new ModerationStore(this.db);
            sources.push(
               new ActionToolSource(
                  actionRequest,
                  withActionTrail(
                     createDiscordActionExecutor(
                        () => client,
                        this.db,
                        {
                           ...ctx,
                           guildId: ctx.guildId,
                           messageId: ctx.messageId,
                        },
                        actionRequest,
                     ),
                     store,
                     {
                        guildId: ctx.guildId,
                        actorId: ctx.userId,
                        targetId: actionRequest.targetId,
                        action: actionRequest.action,
                        reason: `${actionRequest.reason}${actionRequest.action === "timeout" ? ` (${actionRequest.durationMs} ms)` : ""}`,
                        triggerMessageId: ctx.messageId,
                        channelId: ctx.channelId,
                        outcome: "executed",
                        timestamp: Date.now(),
                     },
                     async (line) => {
                        if (!(await partner!.verifyDelivery()))
                           throw new Error("workspace_access_revoked");
                        if (actionRequest.action === "message_deleted") {
                           const guild = await client.guilds.fetch(
                              ctx.guildId!,
                           );
                           const source = await guild.channels.fetch(
                              actionRequest.channelId,
                              { force: true },
                           );
                           if (source?.isThread() && source.parentId)
                              await guild.channels.fetch(source.parentId, {
                                 force: true,
                              });
                           const evidenceSource = source?.isThread()
                              ? source.type === 12
                                 ? null
                                 : source.parent
                              : source;
                           const destination = await guild.channels.fetch(
                              store.settings(ctx.guildId!)
                                 .moderation_channel_id!,
                              { force: true },
                           );
                           if (
                              !evidenceSource ||
                              !destination ||
                              !(await verifyAudienceContainment(
                                 guild,
                                 evidenceSource,
                                 destination,
                              ))
                           )
                              throw new Error("workspace_audience_unverified");
                        }
                        await sendModerationLine(
                           client,
                           store,
                           ctx.guildId!,
                           line,
                           false,
                           `m${ctx.messageId}`,
                        );
                     },
                  ),
               ),
            );
         }
         if (parsedAction && !actionRequest && this.db && ctx.messageId) {
            try {
               new ModerationStore(this.db).record({
                  guildId: ctx.guildId,
                  actorId: ctx.userId,
                  targetId: parsedAction.targetId,
                  action: parsedAction.action,
                  reason: parsedAction.reason,
                  triggerMessageId: ctx.messageId,
                  channelId: ctx.channelId,
                  outcome: moderator
                     ? "refused:workspace_required"
                     : "refused:caller_not_moderation",
                  timestamp: Date.now(),
               });
            } catch {
               /* A broken trail cannot authorize an effect. */
            }
         }
         if (banRequest && ctx.messageId && this.db) {
            const store = new ModerationStore(this.db);
            const executor = createDiscordBanExecutor(
               () => client,
               ctx.guildId,
               ctx.userId,
               ctx.channelId,
               ctx.messageId,
               this.db,
               banRequest,
            );
            sources.push(
               new BanToolSource(
                  banRequest,
                  withBanTrail(
                     executor,
                     store,
                     {
                        guildId: ctx.guildId,
                        actorId: ctx.userId,
                        targetId: banRequest.targetId,
                        action: "ban",
                        reason: banRequest.reason,
                        triggerMessageId: ctx.messageId,
                        channelId: ctx.channelId,
                        outcome: "executed",
                        timestamp: Date.now(),
                     },
                     (line) =>
                        sendModerationLine(
                           client,
                           store,
                           ctx.guildId!,
                           line,
                           false,
                           `m${ctx.messageId}`,
                        ),
                  ),
               ),
            );
         }
         if (
            this.db &&
            !moderator &&
            ctx.messageId &&
            escalationCandidate(ctx.requestText) &&
            moderationSettings(this.db, ctx.guildId).moderation_channel_id !==
               ctx.channelId &&
            (await canEscalateFrom(client, ctx))
         ) {
            sources.push(
               new EscalationToolSource(
                  () => client,
                  new ModerationStore(this.db),
                  ctx,
               ),
            );
         }
         const refused = !moderator ? parseBanRequest(ctx.requestText) : null;
         if (refused && this.db && ctx.messageId) {
            try {
               new ModerationStore(this.db).record({
                  guildId: ctx.guildId,
                  actorId: ctx.userId,
                  targetId: refused.targetId,
                  action: "ban",
                  reason: refused.reason,
                  triggerMessageId: ctx.messageId,
                  channelId: ctx.channelId,
                  outcome: "refused:caller_not_moderation",
                  timestamp: Date.now(),
               });
            } catch {
               /* no member effect; degraded DB cannot authorize one */
            }
         }
         sources.push(
            new ServerDirectoryToolSource(
               createDiscordDirectoryProvider(
                  () => getClient(),
                  ctx.guildId,
                  ctx.userId,
               ),
            ),
         );
         liveHowTo = await loadHowToBlock(
            () => getClient(),
            ctx.guildId,
            ctx.userId,
         );
      }
      const system = partner
         ? renderModerationPartnerPrompt(
              ctx.now,
              knowledge,
              ctx.userDisplayName ?? null,
              banRequest?.targetId ?? null,
              actionRequest
                 ? `${actionToolName(actionRequest)} para el ID ${actionRequest.targetId}`
                 : null,
           )
         : renderAssistantPrompt(
              profile,
              ctx.now,
              snapshot,
              this.resolveChannelName(ctx.channelId),
              liveHowTo,
              ctx.userDisplayName ?? null,
              moderator,
              banRequest?.targetId ?? null,
              knowledge,
           );
      const tailAt = system.indexOf("# Contexto del turno");
      return {
         system,
         stableSystem: tailAt >= 0 ? system.slice(0, tailAt).trimEnd() : system,
         systemTail: tailAt >= 0 ? system.slice(tailAt) : undefined,
         tools: composeToolSources(sources),
         verifyDelivery: partner ? () => partner.verifyDelivery() : undefined,
         // Chat/history/review remain low. Only a current, independently
         // authorized moderator ban turns this into a writing loop.
         effort: banRequest || actionRequest ? "high" : "low",
      };
   }

   /** Channel name for the "estás hablando en #…" tone cue; null on cache miss
    * (the prompt just omits the line — never block a turn on it). */
   private resolveChannelName(channelId: string): string | null {
      try {
         const channel =
            this.getDiscordClient?.().channels.cache.get(channelId);
         return channel && "name" in channel && channel.name
            ? (channel.name as string)
            : null;
      } catch {
         return null;
      }
   }

   private buildCapabilitySnapshot(
      registry: ReturnType<NonNullable<CapabilityInitDeps["getRegistry"]>>,
      router: ReturnType<NonNullable<CapabilityInitDeps["getRouter"]>>,
      client: Client,
   ): CapabilitySnapshotEntry[] {
      // Invert the channel→capability map into capability→channels.
      const bindingsByCapability = new Map<string, string[]>();
      for (const [channelId, capabilityId] of router.getAllBindings()) {
         const list = bindingsByCapability.get(capabilityId) ?? [];
         list.push(channelId);
         bindingsByCapability.set(capabilityId, list);
      }

      const entries: CapabilitySnapshotEntry[] = [];
      for (const cap of registry.list()) {
         if (cap.id === this.id) continue;
         if (cap.id === CONFIGURATION_CAPABILITY_ID) continue;
         const channelIds = bindingsByCapability.get(cap.id) ?? [];
         const bindings = channelIds.map((cid) => resolveBinding(client, cid));
         entries.push({ id: cap.id, description: cap.description, bindings });
      }
      return entries;
   }
}

function resolveBinding(
   client: Client,
   channelId: string,
): CapabilityBindingSnapshot {
   const channel = client.channels.cache.get(channelId);
   const channelName =
      channel && "name" in channel && channel.name
         ? (channel.name as string)
         : null;
   const guild =
      channel && "guild" in channel && channel.guild
         ? (channel.guild as Guild)
         : null;
   const guildId = guild?.id ?? null;
   const guildName = guild?.name ?? null;
   const url = guildId
      ? `https://discord.com/channels/${guildId}/${channelId}`
      : null;
   return { channelId, channelName, guildId, guildName, url };
}
