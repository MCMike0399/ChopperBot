import type Database from 'better-sqlite3';
import { isModCaller, type TurnAuthority } from '../discord/mod-roles.js';
import { EventIntakeStore } from './event_intake/store.js';

/**
 * "May this caller run privileged actions here?" for channel-bound
 * capabilities, answered from the SAME approver-role setting event_intake uses
 * to decide who may approve a ticket (`config_eventintake set_mod_roles`).
 *
 * Reading that one setting rather than keeping a second list is the invariant
 * the calendar announcer already relies on: who may approve, who gets pinged
 * and who may administer can't drift apart. An un-migrated or unreadable
 * event_intake degrades to `[]`, which `effectiveModTokens` resolves to
 * DEFAULT_MOD_ROLES — never to "everybody".
 */
export function modRoleTokens(db: Database.Database | null): string[] {
  if (!db) return [];
  try {
    return new EventIntakeStore(db).getModRoles();
  } catch {
    return [];
  }
}

/** Fail-closed mod check for a capability turn. See {@link isModCaller}. */
export function isModTurn(db: Database.Database | null, caller: TurnAuthority): boolean {
  return isModCaller(caller, modRoleTokens(db));
}
