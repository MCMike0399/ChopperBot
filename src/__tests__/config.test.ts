import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const originalEnv = { ...process.env };

describe("getAuthorizedChannelIds", () => {
   beforeEach(async () => {
      vi.resetModules();
      process.env = { ...originalEnv };
   });

   test("parses valid DISCORD_AUTHORIZED_CHANNELS JSON", async () => {
      process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
         {
            guildId: "12345678901234567890",
            guildName: "Test Server",
            channels: ["11111111111111111111", "22222222222222222222"],
         },
         {
            guildId: "98765432109876543210",
            channels: ["33333333333333333333"],
         },
      ]);
      delete process.env.DISCORD_CHANNEL_ID;

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const channels = getAuthorizedChannelIds();

      expect(channels.size).toBe(3);
      expect(channels.has("11111111111111111111")).toBe(true);
      expect(channels.has("22222222222222222222")).toBe(true);
      expect(channels.has("33333333333333333333")).toBe(true);
   });

   test("falls back to legacy DISCORD_CHANNEL_ID when DISCORD_AUTHORIZED_CHANNELS is absent", async () => {
      delete process.env.DISCORD_AUTHORIZED_CHANNELS;
      process.env.DISCORD_CHANNEL_ID = "44444444444444444444";

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const channels = getAuthorizedChannelIds();

      expect(channels.size).toBe(1);
      expect(channels.has("44444444444444444444")).toBe(true);
   });

   test("returns empty Set when neither config is present", async () => {
      delete process.env.DISCORD_AUTHORIZED_CHANNELS;
      delete process.env.DISCORD_CHANNEL_ID;

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const channels = getAuthorizedChannelIds();

      expect(channels.size).toBe(0);
   });

   test("throws on invalid JSON", async () => {
      process.env.DISCORD_AUTHORIZED_CHANNELS = "not valid json";
      delete process.env.DISCORD_CHANNEL_ID;

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();

      expect(() => getAuthorizedChannelIds()).toThrow();
   });

   test("throws on invalid schema (missing channels)", async () => {
      process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
         { guildName: "Test Server" },
      ]);
      delete process.env.DISCORD_CHANNEL_ID;

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();

      expect(() => getAuthorizedChannelIds()).toThrow();
   });

   test("parses config without guildId (optional)", async () => {
      process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
         { channels: ["11111111111111111111", "22222222222222222222"] },
      ]);
      delete process.env.DISCORD_CHANNEL_ID;

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const channels = getAuthorizedChannelIds();

      expect(channels.size).toBe(2);
   });

   test("throws on invalid channel ID format", async () => {
      process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
         { guildId: "12345678901234567890", channels: ["invalid"] },
      ]);
      delete process.env.DISCORD_CHANNEL_ID;

      const { getAuthorizedChannelIds, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();

      expect(() => getAuthorizedChannelIds()).toThrow();
   });
});

