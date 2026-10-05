import { test, expect, vi } from "vitest";
import {
   Collection,
   PermissionsBitField,
   PermissionFlagsBits as P,
   type Client,
} from "discord.js";
import { MemberLookupToolSource } from "../member-tools.js";
import { transcriptCacheFor } from "../../../discord/transcript-cache.js";

const G = "1435843683541979248",
   C = "200000000000000001",
   CALLER = "200000000000000002",
   TARGET = "200000000000000003";
function harness() {
   const publicRole = {
      id: "200000000000000004",
      name: "Interés ficticio",
      managed: false,
      permissions: new PermissionsBitField(P.ViewChannel),
   };
   const staffRole = {
      id: "1436055845392879778",
      name: "Rol de prueba",
      managed: false,
      permissions: new PermissionsBitField(P.BanMembers),
   };
   const hiddenRole = {
      id: "200000000000000005",
      name: "Rol privado ficticio",
      managed: false,
      permissions: new PermissionsBitField(),
   };
   const perms = new PermissionsBitField(P.ViewChannel | P.ReadMessageHistory);
   const caller = {
      id: CALLER,
      permissions: perms,
      roles: { cache: new Collection() },
   };
   const target = {
      id: TARGET,
      user: { bot: false },
      displayName: "Persona ficticia",
      roles: {
         cache: new Collection(
            [publicRole, staffRole, hiddenRole].map((r) => [r.id, r]),
         ),
      },
   };
   const bot = {
      id: "200000000000000006",
      permissions: new PermissionsBitField(perms.bitfield),
   };
   const channel = {
      id: C,
      guildId: G,
      isTextBased: () => true,
      isThread: () => false,
      messages: {},
      permissionsFor: (who: any) => who.permissions,
      permissionOverwrites: { cache: new Collection() },
   };
   const hidden = {
      id: "200000000000000007",
      permissionsFor: () => new PermissionsBitField(),
      permissionOverwrites: {
         cache: new Collection([
            [hiddenRole.id, { allow: new PermissionsBitField(P.ViewChannel) }],
         ]),
      },
   };
   const guild = {
      id: G,
      roles: {
         everyone: { id: G },
         fetch: vi.fn(async () => new Collection()),
      },
      members: {
         fetch: vi.fn(async ({ user }: any) =>
            user === CALLER ? caller : target,
         ),
         fetchMe: vi.fn(async () => bot),
      },
      channels: {
         fetch: vi.fn(async (id?: string) =>
            id
               ? channel
               : new Collection([
                    [C, channel],
                    [hidden.id, hidden],
                 ]),
         ),
      },
   };
   const search = vi.fn(async () => {
      throw { status: 403 };
   });
   const client = {
      user: { id: bot.id },
      guilds: { fetch: vi.fn(async () => guild) },
      rest: { get: search },
   } as unknown as Client;
   const tool = new MemberLookupToolSource(() => client, null, G, CALLER, C);
   transcriptCacheFor(client).update(C, {
      id: "200000000000000008",
      authorId: TARGET,
      author: "Persona ficticia",
      bot: false,
      timestamp: Date.now(),
      text: "texto ficticio",
      replyTo: null,
      url: "https://discord.com/channels/1/2/3",
   });
   return { tool, search, caller, target, client };
}
test("cached names resolve to real mentions and omit staff and hidden roles", async () => {
   const h = harness();
   const result = await h.tool.handle("server_member_lookup", {
      query: "Persona ficticia",
   });
   expect(result.status).toBe("success");
   expect((result.payload as any).matches).toEqual([
      {
         id: TARGET,
         display_name: "Persona ficticia",
         mention: `<@${TARGET}>`,
         public_roles: [{ id: "200000000000000004", name: "Interés ficticio" }],
      },
   ]);
   expect(h.search).not.toHaveBeenCalled();
});
test("REST-search 403 stays honest about partial coverage; revoked access fails closed", async () => {
   const h = harness();
   const result = await h.tool.handle("server_member_lookup", {
      query: "Desconocidx",
   });
   expect(result.status).toBe("success");
   expect((result.payload as any).search_available).toBe(false);
   expect((result.payload as any).complete).toBe(false);
   expect(h.search).toHaveBeenCalledTimes(1);
   h.caller.permissions.remove(P.ViewChannel);
   expect(
      (await h.tool.handle("server_member_lookup", { query: TARGET })).status,
   ).toBe("error");
});
test("bot lookup never reveals operational role detail outside its workspace", async () => {
   const h = harness();
   h.client.user = { id: TARGET } as any;
   const result = await h.tool.handle("server_member_lookup", {
      query: TARGET,
   });
   expect(result.status).toBe("success");
   expect((result.payload as any).matches[0].public_roles).toEqual([]);
});
