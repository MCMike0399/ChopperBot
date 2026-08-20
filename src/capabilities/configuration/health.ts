/**
 * Cross-capability health snapshot — the "how is ChopperBot actually doing?"
 * answer in ONE tool call.
 *
 * Why this exists: the admin console already had a `bot_info` (uptime, Node, DB
 * size) plus a per-capability `status` on `config_instagram`, `config_filescanner`
 * and `config_eventintake`. So the single most common operator question needed
 * four or five separate calls, and nothing at all surfaced (a) whether the LLM
 * is answering, (b) which capabilities failed to start, or (c) the calendar's
 * publish state. `bot_info` also reported `BEDROCK_MODEL_ID` as "the model",
 * which has been **legacy and off every hot path** since the 2026-07-13 repoint
 * to Kimi — i.e. the console confidently named a model the bot never calls.
 *
 * Every block is **best-effort and independently guarded**: this is a diagnostic,
 * so one missing table or un-migrated capability must degrade to
 * `{ error: "…" }` for that block instead of failing the whole report. That
 * matters most exactly when something is broken.
 */
import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { config } from "../../config.js";
import { llmHealth, type LlmHealthSnapshot } from "../../llm/health.js";
import type { CapabilityRegistry } from "../registry.js";
import type { MutableCapabilityRouter } from "../routing.js";
import { InstagramMonitorStore } from "../instagram_monitor/store.js";
import { FileScannerStore } from "../file_scanner/store.js";
import { EventIntakeStore } from "../event_intake/store.js";
import { DEFAULT_MOD_ROLES } from "../../discord/mod-roles.js";
import { CalendarStore } from "../calendar/store.js";
import { desiredMonthKeys } from "../calendar/publisher.js";
import { resolveAnnounceSettings } from "../calendar/announce-settings.js";
import { countOccurrencesUntil } from "../calendar/recurrence.js";

const DAY_MS = 86_400_000;

/** Content-filter rejections worth mentioning in `problems`. One is normal
 * noise on a political server; a handful means the text provider is refusing
 * this community's subject matter often enough for an operator to know. */
const CONTENT_FILTER_NOTICE_THRESHOLD = 3;

/** A capability that was expected at boot but whose `init()` threw. */
export interface SkippedCapability {
   id: string;
   error: string;
}

export interface HealthDeps {
   db: Database.Database;
   registry: CapabilityRegistry;
   /** Read-only slice: health never mutates routing. */
   router: Pick<MutableCapabilityRouter, "getAllBindings" | "allChannelIds">;
   client: Client;
   startedAtMs: number;
   dbPath: string;
   /** Capabilities that failed `init()` at boot (from app.ts). */
   skipped: readonly SkippedCapability[];
   nowMs?: number;
}

/** Wrap a block so a broken sub-system can't take the whole report down. */
function safe<T>(fn: () => T): T | { error: string } {
   try {
      return fn();
   } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
   }
}

