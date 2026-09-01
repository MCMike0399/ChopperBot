import {
   ActionRowBuilder,
   AttachmentBuilder,
   ButtonBuilder,
   ButtonStyle,
   ChannelType,
   MessageFlags,
   PermissionFlagsBits,
   type ButtonInteraction,
   type Client,
   type Guild,
   type Interaction,
   type Message,
   type MessageReaction,
   type OmitPartialGroupDMChannel,
   type PartialMessageReaction,
   type PartialUser,
   type TextChannel,
   type User,
} from "discord.js";

/** The Message shape the MessageCreate gateway event actually delivers. */
type GatewayMessage = OmitPartialGroupDMChannel<Message>;
import { basename, join } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { textBrainDisplayName } from "../../config.js";
import { log } from "../../log.js";
import { ask, TurnAbortedError } from "../../llm/client.js";
import { reportSpanishStyle } from "../../lang/report.js";
import { WORKSHOP_CAPABILITY_ID } from "./constants.js";
import { chunkBotReply } from "../../discord/chunk.js";
import { normalizeTurns, type Turn } from "../../discord/history.js";
import { WorkshopTurnPresenter } from "../../discord/presenter.js";
import { QueueBusyError, type TurnQueue } from "../../discord/turn-queue.js";
import {
   QUEUE_BUSY_REPLY,
   GENERIC_ERROR_REPLY,
} from "../../discord/handlers.js";
import { resolveAttachments } from "../../attachments/resolver.js";
import { composeToolSources } from "../../tools/source.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import type { WorkshopStore, WorkshopSession } from "./store.js";
import {
   SessionWorkspace,
   workspaceDirFor,
   listUndeliveredDeliverables,
} from "./workspace.js";
import {
   deleteSessionObjects,
   restoreFromStorage,
   uploadToStorage,
} from "./storage.js";
import {
   WorkshopToolSource,
   MAX_SEND_FILE_BYTES,
   type SessionActions,
} from "./tools.js";
import { archiveSessionFiles } from "./archive.js";
import { sandboxAvailable } from "./sandbox.js";
import { buildChannelHistory, type ChannelHistoryResult } from "./history.js";
import { compactConversation, shouldCompact } from "./compact.js";
import {
   renderPanelContent,
   renderSessionIntro,
   renderWelcomeMessage,
   renderWorkshopPrompt,
} from "./preamble.js";

/** Uploaded user files larger than this are not saved to the workspace. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** How the user-visible channel names start. */
const CHANNEL_PREFIX = "taller";

const BTN_CLEAR = "workshop:clear";
const BTN_CLOSE = "workshop:close";
const BTN_CLOSE_CONFIRM = "workshop:close_confirm";
const BTN_CLOSE_CANCEL = "workshop:close_cancel";

export interface WorkshopWatcherDeps {
   client: Client;
   store: WorkshopStore;
   turnQueue: TurnQueue;
   /** Absolute data dir (resolved from projectRoot + CHOPPERBOT_DATA_DIR). */
   dataDir: string;
   reactionEmoji: () => string;
   maxSessionsPerUser: number;
   pyTimeoutMs: number;
   /** Fired whenever a session is created or closed (cache invalidation). */
   onSessionsChanged?: () => void;
   /**
    * Durable object store for session files (MinIO on the HDD). Null/omitted =
    * the pre-MinIO behavior (Discord carrier messages only). Every use is
    * best-effort — storage failures degrade to Discord, never break a turn.
    */
   storage?: ObjectStorage | null;
   now?: () => number;
}

/** Sanitize a Discord username into a channel-name segment. Exported for tests. */
export function channelNameFor(userTag: string, sessionNumber: number): string {
   const base = userTag
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "");
   const suffix = sessionNumber > 1 ? `-${sessionNumber}` : "";
   return `${CHANNEL_PREFIX}-${base || "sesion"}${suffix}`;
}

/**
 * The workshop brain: reaction → private channel; every message in a session
 * channel → a full agent turn (no mention needed); buttons + tools manage the
 * session. Every entry point is wrapped so failures never reach the gateway.
 */
export class WorkshopWatcher {
   private readonly now: () => number;
   /** Users with a channel-creation in flight (double-click guard). */
   private readonly creating = new Set<string>();
   /**
    * Abort flag of each channel's newest pending/running turn. A NEW message
    * from the session owner flips it, so the older turn stops at its next
    * step (between model requests / tool calls) and the new turn — behind it
    * in the FIFO queue — takes over with the full history. Web-LLM-style
    * interruption: "nooo" shouldn't wait minutes behind a doomed loop.
    */
   private readonly turnAborts = new Map<string, { aborted: boolean }>();
   /** Channels with a compaction call in flight (one at a time per channel). */
   private readonly compacting = new Set<string>();

   constructor(private readonly deps: WorkshopWatcherDeps) {
      this.now = deps.now ?? (() => Date.now());
   }

   // ── Welcome message ───────────────────────────────────────────────────────

   /** Make sure the reaction target exists in the welcome channel. */
   async ensureWelcomeMessage(): Promise<void> {
      const settings = this.deps.store.getSettings();
      if (!settings.welcome_channel_id) {
         log.info("workshop.welcome.not_configured");
         return;
      }
      const channel = await this.deps.client.channels
         .fetch(settings.welcome_channel_id)
         .catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
         log.warn(
            { channelId: settings.welcome_channel_id },
            "workshop.welcome.channel_unavailable",
         );
         return;
      }
      const emoji = this.deps.reactionEmoji();
      const body = renderWelcomeMessage(emoji, textBrainDisplayName());

