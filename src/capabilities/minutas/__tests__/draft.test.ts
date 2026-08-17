import { describe, test, expect } from 'vitest';
import { buildTimeline, fmtClock, renderTranscript, type ChatNote, type SpeechBurst } from '../draft.js';

function burst(speaker: string, startedAtMs: number, texts: Array<[number, number, string]>): SpeechBurst {
  return {
    userId: speaker,
    speaker,
    startedAtMs,
    segments: texts.map(([startMs, endMs, text]) => ({ startMs, endMs, text })),
  };
}

describe('fmtClock', () => {
  test('renders mm:ss under an hour, h:mm:ss above', () => {
    expect(fmtClock(0)).toBe('00:00');
    expect(fmtClock(65_000)).toBe('01:05');
    expect(fmtClock(3_725_000)).toBe('1:02:05');
  });
});

describe('buildTimeline', () => {
  test('interleaves speakers chronologically and marks chat', () => {
    const bursts = [
      burst('Ana', 0, [[0, 2000, 'abro la sesión']]),
      burst('Beto', 5_000, [[0, 1500, 'propongo el foro']]),
    ];
    const chat: ChatNote[] = [{ atMs: 3_000, author: 'Carla', content: 'apoyo la propuesta' }];
    const timeline = buildTimeline(bursts, chat);
    expect(timeline.map((e) => [e.atMs, e.kind, e.speaker])).toEqual([
      [0, 'speech', 'Ana'],
      [3000, 'chat', 'Carla'],
      [5000, 'speech', 'Beto'],
    ]);
  });

  test('merges consecutive same-speaker utterances across a short gap', () => {
    const bursts = [
      burst('Ana', 0, [
        [0, 1000, 'primera parte,'],
        [2500, 3500, 'segunda parte'],
      ]),
    ];
    const timeline = buildTimeline(bursts, []);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.text).toBe('primera parte, segunda parte');
  });

  test('does NOT merge different speakers even when back to back', () => {
    const bursts = [
      burst('Ana', 0, [[0, 1000, 'digo algo']]),
      burst('Beto', 1_200, [[0, 800, 'respondo']]),
    ];
    const timeline = buildTimeline(bursts, []);
    expect(timeline).toHaveLength(2);
  });

  test('does NOT merge across a long silence', () => {
    const bursts = [
      burst('Ana', 0, [[0, 1000, 'al inicio']]),
      burst('Ana', 30_000, [[0, 1000, 'media hora después']]),
    ];
    expect(buildTimeline(bursts, [])).toHaveLength(2);
  });

  test('drops empty transcription segments and blank chat lines', () => {
    const bursts = [burst('Ana', 0, [[0, 1000, '   '], [1000, 2000, 'real']])];
    const chat: ChatNote[] = [{ atMs: 500, author: 'Carla', content: '  ' }];
    const timeline = buildTimeline(bursts, chat);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.text).toBe('real');
  });

  test('burst offsets sum onto the burst start (absolute timeline)', () => {
    const bursts = [burst('Ana', 60_000, [[2_000, 4_000, 'un minuto dentro']])];
    const timeline = buildTimeline(bursts, []);
    expect(timeline[0]!.atMs).toBe(62_000);
  });
});

describe('renderTranscript', () => {
  test('formats speech and chat lines distinctly', () => {
    const entries = buildTimeline(
      [burst('Ana', 0, [[0, 1000, 'hola']])],
      [{ atMs: 2000, author: 'Carla', content: 'jeje' }],
    );
    const text = renderTranscript(entries);
    expect(text).toBe('[00:00] Ana: hola\n[00:02] 💬 Carla (chat): jeje');
  });
});