function iso(ms: number | null | undefined): string | null {
   return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** "2 d 3 h", "4 h 12 m", "45 s" — compact enough for a Discord reply. */
export function humanAge(ms: number): string {
   const s = Math.floor(ms / 1000);
   if (s < 60) return `${s} s`;
   const m = Math.floor(s / 60);
   if (m < 60) return `${m} m`;
   const h = Math.floor(m / 60);
   if (h < 24) return `${h} h ${m % 60} m`;
   return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/**
 * A single overall verdict so the model can lead with it instead of making the
 * operator infer health from a wall of fields. `down` is reserved for "the bot
 * cannot answer at all" (the LLM is failing) — everything else is `degraded`,
 * because a paused IG monitor or a disabled scanner still leaves a working bot.
 */
function overallStatus(signals: {
   llmDegraded: boolean;
   problems: string[];
}): "ok" | "degraded" | "down" {
   if (signals.llmDegraded) return "down";
   return signals.problems.length > 0 ? "degraded" : "ok";
}

export interface HealthReport {
   status: "ok" | "degraded" | "down";
   /** Human-readable reasons behind a non-ok status, most important first. */
   problems: string[];
   runtime: unknown;
   llm: unknown;
   capabilities: unknown;
   discord: unknown;
   instagram_monitor: unknown;
   calendar: unknown;
   file_scanner: unknown;
   event_intake: unknown;
}

export function collectHealth(deps: HealthDeps): HealthReport {
   const now = deps.nowMs ?? Date.now();
   const problems: string[] = [];

   // ── Runtime ───────────────────────────────────────────────────────────────
   const uptimeMs = now - deps.startedAtMs;
   let dbSizeBytes: number | null = null;
   try {
      dbSizeBytes = statSync(deps.dbPath).size;
   } catch {
      dbSizeBytes = null;
   }
   const runtime = {
      uptime_human: humanAge(uptimeMs),
      uptime_ms: uptimeMs,
      started_at_iso: iso(deps.startedAtMs),
      node_version: process.version,
      db_path: deps.dbPath,
      db_size_bytes: dbSizeBytes,
      data_dir: config.CHOPPERBOT_DATA_DIR,
   };
   // A very recent boot is worth flagging: it usually means a crash-restart, and
   // it also explains why in-memory counters (IG requests_24h, LLM health) look empty.
   if (uptimeMs < 10 * 60_000)
      problems.push(`Reinicio reciente: lleva ${humanAge(uptimeMs)} arriba.`);

   // ── LLM (the actual two backends, not the legacy field) ───────────────────
   const llmSnapshot: LlmHealthSnapshot = llmHealth.snapshot();
   const llm = {
      text: {
         backend: "kimi",
         model: config.KIMI_MODEL_ID,
         base_url: config.KIMI_BASE_URL,
         note: "Todo el texto (chat, calendario, event_intake, decisión del clasificador de IG).",
      },
      vision: {
         backend: "bedrock",
         model: config.BEDROCK_MODEL_LOW,
         region: config.AWS_REGION,
         note: "SÓLO imágenes (Kimi 2.7 Thinking es text-only).",
      },
      max_output_tokens: config.MAX_OUTPUT_TOKENS,
      max_tool_iterations: config.MAX_TOOL_ITERATIONS,
      health: llmSnapshot,
   };
   if (llmSnapshot.degraded) {
      problems.push(
         `LLM degradado: ${llmSnapshot.consecutive_failures} fallos consecutivos (${llmSnapshot.last_error ?? "sin detalle"}).`,
      );
   } else if (llmSnapshot.consecutive_failures > 0) {
      problems.push(
         `LLM con ${llmSnapshot.consecutive_failures} fallo(s) consecutivo(s) sin alcanzar el umbral de alerta.`,
      );
   }
   // Not a problem in itself (the backend is fine and the turn recovers on the
   // retry / the other backend), but a spike means members are repeatedly
   // hitting the provider's risk filter — worth naming, not silently counting.
   if (
      llmSnapshot.content_filter_rejections >= CONTENT_FILTER_NOTICE_THRESHOLD
   ) {
      problems.push(
         `El filtro de contenido del proveedor de texto rechazó ${llmSnapshot.content_filter_rejections} prompt(s) desde el arranque (último: ${llmSnapshot.last_content_filter_error ?? "sin detalle"}). No es una falla del bot: reintenta y, si insiste, responde por el backend de imágenes.`,
      );
   }

   // ── Capabilities & routing ────────────────────────────────────────────────
   const bindingsByCapability: Record<string, number> = {};
   for (const capId of deps.router.getAllBindings().values()) {
      bindingsByCapability[capId] = (bindingsByCapability[capId] ?? 0) + 1;
   }
   const registered = deps.registry.list().map((c) => c.id);
   const capabilities = {
      registered,
      /** Failed `init()` at boot — the honest "degraded" signal, with the reason. */
      skipped: deps.skipped.map((s) => ({ id: s.id, error: s.error })),
      bindings_by_capability: bindingsByCapability,
      /** Bound to a capability that isn't registered → messages there are ignored. */
      orphan_bindings: [...deps.router.getAllBindings().entries()]
         .filter(([, capId]) => !deps.registry.has(capId))
         .map(([channelId, capId]) => ({
            channel_id: channelId,
            capability: capId,
         })),
   };
   for (const s of deps.skipped)
      problems.push(`Capability "${s.id}" no arrancó: ${s.error}`);
   if (capabilities.orphan_bindings.length > 0) {
      problems.push(
         `${capabilities.orphan_bindings.length} canal(es) bindeados a una capability no registrada.`,
      );
   }

   const discord = safe(() => ({
      guilds: [...deps.client.guilds.cache.values()].map((g) => ({
         id: g.id,
         name: g.name,
      })),
      bound_channels: deps.router.allChannelIds().size,
   }));

   // ── Instagram monitor (the loudest operational surface) ───────────────────
   const instagram = safe(() => {
      const store = new InstagramMonitorStore(deps.db);
      const rt = store.getRuntime();
      const accounts = store.listAccounts();
      const paused = accounts.filter((a) => a.paused === 1);
      const authBlocked = accounts.filter(
         (a) => a.consecutive_auth_failures >= 5,
      );
      const budget = config.IG_DAILY_REQUEST_BUDGET;
      const used = rt.requests_24h ?? 0;
      if (rt.global_stop === 1) {
         problems.push(
            `Monitor de Instagram DETENIDO (kill-switch): ${rt.stop_reason ?? "sin razón registrada"}. Reanuda con \`config_instagram action:resume_monitor confirm:true\`.`,
         );
      }
      if (rt.budget_pause_until !== null && rt.budget_pause_until > now) {
         problems.push(
            `Monitor de Instagram en pausa por presupuesto hasta ${iso(rt.budget_pause_until)}.`,
         );
      }
      if (rt.rate_cooldown_until !== null && rt.rate_cooldown_until > now) {
         problems.push(
            `Monitor de Instagram en cooldown por rate-limit hasta ${iso(rt.rate_cooldown_until)}.`,
         );
      }
      if (authBlocked.length > 0) {
         problems.push(
            `${authBlocked.length} cuenta(s) de IG auto-pausadas por fallos de autenticación.`,
         );
      }
      return {
         polling_stopped: rt.global_stop === 1,
         stop_reason: rt.stop_reason,
         stopped_at_iso: iso(rt.stopped_at),
         budget_pause_until_iso: iso(rt.budget_pause_until),
         rate_cooldown_until_iso: iso(rt.rate_cooldown_until),
         auth_cooldown_until_iso: iso(rt.auth_cooldown_until),
         requests_24h: used,
         daily_budget: budget,
         budget_used_pct: budget > 0 ? Math.round((used / budget) * 100) : null,
         poll_stretch: Number(rt.poll_stretch.toFixed(3)),
         heartbeat_at_iso: iso(rt.heartbeat_at),
         last_digest_at_iso: iso(rt.last_digest_at),
         accounts_total: accounts.length,
         accounts_paused: paused.length,
         accounts_auth_blocked: authBlocked.length,
         accounts_cold_start: accounts.filter(
            (a) => a.poll_interval_ms === null,
         ).length,
         note: "requests_24h es una ventana en memoria: se reinicia con el bot.",
      };
   });

   // ── Calendar (publish state — the Aug 1 miss lived here) ──────────────────
   const calendar = safe(() => {
      const store = new CalendarStore(deps.db);
      const events = store.listAll();
      const series = events.filter((e) => e.recurrence_freq !== null);
      const openEnded = series.filter((e) => e.recurrence_until === null);
      const outputChannelId =
         store.getOutputChannelId() ??
         config.CALENDAR_OUTPUT_CHANNEL_ID ??
         null;
      const publishedMonths = store
         .listPublished()
         .filter((r) => r.pub_key.startsWith("pdf:"))
         .map((r) => r.pub_key.slice(4))
         .sort();
      const desired = desiredMonthKeys(events, now);
      const missing = desired.filter((m) => !publishedMonths.includes(m));
      const stale = publishedMonths.filter((m) => !desired.includes(m));
      if (!outputChannelId)
         problems.push(
            "El calendario no tiene canal de salida configurado — no puede publicar.",
         );
      if (missing.length > 0)
         problems.push(`Calendario: falta publicar ${missing.join(", ")}.`);

      // The daily same-day announcement. Reported here because its two silent
      // failure modes (no channel configured, and events whose Discord event
      // nobody created) are otherwise only visible by watching #anuncios.
      const announce = resolveAnnounceSettings(store);
      const announceChannelId = announce.channelId;
      const todayEnd = now + 86_400_000;
      const upcomingDay = store.listOccurrences(now, todayEnd);
      const unlinked = upcomingDay.filter((o) => o.discord_event_id === null);
      if (!announceChannelId) {
         problems.push(
            "El anuncio diario de eventos no tiene canal configurado (config_calendar set_announce_channel).",
         );
      }
      if (unlinked.length > 0) {
         problems.push(
            `Sin evento de Discord (el anuncio saldría sin enlace): ${unlinked
               .map((o) => `#${o.id} ${o.title}`)
               .join("; ")}.`,
         );
      }
      const lastAnnouncement = store.recentAnnouncements(1)[0] ?? null;
      return {
         output_channel_id: outputChannelId,
         announce_channel_id: announceChannelId,
         announce_hour_local: announce.hour,
         announce_mentions: announce.mentions,
         announce_last_at_iso: lastAnnouncement
            ? iso(lastAnnouncement.announced_at)
            : null,
         next_24h_total: upcomingDay.length,
         next_24h_without_discord_event: unlinked.map((o) => ({
            id: o.id,
            title: o.title,
            start_at_iso: iso(o.start_at),
         })),
         events_total: events.length,
         one_off: events.length - series.length,
         series_total: series.length,
         series_open_ended: openEnded.length,
         series_bounded: series
            .filter((e) => e.recurrence_until !== null)
            .map((e) => ({
               id: e.id,
               title: e.title,
               occurrences: countOccurrencesUntil(
                  e.start_at,
                  e.recurrence_freq!,
                  e.recurrence_until,
               ),
               until_iso: iso(e.recurrence_until),
            })),
         published_months: publishedMonths,
         desired_months: desired,
         months_missing: missing,
         months_stale: stale,
         ics_published: store.getPublished("ics") !== null,
      };
   });

   // ── File scanner ──────────────────────────────────────────────────────────
   const fileScanner = safe(() => {
      const enabled = deps.registry.has("file_scanner");
      if (!enabled) {
         return {
            enabled: false,
            reason: "No registrada (falta VIRUSTOTAL_API_KEY o falló el init).",
         };
      }
      const store = new FileScannerStore(deps.db);
      const budget = config.VIRUSTOTAL_DAILY_REQUEST_BUDGET;
      const used = store.requestsInWindow(now, DAY_MS);
      if (used >= budget)
         problems.push(
            "File scanner sin presupuesto de VirusTotal en la ventana de 24 h.",
         );
      return {
         enabled: true,
         watched_channels: store.getWatchedChannels(),
         requests_24h: used,
         daily_budget: budget,
         budget_remaining: Math.max(0, budget - used),
         verdicts: store.verdictCounts(),
      };
   });

   // ── Event intake ──────────────────────────────────────────────────────────
   const eventIntake = safe(() => {
      const enabled = deps.registry.has("event_intake");
      if (!enabled)
         return { enabled: false, reason: "No registrada (falló el init)." };
      const store = new EventIntakeStore(deps.db);
      const categories = store.getWatchedCategories();
      const recent = store.recentTickets(50);
      const byStatus: Record<string, number> = {};
      for (const t of recent)
         byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      if (categories.length === 0) {
         problems.push(
            "event_intake no tiene categorías de tickets configuradas — está inactiva.",
         );
      }
      // An empty configured list is NOT "nobody can approve" — `isModByRole` falls
      // back to DEFAULT_MOD_ROLES. Report the EFFECTIVE roles so the health view
      // can't be misread as a broken approval path.
      const configuredRoles = store.getModRoles();
      return {
         enabled: true,
         watched_categories: categories,
         mod_roles_effective:
            configuredRoles.length > 0
               ? configuredRoles
               : [...DEFAULT_MOD_ROLES],
         mod_roles_source:
            configuredRoles.length > 0 ? "configured" : "default (roles.ts)",
         tickets_by_status: byStatus,
         tickets_tracked: recent.length,
      };
   });

   return {
      status: overallStatus({ llmDegraded: llmSnapshot.degraded, problems }),
      problems,
      runtime,
      llm,
      capabilities,
      discord,
      instagram_monitor: instagram,
      calendar,
      file_scanner: fileScanner,
      event_intake: eventIntake,
   };
}
