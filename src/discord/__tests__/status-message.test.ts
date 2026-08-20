import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
   LiveStatusMessage,
   composeStatusText,
   toolLabel,
} from "../status-message.js";
import type { Message } from "discord.js";

describe("toolLabel", () => {
   test("maps known tools to friendly Spanish labels", () => {
      expect(toolLabel("workshop_run_python")).toBe("🐍 Ejecutando código");
      expect(toolLabel("workshop_send_file")).toBe("📎 Preparando tu archivo");
      expect(toolLabel("calendar_list_upcoming")).toBe(
         "📅 Consultando el calendario",
      );
      expect(toolLabel("server_channel_info")).toBe("🗺️ Consultando canales");
      expect(toolLabel("mystery_tool")).toBe("🛠️ Trabajando (mystery_tool)");
      expect(toolLabel(undefined)).toBe("🛠️ Trabajando");
   });
});

describe("composeStatusText", () => {
   test("thinking with no steps and short elapsed is just the spinner line", () => {
      expect(
         composeStatusText({ phase: "thinking", step: 0, elapsedMs: 5_000 }),
      ).toBe("-# 🤔 Pensando…");
   });

   test("tool phase carries the label, the step and (after 20s) the elapsed time", () => {
      expect(
         composeStatusText({
            phase: "tool",
            toolName: "workshop_run_python",
            step: 3,
            elapsedMs: 45_000,
         }),
      ).toBe("-# 🐍 Ejecutando código · paso 3 · 45s");
   });

   test("long elapsed renders as minutes", () => {
      expect(
         composeStatusText({ phase: "thinking", step: 0, elapsedMs: 135_000 }),
      ).toBe("-# 🤔 Pensando… · 2m 15s");
   });
});

/** Fake message/channel capturing sends/edits/deletes. */
function fakeChannel() {
   const ops: string[] = [];
   const mkMessage = (): Message =>
      ({
         edit: vi.fn(async (text: string) => {
            ops.push(`edit:${text}`);
            return mkMessage();
         }),
         delete: vi.fn(async () => {
            ops.push("delete");
         }),
      }) as unknown as Message;
   return {
      ops,
      channel: {
         send: vi.fn(async (text: string) => {
            ops.push(`send:${text}`);
            return mkMessage();
         }),
      },
   };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LiveStatusMessage", () => {
   test("start → throttled updates → finishAsReply morphs into the answer", async () => {
      const { ops, channel } = fakeChannel();
      const status = new LiveStatusMessage(channel);
      await status.start("-# 🤔 Pensando…");

      // Immediately after start: inside the throttle window → deferred.
      status.update("-# 🐍 Ejecutando código · paso 1");
      expect(ops).toEqual(["send:-# 🤔 Pensando…"]);
      await vi.advanceTimersByTimeAsync(1600);
      expect(ops).toContain("edit:-# 🐍 Ejecutando código · paso 1");

      // Newest text wins over intermediate ones inside a throttle window.
      status.update("-# paso 2");
      status.update("-# paso 3");
      await vi.advanceTimersByTimeAsync(1600);
      expect(ops).not.toContain("edit:-# paso 2");
      expect(ops).toContain("edit:-# paso 3");

      const anchor = await status.finishAsReply([
         "respuesta final",
         "segunda parte",
      ]);
      expect(anchor).not.toBeNull();
      expect(ops).toContain("edit:respuesta final");
      expect(ops).toContain("send:segunda parte");
   });

   test("duplicate updates are not re-edited", async () => {
      const { ops, channel } = fakeChannel();
      const status = new LiveStatusMessage(channel);
      await status.start("-# a");
      await vi.advanceTimersByTimeAsync(2000);
      status.update("-# a");
      await vi.advanceTimersByTimeAsync(2000);
      expect(ops.filter((o) => o.startsWith("edit:"))).toHaveLength(0);
   });

   test("discard deletes the line; later updates are no-ops", async () => {
      const { ops, channel } = fakeChannel();
      const status = new LiveStatusMessage(channel);
      await status.start("-# 🤔 Pensando…");
      await status.discard();
      expect(ops).toContain("delete");
      status.update("-# too late");
      await vi.advanceTimersByTimeAsync(3000);
      expect(ops.filter((o) => o.startsWith("edit:"))).toHaveLength(0);
   });

   test("fail edits the line into the error text", async () => {
      const { ops, channel } = fakeChannel();
      const status = new LiveStatusMessage(channel);
      await status.start("-# 🤔 Pensando…");
      await status.fail("Se rompió algo.");
      expect(ops).toContain("edit:Se rompió algo.");
   });

   test("the channel send is invoked as a METHOD (regression: unbound send dropped every reply)", async () => {
      // Discord.js channels need `this`; a detached `channel.send` reference
      // throws inside the library. Live 2026-08-06 that silently dropped every
      // workshop reply, so this fake fails loudly if `this` is lost.
      const posted: string[] = [];
      class FakeChannel {
         readonly id = "chan-1";
         async send(content: string): Promise<Message> {
            if (this?.id !== "chan-1")
               throw new TypeError("send called without its channel");
            posted.push(content);
            return {
               edit: async (t: string) => ({}) as Message,
            } as unknown as Message;
         }
      }
      const status = new LiveStatusMessage(new FakeChannel());
      await status.start("-# 🤔 Pensando…");
      expect(posted).toEqual(["-# 🤔 Pensando…"]);
      expect(status.active).toBe(true);

      // …and the same holds for the reply path when no status line exists.
      const bare = new LiveStatusMessage(new FakeChannel());
      const anchor = await bare.finishAsReply(["la respuesta"]);
      expect(posted).toContain("la respuesta");
      expect(anchor).not.toBeNull();
   });

   test("a failed start degrades to plain sends on finish", async () => {
      const ops: string[] = [];
      const channel = {
         send: vi.fn(async (text: string) => {
            if (ops.length === 0) {
               ops.push("send-fail");
               throw new Error("no perms");
            }
            ops.push(`send:${text}`);
            return {} as Message;
         }),
      };
      const status = new LiveStatusMessage(channel);
      await status.start("-# 🤔 Pensando…");
      expect(status.active).toBe(false);
      await status.finishAsReply(["la respuesta"]);
      expect(ops).toContain("send:la respuesta");
   });
});
