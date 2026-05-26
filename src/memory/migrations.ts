import type Database from 'better-sqlite3';

export interface Migration {
  /** Monotonically increasing, starts at 1, unique per capability. */
  version: number;
  /** Idempotent SQL. Use `IF NOT EXISTS` guards. Runs inside a transaction. */
  up: string;
}

const META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    capability TEXT NOT NULL,
    version    INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (capability, version)
  )
`;

export function runMigrations(
  db: Database.Database,
  capabilityId: string,
  migrations: Migration[],
): void {
  db.exec(META_TABLE_DDL);

  const applied = new Set<number>(
    db
      .prepare('SELECT version FROM _migrations WHERE capability = ?')
      .all(capabilityId)
      .map((row) => (row as { version: number }).version),
  );

  const insert = db.prepare(
    'INSERT INTO _migrations (capability, version, applied_at) VALUES (?, ?, ?)',
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      insert.run(capabilityId, m.version, Date.now());
    })();
  }
}
