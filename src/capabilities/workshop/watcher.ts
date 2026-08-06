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
} from 'discord.js';

/** The Message shape the MessageCreate gateway event actually delivers. */
type GatewayMessage = OmitPartialGroupDMChannel<Message>;
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { log } from '../../log.js';
import { ask, TurnAbortedError } from '../../llm/client.js';
import { chunkBotReply } from '../../discord/chunk.js';
import { normalizeTurns, type Turn } from '../../discord/history.js';
import { StatusReactor } from '../../discord/status-reactions.js';
import { QueueBusyError, type TurnQueue } from '../../discord/turn-queue.js';
import { QUEUE_BUSY_REPLY, GENERIC_ERROR_REPLY } from '../../discord/handlers.js';
import { resolveAttachments } from '../../attachments/resolver.js';
import { composeToolSources } from '../../tools/source.js';
import type { WorkshopStore, WorkshopSession } from './store.js';
import { SessionWorkspace, workspaceDirFor } from './workspace.js';
import { WorkshopToolSource, type SessionActions } from './tools.js';
import { sandboxAvailable } from './sandbox.js';
import { buildChannelHistory } from './history.js';
import { renderPanelContent, renderSessionIntro, renderWorkshopPrompt } from './preamble.js';

/** Uploaded user files larger than this are not saved to the workspace. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** How the user-visible channel names start. */
const CHANNEL_PREFIX = 'taller';

const BTN_CLEAR = 'workshop:clear';
const BTN_CLOSE = 'workshop:close';
const BTN_CLOSE_CONFIRM = 'workshop:close_confirm';
const BTN_CLOSE_CANCEL = 'workshop:close_cancel';

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
  now?: () => number;
}

