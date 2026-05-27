import { AttachmentBuilder, type Client, type Message, type TextChannel } from 'discord.js';
import { log } from '../../log.js';
import type { Classification } from './classifier.js';
import type { RecentPost } from './fetcher.js';
import { formatEventWhen, formatPostedAt } from './format.js';

const DISCORD_FILE_LIMIT_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CAROUSEL_ATTACHMENTS = 4;

const IG_CDN_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

const TYPE_EMOJI: Record<Classification['type'], string> = {
  evento: '📅',
  convocatoria: '📢',
  alerta: '🚨',
  acuerpamiento: '🤝',
  actualización: '🔔',
  noticia: '📰',
  otro: '📌',
};

export interface PublishResult {
  messageId: string | null;
  ok: boolean;
  reason?: string;
}

/**
 * Renders the Spanish summary card for a relevant IG post and posts it to the
 * monitor channel, with media re-uploaded as native Discord attachments so
 * the embeds survive Instagram's ~24h CDN URL expiry.
 */
export async function publishPost(
  client: Client,
  channelId: string,
  account: string,
  post: RecentPost,
  classification: Classification,
  /** Pre-fetched cover image bytes (the same buffer used by the classifier). */
  coverBytes: Uint8Array | null,
): Promise<PublishResult> {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    return { messageId: null, ok: false, reason: 'channel_not_sendable' };
  }
  const text = renderText(account, post, classification);

  const files: AttachmentBuilder[] = [];
  if (coverBytes && coverBytes.byteLength <= DISCORD_FILE_LIMIT_BYTES) {
    files.push(new AttachmentBuilder(Buffer.from(coverBytes), { name: `${post.shortcode}.jpg` }));
  }

  // For carousels, append up to 3 more images so the user can scan the set
  // without opening Instagram. Skip on oversized fetches.
  if (post.mediaType === 'carousel' && post.carouselUrls && post.carouselUrls.length > 1) {
    for (let i = 1; i < post.carouselUrls.length && files.length < MAX_CAROUSEL_ATTACHMENTS; i++) {
      try {
        const bytes = await fetchBytes(post.carouselUrls[i]);
        if (bytes && bytes.byteLength <= DISCORD_FILE_LIMIT_BYTES) {
          files.push(
            new AttachmentBuilder(Buffer.from(bytes), {
              name: `${post.shortcode}-${i + 1}.jpg`,
            }),
          );
        }
      } catch (err) {
        log.warn({ err, idx: i, shortcode: post.shortcode }, 'carousel image fetch failed');
      }
    }
  }

  let video: AttachmentBuilder | null = null;
  if (post.mediaType === 'video' && post.videoUrl) {
    try {
      const bytes = await fetchBytes(post.videoUrl);
      if (bytes && bytes.byteLength <= DISCORD_FILE_LIMIT_BYTES) {
        video = new AttachmentBuilder(Buffer.from(bytes), { name: `${post.shortcode}.mp4` });
      } else {
        log.info(
          { shortcode: post.shortcode, size: bytes?.byteLength ?? 0 },
          'video too large for Discord re-upload; linking instead',
        );
      }
    } catch (err) {
      log.warn({ err, shortcode: post.shortcode }, 'video fetch failed; linking instead');
    }
  }
  if (video) files.push(video);

  try {
    const msg: Message = await (channel as TextChannel).send({ content: text, files });
    log.info(
      {
        channelId,
        account,
        shortcode: post.shortcode,
        type: classification.type,
        files: files.length,
      },
      'instagram_monitor.push',
    );
    return { messageId: msg.id, ok: true };
  } catch (err) {
    log.error({ err, account, shortcode: post.shortcode }, 'instagram_monitor.push_failed');
    return {
      messageId: null,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function renderText(account: string, post: RecentPost, c: Classification): string {
  const emoji = TYPE_EMOJI[c.type] ?? '📌';
  const meta: string[] = [`Tipo: **${c.type}**`, `@${account}`];
  if (c.when) meta.push(`Cuándo: **${formatEventWhen(c.when)}**`);
  if (c.where) meta.push(`Dónde: ${c.where}`);
  meta.push(`Posteado: ${formatPostedAt(post.takenAtMs)}`);
  const tags = c.tags.length > 0 ? `\nTags: ${c.tags.map((t) => `\`${t}\``).join(' · ')}` : '';
  const url = `https://instagram.com/p/${post.shortcode}`;
  const body = c.summary || c.title;
  // Italicize the meta line with `*…*` rather than `_…_`: Discord's
  // underscore-italic won't close when adjacent to an alphanumeric (the line
  // ends in a digit, e.g. "12:01"), leaving a stray literal `_`. Asterisks have
  // no intraword restriction and close cleanly.
  return `${emoji} **${c.title || '(sin título)'}**\n*${meta.join(' · ')}*${tags}\n\n${body}\n\n🔗 ${url}`;
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: IG_CDN_HEADERS, signal: ctrl.signal });
    if (!res.ok) {
      log.warn({ url, status: res.status }, 'IG CDN fetch non-ok');
      return null;
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timer);
  }
}

/** Exposed so the scheduler can pre-fetch the cover once and share with the classifier. */
export async function fetchCover(url: string): Promise<Uint8Array | null> {
  try {
    return await fetchBytes(url);
  } catch (err) {
    log.warn({ url, err }, 'fetchCover failed');
    return null;
  }
}
