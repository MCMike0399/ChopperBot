import type Database from "better-sqlite3";
import {
   effectiveRoleTokens,
   isAuthorityCaller,
   type AuthorityTier,
   type TurnAuthority,
} from "../discord/mod-roles.js";
import { EventIntakeStore } from "./event_intake/store.js";

/**
 * The two authority tiers (v2.3.1), both read from event_intake's settings row:
 *
 * - **moderation** (`moderation_roles_json`): the admin console, IG mutations,
 *   general_chat review + bans. Defaults to the four staff roles.
 * - **events** (`mod_roles_json`, the legacy approver list): calendar writes,
 *   ticket approval, flyer staff ops, event pings, minutas recording. Defaults
 *   additionally include Gestión, and ALWAYS include effective moderation.
 *
 * Gestión is event staff, not moderation — the reason the tiers exist. An
 * un-migrated or unreadable store degrades to `[]`, which resolves to the
 * tier's defaults — never to "everybody".
 */
export function authorityRoleTokens(
   db: Database.Database | null,
   tier: AuthorityTier,
): string[] {
   if (!db) return [];
   try {
      const store = new EventIntakeStore(db);
      return tier === "events"
         ? store.getModRoles()
         : store.getModerationRoles();
   } catch {
      return [];
   }
}

/** Configured moderation tokens (may be empty → defaults at match time). */
export const modRoleTokens = (db: Database.Database | null): string[] =>
   authorityRoleTokens(db, "moderation");

/** Fail-closed MODERATION check for a turn. See {@link isAuthorityCaller}. */
export const isModTurn = (
   db: Database.Database | null,
   caller: TurnAuthority,
): boolean => isAuthorityCaller(caller, modRoleTokens(db), "moderation");

/**
 * Effective events tokens: configured/default event roles ∪ effective
 * moderation, so a custom moderation list never locks mods out of events and
 * "who may approve" stays the same list as "who gets pinged".
 */
export function eventRoleTokens(db: Database.Database | null): string[] {
   return [
      ...new Set([
         ...effectiveRoleTokens(authorityRoleTokens(db, "events"), "events"),
         ...effectiveRoleTokens(modRoleTokens(db), "moderation"),
      ]),
   ];
}

/** Fail-closed EVENTS check for a turn (calendar/intake/flyers/minutas). */
export const isEventTurn = (
   db: Database.Database | null,
   caller: TurnAuthority,
): boolean => isAuthorityCaller(caller, eventRoleTokens(db), "events");

/** Both tiers' effective tokens + configured/default source, for health/status. */
export function authoritySnapshot(db: Database.Database | null) {
   return Object.fromEntries(
      (["moderation", "events"] as const).map((tier) => {
         const configured = authorityRoleTokens(db, tier);
         return [
            tier,
            {
               effective:
                  tier === "events"
                     ? eventRoleTokens(db)
                     : [...effectiveRoleTokens(configured, tier)],
               source: configured.length ? "configured" : "defaults",
            },
         ];
      }),
   );
}