/** Sanitize a Discord username into a channel-name segment. Exported for tests. */
export function channelNameFor(userTag: string, sessionNumber: number): string {
  const base = userTag
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  const suffix = sessionNumber > 1 ? `-${sessionNumber}` : '';
  return `${CHANNEL_PREFIX}-${base || 'sesion'}${suffix}`;
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

  constructor(private readonly deps: WorkshopWatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ── Welcome message ───────────────────────────────────────────────────────

  /** Make sure the reaction target exists in the welcome channel. */
  async ensureWelcomeMessage(): Promise<void> {
    const settings = this.deps.store.getSettings();
    if (!settings.welcome_channel_id) {
      log.info('workshop.welcome.not_configured');
      return;
    }
    const channel = await this.deps.client.channels
      .fetch(settings.welcome_channel_id)
      .catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      log.warn({ channelId: settings.welcome_channel_id }, 'workshop.welcome.channel_unavailable');
      return;
    }
    const emoji = this.deps.reactionEmoji();

    if (settings.welcome_message_id) {
      const existing = await channel.messages
        .fetch(settings.welcome_message_id)
        .catch(() => null);
      if (existing) {
        // Re-add our own reaction if it got cleared (it's the visible button).
        if (!existing.reactions.cache.get(emoji)?.me) {
          await existing.react(emoji).catch(() => {});
        }
        return;
      }
      log.warn({ messageId: settings.welcome_message_id }, 'workshop.welcome.message_missing_reposting');
    }

    const posted = await channel
      .send(
        `## 🎓 Talleres de escuela y trabajo\n` +
          `Reacciona con ${emoji} a este mensaje y te abro un **canal privado** (solo tú y la moderación lo ven) con un asistente de IA completo para tu escuela o tu chamba:\n` +
          `- Crea **Excel, Word, PowerPoint y gráficas** de verdad, listas para descargar\n` +
          `- Ejecuta **código Python** y analiza los datos o archivos que le subas\n` +
          `- Explica temas, revisa ensayos, prepara exámenes, arma CVs\n\n` +
          `Cuando termines, cierras tu taller desde su panel y listo. 🚀`,
      )
      .catch((err) => {
        log.error({ err }, 'workshop.welcome.post_failed');
        return null;
      });
    if (!posted) return;
    await posted.react(emoji).catch(() => {});
    this.deps.store.setWelcomeMessageId(posted.id);
    log.info({ messageId: posted.id }, 'workshop.welcome.posted');
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

      const emojiName = reaction.emoji.name ?? '';
      if (emojiName !== this.deps.reactionEmoji()) return;

      const fullUser = user.partial ? await user.fetch().catch(() => null) : user;
      if (!fullUser || fullUser.bot) return;

      if (this.creating.has(fullUser.id)) return;
      this.creating.add(fullUser.id);
      try {
        await this.createSessionFor(reaction, fullUser, settings.category_id);
      } finally {
        this.creating.delete(fullUser.id);
      }
    } catch (err) {
      log.error({ err }, 'workshop.reaction.error');
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
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
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
      log.error({ err, categoryId, user: user.tag }, 'workshop.channel_create_failed');
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
    log.info({ channelId: channel.id, user: user.tag }, 'workshop.session_created');
  }

  private async notifyLimit(user: User, active: WorkshopSession[]): Promise<void> {
    const links = active.map((s) => `<#${s.channel_id}>`).join(', ');
    const text =
      `Ya tienes ${active.length} taller(es) abierto(s): ${links}. ` +
      'Cierra alguno desde su panel (🔒) para abrir uno nuevo.';
    const dm = await user.send(text).catch(() => null);
    if (dm) return;
    // DMs closed → short-lived notice in the welcome channel.
    const settings = this.deps.store.getSettings();
    if (!settings.welcome_channel_id) return;
    const channel = await this.deps.client.channels
      .fetch(settings.welcome_channel_id)
      .catch(() => null);
    if (!channel || !channel.isSendable()) return;
    const notice = await channel.send(`<@${user.id}> ${text}`).catch(() => null);
    if (notice) setTimeout(() => void notice.delete().catch(() => {}), 20_000);
  }

  // ── Session chat ──────────────────────────────────────────────────────────

  async handleMessage(message: GatewayMessage): Promise<void> {
    try {
      if (message.author?.bot) return;
      const session = this.deps.store.getSession(message.channelId);
      if (!session || session.status !== 'active') return;

      const userText = (message.content ?? '').trim();
      const hasAttachments = message.attachments.size > 0;
      if (!userText && !hasAttachments) return;

      this.deps.store.touchActivity(message.channelId, this.now());
      const reactor = new StatusReactor(message, this.deps.client.user?.id);

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
          () => this.runTurn(message, session, reactor, abortFlag),
          { onQueued: () => reactor.set('queued') },
        );
      } catch (err) {
        if (err instanceof TurnAbortedError) {
          // Superseded by a newer message — clean up silently; the newer
          // turn owns the conversation now.
          reactor.resolve();
          log.info({ channelId: message.channelId }, 'workshop.turn_interrupted');
          return;
        }
        reactor.fail();
        if (err instanceof QueueBusyError) {
          await message.reply(QUEUE_BUSY_REPLY).catch(() => {});
          return;
        }
        log.error({ err, channelId: message.channelId }, 'workshop.turn_failed');
        await message.reply(GENERIC_ERROR_REPLY).catch(() => {});
      } finally {
        if (this.turnAborts.get(message.channelId) === abortFlag) {
          this.turnAborts.delete(message.channelId);
        }
      }
    } catch (err) {
      log.error({ err }, 'workshop.message.error');
    }
  }

  private async runTurn(
    message: GatewayMessage,
    session: WorkshopSession,
    reactor: StatusReactor,
    abortFlag: { aborted: boolean },
  ): Promise<void> {
    // Interrupted while still waiting in the queue → don't even start.
    if (abortFlag.aborted) throw new TurnAbortedError();
    reactor.set('thinking');
    await message.channel.sendTyping().catch(() => {});
    const heartbeat = setInterval(() => void message.channel.sendTyping().catch(() => {}), 8000);

    const workspace = new SessionWorkspace(workspaceDirFor(this.deps.dataDir, session.channel_id));
    workspace.ensure();

    // Save EVERY attachment into the workspace (python can process them);
    // images additionally ride the turn for vision.
    const savedUploads = await this.saveUploads(message, workspace);

    // Deferred side effects the tools may request (executed after the reply).
    const pendingFiles: Array<{ relPath: string; caption: string | null }> = [];
    let pendingClear = false;
    let pendingClose = false;
    const actions: SessionActions = {
      queueSendFile: (relPath, caption) => void pendingFiles.push({ relPath, caption }),
      queueClear: () => void (pendingClear = true),
      queueClose: () => void (pendingClose = true),
      clearContextNow: () => this.deps.store.clearContext(session.channel_id, this.now()),
      renameChannel: async (name) => this.renameChannel(message, name),
    };

    let reply: string;
    try {
      const skipIds = new Set<string>();
      if (session.panel_message_id) skipIds.add(session.panel_message_id);
      const history = await buildChannelHistory(this.deps.client, message, {
        sinceMs: session.context_cleared_at,
        skipIds,
      });
      const attachments = await resolveAttachments(message);
      const text =
        (message.content ?? '').trim() ||
        (savedUploads.length > 0 ? `Te subí: ${savedUploads.join(', ')}` : '…');
      const turns: Turn[] = normalizeTurns([...history, { role: 'user', content: text, attachments }]);

      const venvDir = this.venvDir();
      const tools = composeToolSources([
        new WorkshopToolSource({
          workspace,
          actions,
          venvDir,
          maxTimeoutMs: this.deps.pyTimeoutMs,
        }),
      ]);
      const system = renderWorkshopPrompt({
        now: new Date(this.now()),
        userTag: session.user_tag,
        userId: session.user_id,
        channelName: 'name' in message.channel ? ((message.channel.name as string | null) ?? null) : null,
        files: workspace.list(),
        sandboxAvailable: sandboxAvailable(),
        venvAvailable: venvDir !== null,
        savedUploads,
      });

      log.info(
        {
          channelId: session.channel_id,
          user: session.user_tag,
          len: text.length,
          historyTurns: history.length,
          uploads: savedUploads.length,
        },
        'workshop.turn',
      );
      reply = await ask({
        system,
        messages: turns,
        tools,
        onPhase: (phase) => reactor.set(phase),
        shouldAbort: () => abortFlag.aborted,
      });
    } finally {
      clearInterval(heartbeat);
    }

    // Interrupted after the loop finished but before posting: discard — the
    // newer turn answers with full context (web-LLM interrupt semantics).
    if (abortFlag.aborted) throw new TurnAbortedError();

    const parts = chunkBotReply(reply);
    let anchor: Message | null = await message.reply(parts[0]).catch(() => null);
    if (!anchor && message.channel.isSendable()) {
      anchor = await message.channel.send(parts[0]).catch(() => null);
    }
    reactor.resolve();
    for (let i = 1; anchor && i < parts.length; i++) {
      anchor = await anchor
        .reply({ content: parts[i], allowedMentions: { repliedUser: false } })
        .catch(() => null);
    }

    // Deferred effects, in a safe order: files → purge → close.
    for (const f of pendingFiles) {
      await this.sendWorkspaceFile(message, workspace, f.relPath, f.caption);
    }
    if (pendingClear) {
      await this.purgeChannel(message.channel, session, anchor?.id ?? null);
    }
    if (pendingClose) {
      await this.closeSession(session.channel_id, 'tool');
    }
  }

  private venvDir(): string | null {
    const dir = join(this.deps.dataDir, 'workshop', 'venv');
    return existsSync(join(dir, 'bin', 'python3')) ? dir : null;
  }

  private async saveUploads(message: GatewayMessage, workspace: SessionWorkspace): Promise<string[]> {
    const saved: string[] = [];
    for (const att of message.attachments.values()) {
      if (att.size > MAX_UPLOAD_BYTES) {
        await message
          .reply(`⚠️ \`${att.name}\` pesa demasiado (máx ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB) — no lo guardé.`)
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
        saved.push(relPath);
      } catch (err) {
        log.warn({ err, file: att.name }, 'workshop.upload_save_failed');
      }
    }
    return saved;
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
      await message.channel.send({ content: caption ?? undefined, files: [file] });
      log.info({ channelId: message.channelId, file: relPath }, 'workshop.file_sent');
    } catch (err) {
      log.warn({ err, file: relPath }, 'workshop.file_send_failed');
      await message.channel
        .send(`⚠️ No pude subir \`${relPath}\` — inténtalo de nuevo.`)
        .catch(() => {});
    }
  }

  private async renameChannel(
    message: GatewayMessage,
    name: string,
  ): Promise<{ ok: boolean; name?: string; error?: string }> {
    try {
      const channel = message.channel;
      if (channel.type !== ChannelType.GuildText) return { ok: false, error: 'Canal no renombrable.' };
      const cleaned = channelNameFor(name, 1).replace(new RegExp(`^${CHANNEL_PREFIX}-`), '');
      const finalName = `${CHANNEL_PREFIX}-${cleaned || 'sesion'}`.slice(0, 90);
      await channel.setName(finalName, 'Renombrado desde la sesión');
      return { ok: true, name: finalName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Bulk-delete session messages, keeping pins, the panel and `keepId`. */
  private async purgeChannel(
    channel: GatewayMessage['channel'] | null,
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
            this.now() - m.createdTimestamp < 13 * 24 * 60 * 60 * 1000,
        );
        if (deletable.size === 0) break;
        await channel.bulkDelete(deletable, true);
        if (batch.size < 100) break;
      }
      log.info({ channelId: session.channel_id }, 'workshop.channel_purged');
    } catch (err) {
      log.warn({ err, channelId: session.channel_id }, 'workshop.purge_failed');
    }
  }

  /** Goodbye + delete the channel + mark the session closed. */
  async closeSession(channelId: string, initiator: 'tool' | 'button' | 'admin'): Promise<boolean> {
    const session = this.deps.store.getSession(channelId);
    if (!session || session.status !== 'active') return false;
    const channel = await this.deps.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      // Channel already gone (manual delete) — just record it.
      this.deps.store.closeSession(channelId, this.now());
      this.deps.onSessionsChanged?.();
      return true;
    }
    await channel
      .send('🔒 Cerrando este taller… ¡nos vemos! El canal se elimina en unos segundos.')
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 5000));
    try {
      await channel.delete(`Taller cerrado (${initiator}) por ${session.user_tag}`);
      this.deps.store.closeSession(channelId, this.now());
      this.deps.onSessionsChanged?.();
      log.info({ channelId, initiator }, 'workshop.session_closed');
      return true;
    } catch (err) {
      log.error({ err, channelId }, 'workshop.close_failed');
      await channel
        .send('⚠️ No pude eliminar el canal (¿me falta el permiso *Gestionar canales*?). Avísale a la moderación.')
        .catch(() => {});
      return false;
    }
  }

  /** Bookkeeping when a session channel is deleted by hand. */
  handleChannelDelete(channelId: string): void {
    const session = this.deps.store.getSession(channelId);
    if (session && session.status === 'active') {
      this.deps.store.closeSession(channelId, this.now());
      log.info({ channelId }, 'workshop.session_closed_externally');
    }
  }

  // ── Buttons ───────────────────────────────────────────────────────────────

  async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith('workshop:')) return;
      const session = this.deps.store.getSession(interaction.channelId ?? '');
      if (!session || session.status !== 'active') {
        await interaction
          .reply({ content: 'Esta sesión ya no está activa.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return;
      }
      if (!(await this.mayManage(interaction, session))) {
        await interaction
          .reply({
            content: 'Solo quien abrió el taller (o la moderación) puede usar este panel.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }

      switch (interaction.customId) {
        case BTN_CLEAR: {
          await interaction.deferReply().catch(() => {});
          this.deps.store.clearContext(session.channel_id, this.now());
          const reply = await interaction
            .followUp('🧹 Listo — borrón y cuenta nueva. (Tus archivos del workspace siguen ahí.)')
            .catch(() => null);
          await this.purgeChannel(
            (interaction.channel as GatewayMessage['channel'] | null) ?? null,
            session,
            reply?.id ?? null,
          );
          break;
        }
        case BTN_CLOSE: {
          await interaction
            .reply({
              content: '¿Seguro? Cerrar **elimina este canal** (tus archivos generados dejan de estar disponibles).',
              components: [confirmButtons()],
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          break;
        }
        case BTN_CLOSE_CONFIRM: {
          await interaction
            .update({ content: '🔒 Cerrando…', components: [] })
            .catch(() => {});
          await this.closeSession(session.channel_id, 'button');
          break;
        }
        case BTN_CLOSE_CANCEL: {
          await interaction
            .update({ content: 'Cancelado — aquí seguimos. 👍', components: [] })
            .catch(() => {});
          break;
        }
        default:
          break;
      }
    } catch (err) {
      log.error({ err }, 'workshop.interaction.error');
    }
  }

  /** Panel authority: the session owner, or a member who can manage channels. */
  private async mayManage(interaction: ButtonInteraction, session: WorkshopSession): Promise<boolean> {
    if (interaction.user.id === session.user_id) return true;
    const guild: Guild | null = interaction.guild;
    if (!guild) return false;
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return false;
    return (
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member.permissions.has(PermissionFlagsBits.Administrator)
    );
  }
}

function panelButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BTN_CLEAR).setLabel('Limpiar').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BTN_CLOSE).setLabel('Cerrar').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
}

function confirmButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BTN_CLOSE_CONFIRM).setLabel('Sí, cerrar y eliminar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(BTN_CLOSE_CANCEL).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );
}

/** Keep upload names simple and collision-safe-ish. Exported for tests. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80);
  return cleaned || 'archivo';
}

