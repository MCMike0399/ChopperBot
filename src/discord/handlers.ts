import { Client, Events, Message, type CloseEvent } from 'discord.js';
import { log } from '../log.js';
import { ask } from '../llm/client.js';
import { chunkBotReply } from './chunk.js';
import { buildHistory, normalizeTurns, type Turn } from './history.js';
import { ReactionTurnPresenter } from './presenter.js';
import { QueueBusyError, type TurnQueue } from './turn-queue.js';
import { resolveAttachments, listImageAttachments } from '../attachments/resolver.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { CapabilityRouter } from '../capabilities/routing.js';
import { GENERAL_CHAT_CAPABILITY_ID } from '../capabilities/general_chat/constants.js';
import type { UserDirectory } from '../users/store.js';

export interface HandlerDeps {
  registry: CapabilityRegistry;
  router: CapabilityRouter;
  userDirectory: UserDirectory;
  /**
   * Orders turns per channel (strict FIFO) and caps how many run at once
   * globally — the "two messages at the same time" fix. Shared with the
   * workshop watcher so private-session turns count against the same cap.
   */
  turnQueue: TurnQueue;
  /**
   * Optional guard for channels "claimed" by a passive capability that runs its
   * own MessageCreate listener (e.g. event_intake owns the ticket categories).
   * When it returns true, the main mention-gated handler stays out so the
   * passive capability owns the channel — preventing a double-reply.
   */
  claimedChannel?: (message: Message) => boolean;
}

/** Reply when a channel's queue is already packed (anti-spam backstop). */
export const QUEUE_BUSY_REPLY =
  'Tengo varias respuestas pendientes en este canal — dame un momento y vuelve a intentarlo.';

/** Last-resort reply when the turn threw. Spanish and user-facing — the reader
 * is a community member, so it says what happened and invites a retry rather
 * than telling them to read the logs. */
export const GENERIC_ERROR_REPLY =
  'Se me atravesó un error al responder eso. Inténtalo de nuevo en un momento.';

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
      // A passive capability (e.g. event_intake in the ticket categories) owns
      // this channel via its own listener — stay out to avoid a double-reply.
      if (deps.claimedChannel?.(message)) return;
      if (!shouldRespond(client, message, deps.router.allChannelIds())) return;

      const userText = stripBotMention(client, message.content).trim();
      if (!userText) return;

      // Lazily register the Discord user. Idempotent; refreshes tag +
      // last_seen_at on every interaction so capabilities can attribute and
      // rank by recency.
      deps.userDirectory.upsert(message.author.id, message.author.tag, Date.now());

      // Public conversation style: status reactions (⏳🤔🛠️/❌) + the native
      // typing indicator, and nothing else — no extra bot messages. Workshop
      // sessions use the richer WorkshopTurnPresenter (live status line).
      const presenter = new ReactionTurnPresenter(message, client.user?.id);

      let reply: string;
      try {
        // Per-channel FIFO + global cap. History is built INSIDE the queued
        // task, so a message queued behind another sees the earlier reply.
        reply = await deps.turnQueue.run(
          message.channelId,
          async () => {
            await presenter.begin();
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
              return '';
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
              attachments: listImageAttachments(message),
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

            return ask({
              system: turn.system,
              messages: turns,
              tools: turn.tools,
              onPhase: (phase, detail) => presenter.onPhase(phase, detail),
            });
          },
          { onQueued: () => presenter.onQueued() },
        );
      } catch (err) {
        if (err instanceof QueueBusyError) {
          await presenter.fail(QUEUE_BUSY_REPLY);
          return;
        }
        log.error({ err }, 'Failed to handle message');
        // Spanish, and free of operator instructions: this lands in a community
        // channel, not in the config channel. (2026-08-06: a member asked a
        // political question, the provider's risk filter refused the prompt, and
        // the channel got the English "check the logs" — which read as the bot
        // brushing the question off. The filter case now recovers inside ask();
        // this is the generic last resort.)
        await presenter.fail(GENERIC_ERROR_REPLY);
        return;
      }

      if (!reply) {
        await presenter.discard();
        return;
      }
      await presenter.deliver(chunkBotReply(reply));
    } catch (err) {
      log.error({ err }, 'Failed to handle message');
      await message.reply(GENERIC_ERROR_REPLY).catch(() => {});
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
