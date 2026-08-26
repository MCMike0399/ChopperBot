import { describe, test, expect } from "vitest";
import {
   findChannel,
   groupByCategory,
   normalizeChannelQuery,
   ServerDirectoryToolSource,
   type DirectoryChannel,
} from "../server-tools.js";

const ch = (
   over: Partial<DirectoryChannel> & { id: string; name: string },
): DirectoryChannel => ({
   type: "texto",
   categoryName: null,
   categoryPosition: 0,
   position: 0,
   topic: null,
   ...over,
});

const ID1 = "100000000000000001";
const ID2 = "100000000000000002";
const ID3 = "100000000000000003";
const ID4 = "100000000000000004";
const ID5 = "100000000000000005";

const CHANNELS: DirectoryChannel[] = [
   ch({
      id: ID1,
      name: "💬│general",
      categoryName: "Comunidad",
      position: 0,
      topic: "el chat principal",
   }),
   ch({
      id: ID2,
      name: "🎲│fuera-de-tema",
      categoryName: "Comunidad",
      position: 1,
   }),
   ch({
      id: ID3,
      name: "bienvenidx",
      categoryName: "Escuela/trabajo",
      categoryPosition: 1,
      topic: "reacciona 🎓",
   }),
   ch({
      id: ID4,
      name: "chat-poesía",
      categoryName: "Clubs",
      categoryPosition: 2,
   }),
   ch({
      id: ID5,
      name: "chat-cineclub",
      categoryName: "Clubs",
      categoryPosition: 2,
      position: 1,
   }),
];

describe("normalizeChannelQuery", () => {
   test("folds case, accents, emoji decoration and separators", () => {
      expect(normalizeChannelQuery("💬│General")).toBe("general");
      expect(normalizeChannelQuery("chat-poesía")).toBe("chat-poesia");
      expect(normalizeChannelQuery("  Fuera De Tema ")).toBe("fuera-de-tema");
   });
});

describe("findChannel", () => {
   test("matches by id and by <#id> mention", () => {
      expect(findChannel(CHANNELS, ID3).match?.name).toBe("bienvenidx");
      expect(findChannel(CHANNELS, `<#${ID3}>`).match?.name).toBe("bienvenidx");
      expect(findChannel(CHANNELS, "999999999999999999").match).toBeUndefined();
   });

   test("matches names ignoring emoji/accents; unique substring matches too", () => {
      expect(findChannel(CHANNELS, "general").match?.id).toBe(ID1);
      expect(findChannel(CHANNELS, "chat-poesia").match?.id).toBe(ID4);
      expect(findChannel(CHANNELS, "bienvenid").match?.id).toBe(ID3);
   });

   test("ambiguous substring returns candidates, not a guess", () => {
      const res = findChannel(CHANNELS, "chat");
      expect(res.match).toBeUndefined();
      expect(res.candidates?.map((c) => c.id).sort()).toEqual([ID4, ID5]);
   });
});

describe("groupByCategory", () => {
   test("groups in server order", () => {
      const grouped = groupByCategory(CHANNELS);
      expect(grouped.map((g) => g.category)).toEqual([
         "Comunidad",
         "Escuela/trabajo",
         "Clubs",
      ]);
      expect(grouped[0].channels.map((c) => c.id)).toEqual([ID1, ID2]);
   });
});

describe("ServerDirectoryToolSource", () => {
   const source = new ServerDirectoryToolSource({
      // The provider contract: channels are ALREADY filtered to the asking
      // member's visibility — a hidden staff channel is simply absent here.
      listViewableChannels: async () => CHANNELS,
   });

   test("server_list_channels returns the grouped directory", async () => {
      const res = await source.handle("server_list_channels", {});
      expect(res.status).toBe("success");
      const payload = res.payload as {
         total: number;
         categories: Array<{ category: string }>;
      };
      expect(payload.total).toBe(5);
      expect(payload.categories.map((c) => c.category)).toContain(
         "Escuela/trabajo",
      );
   });

   test("server_channel_info resolves and returns the topic", async () => {
      const res = await source.handle("server_channel_info", {
         channel: "bienvenidx",
      });
      expect(res.status).toBe("success");
      expect(
         (res.payload as { channel: { topic?: string } }).channel.topic,
      ).toBe("reacciona 🎓");
   });

   test("server_channel_info includes instructions when the provider has them", async () => {
      const source = new ServerDirectoryToolSource({
         listViewableChannels: async () => CHANNELS,
         getChannelInstructions: async (id) =>
            id === ID3 ? 'Presiona "Comenzar formulario"' : null,
      });
      const res = await source.handle("server_channel_info", {
         channel: "bienvenidx",
      });
      expect(res.status).toBe("success");
      expect(
         (res.payload as { instructions?: string }).instructions,
      ).toContain("Comenzar formulario");
   });

   test("server_list_discord_events returns RSVP urls and the open-event note", async () => {
      const source = new ServerDirectoryToolSource({
         listViewableChannels: async () => CHANNELS,
         listDiscordEvents: async () => [
            {
               id: "DE1",
               name: "Cooperativas en la praxis",
               url: "https://discord.com/events/G/DE1",
               startAtMs: Date.parse("2026-08-26T02:00:00Z"),
               location: null,
               channelName: "Sala de Eventos",
               status: "en_curso",
            },
         ],
      });
      const res = await source.handle("server_list_discord_events", {});
      expect(res.status).toBe("success");
      const payload = res.payload as {
         note: string;
         events: Array<{ name: string; url: string; sala?: string }>;
      };
      expect(payload.note).toMatch(/no hace falta ticket/i);
      expect(payload.events[0]).toMatchObject({
         name: "Cooperativas en la praxis",
         url: "https://discord.com/events/G/DE1",
         sala: "Sala de Eventos",
      });
   });

   test("a hidden-or-missing channel is a single indistinguishable error", async () => {
      const res = await source.handle("server_channel_info", {
         channel: "canal-de-moderacion",
      });
      expect(res.status).toBe("error");
      expect(String((res.payload as { error: string }).error)).toContain(
         "no existe o la persona no puede verlo",
      );
   });

   test("a failing provider degrades to a clean error (fail closed)", async () => {
      const broken = new ServerDirectoryToolSource({
         listViewableChannels: async () => {
            throw new Error("member fetch failed");
         },
      });
      const res = await broken.handle("server_list_channels", {});
      expect(res.status).toBe("error");
   });
});