      if (settings.welcome_message_id) {
         const existing = await channel.messages
            .fetch(settings.welcome_message_id)
            .catch(() => null);
         if (existing) {
            if (existing.content !== body) {
               const edited = await existing.edit(body).catch((err) => {
                  log.warn({ err }, "workshop.welcome.edit_failed");
                  return null;
               });
               if (edited) {
                  log.info(
                     { messageId: existing.id },
                     "workshop.welcome.updated",
                  );
               }
            }
            // Re-add our own reaction if it got cleared (it's the visible button).
            if (!existing.reactions.cache.get(emoji)?.me) {
               await existing.react(emoji).catch(() => {});
            }
            return;
         }
         log.warn(
            { messageId: settings.welcome_message_id },
            "workshop.welcome.message_missing_reposting",
         );
      }

      const posted = await channel
         .send(body)
         .catch((err) => {
            log.error({ err }, "workshop.welcome.post_failed");
            return null;
         });
      if (!posted) return;
      await posted.react(emoji).catch(() => {});
      this.deps.store.setWelcomeMessageId(posted.id);
      log.info({ messageId: posted.id }, "workshop.welcome.posted");
   }

   // ── Reaction → session channel ────────────────────────────────────────────

   async handleReaction(
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
   ): Promise<void> {
      try {
         const settings = this.deps.store.getSettings();
         if (!settings.welcome_message_id || !settings.category_id) return;
         if (reaction.message.id !== settings.welcome_message_id) return;

         const emojiName = reaction.emoji.name ?? "";
         if (emojiName !== this.deps.reactionEmoji()) return;

         const fullUser = user.partial
            ? await user.fetch().catch(() => null)
            : user;
         if (!fullUser || fullUser.bot) return;

         if (this.creating.has(fullUser.id)) return;
         this.creating.add(fullUser.id);
         try {
            await this.createSessionFor(
               reaction,
               fullUser,
               settings.category_id,
            );
         } finally {
            this.creating.delete(fullUser.id);
         }
      } catch (err) {
         log.error({ err }, "workshop.reaction.error");
      }
   }

   private async createSessionFor(
      reaction: MessageReaction | PartialMessageReaction,
      user: User,
      categoryId: string,
   ): Promise<void> {
      const message = reaction.message.partial
         ? await reaction.message.fetch().catch(() => null)
         : reaction.message;
      const guild = message?.guild ?? null;
      // Tidy the button for the next member (and let this one re-click later).
      const removeReaction = (): void => {
         void reaction.users.remove(user.id).catch(() => {});
      };
      if (!guild) return;

      const active = this.deps.store.activeSessionsFor(user.id);
      if (active.length >= this.deps.maxSessionsPerUser) {
         removeReaction();
         await this.notifyLimit(user, active);
         return;
      }

      const name = channelNameFor(user.tag ?? user.username, active.length + 1);
      const botId = this.deps.client.user?.id;
      let channel: TextChannel;
      try {
         channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: categoryId,
            reason: `Taller privado para ${user.tag}`,
            permissionOverwrites: [
               {
                  id: guild.roles.everyone.id,
                  deny: [PermissionFlagsBits.ViewChannel],
               },
               {
                  id: user.id,
                  allow: [
                     PermissionFlagsBits.ViewChannel,
                     PermissionFlagsBits.SendMessages,
                     PermissionFlagsBits.ReadMessageHistory,
                     PermissionFlagsBits.AttachFiles,
                     PermissionFlagsBits.EmbedLinks,
                  ],
               },
               ...(botId
                  ? [
                       {
                          id: botId,
                          allow: [
                             PermissionFlagsBits.ViewChannel,
                             PermissionFlagsBits.SendMessages,
                             PermissionFlagsBits.ReadMessageHistory,
                             PermissionFlagsBits.AttachFiles,
                             PermissionFlagsBits.EmbedLinks,
                             PermissionFlagsBits.ManageMessages,
                             PermissionFlagsBits.ManageChannels,
                             PermissionFlagsBits.AddReactions,
                          ],
                       },
                    ]
                  : []),
            ],
         });
      } catch (err) {
         log.error(
            { err, categoryId, user: user.tag },
            "workshop.channel_create_failed",
         );
         removeReaction();
         return;
      }

      this.deps.store.createSession({
         channelId: channel.id,
         guildId: guild.id,
         userId: user.id,
         userTag: user.tag ?? user.username,
         nowMs: this.now(),
      });
      this.deps.onSessionsChanged?.();

      await channel.send(renderSessionIntro(user.id)).catch(() => null);
      const panel = await channel
         .send({ content: renderPanelContent(), components: [panelButtons()] })
         .catch(() => null);
      if (panel) {
         this.deps.store.setPanelMessageId(channel.id, panel.id);
         await panel.pin().catch(() => {});
      }
      removeReaction();
      log.info(
         { channelId: channel.id, user: user.tag },
         "workshop.session_created",
      );
   }

   private async notifyLimit(
      user: User,
      active: WorkshopSession[],
   ): Promise<void> {
      const links = active.map((s) => `<#${s.channel_id}>`).join(", ");
      const text =
         `Ya tienes ${active.length} taller(es) abierto(s): ${links}. ` +
         "Cierra alguno desde su panel (🔒) para abrir uno nuevo.";
      const dm = await user.send(text).catch(() => null);
      if (dm) return;
      // DMs closed → short-lived notice in the welcome channel.
      const settings = this.deps.store.getSettings();
      if (!settings.welcome_channel_id) return;
      const channel = await this.deps.client.channels
         .fetch(settings.welcome_channel_id)
         .catch(() => null);
      if (!channel || !channel.isSendable()) return;
      const notice = await channel
         .send(`<@${user.id}> ${text}`)
         .catch(() => null);
      if (notice)
         setTimeout(() => void notice.delete().catch(() => {}), 20_000);
   }

   // ── Session chat ──────────────────────────────────────────────────────────

   async handleMessage(message: GatewayMessage): Promise<void> {
      try {
         if (message.author?.bot) return;
         const session = this.deps.store.getSession(message.channelId);
         if (!session || session.status !== "active") return;

         const userText = (message.content ?? "").trim();
         const hasAttachments = message.attachments.size > 0;
         if (!userText && !hasAttachments) return;

         this.deps.store.touchActivity(message.channelId, this.now());
         // Workshop conversation style: ⏳ reaction while queued, then the live
         // status line that morphs into the reply (web-LLM experience).
         const presenter = new WorkshopTurnPresenter(
            message,
            this.deps.client.user?.id,
            this.now,
         );

         // A newer message interrupts the channel's older pending/running turn:
         // it stops at its next step and this turn (behind it in the FIFO queue)
         // answers with the full history — including what the older turn's tools
         // already left in the workspace.
         const prev = this.turnAborts.get(message.channelId);
         if (prev) prev.aborted = true;
         const abortFlag = { aborted: false };
         this.turnAborts.set(message.channelId, abortFlag);

         try {
            await this.deps.turnQueue.run(
               message.channelId,
               () => this.runTurn(message, session, presenter, abortFlag),
               { onQueued: () => presenter.onQueued() },
            );
         } catch (err) {
            if (err instanceof TurnAbortedError) {
               // Superseded by a newer message — clean up silently; the newer
               // turn owns the conversation now.
               await presenter.discard();
               log.info(
                  { channelId: message.channelId },
                  "workshop.turn_interrupted",
               );
               return;
            }
            if (err instanceof QueueBusyError) {
               await presenter.fail(QUEUE_BUSY_REPLY);
               return;
            }
            log.error(
               { err, channelId: message.channelId },
               "workshop.turn_failed",
            );
            await presenter.fail(GENERIC_ERROR_REPLY);
         } finally {
            if (this.turnAborts.get(message.channelId) === abortFlag) {
               this.turnAborts.delete(message.channelId);
            }
         }
      } catch (err) {
         log.error({ err }, "workshop.message.error");
      }
   }

   private async runTurn(
      message: GatewayMessage,
      session: WorkshopSession,
      presenter: WorkshopTurnPresenter,
      abortFlag: { aborted: boolean },
   ): Promise<void> {
      // Interrupted while still waiting in the queue → don't even start.
      if (abortFlag.aborted) throw new TurnAbortedError();

      // Web-LLM-style progress: ONE subtext status line, edited in place as the
      // turn advances, that finally morphs into the reply itself. The queued-⏳
      // reaction (set by handleMessage) is cleared as soon as the line exists.
      await presenter.begin();

      const workspace = new SessionWorkspace(
         workspaceDirFor(this.deps.dataDir, session.channel_id),
      );
      workspace.ensure();

      // Discord is the durable file store; the Pi workspace is a cache. Any
      // manifest file the GC dropped locally is re-downloaded from its message.
      await this.rehydrate(session, workspace);

      // Save EVERY attachment into the workspace (python can process them);
      // images additionally ride the turn for vision.
      const savedUploads = await this.saveUploads(message, workspace);

      // Snapshot for the auto-delivery safety net: deliverables the agent loop
      // creates/rewrites but forgets to send are attached after the reply.
      const filesBefore = new Map(
         workspace.list().map((f) => [f.path, f.modifiedAt]),
      );

      // Deferred side effects the tools may request (executed after the reply).
      const pendingFiles: Array<{ relPath: string; caption: string | null }> =
         [];
      let pendingClear = false;
      let pendingClose = false;
      const actions: SessionActions = {
         queueSendFile: (relPath, caption) =>
            void pendingFiles.push({ relPath, caption }),
         queueClear: () => void (pendingClear = true),
         queueClose: () => void (pendingClose = true),
         clearContextNow: () =>
            this.deps.store.clearContext(session.channel_id, this.now()),
         renameChannel: async (name) => this.renameChannel(message, name),
      };

      let reply: string;
      let hist: ChannelHistoryResult = {
         turns: [],
         older: [],
         olderNewestMs: null,
      };
      try {
         const skipIds = new Set<string>();
         if (session.panel_message_id) skipIds.add(session.panel_message_id);
         // History window starts after whichever is newer: an explicit "limpiar"
         // or the compaction watermark (older turns live in session.summary).
         const sinceMs =
            Math.max(
               session.context_cleared_at ?? 0,
               session.summary_covers_until ?? 0,
            ) || null;
         hist = await buildChannelHistory(this.deps.client, message, {
            sinceMs,
            skipIds,
         });
         const attachments = await resolveAttachments(message);
         const text =
            (message.content ?? "").trim() ||
            (savedUploads.length > 0
               ? `Te subí: ${savedUploads.join(", ")}`
               : "…");
         const turns: Turn[] = normalizeTurns([
            ...hist.turns,
            { role: "user", content: text, attachments },
         ]);

         const venvDir = this.venvDir();
         const tools = composeToolSources([
            new WorkshopToolSource({
               workspace,
               actions,
               venvDir,
               maxTimeoutMs: this.deps.pyTimeoutMs,
               deliveredPaths: () => this.deliveredPaths(session.channel_id),
            }),
         ]);
         const system = renderWorkshopPrompt({
            now: new Date(this.now()),
            userTag: session.user_tag,
            userId: session.user_id,
            channelName:
               "name" in message.channel
                  ? ((message.channel.name as string | null) ?? null)
                  : null,
            files: workspace.list(),
            sandboxAvailable: sandboxAvailable(),
            venvAvailable: venvDir !== null,
            savedUploads,
            summary: session.summary,
            deliveredPaths: this.deliveredPaths(session.channel_id),
         });

         log.info(
            {
               channelId: session.channel_id,
               user: session.user_tag,
               len: text.length,
               historyTurns: hist.turns.length,
               olderTurns: hist.older.length,
               hasSummary: session.summary != null,
               uploads: savedUploads.length,
            },
            "workshop.turn",
         );
         reply = await ask({
            system,
            messages: turns,
            tools,
            // High tier (2026-08-13): a workshop turn is the longest tool loop in
            // the bot — sandboxed Python, doc indexing, file send — and it runs up
            // to MAX_TOOL_ITERATIONS. Weak tool-calling here burns the whole
            // iteration budget and lands the member on the forcing-pass fallback.
            effort: "high",
            onPhase: (phase, detail) => presenter.onPhase(phase, detail),
            shouldAbort: () => abortFlag.aborted,
         });
      } catch (err) {
         if (err instanceof TurnAbortedError) {
            // Superseded: the status line vanishes; the newer turn takes over.
            await presenter.discard();
            throw err;
         }
         log.error(
            { err, channelId: session.channel_id },
            "workshop.turn_failed",
         );
         await presenter.fail(GENERIC_ERROR_REPLY);
         return;
      }

      // Interrupted after the loop finished but before posting: discard — the
      // newer turn answers with full context (web-LLM interrupt semantics).
      if (abortFlag.aborted) {
         await presenter.discard();
         throw new TurnAbortedError();
      }

      reportSpanishStyle(reply, {
         capability: WORKSHOP_CAPABILITY_ID,
         channelId: message.channelId,
      });
      // The status line becomes the reply (first chunk edits it in place).
      const anchor = await presenter.deliver(chunkBotReply(reply));

      // Deferred effects, in a safe order: files → purge → close.
      for (const f of pendingFiles) {
         await this.sendWorkspaceFile(message, workspace, f.relPath, f.caption);
      }
      // Auto-delivery safety net (live 2026-08-09: a session's estatutos
      // .docx/.pdf were generated but the model ended the turn without
      // workshop_send_file, then insisted "ya te lo envié"). Attach whatever
      // deliverable THIS turn created/rewrote that nobody queued; the ledger
      // shows it as ✅ from the next turn on. Pointless if the channel is
      // about to be deleted.
      if (!pendingClose) {
         await this.autoSendForgottenDeliverables(
            message,
            workspace,
            filesBefore,
            pendingFiles,
         );
      }
      if (pendingClear) {
         await this.purgeChannel(message.channel, session, anchor?.id ?? null);
         await this.archiveFiles(message.channel, session);
      }
      if (pendingClose) {
         await this.closeSession(session.channel_id, "tool");
         return;
      }

      // Context compaction (fire-and-forget): fold the turns that overflowed
      // the live window into the session summary so long sessions keep their
      // thread. Non-blocking — a failure just retries on a later turn.
      if (!pendingClear && shouldCompact(hist.older)) {
         void this.compactSession(session.channel_id, session.summary, hist);
      }
   }

   /** One compaction at a time per channel; the watermark only ever advances. */
   private async compactSession(
      channelId: string,
      prevSummary: string | null,
      hist: ChannelHistoryResult,
   ): Promise<void> {
      if (hist.olderNewestMs === null || this.compacting.has(channelId)) return;
      this.compacting.add(channelId);
      try {
         const summary = await compactConversation(prevSummary, hist.older);
         if (!summary) return;
         // The session may have been cleared/closed while we summarized — only
         // store against a still-active session with an older watermark.
         const current = this.deps.store.getSession(channelId);
         if (!current || current.status !== "active") return;
         if ((current.context_cleared_at ?? 0) >= hist.olderNewestMs) return;
         if ((current.summary_covers_until ?? 0) >= hist.olderNewestMs) return;
         this.deps.store.setSummary(channelId, summary, hist.olderNewestMs);
         log.info(
            {
               channelId,
               foldedTurns: hist.older.length,
               summaryChars: summary.length,
            },
            "workshop.compacted",
         );
      } catch (err) {
         log.warn({ err, channelId }, "workshop.compact_error");
      } finally {
         this.compacting.delete(channelId);
      }
   }

   private venvDir(): string | null {
      const dir = join(this.deps.dataDir, "workshop", "venv");
      return existsSync(join(dir, "bin", "python3")) ? dir : null;
   }

   private async saveUploads(
      message: GatewayMessage,
      workspace: SessionWorkspace,
   ): Promise<string[]> {
      const saved: string[] = [];
      for (const att of message.attachments.values()) {
         if (att.size > MAX_UPLOAD_BYTES) {
            await message
               .reply(
                  `⚠️ \`${att.name}\` pesa demasiado (máx ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB) — no lo guardé.`,
               )
               .catch(() => {});
            continue;
         }
         try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60_000);
            const res = await fetch(att.url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const safeName = sanitizeFileName(att.name);
            const relPath = `uploads/${safeName}`;
            workspace.writeBytes(relPath, bytes);
            // The user's message IS the fallback durable copy — the local file is
            // a cache the GC may drop and rehydration restore.
            this.deps.store.recordFile({
               channelId: message.channelId,
               relPath,
               messageId: message.id,
               bytes: bytes.length,
               nowMs: this.now(),
            });
            // MinIO (HDD) is the primary durable copy. Best-effort: a down MinIO
            // leaves storage_key NULL and the Discord carrier keeps working.
            if (this.deps.storage) {
               await uploadToStorage(this.deps.storage, this.deps.store, {
                  channelId: message.channelId,
                  relPath,
                  bytes,
               });
            }
            saved.push(relPath);
         } catch (err) {
            log.warn({ err, file: att.name }, "workshop.upload_save_failed");
         }
      }
      return saved;
   }

   /**
    * Restore manifest files missing from the local cache. MinIO (the HDD) is
    * the primary durable copy; the recorded Discord carrier message is the
    * fallback (message fetch gives a FRESH CDN url — stored urls expire,
    * message ids don't). A record whose message is gone (Unknown Message
    * 10008) is dropped; transient network failures keep the record for the
    * next attempt.
    */
   private async rehydrate(
      session: WorkshopSession,
      workspace: SessionWorkspace,
   ): Promise<void> {
      const manifest = this.deps.store.fileManifest(session.channel_id);
      const missing = manifest.filter((f) => !workspace.exists(f.rel_path));
      if (missing.length === 0) return;
      const channel = await this.deps.client.channels
         .fetch(session.channel_id)
         .catch(() => null);
      for (const f of missing) {
         if (this.deps.storage && f.storage_key) {
            const restored = await restoreFromStorage(
               this.deps.storage,
               workspace,
               f,
            );
            if (restored) {
               log.info(
                  {
                     channelId: session.channel_id,
                     file: f.rel_path,
                     source: "minio",
                  },
                  "workshop.rehydrated",
               );
               continue;
            }
            // Miss/error → fall through to the Discord carrier below.
         }
         if (!channel || !channel.isTextBased()) return;
         try {
            const msg = await channel.messages.fetch(f.message_id);
            const att = [...msg.attachments.values()].find((a) =>
               attachmentNameMatches(a.name, f.rel_path),
            );
            if (!att) {
               this.deps.store.removeFileRecord(session.channel_id, f.rel_path);
               continue;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60_000);
            const res = await fetch(att.url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            workspace.writeBytes(
               f.rel_path,
               new Uint8Array(await res.arrayBuffer()),
            );
            log.info(
               {
                  channelId: session.channel_id,
                  file: f.rel_path,
                  source: "discord",
               },
               "workshop.rehydrated",
            );
         } catch (err) {
            if ((err as { code?: number }).code === 10008) {
               // The carrying message was deleted — the file is truly gone.
               this.deps.store.removeFileRecord(session.channel_id, f.rel_path);
               log.info(
                  { channelId: session.channel_id, file: f.rel_path },
                  "workshop.rehydrate_gone",
               );
            } else {
               log.warn({ err, file: f.rel_path }, "workshop.rehydrate_failed");
            }
         }
      }
   }

   private async sendWorkspaceFile(
      message: GatewayMessage,
      workspace: SessionWorkspace,
      relPath: string,
      caption: string | null,
   ): Promise<void> {
      try {
         const abs = workspace.absolute(relPath);
         const file = new AttachmentBuilder(abs, { name: basename(relPath) });
         if (!message.channel.isSendable()) return;
         const sent = await message.channel.send({
            content: caption ?? undefined,
            files: [file],
         });
         // The channel message is now the fallback durable copy of this
         // deliverable; MinIO (HDD) gets the primary one.
         this.deps.store.recordFile({
            channelId: message.channelId,
            relPath,
            messageId: sent.id,
            bytes: workspace.stat(relPath).bytes,
            nowMs: this.now(),
         });
         if (this.deps.storage) {
            await uploadToStorage(this.deps.storage, this.deps.store, {
               channelId: message.channelId,
               relPath,
               bytes: workspace.readBytes(relPath),
            });
         }
         log.info(
            { channelId: message.channelId, file: relPath },
            "workshop.file_sent",
         );
      } catch (err) {
         log.warn({ err, file: relPath }, "workshop.file_send_failed");
         await message.channel
            .send(`⚠️ No pude subir \`${relPath}\` — inténtalo de nuevo.`)
            .catch(() => {});
      }
   }

   /** One backfill pass at a time (it can fetch from Discord — keep it single). */
   private backfilling = false;

   /**
    * Re-upload manifest files whose PRIMARY (MinIO) copy is missing —
    * `storage_key IS NULL` rows recorded while the object store was down.
    * The canonical producer of those rows is the boot race: this user unit can
    * start before Docker/MinIO at boot, and uploads in that window degrade to
    * Discord-only. Bytes come from the local workspace cache when present,
    * else from the Discord carrier (via rehydrate). Idempotent, best-effort,
    * never throws — run periodically it heals ANY MinIO downtime window
    * without the manual `scripts/migrate-workshop-to-minio.ts` step.
    */
   async storageBackfill(): Promise<number> {
      if (!this.deps.storage || this.backfilling) return 0;
      this.backfilling = true;
      let uploaded = 0;
      try {
         for (const session of this.deps.store.activeSessions()) {
            const pending = this.deps.store
               .fileManifest(session.channel_id)
               .filter((f) => !f.storage_key);
            if (pending.length === 0) continue;
            const workspace = new SessionWorkspace(
               workspaceDirFor(this.deps.dataDir, session.channel_id),
            );
            workspace.ensure();
            if (pending.some((f) => !workspace.exists(f.rel_path))) {
               // Pull GC'd local copies back from their Discord carriers first.
               await this.rehydrate(session, workspace);
            }
            for (const f of pending) {
               // Carrier gone too (record dropped by rehydrate) → nothing to heal.
               if (!workspace.exists(f.rel_path)) continue;
               const ok = await uploadToStorage(
                  this.deps.storage,
                  this.deps.store,
                  {
                     channelId: session.channel_id,
                     relPath: f.rel_path,
                     bytes: workspace.readBytes(f.rel_path),
                  },
               );
               if (ok) uploaded += 1;
            }
         }
      } catch (err) {
         log.warn({ err }, "workshop.storage_backfill_error");
      } finally {
         this.backfilling = false;
      }
      if (uploaded > 0) log.info({ uploaded }, "workshop.storage_backfill");
      return uploaded;
   }

   /** rel_paths the durable manifest records (sent deliverables + user uploads). */
   private deliveredPaths(channelId: string): Set<string> {
      return new Set(
         this.deps.store.fileManifest(channelId).map((f) => f.rel_path),
      );
   }

   /**
    * Attach deliverables this turn created or rewrote that the model forgot to
    * send (and that were never delivered before). Oversized ones are skipped —
    * the ledger will flag them ⚠️ next turn so the model can zip/split them.
    */
   private async autoSendForgottenDeliverables(
      message: GatewayMessage,
      workspace: SessionWorkspace,
      filesBefore: Map<string, number>,
      pendingFiles: Array<{ relPath: string; caption: string | null }>,
   ): Promise<void> {
      const skip = this.deliveredPaths(message.channelId);
      for (const f of pendingFiles) skip.add(f.relPath);
      const forgotten = listUndeliveredDeliverables(
         filesBefore,
         workspace.list(),
         skip,
      ).filter((f) => f.bytes <= MAX_SEND_FILE_BYTES);
      for (const f of forgotten) {
         log.info(
            { channelId: message.channelId, file: f.path },
            "workshop.file_auto_send",
         );
         await this.sendWorkspaceFile(
            message,
            workspace,
            f.path,
            `📎 Esto lo generé en esta vuelta y casi se me pasa adjuntarlo: \`${basename(f.path)}\``,
         );
      }
   }

   private async renameChannel(
      message: GatewayMessage,
      name: string,
   ): Promise<{ ok: boolean; name?: string; error?: string }> {
      try {
         const channel = message.channel;
         if (channel.type !== ChannelType.GuildText)
            return { ok: false, error: "Canal no renombrable." };
         const cleaned = channelNameFor(name, 1).replace(
            new RegExp(`^${CHANNEL_PREFIX}-`),
            "",
         );
         const finalName = `${CHANNEL_PREFIX}-${cleaned || "sesion"}`.slice(
            0,
            90,
         );
         await channel.setName(finalName, "Renombrado desde la sesión");
         return { ok: true, name: finalName };
      } catch (err) {
         return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
         };
      }
   }

   /** Bulk-delete session messages, keeping pins, the panel and `keepId`. */
   private async purgeChannel(
      channel: GatewayMessage["channel"] | null,
      session: WorkshopSession,
      keepId: string | null,
   ): Promise<void> {
      try {
         if (!channel || channel.type !== ChannelType.GuildText) return;
         for (let round = 0; round < 5; round++) {
            const batch = await channel.messages.fetch({ limit: 100 });
            const deletable = batch.filter(
               (m) =>
                  !m.pinned &&
                  m.id !== session.panel_message_id &&
                  m.id !== keepId &&
                  // Messages carrying attachments ARE the session's file storage
                  // (uploads + delivered files) — "limpiar" keeps files, so their
                  // carrier messages survive the purge.
                  m.attachments.size === 0 &&
                  this.now() - m.createdTimestamp < 13 * 24 * 60 * 60 * 1000,
            );
            if (deletable.size === 0) break;
            await channel.bulkDelete(deletable, true);
            if (batch.size < 100) break;
         }
         log.info({ channelId: session.channel_id }, "workshop.channel_purged");
      } catch (err) {
         log.warn(
            { err, channelId: session.channel_id },
            "workshop.purge_failed",
         );
      }
   }

   /**
    * Post the 📁 consolidated files message after a clear (uploads + delivered
    * files), re-point the manifest at it and drop the now-redundant carrier
    * messages. Best-effort: a failure leaves the pre-archive behavior (every
    * carrier message simply survives the purge).
    */
   private async archiveFiles(
      channel: GatewayMessage["channel"] | null,
      session: WorkshopSession,
   ): Promise<void> {
      try {
         if (!channel || channel.type !== ChannelType.GuildText) return;
         const workspace = new SessionWorkspace(
            workspaceDirFor(this.deps.dataDir, session.channel_id),
         );
         workspace.ensure();
         // Restore any GC'd local copies from their carrier messages first.
         await this.rehydrate(session, workspace);
         const stats = await archiveSessionFiles({
            store: this.deps.store,
            workspace,
            channel,
            channelId: session.channel_id,
            nowMs: () => this.now(),
            maxSendBytes: MAX_SEND_FILE_BYTES,
         });
         if (stats.attached > 0 || stats.keptInPlace > 0) {
            log.info(
               { channelId: session.channel_id, ...stats },
               "workshop.files_archived",
            );
         }
      } catch (err) {
         log.warn(
            { err, channelId: session.channel_id },
            "workshop.files_archive_failed",
         );
      }
   }

   /** Goodbye + delete the channel + mark the session closed. */
   async closeSession(
      channelId: string,
      initiator: "tool" | "button" | "admin",
   ): Promise<boolean> {
      const session = this.deps.store.getSession(channelId);
      if (!session || session.status !== "active") return false;
      const channel = await this.deps.client.channels
         .fetch(channelId)
         .catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
         // Channel already gone (manual delete) — just record it.
         this.deps.store.closeSession(channelId, this.now());
         this.deps.onSessionsChanged?.();
         return true;
      }
      await channel
         .send(
            "🔒 Cerrando este taller… ¡nos vemos! El canal se elimina en unos segundos.",
         )
         .catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
      try {
         await channel.delete(
            `Taller cerrado (${initiator}) por ${session.user_tag}`,
         );
         this.deps.store.closeSession(channelId, this.now());
         this.deps.onSessionsChanged?.();
         // The channel (a durable file store) is gone — the manifest, the local
         // cache AND the stored objects go with it (close = "everything is gone"
         // on every store).
         this.deps.store.deleteFileRecords(channelId);
         rmSync(workspaceDirFor(this.deps.dataDir, channelId), {
            recursive: true,
            force: true,
         });
         if (this.deps.storage)
            await deleteSessionObjects(this.deps.storage, channelId);
         log.info({ channelId, initiator }, "workshop.session_closed");
         return true;
      } catch (err) {
         log.error({ err, channelId }, "workshop.close_failed");
         await channel
            .send(
               "⚠️ No pude eliminar el canal (¿me falta el permiso *Gestionar canales*?). Avísale a la moderación.",
            )
            .catch(() => {});
         return false;
      }
   }

   /**
    * Disk garbage collection — MinIO (and Discord as fallback) is the durable
    * store, the Pi is a cache:
    *   - Idle active sessions (>6 h): local files whose durable copy lives in
    *     the manifest are dropped (rehydration restores them on the next turn);
    *     unarchived intermediates get a 48 h TTL (recomputable from the
    *     archived uploads).
    *   - Workspaces of sessions no longer active (closed / channel deleted):
    *     removed entirely — locally, in the manifest, and in object storage.
    * Called hourly by the capability. Never throws.
    */
   async gcSweep(): Promise<{
      filesDeleted: number;
      bytesFreed: number;
      dirsRemoved: number;
   }> {
      const IDLE_MS = 6 * 60 * 60 * 1000;
      const UNARCHIVED_TTL_MS = 48 * 60 * 60 * 1000;
      const now = this.now();
      let filesDeleted = 0;
      let bytesFreed = 0;
      let dirsRemoved = 0;
      try {
         for (const session of this.deps.store.activeSessions()) {
            if (now - session.last_activity_at < IDLE_MS) continue;
            const ws = new SessionWorkspace(
               workspaceDirFor(this.deps.dataDir, session.channel_id),
            );
            const archived = new Set(
               this.deps.store
                  .fileManifest(session.channel_id)
                  .map((f) => f.rel_path),
            );
            for (const f of ws.list()) {
               const droppable =
                  archived.has(f.path) ||
                  now - f.modifiedAt > UNARCHIVED_TTL_MS;
               if (!droppable) continue;
               try {
                  ws.remove(f.path);
                  filesDeleted += 1;
                  bytesFreed += f.bytes;
               } catch {
                  /* stat/unlink race — next sweep */
               }
            }
         }

         const sessionsRoot = join(this.deps.dataDir, "workshop", "sessions");
         if (existsSync(sessionsRoot)) {
            const active = new Set(this.deps.store.activeChannelIds());
            for (const entry of readdirSync(sessionsRoot, {
               withFileTypes: true,
            })) {
               if (!entry.isDirectory() || active.has(entry.name)) continue;
               rmSync(join(sessionsRoot, entry.name), {
                  recursive: true,
                  force: true,
               });
               this.deps.store.deleteFileRecords(entry.name);
               if (this.deps.storage)
                  await deleteSessionObjects(this.deps.storage, entry.name);
               dirsRemoved += 1;
            }
         }
      } catch (err) {
         log.warn({ err }, "workshop.gc_error");
      }
      if (filesDeleted > 0 || dirsRemoved > 0) {
         log.info({ filesDeleted, bytesFreed, dirsRemoved }, "workshop.gc");
      }
      return { filesDeleted, bytesFreed, dirsRemoved };
   }

   /** Bookkeeping when a session channel is deleted by hand. */
   handleChannelDelete(channelId: string): void {
      const session = this.deps.store.getSession(channelId);
      if (session && session.status === "active") {
         this.deps.store.closeSession(channelId, this.now());
         log.info({ channelId }, "workshop.session_closed_externally");
      }
   }

   // ── Buttons ───────────────────────────────────────────────────────────────

   async handleInteraction(interaction: Interaction): Promise<void> {
      try {
         if (!interaction.isButton()) return;
         if (!interaction.customId.startsWith("workshop:")) return;
         const session = this.deps.store.getSession(
            interaction.channelId ?? "",
         );
         if (!session || session.status !== "active") {
            await interaction
               .reply({
                  content: "Esta sesión ya no está activa.",
                  flags: MessageFlags.Ephemeral,
               })
               .catch(() => {});
            return;
         }
         if (!(await this.mayManage(interaction, session))) {
            await interaction
               .reply({
                  content:
                     "Solo quien abrió el taller (o la moderación) puede usar este panel.",
                  flags: MessageFlags.Ephemeral,
               })
               .catch(() => {});
            return;
         }

         switch (interaction.customId) {
            case BTN_CLEAR: {
               await interaction.deferReply().catch(() => {});
               this.deps.store.clearContext(session.channel_id, this.now());
               const hasFiles =
                  this.deps.store.fileManifest(session.channel_id).length > 0;
               const reply = await interaction
                  .followUp(
                     hasFiles
                        ? "🧹 Listo — borrón y cuenta nueva. Tus archivos quedan reunidos en el mensaje 📁 de aquí abajo."
                        : "🧹 Listo — borrón y cuenta nueva.",
                  )
                  .catch(() => null);
               await this.purgeChannel(
                  (interaction.channel as GatewayMessage["channel"] | null) ??
                     null,
                  session,
                  reply?.id ?? null,
               );
               await this.archiveFiles(
                  (interaction.channel as GatewayMessage["channel"] | null) ??
                     null,
                  session,
               );
               break;
            }
            case BTN_CLOSE: {
               await interaction
                  .reply({
                     content:
                        "¿Seguro? Cerrar **elimina este canal** (tus archivos generados dejan de estar disponibles).",
                     components: [confirmButtons()],
                     flags: MessageFlags.Ephemeral,
                  })
                  .catch(() => {});
               break;
            }
            case BTN_CLOSE_CONFIRM: {
               await interaction
                  .update({ content: "🔒 Cerrando…", components: [] })
                  .catch(() => {});
               await this.closeSession(session.channel_id, "button");
               break;
            }
            case BTN_CLOSE_CANCEL: {
               await interaction
                  .update({
                     content: "Cancelado — aquí seguimos. 👍",
                     components: [],
                  })
                  .catch(() => {});
               break;
            }
            default:
               break;
         }
      } catch (err) {
         log.error({ err }, "workshop.interaction.error");
      }
   }

   /** Panel authority: the session owner, or a member who can manage channels. */
   private async mayManage(
      interaction: ButtonInteraction,
      session: WorkshopSession,
   ): Promise<boolean> {
      if (interaction.user.id === session.user_id) return true;
      const guild: Guild | null = interaction.guild;
      if (!guild) return false;
      const member = await guild.members
         .fetch(interaction.user.id)
         .catch(() => null);
      if (!member) return false;
      return (
         member.permissions.has(PermissionFlagsBits.ManageChannels) ||
         member.permissions.has(PermissionFlagsBits.Administrator)
      );
   }
}

