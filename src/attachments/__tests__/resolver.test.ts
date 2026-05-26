import { describe, test, expect, vi, beforeEach } from 'vitest';
import { resolveAttachments } from '../resolver.js';
import { ImageAttachable } from '../attachable.js';
import type { Message, Attachment } from 'discord.js';

// Mock config so MAX_ATTACHMENT_BYTES is predictable
vi.mock('../../config.js', () => ({
  config: { MAX_ATTACHMENT_BYTES: 1024, MAX_ATTACHMENT_COUNT: 3, LOG_LEVEL: 'fatal' },
}));

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    name: 'file.png',
    contentType: 'image/png',
    size: 100,
    url: 'https://cdn.discordapp.com/attachments/123/456/file.png',
    proxyURL: 'https://media.discordapp.net/attachments/123/456/file.png',
    ...overrides,
  } as Attachment;
}

function makeMessage(attachments: Attachment[]): Message {
  return {
    attachments: {
      size: attachments.length,
      values: () => attachments[Symbol.iterator](),
      [Symbol.iterator]: () => attachments[Symbol.iterator](),
    },
  } as unknown as Message;
}

describe('resolveAttachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('returns empty array when no attachments', async () => {
    const msg = makeMessage([]);
    const result = await resolveAttachments(msg);
    expect(result).toEqual([]);
  });

  test('skips oversized attachments', async () => {
    const msg = makeMessage([makeAttachment({ size: 2048, name: 'huge.png' })]);
    const result = await resolveAttachments(msg);
    expect(result).toEqual([]);
  });

  test('skips unsupported MIME types (video)', async () => {
    const msg = makeMessage([makeAttachment({ contentType: 'video/mp4', name: 'clip.mp4' })]);
    const result = await resolveAttachments(msg);
    expect(result).toEqual([]);
  });

  test('skips PDFs (Kimi does not accept documents)', async () => {
    const msg = makeMessage([makeAttachment({ contentType: 'application/pdf', name: 'doc.pdf' })]);
    const result = await resolveAttachments(msg);
    expect(result).toEqual([]);
  });

  test('skips spreadsheets / office documents', async () => {
    const msg = makeMessage([
      makeAttachment({
        name: 'budget.xlsx',
        contentType: 'application/octet-stream',
        size: 100,
      }),
    ]);
    const result = await resolveAttachments(msg);
    expect(result).toEqual([]);
  });

  test('resolves image by MIME type', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response);

    const msg = makeMessage([makeAttachment()]);
    const result = await resolveAttachments(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(ImageAttachable);
    expect(result[0].fileName).toBe('file.png');
    expect((result[0] as ImageAttachable).format).toBe('png');
  });

  test('resolves image by extension fallback', async () => {
    const bytes = new Uint8Array([255, 216, 255]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response);

    const msg = makeMessage([
      makeAttachment({
        name: 'photo.jpg',
        contentType: 'application/octet-stream',
        size: 100,
      }),
    ]);
    const result = await resolveAttachments(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(ImageAttachable);
    expect((result[0] as ImageAttachable).format).toBe('jpeg');
  });

  test('handles download failure gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as unknown as Response);

    const msg = makeMessage([makeAttachment()]);
    const result = await resolveAttachments(msg);

    expect(result).toEqual([]);
  });

  test('handles fetch throwing (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const msg = makeMessage([makeAttachment()]);
    const result = await resolveAttachments(msg);

    expect(result).toEqual([]);
  });

  test('strips MIME parameters before lookup', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response);

    const msg = makeMessage([makeAttachment({ contentType: 'image/png; charset=binary' })]);
    const result = await resolveAttachments(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(ImageAttachable);
  });

  test('respects MAX_ATTACHMENT_COUNT', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      } as unknown as Response);

    const msg = makeMessage([
      makeAttachment({ name: 'a.png' }),
      makeAttachment({ name: 'b.png' }),
      makeAttachment({ name: 'c.png' }),
      makeAttachment({ name: 'd.png' }),
    ]);
    const result = await resolveAttachments(msg);

    expect(result).toHaveLength(3);
  });
});
