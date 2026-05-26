import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';
import { CONFIGURATION_CAPABILITY_ID, CONFIGURATION_CHANNEL_ID } from './constants.js';

export interface ConfigurationBinding {
  channel_id: string;
  capability_id: string;
  updated_at: number;
  updated_by: string | null;
}

export interface TableSummary {
  name: string;
  row_count: number;
}

export interface MigrationRow {
  capability: string;
  version: number;
  applied_at: number;
}

export interface PurgeResult {
  tables_affected: Array<{ table: string; rows_deleted: number }>;
  rows_deleted: number;
}

export const CONFIGURATION_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS configuration_bindings (
        channel_id    TEXT    NOT NULL PRIMARY KEY,
        capability_id TEXT    NOT NULL,
        updated_at    INTEGER NOT NULL,
        updated_by    TEXT
      );
    `,
  },
];

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/i;
const INSPECT_HARD_CAP = 100;

export class ConfigurationStore {
  constructor(private readonly db: Database.Database) {}

  list(): ConfigurationBinding[] {
    return this.db
      .prepare(
        `SELECT channel_id, capability_id, updated_at, updated_by
           FROM configuration_bindings
          ORDER BY updated_at DESC`,
      )
      .all() as ConfigurationBinding[];
  }

  get(channelId: string): ConfigurationBinding | null {
    const row = this.db
      .prepare(
        `SELECT channel_id, capability_id, updated_at, updated_by
           FROM configuration_bindings
          WHERE channel_id = ?`,
      )
      .get(channelId);
    return (row as ConfigurationBinding | undefined) ?? null;
  }

  upsert(channelId: string, capabilityId: string, updatedBy: string | null): void {
    this.db
      .prepare(
        `INSERT INTO configuration_bindings (channel_id, capability_id, updated_at, updated_by)
              VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
              capability_id = excluded.capability_id,
              updated_at    = excluded.updated_at,
              updated_by    = excluded.updated_by`,
      )
      .run(channelId, capabilityId, Date.now(), updatedBy);
  }

  remove(channelId: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM configuration_bindings WHERE channel_id = ?`)
      .run(channelId);
    return info.changes > 0;
  }

  /**
   * Build the channel→capability map used to seed the router at boot.
   *
   * Order of precedence:
   *   1. Existing DB rows are the source of truth.
   *   2. If the DB table is empty AND `envSeed` has entries, copy the env map
   *      into the DB once (with updated_by = 'env-seed'). This is the
   *      one-time migration path from DISCORD_CHANNEL_CAPABILITIES.
   *   3. Always force-bind CONFIGURATION_CHANNEL_ID → 'configuration' so the
   *      admin channel keeps working no matter what's in the DB.
   */
  loadBootBindings(envSeed: Map<string, string>): Map<string, string> {
    const existing = this.list();
    if (existing.length === 0 && envSeed.size > 0) {
      const tx = this.db.transaction(() => {
        for (const [channelId, capabilityId] of envSeed) {
          this.upsert(channelId, capabilityId, 'env-seed');
        }
      });
      tx();
    }

    this.upsert(CONFIGURATION_CHANNEL_ID, CONFIGURATION_CAPABILITY_ID, 'bootstrap');

    const map = new Map<string, string>();
    for (const row of this.list()) {
      map.set(row.channel_id, row.capability_id);
    }
    return map;
  }

  listTables(): TableSummary[] {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => ({
      name: r.name,
      row_count: this.countRows(r.name),
    }));
  }

  inspectTable(name: string, limit: number): Array<Record<string, unknown>> {
    if (!SAFE_NAME.test(name)) {
      throw new Error(`Invalid table name "${name}"`);
    }
    const exists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    if (!exists) {
      throw new Error(`Table "${name}" not found`);
    }
    const clamped = Math.max(1, Math.min(INSPECT_HARD_CAP, Math.floor(limit)));
    return this.db.prepare(`SELECT * FROM ${name} LIMIT ?`).all(clamped) as Array<
      Record<string, unknown>
    >;
  }

  migrationStatus(): MigrationRow[] {
    return this.db
      .prepare(
        `SELECT capability, version, applied_at
           FROM _migrations
          ORDER BY capability, version`,
      )
      .all() as MigrationRow[];
  }

  tableHasColumn(table: string, column: string): boolean {
    if (!SAFE_NAME.test(table) || !SAFE_NAME.test(column)) return false;
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  }

  /**
   * Capability-agnostic channel-data purge. Finds every table whose name
   * starts with `<capability>_`, restricted to those that actually carry a
   * `channel_id` column, and deletes rows matching `channelId`. Refuses to
   * touch the configuration_* namespace.
   */
  purgeChannelData(capability: string, channelId: string): PurgeResult {
    if (!SAFE_NAME.test(capability)) {
      throw new Error(`Invalid capability id "${capability}"`);
    }
    if (capability === CONFIGURATION_CAPABILITY_ID) {
      throw new Error('Refusing to purge configuration_* tables');
    }
    const prefix = `${capability}_`;
    const candidates = this.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name LIKE ?
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all(`${prefix}%`) as Array<{ name: string }>;

    const result: PurgeResult = { tables_affected: [], rows_deleted: 0 };
    const tx = this.db.transaction(() => {
      for (const { name } of candidates) {
        if (!this.tableHasColumn(name, 'channel_id')) continue;
        const info = this.db
          .prepare(`DELETE FROM ${name} WHERE channel_id = ?`)
          .run(channelId);
        if (info.changes > 0) {
          result.tables_affected.push({ table: name, rows_deleted: info.changes });
          result.rows_deleted += info.changes;
        }
      }
    });
    tx();
    return result;
  }

  private countRows(name: string): number {
    if (!SAFE_NAME.test(name)) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM ${name}`).get() as { n: number };
    return row.n;
  }
}
