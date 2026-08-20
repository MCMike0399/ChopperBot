import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { config } from "../../config.js";
import { log } from "../../log.js";
import type {
   ToolHandlerResult,
   ToolSource,
   ToolSpec,
} from "../../tools/source.js";
import {
   CalendarStore,
   type CalendarEvent,
   type UpdateEventInput,
} from "../calendar/store.js";
import {
   countOccurrencesUntil,
   isRecurrenceFreq,
   MAX_RECURRENCE_COUNT,
   RECURRENCE_FREQUENCIES,
   untilFromCount,
   type RecurrenceFreq,
} from "../calendar/recurrence.js";
import { formatInTimezone } from "../calendar/time.js";
import { CalendarAnnouncer } from "../calendar/announcer.js";
import { resolveAnnounceSettings } from "../calendar/announce-settings.js";
import {
   diagnoseEventAccess,
   fetchScheduledEvents,
} from "../calendar/discord-events.js";
import { parseChannelIdEnv } from "../file_scanner/store.js";
import { EventIntakeStore } from "../event_intake/store.js";
import type { UserDirectory } from "../../users/store.js";

export interface ConfigCalendarAdminDeps {
   db: Database.Database;
   userDirectory: UserDirectory;
   callerUserId: string;
   /** Needed by the announcement + Discord-event actions (absent in unit tests). */
   client?: Client;
   /** The guild the console lives in — used for the Discord-event diagnosis. */
   guildId?: string | null;
}

/**
 * Calendar admin from the config channel. The calendar is GLOBAL, so this is
 * just the same shared store reached from the admin console — handy for
 * inspecting/repairing events without going to the input channel, and for
 * pointing the calendar at a different output channel.
 */
export class ConfigCalendarAdminSource implements ToolSource {
   readonly name = "config_calendar";
   private readonly store: CalendarStore;

   constructor(private readonly deps: ConfigCalendarAdminDeps) {
      this.store = new CalendarStore(deps.db);
   }

   async systemPromptSection(): Promise<string> {
      return "";
   }

