import type { Message, Attachment } from 'discord.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { Attachable, ImageAttachable } from './attachable.js';
import type { ImageFormat } from './attachable.js';

const IMAGE_MIME_MAP: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const EXTENSION_IMAGE_MAP: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
};

function detectFormat(attachment: Attachment): { format: ImageFormat } | null {
  const contentType = (attachment.contentType ?? '').split(';')[0].trim();
  if (IMAGE_MIME_MAP[contentType]) return { format: IMAGE_MIME_MAP[contentType] };
  const ext = attachment.name.split('.').pop()?.toLowerCase() ?? '';
  if (EXTENSION_IMAGE_MAP[ext]) return { format: EXTENSION_IMAGE_MAP[ext] };
  return null;
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve Discord message attachments into LLM-compatible Attachables. Only
 * image formats (png/jpeg/gif/webp) are supported — PDFs, csv, docx, etc.
 * land in the "unsupported attachment type, skipping" branch (the bot only
 * sends images to the Bedrock Converse API).
 */
export async function resolveAttachments(message: Message): Promise<Attachable[]> {
  if (message.attachments.size === 0) return [];

  if (message.attachments.size > config.MAX_ATTACHMENT_COUNT) {
    log.warn(
      { count: message.attachments.size, max: config.MAX_ATTACHMENT_COUNT },
      'Too many attachments on message; only processing first N',
    );
  }

  const results: Attachable[] = [];
  let processed = 0;

  for (const attachment of message.attachments.values()) {
    if (processed >= config.MAX_ATTACHMENT_COUNT) break;
    processed++;
    if (attachment.size > config.MAX_ATTACHMENT_BYTES) {
      log.warn(
        { fileName: attachment.name, size: attachment.size, max: config.MAX_ATTACHMENT_BYTES },
        'Attachment too large, skipping',
      );
      continue;
    }

    const detected = detectFormat(attachment);
    if (!detected) {
      log.warn(
        { fileName: attachment.name, contentType: attachment.contentType },
        'Unsupported attachment type, skipping',
      );
      continue;
    }

    try {
      const bytes = await downloadBytes(attachment.url);
      const mimeType = attachment.contentType ?? `image/${detected.format}`;
      results.push(new ImageAttachable(attachment.name, mimeType, bytes, detected.format));
      log.info(
        { fileName: attachment.name, format: detected.format, bytes: bytes.length },
        'Attachment resolved',
      );
    } catch (err) {
      log.error({ err, fileName: attachment.name, url: attachment.url }, 'Failed to download attachment');
    }
  }

  return results;
}
