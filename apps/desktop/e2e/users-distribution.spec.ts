import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Distribution D3 regression guard (marker-pill overlap): the greedy lane
// algorithm reserves a rectangle per PILL (main and, when a marker has one,
// sub), not per marker -- so a sub-pill can never land on top of a different
// marker's main pill occupying the lane below it. This walks every rendered
// pill rect (main: [data-testid="distribution-marker-pill"], sub:
// [data-testid="distribution-sub-pill"]) via getBoundingClientRect() and
// asserts zero pairwise intersection area (touching edges, area === 0, are
// allowed -- a small epsilon absorbs subpixel/antialiasing noise).
async function assertNoPillOverlap(window: Page, windowLabel: string): Promise<void> {
  const rects = await window.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll('[data-testid="distribution-marker-pill"], [data-testid="distribution-sub-pill"]'),
    );
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  });
  // Sanity: the pill query actually found something (a silently-empty
  // selector would make this guard vacuously pass).
  expect(rects.length, `expected marker/sub pills to be present in ${windowLabel} window`).toBeGreaterThan(0);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const area = overlapX * overlapY;
      expect(area, `pill[${i}] and pill[${j}] overlap in ${windowLabel} window (rects: ${JSON.stringify(a)} / ${JSON.stringify(b)})`).toBeLessThanOrEqual(0.5);
    }
  }
}

