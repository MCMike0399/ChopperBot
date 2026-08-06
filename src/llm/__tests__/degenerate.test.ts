/**
 * Degenerate-output guard. Live 2026-08-06: after a 147k-input-token turn Kimi
 * lost the tool-call protocol and posted ~8 Discord messages of self-directed
 * scaffolding ("Use the tool. Done. Now. {"name": "workshop_read_file", …}")
 * into a member's private taller. Such text must never be shown; the client
 * discards it and forces a tools-free pass for real prose.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { ask, isDegenerateOutput } from '../client.js';
import { composeToolSources, type ToolSource } from '../../tools/source.js';

const SCAFFOLDING = `Use the tool. Done. Now. OK. The tool call is:
<tool_call>
name: workshop_read_file
arguments: {"path":"resumen_epilogo.txt","max_bytes":16000}
</tool_call>
Use the tool. Done. Now. End. Use the tool. Stop. Use the tool. Now.`;

describe('isDegenerateOutput', () => {
  test('flags the live scaffolding leak', () => {
    expect(isDegenerateOutput(SCAFFOLDING)).toBe(true);
  });

  test('flags a bare tool-call envelope', () => {
    expect(isDegenerateOutput('{"name": "workshop_read_file", "arguments": {"path": "a.txt"}}')).toBe(true);
    expect(isDegenerateOutput('<tool_call>{"name":"x"}</tool_call>')).toBe(true);
  });

  test('does NOT flag ordinary answers, even technical ones', () => {
    expect(isDegenerateOutput('¡Listo! Te envié el Excel con tres hojas.')).toBe(false);
    expect(
      isDegenerateOutput(
        'Para leer el PDF usé la herramienta de Python con pdftotext; el resultado quedó en texto.txt.',
      ),
    ).toBe(false);
    expect(isDegenerateOutput('El JSON que me pasaste tiene "name" y "arguments" mal anidados.')).toBe(false);
    expect(isDegenerateOutput('')).toBe(false);
  });
});

const echoSource: ToolSource = {
  name: 'echo',
  systemPromptSection: async () => '',
  tools: () => [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }],
  handle: async () => ({ status: 'success', payload: { ok: true } }),
};

function res(content: string, finish = 'stop') {
  return {
    choices: [{ finish_reason: finish, message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

beforeEach(() => createMock.mockReset());

describe('ask() — degenerate output is never returned', () => {
  test('scaffolding is discarded and the retry text is used instead', async () => {
    createMock.mockResolvedValueOnce(res(SCAFFOLDING)).mockResolvedValueOnce(res('Aquí va tu resumen.'));
    const out = await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: composeToolSources([echoSource]),
    });
    expect(out).toBe('Aquí va tu resumen.');
  });

  test('persistent scaffolding ends in the forcing pass, and its prose is used', async () => {
    createMock
      .mockResolvedValueOnce(res(SCAFFOLDING))
      .mockResolvedValueOnce(res(SCAFFOLDING))
      .mockResolvedValueOnce(res(SCAFFOLDING))
      // The forcing pass (no tools) finally answers.
      .mockResolvedValueOnce(res('Resumen final del libro.'));
    const out = await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: composeToolSources([echoSource]),
    });
    expect(out).toBe('Resumen final del libro.');
    // The forcing request must carry NO tools.
    const forced = createMock.mock.calls.at(-1)?.[0] as { tools?: unknown };
    expect(forced.tools).toBeUndefined();
  });

  test('all-degenerate ends in the Spanish fallback, never the scaffolding', async () => {
    createMock.mockResolvedValue(res(SCAFFOLDING));
    const out = await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: composeToolSources([echoSource]),
    });
    expect(out).not.toContain('tool_call');
    expect(out).not.toContain('Use the tool');
    expect(out).toContain('No pude generar una respuesta');
  });
});
