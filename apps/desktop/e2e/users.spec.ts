import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 2.4: Users screen -- read-only heavy-user table. Every asserted value
// is fixture-derived (packages/data/src/msw/fixtures/{usage,licenses,
// costCenters,budgets}.ts against the DEWR world, README.md in that
// directory), never wall-clock:
//   - 81 licensed seats (licenses.ts's SEATS) -> the full roster, not just
//     users with a usage row -> 9 pages at 10/page.
//   - ~36 users have June-cycle credits (usage.ts's CREDITS_USED_ITEMS rows);
//     every other seat is 0, including noah-tanaka whose only rows are the
//     Aug31/Sep1 cliff edge fixture (outside the June cycle window -- 0 MTD
//     this cycle, not a lifetime total).
//   - Ranked order (core's rankHeavyUsers, descending creditsUsed, ties by
//     ascending userId): emily-zhao 5,480, aran-mehta 5,210, liam-obrien
//     4,930, ... down through the roster, then all 0-credit users.
//   - ULB precedence (CLAUDE.md §5, packages/core's resolveEffectiveUlb):
//     rpatel2/Workforce Australia Platform has no individual override ->
//     Workforce's CCULB (budget-cculb-workforce, $52 -> 5,200 credits, "cost
//     center" scope). ext-dmorrow/Corporate Systems has the $0 individual ULB
//     edge fixture (budget-ulb-zero) -> always blocks, wins over the
//     universal fallback.
//   - "At risk" (>= 90% of effective ULB, or an immediate $0 block, core's
//     isUserAtRiskOfUlbBlock) cohort of 7: emily-zhao (91.3% of her 6,000
//     Data & Evaluation CCULB), sarah-huang (91.5% of the 5,200 Workforce
//     CCULB), hannah-webb (94.8% of the 4,600 universal ULB), ruby-carter
//     (93.3%), faisal-noor (90.9%), ext-pshah (90.5% of their 1,900
//     individual ULB), ext-dmorrow ($0-ULB, always blocked). 30 users are
//     "active" (nonzero MTD, not at risk); 44 have "no usage" this cycle
//     (noah-tanaka among them -- his cliff rows don't count).
test('Users table renders the ranked fixture roster with working search, filters, and pagination', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-users-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Navigate to the Users screen via the Task 2.5 nav shell.
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    const screen = window.locator('.users');
    await expect(screen).toBeVisible();

    const rows = screen.locator('.users-table__row');
    await expect(rows).toHaveCount(10); // page 1 of 81, 10/page

    // Default view: page 1 of the ranked roster -- descending MTD credits.
    const row1 = rows.nth(0);
    await expect(row1.locator('.users-table__login')).toHaveText('emily-zhao');
    await expect(row1.locator('.users-table__mtd')).toHaveText('5,480');

    // Signature components render real content for an active user, not just
    // an empty cell (Sparkline + ModelMixBar, design/README.md's "small
    // inline SVGs" -- hand-rolled, never a charting lib).
    await expect(row1.locator('svg.sparkline')).toHaveCount(1);
    await expect(row1.locator('.sparkline--empty')).toHaveCount(0);
    // The sparkline actually draws a polyline (non-empty path `d`), not a blank SVG.
    await expect(row1.locator('svg.sparkline path')).toHaveAttribute('d', /^M[\d.]/);
    // Model-mix caption is the exact fixture-derived value: emily-zhao's 5,480
    // credits decompose to GPT-5.1 2,056 (37%), Claude Sonnet 4.5 913 (17%),
    // Gemini 2.5 Pro 913 (17%), Claude Opus 4.5 685 (12%), and 913 (17%)
    // untagged -- the largest-remainder rounding (core's computeModelMix)
    // hands the leftover point to the three equal 16.66% shares before Opus's
    // 12.5%, landing Opus at 12 not 13. Caption leads with the top model + the
    // explicit unattributable remainder (design/README.md: never imply false
    // precision).
    await expect(row1.locator('.model-mix-bar__caption')).toHaveText('GPT-5.1 37% · 17% unattr');
    // 4 named-model segments + the unattributable segment = 5 drawn bars.
    await expect(row1.locator('.model-mix-bar__segment')).toHaveCount(5);
    await expect(row1.locator('.model-mix-bar--empty')).toHaveCount(0);

    const row2 = rows.nth(1);
    await expect(row2.locator('.users-table__login')).toHaveText('aran-mehta');
    await expect(row2.locator('.users-table__mtd')).toHaveText('5,210');
    const row3 = rows.nth(2);
    await expect(row3.locator('.users-table__login')).toHaveText('liam-obrien');
    await expect(row3.locator('.users-table__mtd')).toHaveText('4,930');

    // 81 users / 10 per page -> 9 pages.
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 9');
    await expect(screen.locator('.users__showing')).toHaveText('Showing 1–10 of 81');
    await expect(screen.locator('.users__result-count')).toHaveText('81 users');

    // Prev is disabled on page 1 (never color-only: also aria-disabled).
    await expect(screen.getByRole('button', { name: '‹ Prev' })).toBeDisabled();

    // Page 2: rank 11, diego-santos -- still a real, active user (the
    // top ~36 ranks are all nonzero-MTD, so page 2 doesn't yet reach the
    // zero-usage tail; that's covered by the "No usage" status filter below).
    await screen.getByRole('button', { name: 'Next ›' }).click();
    await expect(screen.locator('.users__page-label')).toHaveText('Page 2 / 9');
    await expect(rows.nth(0).locator('.users-table__login')).toHaveText('diego-santos');
    await expect(rows.nth(0).locator('.users-table__mtd')).toHaveText('4,080');
    await expect(rows.nth(0).locator('.users-table__sublabel')).toHaveCount(0);

    // Back to page 1 for the remaining assertions.
    await screen.getByRole('button', { name: '‹ Prev' }).click();
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 9');

    // Search narrows to exactly one row.
    await screen.getByLabel('Search login').fill('emily-zhao');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.users-table__login')).toHaveText('emily-zhao');
    await expect(screen.locator('.users__result-count')).toHaveText('1 user');
    await screen.getByLabel('Search login').fill('');
    await expect(screen.locator('.users__result-count')).toHaveText('81 users');

    // Cost-center filter narrows to that CC's members (Payments Integrity
    // Engineering = 8 members, small enough to fit on one page).
    await screen.getByLabel('Filter by cost center').selectOption('Payments Integrity Engineering');
    await expect(screen.locator('.users__result-count')).toHaveText('8 users');
    await expect(rows).toHaveCount(8);
    for (const row of await rows.all()) {
      // Task 4.13: the cost-center cell is now a reassignment <select> carrying
      // the current CC as its selected value.
      await expect(row.locator('.users-table__cc-select')).toHaveValue('Payments Integrity Engineering');
    }
    await screen.getByLabel('Filter by cost center').selectOption('all');

    // Status filter "No usage": every user with 0 MTD this cycle, including
    // noah-tanaka whose cliff-edge rows fall outside the June cycle window.
    await screen.getByRole('button', { name: 'No usage' }).click();
    await expect(screen.locator('.users__result-count')).toHaveText('44 users');
    const noahRow = rows.filter({ hasText: 'noah-tanaka' });
    await expect(noahRow.locator('.users-table__sublabel')).toHaveText('no usage yet this cycle');
    await expect(noahRow.locator('.users-table__mtd')).toHaveText('0');

    // Status filter "Active": nonzero-MTD users who aren't at risk.
    await screen.getByRole('button', { name: 'Active' }).click();
    await expect(screen.locator('.users__result-count')).toHaveText('30 users');

    // Status filter "At risk": >= 90% of the effective ULB, or an immediate
    // $0 block -- 7 users, including the $0-ULB edge fixture (ext-dmorrow),
    // always blocked (CLAUDE.md §5).
    await screen.getByRole('button', { name: 'At risk' }).click();
    await expect(screen.locator('.users__result-count')).toHaveText('7 users');
    await expect(rows).toHaveCount(7);
    const blockedRow = rows.filter({ hasText: 'ext-dmorrow' });
    await expect(blockedRow.locator('.users-table__login')).toHaveText('ext-dmorrow');
    await expect(blockedRow.locator('.users-table__ulb')).toHaveText('✕ $0 · blocked');
    await expect(blockedRow.locator('.users-table__sublabel')).toHaveText('✕ blocked · $0 ULB');

    // Back to "All" to check the ULB column for a normal (non-blocked) user.
    await screen.getByRole('button', { name: 'All' }).click();
    await screen.getByLabel('Search login').fill('rpatel2');
    await expect(rows).toHaveCount(1);
    // rpatel2/Workforce Australia Platform has no individual override ->
    // falls back to the Workforce CCULB ($52 -> 5,200 credits), not the
    // universal ULB.
    await expect(rows.nth(0).locator('.users-table__ulb')).toHaveText('5,200 · cost center');
    // Task 4.13 supersedes: the cost-center cell is now a reassignment <select>
    // (a 1:1 remove+add plan opens on change), so it carries the current CC as
    // the selected value rather than plain text.
    await expect(rows.nth(0).locator('.users-table__cc-select')).toHaveValue('Workforce Australia Platform');

    // Task 4.11 + 4.13 phase-supersede the "read-only screen" assertion this
    // test originally made (SPEC.md Assumption 4 was itself phase-scoped to the
    // MVP tables, not a permanent constraint): the table now carries the
    // checkbox per row (+ "Select all on page"), a per-row "Set ULB" button
    // (Task 4.11), AND a cost-center reassignment <select> (Task 4.13). The
    // originally-inverted "no <select> in any row" assertion is intentionally
    // flipped -- reassignment is now in scope and exercised in
    // cost-centers-lifecycle.spec.ts.
    await expect(screen.getByLabel('Select all on page')).toBeVisible();
    await expect(rows.getByRole('checkbox', { name: 'Select rpatel2' })).toBeVisible();
    await expect(rows.getByRole('button', { name: 'Set ULB' })).toBeVisible();
    await expect(screen.locator('.users-table__row select')).toHaveCount(1);
    await expect(rows.nth(0).getByLabel('Cost center for rpatel2')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// Task (page-size selector): 81 licensed seats total (licenses.ts's SEATS,
// recomputed here rather than copied -- see the header comment above), same
// roster the base test pins. Default page size is unchanged (10/page, 9
// pages) -- this test only exercises the NEW "Rows per page" control's
// effect on the pager math: 25/page over 81 users -> ceil(81/25) = 4 pages
// (25 + 25 + 25 + 6), so page 1 shows "Showing 1–25 of 81" with exactly 25
// rows rendered, and "Page 1 / 4".
test('Users table page-size selector updates the pager math', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-users-pagesize-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    const screen = window.locator('.users');
    await expect(screen).toBeVisible();

    const rows = screen.locator('.users-table__row');
    // Baseline: default page size is still 10 (unchanged behavior).
    await expect(rows).toHaveCount(10);
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 9');

    const pageSizeSelect = screen.getByTestId('users-page-size');
    await expect(pageSizeSelect).toHaveValue('10');

    await pageSizeSelect.selectOption('25');

    await expect(rows).toHaveCount(25);
    await expect(screen.locator('.users__showing')).toHaveText('Showing 1–25 of 81');
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 4');

    // Changing the page size resets to page 1 even from a later page.
    await screen.getByRole('button', { name: 'Next ›' }).click();
    await expect(screen.locator('.users__page-label')).toHaveText('Page 2 / 4');
    await pageSizeSelect.selectOption('50');
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 2');
    await expect(screen.locator('.users__showing')).toHaveText('Showing 1–50 of 81');
    await expect(rows).toHaveCount(50);

    // Last page of 50/page: 81 - 50 = 31 remaining rows.
    await screen.getByRole('button', { name: 'Next ›' }).click();
    await expect(screen.locator('.users__page-label')).toHaveText('Page 2 / 2');
    await expect(screen.locator('.users__showing')).toHaveText('Showing 51–81 of 81');
    await expect(rows).toHaveCount(31);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
