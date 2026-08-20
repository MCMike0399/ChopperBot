import { PermissionFlagsBits, type Client } from "discord.js";
import type Database from "better-sqlite3";
import { config } from "../../config.js";
import { log } from "../../log.js";
import type {
   ToolHandlerResult,
   ToolSource,
   ToolSpec,
} from "../../tools/source.js";
import { EventIntakeStore } from "../event_intake/store.js";
import {
   DEFAULT_MOD_ROLES,
   resolveModMentions,
} from "../../discord/mod-roles.js";
import { DEFAULT_AGITPROP_ROLES } from "../event_intake/constants.js";
import { parseChannelIdEnv } from "../file_scanner/store.js";

export interface ConfigEventIntakeAdminDeps {
   db: Database.Database;
   callerUserId: string;
   /** Guild the config channel lives in — resolves the "este servidor" keyword. */
   guildId: string | null;
   /** Resolves the approver roles to see whether the bot can really ping them. */
   client: Client;
}

/**
 * Manage the ticket event-intake from the config channel: see what it watches +
 * who can approve, change the watched ticket categories, set the approver roles,
 * and review recent tickets. Talks to {@link EventIntakeStore} on the shared db
 * (the live listener re-reads the watched set within ~10 s, so changes take
 * effect without a restart).
 */
export class ConfigEventIntakeAdminSource implements ToolSource {
   readonly name = "config_eventintake";
   private readonly store: EventIntakeStore;

   constructor(private readonly deps: ConfigEventIntakeAdminDeps) {
      this.store = new EventIntakeStore(deps.db);
   }

   async systemPromptSection(): Promise<string> {
      return "";
   }

   tools(): ToolSpec[] {
      return [
         {
            name: "config_eventintake",
            description:
               "Admin the ticket event-intake (works from the config channel). `action`:\n" +
               '• "status" — watched ticket categories, the approver roles (and whether the bot can really @-mention them in a ticket), and recent ticket count.\n' +
               '• "list_categories" — the category/channel ids currently watched.\n' +
               '• "set_categories" {channels} — REPLACE the watched set. `channels` may be: comma/space-separated CATEGORY (or channel) ids or a JSON array; "este servidor" to watch every channel the bot sees in THIS server; "todos"/"all"; explicit `guild:<serverId>` tokens; or empty to stop. Takes effect within ~10s (no restart).\n' +
               '• "set_mod_roles" {roles} — REPLACE who can approve. `roles` is a comma-separated list or JSON array of role NAMES (e.g. "Moderador, Administrador, Administradora") or role ids. Empty resets to the defaults.\n' +
               '• "set_agitprop_channel" {channel} — REPLACE the Agitprop flyer inbox channel id (snowflake), or empty to clear.\n' +
               '• "set_agitprop_roles" {roles} — REPLACE who may fulfill/manage flyer jobs (names or ids). Empty → "Agitprop".\n' +
               '• "recent_tickets" — the latest tickets seen (status + resolved event).',
            inputSchema: {
               type: "object",
               properties: {
                  action: {
                     type: "string",
                     enum: [
                        "status",
                        "list_categories",
                        "set_categories",
                        "set_mod_roles",
                        "set_agitprop_channel",
                        "set_agitprop_roles",
                        "recent_tickets",
                     ],
                  },
                  channels: {
                     type: "string",
                     description:
                        'For set_categories: comma/space ids or JSON array; "este servidor"/"todos"; or empty to clear.',
                  },
                  roles: {
                     type: "string",
                     description:
                        "For set_mod_roles / set_agitprop_roles: comma-separated role names/ids or a JSON array.",
                  },
                  channel: {
                     type: "string",
                     description:
                        "For set_agitprop_channel: a channel snowflake, or empty to clear.",
                  },
               },
               required: ["action"],
            },
         },
      ];
   }

   /** Can we really notify the approver roles from this server? (null = unknown) */
   private pingability(): ReturnType<typeof pingabilityOf> {
      try {
         return pingabilityOf(
            this.deps.client,
            this.deps.guildId,
            this.store.getModRoles(),
         );
      } catch {
         return null;
      }
   }

   private agitpropPingability(): ReturnType<typeof pingabilityOf> {
      try {
         return pingabilityOf(
            this.deps.client,
            this.deps.guildId,
            this.store.getAgitpropRoles().length > 0
               ? this.store.getAgitpropRoles()
               : [...DEFAULT_AGITPROP_ROLES],
         );
      } catch {
         return null;
      }
   }

