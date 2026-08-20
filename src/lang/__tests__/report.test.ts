/**
 * The live detector. `reportSpanishStyle` runs on every reply the bot is about
 * to post, so what matters here is what it does NOT do: it never throws, never
 * touches the reply, and never fires on the admin console (whose prompt tells
 * it to name tools out loud).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const warn = vi.fn();
vi.mock("../../log.js", () => ({
   log: {
      info: () => {},
      warn: (...args: unknown[]) => warn(...args),
      error: () => {},
   },
}));

const { reportSpanishStyle } = await import("../report.js");

const DRIFTED =
   "Si le hace falta algo, se le habla y le pregunto UNA cosa a la vez.";

beforeEach(() => warn.mockClear());

describe("reportSpanishStyle", () => {
   test("warns once, with the rules and the snippets, on a drifted reply", () => {
      reportSpanishStyle(DRIFTED, { capability: "calendar", channelId: "C1" });

      expect(warn).toHaveBeenCalledTimes(1);
      const [payload, msg] = warn.mock.calls[0] as [
         Record<string, unknown>,
         string,
      ];
      expect(msg).toBe("style.spanish_voice_drift");
      expect(payload.capability).toBe("calendar");
      expect(payload.channelId).toBe("C1");
      expect(payload.rules).toContain("usted");
      expect(payload.rules).toContain("scaffolding");
      expect(String(payload.findings)).toContain("se le habla");
   });

   test("stays silent on a reply in voice", () => {
      reportSpanishStyle(
         "Listo, ya quedó el evento del jueves a las 8. Si me pasas el flyer, se lo pongo.",
         {
            capability: "calendar",
            channelId: "C1",
         },
      );
      expect(warn).not.toHaveBeenCalled();
   });

   test("the admin console is exempt — naming a tool there is correct", () => {
      reportSpanishStyle(
         "Corre config_system action:health para ver el estado.",
         {
            capability: "configuration",
            channelId: "C2",
         },
      );
      expect(warn).not.toHaveBeenCalled();
   });

   test("a tool the turn carried counts as a leak when it reaches prose", () => {
      reportSpanishStyle("Ahora llamo a monitor_add_account.", {
         capability: "instagram_monitor",
         channelId: "C3",
         toolNames: ["monitor_add_account"],
      });
      expect(warn).toHaveBeenCalledTimes(1);
   });

   test("an empty reply is not a finding", () => {
      reportSpanishStyle("", { capability: "calendar", channelId: "C1" });
      expect(warn).not.toHaveBeenCalled();
   });
});
