import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

// ============================================================================
// Task 6.7 -- the sim-mode scenario selector, parameterized across all four
// demo states. Boots on the DEFAULT ('healthy' == the byte-identical DEWR
// world), then switches to each alternate and asserts a distinguishing signal:
//   - the topbar cycle label (each alternate re-anchors the sim clock to day
//     26/30, so "Day 13 of 30" -> "Day 26 of 30"),
//   - the Overview burn-down headline (each scenario's own pool draw),
//   - the Auto-balance nav badge (the firing trigger's at-risk count; absent
//     for the non-firing Healthy state, present for At risk/Surplus/Metered).
//
// FORCE-A-SCENARIO-PER-TEST pattern (documented for future specs): the last
// block drives the scenario purely through the bridge
// (`window.api.setScenario(id)`) instead of the UI, so a spec that only needs a
// particular fixture world can jump straight to it. The mock re-seeds in the
// main process, so a subsequent re-render reads the new world.
// ============================================================================

async function launch(): Promise<{ app: ElectronApplication; window: Page; cleanup: () => void }> {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-scenarios-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-scenarios-userdata-'));
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

const selector = (window: Page) => window.locator('.scenario-selector');
const badge = (window: Page) => window.getByTestId('nav-badge-autobalance');
const burndownHeadline = (window: Page) => window.locator('.overview__chart-headline-burned');
const cycle = (window: Page) => window.locator('.app-shell__cycle');

async function pickScenario(window: Page, label: string): Promise<void> {
  await selector(window).getByRole('button', { name: label, exact: true }).click();
}

test('sim-mode scenario selector switches the whole fixture world across all four demo states', async () => {
  const { app, window, cleanup } = await launch();
  const pageErrors: Error[] = [];
  window.on('pageerror', (error) => pageErrors.push(error));

  try {
    // --- DEFAULT: healthy == the DEWR world (day 13/30), no auto-balance badge.
    await expect(selector(window)).toBeVisible();
    await expect(selector(window).getByRole('button')).toHaveCount(4);
    await expect(selector(window).getByRole('button', { name: 'Healthy', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 13 of 30');
    await expect(burndownHeadline(window)).toHaveText('189,800');
    await expect(badge(window)).toHaveCount(0); // trigger not fired -> no badge

    // --- AT RISK: day 26/30, pool trigger fires (17 at-risk), pool draw 511,150
    // (90.1% of 567,000 -- the wire now AGREES with the engine scalar, Defect 1).
    await pickScenario(window, 'At risk');
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 26 of 30');
    await expect(badge(window)).toHaveText('17');
    await expect(burndownHeadline(window)).toHaveText('511,150');

    // --- SURPLUS: day 26/30, drastic under-consumption (16,000 = 2.8% of the
    // pool) BUT a tiny throttled cohort fires the pool rebalancer (4 at-risk).
    await pickScenario(window, 'Surplus');
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 26 of 30');
    await expect(badge(window)).toHaveText('4');
    await expect(burndownHeadline(window)).toHaveText('16,000');

    // --- METERED: metered rebalancer fires (2 at-risk).
    await pickScenario(window, 'Metered');
    await expect(badge(window)).toHaveText('2');
    await expect(selector(window).getByRole('button', { name: 'Metered', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // --- Back to Healthy resets the world (deterministic re-seed).
    await pickScenario(window, 'Healthy');
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 13 of 30');
    await expect(burndownHeadline(window)).toHaveText('189,800');
    await expect(badge(window)).toHaveCount(0);

    // §6.8: the selector reads as a sim affordance (violet SIM tag), and the
    // sim banner is still unmistakable.
    await expect(selector(window)).toContainText('SIM SCENARIO');
    await expect(window.getByText(/simulation mode/i)).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('the persisted forecast follows scenario switches (Defect 2(b): setScenario re-ingests the new world)', async () => {
  const { app, window, cleanup } = await launch();
  const pageErrors: Error[] = [];
  window.on('pageerror', (error) => pageErrors.push(error));
  const forecastNav = () => window.locator('.nav').getByRole('button', { name: 'Forecast' });
  const runway = () => window.locator('.forecast').getByTestId('forecast-runway');
  const exhaustion = () => window.locator('.forecast').getByTestId('forecast-exhaustion-date');

  try {
    // Switch to At risk: setScenario re-anchors the sim clock to day 26/30 AND
    // re-ingests the new world (so the persisted enterprise forecast is the
    // At-risk world's, not a stale Healthy-world forecast). 90.1% consumed at
    // day 26 -> exhausts the 567,000 pool by cycle end: runway ~3 days.
    await pickScenario(window, 'At risk');
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 26 of 30');
    await forecastNav().click();
    await expect(window.locator('.forecast__tab--active')).toHaveText('Enterprise');
    await expect(runway()).toHaveText('runway ~3 days');
    await expect(exhaustion()).toHaveText('2026-06-30');

    // Switch BACK to Healthy: the re-ingest follows the switch the other way too
    // -- the forecast returns to the original day-13 world (runway ~15 days,
    // exhaustion 2026-06-29), proving the read is no longer serving stale
    // cross-scenario rows.
    await pickScenario(window, 'Healthy');
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 13 of 30');
    await forecastNav().click();
    await expect(window.locator('.forecast__tab--active')).toHaveText('Enterprise');
    await expect(runway()).toHaveText('runway ~15 days');
    await expect(exhaustion()).toHaveText('2026-06-29');

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a scenario can be forced through the bridge (window.api.setScenario) without touching the selector UI', async () => {
  const { app, window, cleanup } = await launch();
  try {
    // listScenarios returns the four states in sim mode (refuses in live).
    const list = await window.evaluate(() =>
      (window as unknown as { api: { listScenarios(): Promise<{ refused: boolean; scenarios?: { id: string }[] }> } }).api.listScenarios(),
    );
    expect(list.refused).toBe(false);
    expect(list.scenarios?.map((s) => s.id)).toEqual(['healthy', 'at-risk', 'surplus', 'metered']);

    // Force At risk purely via the bridge, then reload the renderer so it
    // re-reads the re-seeded world.
    const set = await window.evaluate(() =>
      (window as unknown as { api: { setScenario(id: string): Promise<{ refused: boolean; scenario?: { id: string } }> } }).api.setScenario('at-risk'),
    );
    expect(set.refused).toBe(false);
    expect(set.scenario?.id).toBe('at-risk');

    await window.reload();
    await expect(cycle(window)).toHaveText('Cycle Jun 2026 · Day 26 of 30');
    await expect(badge(window)).toHaveText('17');
  } finally {
    await app.close();
    cleanup();
  }
});
