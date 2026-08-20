import { describe, test, expect, vi } from "vitest";
import {
   ChannelType,
   Collection,
   PermissionFlagsBits,
   PermissionsBitField,
} from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { DEFAULT_MOD_ROLES } from "../../../discord/mod-roles.js";
import { MINUTAS_MIGRATIONS, MinutasStore } from "../store.js";
import {
   buildMinutasInteractionHandler,
   resolveInteractionAuthority,
} from "../commands.js";
import { JOIN_COMMAND, LEAVE_COMMAND } from "../constants.js";

const MOD_ROLE = DEFAULT_MOD_ROLES[0]; // ⭐Administradora⭐ — the calendar's approver list
const OUTPUT = "1503986918784766072";

async function newDb() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "minutas").migrate(
      "minutas",
      MINUTAS_MIGRATIONS,
   );
   return { mem, store: new MinutasStore(mem.db()) };
}

interface FakeInteractionOpts {
   command: string;
   memberRoles?: Array<{ id: string; name: string }> | null;
   isAdmin?: boolean;
   inGuild?: boolean;
   voiceChannel?: { id: string; name: string; type: ChannelType } | null;
   title?: string | null;
}

function fakeInteraction(opts: FakeInteractionOpts) {
   const replies: Array<{ content: string; ephemeral?: boolean }> = [];
   const edits: string[] = [];
   const state = { replied: false, deferred: false };
   const interaction = {
      commandName: opts.command,
      guildId: "g1",
      user: { id: "u1", tag: "ana#0001" },
      inGuild: () => opts.inGuild ?? true,
      isChatInputCommand: () => true,
      guild: {
         members: {
            fetch: async () => ({
               voice: { channel: opts.voiceChannel ?? null },
            }),
         },
         roles: { cache: new Map() },
      },
      member:
         opts.memberRoles === null
            ? null
            : {
                 roles: {
                    cache: new Collection(
                       (opts.memberRoles ?? []).map((r) => [r.id, r]),
                    ),
                 },
                 permissions: new PermissionsBitField(
                    opts.isAdmin ? PermissionFlagsBits.Administrator : 0n,
                 ),
              },
      memberPermissions: new PermissionsBitField(
         opts.isAdmin ? PermissionFlagsBits.Administrator : 0n,
      ),
      options: {
         getString: (n: string) =>
            n === "titulo" ? (opts.title ?? null) : null,
      },
      get replied() {
         return state.replied;
      },
      get deferred() {
         return state.deferred;
      },
      reply: async (p: { content: string; ephemeral?: boolean }) => {
         replies.push(p);
         state.replied = true;
      },
      deferReply: async () => {
         state.deferred = true;
      },
      editReply: async (c: string) => {
         edits.push(c);
      },
   };
   return { interaction, replies, edits };
}

function fakeDeps(store: MinutasStore, mem: SqliteMemoryStore) {
   const sessions = {
      start: vi.fn(async () => ({
         id: "s1",
         guild_id: "g1",
         channel_id: "vc1",
         channel_name: "Ágora",
         title: null,
         started_by: "u1",
         started_by_tag: "ana#0001",
         started_at: 1,
         ended_at: null,
         status: "active" as const,
         end_reason: null,
         minio_prefix: null,
         summary_message_id: null,
         participants_json: "[]",
         stats_json: null,
         error: null,
      })),
      getActive: vi.fn(() => null as null | { id: string }),
      end: vi.fn(async () => null),
   };
   const requestLeaveProcessing = vi.fn(async () => "✅ Cerré la grabación…");
   const handler = buildMinutasInteractionHandler({
      store,
      db: mem.db(),
      sessions: sessions as never,
      requestLeaveProcessing,
   });
   return { handler, sessions, requestLeaveProcessing };
}

const VOICE = { id: "vc1", name: "Ágora", type: ChannelType.GuildVoice };

describe("minutas slash-command gate (calendar approver roles only)", () => {
   test("a member with no mod role is denied, ephemerally, before anything runs", async () => {
      const { mem, store } = await newDb();
      store.setOutputChannelId(OUTPUT);
      const { handler, sessions } = fakeDeps(store, mem);
      const { interaction, replies } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [{ id: "999999999999999999", name: "Usuarix" }],
         voiceChannel: VOICE,
      });
      await handler(interaction);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.ephemeral).toBe(true);
      expect(replies[0]!.content).toMatch(/moderación/);
      expect(sessions.start).not.toHaveBeenCalled();
      mem.close();
   });

   test.each([
      ["join", JOIN_COMMAND],
      ["leave", LEAVE_COMMAND],
   ] as const)(
      "calendar approver role passes the gate on /%s",
      async (_label, command) => {
         const { mem, store } = await newDb();
         store.setOutputChannelId(OUTPUT);
         const { handler, sessions, requestLeaveProcessing } = fakeDeps(
            store,
            mem,
         );
         const { interaction, replies } = fakeInteraction({
            command,
            memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
            voiceChannel: VOICE,
         });
         await handler(interaction);
         // The denial is the only reply that proves the gate stopped us. A /leave
         // with no active session DOES get an ephemeral "nothing to stop" — that
         // IS the gate having let us through to the flow.
         expect(
            replies.filter((r) => /moderación/.test(r.content)),
         ).toHaveLength(0);
         if (command === JOIN_COMMAND)
            expect(sessions.start).toHaveBeenCalledTimes(1);
         else expect(requestLeaveProcessing).not.toHaveBeenCalled();
         mem.close();
      },
   );

   test("Discord Administrator permission passes even without any mod role", async () => {
      const { mem, store } = await newDb();
      store.setOutputChannelId(OUTPUT);
      const { handler, sessions } = fakeDeps(store, mem);
      const { interaction } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [],
         isAdmin: true,
         voiceChannel: VOICE,
      });
      await handler(interaction);
      expect(sessions.start).toHaveBeenCalledTimes(1);
      mem.close();
   });

   test("DMs get nothing", async () => {
      const { mem, store } = await newDb();
      const { handler } = fakeDeps(store, mem);
      const { interaction, replies } = fakeInteraction({
         command: JOIN_COMMAND,
         inGuild: false,
         memberRoles: null,
      });
      await handler(interaction);
      expect(replies).toHaveLength(0);
      mem.close();
   });
});

