import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 4.14 (PRD FR3 / CLAUDE.md §5's ULB display-bug domain fact): the
// violet ULB-repair banner on the Controls screen's User-level family tab.
// Detection (packages/core/src/ulbRepair.ts, fed by the SAME getControls()
// ControlState[] the tab already holds -- no dedicated fetch) finds exactly
// the DEWR fixture world's 2 edge fixtures:
//   - liam-obrien's individual ULB (BUDGET_IDS.ulbDisplayBug, $58 -> 5,800
//     credits) -- flagged 'display_bug_hidden' via the simulatedUiHidden
//     enrichment (packages/data/src/msw/fixtures/budgets.ts;
//     docs/api-surface-validation.md's "ULB display-bug detection signal"
//     entry -- real GitHub has no field reporting this, so this candidate
//     kind is simulation-only today, a documented limitation, not a gap in
//     this test).
//   - ext-dmorrow's individual ULB (BUDGET_IDS.zeroUlb, $0) -- flagged
//     'orphaned_zero' via the real, always-present wire signal (amount <= 0
//     + hard-stop); this one would fire identically live.
// Banner copy therefore reads "2 orphaned user-level budgets detected —
// in the API, invisible in GitHub's UI" (matching design/*.dc.html's own
// literal copy, which happens to also say "2").
//
// The healthy-list negative case ("healthy fixtures show no banner") is NOT
// re-proven here -- the running app has exactly one fixture world today (no
// Healthy/At-risk/Surplus scenario selector yet; that's Task 6.7). It's
// proven as a pure unit test instead: packages/core/src/ulbRepair.test.ts's
// "the healthy-list negative case" describe block. Flagged explicitly, per
// Task 4.14's build brief, rather than silently assumed.

async function launchApp(dbLabel: string) {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), `copilot-budget-e2e-${dbLabel}-`));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });
  return { app, dbDir };
}

async function openControlsUlb(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Controls');
  await expect(window.getByText('Always a hard stop — a $0 ULB blocks immediately.')).toBeVisible();
}

