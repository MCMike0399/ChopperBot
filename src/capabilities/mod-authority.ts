import type Database from "better-sqlite3";
import {
   effectiveRoleTokens,
   isAuthorityCaller,
   type AuthorityTier,
   type TurnAuthority,
} from "../discord/mod-roles.js";
import { EventIntakeStore } from "./event_intake/store.js";

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
export const modRoleTokens = (db: Database.Database | null): string[] =>
   authorityRoleTokens(db, "moderation");
export const isModTurn = (
   db: Database.Database | null,
   caller: TurnAuthority,
): boolean => isAuthorityCaller(caller, modRoleTokens(db), "moderation");
// Events always include moderation, even when either tier uses custom roles.
export function eventRoleTokens(db: Database.Database | null): string[] {
   return [
      ...new Set([
         ...effectiveRoleTokens(authorityRoleTokens(db, "events"), "events"),
         ...effectiveRoleTokens(modRoleTokens(db), "moderation"),
      ]),
   ];
}
export const isEventTurn = (
   db: Database.Database | null,
   caller: TurnAuthority,
): boolean => isAuthorityCaller(caller, eventRoleTokens(db), "events");
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
