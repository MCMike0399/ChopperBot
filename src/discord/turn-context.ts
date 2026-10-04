/**
 * What the model should know about a Discord message beyond its raw text.
 *
 * Every piece here comes from the 2026-09-23 general_chat audit (525 turns,
 * ~24k channel messages read back), where the bot answered the words and missed
 * the situation:
 *
 *  - **Non-text content was invisible or dropped.** A sticker-only reply to the
 *    bot got no answer at all (`1534771943474204692`) because an empty text
 *    body returned before attachments were looked at; PDFs were skipped with no
 *    trace, so the model couldn't even say "no puedo abrir PDFs aquí".
 *  - **`<@id>` was opaque.** 12 triggers mentioned another member as a raw
 *    snowflake the model can't resolve.
 *  - **The image a member was replying to was never seen** (a reply to a
 *    tianguis flyer was answered from the text alone). The single model is
 *    multimodal, and REST re-signs attachment URLs on fetch, so the parent's
 *    image can ride the same call.
 *  - **No channel context.** "Le dije q @bot es mejor" → "No sé a qué te
 *    refieres"; "mira" → "¿Mira qué?". 164 non-reply triggers had other messages
 *    in the 5 minutes before them.
 *
 * The functions take narrow structural shapes (not discord.js classes) so they
 * are unit-testable with plain objects.
 */

/** The bits of a Discord message these helpers read. */
export interface ContextMessage {
   id: string;
   content: string;
   createdTimestamp: number;
   author: {
      id: string;
      bot: boolean;
      username: string;
      globalName?: string | null;
   };
   member?: { displayName: string } | null;
   attachments: {
      values(): Iterable<{ name: string; contentType: string | null }>;
   };
   stickers?: { values(): Iterable<{ name: string }> };
   mentions?: {
      users?: {
         values(): Iterable<{
            id: string;
            username: string;
            globalName?: string | null;
         }>;
      };
      members?: { get(id: string): { displayName: string } | undefined } | null;
   };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function isImage(a: { name: string; contentType: string | null }): boolean {
   return (a.contentType ?? "").startsWith("image/") || IMAGE_EXT.test(a.name);
}

/** How the community sees this person: server nickname, else global name, else username. */
export function displayNameOf(
   m: Pick<ContextMessage, "author" | "member">,
): string {
   return m.member?.displayName || m.author.globalName || m.author.username;
}

/**
 * Annotate real user mentions with `@Name (<@id>)`, retaining usable IDs. The bot's own mention
 * is expected to be stripped already; anything unresolvable stays as-is.
 */
export function resolveUserMentions(
   text: string,
   m: Pick<ContextMessage, "mentions">,
): string {
   const names = new Map<string, string>();
   for (const u of m.mentions?.users?.values() ?? []) {
      names.set(
         u.id,
         m.mentions?.members?.get(u.id)?.displayName ||
            u.globalName ||
            u.username,
      );
   }
   return text.replace(/<@!?(\d{15,21})>/g, (whole, id: string) => {
      const name = names.get(id);
      return name ? `@${name} (<@${id}>)` : whole;
   });
}

/** Repair a model's invalid <@nickname> only from an unambiguous readable
 * identity. Unknown names become plain text; real IDs and mention policy stay.
 */
export function repairMemberMentions(
   reply: string,
   identities: readonly { id: string; name: string }[],
): string {
   const fold = (text: string) =>
      text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
   return reply.replace(/<@!?([^!&\d][^>]{0,99})>/g, (_token, name: string) => {
      const candidates = [
         ...new Set(
            identities
               .filter((i) => fold(i.name) === fold(name))
               .map((i) => i.id),
         ),
      ];
      return candidates.length === 1
         ? `<@${candidates[0]}>`
         : `@${name.replace(/[\r\n]/g, " ")}`;
   });
}

/**
 * Text notes for what the model cannot see as text: stickers by name (their
 * name usually IS the meaning — `:bebepensando:`), and non-image files by name
 * so the reply can acknowledge them instead of pretending they weren't sent.
 * Images are not listed: they ride the turn as pixels.
 */
export function nonTextNotes(
   m: Pick<ContextMessage, "attachments" | "stickers">,
): string[] {
   const notes: string[] = [];
   for (const s of m.stickers?.values() ?? [])
      notes.push(`[sticker: ${s.name}]`);
   const files = [...m.attachments.values()]
      .filter((a) => !isImage(a))
      .map((a) => a.name);
   if (files.length > 0) {
      notes.push(
         `[adjuntó ${files.length === 1 ? "un archivo que no puedes abrir aquí" : "archivos que no puedes abrir aquí"}: ${files.join(", ")}]`,
      );
   }
   return notes;
}

/** Whether a message carries any image attachment. */
export function hasImages(m: Pick<ContextMessage, "attachments">): boolean {
   return [...m.attachments.values()].some(isImage);
}

/**
 * The user text for a turn: the message's words (mentions resolved) plus notes
 * for stickers/files, or a placeholder when the member sent only an image. The
 * empty string means "nothing to answer" (a bare mention with nothing at all).
 */
export function composeUserText(
   strippedText: string,
   m: Pick<ContextMessage, "attachments" | "stickers" | "mentions">,
): string {
   const text = resolveUserMentions(strippedText, m).trim();
   const notes = nonTextNotes(m);
   const parts = [text, ...notes].filter(Boolean);
   if (parts.length === 0 && hasImages(m))
      return "(mandó una imagen sin texto)";
   return parts.join("\n");
}

/** Label telling the model where the extra images on this turn came from. */
export function parentImagesLabel(
   parentAuthor: string,
   count: number,
   parentIsBot: boolean,
): string {
   const who = parentIsBot
      ? "tu propio mensaje anterior"
      : `el mensaje de ${parentAuthor}`;
   return `[La persona está respondiendo a ${who}, que trae ${count === 1 ? "una imagen" : `${count} imágenes`} — ${count === 1 ? "va adjunta" : "van adjuntas"} a este turno para que la veas]`;
}

/** Header for a turn inside a thread or forum post: its title and opening post. */
export function renderThreadContext(
   threadName: string,
   starter: string | null,
): string {
   const opening = starter
      ? `\nPublicación inicial: «${starter.replace(/\s+/g, " ").trim().slice(0, 600)}»`
      : "";
   return `[Contexto — estás en el hilo/publicación «${threadName}».${opening}]`;
}
