// dotenv defaults to `override: false` — pre-existing shell env vars win
// over .env values. If the bot uses a stale credential, suspect a leftover
// `export FOO=...` in ~/.zshrc or ~/.profile shadowing .env. `unset FOO`
// or fix the rc file; do not flip override to true here (legitimate dev
// workflows depend on shell-var overrides).
import 'dotenv/config';
import { z } from 'zod';

const GuildChannelConfigSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/).optional(),
  guildName: z.string().optional(),
  channels: z.array(z.string().regex(/^\d{17,20}$/)).min(1),
});

const ChannelCapabilityConfigSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/).optional(),
  guildName: z.string().optional(),
  channels: z
    .array(
      z.object({
        id: z.string().regex(/^\d{17,20}$/),
        capability: z.string().min(1),
      }),
    )
    .min(1),
});

// Empty env-var values (e.g. `DISCORD_CHANNEL_ID=` left blank in a .env file
// where the operator only populates DISCORD_CHANNEL_CAPABILITIES) should be
// treated as "not set" — not as an invalid empty string that crashes boot.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const ConfigSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CHANNEL_ID: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{17,20}$/, 'DISCORD_CHANNEL_ID must be a Discord snowflake')
      .optional(),
  ),
  DISCORD_AUTHORIZED_CHANNELS: z.string().optional(),
  DISCORD_CHANNEL_CAPABILITIES: z.string().optional(),
  CHOPPERBOT_DATA_DIR: z.string().default('./data'),
  DEFAULT_CAPABILITY: z.string().min(1).default('calendar'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  KIMI_API_KEY: z.string().min(1, 'KIMI_API_KEY is required'),
  KIMI_BASE_URL: z.string().min(1).default('https://api.kimi.com/coding/v1'),
  KIMI_MODEL_ID: z.string().min(1).default('kimi-for-coding'),
  KIMI_USER_AGENT: z.string().min(1).default('claude-cli/1.0.0'),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_ATTACHMENT_COUNT: z.coerce.number().int().positive().default(5),
  // Instagram session auth (optional). When IG_SESSIONID + IG_CSRFTOKEN +
  // IG_DS_USER_ID are all present, direct fetches attach the logged-in cookies
  // and x-csrftoken header, which gets far higher rate limits than anonymous
  // requests. Use a THROWAWAY account — automated polling risks a ban. Sessions
  // expire; the scheduler logs `instagram_monitor.auth.expired` so the
  // log-watcher can alert you to refresh the cookies.
  IG_SESSIONID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  IG_CSRFTOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  IG_DS_USER_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  IG_MID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  IG_DID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // User-Agent sent on every IG request. SHOULD match the browser the session
  // cookies were extracted from — a session driven from a UA different than the
  // one that created it is a fingerprint signal. Critical on a personal account.
  // Unset = the built-in desktop-Chrome default (DEFAULT_IG_USER_AGENT).
  IG_USER_AGENT: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Hard ceiling on outbound IG HTTP requests in a rolling 24h window (one poll
  // ≈ 2–3 calls: optional warmup + pk-resolve + feed). On hit, polling
  // soft-pauses (auto-recovers as the window drains) and the operator is
  // alerted. A backstop against runaway request volume.
  IG_DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().default(120),
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

let cachedChannels: Set<string> | null = null;
let cachedCapabilityMap: Map<string, string> | null = null;

/**
 * Set of all Discord channelIds the bot will respond in. Derived from
 * (in priority order):
 *   1. DISCORD_CHANNEL_CAPABILITIES (new per-channel capability mapping)
 *   2. DISCORD_AUTHORIZED_CHANNELS  (legacy: list of channels, all run
 *      DEFAULT_CAPABILITY)
 *   3. DISCORD_CHANNEL_ID           (single legacy channel)
 */
export function getAuthorizedChannelIds(): Set<string> {
  if (cachedChannels) return cachedChannels;
  cachedChannels = new Set(getChannelCapabilityMap().keys());
  return cachedChannels;
}

/**
 * channelId → capabilityId mapping. The single source of truth for routing.
 * `getAuthorizedChannelIds()` is a projection of this.
 */
export function getChannelCapabilityMap(): Map<string, string> {
  if (cachedCapabilityMap) return cachedCapabilityMap;
  const map = new Map<string, string>();
  const fallback = config.DEFAULT_CAPABILITY;

  if (config.DISCORD_CHANNEL_CAPABILITIES) {
    const raw = JSON.parse(config.DISCORD_CHANNEL_CAPABILITIES);
    const validated = z.array(ChannelCapabilityConfigSchema).parse(raw);
    for (const guild of validated) {
      for (const ch of guild.channels) {
        if (map.has(ch.id)) {
          throw new Error(
            `Channel "${ch.id}" appears more than once in DISCORD_CHANNEL_CAPABILITIES`,
          );
        }
        map.set(ch.id, ch.capability);
      }
    }
  } else if (config.DISCORD_AUTHORIZED_CHANNELS) {
    const parsed = JSON.parse(config.DISCORD_AUTHORIZED_CHANNELS);
    const validated = z.array(GuildChannelConfigSchema).parse(parsed);
    for (const guild of validated) {
      for (const id of guild.channels) {
        map.set(id, fallback);
      }
    }
  } else if (config.DISCORD_CHANNEL_ID) {
    map.set(config.DISCORD_CHANNEL_ID, fallback);
  }

  cachedCapabilityMap = map;
  return cachedCapabilityMap;
}

export function _resetChannelCache(): void {
  cachedChannels = null;
  cachedCapabilityMap = null;
}
