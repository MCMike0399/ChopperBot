import { Client, Events, Message, type CloseEvent } from 'discord.js';
import { log } from '../log.js';
import { ask } from '../llm/client.js';
import { chunkBotReply } from './chunk.js';
import { buildHistory, normalizeTurns, type Turn } from './history.js';
import { resolveAttachments } from '../attachments/resolver.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { CapabilityRouter } from '../capabilities/routing.js';
import { GENERAL_CHAT_CAPABILITY_ID } from '../capabilities/general_chat/constants.js';
import type { UserDirectory } from '../users/store.js';

export interface HandlerDeps {
  registry: CapabilityRegistry;
  router: CapabilityRouter;
  userDirectory: UserDirectory;
}

export function registerHandlers(client: Client, deps: HandlerDeps): void {
  client.once(Events.ClientReady, (c) => {
    log.info(
      { tag: c.user.tag, authorizedChannels: deps.router.allChannelIds().size },
      'Discord client ready',
    );
  });

  client.on(Events.ShardDisconnect, (event: CloseEvent, id: number) => {
    log.warn({ shardId: id, closeCode: event.code, reason: event.reason }, 'Discord shard disconnected');
  });

  client.on(Events.ShardReconnecting, (id: number) => {
    log.info({ shardId: id }, 'Discord shard reconnecting');
  });

  client.on(Events.ShardResume, (id: number, replayedEvents: number) => {
    log.info({ shardId: id, replayedEvents }, 'Discord shard resumed');
  });

  client.on(Events.ShardError, (err: Error, id: number) => {
    log.error({ shardId: id, err }, 'Discord shard error');
  });

  client.on(Events.Error, (err: Error) => {
    log.error({ err }, 'Discord client error');
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!shouldRespond(client, message, deps.router.allChannelIds())) return;

      const userText = stripBotMention(client, message.content).trim();
      if (!userText) return;

      // Lazily register the Discord user. Idempotent; refreshes tag +
      // last_seen_at on every interaction so capabilities can attribute and
      // rank by recency.
      deps.userDirectory.upsert(message.author.id, message.author.tag, Date.now());

      // Visible "I heard you and I'm working" signal: a 🔍 reaction on the
      // user's message during the search+synth phase. Discord's typing
      // indicator covers the writing tail, but is too subtle for the long
      // tool-call phase. Reactions are instant and don't add a message
      // to the channel. Removed in `finally` so success/failure both
      // clean up; if removal fails (rate limit, perms), it's a no-op.
      const reaction = await message.react('🔍').catch(() => null);
      await message.channel.sendTyping().catch(() => {});
      const typingHeartbeat = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8000);

      let reply: string;
      try {
        const capabilityId = deps.router.resolve(message.channelId);
        let capability = capabilityId ? deps.registry.get(capabilityId) : undefined;
        if (!capability) {
          // Fallback: any unbound channel in a guild the bot is in falls
          // through to general_chat for a conversational intro + redirect.
          capability = deps.registry.get(GENERAL_CHAT_CAPABILITY_ID);
        }
        if (!capability) {
          log.error(
            { channelId: message.channelId, capabilityId },
            'No capability resolvable for channel (general_chat not registered either) — refusing to answer',
          );
          return;
        }

        const history = await buildHistory(client, message);
        const attachments = await resolveAttachments(message);
        const turns: Turn[] = normalizeTurns([
          ...history,
          { role: 'user', content: userText, attachments },
        ]);

        const turn = await capability.buildTurn({
          channelId: message.channelId,
          guildId: message.guildId,
          userId: message.author.id,
          userTag: message.author.tag,
          now: new Date(),
        });

        log.info(
          {
            capability: capability.id,
            user: message.author.tag,
            len: userText.length,
            historyTurns: history.length,
            attachments: attachments.length,
          },
          'Answering question',
        );

        reply = await ask({ system: turn.system, messages: turns, tools: turn.tools });
      } finally {
        clearInterval(typingHeartbeat);
        if (reaction && client.user) {
          await reaction.users.remove(client.user.id).catch(() => {});
        }
      }

      const parts = chunkBotReply(reply);

      let anchor = await message.reply(parts[0]);
      for (let i = 1; i < parts.length; i++) {
        anchor = await anchor.reply({
          content: parts[i],
          allowedMentions: { repliedUser: false },
        });
      }
    } catch (err) {
      log.error({ err }, 'Failed to handle message');
      await message
        .reply('Sorry, I hit an error answering that — check the logs.')
        .catch(() => {});
    }
  });
}

export function shouldRespond(
  client: Client,
  message: Message,
  authorizedChannels: Set<string>,
): boolean {
  if (message.author.bot) {
    log.debug({ user: message.author.tag, reason: 'author_is_bot' }, 'Ignoring message');
    return false;
  }
  // Specialized bindings always win. Otherwise, any channel inside a guild the
  // bot is in is allowed (general_chat will pick it up as the fallback in the
  // handler). DMs (message.guild == null) still require explicit authorization.
  const inAuthorizedSet = authorizedChannels.has(message.channelId);
  const inGuild = message.guild != null;
  if (!inAuthorizedSet && !inGuild) {
    log.debug(
      { channelId: message.channelId, reason: 'dm_not_authorized' },
      'Ignoring message',
    );
    return false;
  }
  if (!client.user) {
    log.debug({ user: message.author.tag, reason: 'client_not_ready' }, 'Ignoring message');
    return false;
  }

  const mentioned = message.mentions.users.has(client.user.id);
  const isReplyToBot =
    message.reference?.messageId !== undefined &&
    message.mentions.repliedUser?.id === client.user.id;

  if (!mentioned && !isReplyToBot) {
    log.debug(
      { user: message.author.tag, reason: 'no_mention_or_reply', hasMentions: message.mentions.users.size > 0 },
      'Ignoring message',
    );
    return false;
  }

  return true;
}

export function stripBotMention(client: Client, content: string): string {
  if (!client.user) return content;
  const patterns = [
    new RegExp(`<@!?${client.user.id}>`, 'g'),
  ];
  let out = content;
  for (const p of patterns) out = out.replace(p, '');
  return out;
}
