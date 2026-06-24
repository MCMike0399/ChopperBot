import { describe, test, expect, vi, beforeEach } from 'vitest';

// Capture the ask() call so we can assert what the classifier hands the LLM.
const { askMock } = vi.hoisted(() => ({ askMock: vi.fn() }));
vi.mock('../../../llm/client.js', () => ({ ask: askMock }));

const { parseClassificationReply, classifyPost } = await import('../classifier.js');
import type { RecentPost } from '../fetcher.js';

describe('parseClassificationReply', () => {
  test('parses a clean JSON object', () => {
    const raw = JSON.stringify({
      relevant: true,
      type: 'evento',
      title: 'Marcha 8M',
      summary: 'Marcha en CDMX',
      when: '2026-03-08T18:00:00-06:00',
      where: 'CDMX',
      tags: ['cdmx', 'feminismo'],
    });
    const c = parseClassificationReply(raw);
    expect(c).not.toBeNull();
    expect(c!.relevant).toBe(true);
    expect(c!.type).toBe('evento');
    expect(c!.title).toBe('Marcha 8M');
    expect(c!.tags).toEqual(['cdmx', 'feminismo']);
  });

  test('strips ```json fences', () => {
    const raw = '```json\n{"relevant":false,"type":"otro","title":"","summary":"","when":null,"where":null,"tags":[]}\n```';
    const c = parseClassificationReply(raw);
    expect(c).not.toBeNull();
    expect(c!.relevant).toBe(false);
  });

  test('tolerates leading prose before the JSON object', () => {
    const raw =
      'Aquí está el resultado:\n{"relevant":true,"type":"alerta","title":"X","summary":"y","when":null,"where":"CDMX","tags":["x"]}';
    const c = parseClassificationReply(raw);
    expect(c).not.toBeNull();
    expect(c!.type).toBe('alerta');
    expect(c!.where).toBe('CDMX');
  });

  test('coerces unknown type to "otro"', () => {
    const raw = '{"relevant":true,"type":"weird","title":"x","summary":"y","when":null,"where":null,"tags":[]}';
    const c = parseClassificationReply(raw);
    expect(c!.type).toBe('otro');
  });

  test('clamps tags to 5 strings, drops non-strings', () => {
    const raw =
      '{"relevant":true,"type":"otro","title":"","summary":"","when":null,"where":null,"tags":["a","b",3,"c","d","e","f"]}';
    const c = parseClassificationReply(raw);
    expect(c!.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('returns null on garbage text', () => {
    expect(parseClassificationReply('lol no json here')).toBeNull();
    expect(parseClassificationReply('')).toBeNull();
  });

  test('returns null on unbalanced braces', () => {
    expect(parseClassificationReply('{ "relevant": true ')).toBeNull();
  });
});

describe('classifyPost', () => {
  const post: RecentPost = {
    igPostId: '123',
    shortcode: 'ABC',
    caption: 'Convocatoria',
    takenAtMs: Date.parse('2026-06-22T20:00:00Z'),
    mediaType: 'image',
    displayUrl: 'https://example/c.jpg',
  };
  const goodReply = JSON.stringify({
    relevant: true, type: 'convocatoria', title: 't', summary: 's', when: null, where: null, tags: [],
  });

  beforeEach(() => askMock.mockReset());

  test('runs on the medium effort tier', async () => {
    askMock.mockResolvedValueOnce(goodReply);
    await classifyPost('acc', post, { nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock.mock.calls[0][0]).toMatchObject({ effort: 'medium' });
  });

  test('forwards the cover image as an attachment when present', async () => {
    askMock.mockResolvedValueOnce(goodReply);
    const cover = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', format: 'jpeg' as const };
    await classifyPost('acc', post, { cover, nowMs: Date.now() });
    const arg = askMock.mock.calls[0][0] as { messages: Array<{ attachments?: unknown[] }> };
    expect(arg.messages[0].attachments).toHaveLength(1);
    expect(arg.messages[0].attachments![0]).toMatchObject({ mimeType: 'image/jpeg', format: 'jpeg' });
  });

  test('sends no attachment when there is no cover', async () => {
    askMock.mockResolvedValueOnce(goodReply);
    await classifyPost('acc', post, { nowMs: Date.now() });
    const arg = askMock.mock.calls[0][0] as { messages: Array<{ attachments?: unknown[] }> };
    expect(arg.messages[0].attachments).toBeUndefined();
  });

  test('retries caption-only when the cover image is rejected, never dropping the post', async () => {
    askMock
      .mockRejectedValueOnce(new Error('image format not supported')) // image attempt fails
      .mockResolvedValueOnce(goodReply); // caption-only retry succeeds
    const cover = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', format: 'jpeg' as const };
    const out = await classifyPost('acc', post, { cover, nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(2);
    // First call carried the image; the retry did not.
    expect((askMock.mock.calls[0][0] as { messages: Array<{ attachments?: unknown[] }> }).messages[0].attachments).toHaveLength(1);
    expect((askMock.mock.calls[1][0] as { messages: Array<{ attachments?: unknown[] }> }).messages[0].attachments).toBeUndefined();
    expect(out.relevant).toBe(true); // recovered, not dropped
    expect(out.reason).toBeUndefined();
  });

  test('gives up with a non-relevant result only when even caption-only fails', async () => {
    askMock
      .mockRejectedValueOnce(new Error('bedrock down')) // image attempt
      .mockRejectedValueOnce(new Error('bedrock down')); // caption-only retry
    const cover = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', format: 'jpeg' as const };
    const out = await classifyPost('acc', post, { cover, nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(out.relevant).toBe(false);
    expect(out.reason).toMatch(/ask_failed/);
  });
});
