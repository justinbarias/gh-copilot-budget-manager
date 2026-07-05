import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page, type Locator } from '@playwright/test';

// Task 4.11: Users screen write affordances -- per-row "Set ULB" (individual-
// ULB modal) and multi-select -> bulk-ULB modal, BOTH routed through the same
// staged -> simulate -> apply plan Task 4.9/4.10 built for Controls (a modal
// is just a scoped plan -- see packages/ui/src/screens/Users/UlbPlanModal.tsx).
//
// Every value below is fixture-derived (packages/data/src/msw/fixtures/
// {budgets,usage,costCenters,constants}.ts, README.md in that directory),
// never observed output.
//
// Task 4.11b (CLAUDE.md §6.1 preview-fidelity fix, docs/pending/todo.md's
// REQUIRED pre-Checkpoint-4 line): simulatePlan's blocked/unblocked math
// reads usageState.users, which write/live-state.ts's assembleUsageState used
// to build ONLY from the enterprise billing-usage report
// (`/settings/billing/usage`, usage.ts's USAGE_ITEMS) -- a report that carries
// per-user rows for exactly TWO logins in this whole fixture world
// (faisal-noor, noah-tanaka). None of the users this file edits was either of
// those two, so every dry-run here used to honestly-but-misleadingly report
// 0/0 regardless of the amount staged. assembleUsageState now ALSO folds in
// the per-user metrics/CREDITS_USED report (the same one the Users screen's
// own MTD/at-risk numbers already read) over the full 81-seat roster
// (write/live-state.test.ts pins the fold itself) -- so the dry-runs below
// now correctly move real users' blocked status, not just faisal-noor's/
// noah-tanaka's. Individual-scope budget changes are still excluded from
// simulatePlan's scope-delta rollup entirely (core/simulate.ts's
// toScopeDeltaTarget returns null for 'individual') -- so no pool/metered Δ
// row ever renders for these plans, fold or no fold.
//
//   - hannah-webb: Employer & Provider Portals (no CCULB there) -> no
//     individual override -> falls back to the universal ULB (4,600
//     credits). 4,360 MTD credits (June-cycle CREDITS_USED_ITEMS rows:
//     1,453 + 1,211 + 969 + 727), the same "at risk" fixture users.spec.ts
//     already exercises -- comfortably under 4,600, so she is NOT blocked
//     today. No individual ULB exists for her -> Set ULB is a CREATE (a `+`
//     plan entry, a POST mutation). Staged at 3,000 (below her 4,360 MTD):
//     an individual override outranks the universal fallback (CLAUDE.md §5),
//     so 3,000 − 4,360 <= 0 -> she is NEWLY BLOCKED by this plan -- the
//     dry-run now correctly shows 1 newly-blocked, not the old 0/0.
//   - ext-pshah: an existing individual ULB, budget-ulb-contractor-pshah,
//     $19 -> 1,900 credits (BUDGET_IDS.individualContractor) -> Set ULB is a
//     CHANGE (a `~` plan entry, a PATCH to that exact budget id). 1,720 MTD
//     credits (860 + 344 + 516) is under BOTH 1,900 (today) and 2,400 (the
//     staged raise) -> stays unblocked before and after -- correctly 0/0,
//     computed for real this time rather than accidentally.
//   - Bulk: the top 3 rows on page 1 of the default (descending-MTD) sort --
//     emily-zhao (5,480), aran-mehta (5,210), liam-obrien (4,930). Both
//     emily-zhao and aran-mehta are Data & Evaluation Platform members with
//     no individual override (their effective ULB is that CC's 6,000-credit
//     CCULB, under which neither is blocked today: 5,480 < 6,000, 5,210 <
//     6,000) -> CREATEs; liam-obrien already has an individual override
//     (budget-ulb-display-bug, $58 -> 5,800 credits, the ULB-display-bug
//     fixture, also unblocked today: 4,930 < 5,800) -> a CHANGE. One staged
//     value (5,000 credits -> $50) thus produces 2 POSTs + 1 PATCH = 3
//     mutations and 3 audit events, exactly Task 4.11's "an N-user bulk apply
//     issues N budget mutations" -- and, deliberately, a MIXED create/change
//     batch, not a homogeneous one. Post-fold, staging 5,000 for all three
//     newly blocks emily-zhao (5,000 − 5,480 <= 0) and aran-mehta (5,000 −
//     5,210 <= 0) but NOT liam-obrien (5,000 − 4,930 = 70 > 0, still
//     headroom) -- 2 newly-blocked, 0 newly-unblocked.
//   - creditsToUsd: budget_amount = credits / 100 (CLAUDE.md §5): 3,000 ->
//     $30; 2,400 -> $24; 5,000 -> $50.

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

