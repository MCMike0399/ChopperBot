import type { Client, Message, TextChannel } from 'discord.js';
import { log } from '../../log.js';
import { chunkBotReply } from '../../discord/chunk.js';
import { listImageAttachments } from '../../attachments/resolver.js';
import type { CalendarStore } from '../calendar/store.js';
import type { DiscordEventSyncer } from '../calendar/discord-events.js';
import { EventIntakeStore, type TicketRow } from './store.js';
import {
  renderFlyerRequestCard,
  renderTicketFlyerNotice,
  renderAgitpropFlyerNotice,
} from './flyer-card.js';
import type { ParsedForm } from './parse.js';
import type { ModMentions } from '../../discord/mod-roles.js';
import { shouldNotifyRoles, MOD_PING_COOLDOWN_MS } from '../../discord/mod-roles.js';
import type { FlyerStatus } from './store.js';

function mentionPolicy(roleIds: readonly string[]) {
  return { parse: ['users' as const], roles: [...roleIds], repliedUser: false };
}

export interface FlyerServiceDeps {
  client: Client;
  store: EventIntakeStore;
  calendarStore: CalendarStore;
  getAgitpropChannelId: () => string | null;
  resolveAgitpropMentions: (channel: TextChannel) => Promise<ModMentions>;
  makeSyncer?: (guildId: string) => DiscordEventSyncer | undefined;
  now?: () => number;
}

/**
 * Orchestrates the Agitprop flyer inbox: post/edit request cards, fulfill from
 * image replies, mirror to tickets, and wire the calendar + Discord cover.
 */
export class FlyerService {
  private readonly now: () => number;
  private readonly lastAgitpropPingAt = new Map<string, number>();