describe("getChannelCapabilityMap", () => {
   beforeEach(async () => {
      vi.resetModules();
      process.env = { ...originalEnv };
   });

   test("priority 1: DISCORD_CHANNEL_CAPABILITIES wins when present", async () => {
      process.env.DISCORD_CHANNEL_CAPABILITIES = JSON.stringify([
         {
            guildId: "11111111111111111111",
            channels: [
               { id: "22222222222222222222", capability: "instagram_monitor" },
               { id: "33333333333333333333", capability: "calendar" },
            ],
         },
      ]);
      // Even if the legacy var is set, the new one wins.
      process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
         { channels: ["44444444444444444444"] },
      ]);
      delete process.env.DISCORD_CHANNEL_ID;

      const { getChannelCapabilityMap, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const map = getChannelCapabilityMap();

      expect(map.size).toBe(2);
      expect(map.get("22222222222222222222")).toBe("instagram_monitor");
      expect(map.get("33333333333333333333")).toBe("calendar");
      expect(map.has("44444444444444444444")).toBe(false);
   });

   test("priority 2: legacy DISCORD_AUTHORIZED_CHANNELS routes all to DEFAULT_CAPABILITY", async () => {
      delete process.env.DISCORD_CHANNEL_CAPABILITIES;
      process.env.DISCORD_AUTHORIZED_CHANNELS = JSON.stringify([
         { channels: ["11111111111111111111", "22222222222222222222"] },
      ]);
      process.env.DEFAULT_CAPABILITY = "instagram_monitor";
      delete process.env.DISCORD_CHANNEL_ID;

      const { getChannelCapabilityMap, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const map = getChannelCapabilityMap();

      expect(map.size).toBe(2);
      expect(map.get("11111111111111111111")).toBe("instagram_monitor");
      expect(map.get("22222222222222222222")).toBe("instagram_monitor");
   });

   test("priority 3: legacy DISCORD_CHANNEL_ID routes single channel to DEFAULT_CAPABILITY", async () => {
      delete process.env.DISCORD_CHANNEL_CAPABILITIES;
      delete process.env.DISCORD_AUTHORIZED_CHANNELS;
      process.env.DISCORD_CHANNEL_ID = "44444444444444444444";
      process.env.DEFAULT_CAPABILITY = "instagram_monitor";

      const { getChannelCapabilityMap, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();
      const map = getChannelCapabilityMap();

      expect(map.size).toBe(1);
      expect(map.get("44444444444444444444")).toBe("instagram_monitor");
   });

   test("throws on duplicate channel id across guilds in DISCORD_CHANNEL_CAPABILITIES", async () => {
      process.env.DISCORD_CHANNEL_CAPABILITIES = JSON.stringify([
         {
            channels: [
               { id: "22222222222222222222", capability: "instagram_monitor" },
            ],
         },
         { channels: [{ id: "22222222222222222222", capability: "calendar" }] },
      ]);
      delete process.env.DISCORD_CHANNEL_ID;

      const { getChannelCapabilityMap, _resetChannelCache } =
         await import("../config.js");
      _resetChannelCache();

      expect(() => getChannelCapabilityMap()).toThrow(/appears more than once/);
   });
});

describe("boot validation (DeepSeek-only backend)", () => {
   beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
   });
   afterEach(() => {
      vi.restoreAllMocks();
   });

   function mockExit() {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation(((
         code?: string | number,
      ) => {
         throw new Error(`exit:${code}`);
      }) as never);
   }

   // DeepSeek is the ONLY brain since the 2026-09-14 v4.1 migration — it serves
   // text AND images — so its key is required unconditionally. There is no
   // second backend left to boot onto, which is why these are plain
   // "exits without the key" assertions rather than per-backend branches.
   test("boots with DEEPSEEK_API_KEY and resolves one DeepSeek backend", async () => {
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
      delete process.env.DEEP_SEEK_API_KEY;

      const { textBackend, textBrainDisplayName } = await import(
         "../config.js"
      );
      expect(textBackend.provider).toBe("deepseek");
      expect(textBackend.apiKey).toBe("sk-deepseek-test");
      expect(textBackend.baseUrl).toBe("https://api.deepseek.com/v1");
      // `deepseek-flash` IS DeepSeek-V4.1-Flash (the legacy ids still route to
      // it, but name the real one).
      expect(textBackend.modelId).toBe("deepseek-flash");
      expect(textBrainDisplayName()).toBe("DeepSeek V4.1 Flash");
      // ONE model for every tier — no second, pricier id, and no separate vision
      // model: V4.1 Flash reads images natively.
      expect(textBackend.supportsThinkingSwitch).toBe(true);
   });

   test("DEEP_SEEK_API_KEY is accepted as an alias (the spelling already in .env)", async () => {
      delete process.env.DEEPSEEK_API_KEY;
      process.env.DEEP_SEEK_API_KEY = "sk-alias-test";

      const { textBackend } = await import("../config.js");
      expect(textBackend.apiKey).toBe("sk-alias-test");
   });

   test("exits when neither key spelling is set", async () => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEP_SEEK_API_KEY;
      mockExit();

      await expect(import("../config.js")).rejects.toThrow("exit:1");
   });

   // The old Bedrock/Kimi knobs are gone. A leftover .env line for them must be
   // inert rather than a boot failure — Zod strips unknown keys by default, and
   // this pins that so a stale deployment .env can't take the bot down.
   test("leftover Kimi/Bedrock/AWS env vars are ignored, not fatal", async () => {
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
      process.env.KIMI_API_KEY = "sk-stale-kimi";
      process.env.LLM_TEXT_BACKEND = "kimi";
      process.env.ACCESS_KEY_ID = "stale";
      process.env.BEDROCK_MODEL_LOW = "us.amazon.nova-lite-v1:0";

      const { config, textBackend } = await import("../config.js");
      expect(textBackend.provider).toBe("deepseek");
      expect(config).not.toHaveProperty("BEDROCK_MODEL_LOW");
      expect(config).not.toHaveProperty("KIMI_API_KEY");
      expect(config).not.toHaveProperty("LLM_TEXT_BACKEND");
      expect(config).not.toHaveProperty("ACCESS_KEY_ID");
   });
});
