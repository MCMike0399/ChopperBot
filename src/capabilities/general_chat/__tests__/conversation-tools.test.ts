import { describe, test, expect, vi } from "vitest";
import { ConversationToolSource } from "../conversation-tools.js";

const CID = "100000000000000001";
const NOW = Date.parse("2026-10-04T16:00:00Z");
function source(moderator = false, verify = async () => moderator) {
   const fetchPage = vi.fn(async () => []);
   const tools = new ConversationToolSource(
      { fetchPage },
      CID,
      NOW,
      undefined,
      moderator,
      verify,
   );
   return { tools, fetchPage };
}

describe("conversation tools", () => {
   test("members get history only; invented moderation tool is hard-refused", async () => {
      const h = source();
      expect(h.tools.tools().map((t) => t.name)).toEqual([
         "server_conversation_history",
      ]);
      expect(
         (await h.tools.handle("server_moderation_review", {})).status,
      ).toBe("error");
      expect(h.fetchPage).not.toHaveBeenCalled();
   });
   test("moderation authority is rechecked at invocation", async () => {
      const h = source(true, async () => false);
      expect(
         (await h.tools.handle("server_moderation_review", {})).status,
      ).toBe("error");
      expect(h.fetchPage).not.toHaveBeenCalled();
   });
   test("history payload reports coverage and review carries evidence guidance", async () => {
      const h = source(true);
      const result = await h.tools.handle("server_moderation_review", {});
      expect(result.status).toBe("success");
      expect(result.payload).toMatchObject({
         complete: true,
         next_before: null,
         messages: [],
         review: expect.stringContaining("Cita enlaces"),
      });
   });
   test("bad arguments and repeated calls cannot cause unbounded reads", async () => {
      const h = source();
      expect(
         (
            await h.tools.handle("server_conversation_history", {
               channel_id: "nickname",
            })
         ).status,
      ).toBe("error");
      expect(h.fetchPage).not.toHaveBeenCalled();
      await h.tools.handle("server_conversation_history", {});
      await h.tools.handle("server_conversation_history", {});
      expect(
         (await h.tools.handle("server_conversation_history", {})).status,
      ).toBe("error");
      expect(h.fetchPage).toHaveBeenCalledTimes(2);
   });
});

