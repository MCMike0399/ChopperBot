// dotenv defaults to `override: false` — pre-existing shell env vars win
// over .env values. If the bot uses a stale credential, suspect a leftover
// `export FOO=...` in ~/.zshrc or ~/.profile shadowing .env. `unset FOO`
// or fix the rc file; do not flip override to true here (legitimate dev
// workflows depend on shell-var overrides).
import "dotenv/config";
import { z } from "zod";

const GuildChannelConfigSchema = z.object({
   guildId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
   guildName: z.string().optional(),
   channels: z.array(z.string().regex(/^\d{17,20}$/)).min(1),
});

const ChannelCapabilityConfigSchema = z.object({
   guildId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
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
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const ConfigSchema = z
   .object({
      DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
      // Request the privileged MessageContent gateway intent at login. Default true
      // (self-hosted app has it enabled). Set to the literal string 'false' when the
      // Discord app does NOT have the intent toggled on — the gateway would reject
      // IDENTIFY with "Used disallowed intents". Without it the bot still receives
      // content for messages that @mention it (Discord always delivers those), so
      // the mention-driven flows keep working; passive listeners do not.
      DISCORD_MESSAGE_CONTENT_INTENT: z.string().optional(),
      DISCORD_CHANNEL_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "DISCORD_CHANNEL_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      DISCORD_AUTHORIZED_CHANNELS: z.string().optional(),
      DISCORD_CHANNEL_CAPABILITIES: z.string().optional(),
      CHOPPERBOT_DATA_DIR: z.string().default("./data"),
      DEFAULT_CAPABILITY: z.string().min(1).default("calendar"),
      // Channel where the calendar capability publishes rendered month PDFs + the
      // master ICS. Distinct from the INPUT channel (which is bound to `calendar`
      // via the normal routing table and is where mods talk to the bot). Optional —
      // seeds the calendar's DB setting on first boot; after that the DB value wins
      // (changeable from the config channel via `config_calendar`).
      CALENDAR_OUTPUT_CHANNEL_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "CALENDAR_OUTPUT_CHANNEL_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      // Community channel where the calendar posts the daily "hoy hay evento"
      // announcement (the server's #anuncios), distinct from both the calendar INPUT
      // channel and the month-PDF OUTPUT channel. Optional — seeds the calendar's DB
      // setting on first boot, after which the DB wins (`config_calendar
      // action:set_announce_channel`). Unset and unseeded → no daily announcement.
      CALENDAR_ANNOUNCE_CHANNEL_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "CALENDAR_ANNOUNCE_CHANNEL_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      // Who the daily announcement pings. Comma/space list or JSON array of role
      // snowflakes, plus the literal token `everyone` for @everyone. Seeds the DB
      // setting on first boot (DB wins after). Empty → the announcement still posts,
      // it just pings nobody. Deliberately NOT defaulted to `everyone`: a daily
      // automated @everyone is a big escalation over what admins did by hand.
      CALENDAR_ANNOUNCE_MENTIONS: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Local (America/Mexico_City) hour from which today's events may be announced.
      // Not an alarm: the watcher opens a window at this hour and the SQLite ledger
      // guarantees one post per event, so a late boot or a same-day booking still
      // announces exactly once.
      CALENDAR_ANNOUNCE_HOUR: z.coerce
         .number()
         .int()
         .min(0)
         .max(23)
         .default(10),
      // ── DeepSeek — the ONLY brain (v4.1 migration, 2026-09-14) ─────────────────
      // Every turn, text and image alike, runs on DeepSeek-V4.1-Flash through the
      // OpenAI-compatible chat-completions API (the `openai` SDK). There is no
      // second backend: Amazon Bedrock/Nova is gone (V4.1 Flash reads images
      // natively), and Moonshot Kimi is gone with it. `textBackend` below is
      // therefore a single resolved object rather than a selector — see the
      // standing rule in docs/llm.md before reintroducing a provider slot.
      //
      // Both key spellings are accepted: DEEPSEEK_API_KEY is canonical,
      // DEEP_SEEK_API_KEY is the spelling already sitting in the Pi's .env. Set
      // either; at least one is REQUIRED (enforced by the superRefine below).
      DEEPSEEK_API_KEY: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      DEEP_SEEK_API_KEY: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      DEEPSEEK_BASE_URL: z
         .string()
         .min(1)
         .default("https://api.deepseek.com/v1"),
      // `deepseek-flash` IS DeepSeek-V4.1-Flash. Probed live 2026-09-14
      // (scripts/probe-deepseek-v41.ts §1): the legacy ids `deepseek-v4-flash`
      // and `deepseek-v4-flash-vision-exp` are still accepted and served by
      // V4.1 Flash, and a bogus id 400s, so the name is really validated.
      //
      // There is deliberately NO second model id. Effort selects a thinking
      // MODE on this one model, never a pricier model: V4-Pro measured
      // identical to Flash on the calendar tool battery while being ~48% slower
      // and 3.1× the price (2026-08-13), and DeepSeek is retiring Pro in favour
      // of V4.1 Flash anyway. Re-measure before reintroducing a model tier.
      DEEPSEEK_MODEL_ID: z.string().min(1).default("deepseek-flash"),
      // Output budget for the thinking path. Reasoning tokens bill at the OUTPUT
      // rate and count against max_tokens, so a starved cap shows up as
      // finish_reason `length` with empty content — live 2026-09-02 (workshop):
      // three consecutive 16384-token caps produced zero visible text and the
      // member got the fallback. Probed 2026-09-14 (probe-deepseek-v41.ts §6):
      // the API caps max_tokens at 393216 and defaults to 64K thinking / 8K
      // non-thinking, so 32768 is comfortably inside both and leaves real
      // headroom for a `max`-effort workshop turn. The length-cap retry in
      // client.ts still exists as the last line of defence.
      DEEPSEEK_MAX_OUTPUT_TOKENS: z.coerce
         .number()
         .int()
         .positive()
         .default(32768),
      MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(10),
      // Max DeepSeek HTTP requests in flight at once (a semaphore inside
      // llm/client.ts, NOT whole turns — two agent loops interleave their
      // requests). DeepSeek's concurrency limit is 2500 on `deepseek-flash`
      // (probed 2026-09-14), so this is a Pi-protection knob, not a provider
      // limit. 1 was the old Kimi requirement; DeepSeek tolerates overlap, so
      // the default is 3 to match MAX_CONCURRENT_TURNS.
      DEEPSEEK_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
      // Max message-handling turns executing at once across ALL channels (the
      // per-channel ordering is always strict FIFO regardless). Protects the Pi;
      // queued turns show ⏳ on the user's message.
      MAX_CONCURRENT_TURNS: z.coerce.number().int().positive().default(3),
      LOG_LEVEL: z
         .enum(["trace", "debug", "info", "warn", "error", "fatal"])
         .default("info"),
      MAX_ATTACHMENT_BYTES: z.coerce
         .number()
         .int()
         .positive()
         .default(10 * 1024 * 1024),
      MAX_ATTACHMENT_COUNT: z.coerce.number().int().positive().default(5),
      // Instagram session auth (optional). When IG_SESSIONID + IG_CSRFTOKEN +
      // IG_DS_USER_ID are all present, direct fetches attach the logged-in cookies
      // and x-csrftoken header, which gets far higher rate limits than anonymous
      // requests. Use a THROWAWAY account — automated polling risks a ban. Sessions
      // expire; the scheduler logs `instagram_monitor.auth.expired` so the
      // log-watcher can alert you to refresh the cookies.
      IG_SESSIONID: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      IG_CSRFTOKEN: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      IG_DS_USER_ID: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      IG_MID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
      IG_DID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
      // User-Agent sent on every IG request. SHOULD match the browser the session
      // cookies were extracted from — a session driven from a UA different than the
      // one that created it is a fingerprint signal. Critical on a personal account.
      // Unset = the built-in desktop-Chrome default (DEFAULT_IG_USER_AGENT).
      IG_USER_AGENT: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Hard ceiling on outbound IG HTTP requests in a rolling 24h window (one poll
      // ≈ 2–3 calls: optional warmup + pk-resolve + feed). On hit, polling
      // soft-pauses (auto-recovers as the window drains) and the operator is
      // alerted. A backstop against runaway request volume.
      IG_DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().default(90),

      // ── VirusTotal file scanner (file_scanner capability) ──────────────────────
      // Optional. When VIRUSTOTAL_API_KEY is set, the file_scanner capability
      // registers a passive listener that scans uploads in the watched
      // channels (images skipped; videos skipped only in media-native
      // channels) and posts a friendly verdict. Unset → the capability
      // self-disables at boot (logs a warning; nothing else changes), so the
      // code can ship and be tested against a mocked client before a key exists.
      VIRUSTOTAL_API_KEY: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Channels the scanner watches, independent of the channel→capability routing
      // table (the scanner coexists with whatever else a channel already does).
      // JSON array (`["123","456"]`) or comma/space-separated tokens. Each token is
      // a channel snowflake, `guild:<serverId>` (all channels the bot can see in
      // that server), or `all` (every channel it can see). Seeds the DB setting on
      // first boot; after that the DB value wins (manage it live from the config
      // channel via `config_filescanner action:set_channels`).
      FILE_SCANNER_CHANNEL_IDS: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Channels whose purpose is media (clips, memes, art). Videos there are
      // skipped; conversation channels scan them. JSON array or comma list of
      // channel snowflakes. Seeds the DB on first boot; DB wins after
      // (`config_filescanner action:set_media_channels`). Unset → the Revolución Z
      // default denylist (multimedia-general, momos, arte, cine, música, …).
      FILE_SCANNER_MEDIA_CHANNEL_IDS: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Rolling-24h ceiling on VirusTotal API calls. Free tier is 500/day; 480 keeps
      // headroom. On hit the scanner skips the file and tells the user politely.
      VIRUSTOTAL_DAILY_REQUEST_BUDGET: z.coerce
         .number()
         .int()
         .positive()
         .default(480),
      // Minimum spacing between VT API calls (free tier is 4 req/min = 15s; 16s is a
      // safe margin). Enforced by a single global serialized request queue.
      VIRUSTOTAL_MIN_REQUEST_INTERVAL_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(16_000),
      // Max analysis polls before giving up on a fresh upload (each poll is one
      // budgeted, spaced call; ~8 polls ≈ a couple of minutes of VT queue time).
      VIRUSTOTAL_MAX_POLLS: z.coerce.number().int().positive().default(8),
      // Files larger than this are not uploaded to VirusTotal (simple /files
      // endpoint caps around 32 MB). They can still be hashed and looked up.
      VIRUSTOTAL_MAX_FILE_BYTES: z.coerce
         .number()
         .int()
         .positive()
         .default(32 * 1024 * 1024),
      // Hard skip above this — we won't even download. Default 50 MB covers
      // typical Discord Nitro uploads while staying well under Pi RAM.
      VIRUSTOTAL_MAX_DOWNLOAD_BYTES: z.coerce
         .number()
         .int()
         .positive()
         .default(50 * 1024 * 1024),
      // Number of engines flagging "malicious" required to render 🛑 malicioso. A
      // single detection below this (or any suspicious hit) renders ⚠️ sospechoso.
      VIRUSTOTAL_MALICIOUS_THRESHOLD: z.coerce
         .number()
         .int()
         .positive()
         .default(2),

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
      EVENT_INTAKE_TICKET_CATEGORY_IDS: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Roles whose members may APPROVE a request (→ create the calendar event).
      // Each token is a role id snowflake (deterministic — preferred) or a role
      // NAME (accent/case-insensitive, e.g. "Moderador"); JSON array or comma list.
      // Seeds the DB setting on first boot; DB wins after (manage via
      // `config_eventintake action:set_mod_roles`). Empty/unset → the built-in
      // default Moderador/Administrador/Administradora role IDS (see roles.ts),
      // plus anyone with Discord's Administrator permission always qualifies.
      EVENT_INTAKE_MOD_ROLES: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      // Discord user id of the ticket bot whose form messages we parse. Defaults to
      // Ticket Tool. Change it if the server switches ticket bots.
      EVENT_INTAKE_TICKET_BOT_ID: z
         .string()
         .regex(/^\d{17,20}$/)
         .default("557628352828014614"),
      // Agitprop flyer inbox channel (Comisión de Agitprop). Seeds the DB setting
      // on first boot; DB wins after (`config_eventintake action:set_agitprop_channel`).
      EVENT_INTAKE_AGITPROP_CHANNEL_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "EVENT_INTAKE_AGITPROP_CHANNEL_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      // Roles whose members may fulfill/manage flyer jobs. Names or ids; empty → "Agitprop".
      EVENT_INTAKE_AGITPROP_ROLES: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),

      // ── Workshop (escuela/trabajo) private LLM sessions (workshop capability) ──
      // Passive capability: a member reacts to the bot's welcome message in the
      // WELCOME channel and gets a private text channel under the CATEGORY where
      // they chat with the bot like a web LLM (no mentions needed), with sandboxed
      // Python + document skills. All vars seed the DB settings on first boot; the
      // DB wins after (manage live via `config_workshop`). Unset and unseeded → the
      // capability idles.
      WORKSHOP_WELCOME_CHANNEL_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "WORKSHOP_WELCOME_CHANNEL_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      WORKSHOP_CATEGORY_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "WORKSHOP_CATEGORY_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      // The emoji members react with on the welcome message. A unicode emoji.
      WORKSHOP_REACTION_EMOJI: z.string().min(1).default("🎓"),
      // Active private sessions a single member may have at once.
      WORKSHOP_MAX_SESSIONS_PER_USER: z.coerce
         .number()
         .int()
         .positive()
         .default(2),
      // Wall-clock cap for one sandboxed python run, seconds (the tool may ask for
      // less; never more).
      WORKSHOP_PY_TIMEOUT_S: z.coerce.number().int().positive().default(60),

      // ── Minutas (voice/stage meeting recorder → minutes) ───────────────────────
      // Passive capability (own listeners, not channel-routed): `/chopperbot-join`
      // makes the bot join the caller's voice/stage channel and record per-speaker
      // audio bursts + the channel's text chat; `/chopperbot-leave` (or the channel
      // emptying, or its scheduled event ending) stops the session, transcribes
      // locally with whisper.cpp, and posts an LLM-written minuta to the output
      // channel. Drafts live in MinIO under `minutas/<guild>/<date>/<session>/`.
      // All vars optional: with no output channel the capability idles; with no
      // whisper binary it still records and keeps the raw drafts.
      // Channel where minutes are published. Seeds the DB setting on first boot;
      // after that the DB wins (`config_minutas action:set_output_channel`).
      MINUTAS_OUTPUT_CHANNEL_ID: z.preprocess(
         emptyToUndefined,
         z
            .string()
            .regex(
               /^\d{17,20}$/,
               "MINUTAS_OUTPUT_CHANNEL_ID must be a Discord snowflake",
            )
            .optional(),
      ),
      // Local whisper.cpp binary + model (built by scripts/setup-minutas-whisper.sh).
      MINUTAS_WHISPER_BIN: z
         .string()
         .min(1)
         .default("./data/minutas/bin/whisper-cli"),
      MINUTAS_WHISPER_MODEL_PATH: z
         .string()
         .min(1)
         .default("./data/minutas/models/ggml-small.bin"),
      MINUTAS_WHISPER_LANGUAGE: z.string().min(2).default("es"),
      // whisper-cli threads. Live transcription runs during the meeting; leftover
      // whisper at leave is the last un-flushed tail. A single whisper process at
      // a time. Live .env often uses 2 so cores stay free alongside the gateway.
      MINUTAS_WHISPER_THREADS: z.coerce.number().int().min(1).max(8).default(4),
      // Backstop auto-end for a forgotten session (e.g. the mod walks away).
      MINUTAS_MAX_SESSION_MINUTES: z.coerce
         .number()
         .int()
         .positive()
         .default(300),
      // Nightly deferral (MINUTAS_HEAVY_WINDOW_* / MINUTAS_IMMEDIATE_MAX_WHISPER_MIN)
      // was removed 2026-08-19: live transcription keeps pace, so /chopperbot-leave
      // always finalizes immediately (leftover whisper is the last un-flushed tail).

      // ── Object storage (MinIO on the Pi's 1TB SSD) ─────────────────────────────
      // Durable byte store behind capabilities that outgrow the local disk —
      // today: workshop session files (the Pi workspace stays a bounded cache;
      // the Discord carrier message remains the fallback copy). Self-hosted MinIO,
      // S3 API bound to localhost, data under /srv/minio (moved off the 2 TB HDD
      // 2026-08-10 so the file store no longer depends on the external disk).
      // BOTH keys unset → storage disabled → pre-MinIO behavior (Discord-only).
      MINIO_ENDPOINT: z.string().min(1).default("http://127.0.0.1:9500"),
      // MinIO accepts any region string; the SDK requires one to sign requests.
      MINIO_REGION: z.string().min(1).default("us-east-1"),
      MINIO_BUCKET: z.string().min(1).default("chopperbot"),
      // Scoped service account (bucket-rw policy only), NOT the MinIO root user.
      MINIO_ACCESS_KEY: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
      MINIO_SECRET_KEY: z.preprocess(
         emptyToUndefined,
         z.string().min(1).optional(),
      ),
   })
   .superRefine((c, ctx) => {
      // DeepSeek is the only brain — text and vision alike — so its key is
      // unconditionally required. There is no fallback backend to boot onto.
      if (!(c.DEEPSEEK_API_KEY ?? c.DEEP_SEEK_API_KEY)) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["DEEPSEEK_API_KEY"],
            message:
               "DEEPSEEK_API_KEY (or DEEP_SEEK_API_KEY) is required — DeepSeek V4.1 Flash is the only LLM backend",
         });
      }
      if (
         (c.MINIO_ACCESS_KEY && !c.MINIO_SECRET_KEY) ||
         (!c.MINIO_ACCESS_KEY && c.MINIO_SECRET_KEY)
      ) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["MINIO_ACCESS_KEY"],
            message:
               "MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set together (or both unset to disable object storage)",
         });
      }
   });

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
   // eslint-disable-next-line no-console
   console.error(
      "Invalid environment configuration:",
      parsed.error.flatten().fieldErrors,
   );
   process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/**
 * The resolved LLM backend — one object, one provider (v4.1 migration).
 *
 * Before 2026-09-14 this was a *selector* (Kimi / DeepSeek / Bedrock), because
 * the text brain could not see images and Amazon Nova had to serve the vision
 * path. DeepSeek-V4.1-Flash is natively multimodal, so both halves collapsed
 * into one provider and this object lost its branch. src/llm/client.ts reads
 * this instead of raw env vars, which is the seam a future provider would use —
 * but do not add one back without re-reading docs/llm.md.
 */
