import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

// Callers resolve the on-disk path (e.g. Electron main via app.getPath('userData'), or a dev/test override) —
// this package stays free of Electron so it also runs under a future Node server (CLAUDE.md §2).
export function createDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  // Mode-isolation hardening (CLAUDE.md §6.8 slice): SQLite does not enforce
  // `references()` foreign keys unless this pragma is on for the connection
  // (it defaults OFF and is NOT persisted in the database file -- it must be
  // set every time a connection opens, same as journal_mode above). Every
  // schema.ts `.references()` (usage_fact/credits_used_fact/control_snapshot/
  // forecast -> snapshot.id; cost_center_member/license/audit_event's
  // dataSnapshotId -> their targets) was previously decorative for
  // referential integrity purposes -- Drizzle still generates the FK
  // constraint in the migration SQL, but nothing enforced it at write time.
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

export function runMigrations(db: Db, migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder });
}
