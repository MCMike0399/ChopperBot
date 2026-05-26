import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migrations.js';

export type { Migration } from './migrations.js';

/**
 * Per-capability persistent storage. Capabilities receive a NamespacedMemory
 * (which fixes the capabilityId on migrate()) but get raw SQL access via db()
 * so they can index, range-scan, and order their own tables.
 *
 * Convention: table names should be prefixed with the capability id
 * (`calendar_events`, `calendar_reminders`, ...). The framework does NOT
 * enforce this — it's a shared-DB cleanliness convention.
 */
export interface MemoryStore {
  /** Raw better-sqlite3 handle. Synchronous. */
  db(): Database.Database;
  /** Apply pending migrations for `capabilityId`. Idempotent. */
  migrate(capabilityId: string, migrations: Migration[]): Promise<void>;
}

export interface SqliteMemoryStoreOptions {
  /** Absolute or relative path to the .db file. Use ':memory:' for tests. */
  path: string;
}

/** Process-level SQLite store. One file, shared across all capabilities. */
export class SqliteMemoryStore implements MemoryStore {
  private readonly handle: Database.Database;

  constructor(opts: SqliteMemoryStoreOptions) {
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.handle = new Database(opts.path);
    this.handle.pragma('journal_mode = WAL');
    this.handle.pragma('foreign_keys = ON');
  }

  db(): Database.Database {
    return this.handle;
  }

  async migrate(capabilityId: string, migrations: Migration[]): Promise<void> {
    runMigrations(this.handle, capabilityId, migrations);
  }

  close(): void {
    this.handle.close();
  }
}

/**
 * A view of a shared `SqliteMemoryStore` for one capability. Forwards `db()`
 * to the shared handle (capabilities own their table namespace by prefix
 * convention) and fixes the capabilityId on `migrate()` so a capability
 * cannot accidentally migrate another's tables.
 */
export class NamespacedMemory implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly capabilityId: string,
  ) {}

  db(): Database.Database {
    return this.inner.db();
  }

  migrate(_ignored: string, migrations: Migration[]): Promise<void> {
    return this.inner.migrate(this.capabilityId, migrations);
  }
}
