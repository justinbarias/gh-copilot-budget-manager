import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 2.1: Overview burn-down chart (actual-only) + runway tiles. Expected
// numbers are derived from packages/data's MSW fixtures the same way
// getUsageSummary() computes them (see github-impl.ts's buildDailyBurn /
// github-impl.test.ts's coverage of the same math), against the DEWR fixture
// world (packages/data/src/msw/fixtures/README.md):
//   - cycleAsOfDate anchors to 2026-06-14 (SIM_CURRENT_DATE) -> cycle is June
//     2026, cycleBounds gives daysElapsed=13, daysInCycle=30.
//   - Pool-phase credits consumed by 2026-06-14 = Σ round(discount_amount x 100)
//     over the June rows of usage.ts's USAGE_ITEMS (six cost centers' pool
//     draws, itemised over weekdays Jun 2/4/5/9/11/12) = 189,800.
//   - licenseCount = 81 seats (fixtures/licenses.ts) -> promo allowance (June
//     2026 is within the 1 Jun-1 Sep promo window) = 81 * 7,000 = 567,000.
//   - poolConsumedPct(189,800, 567,000) = 33.5% (rounded to 1 decimal).
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

    // Overview is the shell's default screen, but navigate explicitly (Task
    // 2.5's nav shell) rather than relying on that default.
    await window.locator('.nav').getByRole('button', { name: 'Overview' }).click();
    await expect(window.getByText('Enterprise pool burn-down')).toBeVisible();

    // Hero headline encodes the actual chart's final point: 189,800 of 567,000 burned.
    const chartCard = window.locator('.overview__chart-card');
    await expect(chartCard.locator('.overview__chart-headline-burned')).toHaveText('189,800');
    await expect(chartCard.locator('.overview__chart-headline-of')).toHaveText('of 567,000 burned');

    // The chart itself rendered real SVG content, including the allowance
    // reference line's label (a real fixture-derived number, not a stub).
    const chart = window.getByTestId('burndown-chart');
    await expect(chart.locator('svg')).toBeVisible();
    await expect(chart.getByText('allowance 567,000')).toBeVisible();
    expect(await chart.locator('svg path').count()).toBeGreaterThan(0);

    // Runway tiles: 4-up grid of cycle-to-date facts computed via packages/core.
    const tiles = window.locator('.runway-tile');
    await expect(tiles).toHaveCount(4);

    const daysTile = tiles.filter({ hasText: 'Days elapsed in cycle' });
    await expect(daysTile.locator('.runway-tile__value')).toHaveText('13 of 30');

    const pctTile = tiles.filter({ hasText: 'Pool % consumed' });
    await expect(pctTile.locator('.runway-tile__value')).toHaveText('33.5%');
    await expect(pctTile.locator('.runway-tile__sub')).toHaveText('189,800 of 567,000 credits');

    const creditsTile = tiles.filter({ hasText: 'Credits consumed' });
    await expect(creditsTile.locator('.runway-tile__value')).toHaveText('189,800');

    const allowanceTile = tiles.filter({ hasText: 'Allowance' });
    await expect(allowanceTile.locator('.runway-tile__value')).toHaveText('567,000');
    await expect(allowanceTile.locator('.runway-tile__sub')).toHaveText('81 licenses');

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
// field values, in fixture order (no client-side sorting/derivation). The
// DEWR world ships 4 alerts (was 3): the zero-ULB block, the cap-bound crisis
// (now CRITICAL, not warning), the amber low-headroom warning, and the cliff.
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

    await window.locator('.nav').getByRole('button', { name: 'Overview' }).click();
    await expect(window.getByText('Alerts & anomalies')).toBeVisible();

    // Item count matches the ALERTS fixture length exactly (4 entries).
    const items = window.locator('.alerts-list__item');
    await expect(items).toHaveCount(4);

    // First item: alert-zero-ulb-ext-dmorrow (critical).
    const first = items.nth(0);
    await expect(first.locator('.alerts-list__severity')).toHaveAttribute('title', 'Critical');
    await expect(first.locator('.alerts-list__severity-label')).toHaveText('Critical');
    await expect(first.locator('.alerts-list__tag')).toHaveText('zero-ulb');
    await expect(first.locator('.alerts-list__item-title')).toHaveText(
      'ext-dmorrow is fully blocked by a $0 individual budget',
    );
    await expect(first.locator('.alerts-list__item-meta')).toHaveText(
      'Individual ULB overrides CCULB and universal -- always hard-stops both phases',
    );
    // Rendered absolute (UTC, locale-fixed) -- never a wall-clock-relative
    // "Xm ago" string, so this assertion is deterministic across CI/local runs.
    await expect(first.locator('.alerts-list__timestamp')).toHaveText('Jun 14, 2026, 09:12 UTC');

    // Second item: cap-bound cost center (also CRITICAL in the DEWR world --
    // the crisis fixture is a fully-exhausted cap overflowing into metered).
    const second = items.nth(1);
    await expect(second.locator('.alerts-list__severity')).toHaveAttribute('title', 'Critical');
    await expect(second.locator('.alerts-list__tag')).toHaveText('cap-bound');
    await expect(second.locator('.alerts-list__item-title')).toHaveText(
      'Payments Integrity Engineering has exhausted its included-usage cap',
    );

    // Third item: the amber low-headroom warning (new in the DEWR world).
    const third = items.nth(2);
    await expect(third.locator('.alerts-list__severity')).toHaveAttribute('title', 'Warning');
    await expect(third.locator('.alerts-list__tag')).toHaveText('low-headroom');
    await expect(third.locator('.alerts-list__item-title')).toHaveText(
      'Data & Evaluation Platform is within 5,600 credits of its included-usage cap',
    );

    // Fourth item: allowance cliff (info).
    const fourth = items.nth(3);
    await expect(fourth.locator('.alerts-list__severity')).toHaveAttribute('title', 'Info');
    await expect(fourth.locator('.alerts-list__tag')).toHaveText('cliff');

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
