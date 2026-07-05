import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 5.8: Users screen "✕ block ~<date>" projected-block-date sublabel,
// per-user forecast (Task 5.4's persisted `getForecast('user', userId)`) vs
// binding ULB -- PRD §3.3's developer-persona self-service headroom answer.
//
// Every asserted value below was independently confirmed against the app's
// own DB via the same `client.getForecast`/`listHeavyUsers` surface this
// screen calls (see the build report for the full sweep across all 81
// licensed users):
//   - emily-zhao: 5,480 MTD credits against her binding 6,000-credit CCULB
//     (Data & Evaluation Platform) -> projects to exhaust 2026-06-15 (one day
//     past the 2026-06-14 as-of anchor -- her trailing-7-weighted run-rate is
//     high enough to cross the ULB almost immediately). Renders "✕ block ~Jun
//     15".
//   - declan-ryan, devi-anand, jomo-mburu, nina-popov, tegan-ellis: all 0 MTD
//     credits this cycle (a per-user forecast IS persisted for each -- every
//     one of the 81 licensed seats gets one on `syncNow`, Task 5.4 -- but with
//     zero burn the run-rate projects a flat line that never crosses their
//     ULB, so `result.exhaustionDate` is null). The Users screen's existing
//     (pre-5.8) "no usage yet this cycle" rule takes precedence regardless,
//     per loginSublabel's documented precedence order.
//
// A sweep of ALL 81 licensed users' persisted forecasts (this build's report)
// found NO user with nonzero MTD usage and a null exhaustionDate: the DEWR
// fixture's ~36 nonzero-usage seats are, by construction, the "heavy user"
// ranking's near-ULB cohort, and every one of them projects to cross their
// binding ULB within the current 30-day cycle horizon. There is currently no
// naturally-occurring "usage but no projected block" row in this fixture
// world to assert a concrete "neither" case against -- diego-santos (page 2,
// rank 11, 4,080 MTD credits) is used below only to confirm pre-sync
// behaviour (no sublabel before any forecast exists), not the post-sync
// "neither" state, which loginSublabel still handles correctly (returns null)
// but which this fixture set has no example of to pin.
test('Users rows show forecast-derived block-date / no-usage sublabels post-sync, and none pre-sync', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-users-forecast-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // --- Pre-sync: no forecast has ever been computed. No sublabel renders
    // for a nonzero-usage user, no error, no layout jank -- just the
    // pre-existing $0/no-usage rules (unaffected by this task). ---
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    let screen = window.locator('.users');
    await expect(screen).toBeVisible();
    let rows = screen.locator('.users-table__row');
    await expect(rows).toHaveCount(10);

    const preSyncEmily = rows.filter({ hasText: 'emily-zhao' });
    await expect(preSyncEmily.locator('.users-table__login')).toHaveText('emily-zhao');
    // No block sublabel yet -- pre-sync, getForecast resolves null.
    await expect(preSyncEmily.locator('.users-table__sublabel')).toHaveCount(0);

    // The pre-existing "no usage yet this cycle" rule is untouched by this
    // task and needs no forecast to render -- confirm it still renders
    // pre-sync for a named zero-usage user. Searched directly (rather than
    // via the "No usage" status filter + pagination) so the row is always on
    // the single visible page regardless of where declan-ryan ranks among
    // the 44 zero-usage seats.
    await window.getByLabel('Search login').fill('declan-ryan');
    const preSyncDeclan = rows.filter({ hasText: 'declan-ryan' });
    await expect(preSyncDeclan.locator('.users-table__sublabel')).toHaveText('no usage yet this cycle');
    await window.getByLabel('Search login').fill('');

    // --- Sync Now: forecasts are computed and persisted for every scope,
    // including all 81 users (Task 5.4). ---
    interface WindowWithApi {
      api: { syncNow(): Promise<{ lastSyncedAt: string | null }> };
    }
    const status = await window.evaluate(() => (window as unknown as WindowWithApi).api.syncNow());
    expect(status.lastSyncedAt).not.toBeNull();

    // Re-navigate so the table's own effects re-fetch against the now-synced
    // forecast rows (a fresh mount, not relying on any in-session refresh).
    await window.locator('.nav').getByRole('button', { name: 'Overview' }).click();
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    screen = window.locator('.users');
    await expect(screen).toBeVisible();
    rows = screen.locator('.users-table__row');
    await expect(rows).toHaveCount(10);

    // emily-zhao: rank 1, 5,480 MTD against her binding 6,000-credit CCULB ->
    // projected block sublabel with a concrete date.
    const emilyRow = rows.nth(0);
    await expect(emilyRow.locator('.users-table__login')).toHaveText('emily-zhao');
    await expect(emilyRow.locator('.users-table__mtd')).toHaveText('5,480');
    await expect(emilyRow.locator('.users-table__sublabel')).toHaveText('✕ block ~Jun 15');

    // The five named scale-feature zero-usage users: "no usage yet this
    // cycle" persists post-sync (their persisted forecasts have a null
    // exhaustionDate, but the zero-usage rule takes precedence regardless).
    // Searched individually (see the pre-sync note above) rather than via the
    // "No usage" filter's 10/page pagination.
    for (const login of ['declan-ryan', 'devi-anand', 'jomo-mburu', 'nina-popov', 'tegan-ellis']) {
      await window.getByLabel('Search login').fill(login);
      const row = rows.filter({ hasText: login });
      await expect(row.locator('.users-table__login')).toHaveText(login);
      await expect(row.locator('.users-table__mtd')).toHaveText('0');
      await expect(row.locator('.users-table__sublabel')).toHaveText('no usage yet this cycle');
      await window.getByLabel('Search login').fill('');
    }

    // ext-dmorrow: the pre-existing $0-ULB rule still wins over any forecast
    // -- unaffected by this task, re-confirmed here since it shares
    // loginSublabel's precedence chain with the new block-date branch.
    await window.getByLabel('Search login').fill('ext-dmorrow');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.users-table__sublabel')).toHaveText('✕ blocked · $0 ULB');
    await window.getByLabel('Search login').fill('');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
