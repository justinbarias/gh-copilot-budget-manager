import path from 'node:path';
import { app } from 'electron';
import { createDb, runMigrations, type Db } from '@copilot-budget/data/db';

let db: Db | undefined;

// Dev/test override (CLAUDE.md §3 Task 1.2 note): Playwright e2e and any
// manual verification run must not read/write the real per-OS userData dir,
// or repeated runs would accumulate snapshot/dimension rows across launches
// and break the "each app launch boots from a known state" rule (CLAUDE.md §7).
export function getDb(): Db {
  if (!db) {
    const dbPath = process.env.COPILOT_BUDGET_DB_PATH ?? path.join(app.getPath('userData'), 'copilot-budget.sqlite');
    db = createDb(dbPath);
    runMigrations(db);
  }
  return db;
}
