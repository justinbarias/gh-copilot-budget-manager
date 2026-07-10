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
// supplied independent facts (81-user roster, toDate 2026-06-12, emily-zhao
// months=1 total 11,284 -- all confirmed). The DEWR sim world's licensed roster
// is 81 seats, ~44 of them zero-usage this window, so the median and 30th
// percentile are BOTH 0 credits (a real property of this fixture world), and
// core's spread is 0 (p50 === 0 -> guarded ratio):
//
//   months=1  window 2026-05-13 .. 2026-06-12 (not truncated)
//     n=81  p30=0  p50=0  p95=5,210 ($52.10)  mean=1,710  spread=0.00x
//     usersAboveP95=4  tailShare=28.2%
//     universal ULB = 4,600 cr/mo ($46) -> ×1 = 4,600 cr, 8 users above
//   months=9  window 2026-03-01 .. 2026-06-12 (TRUNCATED)
//     p95=17,890 ($179)
//     universal ULB ×9 = 41,400 cr -> beyond xMax (33,078) -> clamped label
//     "Universal ULB · 41,400 cr →", "0 users above" (provably 0 when clamped)
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

    // months=1 (default window): date caption + tiles + chart + markers.
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText('13 May – 12 Jun 2026');
    await expect(window.locator('[data-testid="distribution-tile-p30-value"]')).toHaveText('0 cr');
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('0 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('5,210 cr');
    await expect(window.locator('[data-testid="distribution-tile-spread-value"]')).toHaveText('0.00×');

    // Chart present: the SVG, 28 histogram bins, and the percentile/ULB marker pills.
    await expect(window.locator('.distribution__svg')).toHaveCount(1);
    await expect(window.locator('[data-testid="distribution-bar"]')).toHaveCount(28);
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'P95 · 5,210 cr · $52.10' }),
    ).toBeVisible();
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'Universal ULB · 4,600 cr · $46.00' }),
    ).toBeVisible();
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('8 users above');

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

    // --- Switch to 9 months: truncation caption, coverage range, changed tiles,
    // and the clamped ULB overlay (×9 exceeds the chart's xMax). ---
    await window.getByRole('tab', { name: '9 months' }).click();
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText(
      '1 Mar – 12 Jun 2026 · truncated to available history',
    );
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('17,890 cr');
    await expect(window.locator('[data-testid="distribution-ulb-note"]')).toHaveText(
      'ULB line shown ×9 for multi-month windows (the ULB is a monthly cap).',
    );
    await expect(
      window.locator('[data-testid="distribution-marker-label"]', { hasText: 'Universal ULB · 41,400 cr →' }),
    ).toBeVisible();
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('0 users above');

    // Regression guard (9 month window): P95 (17,890 cr) and the clamped ULB
    // marker (pinned at plotRight) are the closest pair here.
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

// The 'long-tail' scenario exists specifically so the Distribution view demos
// well: 'healthy' reads P30=P50=0 (~44 idle seats), whereas long-tail has a
// rich right-skewed per-user spread. Switching to it via the sim scenario
// selector re-seeds MSW AND re-runs the app's syncNow (setScenario, App.tsx),
// so the Distribution view (a pure local-SQLite read) renders the new world on
// the remount. Every pin is the SAME months=1 distribution proven by the data
// package's usage-distribution-long-tail.test.ts (independent derivation):
//   window 2026-05-13 .. 2026-06-12 · P30 697 · P50 1,209 · P95 5,445 cr ·
//   8 users above the 4,600 universal ULB.
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

    // Same trailing-month window as 'healthy', but a real distribution now.
    await expect(window.locator('[data-testid="distribution-date-caption"]')).toHaveText('13 May – 12 Jun 2026');
    // The headline: a NON-ZERO median (the whole reason this scenario exists).
    await expect(window.locator('[data-testid="distribution-tile-p30-value"]')).toHaveText('697 cr');
    await expect(window.locator('[data-testid="distribution-tile-p50-value"]')).toHaveText('1,209 cr');
    await expect(window.locator('[data-testid="distribution-tile-p95-value"]')).toHaveText('5,445 cr');

    // The ULB overlay pill: a NON-ZERO "N users above" (8 power users above the
    // 4,600 universal ULB).
    await expect(window.locator('[data-testid="distribution-ulb-sublabel"]')).toHaveText('8 users above');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