   async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
      if (toolName !== "config_eventintake") {
         return {
            status: "error",
            payload: { error: `Unknown tool: ${toolName}` },
         };
      }
      const obj = (input ?? {}) as Record<string, unknown>;
      const action = String(obj.action ?? "");
      try {
         switch (action) {
            case "status": {
               const categories = this.store.getWatchedCategories();
               const roles = this.store.getModRoles();
               const recent = this.store.recentTickets(5).map((t) => ({
                  channelId: t.channel_id,
                  status: t.status,
                  createdEventId: t.created_event_id,
               }));
               const ping = this.pingability();
               const agitpropPing = this.agitpropPingability();
               const openFlyers = this.store.openFlyerJobs(5);
               const agitpropChannel = this.store.getAgitpropChannelId();
               const agitpropRoles = this.store.getAgitpropRoles();
               const lines = [
                  "📋 **Event intake (tickets)**",
                  categories.length === 0
                     ? "• Categorías vigiladas: (ninguna — configúralas con `set_categories`)"
                     : `• Categorías vigiladas: ${categories.map((c) => `\`${c}\``).join(", ")}`,
                  `• Roles que pueden aprobar: ${(roles.length > 0 ? roles : [...DEFAULT_MOD_ROLES]).join(", ")}`,
                  ping
                     ? `• Aviso a mods en el ticket: ${
                          ping.pingable.length > 0
                             ? `sí, se notifica a ${ping.pingable.join(", ")}`
                             : "NO se notifica a nadie (ningún rol aprobador es mencionable)"
                       }`
                     : "• Aviso a mods en el ticket: (no pude resolver los roles de este servidor)",
                  ...(ping && ping.silent.length > 0
                     ? [
                          `• ⚠️ Sin notificación: ${ping.silent.join(", ")} — marca el rol como *mencionable* (Ajustes del rol → “Permitir que cualquiera mencione este rol”) o dale al bot el permiso “Mencionar @everyone, @here y todos los roles”.`,
                       ]
                     : []),
                  `• Canal Agitprop (flyers): ${agitpropChannel ? `<#${agitpropChannel}> (\`${agitpropChannel}\`)` : "(sin configurar — `set_agitprop_channel`)"}`,
                  `• Roles Agitprop: ${(agitpropRoles.length > 0 ? agitpropRoles : [...DEFAULT_AGITPROP_ROLES]).join(", ")}`,
                  agitpropPing
                     ? `• Aviso a Agitprop: ${
                          agitpropPing.pingable.length > 0
                             ? `sí, se notifica a ${agitpropPing.pingable.join(", ")}`
                             : "NO se notifica a nadie (ningún rol Agitprop es mencionable)"
                       }`
                     : "• Aviso a Agitprop: (no pude resolver los roles de este servidor)",
                  `• Flyers abiertos: ${openFlyers.length}`,
                  `• Bot de tickets: \`${config.EVENT_INTAKE_TICKET_BOT_ID}\``,
                  `• Tickets recientes: ${recent.length}`,
               ];
               return {
                  status: "success",
                  payload: {
                     message: lines.join("\n"),
                     categories,
                     roles,
                     mod_ping: ping,
                     agitprop_channel_id: agitpropChannel,
                     agitprop_roles:
                        agitpropRoles.length > 0
                           ? agitpropRoles
                           : [...DEFAULT_AGITPROP_ROLES],
                     agitprop_ping: agitpropPing,
                     open_flyer_jobs: openFlyers.length,
                     recent,
                  },
               };
            }
            case "list_categories":
               return {
                  status: "success",
                  payload: { categories: this.store.getWatchedCategories() },
               };
            case "set_categories": {
               const raw = (
                  typeof obj.channels === "string" ? obj.channels : ""
               ).trim();
               const kw = raw.toLowerCase();
               let ids: string[];
               if (kw === "all" || kw === "todos") {
                  ids = ["all"];
               } else if (
                  [
                     "este servidor",
                     "server",
                     "servidor",
                     "guild",
                     "here",
                     "this server",
                  ].includes(kw)
               ) {
                  if (!this.deps.guildId) {
                     return {
                        status: "error",
                        payload: {
                           error: "No puedo resolver el servidor actual (mensaje sin guild).",
                        },
                     };
                  }
                  ids = [`guild:${this.deps.guildId}`];
               } else {
                  ids = parseChannelIdEnv(raw);
               }
               const isValid = (t: string) =>
                  /^\d{17,20}$/.test(t) ||
                  t === "all" ||
                  /^guild:\d{17,20}$/.test(t);
               const invalid = ids.filter((t) => !isValid(t));
               if (invalid.length > 0) {
                  return {
                     status: "error",
                     payload: {
                        error: `No reconozco estos valores: ${invalid.join(", ")} (usa ids de categoría/canal, "guild:<idServidor>", "este servidor" o "todos").`,
                     },
                  };
               }
               this.store.setWatchedCategories(ids);
               log.info(
                  { tool: toolName, watched: ids, by: this.deps.callerUserId },
                  "event_intake.set_categories",
               );
               const note =
                  ids.length === 0
                     ? "Listo: ya no vigilo ninguna categoría de tickets."
                     : `Ahora vigilo ${ids.length} categoría(s)/canal(es) de tickets. Toma efecto en ~10s.`;
               return { status: "success", payload: { watched: ids, note } };
            }
            case "set_mod_roles": {
               const roles = parseRoleList(
                  typeof obj.roles === "string" ? obj.roles : "",
               );
               this.store.setModRoles(roles);
               log.info(
                  { tool: toolName, roles, by: this.deps.callerUserId },
                  "event_intake.set_mod_roles",
               );
               const effective =
                  roles.length > 0 ? roles : [...DEFAULT_MOD_ROLES];
               const ping = this.pingability();
               const warn =
                  ping && ping.pingable.length === 0
                     ? " ⚠️ Ojo: no puedo NOTIFICAR a ninguno de esos roles en los tickets (ninguno es mencionable). Marca al menos uno como mencionable."
                     : "";
               return {
                  status: "success",
                  payload: {
                     roles,
                     mod_ping: ping,
                     note: `Roles que pueden aprobar: ${effective.join(", ")}${roles.length === 0 ? " (predeterminados)" : ""}.${warn}`,
                  },
               };
            }
            case "set_agitprop_channel": {
               const raw = (
                  typeof obj.channel === "string" ? obj.channel : ""
               ).trim();
               if (!raw) {
                  this.store.setAgitpropChannelId(null);
                  return {
                     status: "success",
                     payload: {
                        note: "Canal Agitprop desactivado (ya no se envían solicitudes de flyer).",
                     },
                  };
               }
               if (!/^\d{17,20}$/.test(raw)) {
                  return {
                     status: "error",
                     payload: {
                        error: "El canal debe ser un id de Discord (snowflake).",
                     },
                  };
               }
               this.store.setAgitpropChannelId(raw);
               log.info(
                  { tool: toolName, channel: raw, by: this.deps.callerUserId },
                  "event_intake.set_agitprop_channel",
               );
               return {
                  status: "success",
                  payload: {
                     agitprop_channel_id: raw,
                     note: `Canal Agitprop: <#${raw}>. Toma efecto de inmediato.`,
                  },
               };
            }
            case "set_agitprop_roles": {
               const roles = parseRoleList(
                  typeof obj.roles === "string" ? obj.roles : "",
               );
               this.store.setAgitpropRoles(roles);
               log.info(
                  { tool: toolName, roles, by: this.deps.callerUserId },
                  "event_intake.set_agitprop_roles",
               );
               const effective =
                  roles.length > 0 ? roles : [...DEFAULT_AGITPROP_ROLES];
               const ping = this.agitpropPingability();
               const warn =
                  ping && ping.pingable.length === 0
                     ? " ⚠️ Ojo: no puedo NOTIFICAR a Agitprop (ningún rol es mencionable)."
                     : "";
               return {
                  status: "success",
                  payload: {
                     agitprop_roles: roles,
                     agitprop_ping: ping,
                     note: `Roles Agitprop: ${effective.join(", ")}${roles.length === 0 ? " (predeterminados)" : ""}.${warn}`,
                  },
               };
            }
            case "recent_tickets": {
               const recent = this.store.recentTickets(10).map((t) => ({
                  channel_id: t.channel_id,
                  requester_id: t.requester_id,
                  status: t.status,
                  created_event_id: t.created_event_id,
                  flyer_status: t.flyer_status,
                  updated_at_iso: new Date(t.updated_at).toISOString(),
               }));
               return { status: "success", payload: { recent } };
            }
            default:
               return {
                  status: "error",
                  payload: { error: `Unknown action: ${action}` },
               };
         }
      } catch (err) {
         log.warn({ tool: toolName, err }, "tool_call_failed");
         return {
            status: "error",
            payload: {
               error: err instanceof Error ? err.message : String(err),
            },
         };
      }
   }
}

