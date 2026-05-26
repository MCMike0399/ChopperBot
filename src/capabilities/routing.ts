/**
 * Resolves an authorized Discord channelId to the id of the Capability that
 * should run there. Returns null for unauthorized channels.
 *
 * The channel→capability map starts from `src/config.ts` (env-var seeding)
 * and is then persisted in SQLite via the configuration capability. The
 * router is the runtime view of that map and is mutated live when bindings
 * are added/removed from chat.
 */
export interface CapabilityRouter {
  resolve(channelId: string): string | null;
  /** All channel ids known to the router (= the authorized set). */
  allChannelIds(): Set<string>;
}

/**
 * Live-mutable router. Used by the configuration capability to apply
 * bind/unbind operations without restarting the bot. Read-only consumers
 * (Discord handlers, calendar capability, etc.) should type their dependency
 * as the parent {@link CapabilityRouter} instead.
 */
export interface MutableCapabilityRouter extends CapabilityRouter {
  setBinding(channelId: string, capabilityId: string): void;
  /** Returns true if a binding was actually removed. */
  removeBinding(channelId: string): boolean;
  getAllBindings(): Map<string, string>;
}

export function buildRouter(channelToCapability: Map<string, string>): MutableCapabilityRouter {
  const map = new Map(channelToCapability);
  return {
    resolve: (channelId: string) => map.get(channelId) ?? null,
    allChannelIds: () => new Set(map.keys()),
    setBinding: (channelId: string, capabilityId: string) => {
      map.set(channelId, capabilityId);
    },
    removeBinding: (channelId: string) => map.delete(channelId),
    getAllBindings: () => new Map(map),
  };
}
