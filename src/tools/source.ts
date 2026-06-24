export interface ToolHandlerResult {
  status: 'success' | 'error';
  /** JSON-serializable payload returned to the model as a tool_result. */
  payload: unknown;
}

/**
 * Provider-neutral tool spec emitted by each ToolSource. The LLM client is the
 * only place that knows how to wrap this into its provider's tool format
 * (Bedrock Converse: `{ toolSpec: { name, description, inputSchema: { json } } }`).
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

/**
 * A ToolSource contributes a self-contained set of tools to the agent loop:
 * a system-prompt blurb that tells the model what this source can do, plus
 * a list of tool specs and a handler. Examples: a markdown corpus exposes
 * `search_knowledge`/`read_topic`; a GitHub integration exposes `gh_*` tools.
 */
export interface ToolSource {
  /** Stable id, used in logs. */
  readonly name: string;
  /** Markdown blurb rendered into the system prompt at boot. */
  systemPromptSection(): Promise<string>;
  /** Tool specs this source contributes (provider-neutral). */
  tools(): ToolSpec[];
  /** Run a tool by name. Caller guarantees the tool is registered by this source. */
  handle(toolName: string, input: unknown): Promise<ToolHandlerResult>;
}

export interface ComposedTools {
  tools: ToolSpec[];
  handle(name: string, input: unknown): Promise<ToolHandlerResult>;
}

/**
 * Merge multiple ToolSources into the single { tools, handle } shape that
 * the agent loop consumes. Detects tool-name collisions at boot so a
 * misconfiguration fails fast.
 */
export function composeToolSources(sources: ToolSource[]): ComposedTools {
  const byTool = new Map<string, ToolSource>();
  const allTools: ToolSpec[] = [];

  for (const src of sources) {
    for (const t of src.tools()) {
      if (!t.name) {
        throw new Error(`ToolSource "${src.name}" produced a tool with no name`);
      }
      if (byTool.has(t.name)) {
        const owner = byTool.get(t.name)!;
        throw new Error(
          `Tool name collision: "${t.name}" registered by both "${owner.name}" and "${src.name}"`,
        );
      }
      byTool.set(t.name, src);
      allTools.push(t);
    }
  }

  return {
    tools: allTools,
    async handle(name, input) {
      const src = byTool.get(name);
      if (!src) {
        return { status: 'error', payload: { error: `Unknown tool: ${name}` } };
      }
      return src.handle(name, input);
    },
  };
}
