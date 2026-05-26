import type { Client, Guild } from 'discord.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import { CONFIGURATION_CAPABILITY_ID } from '../configuration/constants.js';
import { GENERAL_CHAT_CAPABILITY_ID } from './constants.js';
import {
  renderGeneralChatPrompt,
  type CapabilityBindingSnapshot,
  type CapabilitySnapshotEntry,
} from './preamble.js';

/**
 * Baseline conversational mode for ChopperBot. Not bound to any channel —
 * runs as the fallback whenever the bot is @-mentioned in a channel that has
 * no specialized capability bound, inside a guild the bot is already in.
 *
 * Has no tools. Its system prompt embeds a per-turn snapshot of the other
 * registered capabilities and the channels they live in, so the LLM can
 * redirect users to the right place (e.g. "ese capability vive en #ig-monitor:
 * https://discord.com/channels/.../...").
 *
 * The `configuration` capability is intentionally excluded from the snapshot
 * (admin-only), and this capability never lists itself.
 */
export class GeneralChatCapability implements Capability {
  readonly id = GENERAL_CHAT_CAPABILITY_ID;
  readonly description =
    'Conversación base de ChopperBot. Presenta el bot y redirige al canal correcto cuando el usuario pide algo que vive en otra capacidad.';

  private getDiscordClient: CapabilityInitDeps['getDiscordClient'] = undefined;
  private getRegistry: CapabilityInitDeps['getRegistry'] = undefined;
  private getRouter: CapabilityInitDeps['getRouter'] = undefined;

  async init(deps: CapabilityInitDeps): Promise<void> {
    await deps.memory.migrate(this.id, []);
    this.getDiscordClient = deps.getDiscordClient;
    this.getRegistry = deps.getRegistry;
    this.getRouter = deps.getRouter;
    log.info({ capability: this.id }, 'GeneralChatCapability initialized');
  }

  async buildTurn(_ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.getDiscordClient || !this.getRegistry || !this.getRouter) {
      throw new Error(
        'GeneralChatCapability missing handles (registry/router/client). Was init() called?',
      );
    }
    const snapshot = this.buildCapabilitySnapshot(
      this.getRegistry(),
      this.getRouter(),
      this.getDiscordClient(),
    );
    return {
      system: renderGeneralChatPrompt(_ctx.now, snapshot),
      tools: composeToolSources([]),
    };
  }

  private buildCapabilitySnapshot(
    registry: ReturnType<NonNullable<CapabilityInitDeps['getRegistry']>>,
    router: ReturnType<NonNullable<CapabilityInitDeps['getRouter']>>,
    client: Client,
  ): CapabilitySnapshotEntry[] {
    // Invert the channel→capability map into capability→channels.
    const bindingsByCapability = new Map<string, string[]>();
    for (const [channelId, capabilityId] of router.getAllBindings()) {
      const list = bindingsByCapability.get(capabilityId) ?? [];
      list.push(channelId);
      bindingsByCapability.set(capabilityId, list);
    }

    const entries: CapabilitySnapshotEntry[] = [];
    for (const cap of registry.list()) {
      if (cap.id === this.id) continue;
      if (cap.id === CONFIGURATION_CAPABILITY_ID) continue;
      const channelIds = bindingsByCapability.get(cap.id) ?? [];
      const bindings = channelIds.map((cid) => resolveBinding(client, cid));
      entries.push({ id: cap.id, description: cap.description, bindings });
    }
    return entries;
  }
}

function resolveBinding(client: Client, channelId: string): CapabilityBindingSnapshot {
  const channel = client.channels.cache.get(channelId);
  const channelName =
    channel && 'name' in channel && channel.name ? (channel.name as string) : null;
  const guild =
    channel && 'guild' in channel && channel.guild ? (channel.guild as Guild) : null;
  const guildId = guild?.id ?? null;
  const guildName = guild?.name ?? null;
  const url = guildId ? `https://discord.com/channels/${guildId}/${channelId}` : null;
  return { channelId, channelName, guildId, guildName, url };
}
