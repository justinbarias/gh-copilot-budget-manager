import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 2.1: Overview burn-down chart (actual-only) + runway tiles. Expected
// numbers are derived from packages/data's MSW fixtures the same way
// getUsageSummary() computes them (see github-impl.ts's buildDailyBurn /
// github-impl.test.ts's coverage of the same math):
//   - cycleAsOfDate anchors to 2026-06-14 (SIM_CURRENT_DATE) -> cycle is June
//     2026, cycleBounds gives daysElapsed=13, daysInCycle=30.
//   - Pool-phase credits consumed by 2026-06-14 = discount_amount-derived:
//     platform 420 + dataAnalytics 310 + cap-bound cost center's fully-metered
//     0 (its discount_amount is 0 -- already tipped to metered) = 730.
//   - licenseCount = 35 seats (fixtures/licenses.ts) -> promo allowance (June
//     2026 is within the 1 Jun-1 Sep promo window) = 35 * 7000 = 245,000.
//   - poolConsumedPct(730, 245000) = 0.30% (rounded to 1 decimal).
test('Overview renders the actual-only burn-down chart, runway tiles, and a disabled forecast lens', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-overview-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Overview is reachable (no nav shell yet -- Task 2.5 -- so it renders on load).
    await expect(window.getByText('Enterprise pool burn-down')).toBeVisible();

    // Hero headline encodes the actual chart's final point: 730 of 245,000 burned.
    const chartCard = window.locator('.overview__chart-card');
    await expect(chartCard.locator('.overview__chart-headline-burned')).toHaveText('730');
    await expect(chartCard.locator('.overview__chart-headline-of')).toHaveText('of 245,000 burned');

    // The chart itself rendered real SVG content, including the allowance
    // reference line's label (a real fixture-derived number, not a stub).
    const chart = window.getByTestId('burndown-chart');
    await expect(chart.locator('svg')).toBeVisible();
    await expect(chart.getByText('allowance 245,000')).toBeVisible();
    expect(await chart.locator('svg path').count()).toBeGreaterThan(0);

    // Runway tiles: 4-up grid of cycle-to-date facts computed via packages/core.
    const tiles = window.locator('.runway-tile');
    await expect(tiles).toHaveCount(4);

    const daysTile = tiles.filter({ hasText: 'Days elapsed in cycle' });
    await expect(daysTile.locator('.runway-tile__value')).toHaveText('13 of 30');

    const pctTile = tiles.filter({ hasText: 'Pool % consumed' });
    await expect(pctTile.locator('.runway-tile__value')).toHaveText('0.3%');
    await expect(pctTile.locator('.runway-tile__sub')).toHaveText('730 of 245,000 credits');

    const creditsTile = tiles.filter({ hasText: 'Credits consumed' });
    await expect(creditsTile.locator('.runway-tile__value')).toHaveText('730');

    const allowanceTile = tiles.filter({ hasText: 'Allowance' });
    await expect(allowanceTile.locator('.runway-tile__value')).toHaveText('245,000');
    await expect(allowanceTile.locator('.runway-tile__sub')).toHaveText('35 licenses');

    // Forecast-lens toggle: present, visibly non-interactive (disabled, not
    // silently missing), and paired with a text cue (never color-only).
    const poolPhaseBtn = window.getByRole('button', { name: 'Pool phase' });
    const meteredPhaseBtn = window.getByRole('button', { name: 'Metered phase' });
    await expect(poolPhaseBtn).toBeVisible();
    await expect(poolPhaseBtn).toBeDisabled();
    await expect(meteredPhaseBtn).toBeDisabled();
    await expect(window.getByText(/Coming in Phase 4/)).toBeVisible();

    // Sim banner from Task 1.7 stays intact alongside the new screen.
    await expect(window.getByText(/simulation mode/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// Task 2.2: Overview alerts & anomalies list, rendered verbatim from
// ApiClient.listAlerts() -- pre-baked MSW fixture data
// (packages/data/src/msw/fixtures/alerts.ts's ALERTS array), not derived from
// syncNow/ingested snapshots. Expected values below are that fixture's exact
// field values, in fixture order (no client-side sorting/derivation).
test('Overview renders the alerts & anomalies list from fixture data with correct severity styling', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-overview-alerts-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    await expect(window.getByText('Alerts & anomalies')).toBeVisible();

    // Item count matches the ALERTS fixture length exactly (3 entries).
    const items = window.locator('.alerts-list__item');
    await expect(items).toHaveCount(3);

    // First item: alert-zero-ulb-user-20 (critical).
    const first = items.nth(0);
    await expect(first.locator('.alerts-list__severity')).toHaveAttribute('title', 'Critical');
    await expect(first.locator('.alerts-list__severity-label')).toHaveText('Critical');
    await expect(first.locator('.alerts-list__tag')).toHaveText('zero-ulb');
    await expect(first.locator('.alerts-list__item-title')).toHaveText(
      'user-20 is fully blocked by a $0 individual budget',
    );
    await expect(first.locator('.alerts-list__item-meta')).toHaveText(
      'Individual ULB overrides CCULB and universal -- always hard-stops both phases',
    );
    // Rendered absolute (UTC, locale-fixed) -- never a wall-clock-relative
    // "Xm ago" string, so this assertion is deterministic across CI/local runs.
    await expect(first.locator('.alerts-list__timestamp')).toHaveText('Jun 14, 2026, 09:12 UTC');

    // Second item: cap-bound cost center (warning).
    const second = items.nth(1);
    await expect(second.locator('.alerts-list__severity')).toHaveAttribute('title', 'Warning');
    await expect(second.locator('.alerts-list__tag')).toHaveText('cap-bound');
    await expect(second.locator('.alerts-list__item-title')).toHaveText(
      'Cost center cc-marketing-cap-bound has exhausted its included-usage cap',
    );

    // Third item: allowance cliff (info).
    const third = items.nth(2);
    await expect(third.locator('.alerts-list__severity')).toHaveAttribute('title', 'Info');
    await expect(third.locator('.alerts-list__tag')).toHaveText('cliff');

    // "View in audit" is present but visibly inert (Audit screen is a Task 2.5
    // stub) -- disabled, not silently missing, paired with an icon+text cue
    // (never color-only per design/README.md's accessibility intent).
    const auditLink = window.getByRole('button', { name: /View in audit/ });
    await expect(auditLink).toBeVisible();
    await expect(auditLink).toBeDisabled();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