export interface TextBackend {
   provider: "deepseek";
   apiKey: string | undefined;
   baseUrl: string;
   /**
    * The one model. Every tier runs on it; effort picks a thinking MODE, never a
    * pricier model (V4-Pro measured identical to Flash on the tool battery while
    * being ~48% slower and 3.1× the price, and DeepSeek is retiring it).
    */
   modelId: string;
   /**
    * Whether the provider honours `thinking: {type}`. Kept as a flag rather than
    * deleted so the request builder has one place to express "this provider
    * takes a thinking switch" — and so a future provider that 400s on unexpected
    * params (as Moonshot did for `temperature`) can opt out without touching the
    * loop. Always true today.
    *
    * MEASURED on v4-flash (2026-08-13, `scripts/probe-deepseek-thinking.ts`) and
    * RE-MEASURED on v4.1 Flash (2026-09-14, `scripts/probe-deepseek-v41-effort.ts`):
    * `type:'disabled'` reliably yields 0 reasoning tokens, while enabling
    * thinking costs roughly 2× billed output. That switch is the load-bearing
    * half of the effort tier.
    */
   supportsThinkingSwitch: boolean;
   maxOutputTokens: number;
   maxConcurrent: number;
}

export const textBackend: TextBackend = {
   provider: "deepseek",
   apiKey: config.DEEPSEEK_API_KEY ?? config.DEEP_SEEK_API_KEY,
   baseUrl: config.DEEPSEEK_BASE_URL,
   modelId: config.DEEPSEEK_MODEL_ID,
   supportsThinkingSwitch: true,
   maxOutputTokens: config.DEEPSEEK_MAX_OUTPUT_TOKENS,
   maxConcurrent: config.DEEPSEEK_MAX_CONCURRENT,
};

/** Community-facing name of the live brain. Not the wire model id. Kept as a
 * function (not a constant) because capability preambles interpolate it and it
 * is asserted in tests. */
export function textBrainDisplayName(): string {
   return "DeepSeek V4.1 Flash";
}

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
