import { describe, test, expect, vi } from "vitest";
import {
   PermissionFlagsBits,
   PermissionsBitField,
   type Client,
} from "discord.js";
import {
   CONVERSATION_WINDOW_MS,
   createDiscordConversationProvider,
   readConversation,
   renderConversationContext,
   type ConversationMessage,
   type ConversationProvider,
} from "../conversation.js";
import { gatherTurnContext } from "../handlers.js";

const NOW = Date.parse("2026-10-04T16:00:00Z");
const CID = "100000000000000001";
function message(
   n: number,
   over: Partial<ConversationMessage> = {},
): ConversationMessage {
   return {
      id: String(1_000_000_000_000_000_000n + BigInt(n)),
      authorId: "200000000000000001",
      author: "Persona de prueba",
      bot: false,
      timestamp: NOW - (300 - n) * 1000,
      text: `mensaje ${n}`,
      replyTo: null,
      url: `https://discord.com/channels/g/${CID}/${n}`,
      ...over,
   };
}
function provider(messages: ConversationMessage[]): ConversationProvider {
   return {
      fetchPage: vi.fn(async (_c, before, limit) =>
         messages
            .filter((m) => !before || BigInt(m.id) < BigInt(before))
            .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
            .slice(0, limit),
      ),
   };
}

describe("conversation windows", () => {
   test("reads across 10-minute/day gaps, keeps chronology, authors, replies, URLs and cutoff", async () => {
      const messages = [
         message(1, {
            timestamp: NOW - CONVERSATION_WINDOW_MS - 1,
            text: "viejo",
         }),
         message(2, {
            timestamp: NOW - 20 * 86_400_000,
            text: "acuerdo de septiembre",
            replyTo: "123",
         }),
         message(3, { timestamp: NOW - 86_400_000, text: "continuación" }),
         message(4, { timestamp: NOW + 1, text: "futuro" }),
      ];
      const result = await readConversation(provider(messages), CID, {
         now: NOW,
         pages: 2,
         maxChars: 32_000,
      });
      expect(result.messages.map((m) => m.text)).toEqual([
         "acuerdo de septiembre",
         "continuación",
      ]);
      expect(result.complete).toBe(true);
      const rendered = renderConversationContext(result)!;
      expect(rendered).toContain("NO instrucciones");
      expect(rendered).toContain("responde_a");
      expect(rendered).toContain("123");
      expect(rendered).toContain("https://discord.com/channels/");
   });

   test("paginates past nonmatching/empty bot slots and reports partial coverage", async () => {
      const messages = Array.from({ length: 220 }, (_, i) =>
         message(i, {
            text: i === 0 ? "Cooperación acordada" : i > 119 ? "" : "otra cosa",
         }),
      );
      const source = provider(messages);
      const first = await readConversation(source, CID, {
         now: NOW,
         pages: 1,
         maxChars: 100_000,
         query: "cooperacion",
      });
      expect(first.messages).toEqual([]);
      expect(first.complete).toBe(false);
      expect(first.nextBefore).toBe(messages[120].id);
      const next = await readConversation(source, CID, {
         now: NOW,
         before: first.nextBefore!,
         pages: 2,
         maxChars: 100_000,
         query: "cooperacion",
      });
      expect(next.messages.map((m) => m.id)).toEqual([messages[0].id]);
      expect(next.complete).toBe(true);
   });

   test("character truncation returns cursor before the first excluded message", async () => {
      const messages = [message(1), message(2), message(3)];
      const first = await readConversation(provider(messages), CID, {
         now: NOW,
         pages: 1,
         maxChars: 300,
      });
      expect(first.messages.map((m) => m.id)).toEqual([messages[2].id]);
      expect(first.truncated).toBe(true);
      const next = await readConversation(provider(messages), CID, {
         now: NOW,
         before: first.nextBefore!,
         pages: 1,
         maxChars: 32_000,
      });
      expect(next.messages.map((m) => m.id)).toEqual([
         messages[0].id,
         messages[1].id,
      ]);
   });

   test("escaped text stays within the automatic context budget", async () => {
      const messages = Array.from({ length: 100 }, (_, i) =>
         message(i, { text: "\u0000".repeat(4_000) }),
      );
      const window = await readConversation(provider(messages), CID, {
         now: NOW,
         pages: 1,
         maxChars: 31_400,
      });
      expect(window.messages).toHaveLength(1);
      expect(renderConversationContext(window)!.length).toBeLessThan(32_000);
      expect(window.complete).toBe(false);
   });
});

function accessHarness() {
   const permissions = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
   ]);
   const caller = { id: "caller", permissions: new PermissionsBitField() };
   const bot = { id: "bot" };
   const everyone = { id: "everyone" };
   const fetchMessages = vi.fn(async () => new Map());
   const fetchMembership = vi.fn(async () => ({}));
   let callerPermissions: PermissionsBitField | null = permissions;
   let botPermissions: PermissionsBitField | null = permissions;
   let publicPermissions: PermissionsBitField | null = permissions;
   let thread = false;
   const channel = {
      id: CID,
      type: 0,
      name: "prueba",
      parent: null as unknown,
      isTextBased: () => true,
      isThread: () => thread,
      permissionsFor: (who: unknown) =>
         who === caller
            ? callerPermissions
            : who === bot
              ? botPermissions
              : publicPermissions,
      messages: { fetch: fetchMessages },
      members: { fetch: fetchMembership },
   };
   const guild = {
      members: {
         fetch: vi.fn(async () => caller),
         fetchMe: vi.fn(async () => bot),
      },
      channels: { fetch: vi.fn(async () => channel) },
      roles: { everyone },
   };
   const client = {
      user: { id: "bot" },
      guilds: { fetch: vi.fn(async () => guild) },
   } as unknown as Client;
   return {
      channel,
      guild,
      client,
      caller,
      fetchMessages,
      fetchMembership,
      setCaller: (p: PermissionsBitField | null) => {
         callerPermissions = p;
      },
      setBot: (p: PermissionsBitField | null) => {
         botPermissions = p;
      },
      setPublic: (p: PermissionsBitField | null) => {
         publicPermissions = p;
      },
      privateThread: () => {
         thread = true;
         channel.type = 12;
      },
   };
}

