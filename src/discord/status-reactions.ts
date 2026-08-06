import type { Message, MessageReaction } from 'discord.js';
import { log } from '../log.js';

/**
 * Progress phases a turn moves through, each with its own reaction emoji so
 * the user can see WHAT the bot is doing, not just that it heard them:
 *   queued   ⏳  waiting for earlier turns to finish (turn queue)
 *   thinking 🤔  the model is reasoning/writing
 *   tool     🛠️  a tool call is executing (calendar, python, files…)
 *   error    ❌  the turn failed (left on the message, next to the apology)
 *
 * This replaces the old single 🔍 "I heard you" reaction (2026-08-06).
 */
export type TurnPhase = 'queued' | 'thinking' | 'tool' | 'error';

const PHASE_EMOJI: Record<TurnPhase, string> = {
  queued: '⏳',
  thinking: '🤔',
  tool: '🛠️',
  error: '❌',
};

/**
 * Manages the single status reaction on a user's message as the turn
 * progresses. All Discord calls are serialized on an internal promise chain
 * (reaction add/remove are racy otherwise) and every error is swallowed — a
 * missing Add Reactions permission must never break the reply itself.
 *
 * Usage: `set()` on each phase change (idempotent), then `resolve()` on
 * success (removes the reaction) or `fail()` on error (leaves ❌).
 */
export class StatusReactor {
  private chain: Promise<void> = Promise.resolve();
  private current: TurnPhase | null = null;
  private reaction: MessageReaction | null = null;
  private finished = false;

  constructor(
    private readonly message: Message,
    private readonly botUserId: string | undefined,
  ) {}

  /** Switch the status reaction to `phase`. No-op if already there. */
  set(phase: TurnPhase): void {
    if (this.finished || phase === this.current) return;
    this.current = phase;
    this.enqueue(async () => {
      await this.removeOwn();
      this.reaction = await this.message.react(PHASE_EMOJI[phase]).catch(() => null);
    });
  }

  /** Success: remove whatever status reaction is showing. */
  resolve(): void {
    if (this.finished) return;
    this.finished = true;
    this.current = null;
    this.enqueue(() => this.removeOwn());
  }

  /** Failure: switch to ❌ and LEAVE it (visible next to the error reply). */
  fail(): void {
    if (this.finished) return;
    this.finished = true;
    this.current = 'error';
    this.enqueue(async () => {
      await this.removeOwn();
      await this.message.react(PHASE_EMOJI.error).catch(() => null);
    });
  }

  /** Wait for pending reaction updates (tests / orderly shutdown). */
  settled(): Promise<void> {
    return this.chain;
  }

  private async removeOwn(): Promise<void> {
    if (!this.reaction || !this.botUserId) {
      this.reaction = null;
      return;
    }
    await this.reaction.users.remove(this.botUserId).catch(() => {});
    this.reaction = null;
  }

  private enqueue(op: () => Promise<void>): void {
    this.chain = this.chain
      .then(op)
      .catch((err) => log.debug({ err }, 'status_reactor.op_failed'));
  }
}
