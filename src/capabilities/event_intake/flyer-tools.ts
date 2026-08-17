import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import type { EventIntakeStore, TicketRow } from './store.js';
import { EventIntakeStore as StoreClass } from './store.js';
import type { ParsedForm } from './parse.js';

export interface FlyerToolDeps {
  store: EventIntakeStore;
  ticketChannelId: string;
  /**
   * Called after a tool mutation so the watcher can post/edit cards.
   * For `request`, return whether the Agitprop job actually opened — the tool
   * must not report success when the card never landed.
   */
  onFlyerAction?: (
    action: 'request' | 'update' | 'cancel',
    notes?: string | null,
  ) => Promise<boolean>;
}

/**
 * Flyer job tools for staff and Agitprop in tickets and the Agitprop channel.
 * Does NOT touch the calendar — only the flyer request lifecycle.
 */
export class FlyerToolSource implements ToolSource {
  readonly name = 'event_intake_flyer';

  constructor(private readonly deps: FlyerToolDeps) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'flyer_request',
        description:
          'Abre (o reabre) una solicitud de flyer a la Comisión de Agitprop para ESTE ticket. ' +
          'Úsalo cuando haga falta diseño aunque el formulario diga que el solicitante lo haría, ' +
          'o para volver a pedirlo tras una cancelación.',
        inputSchema: {
          type: 'object',
          properties: {
            notes: {
              type: 'string',
              description: 'Notas opcionales para Agitprop (tema visual, texto obligatorio, etc.).',
            },
          },
        },
      },
      {
        name: 'flyer_update',
        description:
          'Actualiza las notas o detalles de la solicitud de flyer abierta en Agitprop para este ticket.',
        inputSchema: {
          type: 'object',
          properties: {
            notes: {
              type: 'string',
              description: 'Nuevas notas para Agitprop (reemplaza las anteriores si se pasan).',
            },
          },
        },
      },
      {
        name: 'flyer_cancel',
        description: 'Cancela la solicitud de flyer abierta en Agitprop para este ticket.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const ticket = this.deps.store.getTicket(this.deps.ticketChannelId);
    if (!ticket) {
      return { status: 'error', payload: { error: 'No hay ticket registrado para este canal.' } };
    }
    const parsed = StoreClass.parseForm(ticket);
    if (!parsed) {
      return { status: 'error', payload: { error: 'No pude leer el formulario de este ticket.' } };
    }

    const obj = (input ?? {}) as Record<string, unknown>;

    switch (toolName) {
      case 'flyer_request':
        return this.handleRequest(ticket, parsed, obj.notes);
      case 'flyer_update':
        return this.handleUpdate(ticket, obj.notes);
      case 'flyer_cancel':
        return this.handleCancel(ticket);
      default:
        return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
  }

  private async handleRequest(
    ticket: TicketRow,
    parsed: ParsedForm,
    notesRaw: unknown,
  ): Promise<ToolHandlerResult> {
    if (ticket.flyer_status === 'requested') {
      return {
        status: 'success',
        payload: {
          message: 'Ya hay una solicitud de flyer abierta en Agitprop.',
          flyer_status: ticket.flyer_status,
        },
      };
    }
    const notes = typeof notesRaw === 'string' ? notesRaw.trim() || null : null;
    if (notes) this.deps.store.setFlyerNotes(ticket.channel_id, notes);
    const opened = (await this.deps.onFlyerAction?.('request', notes)) === true;
    if (!opened) {
      const current = this.deps.store.getTicket(ticket.channel_id);
      return {
        status: 'error',
        payload: {
          error:
            'No pude abrir la solicitud de flyer en Agitprop. Revisa que el canal esté configurado y que pueda publicar ahí.',
          flyer_status: current?.flyer_status ?? ticket.flyer_status,
        },
      };
    }
    return {
      status: 'success',
      payload: {
        message: 'Solicitud de flyer enviada a Agitprop.',
        flyer_status: 'requested',
        title: parsed.title,
      },
    };
  }

  private async handleUpdate(ticket: TicketRow, notesRaw: unknown): Promise<ToolHandlerResult> {
    if (ticket.flyer_status !== 'requested') {
      return {
        status: 'error',
        payload: {
          error: 'No hay una solicitud de flyer abierta que actualizar.',
          flyer_status: ticket.flyer_status,
        },
      };
    }
    const notes = typeof notesRaw === 'string' ? notesRaw.trim() || null : null;
    if (notes !== null) this.deps.store.setFlyerNotes(ticket.channel_id, notes);
    await this.deps.onFlyerAction?.('update', notes);
    return {
      status: 'success',
      payload: { message: 'Solicitud de flyer actualizada en Agitprop.', flyer_status: 'requested' },
    };
  }

  private async handleCancel(ticket: TicketRow): Promise<ToolHandlerResult> {
    if (ticket.flyer_status !== 'requested') {
      return {
        status: 'error',
        payload: {
          error: 'No hay una solicitud de flyer abierta que cancelar.',
          flyer_status: ticket.flyer_status,
        },
      };
    }
    await this.deps.onFlyerAction?.('cancel');
    return {
      status: 'success',
      payload: { message: 'Solicitud de flyer cancelada.', flyer_status: 'cancelled' },
    };
  }
}
