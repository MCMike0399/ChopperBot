import { Events, type Client, type Message } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";
import {
   conversationMessage,
   conversationMessageCost,
   CONVERSATION_WINDOW_MS,
   type ConversationMessage,
   type ConversationProvider,
   type ConversationWindow,
} from "./conversation.js";

interface Entry {
   messages: Map<string, ConversationMessage>;
   /** Includes deletes so an in-flight backfill cannot resurrect them. */
   changes: Map<string, number>;
   bytes: number;
   loaded: boolean;
   load?: Promise<void>;
   complete: boolean;
   windowStart?: string;
}

export interface CacheLimits {
   channelChars: number;
   globalChars: number;
   channelMessages: number;
   globalMessages: number;
   channels: number;
}

/** Content stays in bounded process memory, never SQLite. Newest channels win LRU. */
export class TranscriptCache {
   private readonly entries = new Map<string, Entry>();
   private revision = 0;
   private readonly partialFetches = new Map<string, number>();
   private lastRssLog = 0;
   constructor(
      private readonly limits: CacheLimits = {
         channelChars: config.CONTEXT_CACHE_CHANNEL_CHARS,
         globalChars: config.CONTEXT_CACHE_GLOBAL_CHARS,
         channelMessages: 4000,
         globalMessages: 30000,
         channels: 128,
      },
   ) {}

