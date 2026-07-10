import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 5.5: the Forecast screen (enterprise + heavy-user scopes; cost-center
// scope is a labeled Task 5.6 placeholder). Task 5.4's forecast.spec.ts
// already proves getForecast's own null-before-sync / real-after-sync
// contract through the bridge directly -- this drives the actual rendered
// screen (scope tabs, entity select, allowance-basis toggle, the extended
// BurndownChart's forecast layers, the metered-phase bar, backtest MAPE
// pill + percentile rows), against the SAME DEWR fixture world.
//
// Expected values (independently recomputed from packages/data's own
// forecast/compute.ts + github-impl.ts glue against the DEWR fixtures --
// see the Task 5.5 build report for the full derivation):
//   - Enterprise (81 seats, promo 567,000): exhaustionDate 2026-06-29,
//     runwayDays 15, mape ~1.18% ("MAPE 1.2%"), June-cycle (day 0-29)
//     terminal P50/P90 cumulative 604,662 / 623,414 credits. (P90 re-pinned
//     for the decoupled small-sample band model: variance is now the SAMPLE
//     variance of the SHRUNK-index residuals plus a k²·SE² run-rate term;
//     the P50 point path is bit-identical to the original model, so 604,662
//     stands. Hand-derived from the fixtures: nEstim 97, runRate 24,223.158,
//     dailyVariance 10,031,876.89, SE² = var/97; last actual day 2026-06-12
//     -> June-30 terminus is projected day k=18 -> 604,662 +
//     1.2816·√(18·var + 18²·SE²) = 604,662 + 18,752 = 623,414.)
//   - Standard allowance toggle: 81 x 3,900 = 315,900 (a flat hypothetical
//     override -- the real June cycle is inside the 1 Jun-1 Sep promo
//     window, so this never reflects live truth for this cycle).
//   - Enterprise metered budget control: $8,000, hard-stop OFF (alert-only)
//     -- projectedMeteredDollars ~$3,851.12 ("$3,851" per this screen's
//     usd() convention).
//   - emily-zhao (userId 5182, ranked #1 by MTD credits per users.spec.ts,
//     so she's the entity select's default): ULB 6,000 (cost-center scope),
//     exhaustionDate (projected block date) 2026-06-15, runwayDays 1, mape
//     ~2.20% ("MAPE 2.2%"), June-cycle terminal P50/P90 16,858 / 17,515
//     (P90 re-pinned for the same band-model change: nEstim 97, runRate
//     672.7622, shrunk-residual sample variance 12,294.86, k=18 at June 30
//     -> 16,858 + 1.2816·√(18·var + 18²·var/97) = 16,858 + 657 = 17,515).
test('Forecast screen: pre-sync empty state, then enterprise + heavy-user scopes render real persisted forecasts', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-forecast-screen-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // --- Pre-sync: a fresh DB has never computed a forecast for any scope. ---
    await window.locator('.nav').getByRole('button', { name: 'Forecast' }).click();
    const screen = window.locator('.forecast');
    await expect(screen).toBeVisible();
    await expect(screen.getByTestId('forecast-empty-state')).toBeVisible();
    await expect(screen.getByTestId('forecast-runway')).toHaveCount(0);

    // Sync via the real Settings UI (settings.spec.ts's own convention).
    await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();
    await window.getByRole('button', { name: /sync now/i }).click();
    await expect(window.getByText(/last synced:/i)).toBeVisible();

    // --- Post-sync: back to Forecast, default (Enterprise) scope. ---
    await window.locator('.nav').getByRole('button', { name: 'Forecast' }).click();
    await expect(screen).toBeVisible();
    await expect(screen.getByTestId('forecast-empty-state')).toHaveCount(0);

    await expect(screen.locator('.forecast__tab--active')).toHaveText('Enterprise');
    await expect(screen.getByTestId('forecast-runway')).toHaveText('runway ~15 days');
    await expect(screen.getByTestId('forecast-exhaustion-date')).toHaveText('2026-06-29');

    const chart = screen.getByTestId('burndown-chart');
    await expect(chart).toBeVisible();
    await expect(chart.getByText('allowance 567,000')).toBeVisible();

    // Task 5.9 design-fidelity pass: the red exhaustion zone (2026-06-29 ->
    // the June chart's right edge) + its boxed callout ("Exhaustion" +
    // the same "2026-06-29 · day 29" string the plain-text label already
    // used), plus the P50/P90 terminus tags at the forecast band's end.
    await expect(chart.getByTestId('burndown-exhaustion-zone')).toBeVisible();
    const enterpriseCallout = chart.getByTestId('burndown-exhaustion-callout');
    await expect(enterpriseCallout).toBeVisible();
    await expect(enterpriseCallout.getByText('Exhaustion')).toBeVisible();
    await expect(enterpriseCallout.getByText('2026-06-29 · day 29')).toBeVisible();
    await expect(chart.getByTestId('burndown-p50-label')).toHaveText('P50');
    await expect(chart.getByTestId('burndown-p90-label')).toHaveText('P90');

    await expect(screen.getByTestId('mape-pill')).toHaveText('MAPE 1.2%');
    const pctRows = screen.locator('.forecast__pct-row');
    await expect(pctRows.filter({ hasText: 'P50' }).locator('.forecast__pct-value')).toHaveText('604,662');
    await expect(pctRows.filter({ hasText: 'P90' }).locator('.forecast__pct-value')).toHaveText('623,414');

    // Metered-phase spend card: real projected metered $ against the real
    // $8,000 enterprise budget control (alert-only, per the DEWR fixture).
    const metered = screen.getByTestId('forecast-metered-headline');
    await expect(metered).toHaveText('$3,851');
    await expect(screen.getByTestId('metered-budget-bar').getByText(/\$8,000 budget/)).toBeVisible();

    // Allowance-basis toggle: flips the chart's allowance line to the flat
    // standard value, then back -- the real numbers (runway/exhaustion) are
    // untouched by round-tripping back to Promo (the real basis for this cycle).
    await screen.getByRole('button', { name: /Standard \(315,900\)/ }).click();
    await expect(chart.getByText('allowance 315,900')).toBeVisible();
    await expect(chart.getByText('allowance 567,000')).toHaveCount(0);

    await screen.getByRole('button', { name: /Promo \(567,000\)/ }).click();
    await expect(chart.getByText('allowance 567,000')).toBeVisible();
    await expect(screen.getByTestId('forecast-runway')).toHaveText('runway ~15 days');
    await expect(screen.getByTestId('forecast-exhaustion-date')).toHaveText('2026-06-29');

    // --- Users scope: defaults to the heaviest-burning user (emily-zhao), who
    // has a real cost-center ULB (6,000) and is projected to block tomorrow. ---
    await screen.getByRole('tab', { name: 'Users' }).click();
    const entitySelect = screen.getByTestId('forecast-entity-select');
    await expect(entitySelect).toBeVisible();
    await expect(entitySelect).toHaveValue('5182');

    await expect(screen.getByTestId('forecast-runway')).toHaveText('runway ~1 day');
    await expect(screen.getByTestId('forecast-exhaustion-date')).toHaveText('2026-06-15');
    await expect(chart.getByText('allowance 6,000')).toBeVisible();

    // Same design-fidelity elements on the user scope's block-date chart --
    // exhaustionDay 14 of a 30-day cycle sits mid-chart (no right-edge
    // overflow, so the callout box is NOT expected to flip left here, unlike
    // the enterprise scope above).
    await expect(chart.getByTestId('burndown-exhaustion-zone')).toBeVisible();
    const userCallout = chart.getByTestId('burndown-exhaustion-callout');
    await expect(userCallout).toBeVisible();
    await expect(userCallout.getByText('Exhaustion')).toBeVisible();
    await expect(userCallout.getByText('2026-06-15 · day 15')).toBeVisible();
    await expect(chart.getByTestId('burndown-p50-label')).toHaveText('P50');
    await expect(chart.getByTestId('burndown-p90-label')).toHaveText('P90');

    await expect(screen.getByTestId('mape-pill')).toHaveText('MAPE 2.2%');
    await expect(pctRows.filter({ hasText: 'P50' }).locator('.forecast__pct-value')).toHaveText('16,858');
    await expect(pctRows.filter({ hasText: 'P90' }).locator('.forecast__pct-value')).toHaveText('17,515');

    // A user's ULB hard-stops in both phases -- no separate metered-phase card.
    await expect(screen.getByTestId('forecast-metered-headline')).toHaveCount(0);
    // No allowance-basis toggle for the user scope (design gap, see the Task 5.5 build report).
    await expect(screen.getByTestId('forecast-basis-toggle')).toHaveCount(0);

    // --- Cost centers scope: real since Task 5.6 (forecast-cc.spec.ts owns
    // its full coverage) -- just prove the tab is no longer a placeholder. ---
    await screen.getByRole('tab', { name: 'Cost centers' }).click();
    await expect(screen.getByTestId('forecast-cc-placeholder')).toHaveCount(0);
    await expect(screen.getByTestId('forecast-cc-select')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
