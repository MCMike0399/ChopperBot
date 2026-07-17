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
  // Channel where the calendar capability publishes rendered month PDFs + the
  // master ICS. Distinct from the INPUT channel (which is bound to `calendar`
  // via the normal routing table and is where mods talk to the bot). Optional —
  // seeds the calendar's DB setting on first boot; after that the DB value wins
  // (changeable from the config channel via `config_calendar`).
  CALENDAR_OUTPUT_CHANNEL_ID: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^\d{17,20}$/, 'CALENDAR_OUTPUT_CHANNEL_ID must be a Discord snowflake').optional(),
  ),
  // ── Moonshot Kimi (the text brain — ALL text, every domain) ────────────────
  // Every text turn — Discord chat, the calendar/config tool-calling, the
  // event-intake proposals, and the IG classifier's caption-only fallback — runs
  // on Moonshot Kimi 2.7 Thinking via the OpenAI-compatible chat-completions API
  // (the `openai` SDK). Bedrock is used ONLY for images: Kimi 2.7 Thinking is
  // text-only, so any turn carrying an image is routed to Amazon Nova Lite (the
  // `low` tier — see BEDROCK_MODEL_LOW below and src/llm/client.ts).
  KIMI_API_KEY: z.string().min(1, 'KIMI_API_KEY is required'),
  // OpenAI-compatible base URL. Default is the Kimi-for-Coding endpoint, which
  // serves the K2.7 model but gates on a coding-agent User-Agent (see
  // KIMI_USER_AGENT). Point at https://api.moonshot.ai/v1 for the plain platform
  // API (model id `kimi-k2-thinking`, no UA gate).
  KIMI_BASE_URL: z.string().min(1).default('https://api.kimi.com/coding/v1'),
  // Model id. `kimi-for-coding` on the coding endpoint IS Kimi 2.7 Thinking (it
  // returns `reasoning_content` — the client echoes it back so follow-up turns
  // validate). On the platform API use `kimi-k2-thinking`.
  KIMI_MODEL_ID: z.string().min(1).default('kimi-for-coding'),
  // The coding endpoint 403s requests whose User-Agent isn't a known coding
  // agent with "Kimi For Coding is currently only available for Coding Agents".
  // `claude-cli/1.0.0` is empirically on the allowlist. Ignored by the plain
  // platform API. Override if the allowlist changes.
  KIMI_USER_AGENT: z.string().min(1).default('claude-cli/1.0.0'),

  // Amazon Bedrock (Converse API) credentials + model — the IMAGES-ONLY backend.
  // Kimi is text-only, so the ONLY thing Bedrock serves is vision: any turn
  // carrying an image (the IG post classifier's main call, or a chat message with
  // an attachment) goes to Amazon Nova Lite. Auth is a plain IAM access key pair —
  // the env var names are deliberately the short ACCESS_KEY_ID / SECRET_ACCESS_KEY
  // (NOT the AWS_-prefixed standard names) so they don't collide with any ambient
  // AWS CLI credentials on the host.
  ACCESS_KEY_ID: z.string().min(1, 'ACCESS_KEY_ID is required'),
  SECRET_ACCESS_KEY: z.string().min(1, 'SECRET_ACCESS_KEY is required'),
  // Optional STS session token (only for temporary credentials).
  AWS_SESSION_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  // Legacy Bedrock text model id. No longer on any hot path — every text domain
  // is Kimi now (see KIMI_MODEL_ID). Kept only for the dev smoke/bake-off scripts
  // and so a future all-Bedrock rollback needs no schema change.
  BEDROCK_MODEL_ID: z.string().min(1).default('us.anthropic.claude-sonnet-4-6'),
  // The vision model (Amazon Nova Lite), the effort `low` tier. This is the ONLY
  // model Bedrock serves and it is used ONLY for image turns — `high`/`medium`
  // are text and go to Kimi. Directive (2026-07-13): "Nova only for images; it is
  // the low tier; medium and high are Kimi." MUST be image-capable.
  BEDROCK_MODEL_LOW: z.string().min(1).default('us.amazon.nova-lite-v1:0'),
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

  // ── VirusTotal file scanner (file_scanner capability) ──────────────────────
  // Optional. When VIRUSTOTAL_API_KEY is set, the file_scanner capability
  // registers a passive listener that scans non-image uploads in the watched
  // channels and posts a friendly verdict. Unset → the capability self-disables
  // at boot (logs a warning; nothing else changes), so the code can ship and be
  // tested against a mocked client before a key exists.
  VIRUSTOTAL_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Channels the scanner watches, independent of the channel→capability routing
  // table (the scanner coexists with whatever else a channel already does).
  // JSON array (`["123","456"]`) or comma/space-separated tokens. Each token is
  // a channel snowflake, `guild:<serverId>` (all channels the bot can see in
  // that server), or `all` (every channel it can see). Seeds the DB setting on
  // first boot; after that the DB value wins (manage it live from the config
  // channel via `config_filescanner action:set_channels`).
  FILE_SCANNER_CHANNEL_IDS: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Rolling-24h ceiling on VirusTotal API calls. Free tier is 500/day; 480 keeps
  // headroom. On hit the scanner skips the file and tells the user politely.
  VIRUSTOTAL_DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().default(480),
  // Minimum spacing between VT API calls (free tier is 4 req/min = 15s; 16s is a
  // safe margin). Enforced by a single global serialized request queue.
  VIRUSTOTAL_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().positive().default(16_000),
  // Max analysis polls before giving up on a fresh upload (each poll is one
  // budgeted, spaced call; ~8 polls ≈ a couple of minutes of VT queue time).
  VIRUSTOTAL_MAX_POLLS: z.coerce.number().int().positive().default(8),
  // Files larger than this are skipped (VT's simple /files upload endpoint caps
  // around 32 MB on the public API).
  VIRUSTOTAL_MAX_FILE_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  // Number of engines flagging "malicious" required to render 🛑 malicioso. A
  // single detection below this (or any suspicious hit) renders ⚠️ sospechoso.
  VIRUSTOTAL_MALICIOUS_THRESHOLD: z.coerce.number().int().positive().default(2),

  // ── Event intake from the ticket funnel (event_intake capability) ──────────
  // Passive capability that reads the Ticket Tool event-request form in a ticket
  // channel, posts a normalized + conflict-checked proposal, and lets a MOD
  // approve by talking to the bot (which auto-creates the calendar event). Like
  // file_scanner it is NOT in the routing table and self-manages its own
  // MessageCreate listener over a watched CATEGORY set. All three vars are
  // optional (no secret needed): with no category configured it simply idles
  // until a mod points it at the ticket category via `config_eventintake`.
  //
  // Categories the intake watches. JSON array (`["123"]`) or comma/space list.
  // Each token is a CATEGORY snowflake, `guild:<serverId>` (every channel the
  // bot can see in that server), or `all`. Seeds the DB setting on first boot;
  // after that the DB value wins (manage it live from the config channel via
  // `config_eventintake action:set_categories`).
  EVENT_INTAKE_TICKET_CATEGORY_IDS: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Roles whose members may APPROVE a request (→ create the calendar event).
  // Each token is a role id snowflake (deterministic — preferred) or a role
  // NAME (accent/case-insensitive, e.g. "Moderador"); JSON array or comma list.
  // Seeds the DB setting on first boot; DB wins after (manage via
  // `config_eventintake action:set_mod_roles`). Empty/unset → the built-in
  // default Moderador/Administrador/Administradora role IDS (see roles.ts),
  // plus anyone with Discord's Administrator permission always qualifies.
  EVENT_INTAKE_MOD_ROLES: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Discord user id of the ticket bot whose form messages we parse. Defaults to
  // Ticket Tool. Change it if the server switches ticket bots.
  EVENT_INTAKE_TICKET_BOT_ID: z.string().regex(/^\d{17,20}$/).default('557628352828014614'),

  // ── Sancus Ops copilot (sancus_ops capability) ─────────────────────────────
  // A strictly READ-ONLY ops assistant for the Sancus platform. Observes the
  // backend only through CloudWatch Logs Insights (Nautilus wide events) and
  // read-only GitHub — it never touches a live system.
  //
  // AWS named profile used for the CloudWatch client (the process runs as
  // burbujamc, whose ~/.aws/config has the `sancus` profile). Credentials
  // resolve lazily on first query, so a missing profile does NOT break boot.
  SANCUS_OPS_AWS_PROFILE: z.string().min(1).default('sancus'),
  // Region of the Nautilus log groups. Pinned to us-east-2 (account 524329886851).
  SANCUS_OPS_AWS_REGION: z.string().min(1).default('us-east-2'),
  // Which environments the copilot may query, comma-separated. Filtered against
  // the known log groups (dev|qa|prod); an empty result falls back to all three.
  SANCUS_OPS_NAUTILUS_ENVS: z.string().min(1).default('dev,qa,prod'),
  // Read-only GitHub token for the `github` tool. Optional: when unset the
  // capability falls back to `gh auth token`, and degrades gracefully (the tool
  // reports itself unavailable) if neither is present.
  GITHUB_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // GitHub org the Sancus app repos live under.
  GITHUB_ORG: z.string().min(1).default('deep-dive-mexico'),
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
