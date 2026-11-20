import type { ScanOutcome } from "./scanner.js";
import type { VerdictStats } from "./store.js";

/** Image formats the bot already handles via vision — never sent to VirusTotal. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_MIME_PREFIX = "image/";

/**
 * Video formats — skipped only in media-native channels (multimedia, momos,
 * arte, cine…). Conversation channels scan them: a .mov in #general is odd.
 */
const VIDEO_EXTENSIONS = new Set([
   "mp4",
   "m4v",
   "mov",
   "avi",
   "mkv",
   "webm",
   "flv",
   "wmv",
   "mpeg",
   "mpg",
   "3gp",
   "ogv",
   "mts",
   "m2ts",
   "ts",
]);
const VIDEO_MIME_PREFIX = "video/";

/**
 * Audio formats — scanned in every watched channel (a .mp3 in #general is as
 * odd as a .mov). Media-native channels still skip *video*, not audio.
 */
const AUDIO_EXTENSIONS = new Set([
   "mp3",
   "wav",
   "ogg",
   "oga",
   "m4a",
   "flac",
   "aac",
   "opus",
   "wma",
   "weba",
   "mid",
   "midi",
]);
const AUDIO_MIME_PREFIX = "audio/";

/**
 * Terminal state for a file whose fresh upload never finished analyzing in the
 * synchronous poll budget and whose later re-checks ran out too. Rendered as an
 * honest "I couldn't confirm it" instead of an eternal "still analyzing".
 */
export interface UnresolvedOutcome {
   kind: "unresolved";
   sha256: string;
}

/** Per-file line state as the scan progresses (edited in place). */
export type LineStatus =
   | { phase: "queued" }
   | { phase: "scanning" }
   | ScanOutcome
   | UnresolvedOutcome;

export interface FileLine {
   fileName: string;
   status: LineStatus;
   /** The 🛑 malicious upload message was deleted from the channel. */
   deleted?: boolean;
}

/**
 * True if an attachment is an image (by content-type or extension). Images are
 * skipped to protect the limited VirusTotal quota — they're rarely malicious
 * and are already understood by the vision path.
 */
export function isImageAttachment(
   name: string,
   contentType: string | null,
): boolean {
   const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
   if (ct.startsWith(IMAGE_MIME_PREFIX)) return true;
   const ext = name.split(".").pop()?.toLowerCase() ?? "";
   return IMAGE_EXTENSIONS.has(ext);
}

/**
 * True if an attachment is a video (by content-type or extension). Videos are
 * skipped in media-native channels to protect quota; conversation channels
 * scan them.
 */
export function isVideoAttachment(
   name: string,
   contentType: string | null,
): boolean {
   const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
   if (ct.startsWith(VIDEO_MIME_PREFIX)) return true;
   const ext = name.split(".").pop()?.toLowerCase() ?? "";
   return VIDEO_EXTENSIONS.has(ext);
}

/** True if an attachment is audio (by content-type or extension). */
export function isAudioAttachment(
   name: string,
   contentType: string | null,
): boolean {
   const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
   if (ct.startsWith(AUDIO_MIME_PREFIX)) return true;
   const ext = name.split(".").pop()?.toLowerCase() ?? "";
   return AUDIO_EXTENSIONS.has(ext);
}

const VT_LINK = (sha256: string) =>
   `<https://www.virustotal.com/gui/file/${sha256}>`;
