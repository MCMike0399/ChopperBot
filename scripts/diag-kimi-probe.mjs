// Minimum-viable Kimi key smoke test. Mirrors src/llm/client.ts's OpenAI()
// construction; logs the resolved key suffix so you can spot the case where
// a stale `export KIMI_API_KEY=...` in ~/.zshrc is silently shadowing .env
// (dotenv defaults to override: false). `unset KIMI_API_KEY && node ...` is
// the quickest way to force .env to win.
import 'dotenv/config';
import OpenAI from 'openai';

console.log('using key ending in: ...' + (process.env.KIMI_API_KEY || '').slice(-12));

const c = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1',
  defaultHeaders: { 'User-Agent': process.env.KIMI_USER_AGENT || 'claude-cli/1.0.0' },
});

try {
  const r = await c.chat.completions.create({
    model: process.env.KIMI_MODEL_ID || 'kimi-for-coding',
    messages: [{ role: 'user', content: 'Write Python: return 1+1' }],
    max_tokens: 10,
    temperature: 0.2,
  });
  console.log('NODE_KIMI: OK finish=' + r.choices[0]?.finish_reason);
} catch (e) {
  console.log('NODE_KIMI: ERR status=' + (e.status || '') + ' msg=' + e.message);
}
