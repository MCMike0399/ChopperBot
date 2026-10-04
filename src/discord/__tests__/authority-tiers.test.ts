import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../memory/migrations.js";
import {
   EVENT_INTAKE_MIGRATIONS,
   EventIntakeStore,
} from "../../capabilities/event_intake/store.js";
import {
   isModTurn,
   isEventTurn,
   eventRoleTokens,
} from "../../capabilities/mod-authority.js";
import { ConfigEventIntakeAdminSource } from "../../capabilities/configuration/eventintake-admin-source.js";
import type { Client } from "discord.js";
import { DEFAULT_MOD_ROLES, resolveModMentions } from "../mod-roles.js";
const GESTION = "1483694810253492235";
const caller = (id: string) => ({ memberRoles: [{ id, name: "renamed" }] });
describe("two authority tiers", () => {
   it("preserves the legacy event list, without promoting it into moderation", () => {
      const db = new Database(":memory:");
      runMigrations(db, "event_intake", EVENT_INTAKE_MIGRATIONS.slice(0, 2));
      const store = new EventIntakeStore(db);
      store.setModRoles([GESTION]);
      runMigrations(db, "event_intake", EVENT_INTAKE_MIGRATIONS);
      expect(store.getModRoles()).toEqual([GESTION]);
      expect(store.getModerationRoles()).toEqual([]);
      expect(isModTurn(db, caller(GESTION))).toBe(false);
      expect(isEventTurn(db, caller(GESTION))).toBe(true);
      for (const id of DEFAULT_MOD_ROLES) {
         expect(isModTurn(db, caller(id))).toBe(true);
         expect(isEventTurn(db, caller(id))).toBe(true);
      }
      store.setModerationRoles(["1550000000000000001"]);
      expect(isEventTurn(db, caller("1550000000000000001"))).toBe(true);
      expect(isModTurn(db, caller(GESTION))).toBe(false);
      const pings = resolveModMentions(
         [GESTION, "1550000000000000001"].map((id) => ({
            id,
            name: "role",
            mentionable: true,
         })),
         eventRoleTokens(db),
         { canMentionAny: false },
      );
      expect(pings.notifyIds).toEqual([GESTION, "1550000000000000001"]);
      db.close();
   });
   it("live console aliases edit independent settings, and empty restores defaults", async () => {
      const db = new Database(":memory:");
      runMigrations(db, "event_intake", EVENT_INTAKE_MIGRATIONS);
      const source = new ConfigEventIntakeAdminSource({
         db,
         callerUserId: "1550000000000000009",
         guildId: null,
         client: {} as Client,
      });
      for (const action of ["set_event_roles", "set_mod_roles"]) {
         expect(
            (
               await source.handle("config_eventintake", {
                  action,
                  roles: GESTION,
               })
            ).status,
         ).toBe("success");
         expect(isEventTurn(db, caller(GESTION))).toBe(true);
         expect(isModTurn(db, caller(GESTION))).toBe(false);
      }
      await source.handle("config_eventintake", {
         action: "set_moderation_roles",
         roles: "1550000000000000001",
      });
      expect(new EventIntakeStore(db).getModRoles()).toEqual([GESTION]);
      expect(isModTurn(db, caller("1550000000000000001"))).toBe(true);
      await source.handle("config_eventintake", {
         action: "set_moderation_roles",
         roles: "",
      });
      expect(isModTurn(db, caller(DEFAULT_MOD_ROLES[0]))).toBe(true);
      expect(isModTurn(db, caller(GESTION))).toBe(false);
      db.close();
   });
   it("defaults fail closed, bot Administrators never qualify", () => {
      expect(isModTurn(null, caller(GESTION))).toBe(false);
      expect(isEventTurn(null, caller(GESTION))).toBe(true);
      for (const fn of [isModTurn, isEventTurn]) {
         expect(fn(null, {})).toBe(false);
         expect(fn(null, { memberRoles: [] })).toBe(false);
         expect(fn(null, { isAdministrator: true })).toBe(true);
         expect(
            fn(null, {
               ...caller(DEFAULT_MOD_ROLES[0]),
               isAdministrator: true,
               isBot: true,
            }),
         ).toBe(false);
      }
   });
});
