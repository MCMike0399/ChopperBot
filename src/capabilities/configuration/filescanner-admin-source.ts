import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { FileScannerStore, parseChannelIdEnv } from '../file_scanner/store.js';
import { formatScannerStatus } from '../file_scanner/format.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ConfigFileScannerAdminDeps {
  db: Database.Database;
  callerUserId: string;
  /** Guild the config channel lives in — resolves the "este servidor" keyword. */
  guildId: string | null;
}

/**
 * Manage the VirusTotal file scanner from the config channel: see health +
 * budget, list/change the watched channels, and review recent verdicts. Talks
 * to {@link FileScannerStore} on the shared db handle (the live watcher re-reads
 * the watched set within ~10 s, so channel changes take effect without a
 * restart).
 */
export class ConfigFileScannerAdminSource implements ToolSource {
  readonly name = 'config_filescanner';
  private readonly store: FileScannerStore;

  constructor(private readonly deps: ConfigFileScannerAdminDeps) {
    this.store = new FileScannerStore(deps.db);
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_filescanner',
        description:
          'Admin the VirusTotal file scanner (works from the config channel). `action`:\n' +
          '• "status" — whether scanning is enabled, the channels being watched, the 24h VirusTotal request budget used/remaining, and cache verdict counts.\n' +
          '• "list_channels" — the channel ids currently watched.\n' +
          '• "set_channels" {channels} — REPLACE the watched-channel set. `channels` may be: a comma/space-separated list of channel ids (or a JSON array); the keyword "este servidor"/"server"/"guild" to watch EVERY channel the bot can see in THIS server; "todos"/"all" to watch every channel in every server the bot is in; or an empty string to stop watching. You can also pass explicit `guild:<serverId>` tokens. Takes effect within ~10s (no restart).\n' +
          '• "scan_stats" — recent scans and totals by verdict.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'list_channels', 'set_channels', 'scan_stats'],
            },
            channels: {
              type: 'string',
              description:
                'For set_channels: comma/space-separated channel ids or a JSON array. Empty string clears the list.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_filescanner') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const obj = (input ?? {}) as Record<string, unknown>;
    const action = String(obj.action ?? '');
    const nowMs = Date.now();
    try {
      switch (action) {
        case 'status': {
          const counts = this.store.verdictCounts();
          const recent = this.store.recentScans(5).map((r) => ({
            fileName: r.file_name,
            verdict: r.verdict,
            lastSeenAt: r.last_seen_at,
          }));
          const lines = formatScannerStatus({
            enabled: !!config.VIRUSTOTAL_API_KEY,
            watchedChannels: this.store.getWatchedChannels(),
            used24h: this.store.requestsInWindow(nowMs, WINDOW_MS),
            budget: config.VIRUSTOTAL_DAILY_REQUEST_BUDGET,
            minIntervalMs: config.VIRUSTOTAL_MIN_REQUEST_INTERVAL_MS,
            counts,
            recent,
            nowMs,
          });
          return { status: 'success', payload: { message: lines.join('\n'), watched: this.store.getWatchedChannels() } };
        }
        case 'list_channels':
          return { status: 'success', payload: { channels: this.store.getWatchedChannels() } };
        case 'set_channels': {
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
          const isValid = (t: string) =>
            /^\d{17,20}$/.test(t) || t === 'all' || /^guild:\d{17,20}$/.test(t);
          const invalid = ids.filter((t) => !isValid(t));
          if (invalid.length > 0) {
            return {
              status: 'error',
              payload: { error: `No reconozco estos valores: ${invalid.join(', ')} (usa ids de canal, "guild:<idServidor>", "este servidor" o "todos").` },
            };
          }
          this.store.setWatchedChannels(ids);
          log.info({ tool: toolName, watched: ids, by: this.deps.callerUserId }, 'file_scanner.set_channels');
          const note = ids.length === 0
            ? 'Se limpió la lista: el escáner ya no vigila ningún canal.'
            : ids.includes('all')
              ? 'Ahora vigilo TODOS los canales que el bot puede ver (en todos los servidores). Toma efecto en ~10s.'
              : ids.some((t) => t.startsWith('guild:'))
                ? 'Ahora vigilo todos los canales visibles del/los servidor(es) indicado(s). Toma efecto en ~10s.'
                : `Ahora vigilo ${ids.length} canal(es). Toma efecto en ~10s.`;
          return { status: 'success', payload: { watched: ids, note } };
        }
        case 'scan_stats': {
          const counts = this.store.verdictCounts();
          const recent = this.store.recentScans(10).map((r) => ({
            file_name: r.file_name,
            verdict: r.verdict,
            malicious: r.malicious,
            total: r.malicious + r.suspicious + r.harmless + r.undetected,
            last_seen_at_iso: new Date(r.last_seen_at).toISOString(),
            scan_count: r.scan_count,
          }));
          return { status: 'success', payload: { counts, recent } };
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
