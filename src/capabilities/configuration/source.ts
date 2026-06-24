import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Client, Guild, GuildBasedChannel } from 'discord.js';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import type { CapabilityRegistry } from '../registry.js';
import type { MutableCapabilityRouter } from '../routing.js';
import type { UserDirectory } from '../../users/store.js';
import { CONFIGURATION_CAPABILITY_ID, CONFIGURATION_CHANNEL_ID } from './constants.js';
import { GENERAL_CHAT_CAPABILITY_ID } from '../general_chat/constants.js';
import { ConfigurationStore } from './store.js';

/**
 * Capability id of the Instagram monitor. Hardcoded here (not imported from
 * instagram_monitor/capability.ts) to keep the configuration source decoupled
 * from the IG runtime module — we only need the string to flag push channels.
 */
const INSTAGRAM_MONITOR_CAPABILITY_ID = 'instagram_monitor';

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
        name: 'config_bindings',
        description:
          'Channel↔capability routing. `action` selects the operation:\n' +
          '• "list" — every active binding (channel id, capability, channel/guild names when visible, who set it).\n' +
          '• "by_capability" — bindings grouped per capability ("which channels does instagram_monitor fan out to?"), across ALL servers.\n' +
          '• "bind" {channel_id, capability} — bind a channel; persisted to SQLite AND applied to the live router (no restart). Refuses the hardcoded config channel and the "configuration"/"general_chat" capabilities. If the target is a push capability (instagram_monitor) and the bot cannot post there, the result includes a non-blocking `permission_warning`.\n' +
          '• "unbind" {channel_id} — remove a binding; refuses the config channel.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'by_capability', 'bind', 'unbind'] },
            channel_id: { type: 'string', description: 'Discord channel snowflake (17–20 digits). Required for bind/unbind.' },
            capability: { type: 'string', description: 'Registered capability id, e.g. "calendar" or "instagram_monitor". Required for bind.' },
          },
          required: ['action'],
        },
      },
      {
        name: 'config_discovery',
        description:
          'Discover Discord topology and check push readiness. `action`:\n' +
          '• "capabilities" — every capability registered at boot (id + description); the valid values for binding.\n' +
          '• "guilds" — every server the bot is in (id, name, member/channel counts).\n' +
          '• "guild_channels" {guild_id} — that guild\'s text channels and their current binding.\n' +
          '• "check_permissions" {channel_id} — whether ChopperBot can PUSH to a channel: reports View Channel / Send Messages / Attach Files / Embed Links and an overall `can_push` verdict. Run this before binding a channel to instagram_monitor.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['capabilities', 'guilds', 'guild_channels', 'check_permissions'] },
            guild_id: { type: 'string', description: 'Required for "guild_channels".' },
            channel_id: { type: 'string', description: 'Required for "check_permissions".' },
          },
          required: ['action'],
        },
      },
      {
        name: 'config_system',
        description:
          'Bot health, known users, and destructive per-channel purge. `action`:\n' +
          '• "bot_info" — uptime, Node version, Bedrock model id + region, max output tokens, data dir, DB size, capabilities, binding/guild counts.\n' +
          '• "list_users" {limit?} — Discord users the bot has seen (id, tag, first/last seen), most-recent first.\n' +
          '• "purge_channel_data" {capability, channel_id, confirm} — DESTRUCTIVE. Delete every row `<capability>_*` carries for a channel (tables with a channel_id column). Clears instagram_monitor_seen_posts (per-channel dedup); calendar_events is per-user (no-op — use config_calendar). Refuses configuration_*. Requires confirm:true.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['bot_info', 'list_users', 'purge_channel_data'] },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'For "list_users".' },
            capability: { type: 'string', description: 'For "purge_channel_data".' },
            channel_id: { type: 'string', description: 'For "purge_channel_data".' },
            confirm: { type: 'boolean', description: 'Must be true for "purge_channel_data".' },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      switch (toolName) {
        case 'config_bindings':
          return this.handleBindings(obj, t0);
        case 'config_discovery':
          return this.handleDiscovery(obj, t0);
        case 'config_system':
          return this.handleSystem(obj, t0);
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

  private handleBindings(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const action = asAction(obj.action, ['list', 'by_capability', 'bind', 'unbind']);
    switch (action) {
      case 'list':
        return this.handleListBindings(t0, 'config_bindings.list');
      case 'by_capability':
        return this.handleBindingsByCapability(t0);
      case 'bind':
        return this.handleBindChannel(obj, t0, 'config_bindings.bind');
      case 'unbind':
        return this.handleUnbindChannel(obj, t0, 'config_bindings.unbind');
    }
  }

  private handleDiscovery(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const action = asAction(obj.action, [
      'capabilities',
      'guilds',
      'guild_channels',
      'check_permissions',
    ]);
    switch (action) {
      case 'capabilities':
        return this.handleListCapabilities();
      case 'guilds':
        return this.handleListGuilds();
      case 'guild_channels':
        return this.handleListGuildChannels(obj);
      case 'check_permissions':
        return this.handleCheckPermissions(obj, t0);
    }
  }

  private handleSystem(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const action = asAction(obj.action, ['bot_info', 'list_users', 'purge_channel_data']);
    switch (action) {
      case 'bot_info':
        return this.handleBotInfo();
      case 'list_users':
        return this.handleListUsers(obj);
      case 'purge_channel_data':
        return this.handlePurge(obj, t0, 'config_system.purge_channel_data');
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
    if (capability === GENERAL_CHAT_CAPABILITY_ID) {
      return {
        status: 'error',
        payload: {
          error:
            "The 'general_chat' capability is the bot's baseline fallback and cannot be bound to a specific channel — it runs automatically wherever no other capability is bound.",
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

    // Push capabilities (instagram_monitor) post unprompted, so a successful
    // bind is useless if the bot can't actually post there. Surface a
    // non-blocking warning rather than refusing — perms can be fixed after.
    let permissionWarning: string | null = null;
    if (capability === INSTAGRAM_MONITOR_CAPABILITY_ID) {
      const perms = this.computePushPermissions(channelId);
      if (!perms.resolved) {
        permissionWarning = `Could not verify push permissions: ${perms.error}`;
      } else if (!perms.can_push) {
        permissionWarning = `Bot cannot push to this channel — missing: ${(perms.missing ?? []).join(', ')}. IG posts will fail until granted.`;
      }
    }

    return {
      status: 'success',
      payload: {
        channel_id: channelId,
        capability,
        previous_capability: previous?.capability_id ?? null,
        action: previous ? 'updated' : 'created',
        permission_warning: permissionWarning,
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
        bedrock_model_id: config.BEDROCK_MODEL_ID,
        aws_region: config.AWS_REGION,
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

  private handleBindingsByCapability(t0: number): ToolHandlerResult {
    const bindings = this.deps.router.getAllBindings();
    // Invert the channel→capability map into capability→channels.
    const byCapability = new Map<string, string[]>();
    for (const [channelId, capabilityId] of bindings) {
      const list = byCapability.get(capabilityId) ?? [];
      list.push(channelId);
      byCapability.set(capabilityId, list);
    }
    // List every registered capability (even those with zero bindings) so the
    // operator sees the full picture, plus any orphan bindings whose capability
    // is no longer registered.
    const seen = new Set<string>();
    const capabilities = this.deps.registry.list().map((cap) => {
      seen.add(cap.id);
      const channelIds = byCapability.get(cap.id) ?? [];
      return {
        capability_id: cap.id,
        description: cap.description,
        is_fallback: cap.id === GENERAL_CHAT_CAPABILITY_ID,
        is_protected: cap.id === CONFIGURATION_CAPABILITY_ID,
        channel_count: channelIds.length,
        channels: channelIds.map((id) => this.resolveChannelMeta(id)),
      };
    });
    const orphans = [...byCapability.entries()]
      .filter(([capId]) => !seen.has(capId))
      .map(([capId, channelIds]) => ({
        capability_id: capId,
        description: null,
        is_fallback: false,
        is_protected: false,
        registered: false,
        channel_count: channelIds.length,
        channels: channelIds.map((id) => this.resolveChannelMeta(id)),
      }));
    log.info(
      { tool: 'config_bindings.by_capability', count: capabilities.length, ms: Date.now() - t0 },
      'tool_call',
    );
    return { status: 'success', payload: { capabilities, orphan_bindings: orphans } };
  }

  private handleCheckPermissions(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    const result = this.computePushPermissions(channelId);
    log.info({ tool: 'config_discovery.check_permissions', channelId, ms: Date.now() - t0 }, 'tool_call');
    return { status: 'success', payload: { channel_id: channelId, ...result } };
  }

  /** {channel_name, guild_id, guild_name} for a channel id, best-effort from cache. */
  private resolveChannelMeta(channelId: string): {
    channel_id: string;
    channel_name: string | null;
    guild_id: string | null;
    guild_name: string | null;
  } {
    const channel = this.deps.client.channels.cache.get(channelId);
    const channelName =
      channel && 'name' in channel && channel.name ? (channel.name as string) : null;
    const guild =
      channel && 'guild' in channel && channel.guild ? (channel.guild as Guild) : null;
    return {
      channel_id: channelId,
      channel_name: channelName,
      guild_id: guild?.id ?? null,
      guild_name: guild?.name ?? null,
    };
  }

  /**
   * Whether ChopperBot can PUSH (post + attach images) to a channel. The IG
   * publisher sends `content + AttachmentBuilder` files — not rich embeds — so
   * a successful push needs View Channel + Send Messages + Attach Files. Embed
   * Links is surfaced as a nice-to-have. Duck-typed so production discord.js
   * channels and test doubles both work.
   */
  private computePushPermissions(channelId: string): PushPermissionReport {
    const channel = this.deps.client.channels.cache.get(channelId) as unknown as
      | ChannelPermProbe
      | undefined;
    if (!channel) {
      return {
        resolved: false,
        error: `Channel ${channelId} not in cache — the bot may not be in that server or cannot see the channel.`,
      };
    }
    const guild = channel.guild ?? null;
    if (!guild) {
      return {
        resolved: false,
        error: 'Not a guild text channel — instagram_monitor only pushes to guild text channels.',
      };
    }
    const me = guild.members?.me ?? null;
    if (!me || typeof channel.permissionsFor !== 'function') {
      return {
        resolved: false,
        guild_name: guild.name ?? null,
        error: 'Could not resolve the bot member or channel permissions for this channel.',
      };
    }
    const perms = channel.permissionsFor(me);
    if (!perms) {
      return {
        resolved: false,
        guild_name: guild.name ?? null,
        error: 'permissionsFor returned no overwrites for the bot member.',
      };
    }
    const view = perms.has(PermissionsBitField.Flags.ViewChannel);
    const send = perms.has(PermissionsBitField.Flags.SendMessages);
    const attach = perms.has(PermissionsBitField.Flags.AttachFiles);
    const embed = perms.has(PermissionsBitField.Flags.EmbedLinks);
    const missing: string[] = [];
    if (!view) missing.push('View Channel');
    if (!send) missing.push('Send Messages');
    if (!attach) missing.push('Attach Files');
    return {
      resolved: true,
      guild_name: guild.name ?? null,
      permissions: {
        view_channel: view,
        send_messages: send,
        attach_files: attach,
        embed_links: embed,
      },
      can_push: view && send && attach,
      missing,
    };
  }
}

interface ChannelPermProbe {
  guild?: { name?: string; members?: { me?: unknown } } | null;
  permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
}

interface PushPermissionReport {
  resolved: boolean;
  error?: string;
  guild_name?: string | null;
  permissions?: {
    view_channel: boolean;
    send_messages: boolean;
    attach_files: boolean;
    embed_links: boolean;
  };
  can_push?: boolean;
  missing?: string[];
}

/** Validate a multiplexed `action` param against the tool's allowed set. */
function asAction<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) {
    return v as T;
  }
  throw new Error(`action: must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
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
