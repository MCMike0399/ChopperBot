import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { runPython, sandboxAvailable } from './sandbox.js';
import { PathEscapeError, type SessionWorkspace } from './workspace.js';

/** Discord bot upload cap we enforce for workshop file sends (bytes). */
export const MAX_SEND_FILE_BYTES = 9_500_000;
/** Output beyond this is cut before reaching the model (context budget). */
const MODEL_OUTPUT_CAP = 6_000;
const DEFAULT_READ_BYTES = 6_000;
/** Hard ceiling for a single read, however much the model asks for. */
const MAX_READ_BYTES = 20_000;
/**
 * Total characters of tool payload one turn may pull into the conversation.
 *
 * Why (live 2026-08-06): asked to explain a 5.4 MB book chapter by chapter, the
 * model read chapter files at 16k chars each until the request hit **147k input
 * tokens** — and at that size Kimi lost the tool-call protocol and started
 * posting its own scaffolding to Discord. Past this budget, read tools refuse
 * and tell the model to summarize with Python instead (a file it writes costs
 * nothing in context), which is the workflow the prompt asks for anyway.
 */
export const TURN_PAYLOAD_BUDGET_CHARS = 45_000;

/**
 * Deferred/side-effectful session operations the WATCHER executes (the tool
 * layer stays free of discord.js). Send/clear/close are recorded as intents
 * and performed AFTER the agent loop returns its reply — deleting messages or
 * the channel mid-loop would break the reply itself.
 */
export interface SessionActions {
  /** Queue a workspace file to be uploaded to the channel after the reply. */
  queueSendFile(relPath: string, caption: string | null): void;
  /** Purge the channel's messages after the reply (context already cleared). */
  queueClear(): void;
  /** Close the session: goodbye + channel deletion after the reply. */
  queueClose(): void;
  /** Rename the session channel (immediate — safe mid-loop). */
  renameChannel(name: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  /** Mark context cleared as-of now (synchronous, store-backed). */
  clearContextNow(): void;
}

export interface WorkshopToolDeps {
  workspace: SessionWorkspace;
  actions: SessionActions;
  venvDir: string | null;
  maxTimeoutMs: number;
  /**
   * rel_paths with a durable DELIVERED copy (the manifest: sent deliverables +
   * user uploads). The model uses this ledger to know what the user actually
   * received — live 2026-08-09 it insisted "ya te lo envié" about files that
   * had never left the workspace.
   */
  deliveredPaths: () => Set<string>;
}

/** Trim tool output for the model, keeping head + tail (errors live at the tail). */
export function capOutput(text: string, cap = MODEL_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.7));
  const tail = text.slice(-Math.floor(cap * 0.25));
  return `${head}\n… [salida recortada] …\n${tail}`;
}

export class WorkshopToolSource implements ToolSource {
  readonly name = 'workshop';
  /** Characters of payload already returned to the model THIS turn. */
  private payloadChars = 0;

  constructor(private readonly deps: WorkshopToolDeps) {}

  /** Charge a payload against the turn budget; true if it still fits. */
  private budgetAllows(cost: number): boolean {
    return this.payloadChars + cost <= TURN_PAYLOAD_BUDGET_CHARS;
  }

  private charge(cost: number): void {
    this.payloadChars += cost;
  }

