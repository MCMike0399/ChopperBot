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
  ];
  return new Client({
    intents,
    partials: [Partials.Channel, Partials.Message],
  });
}
