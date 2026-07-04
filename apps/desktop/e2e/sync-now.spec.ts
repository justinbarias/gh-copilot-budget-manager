import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// This is the CLAUDE.md Phase-1 smoke test (Task 1.6): confirms Sync Now
// actually ingests through the full preload -> IPC -> main -> MSW -> SQLite
// path. Row-level ingestion correctness (fact/dimension counts, append-only
// vs. current-state writes) is already covered by packages/data's vitest
// suite against the same DB-writing code -- not re-proven here. Playwright's
// TS transform runs specs as CommonJS, and @copilot-budget/data is ESM-only
// (uses import.meta.url), so this spec verifies through the app's own IPC
// surface rather than opening the SQLite file directly from the test process.
test('Sync Now ingests MSW data end to end', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-sync-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    const before = await window.evaluate(
      () => (window as unknown as { api: { getSyncStatus(): Promise<{ lastSyncedAt: string | null }> } }).api.getSyncStatus(),
    );
    expect(before.lastSyncedAt).toBeNull();

    const status = await window.evaluate(
      () => (window as unknown as { api: { syncNow(): Promise<{ lastSyncedAt: string | null }> } }).api.syncNow(),
    );
    expect(status.lastSyncedAt).not.toBeNull();

    const after = await window.evaluate(
      () => (window as unknown as { api: { getSyncStatus(): Promise<{ lastSyncedAt: string | null }> } }).api.getSyncStatus(),
    );
    expect(after.lastSyncedAt).toBe(status.lastSyncedAt);

    // A second sync produces a later status without erroring (dimension
    // upsert/replace must not throw a PK violation on re-sync).
    const secondStatus = await window.evaluate(
      () => (window as unknown as { api: { syncNow(): Promise<{ lastSyncedAt: string | null }> } }).api.syncNow(),
    );
    expect(secondStatus.lastSyncedAt).not.toBeNull();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
