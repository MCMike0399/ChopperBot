import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Client, Guild, GuildBasedChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import type { CapabilityRegistry } from '../registry.js';
import type { MutableCapabilityRouter } from '../routing.js';
import { CalendarStore } from '../calendar/store.js';
import { formatInTimezone } from '../calendar/time.js';
import type { UserDirectory } from '../../users/store.js';
import { CONFIGURATION_CAPABILITY_ID, CONFIGURATION_CHANNEL_ID } from './constants.js';
import { ConfigurationStore } from './store.js';

export interface ConfigurationToolSourceDeps {
  store: ConfigurationStore;
  db: Database.Database;
  registry: CapabilityRegistry;
  router: MutableCapabilityRouter;
  client: Client;
  userDirectory: UserDirectory;
  callerUserId: string;
  startedAtMs: number;
  dbPath: string;
}

export class ConfigurationToolSource implements ToolSource {
  readonly name = 'configuration';

  constructor(private readonly deps: ConfigurationToolSourceDeps) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_list_bindings',
        description:
          "List every channel→capability binding currently active. Returns the capability id, description, the channel's name/guild when the bot can see it, and when/by-whom the binding was last set.",
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'config_bind_channel',
        description:
          "Bind a Discord channel to a capability. Persisted to SQLite AND applied to the live router (no restart needed). Refuses to touch the hardcoded configuration channel and refuses to bind anything to the 'configuration' capability.",
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'Discord channel snowflake (17–20 digits).',
            },
            capability: {
              type: 'string',
              description: 'A registered capability id, e.g. "calendar" or "instagram_monitor".',
            },
          },
          required: ['channel_id', 'capability'],
        },
      },
      {
        name: 'config_unbind_channel',
        description:
          'Remove a channel→capability binding. The channel becomes unauthorized and the bot will stop responding there. Refuses to unbind the hardcoded configuration channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
          },
          required: ['channel_id'],
        },
      },
      {
        name: 'config_list_capabilities',
        description:
          'List every capability registered at boot, with its id and human description. Use this to see what values are valid for `capability` when binding.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'config_list_guilds',
        description:
          'List every Discord guild (server) the bot is currently a member of, with id, name, and channel count. Helpful for discovering where to bind capabilities.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'config_list_guild_channels',
        description:
          'List the text channels of one guild, including each channel\'s current capability binding (if any). Use this to find channel IDs without leaving Discord.',
        inputSchema: {
          type: 'object',
          properties: { guild_id: { type: 'string' } },
          required: ['guild_id'],
        },
      },
      {
        name: 'config_list_tables',
        description:
          "Introspection: list every user table in chopperbot.db with its row count. Excludes sqlite internals.",
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'config_inspect_table',
        description:
          'Read the first N rows of a table, raw. Read-only. Hard cap of 100 rows. Errors if the table does not exist.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['name'],
        },
      },
      {
        name: 'config_migration_status',
        description:
          "Show which migration versions have been applied per capability, with timestamps. Sourced from the framework's `_migrations` table.",
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'config_bot_info',
        description:
          'Snapshot of bot health: uptime, Node version, Kimi model id, max output tokens, data directory, DB file size, registered capabilities, total bindings, and guild count.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'config_purge_channel_data',
        description:
          "DESTRUCTIVE. Delete every row a capability owns for a given channel. Works against any table named `<capability>_*` that carries a `channel_id` column. Refuses to touch configuration_*. Requires `confirm: true` — without it the call is rejected.",
        inputSchema: {
          type: 'object',
          properties: {
            capability: { type: 'string' },
            channel_id: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['capability', 'channel_id', 'confirm'],
        },
      },
      {
        name: 'config_calendar_peek',
        description:
          'List upcoming calendar events in ANY channel (bypasses the normal per-channel and per-user scoping). Each row includes the owning user. Optionally pass `discord_user_id` to filter to one user. Use to inspect calendar state from the admin console.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            discord_user_id: {
              type: 'string',
              description:
                'Optional. Discord snowflake of one user — only that user\'s events are returned. Omit to see every user\'s events in the channel.',
            },
            limit: { type: 'integer', minimum: 1, maximum: 25 },
          },
          required: ['channel_id'],
        },
      },
      {
        name: 'config_list_users',
        description:
          'List every Discord user the bot has interacted with, most-recent first. Returns id, tag, first/last seen timestamps. Useful for cross-referencing event owners surfaced by `config_calendar_peek`.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      {
        name: 'config_calendar_delete',
        description:
          'DESTRUCTIVE. Delete a calendar event by id in any channel. For recurring events this kills the whole series (matches calendar_delete_event semantics). Requires `confirm: true`.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            event_id: { type: 'integer', minimum: 1 },
            confirm: { type: 'boolean' },
          },
          required: ['channel_id', 'event_id', 'confirm'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      switch (toolName) {
        case 'config_list_bindings':
          return this.handleListBindings(t0, toolName);
        case 'config_bind_channel':
          return this.handleBindChannel(obj, t0, toolName);
        case 'config_unbind_channel':
          return this.handleUnbindChannel(obj, t0, toolName);
        case 'config_list_capabilities':
          return this.handleListCapabilities();
        case 'config_list_guilds':
          return this.handleListGuilds();
        case 'config_list_guild_channels':
          return this.handleListGuildChannels(obj);
        case 'config_list_tables':
          return { status: 'success', payload: { tables: this.deps.store.listTables() } };
        case 'config_inspect_table':
          return this.handleInspectTable(obj);
        case 'config_migration_status':
          return {
            status: 'success',
            payload: { migrations: this.deps.store.migrationStatus() },
          };
        case 'config_bot_info':
          return this.handleBotInfo();
        case 'config_purge_channel_data':
          return this.handlePurge(obj, t0, toolName);
        case 'config_calendar_peek':
          return this.handleCalendarPeek(obj);
        case 'config_calendar_delete':
          return this.handleCalendarDelete(obj, t0, toolName);
        case 'config_list_users':
          return this.handleListUsers(obj);
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

  private handleListBindings(t0: number, toolName: string): ToolHandlerResult {
    const rows = this.deps.store.list();
    const bindings = rows.map((row) => {
      const capability = this.deps.registry.get(row.capability_id);
      const channel = this.deps.client.channels.cache.get(row.channel_id);
      const channelName =
        channel && 'name' in channel && channel.name ? (channel.name as string) : null;
      const guild =
        channel && 'guild' in channel && channel.guild ? (channel.guild as Guild) : null;
      return {
        channel_id: row.channel_id,
        capability_id: row.capability_id,
        capability_registered: capability !== undefined,
        capability_description: capability?.description ?? null,
        channel_name: channelName,
        guild_id: guild?.id ?? null,
        guild_name: guild?.name ?? null,
        updated_at_iso: new Date(row.updated_at).toISOString(),
        updated_by: row.updated_by,
        is_protected: row.channel_id === CONFIGURATION_CHANNEL_ID,
      };
    });
    log.info({ tool: toolName, count: bindings.length, ms: Date.now() - t0 }, 'tool_call');
    return { status: 'success', payload: { bindings } };
  }

  private handleBindChannel(
    obj: Record<string, unknown>,
    t0: number,
    toolName: string,
  ): ToolHandlerResult {
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    const capability = asNonEmptyString(obj.capability, 'capability');

    if (channelId === CONFIGURATION_CHANNEL_ID) {
      return {
        status: 'error',
        payload: {
          error:
            'Cannot rebind the configuration channel — it is hardcoded to the configuration capability.',
        },
      };
    }
    if (capability === CONFIGURATION_CAPABILITY_ID) {
      return {
        status: 'error',
        payload: {
          error:
            "The 'configuration' capability is bound to a single hardcoded channel and cannot be assigned elsewhere.",
        },
      };
    }
    if (!this.deps.registry.has(capability)) {
      const available = this.deps.registry.list().map((c) => c.id);
      return {
        status: 'error',
        payload: {
          error: `Unknown capability "${capability}". Available: ${available.join(', ')}.`,
        },
      };
    }

    const previous = this.deps.store.get(channelId);
    this.deps.store.upsert(channelId, capability, this.deps.callerUserId);
    this.deps.router.setBinding(channelId, capability);

    log.info(
      { tool: toolName, channelId, capability, previous: previous?.capability_id ?? null, ms: Date.now() - t0 },
      'tool_call',
    );

    return {
      status: 'success',
      payload: {
        channel_id: channelId,
        capability,
        previous_capability: previous?.capability_id ?? null,
        action: previous ? 'updated' : 'created',
      },
    };
  }

  private handleUnbindChannel(
    obj: Record<string, unknown>,
    t0: number,
    toolName: string,
  ): ToolHandlerResult {
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    if (channelId === CONFIGURATION_CHANNEL_ID) {
      return {
        status: 'error',
        payload: { error: 'Cannot unbind the configuration channel.' },
      };
    }
    const removed = this.deps.store.remove(channelId);
    const routerRemoved = this.deps.router.removeBinding(channelId);
    if (!removed && !routerRemoved) {
      return {
        status: 'error',
        payload: { error: `No binding exists for channel ${channelId}.` },
      };
    }
    log.info({ tool: toolName, channelId, ms: Date.now() - t0 }, 'tool_call');
    return { status: 'success', payload: { channel_id: channelId, removed: true } };
  }

  private handleListCapabilities(): ToolHandlerResult {
    return {
      status: 'success',
      payload: {
        capabilities: this.deps.registry
          .list()
          .map((c) => ({ id: c.id, description: c.description })),
      },
    };
  }

  private handleListGuilds(): ToolHandlerResult {
    const guilds = [...this.deps.client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      member_count: g.memberCount,
      channel_count: g.channels.cache.size,
    }));
    return { status: 'success', payload: { guilds } };
  }

  private handleListGuildChannels(obj: Record<string, unknown>): ToolHandlerResult {
    const guildId = asSnowflake(obj.guild_id, 'guild_id');
    const guild = this.deps.client.guilds.cache.get(guildId);
    if (!guild) {
      return { status: 'error', payload: { error: `Guild ${guildId} not found or not joined.` } };
    }
    const bindings = this.deps.router.getAllBindings();
    const channels = [...guild.channels.cache.values()]
      .filter((c: GuildBasedChannel) => c.type === ChannelType.GuildText)
      .map((c) => ({
        id: c.id,
        name: c.name,
        bound_capability: bindings.get(c.id) ?? null,
      }));
    return {
      status: 'success',
      payload: {
        guild: { id: guild.id, name: guild.name },
        channels,
      },
    };
  }

  private handleInspectTable(obj: Record<string, unknown>): ToolHandlerResult {
    const name = asNonEmptyString(obj.name, 'name');
    const limit = clampInt(obj.limit, 1, 100, 20);
    const rows = this.deps.store.inspectTable(name, limit);
    return { status: 'success', payload: { table: name, limit, rows } };
  }

  private handleBotInfo(): ToolHandlerResult {
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = statSync(this.deps.dbPath).size;
    } catch {
      dbSizeBytes = null;
    }
    const uptimeMs = Date.now() - this.deps.startedAtMs;
    return {
      status: 'success',
      payload: {
        uptime_ms: uptimeMs,
        uptime_human: humanDuration(uptimeMs),
        node_version: process.version,
        kimi_model_id: config.KIMI_MODEL_ID,
        max_output_tokens: config.MAX_OUTPUT_TOKENS,
        data_dir: config.CHOPPERBOT_DATA_DIR,
        db_path: this.deps.dbPath,
        db_size_bytes: dbSizeBytes,
        capabilities: this.deps.registry.list().map((c) => ({ id: c.id, description: c.description })),
        total_bindings: this.deps.router.allChannelIds().size,
        guild_count: this.deps.client.guilds.cache.size,
        started_at_iso: new Date(this.deps.startedAtMs).toISOString(),
        now_iso: new Date().toISOString(),
      },
    };
  }

  private handlePurge(
    obj: Record<string, unknown>,
    t0: number,
    toolName: string,
  ): ToolHandlerResult {
    const capability = asNonEmptyString(obj.capability, 'capability');
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    if (obj.confirm !== true) {
      return {
        status: 'error',
        payload: {
          error:
            'Refusing destructive purge without `confirm: true`. Re-run the tool with confirm set explicitly.',
        },
      };
    }
    if (capability === CONFIGURATION_CAPABILITY_ID) {
      return { status: 'error', payload: { error: 'Refusing to purge configuration_* tables.' } };
    }
    const result = this.deps.store.purgeChannelData(capability, channelId);
    log.info(
      { tool: toolName, capability, channelId, result, ms: Date.now() - t0 },
      'tool_call',
    );
    return { status: 'success', payload: result };
  }

  private handleCalendarPeek(obj: Record<string, unknown>): ToolHandlerResult {
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    const limit = clampInt(obj.limit, 1, 25, 10);
    const filterUserId =
      obj.discord_user_id !== undefined && obj.discord_user_id !== null && obj.discord_user_id !== ''
        ? asSnowflake(obj.discord_user_id, 'discord_user_id')
        : null;
    const cal = new CalendarStore(this.deps.db);
    // Admin tool: default to channel-wide visibility ('all'). When a
    // discord_user_id filter is provided, the store's 'mine' branch does
    // the user-scoped query.
    const rows = filterUserId
      ? cal.listUpcoming(channelId, filterUserId, 'mine', Date.now(), limit)
      : cal.listUpcoming(channelId, '', 'all', Date.now(), limit);
    return {
      status: 'success',
      payload: {
        channel_id: channelId,
        filter_discord_user_id: filterUserId,
        events: rows.map((e) => {
          const owner = this.deps.userDirectory.get(e.discord_user_id);
          return {
            id: e.id,
            title: e.title,
            start_at_iso: new Date(e.start_at).toISOString(),
            start_at_local: formatInTimezone(e.start_at),
            end_at_iso: e.end_at !== null ? new Date(e.end_at).toISOString() : null,
            location: e.location,
            recurrence_freq: e.recurrence_freq,
            is_recurring_instance: e.is_recurring_instance,
            occurrence_index: e.occurrence_index,
            discord_user_id: e.discord_user_id,
            discord_tag: owner?.discord_tag ?? null,
          };
        }),
      },
    };
  }

  private handleListUsers(obj: Record<string, unknown>): ToolHandlerResult {
    const limit = clampInt(obj.limit, 1, 100, 25);
    const rows = this.deps.userDirectory.list(limit);
    return {
      status: 'success',
      payload: {
        users: rows.map((u) => ({
          discord_user_id: u.discord_user_id,
          discord_tag: u.discord_tag,
          first_seen_iso: new Date(u.first_seen_at).toISOString(),
          last_seen_iso: new Date(u.last_seen_at).toISOString(),
        })),
      },
    };
  }

  private handleCalendarDelete(
    obj: Record<string, unknown>,
    t0: number,
    toolName: string,
  ): ToolHandlerResult {
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    const eventId = asPositiveInt(obj.event_id, 'event_id');
    if (obj.confirm !== true) {
      return {
        status: 'error',
        payload: { error: 'Refusing destructive delete without `confirm: true`.' },
      };
    }
    const cal = new CalendarStore(this.deps.db);
    // Admin path: delete bypasses the per-user filter so we can recover
    // events the original owner left behind.
    const deleted = cal.adminDelete(channelId, eventId);
    if (!deleted) {
      return {
        status: 'error',
        payload: { error: `Event #${eventId} not found in channel ${channelId}.` },
      };
    }
    log.info(
      {
        tool: toolName,
        channelId,
        eventId,
        title: deleted.title,
        owner: deleted.discord_user_id,
        ms: Date.now() - t0,
      },
      'tool_call',
    );
    return {
      status: 'success',
      payload: {
        deleted: {
          id: deleted.id,
          title: deleted.title,
          recurrence_freq: deleted.recurrence_freq,
          discord_user_id: deleted.discord_user_id,
        },
      },
    };
  }
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${field}: must be a non-empty string`);
  }
  return v.trim();
}

function asSnowflake(v: unknown, field: string): string {
  const s = asNonEmptyString(v, field);
  if (!/^\d{17,20}$/.test(s)) {
    throw new Error(`${field}: must be a Discord snowflake (17–20 digits)`);
  }
  return s;
}

function asPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${field}: must be a positive integer`);
  }
  return v;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