  constructor(private readonly deps: FlyerServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Post (or skip if no channel) the Agitprop request card + ticket notice. */
  async openFlyerJob(input: {
    ticketChannelId: string;
    guildId: string;
    parsed: ParsedForm;
    requesterId: string | null;
    notes?: string | null;
    location?: string | null;
  }): Promise<boolean> {
    const channelId = this.deps.getAgitpropChannelId();
    if (!channelId) {
      log.warn({ ticketChannelId: input.ticketChannelId }, 'event_intake.flyer.no_agitprop_channel');
      return false;
    }
    const agitprop = await this.fetchTextChannel(channelId);
    if (!agitprop) return false;

    const card = renderFlyerRequestCard({
      ticketChannelId: input.ticketChannelId,
      requesterId: input.requesterId,
      parsed: input.parsed,
      location: input.location,
      notes: input.notes,
      status: 'requested',
    });
    const mentions = await this.deps.resolveAgitpropMentions(agitprop);
    const body = mentions.text ? `${card}\n\n${mentions.text}` : card;
    const posted = await agitprop
      .send({ content: body, allowedMentions: mentionPolicy(mentions.notifyIds) })
      .catch((err) => {
        log.warn({ err, channelId }, 'event_intake.flyer.request_post_failed');
        return null;
      });
    if (!posted) return false;

    this.deps.store.markFlyerRequested(input.ticketChannelId, posted.id, input.notes ?? null);
    if (mentions.notifyIds.length > 0) {
      this.lastAgitpropPingAt.set(input.ticketChannelId, this.now());
    }
    await this.notifyTicket(input.ticketChannelId, renderTicketFlyerNotice('opened'));
    log.info(
      { ticketChannelId: input.ticketChannelId, requestMessageId: posted.id },
      'event_intake.flyer.requested',
    );
    return true;
  }

  /** Edit the Agitprop card in place (update / cancel / delivered). */
  async editFlyerCard(
    ticket: TicketRow,
    status: FlyerStatus,
    parsed: ParsedForm,
    opts?: { location?: string | null; reping?: boolean },
  ): Promise<void> {
    const requestId = ticket.flyer_request_message_id;
    const channelId = this.deps.getAgitpropChannelId();
    if (!requestId || !channelId) return;

    const card = renderFlyerRequestCard({
      ticketChannelId: ticket.channel_id,
      requesterId: ticket.requester_id,
      parsed,
      location: opts?.location,
      notes: ticket.flyer_notes,
      status,
    });

    try {
      const ch = await this.fetchTextChannel(channelId);
      if (!ch) return;
      const msg = await ch.messages.fetch(requestId);
      let body = card;
      const mentions = opts?.reping ? await this.deps.resolveAgitpropMentions(ch) : null;
      if (mentions?.text && opts?.reping) {
        const notify =
          shouldNotifyRoles(this.lastAgitpropPingAt.get(ticket.channel_id), this.now(), MOD_PING_COOLDOWN_MS);
        if (notify && mentions.notifyIds.length > 0) {
          body = `${card}\n\n${mentions.text}`;
          this.lastAgitpropPingAt.set(ticket.channel_id, this.now());
        }
      }
      await msg.edit({ content: body, allowedMentions: mentionPolicy(mentions?.notifyIds ?? []) });
    } catch (err) {
      log.warn({ err, ticketChannelId: ticket.channel_id }, 'event_intake.flyer.card_edit_failed');
    }
  }

  async cancelFlyerJob(ticketChannelId: string, source: 'ticket' | 'agitprop'): Promise<void> {
    const ticket = this.deps.store.getTicket(ticketChannelId);
    if (!ticket || ticket.flyer_status !== 'requested') return;
    const parsed = EventIntakeStore.parseForm(ticket);
    if (!parsed) return;

    this.deps.store.markFlyerCancelled(ticketChannelId);
    await this.editFlyerCard({ ...ticket, flyer_status: 'cancelled' }, 'cancelled', parsed);

    if (source === 'ticket') {
      await this.notifyAgitprop(renderAgitpropFlyerNotice(ticketChannelId, 'cancelled'));
      await this.notifyTicket(ticketChannelId, renderTicketFlyerNotice('cancelled'));
    } else {
      await this.notifyTicket(ticketChannelId, renderTicketFlyerNotice('cancelled'));
    }
    log.info({ ticketChannelId, source }, 'event_intake.flyer.cancelled');
  }

  async updateFlyerJob(
    ticketChannelId: string,
    notes: string | null,
    source: 'ticket' | 'agitprop',
  ): Promise<void> {
    const ticket = this.deps.store.getTicket(ticketChannelId);
    if (!ticket || ticket.flyer_status !== 'requested') return;
    const parsed = EventIntakeStore.parseForm(ticket);
    if (!parsed) return;

    if (notes !== null) this.deps.store.setFlyerNotes(ticketChannelId, notes);
    const updated = this.deps.store.getTicket(ticketChannelId)!;
    await this.editFlyerCard(updated, 'requested', parsed, { reping: true });

    if (source === 'ticket') {
      await this.notifyAgitprop(renderAgitpropFlyerNotice(ticketChannelId, 'edited'));
      await this.notifyTicket(ticketChannelId, renderTicketFlyerNotice('edited'));
    } else {
      await this.notifyTicket(ticketChannelId, renderTicketFlyerNotice('edited'));
    }
    log.info({ ticketChannelId, source }, 'event_intake.flyer.updated');
  }

  /**
   * Fulfill a flyer job from an image message (Agitprop channel reply or ticket upload).
   */
  async fulfillFlyer(
    ticketChannelId: string,
    imageMessage: Message,
    source: 'agitprop' | 'ticket',
  ): Promise<boolean> {
    const ticket = this.deps.store.getTicket(ticketChannelId);
    if (!ticket || ticket.flyer_status !== 'requested') return false;

    const images = listImageAttachments(imageMessage);
    if (images.length === 0) return false;

    this.deps.store.markFlyerDelivered(ticketChannelId, imageMessage.channelId, imageMessage.id);

    const parsed = EventIntakeStore.parseForm(ticket);
    if (parsed) {
      await this.editFlyerCard({ ...ticket, flyer_status: 'delivered' }, 'delivered', parsed);
    }

    await this.mirrorFlyerToTicket(ticketChannelId, imageMessage);
    await this.applyFlyerToEvent(ticketChannelId, imageMessage);

    await this.notifyTicket(ticketChannelId, renderTicketFlyerNotice('delivered'));
    if (source === 'ticket') {
      await this.notifyAgitprop(renderAgitpropFlyerNotice(ticketChannelId, 'delivered_in_ticket'));
    }

    log.info({ ticketChannelId, source, messageId: imageMessage.id }, 'event_intake.flyer.delivered');
    return true;
  }

  /** Resolve a fresh CDN URL for the stored flyer pointer (ticket row first). */
  async resolveFlyerImageUrl(ticketChannelId: string, eventId?: number | null): Promise<string | null> {
    const ticket = this.deps.store.getTicket(ticketChannelId);
    if (ticket?.flyer_image_channel_id && ticket.flyer_image_message_id) {
      const url = await this.urlFromPointer(ticket.flyer_image_channel_id, ticket.flyer_image_message_id);
      if (url) return url;
    }
    if (eventId) {
      const ev = this.deps.calendarStore.get(eventId);
      if (ev?.flyer_channel_id && ev.flyer_image_message_id) {
        return this.urlFromPointer(ev.flyer_channel_id, ev.flyer_image_message_id);
      }
    }
    return null;
  }

  private async applyFlyerToEvent(ticketChannelId: string, imageMessage: Message): Promise<void> {
    const ticket = this.deps.store.getTicket(ticketChannelId);
    if (!ticket?.created_event_id) return;

    const eventId = ticket.created_event_id;
    this.deps.calendarStore.setFlyerPointer(eventId, imageMessage.channelId, imageMessage.id);

    const url = listImageAttachments(imageMessage)[0]?.url ?? null;
    if (!url || !ticket.guild_id) return;
    const syncer = this.deps.makeSyncer?.(ticket.guild_id);
    if (!syncer) return;
    await syncer.sync(eventId, { imageUrl: url }).catch((err) => {
      log.warn({ err, eventId }, 'event_intake.flyer.discord_cover_failed');
    });
  }

  private async mirrorFlyerToTicket(ticketChannelId: string, imageMessage: Message): Promise<void> {
    const ch = await this.fetchTextChannel(ticketChannelId);
    if (!ch) return;
    const images = listImageAttachments(imageMessage);
    if (images.length === 0) return;
    const image = images[0]!;
    await ch
      .send({
        content: '🎨 **Flyer del evento** (Comisión de Agitprop)',
        files: [{ attachment: image.url, name: image.name ?? 'flyer.png' }],
      })
      .catch((err) => {
        log.warn({ err, ticketChannelId }, 'event_intake.flyer.mirror_failed');
      });
  }

  private async notifyTicket(ticketChannelId: string, text: string): Promise<void> {
    const ch = await this.fetchTextChannel(ticketChannelId);
    if (!ch) return;
    const parts = chunkBotReply(text);
    await ch.send({ content: parts[0], allowedMentions: { parse: [] } }).catch(() => {});
  }

  private async notifyAgitprop(text: string): Promise<void> {
    const channelId = this.deps.getAgitpropChannelId();
    if (!channelId) return;
    const ch = await this.fetchTextChannel(channelId);
    if (!ch) return;
    await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }

  private async urlFromPointer(channelId: string, messageId: string): Promise<string | null> {
    try {
      const ch = await this.fetchTextChannel(channelId);
      if (!ch) return null;
      const msg = await ch.messages.fetch(messageId);
      const images = listImageAttachments(msg);
      return images[0]?.url ?? null;
    } catch {
      return null;
    }
  }

  private async fetchTextChannel(id: string): Promise<TextChannel | null> {
    try {
      const ch = await this.deps.client.channels.fetch(id);
      if (!ch?.isTextBased() || ch.isDMBased()) return null;
      return ch as TextChannel;
    } catch {
      return null;
    }
  }
}
