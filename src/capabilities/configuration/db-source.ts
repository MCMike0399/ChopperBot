import type Database from 'better-sqlite3';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import type { ConfigurationStore } from './store.js';

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/i;
const MAX_QUERY_ROWS = 200;
/** Leading keywords allowed for ad-hoc SQL — read-only verbs only. */
const READ_ONLY_LEADERS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA', 'VALUES']);

export interface ConfigDbSourceDeps {
  db: Database.Database;
  store: ConfigurationStore;
}

/**
 * Read-only DB window for the config console: list/describe tables and run
 * ad-hoc SELECTs to answer questions about application state.
 *
 * SAFETY: this is the one place we hand Kimi raw SQL, so writes are blocked by
 * defense-in-depth — (1) a leading-keyword allowlist, (2) a ban on assignment
 * PRAGMAs, and (3) better-sqlite3's `statement.readonly` flag (true iff the
 * statement makes no changes). We execute on the shared handle (not a separate
 * read-only connection) because that handle is the source of truth — a second
 * connection would not see an in-memory test DB and is unnecessary once the
 * statement is proven read-only before execution.
 */
export class ConfigDbSource implements ToolSource {
  readonly name = 'config_db';

  constructor(private readonly deps: ConfigDbSourceDeps) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_db',
        description:
          'Read-only window into chopperbot.db for understanding application state. `action`:\n' +
          '• "list_tables" — every user table with row count.\n' +
          '• "describe_schema" {table?} — column definitions + CREATE SQL for one table, or the CREATE SQL of every table when omitted. Use this to learn the schema before querying.\n' +
          '• "inspect_table" {name, limit?} — first N raw rows of a table (≤100).\n' +
          '• "migrations" — applied migration versions per capability.\n' +
          '• "query" {sql, params?} — run a READ-ONLY SQL query. SELECT / WITH / EXPLAIN / read-only PRAGMA only; any write (INSERT/UPDATE/DELETE/DDL/assignment PRAGMA) is rejected. Use ? placeholders and pass `params` for values. Returns up to 200 rows.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list_tables', 'describe_schema', 'inspect_table', 'migrations', 'query'],
            },
            table: { type: 'string', description: 'For "describe_schema" (omit for all tables).' },
            name: { type: 'string', description: 'Table name for "inspect_table".' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'For "inspect_table".' },
            sql: { type: 'string', description: 'Read-only SQL for "query".' },
            params: {
              type: 'array',
              description: 'Optional positional bind values for ? placeholders in "query".',
              items: {},
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_db') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      const action = asAction(obj.action, [
        'list_tables',
        'describe_schema',
        'inspect_table',
        'migrations',
        'query',
      ]);
      switch (action) {
        case 'list_tables':
          return { status: 'success', payload: { tables: this.deps.store.listTables() } };
        case 'migrations':
          return { status: 'success', payload: { migrations: this.deps.store.migrationStatus() } };
        case 'inspect_table': {
          const name = asNonEmptyString(obj.name, 'name');
          const limit = clampInt(obj.limit, 1, 100, 20);
          const rows = this.deps.store.inspectTable(name, limit);
          return { status: 'success', payload: { table: name, limit, rows } };
        }
        case 'describe_schema':
          return this.handleDescribeSchema(obj);
        case 'query':
          return this.handleQuery(obj, t0);
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return {
        status: 'error',
        payload: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private handleDescribeSchema(obj: Record<string, unknown>): ToolHandlerResult {
    if (obj.table !== undefined && obj.table !== null && obj.table !== '') {
      const name = asNonEmptyString(obj.table, 'table');
      if (!SAFE_NAME.test(name)) throw new Error(`table: "${name}" is not a valid identifier`);
      const createRow = this.deps.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) as { sql: string } | undefined;
      if (!createRow) return { status: 'error', payload: { error: `Table "${name}" does not exist.` } };
      const columns = (
        this.deps.db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((c) => ({ name: c.name, type: c.type, not_null: c.notnull === 1, primary_key: c.pk > 0 }));
      return { status: 'success', payload: { table: name, columns, sql: createRow.sql } };
    }
    const tables = this.deps.db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>;
    return { status: 'success', payload: { tables } };
  }

  private handleQuery(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const sql = asNonEmptyString(obj.sql, 'sql');
    const params = parseParams(obj.params);

    const leader = sql.replace(/^\s+/, '').split(/[\s(;]/, 1)[0]?.toUpperCase() ?? '';
    if (!READ_ONLY_LEADERS.has(leader)) {
      log.warn({ tool: 'config_db.query', rejected: 'leader', leader }, 'config_db.query_rejected');
      return {
        status: 'error',
        payload: {
          error: `Refusing query starting with "${leader}". Read-only only: ${[...READ_ONLY_LEADERS].join(', ')}.`,
        },
      };
    }
    // Block assignment PRAGMAs (e.g. `PRAGMA journal_mode = DELETE`) which can
    // change DB behavior even though they touch no rows.
    if (leader === 'PRAGMA' && sql.includes('=')) {
      log.warn({ tool: 'config_db.query', rejected: 'assignment_pragma' }, 'config_db.query_rejected');
      return { status: 'error', payload: { error: 'Assignment PRAGMAs are not allowed (read-only).' } };
    }

    let stmt: Database.Statement;
    try {
      stmt = this.deps.db.prepare(sql);
    } catch (err) {
      // better-sqlite3 throws on syntax errors and on multiple statements.
      log.warn({ tool: 'config_db.query', rejected: 'prepare_failed' }, 'config_db.query_rejected');
      return {
        status: 'error',
        payload: { error: `Could not prepare query (one statement only): ${err instanceof Error ? err.message : String(err)}` },
      };
    }
    if (!stmt.readonly) {
      log.warn({ tool: 'config_db.query', rejected: 'not_readonly' }, 'config_db.query_rejected');
      return {
        status: 'error',
        payload: { error: 'Query rejected: it writes to the database. This tool is read-only.' },
      };
    }

    const allRows = stmt.all(...params) as unknown[];
    const truncated = allRows.length > MAX_QUERY_ROWS;
    const rows = truncated ? allRows.slice(0, MAX_QUERY_ROWS) : allRows;
    log.info(
      { tool: 'config_db.query', returned: rows.length, truncated, ms: Date.now() - t0 },
      'tool_call',
    );
    return { status: 'success', payload: { row_count: rows.length, truncated, rows } };
  }
}

function parseParams(v: unknown): Array<string | number | bigint | Buffer | null> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error('params: must be an array of bind values');
  return v.map((p, i) => {
    if (p === null) return null;
    if (typeof p === 'string' || typeof p === 'number' || typeof p === 'bigint') return p;
    throw new Error(`params[${i}]: bind values must be string, number, bigint, or null`);
  });
}

function asAction<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`action: must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field}: must be a non-empty string`);
  return v.trim();
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
