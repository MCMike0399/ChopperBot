/**
 * A deterministic linter for the bot's user-facing Spanish.
 *
 * Why this exists: on 2026-08-13 the text brain moved from Kimi to DeepSeek and
 * the Spanish register drifted the same day. The first DeepSeek turns in the
 * calendar channel produced, in one reply:
 *
 *   "…no hay que saber nada especial, se le habla como en una conversación
 *    normal … Si le hace falta algo, le pregunto UNA cosa a la vez y listo.
 *    ¿Se lo resumo también por acá en un mensaje para elx?"
 *
 * Three distinct defects, none of which any test could see: the usted register
 * (the server tutea), a made-up singular inclusive form ("elx"), and a verbatim
 * leak of a system-prompt rule, ALL-CAPS emphasis included ("UNA cosa a la
 * vez"). Kimi-era replies from the same channel and the same week are clean on
 * all three — see the corpus in `__tests__/corpus.ts`.
 *
 * The rules are deliberately **high precision, low recall**: every pattern here
 * fires only on constructions that are wrong in this community's voice no
 * matter the context, because the output feeds a journal warning on every live
 * reply and a red test on every regression. Stylistic near-misses ("Por favor,
 * informa a un administrador") are left alone on purpose — grading taste is the
 * prompt's job (see `voice.ts`), not this file's.
 *
 * Pure and dependency-free: usable from tests, from the live reply path
 * (`report.ts`) and from the backend bake-off script alike.
 */

export type SpanishStyleRuleId =
   | "usted"
   | "mixed_register"
   | "inclusive_malformed"
   | "scaffolding"
   | "service_closer"
   | "enclitic_accent";

export interface SpanishStyleFinding {
   rule: SpanishStyleRuleId;
   /** The exact snippet that tripped the rule — what a human needs to see. */
   match: string;
   /** One-line operator-facing explanation (English: this lands in the journal). */
   why: string;
}

export interface LintSpanishOptions {
   /**
    * Tool names available to the turn. Any of them appearing in the reply is a
    * scaffolding leak: the bot must say "la busco", never "llamo a
    * calendar_search_events". Optional — the built-in prefix rule already
    * catches the framework's own naming convention.
    */
   toolNames?: readonly string[];
}

/**
 * Text that is not prose and must never be linted: fenced and inline code
 * (workshop replies are full of Python), URLs, Discord mentions/channel links
 * and custom emoji (`<:gatito3:143…>`). Masked with spaces so word boundaries
 * on either side survive.
 */
