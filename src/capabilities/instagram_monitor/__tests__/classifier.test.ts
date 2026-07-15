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

  // The weaker vision model (Nova Lite) regularly writes the string "null"
  // instead of the JSON literal; left verbatim it printed a literal
  // "Cuándo: null" on the card. The parser must fold nullish tokens to a real
  // absence.
  test('normalizes a literal string "null"/"None" in when/where to real null', () => {
    const raw =
      '{"relevant":true,"type":"noticia","title":"x","summary":"y","when":"null","where":"None","tags":[]}';
    const c = parseClassificationReply(raw);
    expect(c!.when).toBeNull();
    expect(c!.where).toBeNull();
  });

  test('normalizes accented / upper-case nullish tokens (Sin Fecha, NINGUNO, N/A)', () => {
    const raw =
      '{"relevant":true,"type":"noticia","title":"x","summary":"y","when":"Sin Fecha","where":"N/A","tags":[]}';
    const c = parseClassificationReply(raw);
    expect(c!.when).toBeNull();
    expect(c!.where).toBeNull();
    const raw2 =
      '{"relevant":true,"type":"noticia","title":"x","summary":"y","when":"NINGUNO","where":"no especificado","tags":[]}';
    const c2 = parseClassificationReply(raw2);
    expect(c2!.when).toBeNull();
    expect(c2!.where).toBeNull();
  });

  test('normalizes nullish title/summary to empty strings', () => {
    const raw =
      '{"relevant":false,"type":"otro","title":"null","summary":"ninguna","when":null,"where":null,"tags":[]}';
    const c = parseClassificationReply(raw);
    expect(c!.title).toBe('');
    expect(c!.summary).toBe('');
  });

  test('keeps a real date / place unchanged', () => {
    const raw =
      '{"relevant":true,"type":"evento","title":"t","summary":"s","when":"2026-03-08","where":"CDMX","tags":[]}';
    const c = parseClassificationReply(raw);
    expect(c!.when).toBe('2026-03-08');
    expect(c!.where).toBe('CDMX');
  });
});

describe('classifyPost (two-stage: Nova reads, Kimi decides)', () => {
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
  const cover = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', format: 'jpeg' as const };

  beforeEach(() => askMock.mockReset());

  test('no cover → a single caption-only Kimi call on the medium tier, no attachment', async () => {
    askMock.mockResolvedValueOnce(goodReply);
    const out = await classifyPost('acc', post, { nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(1);
    const arg = askMock.mock.calls[0][0] as {
      effort: string;
      messages: Array<{ attachments?: unknown[] }>;
    };
    expect(arg.effort).toBe('medium');
    expect(arg.messages[0].attachments).toBeUndefined();
    expect(out.relevant).toBe(true);
  });

  test('with cover → stage 1 (image, low) transcribes; stage 2 (text, medium) classifies with the transcription inlined', async () => {
    const transcription = 'MARCHA 8M · 8 de marzo 17:00 · Zócalo CDMX';
    askMock
      .mockResolvedValueOnce(transcription) // stage 1: Nova vision transcription
      .mockResolvedValueOnce(goodReply); // stage 2: Kimi classification
    const out = await classifyPost('acc', post, { cover, nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(2);

    // Stage 1 is the vision call: carries the image on the low tier.
    const s1 = askMock.mock.calls[0][0] as {
      effort: string;
      messages: Array<{ attachments?: Array<{ mimeType: string; format: string }> }>;
    };
    expect(s1.effort).toBe('low');
    expect(s1.messages[0].attachments).toHaveLength(1);
    expect(s1.messages[0].attachments![0]).toMatchObject({ mimeType: 'image/jpeg', format: 'jpeg' });

    // Stage 2 is the decision call: text-only (no attachment), medium tier, and
    // the transcribed flyer text is inlined into what Kimi sees.
    const s2 = askMock.mock.calls[1][0] as {
      effort: string;
      messages: Array<{ content: string; attachments?: unknown[] }>;
    };
    expect(s2.effort).toBe('medium');
    expect(s2.messages[0].attachments).toBeUndefined();
    expect(s2.messages[0].content).toContain(transcription);

    expect(out.relevant).toBe(true);
  });

  test('transcription failure is non-fatal — still classifies caption-only, never drops the post', async () => {
    askMock
      .mockRejectedValueOnce(new Error('bedrock rejected image')) // stage 1 fails
      .mockResolvedValueOnce(goodReply); // stage 2 succeeds
    const out = await classifyPost('acc', post, { cover, nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(2);
    const s2 = askMock.mock.calls[1][0] as { messages: Array<{ attachments?: unknown[] }> };
    expect(s2.messages[0].attachments).toBeUndefined();
    expect(out.relevant).toBe(true);
    expect(out.reason).toBeUndefined();
  });

  test('empty transcription → no flyer section handed to Kimi', async () => {
    askMock
      .mockResolvedValueOnce('   ') // stage 1: whitespace only → treated as no text
      .mockResolvedValueOnce(goodReply);
    await classifyPost('acc', post, { cover, nowMs: Date.now() });
    const s2 = askMock.mock.calls[1][0] as { messages: Array<{ content: string }> };
    expect(s2.messages[0].content).not.toContain('transcrito');
  });

  test('gives up (non-relevant, reason ask_failed) only when the Kimi classification call fails', async () => {
    askMock
      .mockResolvedValueOnce('algún texto del flyer') // stage 1 ok
      .mockRejectedValueOnce(new Error('kimi down')); // stage 2 fails
    const out = await classifyPost('acc', post, { cover, nowMs: Date.now() });
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(out.relevant).toBe(false);
    expect(out.reason).toMatch(/ask_failed/);
  });
});