test('the repair banner renders on the ULB tab with the fixture-derived count, reasons, and both repair actions', async () => {
  const { app, dbDir } = await launchApp('repair-banner-renders');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const banner = window.locator('.ulb-repair-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('2 orphaned user-level budgets detected — in the API, invisible in GitHub\'s UI');
    // The banner's explanatory copy IS the user-facing "reason" (the exact
    // per-candidate `reason` strings core's detectUlbRepairCandidates
    // produces are pinned instead in packages/core/src/ulbRepair.test.ts and
    // packages/data/src/api-client/ulb-repair.test.ts -- this screen
    // deliberately shows one generic explanation per design/*.dc.html's own
    // literal markup, not a per-candidate breakdown it never specifies).
    await expect(banner).toContainText('A known GitHub display bug hides these from the "Budgets and alerts" list');
    await expect(banner).toContainText('one is a');
    await expect(banner.locator('.mono')).toHaveText('$0');
    await expect(banner).toContainText('ULB that hard-blocks its owner immediately');
    await expect(banner).toContainText("This tool reads the API's authoritative list and offers the repair the native UI can't.");

    await expect(banner.getByRole('button', { name: 'View & edit via API' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Delete the $0 ULB' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Dismiss orphaned ULB notice' })).toBeVisible();

    // Only the Controls/user-level tab renders it -- never spending or caps.
    await window.getByRole('tab', { name: 'Spending limits' }).click();
    await expect(window.locator('.ulb-repair-banner')).toHaveCount(0);
    await window.getByRole('tab', { name: 'Included-usage caps' }).click();
    await expect(window.locator('.ulb-repair-banner')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('"View & edit via API" clears an active search AND navigates to the page containing liam-obrien\'s row under the active sort, then highlights it', async () => {
  const { app, dbDir } = await launchApp('repair-view-edit');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const banner = window.locator('.ulb-repair-banner');
    const liamRow = table.locator('[data-control-id="budget:individual:liam-obrien"]');

    // Sort by cap ascending: liam-obrien's 5,800-credit cap is the 11th of
    // 12 rows (page 2 of 2) -- see this file's header derivation. "View &
    // edit" only clears search/scope filter (design brief), not sort, so
    // this sort stays active through the click below.
    const capHeader = table.locator('[role="columnheader"]', { hasText: 'Cap (credits)' });
    await capHeader.getByRole('button').click();
    await expect(capHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(liamRow).toHaveCount(0); // on page 2, not page 1

    // ALSO narrow with a search that hides him further (proves the
    // search-clearing half of "clears the tab's filters/search").
    await window.getByLabel('Search user-level budgets').fill('nina');
    await expect(table.locator('.controls-table__row')).toHaveCount(1);
    await expect(liamRow).toHaveCount(0);

    await banner.getByRole('button', { name: 'View & edit via API' }).click();

    // Search cleared.
    await expect(window.getByLabel('Search user-level budgets')).toHaveValue('');
    // Landed on page 2 of 2 (the sort is kept, unfiltered by the now-cleared search).
    await expect(table.locator('.controls-table__page-label')).toHaveText('Page 2 / 2');
    // The target row is visible and highlighted.
    await expect(liamRow).toBeVisible();
    await expect(liamRow).toHaveClass(/controls-ulb__row--repair-highlight/);

    // A genuine follow-up interaction (not the repair navigation itself)
    // clears the highlight.
    await window.getByLabel('Search user-level budgets').fill('liam');
    await expect(liamRow).not.toHaveClass(/controls-ulb__row--repair-highlight/);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('"Delete the $0 ULB" stages the SAME delete the row\'s own button would, through the standard plan -> dry-run -> apply rail', async () => {
  const { app, dbDir } = await launchApp('repair-delete-zero');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const banner = window.locator('.ulb-repair-banner');
    const rail = window.locator('.plan-rail');
    const extDmorrowRow = table.locator('[data-control-id="budget:individual:ext-dmorrow"]');

    await expect(window.getByText('No staged changes')).toBeVisible();

    await banner.getByRole('button', { name: 'Delete the $0 ULB' }).click();

    // Staged exactly like a row-button delete (Task 4.10's mechanism) --
    // same marker, same undo affordance, same diff line.
    await expect(extDmorrowRow.getByText('● staged: delete')).toBeVisible();
    await expect(extDmorrowRow.getByRole('button', { name: '⤺ undo delete' })).toBeVisible();
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('- individual["ext-dmorrow"]: cap 0');

    // Idempotent: clicking the banner action again does NOT toggle the
    // delete back off (unlike the row's own button, which does toggle) --
    // a repeat click must never silently undo an already-staged repair.
    await banner.getByRole('button', { name: 'Delete the $0 ULB' }).click();
    await expect(extDmorrowRow.getByText('● staged: delete')).toBeVisible();
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // Same fixture-derived preview as controls-ulb.spec.ts's row-button
    // delete test: ext-dmorrow has 0 MTD usage against his live $0 ULB
    // (blocked at the boundary, 0 - 0 <= 0), and falls back to Corporate
    // Systems' 4,600-credit universal ULB once the $0 override is removed
    // -> newly UNBLOCKED.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('1');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-users')).toHaveText('ext-dmorrow');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: repair banner -- remove the orphaned $0 ULB');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('DELETE');
    await expect(applied).toContainText('/settings/billing/budgets/budget-ulb-zero');
    await expect(applied).toContainText('budget.delete');
    await expect(applied).toContainText('budget:individual:ext-dmorrow');
    // §6.8 simulation-mode safety: the apply reads as visibly simulated, never live.
    await expect(window.locator('.controls-toast')).toContainText(/Simulated apply/i);

    // onApply's refreshLive() re-fetches getControls() after a successful
    // apply (Controls.tsx), and the banner is DERIVED from that live list --
    // proven here by the banner still rendering correctly post-apply.
    // It still shows BOTH candidates, unchanged: MSW is a deliberately
    // STATELESS mock (CLAUDE.md §7 -- "e2e asserts on the request issued...
    // not cross-request persistence"), so the DELETE handler
    // (packages/data/src/msw/handlers.ts) returns 204 without actually
    // removing the entry from the canonical BUDGETS fixture -- the same
    // reason controls-ulb.spec.ts's row-button delete test never asserts
    // the row disappears from a subsequent GET either. This is a real,
    // deliberate limitation of the shared mock, not this feature.
    await expect(banner).toContainText('2 orphaned user-level budgets detected');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('dismiss hides the banner, survives a family-tab switch and return, and (fresh launch) reappears', async () => {
  const { app, dbDir } = await launchApp('repair-dismiss');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const banner = window.locator('.ulb-repair-banner');
    await expect(banner).toBeVisible();

    await banner.getByRole('button', { name: 'Dismiss orphaned ULB notice' }).click();
    await expect(banner).toHaveCount(0);

    // Survives switching to another family tab and back -- Controls.tsx
    // stays mounted across family-tab switches, so this is plain session
    // state, not re-fetched/re-derived.
    await window.getByRole('tab', { name: 'Spending limits' }).click();
    await window.getByRole('tab', { name: 'User-level budgets' }).click();
    await expect(banner).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('a fresh app launch shows the banner again (dismissal is session-only, never persisted)', async () => {
  // A separate `launchApp` call is a brand-new Electron process/React root --
  // this is what "resets on relaunch" actually means, distinct from the
  // family-tab-switch case above (same process, same React tree).
  const { app, dbDir } = await launchApp('repair-fresh-launch');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    await expect(window.locator('.ulb-repair-banner')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
