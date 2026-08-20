/**
 * The live half of the Spanish voice net: every reply the bot is about to post
 * in a community channel is linted, and anything the rules catch lands in the
 * journal as a warning. It never edits or blocks the reply — a false positive
 * must cost nothing — it just makes a register regression something you can
 * grep for instead of something a member has to notice and report:
 *
 *   journalctl --user -u chopperbot | grep style.spanish
 *
 * That is the detector we did not have on 2026-08-13, when the text brain
 * changed and the Spanish drifted the same afternoon.
 */
import { log } from "../log.js";
import { lintSpanish, describeFindings } from "./spanish-style.js";
import { CONFIGURATION_CAPABILITY_ID } from "../capabilities/configuration/constants.js";

/**
 * Surfaces that are NOT linted. The admin console talks to operators and is
 * told by its own prompt to name tools and fields ("corre `config_discovery`"),
 * so the scaffolding rule would fire on correct behaviour there.
 */
const UNLINTED_CAPABILITIES: ReadonlySet<string> = new Set([
   CONFIGURATION_CAPABILITY_ID,
]);

export interface StyleReportContext {
   /** Capability that produced the reply — decides whether it's linted at all. */
   capability: string;
   channelId: string;
   /** Tool names this turn carried, so naming one in prose counts as a leak. */
   toolNames?: readonly string[];
}

/** Lints a user-facing reply and warns on anything it catches. Never throws. */
export function reportSpanishStyle(
   text: string,
   ctx: StyleReportContext,
): void {
   try {
      if (!text || UNLINTED_CAPABILITIES.has(ctx.capability)) return;
      const findings = lintSpanish(
         text,
         ctx.toolNames ? { toolNames: ctx.toolNames } : {},
      );
      if (findings.length === 0) return;
      log.warn(
         {
            capability: ctx.capability,
            channelId: ctx.channelId,
            rules: [...new Set(findings.map((f) => f.rule))],
            findings: describeFindings(findings),
         },
         "style.spanish_voice_drift",
      );
   } catch {
      // Style telemetry must never cost a reply.
   }
}