function panelButtons(): ActionRowBuilder<ButtonBuilder> {
   return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
         .setCustomId(BTN_CLEAR)
         .setLabel("Limpiar")
         .setEmoji("🧹")
         .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
         .setCustomId(BTN_CLOSE)
         .setLabel("Cerrar")
         .setEmoji("🔒")
         .setStyle(ButtonStyle.Danger),
   );
}

function confirmButtons(): ActionRowBuilder<ButtonBuilder> {
   return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
         .setCustomId(BTN_CLOSE_CONFIRM)
         .setLabel("Sí, cerrar y eliminar")
         .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
         .setCustomId(BTN_CLOSE_CANCEL)
         .setLabel("Cancelar")
         .setStyle(ButtonStyle.Secondary),
   );
}

/** Keep upload names simple and collision-safe-ish. Exported for tests. */
export function sanitizeFileName(name: string): string {
   const cleaned = name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^\.+/, "_");
   // Truncating to 80 chars must not amputate the extension — a PDF landing in
   // the workspace as "libro_2011" (no .pdf) confuses both tools and the model
   // (live 2026-08-06: the Federici book lost its extension to the slice).
   const ext = cleaned.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? "";
   const stem = ext ? cleaned.slice(0, -ext.length) : cleaned;
   const truncated = stem.slice(0, 80 - ext.length) + ext;
   return truncated || "archivo";
}

/**
 * Whether a Discord attachment carries the workspace file `relPath`. Discord
 * NORMALIZES attachment filenames (trailing dots/spaces are stripped as
 * Windows-unsafe), so the carrier's name can differ from the manifest's
 * basename — live: a file recorded as `…primitiva2011.` came back as
 * `…primitiva2011` and rehydration couldn't find its own file. Compare raw,
 * sanitized, and trailing-dot-folded forms.
 */
export function attachmentNameMatches(
   attName: string,
   relPath: string,
): boolean {
   const wanted = basename(relPath);
   const fold = (s: string) => s.replace(/[.\s]+$/, "");
   return (
      attName === wanted ||
      sanitizeFileName(attName) === wanted ||
      fold(attName) === fold(wanted)
   );
}
