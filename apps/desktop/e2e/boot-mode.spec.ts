import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// PLAN.md Task 3.1 gap-fill: SPEC.md's Testing Strategy bullet "App boots
// into simulation mode by default (no PAT stored)" had no spec asserting
// both facts together against a guaranteed-fresh profile in one place.
// api-client.spec.ts already asserts getMode() === 'simulation' very early,
// and settings.spec.ts already asserts the Settings screen's initial "No PAT
// stored yet" text -- but neither isolates Electron's userData directory
// (only the sqlite DB path is isolated per-test via COPILOT_BUDGET_DB_PATH;
// pat-bridge.ts's PatStore always resolves against the real
// app.getPath('userData')), so "no PAT stored" was true only by accident of
// run order/history on a given machine, not by construction. This spec
// passes --user-data-dir explicitly (a built-in Electron/Chromium switch) so
// a truly first-run profile is the guaranteed starting condition, then pins
// hasPat/getMode/the banner together as CLAUDE.md §7 requires ("mode is
// queryable via IPC").
test('a fresh profile (no prior userData) boots into simulation mode: no PAT stored, banner visible, mode queryable via window.api', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-boot-db-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-boot-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Queryable via the preload bridge (CLAUDE.md §7), not just visible text:
    // a genuinely fresh profile has no PAT, and the mode resolver (Task 1.4)
    // reports 'simulation'.
    const hasPat = await window.evaluate(() =>
      (window as unknown as { api: { hasPat(): Promise<boolean> } }).api.hasPat(),
    );
    expect(hasPat).toBe(false);

    const mode = await window.evaluate(() =>
      (window as unknown as { api: { getMode(): Promise<string> } }).api.getMode(),
    );
    expect(mode).toBe('simulation');

    // Unmistakable on first paint (CLAUDE.md §6.8), before any navigation --
    // this is the default/landing screen, not something reached by clicking in.
    await expect(window.getByText(/simulation mode/i)).toBeVisible();

    // The Settings screen corroborates the same fact through its own UI text
    // (the surface a real admin would check first), not just the bridge call.
    await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();
    await expect(window.getByText(/no pat stored/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
