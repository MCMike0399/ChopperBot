import { AttachmentBuilder, type Client } from "discord.js";
import { chunkBotReply } from "../../discord/chunk.js";

export interface PublishedMinutes {
   messageId: string;
   url: string;
}

/**
 * Post the minutes to the output channel as ONE message: the summary post
 * (header + Resumen + pointer, see `renderMinutesSummaryPost`) with the full
 * minuta attached as `minuta-<id>.md`.
 *
 * One message on purpose (user request 2026-09-23): the full acta used to be
 * chunked into the channel, several messages per assembly, flooding
 * #minutas-de-asambleas. The complete document is the attachment. If the text
 * ever exceeds Discord's cap anyway, only the first chunk is posted — the file
 * carries everything, so nothing is lost and the channel stays at one post.
 *
 * The raw transcript is deliberately NOT attached (user decision 2026-08-17):
 * a near-verbatim record of who said what is more than the channel needs and
 * more than participants signed up to have pinned in Discord. It stays in the
 * internal MinIO archive (`transcripcion.md` in the session prefix), where the
 * moderation team can pull it when an acta needs checking.
 *
 * `allowedMentions: { parse: [] }` on purpose: the minutes name participants
 * in plain text — an acta must never mass-ping everyone who spoke (the model
 * is told the same in the prompt; this is the gate, not the promise).
 */
export async function publishMinutes(deps: {
   client: Client;
   channelId: string;
   docText: string;
   minutesMd: string;
   fileBaseName: string;
}): Promise<PublishedMinutes> {
   const channel = await deps.client.channels.fetch(deps.channelId);
   if (!channel || !channel.isSendable()) {
      throw new Error(
         `Minutas output channel ${deps.channelId} is not sendable`,
      );
   }
   const file = new AttachmentBuilder(Buffer.from(deps.minutesMd, "utf8"), {
      name: `minuta-${deps.fileBaseName}.md`,
   });
   const sent = await channel.send({
      content: chunkBotReply(deps.docText)[0] ?? deps.docText.slice(0, 1900),
      files: [file],
      allowedMentions: { parse: [] },
   });
   return { messageId: sent.id, url: sent.url };
}
