import { describe, test, expect } from "vitest";
import { isModByRole, isModCaller, DEFAULT_MOD_ROLES } from "../mod-roles.js";

const rolesOf = (...pairs: Array<[string, string]>) =>
   pairs.map(([id, name]) => ({ id, name }));

describe("isModByRole", () => {
   test("matches a configured role by id", () => {
      const MOD_ID = "222222222222222222"; // 18-digit snowflake
      expect(
         isModByRole(
            rolesOf(["111111111111111111", "Miembro"], [MOD_ID, "Mod"]),
            [MOD_ID],
         ),
      ).toBe(true);
      expect(
         isModByRole(rolesOf(["111111111111111111", "Miembro"]), [MOD_ID]),
      ).toBe(false);
   });

   test("matches a configured role by name, accent/case-insensitive", () => {
      expect(isModByRole(rolesOf(["1", "Moderador"]), ["moderador"])).toBe(
         true,
      );
      expect(
         isModByRole(rolesOf(["1", "Administradora"]), ["ADMINISTRADORA"]),
      ).toBe(true);
   });

   test("empty config falls back to the default approver role ids", () => {
      const modId = DEFAULT_MOD_ROLES[0];
      expect(
         isModByRole(rolesOf(["1", "Miembro"], [modId, "Moderador"]), []),
      ).toBe(true);
      expect(isModByRole(rolesOf(["1", "Miembro"]), [])).toBe(false);
   });

   test("matches an emoji-decorated role name by its plain name", () => {
      // The live Revolución Z roles are wrapped in emoji; configuring them by the
      // name a mod would actually type must still work.
      expect(
         isModByRole(rolesOf(["1", "🚓Moderación🚓"]), ["Moderación"]),
      ).toBe(true);
      expect(
         isModByRole(rolesOf(["1", "⭐Administrador⭐"]), ["administrador"]),
      ).toBe(true);
      expect(
         isModByRole(rolesOf(["1", "🚓Moderación🚓"]), ["Administrador"]),
      ).toBe(false);
   });

   test("a plain member is not a mod", () => {
      expect(
         isModByRole(rolesOf(["1", "Miembro"], ["2", "Verificadx"]), ["999"]),
      ).toBe(false);
   });
});

/**
 * The gate the privileged capabilities call. The only interesting property is
 * what it does when it does NOT know: an unresolved member (a DM, a failed
 * fetch) must read as "not a mod", never as "no roles, therefore fine".
 */
describe("isModCaller", () => {
   const MOD_ID = DEFAULT_MOD_ROLES[0];

   test("Administrator alone authorizes, whatever the roles say", () => {
      expect(isModCaller({ isAdministrator: true }, [])).toBe(true);
      expect(
         isModCaller(
            { isAdministrator: true, memberRoles: rolesOf(["1", "Miembro"]) },
            [],
         ),
      ).toBe(true);
   });

   test("an approver role authorizes without Administrator", () => {
      expect(
         isModCaller(
            {
               memberRoles: rolesOf([MOD_ID, "Moderación"]),
               isAdministrator: false,
            },
            [],
         ),
      ).toBe(true);
   });

   test("fails CLOSED when the member could not be resolved", () => {
      expect(isModCaller({}, [])).toBe(false);
      expect(isModCaller({ isAdministrator: false }, [])).toBe(false);
   });

   test('an empty role list is "no roles", not "unrestricted"', () => {
      expect(isModCaller({ memberRoles: [], isAdministrator: false }, [])).toBe(
         false,
      );
   });
});
