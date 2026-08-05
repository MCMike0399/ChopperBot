/**
 * Where the daily announcement posts and who it pings, resolved the same way
 * everywhere: **the DB setting once it exists, the env var only as a first-boot
 * seed** (the rule the output channel already follows).
 *
 * It lives in its own module because three callers need the identical answer —
 * the runtime watcher, the admin console's `announce_status`/`announce_now`, and
 * the verify script — and a disagreement between them would mean the preview
 * shows one thing and the live post does another. That is precisely the bug
 * class a feature that @-pings a whole community cannot afford.
 *
 * The mention list distinguishes **never configured** (SQL NULL → fall back to
 * the env seed) from **configured as empty** (`[]` → deliberately ping nobody).
 * Collapsing those two would make `set_announce_mentions ""` silently undo
 * itself on the next restart.
 */
import { config } from '../../config.js';
import { parseChannelIdEnv } from '../file_scanner/store.js';

/** The slice of {@link ./store.js CalendarStore} these settings live in. */
export interface AnnounceSettingsStore {
  getAnnounceChannelId(): string | null;
  /** Raw JSON as stored: `null` means the setting was never written. */
  getAnnounceMentionsRaw(): string | null;
  getAnnounceMentions(): string[];
}

export interface ResolvedAnnounceSettings {
  /** Community channel, or null when the feature is simply off. */
  channelId: string | null;
  /** Role snowflakes and/or the literal `everyone`; empty = ping nobody. */
  mentions: string[];
  /** Local hour (America/Mexico_City) from which announcing is allowed. */
  hour: number;
}

export function resolveAnnounceSettings(store: AnnounceSettingsStore): ResolvedAnnounceSettings {
  return {
    channelId: store.getAnnounceChannelId() ?? config.CALENDAR_ANNOUNCE_CHANNEL_ID ?? null,
    mentions:
      store.getAnnounceMentionsRaw() === null
        ? parseChannelIdEnv(config.CALENDAR_ANNOUNCE_MENTIONS)
        : store.getAnnounceMentions(),
    hour: config.CALENDAR_ANNOUNCE_HOUR,
  };
}
