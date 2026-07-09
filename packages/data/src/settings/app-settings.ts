import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';

// Task 9.3-lite: the app_settings key-value store (migration 0004). First
// consumer: the persisted in-app mode toggle ('app_mode'), which retires the
// COPILOT_BUDGET_FORCE_SIMULATION env-var seam. Plain synchronous reads/
// writes (better-sqlite3), main-process only -- the renderer reaches these
// through the sanctioned ApiClient methods, never directly.

export const APP_MODE_SETTING_KEY = 'app_mode';

export type AppModeSetting = 'simulation' | 'live';

export function getAppSetting(db: Db, key: string): string | null {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).all()[0];
  return row ? row.value : null;
}

export function setAppSetting(db: Db, key: string, value: string): void {
  db.insert(schema.appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } })
    .run();
}

/**
 * The persisted mode SELECTION (what the admin chose in Settings), defaulting
 * to 'simulation' when unset or unrecognized -- the safe default, and the
 * fresh-database behavior. NOTE: this is the SELECTION, not the resolved
 * mode: a 'live' selection with no stored PAT still RESOLVES to simulation
 * (pat/mode.ts's resolveMode), and the Settings card says why.
 */
export function getAppModeSetting(db: Db): AppModeSetting {
  const value = getAppSetting(db, APP_MODE_SETTING_KEY);
  return value === 'live' ? 'live' : 'simulation';
}

export function setAppModeSetting(db: Db, mode: AppModeSetting): void {
  setAppSetting(db, APP_MODE_SETTING_KEY, mode);
}