/**
 * Whether the approver roles of the config channel's guild can actually be
 * @-mentioned by the bot — the difference between "mods get notified" and "a
 * chip that pings nobody", which is otherwise invisible from Discord. Uses the
 * GUILD-level permission (a category override could still grant it in the
 * tickets themselves, which the watcher resolves per channel).
 */
function pingabilityOf(
   client: Client,
   guildId: string | null,
   tokens: string[],
): { pingable: string[]; silent: string[]; can_mention_any: boolean } | null {
   if (!guildId) return null;
   const guild = client.guilds.cache.get(guildId);
   if (!guild) return null;
   const canMentionAny =
      guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone) ??
      false;
   const resolved = resolveModMentions(
      guild.roles.cache.map((r) => ({
         id: r.id,
         name: r.name,
         mentionable: r.mentionable,
      })),
      tokens,
      { canMentionAny },
   );
   return {
      pingable: resolved.notifies
         ? resolved.matched
              .filter((r) => !resolved.silent.includes(r))
              .map((r) => r.name)
         : [],
      silent: resolved.silent.map((r) => r.name),
      can_mention_any: canMentionAny,
   };
}

/** Role tokens: JSON array, or comma-separated (so multi-word names survive). */
function parseRoleList(raw: string): string[] {
   const trimmed = raw.trim();
   if (!trimmed) return [];
   if (trimmed.startsWith("[")) {
      try {
         const arr = JSON.parse(trimmed);
         if (Array.isArray(arr)) return dedupe(arr.map((x) => String(x)));
      } catch {
         // fall through
      }
   }
   return dedupe(trimmed.split(",").map((s) => s.trim()));
}

function dedupe(items: string[]): string[] {
   return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}
