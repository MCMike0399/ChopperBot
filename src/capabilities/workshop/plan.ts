import { ask } from "../../llm/client.js";
import { composeToolSources } from "../../tools/source.js";
import { log } from "../../log.js";
import type { Turn } from "../../discord/history.js";

/**
 * The "starting up message": ONE plain-language line saying what the bot is
 * about to do with the member's request, shown in the live status line before
 * the tool trace starts. A workshop turn at `max` effort spends its first tens
 * of seconds thinking, and a bare "🤔 Pensando…" says nothing; a cheap
 * `low`-effort call up front gives the member intent instead of a spinner.
 *
 * Display-only: the line is never fed back into the conversation (the status
 * message morphs into the reply and `-# ` is filtered from history), and every
 * failure degrades to the plain spinner — a plan is never worth breaking a
 * turn for.
 */

/** Hard cap for the line (Discord subtext stays readable; the model overruns). */
export const PLAN_MAX_CHARS = 140;
/** Recent turns handed to the planner, for follow-ups ("dale", "sí", "eso"). */
export const PLAN_CONTEXT_TURNS = 4;
/** Per-turn cap for context, so the planning call stays tiny. */
const PLAN_TURN_CHARS = 700;

function renderPlanPrompt(): string {
   return `Eres ChopperBot en un taller privado de Discord (escuela/trabajo). Antes de trabajar, avisas en UNA línea qué vas a hacer con el mensaje que acabas de recibir: es lo que la persona lee mientras ejecutas.

Devuelve SOLO esa línea, en español neutro y cálido, en primera persona y en presente:
- máximo 120 caracteres, una sola línea, sin markdown, sin emojis, sin comillas, sin "Plan:" ni numeración;
- concreta y verificable: qué harás y qué entregarás ("Reviso tu PDF y te armo el resumen en Word");
- si el mensaje es un seguimiento ("dale", "sí", "eso mismo"), apóyate en el contexto reciente para saber a qué se refiere;
- nombra los archivos del taller cuando sean el centro del pedido;
- no prometas nada fuera de esta misma respuesta (nada de "te aviso luego") ni pidas permiso: si falta un dato, di qué vas a preparar con lo que hay.`;
}

/** Compose the planner's single user message. Pure — exported for tests. */
export function renderPlanInput(input: {
   userText: string;
   uploads: readonly string[];
   files: readonly string[];
   contextTurns: readonly Turn[];
}): string {
   const blocks: string[] = [`MENSAJE ACTUAL:\n${input.userText}`];
   if (input.uploads.length > 0) {
      blocks.push(`ARCHIVOS QUE ACABA DE SUBIR:\n${input.uploads.join(", ")}`);
   }
   if (input.files.length > 0) {
      blocks.push(
         `ARCHIVOS DEL TALLER:\n${input.files.slice(0, 20).join(", ")}`,
      );
   }
   const context = input.contextTurns
      .map(
         (t) =>
            `${t.role === "user" ? "Usuario" : "ChopperBot"}: ${t.content.slice(0, PLAN_TURN_CHARS)}`,
      )
      .join("\n\n");
   if (context) blocks.push(`CONTEXTO RECIENTE:\n${context}`);
   return blocks.join("\n\n");
}

/**
 * Clean the model's reply into a displayable line, or null when it isn't a
 * plan at all (empty, a provider fallback, a refusal). Tolerant on purpose:
 * the planner sometimes wraps the line in quotes, markdown or a "Plan:" prefix.
 */
export function sanitizePlan(raw: string): string | null {
   const firstLine = (raw ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
   if (!firstLine) return null;
   const text = firstLine
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-•>]+\s*/, "")
      .replace(/^#+\s*/, "")
      .replace(/^(plan|aviso|acci[oó]n)\s*[:–—-]\s*/i, "")
      .replace(/^🧭\s*/u, "")
      .trim()
      .replace(/^["'«“”]+|["'»“”]+$/g, "")
      .trim();
   if (!text) return null;
   // Provider fallbacks / apologies are not a plan.
   if (/^(no pude|no puedo|lo siento|perd[oó]n)/i.test(text)) return null;
   if (text.length <= PLAN_MAX_CHARS) return text;
   const cut = text.slice(0, PLAN_MAX_CHARS);
   const lastSpace = cut.lastIndexOf(" ");
   const body = (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd();
   return `${body}…`;
}

export interface PlanInput {
   /** The member's message (not the ambient transcript). */
   userText: string;
   /** Files this very message delivered into the workspace. */
   uploads: readonly string[];
   /** Workspace listing shown to the planner (relative paths). */
   files: readonly string[];
   /** Turns before the current message (chronological). */
   contextTurns: readonly Turn[];
}

/** Plan the turn → the one-line intent, or null (never throws). */
export async function planTurn(input: PlanInput): Promise<string | null> {
   try {
      const reply = await ask({
         system: renderPlanPrompt(),
         messages: [{ role: "user", content: renderPlanInput(input) }],
         tools: composeToolSources([]),
         // One display line: thinking would only add latency and billed tokens.
         effort: "low",
      });
      const plan = sanitizePlan(reply);
      if (plan) log.info({ plan }, "workshop.plan");
      else log.info("workshop.plan_skipped");
      return plan;
   } catch (err) {
      // Best-effort UX: the turn runs exactly as before without a plan line.
      log.warn({ err }, "workshop.plan_failed");
      return null;
   }
}
