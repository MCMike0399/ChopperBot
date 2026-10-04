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
