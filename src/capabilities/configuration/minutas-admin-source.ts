import type Database from 'better-sqlite3';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { MinutasStore } from '../minutas/store.js';

export interface ConfigMinutasAdminDeps {
  db: Database.Database;
  callerUserId: string;
  /** Guild the config channel lives in (for end_session + status). */
  guildId: string | null;
  /** Live hooks into the running capability; null when it failed to init. */
  minutas: {
    endActiveSession: (guildId: string) => Promise<string>;
    transcriberAvailable: () => boolean;
    activeSession: (
      guildId: string,
    ) => { id: string; channelId: string; channelName: string; startedAtMs: number } | null;
  } | null;
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Admin the minutas (voice-minutes) capability from the config channel: where
 * minutes get published, whether a recording is running, and an emergency
 * stop. Mirrors the live capability through the hooks app.ts attaches.
 */
export class ConfigMinutasAdminSource implements ToolSource {
  readonly name = 'config_minutas';
  private readonly store: MinutasStore;

  constructor(private readonly deps: ConfigMinutasAdminDeps) {
    this.store = new MinutasStore(deps.db);
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_minutas',
        description:
          'Admin the voice-minutes (minutas) capability. `action`:\n' +
          '• "status" — output channel, whether the whisper transcriber is available, the active recording (if any), and the 5 most recent sessions.\n' +
          '• "set_output_channel" {channel_id} — where minutes are published (a text channel id).\n' +
          '• "end_session" — stop this server\'s active recording and process its minutes (same as /chopperbot-leave).',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'set_output_channel', 'end_session'] },
            channel_id: { type: 'string', description: 'For set_output_channel: text channel id.' },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_minutas') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const obj = (input ?? {}) as Record<string, unknown>;
    const action = String(obj.action ?? '');
    try {
      switch (action) {
        case 'status': {
          const recent = this.store.listRecentSessions(5).map((s) => ({
            id: s.id,
            channel: s.channel_name ?? s.channel_id,
            status: s.status,
            started_at: new Date(s.started_at).toISOString(),
            end_reason: s.end_reason,
            summary_message_id: s.summary_message_id,
            minio_prefix: s.minio_prefix,
          }));
          const active = this.deps.guildId
            ? (this.deps.minutas?.activeSession(this.deps.guildId) ?? null)
            : null;
          return {
            status: 'success',
            payload: {
              output_channel_id: this.store.getOutputChannelId(),
              transcriber_available: this.deps.minutas?.transcriberAvailable() ?? null,
              active_session: active,
              recent,
            },
          };
        }
        case 'set_output_channel': {
          const id = String(obj.channel_id ?? '').trim();
          if (!SNOWFLAKE.test(id)) {
            return { status: 'error', payload: { error: 'channel_id debe ser un snowflake de canal de texto.' } };
          }
          this.store.setOutputChannelId(id);
          log.info({ tool: toolName, channel: id, by: this.deps.callerUserId }, 'minutas.set_output_channel');
          return { status: 'success', payload: { output_channel_id: id, note: `Las minutas se publican ahora en <#${id}>.` } };
        }
        case 'end_session': {
          if (!this.deps.guildId) {
            return { status: 'error', payload: { error: 'No puedo resolver el servidor actual.' } };
          }
          if (!this.deps.minutas) {
            return { status: 'error', payload: { error: 'La capacidad minutas no está registrada (falló al iniciar).' } };
          }
          const ack = await this.deps.minutas.endActiveSession(this.deps.guildId);
          return { status: 'success', payload: { message: ack } };
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
