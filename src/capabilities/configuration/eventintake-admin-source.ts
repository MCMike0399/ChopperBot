import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { EventIntakeStore } from '../event_intake/store.js';
import { DEFAULT_MOD_ROLES } from '../event_intake/roles.js';
import { parseChannelIdEnv } from '../file_scanner/store.js';

export interface ConfigEventIntakeAdminDeps {
  db: Database.Database;
  callerUserId: string;
  /** Guild the config channel lives in — resolves the "este servidor" keyword. */
  guildId: string | null;
}

/**
 * Manage the ticket event-intake from the config channel: see what it watches +
 * who can approve, change the watched ticket categories, set the approver roles,
 * and review recent tickets. Talks to {@link EventIntakeStore} on the shared db
 * (the live listener re-reads the watched set within ~10 s, so changes take
 * effect without a restart).
 */
export class ConfigEventIntakeAdminSource implements ToolSource {
  readonly name = 'config_eventintake';
  private readonly store: EventIntakeStore;

  constructor(private readonly deps: ConfigEventIntakeAdminDeps) {
    this.store = new EventIntakeStore(deps.db);
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_eventintake',
        description:
          'Admin the ticket event-intake (works from the config channel). `action`:\n' +
          '• "status" — watched ticket categories, the approver roles, and recent ticket count.\n' +
          '• "list_categories" — the category/channel ids currently watched.\n' +
          '• "set_categories" {channels} — REPLACE the watched set. `channels` may be: comma/space-separated CATEGORY (or channel) ids or a JSON array; "este servidor" to watch every channel the bot sees in THIS server; "todos"/"all"; explicit `guild:<serverId>` tokens; or empty to stop. Takes effect within ~10s (no restart).\n' +
          '• "set_mod_roles" {roles} — REPLACE who can approve. `roles` is a comma-separated list or JSON array of role NAMES (e.g. "Moderador, Administrador, Administradora") or role ids. Empty resets to the defaults.\n' +
          '• "recent_tickets" — the latest tickets seen (status + resolved event).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'list_categories', 'set_categories', 'set_mod_roles', 'recent_tickets'],
            },
            channels: {
              type: 'string',
              description: 'For set_categories: comma/space ids or JSON array; "este servidor"/"todos"; or empty to clear.',
            },
            roles: {
              type: 'string',
              description: 'For set_mod_roles: comma-separated role names/ids or a JSON array. Empty resets to defaults.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_eventintake') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const obj = (input ?? {}) as Record<string, unknown>;
    const action = String(obj.action ?? '');
    try {
      switch (action) {
        case 'status': {
          const categories = this.store.getWatchedCategories();
          const roles = this.store.getModRoles();
          const recent = this.store.recentTickets(5).map((t) => ({
            channelId: t.channel_id,
            status: t.status,
            createdEventId: t.created_event_id,
          }));
          const lines = [
            '📋 **Event intake (tickets)**',
            categories.length === 0
              ? '• Categorías vigiladas: (ninguna — configúralas con `set_categories`)'
              : `• Categorías vigiladas: ${categories.map((c) => `\`${c}\``).join(', ')}`,
            `• Roles que pueden aprobar: ${(roles.length > 0 ? roles : [...DEFAULT_MOD_ROLES]).join(', ')}`,
            `• Bot de tickets: \`${config.EVENT_INTAKE_TICKET_BOT_ID}\``,
            `• Tickets recientes: ${recent.length}`,
          ];
          return { status: 'success', payload: { message: lines.join('\n'), categories, roles, recent } };
        }
        case 'list_categories':
          return { status: 'success', payload: { categories: this.store.getWatchedCategories() } };
        case 'set_categories': {
          const raw = (typeof obj.channels === 'string' ? obj.channels : '').trim();
          const kw = raw.toLowerCase();
          let ids: string[];
          if (kw === 'all' || kw === 'todos') {
            ids = ['all'];
          } else if (['este servidor', 'server', 'servidor', 'guild', 'here', 'this server'].includes(kw)) {
            if (!this.deps.guildId) {
              return { status: 'error', payload: { error: 'No puedo resolver el servidor actual (mensaje sin guild).' } };
            }
            ids = [`guild:${this.deps.guildId}`];
          } else {
            ids = parseChannelIdEnv(raw);
          }
          const isValid = (t: string) => /^\d{17,20}$/.test(t) || t === 'all' || /^guild:\d{17,20}$/.test(t);
          const invalid = ids.filter((t) => !isValid(t));
          if (invalid.length > 0) {
            return {
              status: 'error',
              payload: { error: `No reconozco estos valores: ${invalid.join(', ')} (usa ids de categoría/canal, "guild:<idServidor>", "este servidor" o "todos").` },
            };
          }
          this.store.setWatchedCategories(ids);
          log.info({ tool: toolName, watched: ids, by: this.deps.callerUserId }, 'event_intake.set_categories');
          const note = ids.length === 0
            ? 'Listo: ya no vigilo ninguna categoría de tickets.'
            : `Ahora vigilo ${ids.length} categoría(s)/canal(es) de tickets. Toma efecto en ~10s.`;
          return { status: 'success', payload: { watched: ids, note } };
        }
        case 'set_mod_roles': {
          const roles = parseRoleList(typeof obj.roles === 'string' ? obj.roles : '');
          this.store.setModRoles(roles);
          log.info({ tool: toolName, roles, by: this.deps.callerUserId }, 'event_intake.set_mod_roles');
          const effective = roles.length > 0 ? roles : [...DEFAULT_MOD_ROLES];
          return {
            status: 'success',
            payload: {
              roles,
              note: `Roles que pueden aprobar: ${effective.join(', ')}${roles.length === 0 ? ' (predeterminados)' : ''}.`,
            },
          };
        }
        case 'recent_tickets': {
          const recent = this.store.recentTickets(10).map((t) => ({
            channel_id: t.channel_id,
            requester_id: t.requester_id,
            status: t.status,
            created_event_id: t.created_event_id,
            updated_at_iso: new Date(t.updated_at).toISOString(),
          }));
          return { status: 'success', payload: { recent } };
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

/** Role tokens: JSON array, or comma-separated (so multi-word names survive). */
function parseRoleList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return dedupe(arr.map((x) => String(x)));
    } catch {
      // fall through
    }
  }
  return dedupe(trimmed.split(',').map((s) => s.trim()));
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}