   tools(): ToolSpec[] {
      return [
         {
            name: "config_calendar",
            description:
               "Admin of the GLOBAL server calendar from the config channel. `action`:\n" +
               '• "peek" {limit?} — list events (each row shows the creator id + tag).\n' +
               '• "create" {title, start_at_iso, end_at_iso?, description?, location?, recurrence_freq?, recurrence_count?, recurrence_until_iso?} — create an event.\n' +
               '• "update" {event_id, confirm, ...same fields} — edit any event (whole series for recurring). Requires confirm:true.\n' +
               '• "delete" {event_id, confirm} — delete any event (whole series for recurring). Requires confirm:true.\n' +
               '• "get_output_channel" — show the channel where month PDFs + ICS are published.\n' +
               '• "set_output_channel" {channel_id} — change that output channel.\n' +
               '• "announce_status" — the daily same-day announcement: channel, hour, who it pings, what it would post TODAY (a dry run: resolves each of today\'s events to its Discord event and renders the text) and the last announcements sent.\n' +
               '• "set_announce_channel" {channel_id} — where the daily announcement posts (the community #anuncios).\n' +
               '• "set_announce_mentions" {mentions} — who it pings: role ids and/or the word "everyone", comma-separated. Empty string = ping nobody.\n' +
               '• "announce_now" {confirm} — post today\'s announcement immediately (ignores the hour gate). Requires confirm:true; skips events already announced unless `repost:true`.\n' +
               '• "discord_events" — Discord scheduled events the bot can see + whether it may create them (diagnoses the "Gestionar eventos" permission and hidden voice channels).\n' +
               "NOTE: create/update/delete here do NOT auto-publish; mutations from the config channel only change the DB. Use the input channel (or ask a mod to run `calendar_publish` there) to re-post the rendered PDFs. Pass times as ISO 8601 UTC.",
            inputSchema: {
               type: "object",
               properties: {
                  action: {
                     type: "string",
                     enum: [
                        "peek",
                        "create",
                        "update",
                        "delete",
                        "get_output_channel",
                        "set_output_channel",
                        "announce_status",
                        "set_announce_channel",
                        "set_announce_mentions",
                        "announce_now",
                        "discord_events",
                     ],
                  },
                  mentions: {
                     type: "string",
                     description:
                        'For "set_announce_mentions": comma/space list of role snowflakes and/or the literal "everyone". Empty string clears (announce without pinging).',
                  },
                  repost: {
                     type: "boolean",
                     description:
                        'For "announce_now": also re-announce events already announced today.',
                  },
                  event_id: {
                     type: "integer",
                     minimum: 1,
                     description: 'Required for "update"/"delete".',
                  },
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  start_at_iso: {
                     type: "string",
                     description: "ISO 8601 UTC.",
                  },
                  end_at_iso: {
                     type: "string",
                     description:
                        "ISO 8601 UTC, or null to clear (update only).",
                  },
                  description: { type: "string" },
                  location: { type: "string" },
                  recurrence_freq: {
                     description:
                        "daily/weekly/monthly, or null to clear recurrence (update).",
                     oneOf: [
                        { type: "string", enum: [...RECURRENCE_FREQUENCIES] },
                        { type: "null" },
                     ],
                  },
                  recurrence_count: {
                     type: "integer",
                     minimum: 1,
                     maximum: MAX_RECURRENCE_COUNT,
                     description:
                        "Bound the series to N occurrences counting the first. Requires recurrence_freq; mutually exclusive with recurrence_until_iso.",
                  },
                  recurrence_until_iso: {
                     description:
                        "ISO 8601 UTC last occurrence, or null to clear (open-ended). Mutually exclusive with recurrence_count.",
                     oneOf: [{ type: "string" }, { type: "null" }],
                  },
                  channel_id: {
                     type: "string",
                     description: 'Discord snowflake for "set_output_channel".',
                  },
                  limit: {
                     type: "integer",
                     minimum: 1,
                     maximum: 50,
                     description: 'For "peek".',
                  },
                  confirm: {
                     type: "boolean",
                     description: 'Must be true for "update"/"delete".',
                  },
               },
               required: ["action"],
            },
         },
      ];
   }