// Distribution D3: the Users screen's Table|Distribution toggle + the per-user
// credit-consumption distribution view (SVG histogram, percentile/mean/ULB
// markers, tiles, insight strip). Read-only (§6.8): no writes, no banner change.
//
// getUsageDistribution is a PURE local-SQLite read (Distribution D2), so the
// distribution view is empty until a sync has backfilled per-user history --
// this spec exercises the pre-sync sentinel AND the post-sync render, syncing
// via the same window.api.syncNow() the Users-forecast spec uses.
//
// EVERY pinned value below was derived INDEPENDENTLY from the MSW fixtures +
// the D2 backfill persistence semantics + D1 math (computeUsageDistribution),
// via a throwaway harness that ran the real sim syncNow -> getUsageDistribution
// -> computeUsageDistribution and cross-checked against three orchestrator-
// supplied independent facts (81-user roster, toDate 2026-06-12; under the new
// calendar-anchored June-to-date months=1 window emily-zhao totals 5,480, the
// window max -- re-confirmed). The DEWR sim world's licensed roster
// is 81 seats, ~44 of them zero-usage this window, so the median and 30th
// percentile are BOTH 0 credits (a real property of this fixture world), and
// core's spread is 0 (p50 === 0 -> guarded ratio). CALENDAR-ANCHORED windows:
// months=N = the current calendar month (June, to 06-12) + the (N-1) prior
// calendar months that carry data.
//
//   months=1  June-to-date only (2026-06-01 .. 2026-06-12), monthsIncluded=1,
//     not truncated
//     n=81  p30=0  p50=0  p95=4,760 ($47.60)  spread=0.00x  usersAboveP95=4
//     universal ULB = 4,600 cr/mo ($46) -> ×1 = 4,600 cr, 6 users above
//   months=9  Mar-Jun contribute (2026-03-01 .. 2026-06-12), monthsIncluded=4
//     (TRUNCATED: 4 of 9 requested months have data)
//     p95=17,890 ($179)
//     universal ULB ×4 = 18,400 cr ($184) -> within xMax (33,078), NOT clamped
//     -> label "Universal ULB · 18,400 cr · $184", 4 users above
test('Users screen: Table|Distribution toggle, pre-sync sentinel, and the post-sync distribution view across windows', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-users-dist-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // --- Users screen: the Table|Distribution toggle, Table is the default
    // (the pre-existing behaviour) and the UNCHANGED UsersTable still renders. ---
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    const usersScreen = window.locator('.users-screen');
    await expect(usersScreen).toBeVisible();

    const toggle = usersScreen.locator('.users-screen__toggle');
    await expect(toggle.getByRole('tab', { name: 'Table' })).toBeVisible();
    await expect(toggle.getByRole('tab', { name: 'Distribution' })).toBeVisible();
    // Table default: it is the active tab and the existing table is on screen.
    await expect(toggle.locator('.users-screen__toggle-btn--active')).toHaveText('Table');
    await expect(window.locator('.users')).toBeVisible();
    await expect(window.locator('.users-table__row')).toHaveCount(10); // 81 users / 10 per page

    // --- Distribution tab PRE-sync: getUsageDistribution is a pure DB read, so
    // with a fresh (never-synced) DB it returns the sentinel -> empty state. ---
    await toggle.getByRole('tab', { name: 'Distribution' }).click();
    await expect(window.locator('[data-testid="distribution-empty-state"]')).toBeVisible();

    // --- Sync Now: backfills the prior-cycle + current-cycle per-user history
    // into credits_used_fact (Distribution D2's sync change). ---
    interface WindowWithApi {
      api: { syncNow(): Promise<{ lastSyncedAt: string | null }> };
    }
    const status = await window.evaluate(() => (window as unknown as WindowWithApi).api.syncNow());
    expect(status.lastSyncedAt).not.toBeNull();

    // Re-mount the screen so the Distribution view re-fetches against the now-
    // synced DB (a fresh mount, not an in-session refresh).
    await window.locator('.nav').getByRole('button', { name: 'Overview' }).click();
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    // Table remains the default landing view after the remount.
    await expect(usersScreen.locator('.users-screen__toggle-btn--active')).toHaveText('Table');
    await toggle.getByRole('tab', { name: 'Distribution' }).click();

    const dist = window.locator('[data-testid="distribution"]');
    await expect(dist).toBeVisible();

    // months=1 (default window): calendar-anchored caption + tiles + chart + markers.
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText('Jun (to 12 Jun) 2026');
    await expect(window.locator('[data-testid="distribution-tile-p30-value"]')).toHaveText('0 cr');
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('0 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('4,760 cr');
    await expect(window.locator('[data-testid="distribution-tile-spread-value"]')).toHaveText('0.00×');

    // Chart present: the SVG, 28 histogram bins, and the percentile/ULB marker pills.
    await expect(window.locator('.distribution__svg')).toHaveCount(1);
    await expect(window.locator('[data-testid="distribution-bar"]')).toHaveCount(28);
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'P95 · 4,760 cr · $47.60' }),
    ).toBeVisible();
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'Universal ULB · 4,600 cr · $46.00' }),
    ).toBeVisible();
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('6 users above');

    // Insight strip: live-computed template copy (median 0, well under the $46 ULB).
    await expect(window.locator('[data-testid="distribution-insight"]')).toContainText('well under the $46.00 universal ULB');

    // Regression guard (1 month window): the P95 main pill and the ULB
    // marker's "N users above" sub-pill land close together with live data --
    // this is the window where they used to overlap by ~53px.
    await assertNoPillOverlap(window, '1 month');

    // --- Switch to 3 months: same regression guard, different window. ---
    await window.getByRole('tab', { name: '3 months' }).click();
    await expect(window.locator('.distribution__svg')).toHaveCount(1);
    await assertNoPillOverlap(window, '3 months');

    // --- Switch to 9 months: truncation caption, month-aware range, changed
    // tiles, and the ×4 ULB overlay (only Mar-Jun of the 9 requested months have
    // data; ×4 = 18,400 cr stays within xMax, so NOT clamped). ---
    await window.getByRole('tab', { name: '9 months' }).click();
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText(
      'Mar – Jun (to 12 Jun) 2026 · truncated to available history',
    );
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('17,890 cr');
    await expect(window.locator('[data-testid="distribution-ulb-note"]')).toHaveText(
      'ULB line shown ×4 — 4 of 9 requested months have data (the ULB is a monthly cap).',
    );
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'Universal ULB · 18,400 cr · $184' }),
    ).toBeVisible();
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('4 users above');

    // Regression guard (9 month window): the marker pills still never overlap
    // (P95 17,890 cr and the ULB at 18,400 cr are the closest pair here).
    await assertNoPillOverlap(window, '9 months');

    // --- Back to Table: the regression guard that the toggle still swaps views. ---
    await toggle.getByRole('tab', { name: 'Table' }).click();
    await expect(window.locator('.users-table__row')).toHaveCount(10);
    await expect(window.locator('[data-testid="distribution"]')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// Distribution "Per month" lens (DEFAULT healthy scenario): the "Totals | Per
// month" segmented toggle switches the histogram from per-user WINDOW TOTALS to
// per (user, complete-calendar-month) observations, read directly against the
// MONTHLY universal ULB (plain, never ×months). Coverage 2026-03-01..2026-06-12
// -> complete months Mar/Apr/May 2026 (the partial June is excluded), so
// months=1 -> [2026-05] (81 user-months), months=3 -> [Mar,Apr,May] (243
// user-months). Only the five history-carrying personas have Mar/Apr/May data
// in 'healthy', so most user-months are 0 -> P30=P50=0 (a real property of this
// world; the long-tail scenario is where per-month P50 is non-zero).
//
// EVERY pin below was derived INDEPENDENTLY from the MSW fixtures via a
// throwaway harness that ran the real sim syncNow, read the raw
// credits_used_fact rows (NOT getUserMonthObservations), bucketed them by whole
// calendar month with the same union/latest-wins winning-rows rule + roster
// rule, and fed the per-user-month multiset through core's
// computeUsageDistribution / countAbove:
//   months=1  [2026-05]  81 user-months
//     p30=0  p50=0  p95=6,699 cr ($66.99)  usersAboveP95=4
//     plain 4,600-cr ($46.00) monthly ULB -> 5 user-months above
//   months=3  [Mar,Apr,May]  243 user-months
//     p30=0  p50=0  p95=5,800 cr ($58.00)  15 user-months above the ULB
test('Distribution "Per month" lens (healthy): toggle switches to per-user-month observations against the monthly ULB', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-permonth-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Sync first (getUserMonthObservations is a pure DB read -- empty until a
    // sync backfills per-user history).
    interface WindowWithApi {
      api: { syncNow(): Promise<{ lastSyncedAt: string | null }> };
    }
    const status = await window.evaluate(() => (window as unknown as WindowWithApi).api.syncNow());
    expect(status.lastSyncedAt).not.toBeNull();

    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    const usersScreen = window.locator('.users-screen');
    await expect(usersScreen).toBeVisible();
    await usersScreen.locator('.users-screen__toggle').getByRole('tab', { name: 'Distribution' }).click();

    const dist = window.locator('[data-testid="distribution"]');
    await expect(dist).toBeVisible();

    // Toggle from Totals (default) to Per month.
    await window.getByRole('tab', { name: 'Per month' }).click();

    // months=1 (default window): caption names the single complete month + the
    // observation count + the partial-month exclusion.
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText(
      'May 2026 · 81 user-months · current month excluded (partial)',
    );
    // P50/P95 tiles (independent derivation above). P30/P50 read 0 in 'healthy'.
    await expect(window.locator('[data-testid="distribution-tile-p30-value"]')).toHaveText('0 cr');
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('0 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('6,699 cr');
    await expect(window.locator('[data-testid="distribution-tile-spread-value"]')).toHaveText('0.00×');

    // x-axis title switches to the per-user-month wording.
    await expect(window.getByText('credits per user-month (1 cr = $0.01)')).toBeVisible();

    // The ULB overlay is the PLAIN monthly amount (no ×months scaling), and the
    // sub-pill counts USER-MONTHS above it.
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'Universal ULB · 4,600 cr · $46.00' }),
    ).toBeVisible();
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('5 user-months above');
    await expect(window.locator('[data-testid="distribution-marker-label"]', { hasText: 'P95 · 6,699 cr · $66.99' })).toBeVisible();
    // Per-month insight: P95 user-month named directly against the monthly ULB.
    await expect(window.locator('[data-testid="distribution-insight"]')).toContainText('against the $46.00 monthly ULB');

    // No multi-month ×-scaling footer note in per-month mode.
    await expect(window.locator('[data-testid="distribution-ulb-note"]')).toHaveCount(0);

    // The pill no-overlap regression guard must still hold in per-month mode.
    await assertNoPillOverlap(window, 'per-month 1 month');

    // --- Switch to 3 months (still Per month): 243 user-months, changed tiles. ---
    await window.getByRole('tab', { name: '3 months' }).click();
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText(
      'Mar–May 2026 · 243 user-months · current month excluded (partial)',
    );
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('5,800 cr');
    // Still the PLAIN monthly ULB (not ×3) -- the whole point of the per-month lens.
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'Universal ULB · 4,600 cr · $46.00' }),
    ).toBeVisible();
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('15 user-months above');
    await assertNoPillOverlap(window, 'per-month 3 months');

    // --- Back to Totals: the toggle restores the window-totals lens (×3 ULB). ---
    await window.getByRole('tab', { name: 'Totals' }).click();
    await expect(window.locator('[data-testid="distribution-ulb-note"]')).toHaveText(
      'ULB line shown ×3 for multi-month windows (the ULB is a monthly cap).',
    );
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// The 'long-tail' scenario exists specifically so the Distribution view demos
// well: 'healthy' reads P30=P50=0 (~44 idle seats), whereas long-tail has a
// rich right-skewed per-user spread. Switching to it via the sim scenario
// selector re-seeds MSW AND re-runs the app's syncNow (setScenario, App.tsx),
// so the Distribution view (a pure local-SQLite read) renders the new world on
// the remount. Every pin is the SAME distribution proven by the data package's
// usage-distribution-long-tail.test.ts (independent derivation). Totals is now
// CALENDAR-ANCHORED (current month June-to-date + prior contributing months):
//   Totals months=1  June-to-date (2026-06-01 .. 2026-06-12)
//     P30 649 · P50 1,100 · P95 4,600 cr · 3 users above the 4,600 ULB
//   Per month months=1  [2026-05] 81 user-months  (per-month lens UNCHANGED)
//     P30 697 · P50 1,172 · P95 6,699 cr · 8 user-months above the 4,600 ULB
//   Per month months=3  [Mar,Apr,May] 243 user-months  (UNCHANGED)
//     P50 1,207 · P95 6,000 cr · 25 user-months above the 4,600 ULB
test('Long tail scenario: the Distribution view shows a non-zero P50 and a non-zero "N users above ULB" pill', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-longtail-dist-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-longtail-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Switch to Long tail via the sim scenario selector -- this awaits the
    // bridge's setScenario (which re-runs syncNow), so once the button reads
    // pressed the DB is synced with the long-tail world.
    const selector = window.locator('.scenario-selector');
    await expect(selector).toBeVisible();
    await selector.getByRole('button', { name: 'Long tail', exact: true }).click();
    await expect(selector.getByRole('button', { name: 'Long tail', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Open Users -> Distribution (a fresh mount re-fetches the synced world).
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    const usersScreen = window.locator('.users-screen');
    await expect(usersScreen).toBeVisible();
    await usersScreen.locator('.users-screen__toggle').getByRole('tab', { name: 'Distribution' }).click();

    const dist = window.locator('[data-testid="distribution"]');
    await expect(dist).toBeVisible();

    // Same June-to-date window as 'healthy', but a real distribution now.
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText('Jun (to 12 Jun) 2026');
    // The headline: a NON-ZERO median (the whole reason this scenario exists).
    await expect(window.locator('[data-testid="distribution-tile-p30-value"]')).toHaveText('649 cr');
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('1,100 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('4,600 cr');

    // The ULB overlay pill: a NON-ZERO "N users above" (3 seats above the ×1 =
    // 4,600 universal ULB from the June-to-date draw alone).
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('3 users above');

    // --- Per month lens: the full-roster backfill makes this a non-zero-median
    // bell curve too (the point of the backfill; 'healthy' reads P30=P50=0). ---
    await window.getByRole('tab', { name: 'Per month' }).click();
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText(
      'May 2026 · 81 user-months · current month excluded (partial)',
    );
    await expect(window.locator('[data-testid="distribution-tile-p30-value"]')).toHaveText('697 cr');
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('1,172 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('6,699 cr');
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('8 user-months above');

    // 3 months (still Per month): 243 user-months, a wider bell.
    await window.getByRole('tab', { name: '3 months' }).click();
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText(
      'Mar–May 2026 · 243 user-months · current month excluded (partial)',
    );
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('1,207 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('6,000 cr');
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('25 user-months above');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
