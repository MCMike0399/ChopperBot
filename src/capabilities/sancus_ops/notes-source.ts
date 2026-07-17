import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import type { SancusOpsNote, SancusOpsStore } from './store.js';

export interface NotesToolSourceDeps {
  store: SancusOpsStore;
  channelId: string;
  userId: string;
  nowMs: number;
}

const MAX_NOTE_LEN = 2000;
const DEFAULT_RECALL = 10;
const MAX_RECALL = 30;

/**
 * Recall memory for the sancus_ops copilot: `remember` persists an operator
 * note/finding scoped to THIS channel; `recall` searches/lists them. Backed by
 * the `sancus_ops_notes` table via the capability migration system.
 */
export class SancusOpsNotesToolSource implements ToolSource {
  readonly name = 'sancus_ops_notes';

  constructor(private readonly deps: NotesToolSourceDeps) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'remember',
        description:
          'Guarda una nota u observación operativa (un hallazgo, la causa raíz de un incidente, un dato a recordar) en la memoria de ESTE canal para consultarla después. Úsala cuando el usuario diga "recuerda que…", "anota…", "guarda esto", o cuando descubras algo que valga la pena persistir entre conversaciones.',
        inputSchema: {
          type: 'object',
          properties: {
            note: { type: 'string', minLength: 1, maxLength: MAX_NOTE_LEN, description: 'El texto de la nota a guardar.' },
            tags: {
              type: 'string',
              description: 'Etiquetas opcionales separadas por espacios o comas (p. ej. "dock qa incidente") para facilitar la búsqueda después.',
            },
          },
          required: ['note'],
          additionalProperties: false,
        },
      },
      {
        name: 'recall',
        description:
          'Recupera notas guardadas en ESTE canal. Sin `query` devuelve las más recientes; con `query` busca por texto o etiqueta (coincidencia de subcadena, sin distinguir mayúsculas). Úsala cuando el usuario pregunte "¿qué habíamos anotado sobre…?", "¿qué recuerdas de…?", o para tener contexto antes de responder.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto o etiqueta a buscar. Omítelo para ver las notas más recientes.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_RECALL, description: `Máximo de notas a devolver (default ${DEFAULT_RECALL}, máx ${MAX_RECALL}).` },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'forget',
        description:
          'Elimina una nota guardada de ESTE canal por su id (el que muestra `recall`). Úsala solo cuando el usuario pida explícitamente borrar u olvidar una nota.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'El id de la nota a eliminar (visible en la salida de `recall`).' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      switch (toolName) {
        case 'remember': {
          const note = asNonEmptyString(obj.note, 'note').slice(0, MAX_NOTE_LEN);
          const tags = normalizeTags(obj.tags);
          const saved = this.deps.store.addNote({
            channel_id: this.deps.channelId,
            note,
            tags,
            created_by: this.deps.userId,
            now_ms: this.deps.nowMs,
          });
          log.info({ tool: toolName, id: saved.id }, 'sancus_ops.remember');
          return { status: 'success', payload: { saved: serializeNote(saved) } };
        }
        case 'recall': {
          const query = typeof obj.query === 'string' ? obj.query : '';
          const limit = clampInt(obj.limit, 1, MAX_RECALL, DEFAULT_RECALL);
          const rows = this.deps.store.searchNotes(this.deps.channelId, query, limit);
          return {
            status: 'success',
            payload: { count: rows.length, notes: rows.map(serializeNote) },
          };
        }
        case 'forget': {
          const id = Number(obj.id);
          if (!Number.isInteger(id) || id <= 0) {
            return { status: 'error', payload: { error: 'id debe ser un entero positivo (el que muestra recall).' } };
          }
          const removed = this.deps.store.deleteNote(this.deps.channelId, id);
          if (!removed) {
            return { status: 'error', payload: { error: `No hay nota con id ${id} en este canal.` } };
          }
          return { status: 'success', payload: { removed_id: id } };
        }
        default:
          return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'sancus_ops.notes_tool_failed');
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
}

function serializeNote(n: SancusOpsNote) {
  return {
    id: n.id,
    note: n.note,
    tags: n.tags,
    created_by: n.created_by,
    created_at_iso: new Date(n.created_at).toISOString(),
  };
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${field}: cadena no vacía requerida`);
  }
  return v.trim();
}

function normalizeTags(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const tags = v
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return tags.length > 0 ? tags.join(' ') : null;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
