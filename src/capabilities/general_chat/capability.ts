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
   type CapabilityBindingSnapshot,
   type CapabilitySnapshotEntry,
} from "./preamble.js";
import { guildProfileFor } from "./profile.js";
import {
   createDiscordDirectoryProvider,
   ServerDirectoryToolSource,
} from "./server-tools.js";

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
   readonly description =
      "Asistente de la comunidad y conversación base de ChopperBot. Responde desde los principios del servidor, orienta a los canales correctos y consulta el calendario en solo lectura.";

   private getDiscordClient: CapabilityInitDeps["getDiscordClient"] = undefined;
   private getRegistry: CapabilityInitDeps["getRegistry"] = undefined;
   private getRouter: CapabilityInitDeps["getRouter"] = undefined;
   /** Shared DB handle for the read-only calendar tools. The calendar tables
    * are created by CalendarCapability's own migrations, which init()s earlier
    * in app.ts's candidates list — same reuse pattern as event_intake. */
   private db: Database.Database | null = null;

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
               },
            ),
         );
      }
      if (profile.serverDirectoryTools && ctx.guildId) {
         const getClient = this.getDiscordClient;
         sources.push(
            new ServerDirectoryToolSource(
               createDiscordDirectoryProvider(
                  () => getClient(),
                  ctx.guildId,
                  ctx.userId,
               ),
            ),
         );
      }
      return {
         system: renderAssistantPrompt(
            profile,
            ctx.now,
            snapshot,
            this.resolveChannelName(ctx.channelId),
         ),
         tools: composeToolSources(sources),
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