  private budgetExceededResult(what: string): ToolHandlerResult {
    return {
      status: 'error',
      payload: {
        error:
          `Se agotó el presupuesto de contexto de esta vuelta (ya leíste ~${Math.round(this.payloadChars / 1000)}k caracteres), así que no puedo devolverte ${what}. ` +
          'NO sigas leyendo archivos completos: procésalos con workshop_run_python (resume, extrae o escribe el entregable directamente desde el script) e imprime solo lo indispensable.',
      },
    };
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'workshop_run_python',
        description:
          'Ejecuta código Python 3.11 en un sandbox aislado (sin red, sin acceso fuera del workspace). ' +
          'El directorio de trabajo es el workspace de la sesión: los archivos que escribas ahí persisten entre ejecuciones y puedes mandarlos al chat con workshop_send_file. ' +
          'Librerías disponibles: openpyxl, python-docx, python-pptx, reportlab, matplotlib, numpy, pandas, pillow, pypdf, pdfplumber (+ stdlib, y los CLIs pdftotext/pdfinfo de poppler). ' +
          'stdout/stderr se devuelven (recortados si son muy largos). Imprime lo que necesites ver.',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'El script Python completo a ejecutar.' },
            timeout_s: {
              type: 'number',
              description: `Tiempo máximo en segundos (por defecto 30, tope ${Math.floor(this.deps.maxTimeoutMs / 1000)}).`,
            },
          },
          required: ['code'],
        },
      },
      {
        name: 'workshop_write_file',
        description:
          'Escribe un archivo de TEXTO en el workspace de la sesión (rutas relativas; crea carpetas intermedias). Para binarios (xlsx/docx/png) genera el archivo con workshop_run_python.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta relativa dentro del workspace, p. ej. "notas.md".' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'workshop_read_file',
        description:
          'Lee un archivo de texto del workspace (recortado si es grande). Para inspeccionar cosas puntuales, no para cargar textos largos: ' +
          'hay un presupuesto de contexto por vuelta, así que si necesitas trabajar un documento extenso, procésalo con workshop_run_python en vez de leerlo aquí.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            max_bytes: {
              type: 'number',
              description: `Por defecto ${DEFAULT_READ_BYTES}, máximo ${MAX_READ_BYTES}.`,
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'workshop_list_files',
        description:
          'Lista los archivos del workspace de la sesión (ruta, tamaño, fecha) y si cada uno YA FUE ENTREGADO al usuario. ' +
          'Úsala para verificar antes de afirmar que algo fue enviado, o cuando el usuario diga que no le llegó un archivo.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'workshop_send_file',
        description:
          'Sube un archivo del workspace al chat de Discord (máx ~9.5 MB) para que el usuario lo descargue. Úsalo SIEMPRE que generes un entregable (xlsx, docx, pptx, pdf, png…). El archivo se adjunta junto a tu respuesta.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta relativa dentro del workspace.' },
            caption: { type: 'string', description: 'Texto breve opcional que acompaña al archivo.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'workshop_rename_session',
        description:
          'Renombra el canal de esta sesión (p. ej. al tema en el que están trabajando). Nombre corto, minúsculas.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Nuevo nombre del canal.' } },
          required: ['name'],
        },
      },
      {
        name: 'workshop_clear_session',
        description:
          'Limpia la sesión: olvida todo el contexto de la conversación y borra los mensajes del canal (los archivos se conservan: quedan reunidos en un mensaje 📁 del canal). Úsalo cuando el usuario pida "limpiar", "borrar el chat", "empezar de cero".',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'workshop_close_session',
        description:
          'Cierra la sesión y ELIMINA este canal de Discord. Irreversible. Llama SOLO con confirm=true y solo después de que el usuario haya confirmado explícitamente que quiere cerrar.',
        inputSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', description: 'Debe ser true; confirma primero con el usuario.' },
          },
          required: ['confirm'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const obj = (input ?? {}) as Record<string, unknown>;
    try {
      switch (toolName) {
        case 'workshop_run_python':
          return await this.handleRunPython(obj);
        case 'workshop_write_file': {
          const path = String(obj.path ?? '');
          const content = String(obj.content ?? '');
          this.deps.workspace.writeText(path, content);
          return { status: 'success', payload: { written: path, bytes: Buffer.byteLength(content, 'utf-8') } };
        }
        case 'workshop_read_file': {
          const path = String(obj.path ?? '');
          const maxBytes = clampInt(obj.max_bytes, 1, MAX_READ_BYTES, DEFAULT_READ_BYTES);
          if (!this.deps.workspace.exists(path)) {
            return { status: 'error', payload: { error: `No existe: ${path}` } };
          }
          if (!this.budgetAllows(maxBytes)) return this.budgetExceededResult(`el contenido de ${path}`);
          const res = this.deps.workspace.readText(path, maxBytes);
          this.charge(res.content.length);
          return {
            status: 'success',
            payload: {
              path,
              bytes: res.bytes,
              truncated: res.truncated,
              content: res.content,
              ...(res.truncated
                ? { note: 'Archivo recortado. Para trabajar el texto completo, procésalo con Python en vez de leerlo por partes.' }
                : {}),
            },
          };
        }
        case 'workshop_list_files': {
          const delivered = this.deps.deliveredPaths();
          const files = this.deps.workspace.list().map((f) => {
            const isUpload = f.path.startsWith('uploads/');
            return {
              path: f.path,
              bytes: f.bytes,
              modified_iso: new Date(f.modifiedAt).toISOString(),
              tipo: isUpload ? ('subida_del_usuario' as const) : ('generado' as const),
              // Uploads reached the chat by definition (the user attached them);
              // generated files only count as delivered once recorded on send.
              entregado: isUpload || delivered.has(f.path),
            };
          });
          const undelivered = files.filter((f) => !f.entregado).map((f) => f.path);
          return {
            status: 'success',
            payload: {
              files,
              count: files.length,
              pendientes_de_entrega: undelivered,
              ...(undelivered.length > 0
                ? {
                    note:
                      'Los archivos con entregado=false existen SOLO en el workspace: el usuario NO los ha recibido. ' +
                      'Si son entregables (o el usuario dice que no le llegaron), envíalos ahora con workshop_send_file. ' +
                          'Nunca afirmes que un archivo fue enviado si aquí dice entregado=false.',
                  }
                : {}),
            },
          };
        }
        case 'workshop_send_file': {
          const path = String(obj.path ?? '');
          if (!this.deps.workspace.exists(path)) {
            return { status: 'error', payload: { error: `No existe: ${path}. Usa workshop_list_files.` } };
          }
          const { bytes } = this.deps.workspace.stat(path);
          if (bytes > MAX_SEND_FILE_BYTES) {
            return {
              status: 'error',
              payload: { error: `El archivo pesa ${bytes} bytes; el máximo para Discord es ~9.5 MB. Compréndelo (zip) o divídelo.` },
            };
          }
          const caption = typeof obj.caption === 'string' ? obj.caption : null;
          this.deps.actions.queueSendFile(path, caption);
          return {
            status: 'success',
            payload: { queued: path, bytes, note: 'Se adjuntará al canal junto con tu respuesta.' },
          };
        }
        case 'workshop_rename_session': {
          const name = String(obj.name ?? '').trim();
          if (!name) return { status: 'error', payload: { error: 'Falta el nombre.' } };
          const res = await this.deps.actions.renameChannel(name);
          return res.ok
            ? { status: 'success', payload: { renamed_to: res.name } }
            : { status: 'error', payload: { error: res.error ?? 'No pude renombrar el canal.' } };
        }
        case 'workshop_clear_session': {
          this.deps.actions.clearContextNow();
          this.deps.actions.queueClear();
          return {
            status: 'success',
            payload: {
              cleared: true,
              note: 'Contexto olvidado; los mensajes del canal se borrarán tras esta respuesta y los archivos quedarán reunidos en un mensaje 📁.',
            },
          };
        }
        case 'workshop_close_session': {
          if (obj.confirm !== true) {
            return {
              status: 'error',
              payload: { error: 'Confirma primero con el usuario y vuelve a llamar con confirm=true. Cerrar elimina el canal.' },
            };
          }
          this.deps.actions.queueClose();
          return {
            status: 'success',
            payload: { closing: true, note: 'El canal se despedirá y se eliminará unos segundos después de tu respuesta.' },
          };
        }
        default:
          return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
      }
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return { status: 'error', payload: { error: 'Ruta inválida: usa rutas relativas dentro del workspace.' } };
      }
      log.warn({ tool: toolName, err }, 'workshop.tool_failed');
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async handleRunPython(obj: Record<string, unknown>): Promise<ToolHandlerResult> {
    const code = String(obj.code ?? '');
    if (!code.trim()) return { status: 'error', payload: { error: 'Falta el código.' } };
    if (!sandboxAvailable()) {
      return {
        status: 'error',
        payload: { error: 'La ejecución de código no está disponible en este host (falta bubblewrap).' },
      };
    }
    const timeoutMs = clampInt(obj.timeout_s, 1, Math.floor(this.deps.maxTimeoutMs / 1000), 30) * 1000;

    this.deps.workspace.ensure();
    const before = new Map(this.deps.workspace.list().map((f) => [f.path, f.modifiedAt]));
    const result = await runPython(code, {
      workspaceDir: this.deps.workspace.root,
      venvDir: this.deps.venvDir,
      timeoutMs,
    });
    const after = this.deps.workspace.list();
    const changed = after
      .filter((f) => before.get(f.path) !== f.modifiedAt)
      .map((f) => ({ path: f.path, bytes: f.bytes }));

    log.info(
      {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        filesChanged: changed.length,
      },
      'workshop.python_run',
    );
    const stdout = capOutput(result.stdout);
    const stderr = capOutput(result.stderr);
    this.charge(stdout.length + stderr.length);
    return {
      status: result.exitCode === 0 && !result.timedOut ? 'success' : 'error',
      payload: {
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        stdout,
        stderr,
        files_changed: changed,
        ...(result.timedOut
          ? { note: `Se agotó el tiempo (${Math.floor(timeoutMs / 1000)}s). Divide el trabajo o sube timeout_s.` }
          : {}),
      },
    };
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
