import {
   ChannelType,
   GuildScheduledEventStatus,
   PermissionFlagsBits,
   type Client,
   type GuildBasedChannel,
} from "discord.js";
import { log } from "../../log.js";
import type {
   ToolHandlerResult,
   ToolSource,
   ToolSpec,
} from "../../tools/source.js";

/**
 * Live server-directory tools for the community assistant, so it can answer
 * "¿de qué va #tal-canal?" about channels created AFTER the curated primer was
 * written (2026-08-06: a member asked about the brand-new #bienvenidx and the
 * bot could only shrug — the primer's channel list is a static snapshot).
 *
 * THE SECURITY RULE: everything is filtered by what the ASKING MEMBER can see,
 * not what the bot can see. The bot holds a mod role, so its own view includes
 * staff channels; leaking their existence to a regular member would be worse
 * than not having these tools. A channel the member can't view answers exactly
 * like one that doesn't exist. Member resolution fails CLOSED (tool errors).
 */

/** Provider-neutral channel shape (already member-visibility-filtered). */
export interface DirectoryChannel {
   id: string;
   name: string;
   type: "texto" | "voz" | "anuncios" | "foro" | "escenario";
   categoryName: string | null;
   categoryPosition: number;
   position: number;
   topic: string | null;
}

/** A Discord scheduled event the asking member can see (RSVP / "Me interesa"). */
export interface DirectoryDiscordEvent {
   id: string;
   name: string;
   url: string;
   startAtMs: number;
   location: string | null;
   channelName: string | null;
   status: "programado" | "en_curso";
}

export interface ChannelDirectoryProvider {
   /** Channels of the guild the ASKING MEMBER can view. Throws if the member
    * can't be resolved (fail closed). */
   listViewableChannels(): Promise<DirectoryChannel[]>;
   /**
    * Instructional text on a channel the member can view (pins + recent bot
    * embeds: Ticket Tool "Comenzar formulario", etc.). Null if none / hidden.
    */
   getChannelInstructions?(channelId: string): Promise<string | null>;
   /** Upcoming Discord scheduled events the member can see. */
   listDiscordEvents?(): Promise<DirectoryDiscordEvent[]>;
}

const LIST_TOPIC_MAX = 160;
const INFO_TOPIC_MAX = 800;
const INSTRUCTIONS_MAX = 500;

const TYPE_LABELS: Partial<Record<ChannelType, DirectoryChannel["type"]>> = {
   [ChannelType.GuildText]: "texto",
   [ChannelType.GuildVoice]: "voz",
   [ChannelType.GuildAnnouncement]: "anuncios",
   [ChannelType.GuildForum]: "foro",
   [ChannelType.GuildStageVoice]: "escenario",
};

/** Fold a channel/user string for matching: lowercase, no accents, no emoji
 * decoration (│, emojis, punctuation). Exported for tests. */
export function normalizeChannelQuery(raw: string): string {
   return raw
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
}

/**
 * Find a channel by id, `<#id>` mention, or (normalized) name. Exact name
 * match wins; otherwise unique substring match; ambiguity returns candidates.
 * Pure — exported for tests.
 */