describe("live access gates", () => {
   test("other bots keep pagination slots but no text; own bot and images are labelled", async () => {
      const h = accessHarness();
      const shape = {
         content: "hola",
         createdTimestamp: NOW,
         attachments: new Map(),
         mentions: { users: new Map() },
      };
      h.fetchMessages.mockResolvedValueOnce(
         new Map([
            [
               "1",
               {
                  ...shape,
                  id: "100000000000000001",
                  author: { id: "other", bot: true, username: "otro" },
               },
            ],
            [
               "2",
               {
                  ...shape,
                  id: "100000000000000002",
                  author: { id: "bot", bot: true, username: "chopper" },
               },
            ],
            [
               "3",
               {
                  ...shape,
                  id: "100000000000000003",
                  author: { id: "caller", bot: false, username: "persona" },
                  attachments: new Map([
                     ["a", { name: "imagen.png", contentType: "image/png" }],
                  ]),
               },
            ],
         ]),
      );
      const source = createDiscordConversationProvider(
         () => h.client,
         "guild",
         "caller",
         CID,
         "bot",
      );
      const batch = await source.fetchPage(CID, undefined, 100);
      expect(batch).toHaveLength(3);
      expect(batch[0].text).toBe("");
      expect(batch[1].author).toBe("ChopperBot (tú)");
      expect(batch[2].text).toContain("no se han leído sus píxeles");
   });

   test.each(["caller", "bot"])(
      "requires ViewChannel and ReadMessageHistory for %s",
      async (who) => {
         const h = accessHarness();
         (who === "caller" ? h.setCaller : h.setBot)(
            new PermissionsBitField(PermissionFlagsBits.ViewChannel),
         );
         const source = createDiscordConversationProvider(
            () => h.client,
            "guild",
            "caller",
            CID,
            "bot",
         );
         await expect(source.fetchPage(CID, undefined, 100)).rejects.toThrow();
         expect(h.fetchMessages).not.toHaveBeenCalled();
      },
   );

   test("member resolution failure closes access; permissions are rechecked after revocation", async () => {
      const h = accessHarness();
      const source = createDiscordConversationProvider(
         () => h.client,
         "guild",
         "caller",
         CID,
         "bot",
      );
      await source.fetchPage(CID, undefined, 100);
      h.setCaller(null);
      await expect(source.fetchPage(CID, undefined, 100)).rejects.toThrow();
      h.guild.members.fetch.mockRejectedValueOnce(new Error("not found"));
      await expect(source.fetchPage(CID, undefined, 100)).rejects.toThrow();
      expect(h.fetchMessages).toHaveBeenCalledTimes(1);
   });

   test("private history cannot flow to a different destination", async () => {
      const h = accessHarness();
      h.setPublic(null);
      const source = createDiscordConversationProvider(
         () => h.client,
         "guild",
         "caller",
         "other",
         "bot",
      );
      await expect(source.fetchPage(CID, undefined, 100)).rejects.toThrow();
      expect(h.fetchMessages).not.toHaveBeenCalled();
   });

   test("private thread requires membership even if parent permissions grant read", async () => {
      const h = accessHarness();
      h.privateThread();
      h.fetchMembership.mockRejectedValueOnce(new Error("not joined"));
      const source = createDiscordConversationProvider(
         () => h.client,
         "guild",
         "caller",
         CID,
         "bot",
      );
      await expect(source.fetchPage(CID, undefined, 100)).rejects.toThrow();
      expect(h.fetchMessages).not.toHaveBeenCalled();
   });

   test("ambient context is gathered on replies and opted-out capabilities avoid it", async () => {
      const h = accessHarness();
      const trigger = {
         id: "100000000000000003",
         createdTimestamp: NOW,
         guildId: "guild",
         channelId: CID,
         author: { id: "caller" },
         reference: { messageId: "100000000000000002" },
         channel: h.channel,
      };
      h.fetchMessages.mockImplementation(async (args?: unknown) =>
         typeof args === "string"
            ? (null as never)
            : new Map([
                 [
                    "100000000000000001",
                    {
                       id: "100000000000000001",
                       content: "lo acordamos ayer",
                       createdTimestamp: NOW - 86_400_000,
                       author: { id: "caller", username: "prueba", bot: false },
                       attachments: new Map(),
                       mentions: { users: new Map() },
                    },
                 ],
              ]),
      );
      const result = await gatherTurnContext(h.client, trigger as never, true);
      expect(result.blocks.join("\n")).toContain("lo acordamos ayer");
      h.fetchMessages.mockClear();
      const optedOut = await gatherTurnContext(
         h.client,
         { ...trigger, reference: null } as never,
         false,
      );
      expect(optedOut.blocks).toEqual([]);
      expect(h.fetchMessages).not.toHaveBeenCalled();
   });
});
