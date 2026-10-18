import { ChannelType, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { sendAdminAlert, trySendAdminAlert } from "../admin-alert.js";

describe("admin alert delivery receipts", () => {
   it("acknowledges only successful sends and preserves the mention policy", async () => {
      const send = vi.fn(async () => ({}));
      const fetch = vi.fn(async () => ({ type: ChannelType.GuildText, send }));
      const client = { channels: { fetch } } as unknown as Client;
      expect(await trySendAdminAlert(client, ["test"], "test.alert")).toBe(
         true,
      );
      expect(send).toHaveBeenCalledWith({
         content: "test",
         allowedMentions: { parse: ["users"], roles: [] },
      });
      send.mockRejectedValueOnce(new Error("Discord unavailable"));
      expect(await trySendAdminAlert(client, ["test"], "test.alert")).toBe(
         false,
      );
      fetch.mockResolvedValueOnce(null as never);
      expect(await trySendAdminAlert(client, ["test"], "test.alert")).toBe(
         false,
      );
      send.mockRejectedValueOnce(new Error("Discord unavailable"));
      await expect(
         sendAdminAlert(client, ["test"], "test.alert"),
      ).resolves.toBeUndefined();
   });
});