   private entry(channelId: string): Entry {
      const entry = this.entries.get(channelId) ?? {
         messages: new Map(),
         changes: new Map(),
         bytes: 0,
         loaded: false,
         complete: false,
      };
      this.entries.delete(channelId);
      this.entries.set(channelId, entry);
      return entry;
   }
   private put(entry: Entry, message: ConversationMessage): void {
      const bounded = {
         ...message,
         text: message.text.slice(0, 4000),
         author: message.author.slice(0, 120),
         mentions: message.mentions
            ?.slice(0, 50)
            .map((m) => ({ id: m.id, name: m.name.slice(0, 120) })),
      };
      const old = entry.messages.get(message.id);
      if (old) entry.bytes -= conversationMessageCost(old);
      entry.messages.set(message.id, bounded);
      entry.bytes += conversationMessageCost(bounded);
   }
   update(channelId: string, message: ConversationMessage): void {
      this.partialFetches.delete(`${channelId}:${message.id}`);
      const entry = this.entry(channelId);
      entry.changes.set(message.id, ++this.revision);
      this.put(entry, message);
      this.trim(entry);
      this.evict();
   }
   delete(channelId: string, messageId: string): void {
      this.partialFetches.delete(`${channelId}:${messageId}`);
      const entry = this.entries.get(channelId);
      if (!entry) return;
      entry.changes.set(messageId, ++this.revision);
      const message = entry.messages.get(messageId);
      if (message) entry.bytes -= conversationMessageCost(message);
      entry.messages.delete(messageId);
      this.trim(entry);
   }
   private trim(entry: Entry): void {
      const sorted = [...entry.messages.values()].sort(
         (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
      );
      for (const message of sorted) {
         if (
            entry.bytes <= this.limits.channelChars &&
            entry.messages.size <= this.limits.channelMessages &&
            message.timestamp >= Date.now() - CONVERSATION_WINDOW_MS
         )
            break;
         entry.bytes -= conversationMessageCost(message);
         entry.messages.delete(message.id);
         entry.complete = false;
      }
      // Tombstones only need to cover in-flight REST pages. The revision
      // snapshot prevents edits during that load from being overwritten.
      if (entry.load && entry.changes.size > this.limits.channelMessages * 2) {
         for (const [id, value] of this.entries)
            if (value === entry) this.entries.delete(id);
         entry.changes.clear();
      }
      if (!entry.load) entry.changes.clear();
   }
   private evict(): void {
      let chars = 0,
         messages = 0;
      for (const entry of this.entries.values()) {
         chars += entry.bytes;
         messages += entry.messages.size;
      }
      while (
         this.entries.size > this.limits.channels ||
         chars > this.limits.globalChars ||
         messages > this.limits.globalMessages
      ) {
         const id = this.entries.keys().next().value as string | undefined;
         if (!id) break;
         const entry = this.entries.get(id)!;
         chars -= entry.bytes;
         messages -= entry.messages.size;
         this.entries.delete(id);
      }
      if (Date.now() - this.lastRssLog > 60_000) {
         this.lastRssLog = Date.now();
         log.info(
            {
               channels: this.entries.size,
               serializedChars: chars,
               messages,
               rssBytes: process.memoryUsage().rss,
            },
            "conversation.cache_memory",
         );
      }
   }
   async read(
      provider: ConversationProvider,
      channelId: string,
      options: {
         now: number;
         before: string;
         maxChars: number;
         pages: number;
         botId: string | null;
      },
   ): Promise<ConversationWindow> {
      // Every read refreshes authorization, even on a warm hit. A fake provider
      // without the dedicated gate uses one bounded, authorized page instead.
      if (provider.checkAccess) await provider.checkAccess(channelId);
      else await provider.fetchPage(channelId, options.before, 1);
      const entry = this.entry(channelId);
      if (!entry.loaded) {
         if (!entry.load) {
            const revision = this.revision;
            entry.load = (async () => {
               let before = options.before;
               for (let page = 0; page < options.pages; page++) {
                  const batch = await (
                     provider.fetchBackfillPage ?? provider.fetchPage
                  ).call(provider, channelId, before, 100);
                  if (!batch.length) {
                     entry.complete = true;
                     break;
                  }
                  for (const message of batch) {
                     if ((entry.changes.get(message.id) ?? 0) <= revision)
                        this.put(entry, message);
                  }
                  before = batch.reduce(
                     (id, m) => (BigInt(m.id) < BigInt(id) ? m.id : id),
                     batch[0].id,
                  );
                  if (
                     batch.length < 100 ||
                     batch.some(
                        (m) =>
                           m.timestamp < options.now - CONVERSATION_WINDOW_MS,
                     )
                  ) {
                     entry.complete = true;
                     break;
                  }
                  if (
                     entry.bytes >= this.limits.channelChars ||
                     entry.messages.size >= this.limits.channelMessages
                  )
                     break;
               }
               entry.loaded = true;
            })().finally(() => {
               entry.load = undefined;
               entry.changes.clear();
               this.trim(entry);
               this.evict();
            });
         }
         await entry.load;
      }
      if (this.entries.get(channelId) !== entry)
         throw new Error("Cached window was invalidated.");
      // Authorization is repeated after slow backfill to catch mid-read revocation.
      if (provider.checkAccess) await provider.checkAccess(channelId);
      const all = [...entry.messages.values()]
         .filter(
            (m) =>
               BigInt(m.id) < BigInt(options.before) &&
               m.timestamp >= options.now - CONVERSATION_WINDOW_MS &&
               (!m.bot || m.authorId === options.botId) &&
               m.text,
         )
         .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      let selected = all.filter(
         (m) => !entry.windowStart || BigInt(m.id) >= BigInt(entry.windowStart),
      );
      const cost = (rows: ConversationMessage[]) =>
         rows.reduce((n, m) => n + conversationMessageCost(m), 0);
      if (
         !entry.windowStart ||
         cost(selected) > options.maxChars ||
         !selected.length
      ) {
         // 20% slack makes the transcript append-only between window resets,
         // rather than shifting its oldest message on every busy-channel turn.
         selected = [];
         let chars = 0;
         for (const message of [...all].reverse()) {
            const size = conversationMessageCost(message);
            if (chars + size > options.maxChars * 0.8) break;
            selected.push(message);
            chars += size;
         }
         selected.reverse();
         entry.windowStart = selected[0]?.id;
      }
      return {
         messages: selected,
         scanned: entry.messages.size,
         nextBefore: selected[0]?.id ?? null,
         complete: entry.complete && selected.length === all.length,
         truncated: selected.length < all.length || !entry.complete,
      };
   }
   stats() {
      return {
         channels: this.entries.size,
         chars: [...this.entries.values()].reduce((n, e) => n + e.bytes, 0),
         messages: [...this.entries.values()].reduce(
            (n, e) => n + e.messages.size,
            0,
         ),
      };
   }
   clear(): void {
      this.entries.clear();
      this.partialFetches.clear();
   }
   drop(channelId: string): void {
      this.entries.delete(channelId);
      for (const key of this.partialFetches.keys())
         if (key.startsWith(`${channelId}:`)) this.partialFetches.delete(key);
   }
   refreshPartial(
      channelId: string,
      messageId: string,
      fetch: () => Promise<ConversationMessage>,
   ): void {
      this.delete(channelId, messageId);
      if (this.partialFetches.size >= 1000) return;
      const key = `${channelId}:${messageId}`,
         revision = ++this.revision;
      this.partialFetches.set(key, revision);
      void Promise.resolve()
         .then(fetch)
         .then((message) => {
            if (this.partialFetches.get(key) === revision)
               this.update(channelId, message);
         })
         .catch(() => {})
         .finally(() => {
            if (this.partialFetches.get(key) === revision)
               this.partialFetches.delete(key);
         });
   }
   busy(channelId: string, now: number): boolean {
      const entry = this.entries.get(channelId);
      if (!entry?.loaded) return true; // cold use can span days on a busy channel
      return (
         [...entry.messages.values()].filter(
            (m) => m.timestamp >= now - 86_400_000,
         ).length >= 100
      );
   }
   async identities(
      provider: ConversationProvider,
      channelId: string,
   ): Promise<{ id: string; name: string }[]> {
      if (!provider.checkAccess)
         throw new Error("Identity access cannot be verified.");
      await provider.checkAccess(channelId);
      const identities = new Map<string, string>();
      for (const message of this.entries.get(channelId)?.messages.values() ??
         []) {
         if (message.timestamp < Date.now() - CONVERSATION_WINDOW_MS) continue;
         identities.set(message.authorId, message.author);
         for (const mention of message.mentions ?? [])
            identities.set(mention.id, mention.name);
      }
      return [...identities].map(([id, name]) => ({ id, name }));
   }
}

const caches = new WeakMap<Client, TranscriptCache>();
export function transcriptCacheFor(client: Client): TranscriptCache {
   let cache = caches.get(client);
   if (!cache) {
      cache = new TranscriptCache();
      caches.set(client, cache);
   }
   return cache;
}

/** Gateway updates/deletes are authoritative over an overlapping REST load. */
export function registerTranscriptCache(client: Client): void {
   const cache = transcriptCacheFor(client);
   const update = (message: Message) => {
      if (!message.guildId) return;
      cache.update(
         message.channelId,
         conversationMessage(message, message.guildId, message.channelId),
      );
   };
   client.on(Events.MessageCreate, update);
   client.on(Events.MessageUpdate, (_old, current) => {
      // Unknown partial edits invalidate the old text immediately, then fetch
      // the new version. A failed fetch leaves the content absent.
      if (current.partial) {
         cache.refreshPartial(current.channelId, current.id, async () => {
            const message = await current.fetch();
            if (!message.guildId) throw new Error("Guild unavailable.");
            return conversationMessage(
               message,
               message.guildId,
               message.channelId,
            );
         });
      } else update(current);
   });
   client.on(Events.MessageDelete, (message) =>
      cache.delete(message.channelId, message.id),
   );
   client.on(Events.MessageBulkDelete, (messages) => {
      for (const message of messages.values())
         cache.delete(message.channelId, message.id);
   });
   client.on(Events.ChannelDelete, (channel) => cache.drop(channel.id));
   client.on(Events.ThreadDelete, (thread) => cache.drop(thread.id));
   client.on(Events.ShardDisconnect, () => cache.clear());
}
