import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// "Controls scale features": the ULB and Spending-limits family tables gained
// free-text search, column-appropriate filters, sortable columns
// (name/cap/utilization), and 10/page pagination (Controls.tsx owns the
// state; UlbTable.tsx/ControlsTable.tsx render it -- see tableScale.ts +
// ScaleControls.tsx). The Caps grid gained a free-text name filter only (no
// sort/pagination at 6 cards). This file proves the new surface end to end
// AND proves staging survives it (CLAUDE.md's "staging integrity" ask):
// a staged edit/delete must never be lost by a search/filter/sort/page
// change, and a staged-NEW row (from the create modal) must stay
// discoverable even when the active filter would otherwise exclude it.
//
// Fixture basis: the "Controls scale fixtures" 5 individual ULBs added
// alongside this feature (packages/data/src/msw/fixtures/README.md,
// controls-ulb.spec.ts's header note) bring the ULB tab to 12 rows --
// universal + 2 CCULBs + 9 individuals. Default order (no search/filter/sort,
// ULB_SCOPE_ORDER-then-name) page 1 (10 rows): universal (dewr, 4,600), CCULB
// Data & Evaluation Platform (6,000), CCULB Workforce Australia Platform
// (5,200), then individuals alphabetically -- declan-ryan (2,500), devi-anand
// (3,300), ext-dmorrow (0), ext-pshah (1,900), jomo-mburu (2,900), liam-obrien
// (5,800), nina-popov (4,800); page 2 (2 rows): sam-kelly (5,400), tegan-ellis
// (3,700). Every cap across all 12 rows is distinct, so a cap sort never
// ties. The Spending tab is unaffected by the fixture addition (still 4 rows:
// enterprise 800,000/alert-only, organization 320,000/alert-only, cost_center
// Workforce 60,000/alert-only, cost_center Data & Evaluation 25,000/hard-stop
// -- the only hard-stop-ON row).

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