const code = (s: string) => "`" + s.replace(/`/g, "") + "`";

function verdictLine(
   fileName: string,
   o: Extract<ScanOutcome, { kind: "verdict" }>,
   deleted = false,
): string {
   const { verdict, stats, sha256, source } = o;
   const flagged = stats.malicious + stats.suspicious;
   const cached = source === "cache" ? " · _resultado en caché_" : "";
   switch (verdict) {
      case "malicious":
         return (
            `🛑 ${code(fileName)} — **¡MALICIOSO!** ${stats.malicious}/${stats.total} motores lo detectan como dañino. ` +
            `**No lo abras ni lo descargues.**` +
            (deleted
               ? `\n   🗑️ Borré el mensaje con el archivo (y todo lo que traía adjunto).`
               : "") +
            `\n   🔗 ${VT_LINK(sha256)}${cached}`
         );
      case "suspicious":
         return (
            `⚠️ ${code(fileName)} — **sospechoso**: ${flagged}/${stats.total} motores lo marcaron. Trátalo con cuidado.\n` +
            `   🔗 ${VT_LINK(sha256)}${cached}`
         );
      case "clean":
         return `✅ ${code(fileName)} — limpio (0/${stats.total} motores lo marcan como dañino).${cached}`;
   }
}

/** One status line for a single file, given its current phase/outcome. */
export function renderLine({ fileName, status, deleted }: FileLine): string {
   if ("phase" in status) {
      return status.phase === "queued"
         ? `⏳ ${code(fileName)} — en cola…`
         : `🔬 ${code(fileName)} — analizando con VirusTotal…`;
   }
   switch (status.kind) {
      case "verdict":
         return verdictLine(fileName, status, deleted === true);
      case "pending":
         return (
            `⏳ ${code(fileName)} — VirusTotal aún lo está analizando. Vuelvo con el resultado en cuanto esté, y si no, aquí queda el enlace:\n` +
            `   🔗 ${VT_LINK(status.sha256)}`
         );
      case "unresolved":
         return (
            `⚠️ ${code(fileName)} — no logré confirmar el veredicto (VirusTotal tardó más de la cuenta). ` +
            `Revísalo tú antes de fiarte:\n   🔗 ${VT_LINK(status.sha256)}`
         );
      case "budget_exhausted":
         return `😴 ${code(fileName)} — alcancé el límite diario de análisis de VirusTotal. Intenta de nuevo más tarde.`;
      case "queue_full":
         return `🕒 ${code(fileName)} — hay muchos archivos en cola ahora mismo. Vuelve a subirlo en un rato.`;
      case "too_large":
         return (
            `📦 ${code(fileName)} — pesa de más para mandarlo completo a analizar. ` +
            `Huella: \`${status.sha256}\`.\n   🔗 ${VT_LINK(status.sha256)}`
         );
      case "error":
         return `⚠️ ${code(fileName)} — no pude analizarlo (error técnico). Intenta de nuevo más tarde.`;
   }
}

/** Card header shared by the initial post and every later in-place edit. */
export const SCAN_HEADER = "🔎 **Análisis de seguridad (VirusTotal)**";

/** Appended once to a card that carries a 🛑 malicious verdict. */
export const MALICIOUS_FOOTER =
   "\n\n@here ⚠️ Se detectó un archivo potencialmente peligroso. Modera con precaución.";

const MALICIOUS_FOOTER_MARKER =
   "Se detectó un archivo potencialmente peligroso";

/** Idempotently add the mod ping to a card body (used by in-place edits). */
export function appendMaliciousFooter(content: string): string {
   return content.includes(MALICIOUS_FOOTER_MARKER)
      ? content
      : content + MALICIOUS_FOOTER;
}

/** The full scan message body (header + one line per file). Edited in place. */
export function renderScanMessage(lines: FileLine[]): string {
   const anyMalicious = lines.some(
      (l) =>
         !("phase" in l.status) &&
         l.status.kind === "verdict" &&
         l.status.verdict === "malicious",
   );
   const body = lines.map(renderLine).join("\n");
   return `${SCAN_HEADER}\n${body}${anyMalicious ? MALICIOUS_FOOTER : ""}`;
}

/** Compact admin-facing status block (shared by config_filescanner status). */
export function formatScannerStatus(input: {
   enabled: boolean;
   watchedChannels: string[];
   mediaNativeChannels: string[];
   /** Analyses still waiting on VirusTotal (the reconciler's queue). */
   pending: number;
   used24h: number;
   budget: number;
   minIntervalMs: number;
   counts: {
      total: number;
      malicious: number;
      suspicious: number;
      clean: number;
   };
   recent: { fileName: string | null; verdict: string; lastSeenAt: number }[];
   nowMs: number;
}): string[] {
   const {
      enabled,
      watchedChannels,
      mediaNativeChannels,
      pending,
      used24h,
      budget,
      minIntervalMs,
      counts,
      recent,
      nowMs,
   } = input;
   const lines: string[] = [];
   lines.push("🛡️ **File scanner (VirusTotal)**");
   lines.push(
      enabled
         ? "Estado: **activo**"
         : "Estado: **inactivo** (falta `VIRUSTOTAL_API_KEY`)",
   );
   lines.push(
      watchedChannels.length > 0
         ? `Canales vigilados: ${watchedChannels.map(renderWatchTarget).join(", ")}`
         : "Canales vigilados: _ninguno_ (usa `set_channels`)",
   );
   lines.push(
      mediaNativeChannels.length > 0
         ? `Canales de media (videos se saltan): ${mediaNativeChannels.map((id) => `<#${id}>`).join(", ")}`
         : "Canales de media: _ninguno_ (los videos se analizan en todos los canales vigilados)",
   );
   lines.push(
      `Presupuesto 24 h: ${used24h}/${budget} peticiones · espaciado ${Math.round(minIntervalMs / 1000)}s`,
   );
   lines.push(
      `Análisis en caché: ${counts.total} (🛑 ${counts.malicious} · ⚠️ ${counts.suspicious} · ✅ ${counts.clean})`,
   );
   lines.push(
      pending > 0
         ? `Análisis esperando veredicto: ${pending} (los reviso solos hasta ~1.5 h)`
         : "Análisis esperando veredicto: ninguno",
   );
   if (recent.length > 0) {
      lines.push("", "Últimos análisis:");
      for (const r of recent) {
         const emoji =
            r.verdict === "malicious"
               ? "🛑"
               : r.verdict === "suspicious"
                 ? "⚠️"
                 : "✅";
         lines.push(
            `• ${emoji} ${r.fileName ?? "(sin nombre)"} — hace ${formatAgoEs(nowMs - r.lastSeenAt)}`,
         );
      }
   }
   return lines;
}

/** Render a watched-target token (channel id, `all`, or `guild:<id>`) for humans. */
export function renderWatchTarget(token: string): string {
   if (token === "all") return "**todos los canales visibles**";
   if (token.startsWith("guild:"))
      return `**todo el servidor** (guild \`${token.slice(6)}\`)`;
   return `<#${token}>`;
}

/** Verdict-stats one-liner, reused where a compact summary is handy. */
export function statsSummary(stats: VerdictStats): string {
   return `mal ${stats.malicious} · susp ${stats.suspicious} · limpio ${stats.harmless} · s/detección ${stats.undetected}`;
}

function formatAgoEs(ms: number): string {
   const s = Math.max(0, Math.round(ms / 1000));
   if (s < 60) return `${s}s`;
   const m = Math.round(s / 60);
   if (m < 60) return `${m}min`;
   const h = Math.round(m / 60);
   if (h < 48) return `${h}h`;
   return `${Math.round(h / 24)}d`;
}
