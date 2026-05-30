import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import type { InstagramMonitorStore, MonitoredAccount, SeenPost } from './store.js';
import { classifyPost } from './classifier.js';
import type { RecentPost } from './fetcher.js';

export interface InstagramMonitorToolSourceDeps {
  store: InstagramMonitorStore;
  /** Channel the caller is in. Used ONLY by monitor_recent_pushed; account ops are global. */
  channelId: string;
  userId: string;
  nowMs: number;
}

export class InstagramMonitorToolSource implements ToolSource {
  readonly name = 'instagram_monitor';

  constructor(private readonly deps: InstagramMonitorToolSourceDeps) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'monitor_add_account',
        description:
          'Agrega una cuenta pública de Instagram a la lista GLOBAL de monitoreo. La cuenta es vigilada una sola vez y sus posts se publican en todos los canales bindeados a esta capacidad. Acepta el handle con o sin "@", se normaliza a minúsculas. Si el usuario menciona varias cuentas, llama una vez por cada una.',
        inputSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
          },
          required: ['username'],
        },
      },
      {
        name: 'monitor_remove_account',
        description:
          'Elimina una cuenta de la lista GLOBAL de monitoreo. Deja de publicarse en todos los canales bindeados. El historial de posts detectados se conserva.',
        inputSchema: {
          type: 'object',
          properties: { username: { type: 'string' } },
          required: ['username'],
        },
      },
      {
        name: 'monitor_list_accounts',
        description:
          'Lista todas las cuentas vigiladas (lista global) con su estado (activa/pausada), último poll, y fallos consecutivos.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'monitor_pause_account',
        description:
          'Pausa o reanuda una cuenta sin borrarla. Pasa `paused: true` para pausar, `paused: false` para reanudar. Afecta todos los canales bindeados.',
        inputSchema: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            paused: { type: 'boolean' },
          },
          required: ['username', 'paused'],
        },
      },
      {
        name: 'monitor_force_poll',
        description:
          'Marca una cuenta para que el siguiente tick la procese de inmediato. La primera vez que una cuenta se sondea solo se ancla la lista de posts; no se publica nada (no hay backfill).',
        inputSchema: {
          type: 'object',
          properties: { username: { type: 'string' } },
          required: ['username'],
        },
      },
      {
        name: 'monitor_recent_pushed',
        description:
          'Devuelve los últimos N posts ya publicados a ESTE canal (con tipo, enlace y fecha). Default 10, máximo 25. Si recién bindeaste este canal, la lista estará vacía hasta que lleguen nuevos posts.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 25 },
          },
        },
      },
      {
        name: 'monitor_test_classify',
        description:
          'Prueba el clasificador con un caption arbitrario, sin tocar la base de datos ni publicar nada. Útil para validar el prompt en vivo.',
        inputSchema: {
          type: 'object',
          properties: {
            account: { type: 'string' },
            caption: { type: 'string', minLength: 1 },
          },
          required: ['account', 'caption'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      switch (toolName) {
        case 'monitor_add_account': {
          const username = normalizeUsername(obj.username);
          const { account, created } = this.deps.store.upsertAccount({
            username,
            added_by: this.deps.userId,
          });
          log.info({ tool: toolName, username, created, ms: Date.now() - t0 }, 'tool_call');
          return {
            status: 'success',
            payload: { created, account: serializeAccount(account) },
          };
        }
        case 'monitor_remove_account': {
          const username = normalizeUsername(obj.username);
          const removed = this.deps.store.removeAccount(username);
          if (!removed) {
            return {
              status: 'error',
              payload: { error: `La cuenta @${username} no está en la lista global.` },
            };
          }
          return { status: 'success', payload: { removed: serializeAccount(removed) } };
        }
        case 'monitor_list_accounts': {
          const rows = this.deps.store.listAccounts();
          return {
            status: 'success',
            payload: {
              accounts: rows.map(serializeAccount),
            },
          };
        }
        case 'monitor_pause_account': {
          const username = normalizeUsername(obj.username);
          if (typeof obj.paused !== 'boolean') {
            return { status: 'error', payload: { error: 'paused debe ser boolean.' } };
          }
          const updated = this.deps.store.setPaused(username, obj.paused);
          if (!updated) {
            return {
              status: 'error',
              payload: { error: `La cuenta @${username} no está en la lista global.` },
            };
          }
          return { status: 'success', payload: { account: serializeAccount(updated) } };
        }
        case 'monitor_force_poll': {
          const username = normalizeUsername(obj.username);
          const updated = this.deps.store.resetLastPost(username);
          if (!updated) {
            return {
              status: 'error',
              payload: { error: `La cuenta @${username} no está en la lista global.` },
            };
          }
          return {
            status: 'success',
            payload: {
              account: serializeAccount(updated),
              note: 'Listada para el próximo tick (~60s). La primera vez NO publica posts; solo ancla.',
            },
          };
        }
        case 'monitor_recent_pushed': {
          const limit = clampInt(obj.limit, 1, 25, 10);
          const rows = this.deps.store.recentPushed(this.deps.channelId, limit);
          return { status: 'success', payload: { posts: rows.map(serializeSeen) } };
        }
        case 'monitor_test_classify': {
          const account = normalizeUsername(obj.account);
          const caption = asNonEmptyString(obj.caption, 'caption');
          const fakePost: RecentPost = {
            igPostId: 'test',
            shortcode: 'test',
            caption,
            takenAtMs: this.deps.nowMs,
            mediaType: 'image',
            displayUrl: '',
          };
          const classification = await classifyPost(account, fakePost, {
            nowMs: this.deps.nowMs,
          });
          return { status: 'success', payload: { classification } };
        }
        default:
          return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return {
        status: 'error',
        payload: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}

function normalizeUsername(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error('username debe ser una cadena no vacía');
  }
  const stripped = v.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(stripped)) {
    throw new Error(
      `username inválido: "${v}" — usa solo letras, dígitos, puntos y guiones bajos, hasta 30 caracteres`,
    );
  }
  return stripped;
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${field}: cadena no vacía requerida`);
  }
  return v.trim();
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function serializeAccount(a: MonitoredAccount) {
  return {
    username: a.username,
    paused: a.paused === 1,
    added_at_iso: new Date(a.added_at).toISOString(),
    last_polled_at_iso: a.last_polled_at !== null ? new Date(a.last_polled_at).toISOString() : null,
    last_post_id: a.last_post_id,
    consecutive_failures: a.consecutive_failures,
    consecutive_auth_failures: a.consecutive_auth_failures,
    poll_interval_min: a.poll_interval_ms !== null ? Math.round(a.poll_interval_ms / 60000) : null,
    posts_per_day: a.posts_per_day !== null ? Number(a.posts_per_day.toFixed(2)) : null,
    cadence_updated_at_iso:
      a.cadence_updated_at !== null ? new Date(a.cadence_updated_at).toISOString() : null,
  };
}

function serializeSeen(p: SeenPost) {
  let classification: unknown = null;
  if (p.classification_json) {
    try {
      classification = JSON.parse(p.classification_json);
    } catch {
      classification = { parse_error: true, raw: p.classification_json.slice(0, 80) };
    }
  }
  return {
    ig_post_id: p.ig_post_id,
    account: p.account_username,
    media_type: p.media_type,
    posted_at_iso: p.posted_at !== null ? new Date(p.posted_at).toISOString() : null,
    detected_at_iso: new Date(p.detected_at).toISOString(),
    discord_message_id: p.discord_message_id,
    instagram_url: `https://instagram.com/p/${p.ig_post_id}`,
    classification,
  };
}
