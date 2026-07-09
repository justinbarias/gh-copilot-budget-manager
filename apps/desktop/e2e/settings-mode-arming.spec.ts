import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

// Task 9.3-lite: the Settings Mode card + Write-arming card, and the mode-aware
// banner, driven through the REAL rendered UI against MSW. Everything here is
// SIMULATION-drivable (no live PAT). Live-mode arming/banner rendering is
// covered by the unit/component tests (github-impl + resolveMode) and the
// validator's interactive CDP pass -- it cannot be driven headless without a
// live PAT, since the app force-resolves simulation without one.

interface Launched {
  app: ElectronApplication;
  window: Page;
  cleanup: () => void;
}

// Each launch boots from an isolated, fresh SQLite DB + userData dir (CLAUDE.md
// §7: known state per launch) -- the MSW world resets to fixtures by
// construction on every process start.
async function launch(): Promise<Launched> {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-mode-arming-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-mode-arming-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });
  const window = await app.firstWindow();
  return {
    app,
    window,
    cleanup: () => {
      rmSync(dbDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function appModeSetting(window: Page): Promise<string> {
  return window.evaluate(() =>
    (window as unknown as { api: { getAppModeSetting(): Promise<string> } }).api.getAppModeSetting(),
  );
}

function armingState(window: Page): Promise<{ armed: boolean; enterpriseSlug: string | null; mode: string }> {
  return window.evaluate(() =>
    (window as unknown as {
      api: { getWriteArmingState(): Promise<{ armed: boolean; enterpriseSlug: string | null; mode: string }> };
    }).api.getWriteArmingState(),
  );
}

test('Settings Mode card persists a selection; arming is inert in simulation; SimBanner shows', async () => {
  const { app, window, cleanup } = await launch();
  try {
    // §6.8: the simulation banner is unmistakable, and no live/armed banner
    // exists in simulation.
    await expect(window.getByText(/SIMULATION MODE/i)).toBeVisible();
    await expect(window.getByText(/writes ARMED/i)).toHaveCount(0);

    await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();

    // --- Mode card ---------------------------------------------------------
    // Fresh DB: resolved mode + persisted selection both simulation, no
    // pending change yet.
    // Task 9.3-lite rework (maintainer feedback): the currently-active
    // segment is disabled + reads "active now"; the other segment is
    // enabled and reads as the action ("Switch to Live"); no pending
    // notice; a quiet next-launch hint instead.
    await expect(window.getByTestId('mode-resolved')).toHaveText('simulation');
    expect(await appModeSetting(window)).toBe('simulation');
    await expect(window.getByTestId('mode-select-simulation')).toBeDisabled();
    await expect(window.getByTestId('mode-select-simulation')).toContainText(/active now/i);
    await expect(window.getByTestId('mode-select-live')).toBeEnabled();
    await expect(window.getByTestId('mode-select-live')).toContainText(/switch to live/i);
    await expect(window.getByTestId('mode-restart-note')).toHaveCount(0);
    await expect(window.getByTestId('mode-quiet-hint')).toHaveText(/next launch/i);

    // Switch the selection to Live -> persisted (getAppModeSetting reflects it),
    // and the card flips into the "pending restart" state.
    await window.getByTestId('mode-select-live').click();
    await expect.poll(() => appModeSetting(window)).toBe('live');
    await expect(window.getByTestId('mode-select-live')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('mode-select-live')).toContainText(/on next start/i);
    await expect(window.getByTestId('mode-select-live')).toBeDisabled();

    // The active-mode segment (Simulation) must stay ENABLED in the pending
    // state -- this is the cancel path, and disabling it would trap the user
    // in a pending change they can't revert.
    await expect(window.getByTestId('mode-select-simulation')).toBeEnabled();
    await expect(window.getByTestId('mode-select-simulation')).toContainText(/active now.*cancel/i);

    // Loud pending notice, naming both modes and "next launch".
    const pendingNote = window.getByTestId('mode-restart-note');
    await expect(pendingNote).toBeVisible();
    await expect(pendingNote).toContainText(/SIMULATION/);
    await expect(pendingNote).toContainText(/LIVE/);
    await expect(pendingNote).toContainText(/next launch/i);
    await expect(window.getByTestId('mode-quiet-hint')).toHaveCount(0);

    // The RUNNING process does NOT re-resolve: still simulation, banner unchanged.
    await expect(window.getByTestId('mode-resolved')).toHaveText('simulation');
    await expect(window.getByText(/SIMULATION MODE/i)).toBeVisible();

    // A live selection with no PAT gets the explanatory note.
    await expect(window.getByTestId('mode-live-no-pat-note')).toBeVisible();

    // Switch back to Simulation (the cancel path) -> persisted, pending notice
    // clears, Simulation is disabled again.
    await window.getByTestId('mode-select-simulation').click();
    await expect.poll(() => appModeSetting(window)).toBe('simulation');
    await expect(window.getByTestId('mode-restart-note')).toHaveCount(0);
    await expect(window.getByTestId('mode-select-simulation')).toBeDisabled();
    await expect(window.getByTestId('mode-select-simulation')).toContainText(/active now/i);

    // --- Write-arming card (inert in simulation) ---------------------------
    await expect(window.getByTestId('arming-sim-note')).toBeVisible();
    // No active arm/disarm controls exist in the inert state.
    await expect(window.getByTestId('arming-arm')).toHaveCount(0);
    await expect(window.getByTestId('arming-disarm')).toHaveCount(0);
    // And the underlying state is unambiguously disarmed + simulation.
    expect(await armingState(window)).toEqual({ armed: false, enterpriseSlug: null, mode: 'simulation' });
  } finally {
    await app.close();
    cleanup();
  }
});
