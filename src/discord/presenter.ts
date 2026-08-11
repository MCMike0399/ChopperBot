import type { Message } from 'discord.js';
import { log } from '../log.js';
import type { AskPhase } from '../llm/client.js';
import { StatusReactor } from './status-reactions.js';
import { LiveStatusMessage, composeStatusText } from './status-message.js';

/**
 * How a turn's progress and reply reach the user — the ONE seam that decides a
 * channel's "conversation style". Two styles ship:
 *
 *   - {@link ReactionTurnPresenter} (public, mention-gated channels): status
 *     reactions on the user's message + the native typing indicator. No extra
 *     bot messages, ever — in a public channel the spinner line would be noise.
 *   - {@link WorkshopTurnPresenter} (private taller sessions): the full
 *     web-LLM experience — reactions while queued, then ONE live status line
 *     ("-# 🐍 Ejecutando código · paso 3 · 45s") edited in place and finally
 *     morphed into the reply itself.
 *
 * Handlers drive presenters through this interface only, so a surface can
 * change style without touching the turn pipeline.
 */
export interface TurnPresenter {
  /** The turn is waiting behind earlier turns in the channel queue. */
  onQueued(): void;
  /** The turn started executing (bring up progress surfaces). */
  begin(): Promise<void>;
  /** Agent-loop progress (thinking / tool). Cheap, may fire often. */
  onPhase(phase: AskPhase, detail?: string): void;
  /**
   * Post the reply chunks and tear down progress surfaces. Returns the LAST
   * posted message (the reply anchor), or null when nothing was posted.
   * An empty `parts` means "no reply" — progress is cleaned up silently.
   */
  deliver(parts: string[]): Promise<Message | null>;
  /** The turn failed: surface `text` as the user-facing (Spanish) error. */
  fail(text: string): Promise<void>;
  /** The turn was superseded/aborted: remove progress surfaces, post nothing. */
  discard(): Promise<void>;
}

/**
 * Discord's typing indicator expires ~10 s after each `sendTyping()`, so the
 * refresh must have real margin: at 8 s a busy event loop on the Pi let it
 * lapse mid-turn and a member read the stopped animation as "se trabó" (live
 * 2026-08-06, #chat-poesía — the answer did arrive). 5 s leaves ~2× headroom.
 */
const TYPING_REFRESH_MS = 5_000;

/** How often the live status line's elapsed-time suffix advances. */
const STATUS_TICK_MS = 10_000;

/** The message shape presenters actually use (structural — test seam). */
export interface PresentableMessage {
  reply(content: string): Promise<Message>;
  channel: {
    send(
      options: string | { content: string; allowedMentions?: { repliedUser?: boolean } },
    ): Promise<Message>;
    sendTyping(): Promise<unknown>;
  };
}

/** Base: the status reaction + typing heartbeat both styles share. */
abstract class BasePresenter implements TurnPresenter {
  protected readonly reactor: StatusReactor;
  private typingTimer: NodeJS.Timeout | null = null;
  protected begun = false;
  protected done = false;

  constructor(protected readonly message: PresentableMessage, botUserId: string | undefined) {
    this.reactor = new StatusReactor(message as unknown as Message, botUserId);
  }

  onQueued(): void {
    this.reactor.set('queued');
  }

  protected startTyping(): void {
    if (this.typingTimer) return;
    void this.message.channel.sendTyping().catch(() => {});
    this.typingTimer = setInterval(() => {
      void this.message.channel.sendTyping().catch(() => {});
    }, TYPING_REFRESH_MS);
  }

  protected stopTimers(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  abstract begin(): Promise<void>;
  abstract onPhase(phase: AskPhase, detail?: string): void;
  abstract deliver(parts: string[]): Promise<Message | null>;
  abstract fail(text: string): Promise<void>;
  abstract discard(): Promise<void>;
}

/**
 * Public-channel style: reactions (⏳🤔🛠️/❌) + typing indicator ONLY. The
 * reply is a normal Discord reply to the user's message, so `buildHistory`'s
 * reply-chain walk keeps working. Deliberately posts no status messages — an
 * extra bot message per turn is noise in a shared channel.
 */
export class ReactionTurnPresenter extends BasePresenter {
  async begin(): Promise<void> {
    this.begun = true;
    this.reactor.set('thinking');
    this.startTyping();
  }

