import { AttachmentBuilder, type Client } from 'discord.js';
import { chunkBotReply } from '../../discord/chunk.js';

export interface PublishedMinutes {
  messageId: string;
  url: string;
}

/**
 * Post the minutes to the output channel: the composed document chunked under
 * Discord's 2000-char cap (fences preserved), with the full minuta attached to
 * the first message so a long assembly is never lost to chunk truncation.
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
    throw new Error(`Minutas output channel ${deps.channelId} is not sendable`);
  }
  const files = [
    new AttachmentBuilder(Buffer.from(deps.minutesMd, 'utf8'), {
      name: `minuta-${deps.fileBaseName}.md`,
    }),
  ];
  const chunks = chunkBotReply(deps.docText);
  let firstId = '';
  let firstUrl = '';
  for (let i = 0; i < chunks.length; i++) {
    const sent = await channel.send({
      content: chunks[i]!,
      files: i === 0 ? files : undefined,
      allowedMentions: { parse: [] },
    });
    if (i === 0) {
      firstId = sent.id;
      firstUrl = sent.url;
    }
  }
  return { messageId: firstId, url: firstUrl };
}