function maskNonProse(text: string): string {
   const blank = (m: string): string => " ".repeat(m.length);
   return text
      .replace(/```[\s\S]*?```/g, blank)
      .replace(/`[^`\n]*`/g, blank)
      .replace(/https?:\/\/\S+/gi, blank)
      .replace(/<a?:[A-Za-z0-9_]+:\d+>/g, blank)
      .replace(/<[@#][!&]?\d+>/g, blank);
}

/**
 * The usted register. Only unambiguous markers: the singular pronoun (never
 * "ustedes", which is the ordinary Mexican plural), the usted imperative forms
 * a model reaches for when it slips into customer-service Spanish, and the
 * impersonal "se le <verbo>" addressed at the reader. Bare dative "le" is NOT
 * a marker — "le creé el evento de Discord" is correct tuteo.
 */
const USTED_PATTERNS: ReadonlyArray<RegExp> = [
   /\busted\b(?!es)/gi,
   /\bse le (?:habla|dice|pide|informa|explica|comunica|solicita|recomienda|contesta|atiende)\b/gi,
   /\b(?:sírvase|avíseme|aviseme|dígame|digame|escríbame|envíeme|indíqueme|confírmeme|comuníquese|diríjase)\b/gi,
   /\b(?:tenga en cuenta|no dude en|quedo a sus órdenes|para servirle|si lo desea|si gusta usted)\b/gi,
   /¿\s*(?:desea|gusta|podría usted|le gustaría|necesita usted|quiere usted)\b/gi,
];

/**
 * Tuteo markers, for the drift check. "te", "ti" and possessive "tu" are
 * second-person-informal and nothing else in Spanish (the accented "té" is a
 * different token and does not match), so they are reliable on their own.
 */
const TUTEO_PATTERNS: ReadonlyArray<RegExp> = [
   /\b(?:tú|te|ti|tu|tus|contigo|tuyo|tuya|tuyos|tuyas)\b/gi,
   /\b(?:dime|dile|avísame|mándame|pásame|escríbeme|cuéntame|checa|súbela|súbelo|mándalo|pregúntame)\b/gi,
   /¿\s*(?:quieres|puedes|necesitas|te gustaría|te parece)\b/gi,
];

/**
 * Invented inclusive **function words** — articles, demonstratives and pronouns
 * spelled with an x.
 *
 * Deliberately a denylist and not a rule about "-x" in general. The first
 * version of this rule flagged every singular x-form and immediately caught
 * "¡Qué onda, bienvenidx!" in a live probe — but the welcome channel is
 * literally named `#bienvenidx`, the guild profile says "amix", and
 * "compañerx"/"usuarixs" are ordinary usage here. Content words in -x are the
 * community's own vocabulary and must pass.
 *
 * What is not usage is a made-up pronoun: "elx" (the reported defect — "un
 * mensaje para elx") has no accepted reading. For one person the reply should
 * use their name, "esa persona", or a rewrite that needs no gendered pronoun.
 *
 * The lookarounds are explicit letter classes because JS `\b` is ASCII-only and
 * fires *inside* an accented word; the trailing one also lets the correct
 * plurals ("lxs", "ellxs") through.
 */
const INVENTED_PRONOUNS =
   /(?<![a-záéíóúüñA-ZÁÉÍÓÚÜÑ])(?:elx|ellx|lx|unx|algunx|ningunx|estx|esx|aquelx|aquellx)(?![a-záéíóúüñA-ZÁÉÍÓÚÜÑs])/gi;

/**
 * Internal vocabulary that must never reach a community channel: the framework's
 * own tool ids (`<dominio>_<verbo>`), the parameter names the system prompts use
 * to teach the model its tools, ALL-CAPS emphasis lifted straight out of those
 * prompts, and any sentence about being configured/instructed.
 *
 * The caps list is exactly the set of words the system prompts shout — a reply
 * containing them is quoting its own rules, which is how "le pregunto UNA cosa
 * a la vez" reached the channel.
 */
const SCAFFOLDING_PATTERNS: ReadonlyArray<RegExp> = [
   /\b(?:calendar|workshop|server|config|configuration|instagram|ig|event|file|memory|user)_[a-z0-9_]+\b/g,
   /\b(?:start_at_iso|start_at_local|local_date|occurrence_date_iso|occurrence_count|occurrence_index|recurrence_freq|recurrence_count|recurrence_until_iso|recurrence_until_local|recurrence_open_ended|updated_scope|deleted_scope|discord_event_id|image_url|venue_kind|venue_name|needs_room|missing_permission|no_output_channel)\b/g,
   /\b(?:NUNCA|SIEMPRE|JAMÁS|JAMAS|IMPORTANTE|OBLIGATORIO|REQUERIDO|OPCIONAL|MÍNIMO|MINIMO|UNA|SOLO|SÓLO|TODOS|ANTES)\b/g,
   /\b(?:mis instrucciones|mi prompt|el system prompt|mis reglas internas|se me indicó|mi configuración me|como modelo de lenguaje|como IA)\b/gi,
];

/**
 * Customer-service closers. The prompts have banned these since before the
 * migration ("cierra con afirmaciones"), and every capability repeats it,
 * because they are the single most recognisable tell of a bot pretending to be
 * a helpdesk. A concrete offer ("¿quieres que cree también el evento de
 * Discord?") is NOT one of these and must keep passing — the calendar prompt
 * explicitly asks for it.
 */
const SERVICE_CLOSER_PATTERNS: ReadonlyArray<RegExp> = [
   /¿\s*(?:algo|hay algo|necesitas algo|puedo ayudarte en algo)\s*más\s*[?¿]/gi,
   /¿\s*en qué más\b/gi,
   /\bestoy (?:aquí )?para (?:ayudarte|servirte|lo que necesites)\b/gi,
   /\bquedo (?:atento|atenta|a la orden|pendiente)\b/gi,
   /\bno dudes en (?:preguntar|escribir|consultar|contactar|decirme)\b/gi,
   /\bespero (?:que )?(?:esto|esta información|te)\s*\w*\s*(?:sea|haya sido|resulte)\s*(?:útil|de ayuda)\b/gi,
   /\bque tengas (?:un |una )?(?:buen|buena|excelente)\b/gi,
];

/**
 * Enclitic-accent orthography — the one spelling error class these models make
 * often enough to be worth a rule, and the one that shipped on day one
 * ("Propónlo en la próxima asamblea"). Two directions of the same rule:
 * an accented imperative loses its accent when a single enclitic makes it
 * paroxytone (propón → proponlo), and an unaccented monosyllable never gains
 * one (pon → ponlo, never "pónlo").
 */
const ENCLITIC_ACCENT_PATTERNS: ReadonlyArray<RegExp> = [
   /\b(?:propón|detén|mantén|contén|sostén|retén|entretén)(?:lo|la|los|las|le|les|me|te|nos|se)\b/gi,
   /\b(?:pón|ház|dí|vé|dá|tén|vén|sál)(?:lo|la|los|las|le|les|me|te|nos|se)\b/gi,
];

const WHY: Record<SpanishStyleRuleId, string> = {
   usted: "usted register — the server tutea",
   mixed_register: "tú and usted mixed in the same reply",
   inclusive_malformed:
      'invented inclusive pronoun/article (use a name, "esa persona", or a plural -xs form)',
   scaffolding: "internal prompt vocabulary reached the reply",
   service_closer: "customer-service closer",
   enclitic_accent: "enclitic accent misspelling",
};

function collect(
   rule: SpanishStyleRuleId,
   text: string,
   patterns: ReadonlyArray<RegExp>,
   out: SpanishStyleFinding[],
   seen: Set<string>,
): void {
   for (const pattern of patterns) {
      for (const m of text.matchAll(
         new RegExp(pattern.source, pattern.flags),
      )) {
         const match = m[0].trim();
         const key = `${rule}:${match.toLowerCase()}`;
         if (seen.has(key)) continue;
         seen.add(key);
         out.push({ rule, match, why: WHY[rule] });
      }
   }
}

function hits(text: string, patterns: ReadonlyArray<RegExp>): boolean {
   return patterns.some((p) => new RegExp(p.source, p.flags).test(text));
}

/**
 * Lints one user-facing Spanish reply. Returns every distinct violation, in
 * rule order; an empty array means the reply is in voice as far as the
 * deterministic rules can tell.
 */
export function lintSpanish(
   text: string,
   opts: LintSpanishOptions = {},
): SpanishStyleFinding[] {
   const prose = maskNonProse(text);
   const findings: SpanishStyleFinding[] = [];
   const seen = new Set<string>();

   collect("usted", prose, USTED_PATTERNS, findings, seen);
   if (hits(prose, USTED_PATTERNS) && hits(prose, TUTEO_PATTERNS)) {
      findings.push({
         rule: "mixed_register",
         match: "",
         why: WHY.mixed_register,
      });
   }

   collect("inclusive_malformed", prose, [INVENTED_PRONOUNS], findings, seen);

   collect("scaffolding", prose, SCAFFOLDING_PATTERNS, findings, seen);
   for (const name of opts.toolNames ?? []) {
      if (!prose.includes(name)) continue;
      const key = `scaffolding:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ rule: "scaffolding", match: name, why: WHY.scaffolding });
   }

   collect("service_closer", prose, SERVICE_CLOSER_PATTERNS, findings, seen);
   collect("enclitic_accent", prose, ENCLITIC_ACCENT_PATTERNS, findings, seen);

   return findings;
}

/** Compact one-line rendering of a lint result, for logs and CLI scorecards. */
export function describeFindings(
   findings: readonly SpanishStyleFinding[],
): string {
   return findings
      .map((f) => (f.match ? `${f.rule}("${f.match}")` : f.rule))
      .join(", ");
}