  onPhase(phase: AskPhase, _detail?: string): void {
    this.reactor.set(phase);
  }

  async deliver(parts: string[]): Promise<Message | null> {
    if (this.done) return null;
    this.done = true;
    if (parts.length === 0) {
      this.stopTimers();
      this.reactor.resolve();
      return null;
    }
    // Typing stays alive until the first chunk is actually posted — clearing
    // it earlier is what left the gap members read as "stuck".
    let anchor: Message | null = await this.message.reply(parts[0]).catch((err) => {
      log.warn({ err }, 'presenter.reply_failed_falling_back_to_send');
      return null;
    });
    if (!anchor) {
      // The user's message may be gone (deleted) — the answer must still land.
      anchor = await this.message.channel
        .send({ content: parts[0], allowedMentions: { repliedUser: false } })
        .catch((err) => {
          log.error({ err }, 'presenter.reply_delivery_failed');
          return null;
        });
    }
    this.stopTimers();
    for (let i = 1; anchor && i < parts.length; i++) {
      anchor = await this.message.channel
        .send({ content: parts[i], allowedMentions: { repliedUser: false } })
        .catch(() => anchor);
    }
    this.reactor.resolve();
    return anchor;
  }

  async fail(text: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.stopTimers();
    this.reactor.fail();
    await this.message.reply(text).catch(() => {});
  }

  async discard(): Promise<void> {
    this.done = true;
    this.stopTimers();
    this.reactor.resolve();
  }
}

/**
 * Workshop (taller) style: the full live status line. ⏳ covers the queue
 * wait; once the turn starts, ONE subtext message is edited in place through
 * thinking/tool phases (with a ticking elapsed time) and finally morphs into
 * the reply itself — no delete/send flicker, no leftover noise.
 */
export class WorkshopTurnPresenter extends BasePresenter {
  private readonly status: LiveStatusMessage;
  private readonly now: () => number;
  private ticker: NodeJS.Timeout | null = null;
  private readonly progress = {
    phase: 'thinking' as AskPhase,
    toolName: undefined as string | undefined,
    step: 0,
    startedAt: 0,
  };

  constructor(message: PresentableMessage, botUserId: string | undefined, now?: () => number) {
    super(message, botUserId);
    this.now = now ?? (() => Date.now());
    this.status = new LiveStatusMessage({
      post: (content) => message.channel.send(content),
      send: (content) => message.channel.send(content),
    });
  }

  private statusText(): string {
    return composeStatusText({
      ...this.progress,
      elapsedMs: this.now() - this.progress.startedAt,
    });
  }

  async begin(): Promise<void> {
    this.begun = true;
    this.progress.startedAt = this.now();
    await this.status.start(this.statusText());
    this.reactor.resolve(); // the status line takes over from the ⏳ reaction
    this.startTyping();
    // Keep the elapsed-time suffix moving through long model requests.
    this.ticker = setInterval(() => this.status.update(this.statusText()), STATUS_TICK_MS);
  }

  onPhase(phase: AskPhase, detail?: string): void {
    this.progress.phase = phase;
    if (phase === 'tool') {
      this.progress.toolName = detail;
      this.progress.step += 1;
    }
    this.status.update(this.statusText());
  }

  async deliver(parts: string[]): Promise<Message | null> {
    if (this.done) return null;
    this.done = true;
    this.stopAll();
    if (parts.length === 0) {
      await this.status.discard();
      this.reactor.resolve();
      return null;
    }
    return this.status.finishAsReply(parts);
  }

  async fail(text: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.stopAll();
    if (this.begun) {
      // The status line becomes the error message.
      await this.status.fail(text);
    } else {
      // Never started (queue busy / pre-start error): ❌ + plain reply.
      this.reactor.fail();
      await this.message.reply(text).catch(() => {});
    }
  }

  async discard(): Promise<void> {
    this.done = true;
    this.stopAll();
    await this.status.discard();
    this.reactor.resolve();
  }

  private stopAll(): void {
    this.stopTimers();
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