   async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
      if (toolName !== "config_calendar") {
         return {
            status: "error",
            payload: { error: `Unknown tool: ${toolName}` },
         };
      }
      const t0 = Date.now();
      try {
         const obj = (input ?? {}) as Record<string, unknown>;
         const action = asAction(obj.action, [
            "peek",
            "create",
            "update",
            "delete",
            "get_output_channel",
            "set_output_channel",
            "announce_status",
            "set_announce_channel",
            "set_announce_mentions",
            "announce_now",
            "discord_events",
         ]);
         switch (action) {
            case "peek":
               return this.handlePeek(obj);
            case "create":
               return this.handleCreate(obj, t0);
            case "update":
               return this.handleUpdate(obj, t0);
            case "delete":
               return this.handleDelete(obj, t0);
            case "get_output_channel":
               return {
                  status: "success",
                  payload: {
                     output_channel_id: this.store.getOutputChannelId(),
                  },
               };
            case "set_output_channel":
               return this.handleSetOutputChannel(obj);
            case "announce_status":
               return await this.handleAnnounceStatus();
            case "set_announce_channel":
               return this.handleSetAnnounceChannel(obj);
            case "set_announce_mentions":
               return this.handleSetAnnounceMentions(obj);
            case "announce_now":
               return await this.handleAnnounceNow(obj);
            case "discord_events":
               return await this.handleDiscordEvents();
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

   private handlePeek(obj: Record<string, unknown>): ToolHandlerResult {
      const limit = clampInt(obj.limit, 1, 50, 20);
      const rows = this.store.listAll().slice(0, limit);
      return {
         status: "success",
         payload: { events: rows.map((e) => this.serialize(e)) },
      };
   }

   private handleCreate(
      obj: Record<string, unknown>,
      t0: number,
   ): ToolHandlerResult {
      const title = asNonEmptyString(obj.title, "title");
      const startMs = parseRequiredIso(obj.start_at_iso, "start_at_iso");
      const endMs = parseOptionalIso(obj.end_at_iso, "end_at_iso");
      if (endMs !== null && endMs < startMs) {
         return {
            status: "error",
            payload: { error: "end_at_iso must be after start_at_iso." },
         };
      }
      const recurrenceFreq = parseRecurrenceFreq(obj.recurrence_freq);
      const recurrenceUntil = resolveUntil(obj, startMs, recurrenceFreq);
      if (recurrenceUntil !== null && recurrenceFreq === null) {
         return {
            status: "error",
            payload: {
               error: "recurrence_until_iso requires recurrence_freq to also be set.",
            },
         };
      }
      if (recurrenceUntil !== null && recurrenceUntil < startMs) {
         return {
            status: "error",
            payload: {
               error: "recurrence_until_iso must be on or after start_at_iso.",
            },
         };
      }
      const created = this.store.create({
         created_by: this.deps.callerUserId,
         title,
         start_at: startMs,
         end_at: endMs,
         description: asOptionalString(obj.description),
         location: asOptionalString(obj.location),
         recurrence_freq: recurrenceFreq,
         recurrence_until: recurrenceUntil,
      });
      log.info(
         {
            tool: "config_calendar.create",
            id: created.id,
            ms: Date.now() - t0,
         },
         "tool_call",
      );
      return { status: "success", payload: { event: this.serialize(created) } };
   }

   private handleUpdate(
      obj: Record<string, unknown>,
      t0: number,
   ): ToolHandlerResult {
      const eventId = asPositiveInt(obj.event_id, "event_id");
      if (obj.confirm !== true) {
         return {
            status: "error",
            payload: { error: "Refusing to edit without `confirm: true`." },
         };
      }
      const patch: UpdateEventInput = {};
      if (obj.title !== undefined)
         patch.title = asNonEmptyString(obj.title, "title");
      if (obj.start_at_iso !== undefined)
         patch.start_at = parseRequiredIso(obj.start_at_iso, "start_at_iso");
      if (obj.end_at_iso !== undefined) {
         patch.end_at =
            obj.end_at_iso === null
               ? null
               : parseRequiredIso(obj.end_at_iso, "end_at_iso");
      }
      if (obj.description !== undefined)
         patch.description = asOptionalString(obj.description);
      if (obj.location !== undefined)
         patch.location = asOptionalString(obj.location);
      if (obj.recurrence_freq !== undefined)
         patch.recurrence_freq = parseRecurrenceFreq(obj.recurrence_freq);
      if (
         obj.recurrence_count !== undefined ||
         obj.recurrence_until_iso !== undefined
      ) {
         const existing = this.store.get(eventId);
         if (!existing)
            return {
               status: "error",
               payload: { error: `Event #${eventId} not found.` },
            };
         const effectiveStart = patch.start_at ?? existing.start_at;
         const effectiveFreq =
            patch.recurrence_freq !== undefined
               ? patch.recurrence_freq
               : existing.recurrence_freq;
         patch.recurrence_until = resolveUntil(
            obj,
            effectiveStart,
            effectiveFreq,
         );
      }
      if (Object.keys(patch).length === 0) {
         return { status: "error", payload: { error: "No fields to update." } };
      }
      const updated = this.store.update(eventId, patch);
      if (!updated)
         return {
            status: "error",
            payload: { error: `Event #${eventId} not found.` },
         };
      log.info(
         { tool: "config_calendar.update", id: eventId, ms: Date.now() - t0 },
         "tool_call",
      );
      return { status: "success", payload: { event: this.serialize(updated) } };
   }

   private handleDelete(
      obj: Record<string, unknown>,
      t0: number,
   ): ToolHandlerResult {
      const eventId = asPositiveInt(obj.event_id, "event_id");
      if (obj.confirm !== true) {
         return {
            status: "error",
            payload: {
               error: "Refusing destructive delete without `confirm: true`.",
            },
         };
      }
      const deleted = this.store.delete(eventId);
      if (!deleted)
         return {
            status: "error",
            payload: { error: `Event #${eventId} not found.` },
         };
      log.info(
         { tool: "config_calendar.delete", id: eventId, ms: Date.now() - t0 },
         "tool_call",
      );
      return {
         status: "success",
         payload: {
            deleted: {
               id: deleted.id,
               title: deleted.title,
               recurrence_freq: deleted.recurrence_freq,
            },
         },
      };
   }

   private handleSetOutputChannel(
      obj: Record<string, unknown>,
   ): ToolHandlerResult {
      const channelId = asSnowflake(obj.channel_id, "channel_id");
      this.store.setOutputChannelId(channelId);
      log.info(
         { tool: "config_calendar.set_output_channel", channel_id: channelId },
         "tool_call",
      );
      return { status: "success", payload: { output_channel_id: channelId } };
   }

   // ── Daily announcement ─────────────────────────────────────────────────────

   /**
    * The announcement's configuration AND a dry run of what it would post today.
    * Both in one call on purpose: "is the announcement working?" is really the
    * question "what would it say", and answering it without a preview means the
    * operator only finds out in the community channel.
    */
   private async handleAnnounceStatus(): Promise<ToolHandlerResult> {
      const settings = resolveAnnounceSettings(this.store);
      const channelId = settings.channelId;
      const payload: Record<string, unknown> = {
         announce_channel_id: channelId,
         announce_hour_local: settings.hour,
         timezone: "America/Mexico_City",
         mentions: settings.mentions,
         enabled: channelId !== null,
         recent: this.store.recentAnnouncements(8).map((r) => ({
            key: r.announce_key,
            event_id: r.event_id,
            when_local:
               r.occurrence_start_at !== null
                  ? formatInTimezone(r.occurrence_start_at)
                  : null,
            discord_event_id: r.discord_event_id,
            announced_at_local: formatInTimezone(r.announced_at),
         })),
      };
      const announcer = this.makeAnnouncer();
      if (!announcer) {
         payload.preview =
            "No disponible (sin cliente de Discord en este contexto).";
         return { status: "success", payload };
      }
      const report = await announcer.run({
         force: true,
         dryRun: true,
         ignoreLedger: true,
      });
      payload.preview = {
         reason: report.reason ?? null,
         today: report.announced.map((a) => ({
            event_id: a.eventId,
            title: a.title,
            start_at_local: a.startAtLocal,
            discord_event_link: a.link,
            discord_event_url: a.discordEventUrl,
            text: a.text,
         })),
         missing_discord_event: report.nudged,
      };
      return { status: "success", payload };
   }

   private handleSetAnnounceChannel(
      obj: Record<string, unknown>,
   ): ToolHandlerResult {
      const channelId = asSnowflake(obj.channel_id, "channel_id");
      this.store.setAnnounceChannelId(channelId);
      log.info(
         {
            tool: "config_calendar.set_announce_channel",
            channel_id: channelId,
         },
         "tool_call",
      );
      return { status: "success", payload: { announce_channel_id: channelId } };
   }

   private handleSetAnnounceMentions(
      obj: Record<string, unknown>,
   ): ToolHandlerResult {
      if (typeof obj.mentions !== "string") {
         throw new Error(
            'mentions: pass a string (role ids and/or "everyone", comma-separated; "" to clear)',
         );
      }
      const tokens = parseChannelIdEnv(obj.mentions).filter(
         (t) => /^\d{17,20}$/.test(t) || t.toLowerCase() === "everyone",
      );
      this.store.setAnnounceMentions(tokens);
      log.info(
         { tool: "config_calendar.set_announce_mentions", tokens },
         "tool_call",
      );
      return { status: "success", payload: { mentions: tokens } };
   }

   private async handleAnnounceNow(
      obj: Record<string, unknown>,
   ): Promise<ToolHandlerResult> {
      if (obj.confirm !== true) {
         return {
            status: "error",
            payload: {
               error: "Publicar en el canal de la comunidad requiere `confirm: true`.",
            },
         };
      }
      const announcer = this.makeAnnouncer();
      if (!announcer) {
         return {
            status: "error",
            payload: {
               error: "No hay cliente de Discord disponible en este contexto.",
            },
         };
      }
      const report = await announcer.run({
         force: true,
         ignoreLedger: obj.repost === true,
      });
      log.info(
         {
            tool: "config_calendar.announce_now",
            announced: report.announced.length,
            reason: report.reason,
         },
         "tool_call",
      );
      return {
         status: report.ok ? "success" : "error",
         payload: {
            reason: report.reason ?? null,
            announced: report.announced.map((a) => ({
               event_id: a.eventId,
               title: a.title,
               posted: a.posted,
               discord_event_link: a.link,
               discord_event_url: a.discordEventUrl,
               error: a.error ?? null,
            })),
            missing_discord_event: report.nudged,
         },
      };
   }

   /**
    * What the bot can see and do with Discord's own scheduled events. Exists
    * because both failure modes are invisible: without "Gestionar eventos" the
    * bot can't create events, and events living in voice channels it can't see
    * are simply absent from the list — indistinguishable from "none exist".
    */
   private async handleDiscordEvents(): Promise<ToolHandlerResult> {
      const client = this.deps.client;
      const guildId = this.deps.guildId;
      if (!client || !guildId) {
         return {
            status: "error",
            payload: {
               error: "Sin contexto de servidor para consultar los eventos de Discord.",
            },
         };
      }
      const [events, diagnosis] = await Promise.all([
         fetchScheduledEvents(client, guildId),
         diagnoseEventAccess(client, guildId),
      ]);
      const linked = new Map(
         this.store
            .listAll()
            .filter((e) => e.discord_event_id !== null)
            .map((e) => [e.discord_event_id!, e.id]),
      );
      return {
         status: "success",
         payload: {
            can_create_events: diagnosis.canManageEvents,
            problems: diagnosis.problems,
            hidden_voice_channels: diagnosis.hiddenEventChannels.map(
               (c) => c.name,
            ),
            visible_events:
               events === null
                  ? null
                  : events.map((e) => ({
                       id: e.id,
                       name: e.name,
                       start_at_local: formatInTimezone(e.startAtMs),
                       recurring: e.recurring,
                       url: e.url,
                       linked_calendar_event_id: linked.get(e.id) ?? null,
                    })),
            linked_count: linked.size,
         },
      };
   }

   /** The announcer, wired exactly as the live watcher wires it. */
   private makeAnnouncer(): CalendarAnnouncer | null {
      const client = this.deps.client;
      if (!client) return null;
      const store = this.store;
      return new CalendarAnnouncer({
         client,
         store,
         getAnnounceChannelId: () => resolveAnnounceSettings(store).channelId,
         getAnnounceMentions: () => resolveAnnounceSettings(store).mentions,
         getModRoles: () => new EventIntakeStore(this.deps.db).getModRoles(),
         // Nudges from the console go to the config channel (via the announcer's
         // own fallback) rather than pinging mods out of an admin dry run.
         getManagementChannelId: () => null,
         getAnnounceHour: () => resolveAnnounceSettings(store).hour,
      });
   }

   private serialize(e: CalendarEvent) {
      const owner = this.deps.userDirectory.get(e.created_by);
      return {
         id: e.id,
         title: e.title,
         description: e.description,
         start_at_iso: new Date(e.start_at).toISOString(),
         start_at_local: formatInTimezone(e.start_at),
         end_at_iso:
            e.end_at !== null ? new Date(e.end_at).toISOString() : null,
         location: e.location,
         recurrence_freq: e.recurrence_freq,
         recurrence_until_iso:
            e.recurrence_until !== null
               ? new Date(e.recurrence_until).toISOString()
               : null,
         recurrence_until_local:
            e.recurrence_until !== null
               ? formatInTimezone(e.recurrence_until)
               : null,
         occurrence_count:
            e.recurrence_freq !== null
               ? countOccurrencesUntil(
                    e.start_at,
                    e.recurrence_freq,
                    e.recurrence_until,
                 )
               : 1,
         discord_event_id: e.discord_event_id,
         created_by: e.created_by,
         created_by_tag: owner?.discord_tag ?? null,
      };
   }
}

/**
 * Resolve the admin console's two range spellings into one `recurrence_until`.
 * Mirrors the mod-facing tool (`calendar/source.ts`) so a repair from the config
 * channel bounds a series exactly like the input channel would. An explicit
 * `recurrence_until_iso: null` clears the bound.
 */
function resolveUntil(
   obj: Record<string, unknown>,
   startMs: number,
   freq: RecurrenceFreq | null,
): number | null {
   const hasCount =
      obj.recurrence_count !== undefined && obj.recurrence_count !== null;
   const hasUntil =
      obj.recurrence_until_iso !== undefined &&
      obj.recurrence_until_iso !== null;
   if (hasCount && hasUntil) {
      throw new Error(
         "Pass either recurrence_count OR recurrence_until_iso, not both.",
      );
   }
   if (!hasCount)
      return hasUntil
         ? parseRequiredIso(obj.recurrence_until_iso, "recurrence_until_iso")
         : null;
   if (freq === null)
      throw new Error(
         "recurrence_count requires recurrence_freq to also be set.",
      );
   const count = obj.recurrence_count;
   if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_RECURRENCE_COUNT
   ) {
      throw new Error(
         `recurrence_count: must be an integer between 1 and ${MAX_RECURRENCE_COUNT}`,
      );
   }
   return untilFromCount(startMs, freq, count);
}

function parseRecurrenceFreq(v: unknown): RecurrenceFreq | null {
   if (v === undefined || v === null || v === "") return null;
   if (isRecurrenceFreq(v)) return v;
   throw new Error(
      `recurrence_freq: must be one of ${RECURRENCE_FREQUENCIES.join(", ")}`,
   );
}

function asAction<T extends string>(v: unknown, allowed: readonly T[]): T {
   if (typeof v === "string" && (allowed as readonly string[]).includes(v))
      return v as T;
   throw new Error(
      `action: must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`,
   );
}

function asNonEmptyString(v: unknown, field: string): string {
   if (typeof v !== "string" || !v.trim())
      throw new Error(`${field}: must be a non-empty string`);
   return v.trim();
}

function asOptionalString(v: unknown): string | null {
   if (v === undefined || v === null || v === "") return null;
   if (typeof v !== "string") throw new Error("expected a string");
   return v.trim();
}

function asSnowflake(v: unknown, field: string): string {
   const s = asNonEmptyString(v, field);
   if (!/^\d{17,20}$/.test(s))
      throw new Error(`${field}: must be a Discord snowflake (17–20 digits)`);
   return s;
}

function asPositiveInt(v: unknown, field: string): number {
   if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error(`${field}: must be a positive integer`);
   }
   return v;
}

function clampInt(
   v: unknown,
   min: number,
   max: number,
   fallback: number,
): number {
   if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
   return Math.max(min, Math.min(max, Math.floor(v)));
}

function parseRequiredIso(v: unknown, field: string): number {
   if (typeof v !== "string" || !v.trim()) {
      throw new Error(
         `${field}: required ISO 8601 string (e.g. "2026-06-21T02:00:00Z")`,
      );
   }
   const ms = Date.parse(v);
   if (!Number.isFinite(ms))
      throw new Error(`${field}: "${v}" is not a valid ISO 8601 timestamp`);
   return ms;
}

function parseOptionalIso(v: unknown, field: string): number | null {
   if (v === undefined || v === null || v === "") return null;
   return parseRequiredIso(v, field);
}
