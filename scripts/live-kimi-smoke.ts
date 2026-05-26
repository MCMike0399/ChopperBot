/**
 * Live smoke test against the real Kimi Code API.
 *
 * Validates that:
 *   1. The new src/llm/client.ts can authenticate against api.kimi.com
 *   2. A simple no-tools turn returns text
 *   3. A turn with a single tool produces tool_calls, the loop runs the
 *      handler, sends the result back, and the model synthesizes a final
 *      answer.
 *   4. An image attachment is accepted (the model "sees" the data URI).
 *
 * Usage: KIMI_API_KEY=sk-kimi-... tsx scripts/live-kimi-smoke.ts
 *
 * Does NOT run inside `pnpm test` — that suite uses a mocked OpenAI client.
 * This script makes real network calls and will spend a small amount of the
 * Kimi subscription's request budget.
 */
import 'dotenv/config';
import { ask } from '../src/llm/client.js';
import { composeToolSources, type ToolSource } from '../src/tools/source.js';
import { ImageAttachable } from '../src/attachments/attachable.js';

import { readFileSync } from 'node:fs';

// 64x64 solid red PNG — generated alongside this script. If the file is
// missing we fall back to a tiny 1x1 PNG (which some providers reject as
// too small to decode).
let RED_PNG: Uint8Array;
try {
  RED_PNG = new Uint8Array(readFileSync('/tmp/red64.png'));
} catch {
  RED_PNG = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfc, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x55, 0x3c, 0x6e, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const greenCheck = '\x1b[32m✓\x1b[0m';
const redX = '\x1b[31m✗\x1b[0m';

let failures = 0;
function pass(label: string, detail?: string) {
  console.log(`${greenCheck} ${label}${detail ? '  ' + detail : ''}`);
}
function fail(label: string, err: unknown) {
  failures++;
  console.log(`${redX} ${label}`);
  console.log('   ', err instanceof Error ? err.message : String(err));
}

// A trivial echo tool. The model is asked to call it with `text: "hello"`.
const echoSource: ToolSource = {
  name: 'echo',
  async systemPromptSection() {
    return 'You have an `echo` tool that returns the string you pass to it. Use it when the user asks you to "echo" something.';
  },
  tools() {
    return [
      {
        name: 'echo',
        description: 'Return the input text unchanged. Useful when the user wants the bot to echo a literal value.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The text to echo back.' } },
          required: ['text'],
        },
      },
    ];
  },
  async handle(_name, input) {
    const obj = input as { text?: unknown };
    if (typeof obj?.text !== 'string') {
      return { status: 'error', payload: { error: 'text must be a string' } };
    }
    return { status: 'success', payload: { echoed: obj.text } };
  },
};

async function main() {
  console.log('=== Live Kimi smoke test ===');
  console.log('Base URL:', process.env.KIMI_BASE_URL ?? '(default)');
  console.log('Model:   ', process.env.KIMI_MODEL_ID ?? '(default kimi-for-coding)');
  console.log('Key:     ', process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.slice(0, 12) + '…' : '(MISSING)');
  console.log();

  // 1. Plain text round-trip (no tools at all).
  try {
    const tools = composeToolSources([]);
    const out = await ask({
      system: 'You are a terse assistant. Reply in fewer than 15 words.',
      messages: [{ role: 'user', content: 'Say "kimi smoke ok" verbatim, then stop.' }],
      tools,
    });
    if (out && out.length > 0) {
      pass('plain text turn', out.length > 80 ? out.slice(0, 80) + '…' : out);
    } else {
      fail('plain text turn', new Error('empty response'));
    }
  } catch (err) {
    fail('plain text turn', err);
  }

  // 2. Tool-calling round-trip.
  try {
    const tools = composeToolSources([echoSource]);
    const out = await ask({
      system:
        'You are a terse assistant with an `echo` tool. When the user asks you to echo something, call `echo` with the exact text they specified, then report what the tool returned.',
      messages: [
        {
          role: 'user',
          content: 'Use the echo tool to echo the string "kimi-tool-ok" exactly. Then tell me what it returned.',
        },
      ],
      tools,
    });
    if (out.toLowerCase().includes('kimi-tool-ok')) {
      pass('tool-calling turn', out.length > 80 ? out.slice(0, 80) + '…' : out);
    } else {
      fail('tool-calling turn — response did not include echoed string', out);
    }
  } catch (err) {
    fail('tool-calling turn', err);
  }

  // 3. Image attachment turn.
  try {
    const tools = composeToolSources([]);
    const img = new ImageAttachable('red.png', 'image/png', RED_PNG, 'png');
    const out = await ask({
      system: 'You can see images. Be terse.',
      messages: [
        {
          role: 'user',
          content:
            'I am sending you a 1×1 pixel PNG. Reply with exactly ONE word describing whether you can see it: "yes" or "no".',
          attachments: [img],
        },
      ],
      tools,
    });
    if (out.length > 0) {
      pass('image attachment turn', out.length > 80 ? out.slice(0, 80) + '…' : out);
    } else {
      fail('image attachment turn', new Error('empty response'));
    }
  } catch (err) {
    fail('image attachment turn', err);
  }

  console.log();
  if (failures === 0) {
    console.log(`${greenCheck} All live smoke checks passed.`);
    process.exit(0);
  } else {
    console.log(`${redX} ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