describe("Discord message discovery", () => {
   const MINUTES = "100000000000000002";
   const PRIVATE = "100000000000000003";
   function discovery(extraChannels = 0) {
      const fetchPage = vi.fn(async (channelId: string) => {
         if (channelId === PRIVATE) throw new Error("private");
         return channelId === MINUTES
            ? [
                 {
                    id: "200000000000000001",
                    authorId: "300000000000000001",
                    author: "ChopperBot (tú)",
                    bot: true,
                    timestamp: NOW - 1000,
                    text: "Minuta de ayer [archivo: minuta.md]",
                    replyTo: null,
                    url: `https://discord.com/channels/400000000000000001/${MINUTES}/200000000000000001`,
                 },
              ]
            : [];
      });
      const directory = {
         listViewableChannels: vi.fn(async () => [
            ...Array.from({ length: extraChannels }, (_, i) => ({
               id: String(100000000000000100n + BigInt(i)),
               name: `otro-${i}`,
               type: "texto" as const,
               categoryName: null,
               categoryPosition: 0,
               position: i,
               topic: null,
            })),
            {
               id: CID,
               name: "general",
               type: "texto" as const,
               categoryName: null,
               categoryPosition: 0,
               position: 0,
               topic: null,
            },
            {
               id: MINUTES,
               name: "📝│minutas-de-asambleas",
               type: "texto" as const,
               categoryName: null,
               categoryPosition: 0,
               position: 1,
               topic: null,
            },
            {
               id: PRIVATE,
               name: "staff-secret",
               type: "texto" as const,
               categoryName: null,
               categoryPosition: 0,
               position: 2,
               topic: null,
            },
         ]),
      };
      const tools = new ConversationToolSource(
         { fetchPage },
         CID,
         NOW,
         undefined,
         false,
         async () => false,
         directory,
      );
      return { tools, fetchPage, directory };
   }
   test("finds a bot's minutes outside the current channel with a real evidence link", async () => {
      const h = discovery();
      const r = await h.tools.handle("server_search_messages", {
         query: "minuta",
      });
      expect(r.status).toBe("success");
      expect(JSON.stringify(r.payload)).toContain("minuta.md");
      expect(JSON.stringify(r.payload)).toContain(
         `https://discord.com/channels/400000000000000001/${MINUTES}/200000000000000001`,
      );
      expect(JSON.stringify(r.payload)).not.toContain("staff-secret");
      expect(r.payload).toMatchObject({ complete: false });
   });
   test("resolves decorated channel names and refuses hidden or ambiguous channels", async () => {
      const h = discovery();
      const r = await h.tools.handle("server_search_messages", {
         query: "minuta",
         channel: "minutas",
      });
      expect(r.status).toBe("success");
      expect(h.fetchPage).toHaveBeenCalledTimes(1);
      const missing = await h.tools.handle("server_search_messages", {
         query: "minuta",
         channel: "hidden",
      });
      expect(missing.status).toBe("error");
      expect(h.fetchPage).toHaveBeenCalledTimes(1);
   });
   test("automatic discovery ranks relevant channels and scans at most five", async () => {
      const h = discovery(20);
      const r = await h.tools.handle("server_search_messages", {
         query: "minuta",
      });
      expect(r.status).toBe("success");
      expect(h.fetchPage.mock.calls[0][0]).toBe(MINUTES);
      expect(h.fetchPage).toHaveBeenCalledTimes(5);
   });
   test("publication after midnight UTC retains the previous CDMX day", async () => {
      const h = discovery();
      h.fetchPage.mockResolvedValueOnce([
         {
            id: "200000000000000001",
            authorId: "300000000000000001",
            author: "ChopperBot",
            bot: true,
            timestamp: Date.parse("2026-10-04T02:02:00Z"),
            text: "minuta",
            replyTo: null,
            url: `https://discord.com/channels/400000000000000001/${MINUTES}/200000000000000001`,
         },
      ]);
      const r = await h.tools.handle("server_search_messages", {
         query: "minuta",
         channel: "minutas",
      });
      expect(r.payload).toMatchObject({
         channels: [
            {
               messages: [
                  {
                     timestamp_local: expect.stringContaining("2026-10-03"),
                     timestamp_utc: "2026-10-04T02:02:00.000Z",
                  },
               ],
            },
         ],
      });
   });
   test("ambiguous channels cannot cause guessed history reads", async () => {
      const h = discovery(2);
      expect(
         (
            await h.tools.handle("server_search_messages", {
               query: "minuta",
               channel: "otro",
            })
         ).status,
      ).toBe("error");
      expect(h.fetchPage).not.toHaveBeenCalled();
   });
   test("a partial search provides a usable history cursor", async () => {
      const h = discovery();
      const messages = Array.from({ length: 220 }, (_, i) => ({
         id: String(200000000000000000n + BigInt(220 - i)),
         authorId: "300000000000000001",
         author: "ChopperBot (tú)",
         bot: true,
         timestamp: NOW - 1000 - i,
         text: i === 219 ? "minuta anterior" : "otra cosa",
         replyTo: null,
         url: `https://discord.com/channels/400000000000000001/${MINUTES}/${200000000000000000n + BigInt(220 - i)}`,
      }));
      h.fetchPage.mockImplementation(
         async (_channelId: string, before?: string) =>
            messages
               .filter((m) => !before || BigInt(m.id) < BigInt(before))
               .slice(0, 100),
      );
      const r = await h.tools.handle("server_search_messages", {
         query: "minuta",
         channel: "minutas",
      });
      const payload = r.payload as {
         channels: {
            next_before: string;
            complete: boolean;
            messages: unknown[];
         }[];
      };
      expect(payload.channels[0].complete).toBe(false);
      expect(payload.channels[0].messages).toEqual([]);
      expect(payload.channels[0].next_before).toBe(messages[199].id);
      const next = await h.tools.handle("server_conversation_history", {
         channel_id: MINUTES,
         query: "minuta",
         before: payload.channels[0].next_before,
      });
      expect(JSON.stringify(next.payload)).toContain("minuta anterior");
   });
   test("directory outages fail closed without reading messages", async () => {
      const h = discovery();
      h.directory.listViewableChannels.mockRejectedValueOnce(
         new Error("unavailable"),
      );
      expect(
         (await h.tools.handle("server_search_messages", { query: "minuta" }))
            .status,
      ).toBe("error");
      expect(h.fetchPage).not.toHaveBeenCalled();
   });
   test("search shares the turn's history budget and validates before fetching", async () => {
      const h = discovery();
      expect(
         (await h.tools.handle("server_search_messages", { query: "" })).status,
      ).toBe("error");
      expect(h.directory.listViewableChannels).not.toHaveBeenCalled();
      await h.tools.handle("server_conversation_history", {});
      await h.tools.handle("server_conversation_history", {});
      expect(
         (await h.tools.handle("server_search_messages", { query: "minuta" }))
            .status,
      ).toBe("error");
      expect(h.directory.listViewableChannels).not.toHaveBeenCalled();
   });
});
