import { describe, test, expect, vi } from 'vitest';
import { composeToolSources, type ToolSource, type ToolHandlerResult } from '../source.js';

function makeSource(
  name: string,
  toolNames: string[],
  handler: (n: string, i: unknown) => Promise<ToolHandlerResult>,
): ToolSource {
  return {
    name,
    async systemPromptSection() {
      return `## ${name}`;
    },
    tools() {
      return toolNames.map((tn) => ({
        name: tn,
        description: `${tn} tool`,
        inputSchema: { type: 'object', properties: {} },
      }));
    },
    handle: handler,
  };
}

describe('composeToolSources', () => {
  test('aggregates tools from all sources', () => {
    const a = makeSource('a', ['t1', 't2'], async () => ({ status: 'success', payload: {} }));
    const b = makeSource('b', ['t3'], async () => ({ status: 'success', payload: {} }));
    const composed = composeToolSources([a, b]);
    const names = composed.tools.map((t) => t.name);
    expect(names).toEqual(['t1', 't2', 't3']);
  });

  test('throws on tool-name collision', () => {
    const a = makeSource('a', ['shared'], async () => ({ status: 'success', payload: {} }));
    const b = makeSource('b', ['shared'], async () => ({ status: 'success', payload: {} }));
    expect(() => composeToolSources([a, b])).toThrow(/collision/);
  });

  test('routes a tool call to the source that owns it', async () => {
    const aHandler = vi.fn().mockResolvedValue({ status: 'success', payload: { from: 'a' } });
    const bHandler = vi.fn().mockResolvedValue({ status: 'success', payload: { from: 'b' } });
    const a = makeSource('a', ['ta'], aHandler);
    const b = makeSource('b', ['tb'], bHandler);
    const composed = composeToolSources([a, b]);
    const r = await composed.handle('tb', { foo: 1 });
    expect(r.payload).toEqual({ from: 'b' });
    expect(bHandler).toHaveBeenCalledWith('tb', { foo: 1 });
    expect(aHandler).not.toHaveBeenCalled();
  });

  test('returns error for an unknown tool name', async () => {
    const a = makeSource('a', ['ta'], async () => ({ status: 'success', payload: {} }));
    const composed = composeToolSources([a]);
    const r = await composed.handle('unknown', {});
    expect(r.status).toBe('error');
  });
});
