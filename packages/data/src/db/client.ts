import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

// Callers resolve the on-disk path (e.g. Electron main via app.getPath('userData'), or a dev/test override) —
// this package stays free of Electron so it also runs under a future Node server (CLAUDE.md §2).
export function createDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  return drizzle(sqlite, { schema });
}

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

export function runMigrations(db: Db, migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder });
}
