import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// This is the thin cross-boundary gate (CLAUDE.md §6.7): does a renderer call
// actually cross preload -> IPC -> main -> MSW -> back with the right shape?
// Transform/aggregation correctness (usage summing, ranking) is already
// covered by packages/data's vitest suite against the same MSW server —
// not re-tested here.
test('ApiClient round-trips through preload -> main -> MSW -> back', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-db-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    // Isolated per-run DB path (CLAUDE.md §7: each launch boots from a known
    // state) -- without this override, syncNow-touching specs would read/write
    // the real per-OS userData dir and accumulate rows across e2e runs.
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Simulation is forced by default (main/mode.ts) whenever no PAT is
    // stored, so this never needs a real GitHub token or network access.
    const mode = await window.evaluate(() => (window as unknown as { api: { getMode(): Promise<string> } }).api.getMode());
    expect(mode).toBe('simulation');

    const summary = await window.evaluate(() =>
      (window as unknown as { api: { getUsageSummary(): Promise<{ totalQuantity: number }> } }).api.getUsageSummary(),
    );
    expect(summary.totalQuantity).toBeGreaterThan(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