async function openUsers(window: Page): Promise<Locator> {
  await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
  const screen = window.locator('.users');
  await expect(screen).toBeVisible();
  return screen;
}

test('row "Set ULB" CREATEs a new individual ULB (hannah-webb): real dry-run (honestly 0/0, not the design\'s fake heuristic), POST payload, audit event, simulated-apply treatment', async () => {
  const { app, dbDir } = await launchApp('users-ulb-create');
  try {
    const window = await app.firstWindow();
    const screen = await openUsers(window);

    await screen.getByLabel('Search login').fill('hannah-webb');
    const row = screen.locator('.users-table__row').filter({ hasText: 'hannah-webb' });
    await expect(row).toHaveCount(1);
    // Baseline: no individual override yet -- her ULB column reads the
    // universal fallback.
    await expect(row.locator('.users-table__ulb')).toHaveText('4,600 · universal');

    await row.getByRole('button', { name: 'Set ULB' }).click();
    const modal = window.locator('.ulb-plan-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Individual ULB override');
    await expect(modal).toContainText('hannah-webb');
    // Current-effective-ULB line, shown before any edit (design §6: "current
    // effective ULB shown, amount + scope provenance").
    await expect(modal.getByText('Current effective ULB')).toBeVisible();
    await expect(modal.locator('.ulb-plan-modal__current-row').getByText('4,600 · universal')).toBeVisible();

    const amountInput = modal.getByLabel('New per-user limit (credits)');
    await expect(amountInput).toHaveValue('4600'); // prefilled from her current effective ULB

    // Staged BELOW her 4,360 MTD -- the exact case a naive/fake heuristic
    // would call "blocked now" (see file header). Individual is a brand new
    // control for her -> an `add` plan entry.
    await amountInput.fill('3000');

    const rail = modal.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('+ individual["hannah-webb"]: cap 3,000 · hard-stop');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // The REAL simulation, correctly: staging 3,000 below her 4,360 MTD
    // newly blocks hannah-webb (see file header) -- exactly the case a naive
    // client-side heuristic would ALSO call "blocked now", but this time
    // simulatePlan agrees, for the right reason (an individual override that
    // outranks her universal fallback, evaluated against her real MTD burn
    // from the folded metrics report).
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('1');
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-users')).toHaveText('hannah-webb');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);
    // Individual-scope changes never roll up to a pool-phase delta row.
    await expect(rail.locator('.plan-rail__sim-delta', { hasText: 'pool-phase' })).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: hannah-webb approaching the universal ULB, grant personal headroom');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('Simulated apply');
    await expect(applied).toContainText('POST');
    await expect(applied).toContainText('/settings/billing/budgets');
    await expect(applied).toContainText('budget.create');
    await expect(applied).toContainText('budget:individual:hannah-webb');
    await expect(rail.locator('.plan-rail__audit')).toHaveCount(1);

    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    expect(parsedBody).toStrictEqual({
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_scope: 'individual',
      budget_entity_name: 'hannah-webb',
      budget_amount: 30,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] },
    });

    // §6.8: never lets a simulated apply look live -- the modal's own result
    // panel says so, and the Users screen's toast repeats it.
    await expect(window.locator('.users-toast')).toContainText('◆ Simulated apply — ULB updated for hannah-webb.');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('row "Set ULB" CHANGEs an existing individual ULB (ext-pshah): PATCH to the exact fixture budget id + audit event', async () => {
  const { app, dbDir } = await launchApp('users-ulb-edit');
  try {
    const window = await app.firstWindow();
    const screen = await openUsers(window);

    await screen.getByLabel('Search login').fill('ext-pshah');
    const row = screen.locator('.users-table__row').filter({ hasText: 'ext-pshah' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.users-table__ulb')).toHaveText('1,900 · individual');

    await row.getByRole('button', { name: 'Set ULB' }).click();
    const modal = window.locator('.ulb-plan-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.ulb-plan-modal__current-row').getByText('1,900 · individual')).toBeVisible();

    const amountInput = modal.getByLabel('New per-user limit (credits)');
    await expect(amountInput).toHaveValue('1900'); // prefilled from her existing individual ULB

    await amountInput.fill('2400');

    const rail = modal.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ individual["ext-pshah"].cap: 1,900 → 2,400');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // Correctly 0/0: her 1,720 MTD (folded from the metrics report -- see
    // file header) sits under BOTH 1,900 (today) and 2,400 (staged) -- never
    // blocked, before or after.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: ext-pshah raise -- approved contractor extension');
    await rail.getByRole('button', { name: /Apply changes/ }).click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('PATCH');
    // The exact fixture budget id (BUDGET_IDS.individualContractor) -- not a
    // guessed/derived one.
    await expect(applied).toContainText('/settings/billing/budgets/budget-ulb-contractor-pshah');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:individual:ext-pshah');
    await expect(rail.locator('.plan-rail__audit')).toHaveCount(1);

    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    // Only amountCredits changed -- the PATCH carries just budget_amount,
    // preserving ext-pshah's existing alerting/enforcement untouched.
    expect(parsedBody).toStrictEqual({ budget_amount: 24 });

    await expect(window.locator('.users-toast')).toContainText('◆ Simulated apply — ULB updated for ext-pshah.');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('bulk-select the top 3 users on page 1: one staged value produces 2 creates + 1 change -> 3 mutations + 3 audit events, selection clears', async () => {
  const { app, dbDir } = await launchApp('users-ulb-bulk');
  try {
    const window = await app.firstWindow();
    const screen = await openUsers(window);

    const rows = screen.locator('.users-table__row');
    await expect(rows).toHaveCount(10);
    await expect(rows.nth(0).locator('.users-table__login')).toHaveText('emily-zhao');
    await expect(rows.nth(1).locator('.users-table__login')).toHaveText('aran-mehta');
    await expect(rows.nth(2).locator('.users-table__login')).toHaveText('liam-obrien');

    await rows.nth(0).getByRole('checkbox', { name: 'Select emily-zhao' }).check();
    await rows.nth(1).getByRole('checkbox', { name: 'Select aran-mehta' }).check();
    await rows.nth(2).getByRole('checkbox', { name: 'Select liam-obrien' }).check();

    await expect(screen.locator('.users__bulk-bar')).toBeVisible();
    await expect(screen.locator('.users__bulk-label')).toHaveText('3 selected');

    await screen.getByRole('button', { name: 'Set ULB for selected' }).click();
    const modal = window.locator('.ulb-plan-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Bulk ULB — 3 users');

    // Current-effective-ULB list, one row per selected user, before any edit.
    await expect(modal.locator('.ulb-plan-modal__current-row')).toHaveCount(3);
    await expect(modal.locator('.ulb-plan-modal__current-row').filter({ hasText: 'emily-zhao' })).toContainText(
      '6,000 · cost center',
    );
    await expect(modal.locator('.ulb-plan-modal__current-row').filter({ hasText: 'aran-mehta' })).toContainText(
      '6,000 · cost center',
    );
    await expect(modal.locator('.ulb-plan-modal__current-row').filter({ hasText: 'liam-obrien' })).toContainText(
      '5,800 · individual',
    );

    const amountInput = modal.getByLabel('New per-user limit for all selected (credits)');
    await expect(amountInput).toHaveValue(''); // no single honest default across 3 heterogeneous users
    await expect(modal.getByText('No staged changes')).toBeVisible(); // nothing staged yet

    await amountInput.fill('5000');

    const rail = modal.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(3);
    // Sorted by plan identity (alphabetical): aran-mehta, emily-zhao, liam-obrien.
    await expect(rail.locator('.plan-rail__diff-line').nth(0)).toHaveText('+ individual["aran-mehta"]: cap 5,000 · hard-stop');
    await expect(rail.locator('.plan-rail__diff-line').nth(1)).toHaveText('+ individual["emily-zhao"]: cap 5,000 · hard-stop');
    await expect(rail.locator('.plan-rail__diff-line').nth(2)).toHaveText('~ individual["liam-obrien"].cap: 5,800 → 5,000');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // emily-zhao (5,000 - 5,480 <= 0) and aran-mehta (5,000 - 5,210 <= 0) are
    // newly blocked; liam-obrien keeps 70 credits of headroom (5,000 - 4,930)
    // and stays unblocked (see file header) -- sorted alphabetically, same
    // ordering as the diff lines above.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('2');
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-users')).toHaveText('aran-mehta, emily-zhao');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: bulk-normalize top-3 heavy users to a 5,000-credit ceiling');
    await rail.getByRole('button', { name: /Apply changes/ }).click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('3 changes issued');

    // Three mutations, exactly Task 4.11's "an N-user bulk apply issues N
    // budget mutations" -- 2 POST creates + 1 PATCH change, in plan order.
    const mutations = rail.locator('.plan-rail__mutation');
    await expect(mutations).toHaveCount(3);
    await expect(mutations.nth(0)).toContainText('POST');
    await expect(mutations.nth(0)).toContainText('/settings/billing/budgets');
    await expect(mutations.nth(1)).toContainText('POST');
    await expect(mutations.nth(1)).toContainText('/settings/billing/budgets');
    await expect(mutations.nth(2)).toContainText('PATCH');
    await expect(mutations.nth(2)).toContainText('/settings/billing/budgets/budget-ulb-display-bug');

    const bodies = await mutations.locator('.plan-rail__mutation-body').allInnerTexts();
    expect(bodies.map((b) => JSON.parse(b))).toStrictEqual([
      {
        budget_type: 'BundlePricing',
        budget_product_sku: 'ai_credits',
        budget_scope: 'individual',
        budget_entity_name: 'aran-mehta',
        budget_amount: 50,
        prevent_further_usage: true,
        budget_alerting: { will_alert: false, alert_recipients: [] },
      },
      {
        budget_type: 'BundlePricing',
        budget_product_sku: 'ai_credits',
        budget_scope: 'individual',
        budget_entity_name: 'emily-zhao',
        budget_amount: 50,
        prevent_further_usage: true,
        budget_alerting: { will_alert: false, alert_recipients: [] },
      },
      { budget_amount: 50 },
    ]);

    // Three audit events -- one per user (Task 4.11's "apply audits per user").
    const audits = rail.locator('.plan-rail__audit');
    await expect(audits).toHaveCount(3);
    await expect(audits.nth(0)).toContainText('budget.create');
    await expect(audits.nth(0)).toContainText('budget:individual:aran-mehta');
    await expect(audits.nth(1)).toContainText('budget.create');
    await expect(audits.nth(1)).toContainText('budget:individual:emily-zhao');
    await expect(audits.nth(2)).toContainText('budget.update');
    await expect(audits.nth(2)).toContainText('budget:individual:liam-obrien');

    await expect(window.locator('.users-toast')).toContainText('◆ Simulated apply — ULB updated for 3 users.');

    // The bulk apply clears the underlying table selection (design's own
    // applyBulk: selUsers reset) -- close the modal and confirm both.
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).toHaveCount(0);
    await expect(screen.locator('.users__bulk-bar')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
