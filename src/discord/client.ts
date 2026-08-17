import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';

export function createClient(): Client {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // MessageContent is a PRIVILEGED intent: it must also be toggled on for the
    // app in the Discord Developer Portal, or the gateway rejects IDENTIFY with
    // "Used disallowed intents". Deployments whose app lacks the toggle can set
    // DISCORD_MESSAGE_CONTENT_INTENT=false — the bot keeps working for its
    // mention-driven flows, because Discord ALWAYS delivers content for messages
    // that @mention the bot (plus DMs and the bot's own messages), intent or
    // not. What is lost without the intent: content of messages that do NOT
    // mention the bot (passive listeners, reply-chains without a ping).
    ...(config.DISCORD_MESSAGE_CONTENT_INTENT !== 'false' ? [GatewayIntentBits.MessageContent] : []),
    // Reactions drive the workshop onboarding (react on the welcome message →
    // get a private session channel). NOT privileged — no portal toggle needed.
    GatewayIntentBits.GuildMessageReactions,
    // Voice states: the minutas capability joins/records voice & stage
    // channels (the join, the speaking stream, and the "channel emptied"
    // auto-end all ride on this). NOT privileged either.
    GatewayIntentBits.GuildVoiceStates,
    // Scheduled events: a minutas session auto-ends when the event tied to
    // its channel completes/is cancelled. NOT privileged.
    GatewayIntentBits.GuildScheduledEvents,
  ];
  return new Client({
    intents,
    // Reaction + User partials: reactions on messages posted before this boot
    // arrive partial (the welcome message usually predates the process), so the
    // workshop listener must be able to `fetch()` them.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    // Bot-wide mention policy — the ONE place @everyone/@here/role pings are
    // denied. Without it discord.js omits `allowed_mentions` entirely and
    // Discord parses EVERY mention class in whatever the model wrote; since
    // 2026-08-13 the bot holds Administrator in the guild, so every role is
    // pingable and a single successful jailbreak (or a hostile Instagram
    // caption echoed into a card) would ring the whole server. The rule against
    // mass pings lived only in prompt text — a promise, not a gate.
    //
    // `parse: ['users']` keeps ordinary "@fulanx" replies working; `repliedUser`
    // keeps the reply ping the bot has always sent. Paths that legitimately DO
    // ping roles (the calendar announcement + nudge, event_intake's mod ping)
    // pass their own `allowedMentions` with an explicit role allowlist —
    // message-level policy REPLACES this default, it does not merge, so any new
    // send that needs a role ping must opt in by id.
    allowedMentions: { parse: ['users'], repliedUser: true },
  });
}
