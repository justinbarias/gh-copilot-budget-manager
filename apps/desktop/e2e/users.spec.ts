import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 2.4: Users screen -- read-only heavy-user table. Every asserted value
// is fixture-derived (packages/data/src/msw/fixtures/{usage,licenses,
// costCenters,budgets}.ts), never wall-clock:
//   - 35 licensed seats (licenses.ts's SEATS) -> the full roster, not just
//     users with a usage row -> 4 pages at 10/page.
//   - Only user-01 (420), user-16 (310), user-26 (500) have June-cycle credits
//     (usage.ts's decomposed CREDITS_USED_ITEMS rows); every other user is 0,
//     including user-05 whose only rows are the Aug31/Sep1 cliff edge fixture
//     (outside the June cycle window -- 0 MTD this cycle, not a lifetime total).
//   - Ranked order (core's rankHeavyUsers, descending creditsUsed, ties by
//     ascending userId/login): user-26, user-01, user-16, then all 0-credit
//     users in ascending login order.
//   - ULB precedence (CLAUDE.md §5, packages/core's resolveEffectiveUlb):
//     user-01/Platform CC has no individual override -> Platform's CCULB
//     (budget-cculb-platform-1, $45 -> 4,500 credits, "cost center" scope).
//     user-20/Data & Analytics has the $0 individual ULB edge fixture
//     (budget-ulb-zero-1) -> always blocks, wins over the universal fallback.
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

    // Screen is reachable (stacked below Cost Centers -- no nav shell until Task 2.5).
    const screen = window.locator('.users');
    await expect(screen).toBeVisible();

    const rows = screen.locator('.users-table__row');
    await expect(rows).toHaveCount(10); // page 1 of 35, 10/page

    // Default view: page 1 of the ranked roster -- descending MTD, ties broken
    // ascending by userId (== ascending login for this fixture's numbering).
    const row1 = rows.nth(0);
    await expect(row1.locator('.users-table__login')).toHaveText('user-26');
    await expect(row1.locator('.users-table__mtd')).toHaveText('500');

    // Signature components render real content for an active user, not just
    // an empty cell (Sparkline + ModelMixBar, design/README.md's "small
    // inline SVGs" -- hand-rolled, never a charting lib).
    await expect(row1.locator('svg.sparkline')).toHaveCount(1);
    await expect(row1.locator('.sparkline--empty')).toHaveCount(0);
    // The sparkline actually draws a polyline (non-empty path `d`), not a blank SVG.
    await expect(row1.locator('svg.sparkline path')).toHaveAttribute('d', /^M[\d.]/);
    // Model-mix caption is the exact fixture-derived value: user-26's 500 credits
    // decompose to 140 GPT-5.4 (28%), 110 Sonnet 4.6 (22%), 90 GPT-5 mini (18%),
    // 160 unattributable (32%) -- caption leads with the top model + the explicit
    // unattributable remainder (design/README.md: never imply false precision).
    await expect(row1.locator('.model-mix-bar__caption')).toHaveText('GPT-5.4 28% · 32% unattr');
    // 3 named-model segments + the unattributable segment = 4 drawn bars.
    await expect(row1.locator('.model-mix-bar__segment')).toHaveCount(4);
    await expect(row1.locator('.model-mix-bar--empty')).toHaveCount(0);

    const row2 = rows.nth(1);
    await expect(row2.locator('.users-table__login')).toHaveText('user-01');
    await expect(row2.locator('.users-table__mtd')).toHaveText('420');
    const row3 = rows.nth(2);
    await expect(row3.locator('.users-table__login')).toHaveText('user-16');
    await expect(row3.locator('.users-table__mtd')).toHaveText('310');

    // 35 users / 10 per page -> 4 pages.
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 4');
    await expect(screen.locator('.users__showing')).toHaveText('Showing 1–10 of 35');
    await expect(screen.locator('.users__result-count')).toHaveText('35 users');

    // Prev is disabled on page 1 (never color-only: also aria-disabled).
    await expect(screen.getByRole('button', { name: '‹ Prev' })).toBeDisabled();

    // Page 2: first row is the next user in rank order after the 3 active
    // users and the first 7 zero-credit users (ascending login) -- user-09.
    await screen.getByRole('button', { name: 'Next ›' }).click();
    await expect(screen.locator('.users__page-label')).toHaveText('Page 2 / 4');
    await expect(rows.nth(0).locator('.users-table__login')).toHaveText('user-09');
    await expect(rows.nth(0).locator('.users-table__mtd')).toHaveText('0');
    await expect(rows.nth(0).locator('.users-table__sublabel')).toHaveText('no usage yet this cycle');

    // Back to page 1 for the remaining assertions.
    await screen.getByRole('button', { name: '‹ Prev' }).click();
    await expect(screen.locator('.users__page-label')).toHaveText('Page 1 / 4');

    // Search narrows to exactly one row.
    await screen.getByLabel('Search login').fill('user-26');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.users-table__login')).toHaveText('user-26');
    await expect(screen.locator('.users__result-count')).toHaveText('1 user');
    await screen.getByLabel('Search login').fill('');
    await expect(screen.locator('.users__result-count')).toHaveText('35 users');

    // Cost-center filter narrows to that CC's 10 members (Data & Analytics = user-16..25).
    await screen.getByLabel('Filter by cost center').selectOption('Data & Analytics');
    await expect(screen.locator('.users__result-count')).toHaveText('10 users');
    await expect(rows).toHaveCount(10);
    for (const row of await rows.all()) {
      await expect(row.locator('.users-table__cc')).toHaveText('Data & Analytics');
    }
    await screen.getByLabel('Filter by cost center').selectOption('all');

    // Status filter "No usage": every user with 0 MTD this cycle, including
    // user-05 whose cliff-edge rows fall outside the June cycle window.
    await screen.getByRole('button', { name: 'No usage' }).click();
    await expect(screen.locator('.users__result-count')).toHaveText('31 users');
    const user05Row = rows.filter({ hasText: 'user-05' });
    await expect(user05Row.locator('.users-table__sublabel')).toHaveText('no usage yet this cycle');
    await expect(user05Row.locator('.users-table__mtd')).toHaveText('0');

    // Status filter "Active": the 3 users with real June-cycle usage.
    await screen.getByRole('button', { name: 'Active' }).click();
    await expect(screen.locator('.users__result-count')).toHaveText('3 users');
    await expect(rows).toHaveCount(3);

    // Status filter "At risk": the $0-ULB edge fixture (user-20) -- always
    // blocked (CLAUDE.md §5), the only user meeting the at-risk/blocked rule
    // in this fixture set.
    await screen.getByRole('button', { name: 'At risk' }).click();
    await expect(screen.locator('.users__result-count')).toHaveText('1 user');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.users-table__login')).toHaveText('user-20');
    await expect(rows.nth(0).locator('.users-table__ulb')).toHaveText('✕ $0 · blocked');
    await expect(rows.nth(0).locator('.users-table__sublabel')).toHaveText('✕ blocked · $0 ULB');

    // Back to "All" to check the ULB column for a normal (non-blocked) user.
    await screen.getByRole('button', { name: 'All' }).click();
    await screen.getByLabel('Search login').fill('user-01');
    await expect(rows).toHaveCount(1);
    // user-01/Platform CC has no individual override -> falls back to the
    // Platform CCULB ($45 -> 4,500 credits), not the universal ULB.
    await expect(rows.nth(0).locator('.users-table__ulb')).toHaveText('4,500 · cost center');
    await expect(rows.nth(0).locator('.users-table__cc')).toHaveText('Platform');

    // Read-only screen (SPEC.md Assumption 4): no checkbox multi-select, no
    // "Set ULB" action, no cost-center reassignment <select> anywhere.
    await expect(window.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(window.getByRole('button', { name: /set ulb/i })).toHaveCount(0);
    await expect(window.getByText('Set ULB for selected')).toHaveCount(0);
    await expect(screen.locator('.users-table__row select')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