export function findChannel(
   channels: readonly DirectoryChannel[],
   query: string,
): { match?: DirectoryChannel; candidates?: DirectoryChannel[] } {
   const idMatch = query.match(/^(?:<#)?(\d{17,20})>?$/);
   if (idMatch) {
      const byId = channels.find((c) => c.id === idMatch[1]);
      return byId ? { match: byId } : {};
   }
   const q = normalizeChannelQuery(query);
   if (!q) return {};
   const exact = channels.filter((c) => normalizeChannelQuery(c.name) === q);
   if (exact.length === 1) return { match: exact[0] };
   if (exact.length > 1) return { candidates: exact };
   const partial = channels.filter((c) =>
      normalizeChannelQuery(c.name).includes(q),
   );
   if (partial.length === 1) return { match: partial[0] };
   if (partial.length > 1 && partial.length <= 8)
      return { candidates: partial };
   return {};
}

/** Group the directory by category, in server order. Pure — exported for tests. */
export function groupByCategory(
   channels: readonly DirectoryChannel[],
): Array<{ category: string | null; channels: DirectoryChannel[] }> {
   const groups = new Map<string | null, DirectoryChannel[]>();
   const sorted = [...channels].sort(
      (a, b) =>
         a.categoryPosition - b.categoryPosition || a.position - b.position,
   );
   for (const c of sorted) {
      const list = groups.get(c.categoryName) ?? [];
      list.push(c);
      groups.set(c.categoryName, list);
   }
   return [...groups.entries()].map(([category, chans]) => ({
      category,
      channels: chans,
   }));
}

function channelPayload(
   c: DirectoryChannel,
   topicMax: number = LIST_TOPIC_MAX,
): Record<string, unknown> {
   const topic =
      c.topic && c.topic.length > topicMax
         ? `${c.topic.slice(0, topicMax)}…`
         : c.topic;
   return {
      mention: `<#${c.id}>`,
      name: c.name,
      type: c.type,
      category: c.categoryName,
      ...(topic ? { topic } : {}),
   };
}

/** The live discord.js-backed provider. */
export function createDiscordDirectoryProvider(
   getClient: () => Client,
   guildId: string,
   userId: string,
): ChannelDirectoryProvider {
   return {
      async listViewableChannels(): Promise<DirectoryChannel[]> {
         const client = getClient();
         const guild = await client.guilds.fetch(guildId);
         // The member's own permissions — NOT the bot's — decide visibility.
         const member = await guild.members.fetch(userId);
         const channels = await guild.channels.fetch();

         const out: DirectoryChannel[] = [];
         for (const channel of channels.values()) {
            if (!channel) continue;
            const label = TYPE_LABELS[channel.type];
            if (!label) continue; // categories group; threads live inside their parent
            const perms = channel.permissionsFor(member);
            if (!perms?.has(PermissionFlagsBits.ViewChannel)) continue;
            const topicRaw =
               "topic" in channel && typeof channel.topic === "string"
                  ? channel.topic
                  : null;
            const topic =
               topicRaw && topicRaw.length > INFO_TOPIC_MAX
                  ? `${topicRaw.slice(0, INFO_TOPIC_MAX)}…`
                  : topicRaw;
            out.push({
               id: channel.id,
               name: channel.name,
               type: label,
               categoryName: channel.parent?.name ?? null,
               categoryPosition: channel.parent?.position ?? -1,
               position: "position" in channel ? (channel.position ?? 0) : 0,
               topic,
            });
         }
         return out;
      },
      async getChannelInstructions(channelId: string): Promise<string | null> {
         const client = getClient();
         const guild = await client.guilds.fetch(guildId);
         const member = await guild.members.fetch(userId);
         const raw = await guild.channels.fetch(channelId).catch(() => null);
         if (!raw) return null;
         const channel = raw as GuildBasedChannel;
         const perms = channel.permissionsFor(member);
         if (!perms?.has(PermissionFlagsBits.ViewChannel)) return null;
         return readChannelInstructions(channel);
      },
      async listDiscordEvents(): Promise<DirectoryDiscordEvent[]> {
         const client = getClient();
         const guild = await client.guilds.fetch(guildId);
         const member = await guild.members.fetch(userId);
         const events = await guild.scheduledEvents.fetch();
         const out: DirectoryDiscordEvent[] = [];
         for (const e of events.values()) {
            const status = discordEventStatus(e.status);
            if (!status) continue;
            if (e.channelId) {
               const room =
                  e.channel ??
                  guild.channels.cache.get(e.channelId) ??
                  (await guild.channels.fetch(e.channelId).catch(() => null));
               const perms = room?.permissionsFor(member);
               if (!perms?.has(PermissionFlagsBits.ViewChannel)) continue;
            }
            out.push({
               id: e.id,
               name: e.name,
               url: `https://discord.com/events/${guildId}/${e.id}`,
               startAtMs: e.scheduledStartTimestamp ?? 0,
               location: e.entityMetadata?.location ?? e.channel?.name ?? null,
               channelName: e.channel?.name ?? null,
               status,
            });
         }
         return out
            .filter((ev) => ev.startAtMs > 0)
            .sort((a, b) => a.startAtMs - b.startAtMs)
            .slice(0, 15);
      },
   };
}

function discordEventStatus(
   status: GuildScheduledEventStatus,
): DirectoryDiscordEvent["status"] | null {
   if (status === GuildScheduledEventStatus.Active) return "en_curso";
   if (status === GuildScheduledEventStatus.Scheduled) return "programado";
   return null;
}

/** Pins + recent bot embeds, as ChopperBot sees them. Best-effort. */
async function readChannelInstructions(
   channel: GuildBasedChannel,
): Promise<string | null> {
   if (!channel.isTextBased() || !("messages" in channel)) return null;
   const snippets: string[] = [];
   const push = (text: string | null | undefined) => {
      const t = (text ?? "").replace(/\s+/g, " ").trim();
      if (t && !snippets.includes(t)) snippets.push(t);
   };
   try {
      const messages = (
         channel as {
            messages: {
               fetchPinned?: () => Promise<Map<string, unknown>>;
               fetch: (o: { limit: number }) => Promise<Map<string, unknown>>;
            };
         }
      ).messages;
      const pinned = messages.fetchPinned
         ? await messages.fetchPinned().catch(() => new Map())
         : new Map();
      for (const raw of pinned.values()) collectEmbedText(raw, push);
      const recent = await messages.fetch({ limit: 12 });
      for (const raw of recent.values()) {
         const m = raw as { author?: { bot?: boolean } };
         if (!m.author?.bot) continue;
         collectEmbedText(raw, push);
      }
   } catch {
      return snippets.length > 0
         ? snippets.join(" ").slice(0, INSTRUCTIONS_MAX)
         : null;
   }
   if (snippets.length === 0) return null;
   const joined = snippets.join(" — ");
   return joined.length > INSTRUCTIONS_MAX
      ? `${joined.slice(0, INSTRUCTIONS_MAX)}…`
      : joined;
}

function collectEmbedText(
   raw: unknown,
   push: (text: string | null | undefined) => void,
): void {
   const m = raw as {
      content?: string;
      embeds?: Array<{
         title?: string | null;
         description?: string | null;
      }>;
   };
   if (m.content) push(m.content);
   for (const e of m.embeds ?? []) {
      push(e.title);
      push(e.description);
   }
}

export class ServerDirectoryToolSource implements ToolSource {
   readonly name = "server_directory";

   constructor(private readonly provider: ChannelDirectoryProvider) {}

   async systemPromptSection(): Promise<string> {
      return "";
   }

   tools(): ToolSpec[] {
      return [
         {
            name: "server_list_channels",
            description:
               "Directorio EN VIVO de los canales del servidor que la persona que pregunta puede ver (nombre, tipo, categoría y tema). Úsalo cuando pregunten qué canales hay, dónde va algo, o por un canal que no aparece en tu lista de canales clave. Solo muestra lo que esa persona puede ver, así que es seguro responder con lo que devuelva.",
            inputSchema: { type: "object", properties: {} },
         },
         {
            name: "server_channel_info",
            description:
               'Detalles EN VIVO de UN canal: tema real (lo que está escrito en Discord), categoría, tipo, e instrucciones del bot del canal si las hay (p. ej. "Comenzar formulario" vs "Crear Ticket"). `channel` acepta <#id>, id, o nombre. Si el tema dice que el canal es para denuncias, NO lo uses para eventos. Si responde "no existe o no puedes verlo", trátalo como que no existe para esa persona.',
            inputSchema: {
               type: "object",
               properties: {
                  channel: {
                     type: "string",
                     description: "Mención <#id>, id, o nombre del canal.",
                  },
               },
               required: ["channel"],
            },
         },
         {
            name: "server_list_discord_events",
            description:
               'Eventos de Discord EN VIVO (la pestaña Eventos del servidor, a los que se les da "Me interesa"). Úsalo para "dónde reservo", "cómo me apunto", "cuál es el link del evento". Cada uno trae `url`. Los eventos son abiertos: este enlace ES la reserva, no un ticket. Solo lista los que la persona puede ver.',
            inputSchema: { type: "object", properties: {} },
         },
      ];
   }

   async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
      try {
         if (toolName === "server_list_discord_events") {
            const events = this.provider.listDiscordEvents
               ? await this.provider.listDiscordEvents()
               : [];
            return {
               status: "success",
               payload: {
                  total: events.length,
                  note: "Estos son los Eventos de Discord para apuntarse. Asistir es abierto: no hace falta ticket.",
                  events: events.map((e) => ({
                     name: e.name,
                     url: e.url,
                     status: e.status,
                     start_at_iso: new Date(e.startAtMs).toISOString(),
                     ...(e.channelName ? { sala: e.channelName } : {}),
                     ...(e.location ? { location: e.location } : {}),
                  })),
               },
            };
         }
         const channels = await this.provider.listViewableChannels();
         switch (toolName) {
            case "server_list_channels": {
               const grouped = groupByCategory(channels).map((g) => ({
                  category: g.category ?? "(sin categoría)",
                  channels: g.channels.map(channelPayload),
               }));
               return {
                  status: "success",
                  payload: { total: channels.length, categories: grouped },
               };
            }
            case "server_channel_info": {
               const query = String(
                  (input as Record<string, unknown>)?.channel ?? "",
               ).trim();
               if (!query)
                  return {
                     status: "error",
                     payload: { error: "Falta `channel`." },
                  };
               const { match, candidates } = findChannel(channels, query);
               if (match) {
                  const payload: Record<string, unknown> = {
                     channel: channelPayload(match, INFO_TOPIC_MAX),
                  };
                  if (this.provider.getChannelInstructions) {
                     const instructions =
                        await this.provider.getChannelInstructions(match.id);
                     if (instructions) payload.instructions = instructions;
                  }
                  return { status: "success", payload };
               }
               if (candidates && candidates.length > 0) {
                  return {
                     status: "success",
                     payload: {
                        ambiguous: true,
                        candidates: candidates.map((c) => ({
                           mention: `<#${c.id}>`,
                           name: c.name,
                        })),
                     },
                  };
               }
               // Same answer for "hidden from this member" and "doesn't exist":
               // existence must not leak.
               return {
                  status: "error",
                  payload: {
                     error: `Ese canal no existe o la persona no puede verlo: ${query}`,
                  },
               };
            }
            default:
               return {
                  status: "error",
                  payload: { error: `Unknown tool: ${toolName}` },
               };
         }
      } catch (err) {
         log.warn({ tool: toolName, err }, "server_directory.tool_failed");
         return {
            status: "error",
            payload: {
               error: "No pude consultar el directorio del servidor en este momento.",
            },
         };
      }
   }
}
