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
//
// Task 5.7 update: the forecast lens is no longer a disabled Phase-4 stub --
// it's live from a fresh (never-synced) DB, same as this test's own state.
// CHANGED assertions (old -> new), both in this same test:
//   - Removed: `poolPhaseBtn`/`meteredPhaseBtn` `.toBeDisabled()` and the
//     "Coming in Phase 4" cue text (no longer true -- the lens is live).
//   - Added: both lens buttons are ENABLED; Pool phase is active by default;
//     the persistent cliff banner (independent of forecast/sync state --
//     it's a static date fact, not a projection) renders with the real,
//     truthful 44.3% figure (NOT the spec's "~37%", see CliffBanner.tsx's own
//     doc comment + packages/data/src/msw/fixtures/README.md's reconciliation
//     note); clicking into the Metered lens pre-sync shows a graceful
//     "No forecast yet" card, not an error/blank flash; clicking back to Pool
//     phase renders the SAME 4 MVP tiles this test already asserted above
//     (forecast === null keeps the tile grid byte-for-byte the Task 2.1 shape --
//     see the Task 5.7 build report).
test('Overview renders the actual-only burn-down chart, runway tiles, a live forecast lens, and the cliff banner (pre-sync)', async () => {
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

    // Pre-sync: no forecast overlay at all (graceful degradation, Task 5.7
    // acceptance criterion 4) -- byte-for-byte the Task 2.1 actual-only chart.
    await expect(chart.getByTestId('burndown-band')).toHaveCount(0);
    await expect(chart.getByTestId('burndown-exhaustion-marker')).toHaveCount(0);
    await expect(chart.getByTestId('burndown-exhaustion-zone')).toHaveCount(0);
    await expect(chart.getByTestId('burndown-exhaustion-callout')).toHaveCount(0);

    // Runway tiles: 4-up grid of cycle-to-date facts computed via packages/core.
    // Pre-sync, this is exactly the Task 2.1 MVP grid (forecast === null keeps
    // "Credits consumed"/"Allowance" instead of upgrading to projections).
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

    // Forecast-lens toggle: now LIVE (Task 5.7) -- both buttons enabled, Pool
    // phase active by default, no "coming soon" cue.
    const poolPhaseBtn = window.getByRole('button', { name: 'Pool phase' });
    const meteredPhaseBtn = window.getByRole('button', { name: 'Metered phase' });
    await expect(poolPhaseBtn).toBeVisible();
    await expect(poolPhaseBtn).toBeEnabled();
    await expect(meteredPhaseBtn).toBeEnabled();
    await expect(poolPhaseBtn).toHaveClass(/overview__lens-btn--active/);
    await expect(window.getByText(/Coming in Phase 4/)).toHaveCount(0);

    // Persistent cliff banner: independent of sync/forecast state (a static
    // date fact -- SIM_CURRENT_DATE 2026-06-14 is 79 days ahead of the 1 Sep
    // 2026 cliff), so it renders even on a never-synced DB. Real fixture
    // constants: 81 seats x 7,000 promo -> 567,000, x 3,900 standard ->
    // 315,900, a TRUE 44.3% drop -- not the spec's rounded "~37%".
    const banner = window.getByTestId('cliff-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Included allowance drops on 2026-09-01 — pool falls 44.3%');
    await expect(banner).toContainText('567,000 → 315,900');
    await expect(banner).toContainText('79 days out');

    // Clicking into the Metered lens before any Sync Now has run: a graceful
    // "No forecast yet" card, never an error or a blank flash.
    await meteredPhaseBtn.click();
    await expect(window.getByTestId('overview-metered-empty-state')).toBeVisible();
    await expect(window.getByText('No forecast yet')).toBeVisible();
    await expect(window.getByTestId('overview-metered-headline')).toHaveCount(0);

    // Back to Pool phase: the same MVP tiles/chart, undisturbed.
    await poolPhaseBtn.click();
    await expect(tiles).toHaveCount(4);
    await expect(creditsTile.locator('.runway-tile__value')).toHaveText('189,800');

    // Sim banner from Task 1.7 stays intact alongside the new screen.
    await expect(window.getByText(/simulation mode/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// Task 5.7: post-sync forecast overlay + projected tiles + metered lens +
// cliff banner navigation. Expected values are the SAME DEWR-world enterprise
// forecast already pinned by apps/desktop/e2e/forecast.spec.ts and
// forecast-screen.spec.ts (exhaustionDate 2026-06-29, runwayDays 15,
// projectedMeteredDollars ~$3,851.12, enterprise metered budget $8,000 /
// hard-stop OFF (alert-only) -- packages/data/src/msw/fixtures/budgets.ts's
// BUDGET_IDS.enterpriseMetered) -- this drives the actual Overview screen
// rather than re-deriving the math.
test('Overview: after Sync Now, the pool lens gains the forecast overlay + projected tiles, the metered lens renders real projections, and the cliff banner links to Forecast', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-overview-forecast-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Sync via the real Settings UI (settings.spec.ts's own convention).
    await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();
    await window.getByRole('button', { name: /sync now/i }).click();
    await expect(window.getByText(/last synced:/i)).toBeVisible();

    await window.locator('.nav').getByRole('button', { name: 'Overview' }).click();
    const chart = window.getByTestId('burndown-chart');
    await expect(chart).toBeVisible();

    // Pool lens: the forecast overlay is now present -- P50 band + the real
    // exhaustion marker (2026-06-29, day 28 of the June cycle: 2026-06-01 is
    // day 0).
    await expect(chart.getByTestId('burndown-band')).toBeVisible();
    await expect(chart.getByTestId('burndown-exhaustion-marker')).toBeVisible();
    await expect(chart.getByText(/2026-06-29/)).toBeVisible();

    // Task 5.9 design-fidelity pass: the pool lens gets the same red
    // exhaustion zone + boxed callout as the Forecast screen's enterprise
    // scope (same underlying forecast, same day-28-of-30 exhaustion).
    await expect(chart.getByTestId('burndown-exhaustion-zone')).toBeVisible();
    const overviewCallout = chart.getByTestId('burndown-exhaustion-callout');
    await expect(overviewCallout).toBeVisible();
    await expect(overviewCallout.getByText('Exhaustion')).toBeVisible();
    await expect(overviewCallout.getByText('2026-06-29 · day 29')).toBeVisible();

    // Projected tiles replace "Credits consumed"/"Allowance" (Task 5.7):
    // "Pool runway 15 days" + "Projected metered spend $3,851.12", with an
    // unambiguous multi-cycle-horizon sublabel (never implying "just this cycle").
    const tiles = window.locator('.runway-tile');
    await expect(tiles).toHaveCount(4);

    const runwayTile = tiles.filter({ hasText: 'Pool runway' });
    await expect(runwayTile.locator('.runway-tile__value')).toHaveText('15 days');
    await expect(runwayTile.locator('.runway-tile__sub')).toHaveText('Projected exhaustion 2026-06-29');

    const meteredTile = tiles.filter({ hasText: 'Projected metered spend' });
    await expect(meteredTile.locator('.runway-tile__value')).toHaveText('$3,851.12');
    // Honesty requirement (CLAUDE.md/PLAN.md Task 5.7): the sublabel must be
    // unambiguous that this total spans the full multi-cycle horizon, NOT
    // just the single June cycle charted above -- explicitly says so, rather
    // than merely omitting a caveat.
    await expect(meteredTile.locator('.runway-tile__sub')).toContainText('multi-cycle');
    await expect(meteredTile.locator('.runway-tile__sub')).toContainText('not just this cycle');

    // "Days elapsed"/"Pool % consumed" -- the two MVP tiles design/PLAN.md
    // retain -- are unchanged.
    await expect(tiles.filter({ hasText: 'Days elapsed in cycle' }).locator('.runway-tile__value')).toHaveText('13 of 30');
    await expect(tiles.filter({ hasText: 'Pool % consumed' }).locator('.runway-tile__value')).toHaveText('33.5%');

    // Metered lens: real projected metered spend against the real enterprise
    // budget control ($8,000, alert-only).
    await window.getByRole('button', { name: 'Metered phase' }).click();
    const meteredHeadline = window.getByTestId('overview-metered-headline');
    await expect(meteredHeadline).toContainText('$3,851.12');
    await expect(meteredHeadline).toContainText('$8,000 metered budget');
    await expect(meteredHeadline).toContainText('hard-stop not projected');

    const meteredTiles = window.locator('.overview__metered-tiles .runway-tile');
    await expect(meteredTiles).toHaveCount(3);
    await expect(meteredTiles.filter({ hasText: 'Metered budget' }).locator('.runway-tile__value')).toHaveText('$8,000');
    await expect(meteredTiles.filter({ hasText: 'Metered budget' }).locator('.runway-tile__sub')).toHaveText(
      'enterprise · alert-only',
    );
    await expect(meteredTiles.filter({ hasText: 'Projected metered (P50)' }).locator('.runway-tile__value')).toHaveText(
      '$3,851.12',
    );
    await expect(meteredTiles.filter({ hasText: 'Metered phase starts' }).locator('.runway-tile__value')).toHaveText(
      '2026-06-29',
    );

    // Back to Pool phase before exercising the cliff banner's nav link, so we
    // can confirm it still renders alongside the now-live forecast overlay.
    await window.getByRole('button', { name: 'Pool phase' }).click();
    const banner = window.getByTestId('cliff-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('pool falls 44.3%');

    // "Visualise the cliff ->" navigates to the real Forecast screen (same
    // cross-link mechanism as Controls' Auto-balance link, App.tsx's `navigate`).
    await banner.getByRole('button', { name: /Visualise the cliff/ }).click();
    await expect(window.locator('h1.app-shell__title')).toHaveText('Forecast');
    await expect(window.locator('.forecast')).toBeVisible();
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

    // "View in audit" is real since Task 8.4 -- clicking it lands on the
    // Audit screen (the disabled Task 2.5 stub this replaced is gone).
    const auditLink = window.getByRole('button', { name: /View in audit/ });
    await expect(auditLink).toBeVisible();
    await expect(auditLink).toBeEnabled();
    await auditLink.click();
    await expect(window.locator('.app-shell__title')).toHaveText('Audit');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
