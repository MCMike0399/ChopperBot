import type Database from 'better-sqlite3';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { InstagramMonitorStore, type MonitoredAccount } from '../instagram_monitor/store.js';

export interface ConfigInstagramAdminDeps {
  db: Database.Database;
  /** Discord user driving the config console — recorded as `added_by`. */
  callerUserId: string;
}

/**
 * Manage the GLOBAL Instagram monitor account list from the config channel,
 * without having to switch into a channel bound to `instagram_monitor`.
 *
 * Accounts are global (one row per username): adding one means it is polled
 * and fanned out to EVERY channel bound to `instagram_monitor` across every
 * server. This source talks to {@link InstagramMonitorStore} directly on the
 * shared db handle — it does NOT touch the IG runtime/scheduler, so the live
 * monitor keeps working unchanged. (Force-poll is intentionally not exposed
 * here because it needs the live scheduler; `reset_anchor` nulls
 * `last_polled_at`, which makes the account due on the next tick instead — and
 * because a null anchor is treated as a first-ever poll, that re-seeds to the
 * newest post without backfilling, so it never spams bound channels.)
 */
export class ConfigInstagramAdminSource implements ToolSource {
  readonly name = 'config_instagram';
  private readonly store: InstagramMonitorStore;

  constructor(private readonly deps: ConfigInstagramAdminDeps) {
    this.store = new InstagramMonitorStore(deps.db);
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_instagram',
        description:
          'Admin the GLOBAL Instagram monitor account list + global runtime (works from the config channel). Accounts are global — changes affect EVERY channel bound to instagram_monitor on EVERY server. `action`:\n' +
          '• "list" — every monitored account with paused flag, last poll time, failure count, dedup anchor, and who added it.\n' +
          '• "status" — GLOBAL monitor health: whether the safety kill-switch is engaged (and why), current auth/rate-limit/budget cooldowns, requests in the last 24h, and counts of paused / auth-blocked accounts.\n' +
          '• "add" {username} — start monitoring an account (idempotent; reports created vs already-present).\n' +
          '• "remove" {username, confirm} — DESTRUCTIVE. Stop monitoring and drop the account row. Requires confirm:true.\n' +
          '• "pause" {username} / "resume" {username} — temporarily stop / restart polling of ONE account without losing the dedup anchor.\n' +
          '• "resume_monitor" {confirm} — clear the PERSISTENT safety kill-switch that halted ALL polling after IG flagged the session / repeatedly throttled us. Polling stays stopped (even across restarts) until this is run. Only do this AFTER confirming the IG account has no pending challenge and the cookies are fresh. Requires confirm:true.\n' +
          '• "reset_anchor" {username, confirm} — clear the dedup anchor + last_polled_at so the account re-polls next tick and RE-SEEDS its anchor to the current newest post WITHOUT pushing or backfilling. Use it to resync an account whose anchor is stuck/wrong. It does NOT replay old posts, and any unpushed posts newer than the old anchor are SKIPPED (the anchor jumps forward to "now"). Requires confirm:true.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list',
                'status',
                'add',
                'remove',
                'pause',
                'resume',
                'resume_monitor',
                'reset_anchor',
              ],
            },
            username: {
              type: 'string',
              description:
                'Instagram handle without the @ (e.g. "nasa"). Required for everything except "list".',
            },
            confirm: {
              type: 'boolean',
              description: 'Must be true for "remove", "reset_anchor", and "resume_monitor".',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_instagram') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      const action = asAction(obj.action, [
        'list',
        'status',
        'add',
        'remove',
        'pause',
        'resume',
        'resume_monitor',
        'reset_anchor',
      ]);

      if (action === 'list') {
        const accounts = this.store.listAccounts().map(serializeAccount);
        return { status: 'success', payload: { accounts } };
      }

      if (action === 'status') {
        return { status: 'success', payload: this.buildStatus() };
      }

      if (action === 'resume_monitor') {
        if (obj.confirm !== true) return needsConfirm('resume_monitor');
        const was = this.store.isGlobalStopped();
        this.store.clearGlobalStop();
        log.info({ tool: 'config_instagram.resume_monitor', was_stopped: was, ms: Date.now() - t0 }, 'tool_call');
        return {
          status: 'success',
          payload: {
            resumed: true,
            was_stopped: was,
            note: was
              ? 'Kill-switch cleared. Polling resumes on the next tick (within ~1 min, outside quiet hours).'
              : 'Monitor was not stopped; nothing to clear.',
          },
        };
      }

      const username = normalizeUsername(obj.username);

      switch (action) {
        case 'add': {
          const { account, created } = this.store.upsertAccount({
            username,
            added_by: this.deps.callerUserId,
          });
          log.info({ tool: 'config_instagram.add', username, created, ms: Date.now() - t0 }, 'tool_call');
          return {
            status: 'success',
            payload: { created, account: serializeAccount(account) },
          };
        }
        case 'pause':
        case 'resume': {
          const updated = this.store.setPaused(username, action === 'pause');
          if (!updated) return notFound(username);
          log.info({ tool: `config_instagram.${action}`, username, ms: Date.now() - t0 }, 'tool_call');
          return { status: 'success', payload: { account: serializeAccount(updated) } };
        }
        case 'remove': {
          if (obj.confirm !== true) return needsConfirm('remove');
          const removed = this.store.removeAccount(username);
          if (!removed) return notFound(username);
          log.info({ tool: 'config_instagram.remove', username, ms: Date.now() - t0 }, 'tool_call');
          return { status: 'success', payload: { removed: serializeAccount(removed) } };
        }
        case 'reset_anchor': {
          if (obj.confirm !== true) return needsConfirm('reset_anchor');
          const reset = this.store.resetLastPost(username);
          if (!reset) return notFound(username);
          log.info({ tool: 'config_instagram.reset_anchor', username, ms: Date.now() - t0 }, 'tool_call');
          return { status: 'success', payload: { account: serializeAccount(reset) } };
        }
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return {
        status: 'error',
        payload: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** Snapshot of GLOBAL monitor health: persistent kill-switch + the
   * scheduler's last-heartbeat cooldowns/budget + account aggregates. */
  private buildStatus(): Record<string, unknown> {
    const r = this.store.getRuntime();
    const accounts = this.store.listAccounts();
    const iso = (ms: number | null | undefined) =>
      ms && ms > 0 ? new Date(ms).toISOString() : null;
    const future = (ms: number | null | undefined) =>
      iso(ms && ms > Date.now() ? ms : null);
    return {
      kill_switch: {
        engaged: r.global_stop === 1,
        reason: r.stop_reason,
        stopped_at_iso: iso(r.stopped_at),
        resume_with: r.global_stop === 1 ? 'config_instagram action:resume_monitor confirm:true' : null,
      },
      cooldowns: {
        // Only show future (still-active) cooldowns; the heartbeat row may hold
        // a stale past value between events.
        auth_until_iso: future(r.auth_cooldown_until),
        rate_limit_until_iso: future(r.rate_cooldown_until),
        budget_pause_until_iso: future(r.budget_pause_until),
      },
      requests_24h: r.requests_24h ?? 0,
      heartbeat_at_iso: iso(r.heartbeat_at),
      accounts: {
        total: accounts.length,
        paused: accounts.filter((a) => a.paused === 1).length,
        auth_blocked: accounts.filter((a) => a.consecutive_auth_failures >= 5).length,
        with_failures: accounts.filter((a) => a.consecutive_failures > 0).length,
      },
    };
  }
}

function serializeAccount(a: MonitoredAccount) {
  return {
    username: a.username,
    paused: a.paused === 1,
    last_polled_at_iso: a.last_polled_at !== null ? new Date(a.last_polled_at).toISOString() : null,
    last_post_id: a.last_post_id,
    consecutive_failures: a.consecutive_failures,
    consecutive_auth_failures: a.consecutive_auth_failures,
    added_by: a.added_by,
    added_at_iso: new Date(a.added_at).toISOString(),
  };
}

function normalizeUsername(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error('username: must be a non-empty string');
  }
  // Mirror instagram_monitor/source.ts normalizeUsername so admin-added handles
  // dedup identically against UI-added ones (UNIQUE(username) is case-sensitive).
  const stripped = v.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(stripped)) {
    throw new Error(
      `username: "${v}" is invalid — letters, digits, dots and underscores only, up to 30 chars`,
    );
  }
  return stripped;
}

function notFound(username: string): ToolHandlerResult {
  return { status: 'error', payload: { error: `No monitored account "${username}".` } };
}

function needsConfirm(action: string): ToolHandlerResult {
  return {
    status: 'error',
    payload: { error: `Refusing "${action}" without \`confirm: true\`.` },
  };
}

function asAction<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`action: must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
}
