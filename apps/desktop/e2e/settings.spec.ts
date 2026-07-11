import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

async function getMode(window: Page): Promise<string> {
  return window.evaluate(() => (window as unknown as { api: { getMode(): Promise<string> } }).api.getMode());
}

// This is the first spec that drives actual rendered UI (Task 1.7), rather
// than calling window.api directly -- the sim banner and Settings screen are
// real DOM, so Playwright locators exercise them the way a human would.
test('Sim banner is always visible and Settings drives PAT + Sync Now', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-settings-'));
  // Isolate Electron's userData dir too (not just the sqlite DB path): the
  // "No PAT stored yet" precondition below is otherwise only true by
  // accident of run order/history on a given machine, since pat-bridge.ts's
  // PatStore always resolves against the real app.getPath('userData') --
  // see PLAN.md Task 3.1 / boot-mode.spec.ts's fuller explanation.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-settings-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // CLAUDE.md §6.8: unmistakable, persistent -- always on for MVP.
    await expect(window.getByText(/simulation mode/i)).toBeVisible();

    // Navigate to the Settings screen via the Task 2.5 nav shell.
    await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();

    // No PAT stored yet.
    await expect(window.getByText(/no pat stored/i)).toBeVisible();

    await window.getByLabel(/personal access token/i).fill('ghp_e2eSentinelToken123');
    await window.getByRole('button', { name: /save token/i }).click();
    await expect(window.getByText(/pat stored/i)).toBeVisible();

    // SPEC.md's "PAT capture round-trip + toggling the sim/live banner"
    // bullet, read literally, implies a live-mode switch -- but MVP has no
    // such toggle (SPEC.md Assumption 2, Task 1.4's mode.ts: simulation is
    // forced regardless of PAT presence until a real tenant/toggle exists).
    // Assert what the app actually does instead of fabricating one: mode
    // stays 'simulation' and the banner stays unmistakable even with a PAT
    // stored -- a real admin must never be able to mistake this for live.
    expect(await getMode(window)).toBe('simulation');
    await expect(window.getByText(/simulation mode/i)).toBeVisible();

    await window.getByRole('button', { name: /clear token/i }).click();
    await expect(window.getByText(/no pat stored/i)).toBeVisible();

    // Same guarantee holds after clearing.
    expect(await getMode(window)).toBe('simulation');
    await expect(window.getByText(/simulation mode/i)).toBeVisible();

    // Sync Now moved out of Settings into the GLOBAL nav-footer affordance
    // (data-testid nav-sync-button), visible on every screen. The detail line
    // reads "Never synced" until a sync runs, then a compact "Synced <day>"
    // with the full "Last synced: …" text carried in the row's title attribute.
    await expect(window.getByTestId('nav-sync-detail')).toHaveText(/never synced/i);
    await window.getByTestId('nav-sync-button').click();
    // On completion the global app-shell toast confirms the refresh app-wide
    // (role="status", generic text -- no token/login detail per §6.6, auto-
    // dismisses ~3.8s). Assert it BEFORE the compact detail so we catch it
    // inside its dwell window.
    await expect(window.getByRole('status').filter({ hasText: 'Sync complete — data refreshed' })).toBeVisible();
    await expect(window.getByTestId('nav-sync-detail')).toHaveAttribute('title', /last synced:/i);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