test('free-text search narrows the ULB tab to exactly the matching row', async () => {
  const { app, dbDir } = await launchApp('scale-ulb-search');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    const table = window.locator('.controls-table');

    await window.getByLabel('Search user-level budgets').fill('liam');
    await expect(table.locator('.controls-table__row')).toHaveCount(1);
    await expect(table.locator('.controls-table__row')).toHaveAttribute('data-control-id', 'budget:individual:liam-obrien');

    // Clearing the search restores page 1's full 10 rows.
    await window.getByLabel('Search user-level budgets').fill('');
    await expect(table.locator('.controls-table__row')).toHaveCount(10);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('scope filter narrows the ULB tab to exactly the 9 individual rows, no pager needed', async () => {
  const { app, dbDir } = await launchApp('scale-ulb-scope-filter');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    const table = window.locator('.controls-table');

    await window.getByLabel('Filter by scope').selectOption('individual');
    // 9 individual ULBs: the 4 original (ext-dmorrow, ext-pshah, liam-obrien,
    // sam-kelly) + the 5 controls-scale additions (declan-ryan, devi-anand,
    // jomo-mburu, nina-popov, tegan-ellis) -- fits on one page (9 <= 10), so
    // the pager renders nothing.
    await expect(table.locator('.controls-table__row')).toHaveCount(9);
    await expect(table.locator('.controls-ulb__apionly-pill')).toHaveCount(0); // CCULBs excluded
    await expect(table.locator('.controls-table__pagination')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('sort ULB rows by cap: ascending surfaces the global-min cap row first, toggling desc inverts to the global-max', async () => {
  const { app, dbDir } = await launchApp('scale-ulb-sort-cap');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    const table = window.locator('.controls-table');
    const capHeader = table.locator('[role="columnheader"]', { hasText: 'Cap (credits)' });

    await expect(capHeader).toHaveAttribute('aria-sort', 'none');

    await capHeader.getByRole('button').click();
    await expect(capHeader).toHaveAttribute('aria-sort', 'ascending');
    // Global min cap across all 12 ULB rows is ext-dmorrow's $0 ULB -- it
    // sorts to the very top of page 1 regardless of the 10/page cutoff
    // (the true "last" row when ascending, sam-kelly at 5,400 or the CCULB
    // at 6,000, sits on page 2, so this is the page-invariant boundary).
    await expect(table.locator('.controls-table__row').first()).toHaveAttribute('data-control-id', 'budget:individual:ext-dmorrow');

    await capHeader.getByRole('button').click();
    await expect(capHeader).toHaveAttribute('aria-sort', 'descending');
    // Global max cap is the Data & Evaluation CCULB's 6,000 -- inverted to the top.
    await expect(table.locator('.controls-table__row').first()).toHaveAttribute(
      'data-control-id',
      'budget:multi_user_cost_center:Data & Evaluation Platform',
    );
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('pagination: 12 ULB rows -> Page 1 of 2, Next reveals the 2 remaining rows (sam-kelly, tegan-ellis)', async () => {
  const { app, dbDir } = await launchApp('scale-ulb-pagination');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    const table = window.locator('.controls-table');

    await expect(table.locator('.controls-table__row')).toHaveCount(10);
    await expect(window.getByText('Page 1 / 2')).toBeVisible();
    const prevButton = window.getByRole('button', { name: '‹ Prev' });
    const nextButton = window.getByRole('button', { name: 'Next ›' });
    await expect(prevButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();

    await nextButton.click();
    await expect(table.locator('.controls-table__row')).toHaveCount(2);
    await expect(table.locator('[data-control-id="budget:individual:sam-kelly"]')).toBeVisible();
    await expect(table.locator('[data-control-id="budget:individual:tegan-ellis"]')).toBeVisible();
    await expect(window.getByText('Page 2 / 2')).toBeVisible();
    await expect(nextButton).toBeDisabled();
    await expect(prevButton).toBeEnabled();

    await prevButton.click();
    await expect(table.locator('.controls-table__row')).toHaveCount(10);
    await expect(window.getByText('Page 1 / 2')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('a staged ULB edit survives being filtered out: the honesty note appears, then the marker + value return when the filter clears', async () => {
  const { app, dbDir } = await launchApp('scale-ulb-staged-survives');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    const table = window.locator('.controls-table');
    const deviRow = table.locator('[data-control-id="budget:individual:devi-anand"]');

    await deviRow.getByLabel('Cap (credits) — Individual · devi-anand').fill('4000');
    await expect(deviRow.getByText('● staged change')).toBeVisible();
    await expect(window.locator('.controls__hidden-staged-note')).toHaveCount(0);

    // Filter to Universal scope -- devi-anand (individual) drops out of view.
    await window.getByLabel('Filter by scope').selectOption('universal');
    await expect(table.locator('[data-control-id="budget:individual:devi-anand"]')).toHaveCount(0);
    await expect(window.locator('.controls__hidden-staged-note')).toContainText(
      '1 staged change not shown by the current search/filter/page',
    );

    // Clear the filter -- the row, its staged marker, and the edited value all return.
    await window.getByLabel('Filter by scope').selectOption('all');
    await expect(deviRow.getByText('● staged change')).toBeVisible();
    await expect(deviRow.getByLabel('Cap (credits) — Individual · devi-anand')).toHaveValue('4000');
    await expect(window.locator('.controls__hidden-staged-note')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('a staged-NEW ULB row stays visible + discoverable even under a scope filter that would otherwise exclude it', async () => {
  const { app, dbDir } = await launchApp('scale-ulb-staged-new-visible');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    const table = window.locator('.controls-table');

    await window.getByRole('button', { name: '+ New user-level budget' }).click();
    const modal = window.locator('.new-ulb-modal');
    await modal.locator('#new-ulb-scope').selectOption('individual');
    await modal.locator('#new-ulb-entity').selectOption('rpatel2');
    await modal.getByLabel('Cap (credits) — new user-level budget').fill('5000');
    await modal.getByRole('button', { name: 'Create' }).click();
    await expect(modal).toHaveCount(0);

    const newRow = table.locator('[data-control-id="budget:individual:rpatel2"]');
    await expect(newRow).toBeVisible();

    // Filter to Universal scope -- would normally exclude an individual row,
    // but staged-NEW rows bypass every filter/sort/page (pinned above the
    // paginated body, "Controls scale features"'s simplest-honest-treatment
    // decision: a freshly-created row can never vanish from an unrelated
    // filter change).
    await window.getByLabel('Filter by scope').selectOption('universal');
    await expect(newRow).toBeVisible();
    await expect(newRow.getByText('● staged: new')).toBeVisible();
    // And it never counts toward the hidden-staged note -- it's never hidden.
    await expect(window.locator('.controls__hidden-staged-note')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('enforcement filter on the Spending tab narrows to the one hard-stop-ON row (Data & Evaluation Platform)', async () => {
  const { app, dbDir } = await launchApp('scale-spending-enforcement-filter');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    await window.getByRole('tab', { name: 'Spending limits' }).click();
    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(4);

    await window.getByLabel('Filter by enforcement').selectOption('hard');
    await expect(table.locator('.controls-table__row')).toHaveCount(1);
    await expect(table.locator('[data-control-id="budget:cost_center:Data & Evaluation Platform"]')).toBeVisible();

    await window.getByLabel('Filter by enforcement').selectOption('alert');
    await expect(table.locator('.controls-table__row')).toHaveCount(3);
    await expect(table.locator('[data-control-id="budget:cost_center:Data & Evaluation Platform"]')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('free-text name filter narrows the Included-usage caps grid', async () => {
  const { app, dbDir } = await launchApp('scale-caps-search');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);
    await window.getByRole('tab', { name: 'Included-usage caps' }).click();
    const grid = window.locator('.included-caps__grid');
    await expect(grid.locator('.included-caps__card')).toHaveCount(6);

    await window.getByLabel('Search included-usage caps').fill('payments');
    await expect(grid.locator('.included-caps__card')).toHaveCount(1);
    await expect(grid.locator('[data-control-id="included_cap:Payments Integrity Engineering"]')).toBeVisible();

    await window.getByLabel('Search included-usage caps').fill('zzz-no-match');
    await expect(grid.locator('.included-caps__card')).toHaveCount(0);
    await expect(window.getByText('No cost centers match this search.')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