describe("minutas slash-command flows", () => {
   test("join without an output channel configured fails early + ephemerally", async () => {
      const { mem, store } = await newDb();
      const { handler, sessions } = fakeDeps(store, mem);
      const { interaction, replies } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
         voiceChannel: VOICE,
      });
      await handler(interaction);
      expect(replies[0]!.content).toMatch(/canal donde publicar/);
      expect(sessions.start).not.toHaveBeenCalled();
      mem.close();
   });

   test("join from outside a voice/stage channel tells the member to enter first", async () => {
      const { mem, store } = await newDb();
      store.setOutputChannelId(OUTPUT);
      const { handler, sessions } = fakeDeps(store, mem);
      const { interaction, replies } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
         voiceChannel: null,
      });
      await handler(interaction);
      expect(replies[0]!.content).toMatch(/Entra primero/);
      expect(sessions.start).not.toHaveBeenCalled();
      mem.close();
   });

   test("join happy path: defers publicly, starts the session, confirms", async () => {
      const { mem, store } = await newDb();
      store.setOutputChannelId(OUTPUT);
      const { handler, sessions } = fakeDeps(store, mem);
      const { interaction, edits } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
         voiceChannel: VOICE,
         title: "Asamblea de octubre",
      });
      await handler(interaction);
      expect(sessions.start).toHaveBeenCalledTimes(1);
      expect(sessions.start.mock.calls[0]![0]).toMatchObject({
         startedBy: { id: "u1", tag: "ana#0001" },
         title: "Asamblea de octubre",
      });
      expect(edits).toHaveLength(1);
      expect(edits[0]).toContain("Grabando");
      mem.close();
   });

   test("leave with no active session → ephemeral notice", async () => {
      const { mem, store } = await newDb();
      const { handler, requestLeaveProcessing } = fakeDeps(store, mem);
      const { interaction, replies } = fakeInteraction({
         command: LEAVE_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
      });
      await handler(interaction);
      expect(replies[0]!.content).toMatch(/No hay ninguna grabación activa/);
      expect(requestLeaveProcessing).not.toHaveBeenCalled();
      mem.close();
   });

   test("leave with an active session → defer + process + ack", async () => {
      const { mem, store } = await newDb();
      const { handler, sessions, requestLeaveProcessing } = fakeDeps(
         store,
         mem,
      );
      sessions.getActive.mockReturnValue({ id: "s1" });
      const { interaction, edits } = fakeInteraction({
         command: LEAVE_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
      });
      await handler(interaction);
      expect(requestLeaveProcessing).toHaveBeenCalledWith(
         "g1",
         "/chopperbot-leave",
      );
      expect(edits).toEqual(["✅ Cerré la grabación…"]);
      mem.close();
   });
});

describe("resolveInteractionAuthority", () => {
   test("resolves GuildMember-shaped members (roles with names + permissions)", async () => {
      const { interaction } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "⭐Administradora⭐" }],
      });
      const auth = resolveInteractionAuthority(interaction as never);
      expect(auth.memberRoles).toEqual([
         { id: MOD_ROLE, name: "⭐Administradora⭐" },
      ]);
      expect(auth.isAdministrator).toBe(false);
   });

   test("resolves raw API members (role ids + memberPermissions bitfield)", async () => {
      const { interaction } = fakeInteraction({
         command: JOIN_COMMAND,
         memberRoles: [{ id: MOD_ROLE, name: "x" }],
      });
      // Reshape to the raw payload form: roles as bare ids, no cache.
      (interaction as { member: unknown }).member = { roles: [MOD_ROLE] };
      const auth = resolveInteractionAuthority(interaction as never);
      expect(auth.memberRoles?.map((r) => r.id)).toEqual([MOD_ROLE]);
      expect(auth.isAdministrator).toBe(false);
   });

   test("out-of-guild resolves to the fail-closed empty authority", () => {
      const auth = resolveInteractionAuthority({
         inGuild: () => false,
         member: null,
      } as never);
      expect(auth).toEqual({});
   });
});
