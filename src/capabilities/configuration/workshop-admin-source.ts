import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { WorkshopStore } from '../workshop/store.js';
import { sandboxAvailable } from '../workshop/sandbox.js';

export interface ConfigWorkshopAdminDeps {
  db: Database.Database;
  callerUserId: string;
  /** Resolved data dir (venv / workspaces live under it). */
  dataDir: string;
  /** Live workshop capability hooks; null when the capability isn't registered. */
  workshop: {
    adminCloseSession(channelId: string): Promise<boolean>;
    adminEnsureWelcome(): Promise<void>;
  } | null;
}

/**
 * Manage the workshop (escuela/trabajo private sessions) from the config
 * channel: see health + sessions, change the welcome channel / category /
 * emoji, repost the welcome message, and close runaway sessions.
 */
export class ConfigWorkshopAdminSource implements ToolSource {
  readonly name = 'config_workshop';
  private readonly store: WorkshopStore;

  constructor(private readonly deps: ConfigWorkshopAdminDeps) {
    this.store = new WorkshopStore(deps.db);
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_workshop',
        description:
          'Admin de los talleres privados escuela/trabajo (capacidad workshop). `action`:\n' +
          '• "status" — configuración (canal de bienvenida, categoría, emoji), sesiones activas/cerradas, sandbox/venv disponibles.\n' +
          '• "list_sessions" — sesiones activas (canal, usuarix, última actividad).\n' +
          '• "close_session" {channel_id} — cierra y ELIMINA el canal de una sesión.\n' +
          '• "set_channels" {welcome_channel_id, category_id} — cambia el canal de bienvenida y/o la categoría (repostea el mensaje de bienvenida).\n' +
          '• "set_emoji" {emoji} — cambia el emoji de reacción.\n' +
          '• "repost_welcome" — asegura/repostea el mensaje de bienvenida con el emoji.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'list_sessions', 'close_session', 'set_channels', 'set_emoji', 'repost_welcome'],
            },
            channel_id: { type: 'string' },
            welcome_channel_id: { type: 'string' },
            category_id: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_workshop') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const obj = (input ?? {}) as Record<string, unknown>;
    const action = String(obj.action ?? '');
    try {
      switch (action) {
        case 'status': {
          const settings = this.store.getSettings();
          const counts = this.store.countSessions();
          const venv = existsSync(join(this.deps.dataDir, 'workshop', 'venv', 'bin', 'python3'));
          return {
            status: 'success',
            payload: {
              registered: this.deps.workshop !== null,
              welcome_channel_id: settings.welcome_channel_id,
              welcome_message_id: settings.welcome_message_id,
              category_id: settings.category_id,
              reaction_emoji: settings.reaction_emoji,
              sessions: counts,
              max_sessions_per_user: config.WORKSHOP_MAX_SESSIONS_PER_USER,
              sandbox_available: sandboxAvailable(),
              venv_available: venv,
              note: !settings.welcome_channel_id || !settings.category_id
                ? 'Falta configurar canal de bienvenida y/o categoría (set_channels).'
                : undefined,
            },
          };
        }
        case 'list_sessions': {
          const sessions = this.store.activeSessions().map((s) => ({
            channel: `<#${s.channel_id}>`,
            channel_id: s.channel_id,
            user: s.user_tag,
            user_id: s.user_id,
            created_iso: new Date(s.created_at).toISOString(),
            last_activity_iso: new Date(s.last_activity_at).toISOString(),
          }));
          return { status: 'success', payload: { active: sessions.length, sessions } };
        }
        case 'close_session': {
          const channelId = String(obj.channel_id ?? '').replace(/[<#>]/g, '');
          if (!/^\d{17,20}$/.test(channelId)) {
            return { status: 'error', payload: { error: 'channel_id inválido.' } };
          }
          if (!this.deps.workshop) {
            return { status: 'error', payload: { error: 'La capacidad workshop no está registrada.' } };
          }
          const ok = await this.deps.workshop.adminCloseSession(channelId);
          log.info({ channelId, by: this.deps.callerUserId, ok }, 'workshop.admin_close');
          return ok
            ? { status: 'success', payload: { closed: channelId } }
            : { status: 'error', payload: { error: 'No pude cerrar esa sesión (¿existe y está activa?).' } };
        }
        case 'set_channels': {
          const welcome = normalizeId(obj.welcome_channel_id);
          const category = normalizeId(obj.category_id);
          const cur = this.store.getSettings();
          this.store.setChannels(welcome ?? cur.welcome_channel_id, category ?? cur.category_id);
          if (this.deps.workshop) await this.deps.workshop.adminEnsureWelcome();
          const updated = this.store.getSettings();
          return {
            status: 'success',
            payload: {
              welcome_channel_id: updated.welcome_channel_id,
              category_id: updated.category_id,
              note: 'Mensaje de bienvenida reposteado si hizo falta.',
            },
          };
        }
        case 'set_emoji': {
          const emoji = String(obj.emoji ?? '').trim();
          if (!emoji) return { status: 'error', payload: { error: 'Falta el emoji.' } };
          this.store.setReactionEmoji(emoji);
          if (this.deps.workshop) await this.deps.workshop.adminEnsureWelcome();
          return { status: 'success', payload: { reaction_emoji: emoji } };
        }
        case 'repost_welcome': {
          if (!this.deps.workshop) {
            return { status: 'error', payload: { error: 'La capacidad workshop no está registrada.' } };
          }
          await this.deps.workshop.adminEnsureWelcome();
          const settings = this.store.getSettings();
          return { status: 'success', payload: { welcome_message_id: settings.welcome_message_id } };
        }
        default:
          return { status: 'error', payload: { error: `Unknown action: ${action}` } };
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
}

function normalizeId(value: unknown): string | null {
  const s = String(value ?? '').replace(/[<#>]/g, '').trim();
  return /^\d{17,20}$/.test(s) ? s : null;
}
