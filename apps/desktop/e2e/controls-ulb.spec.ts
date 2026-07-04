import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 4.10: User-level budgets (ULB) family -- universal + individual + CCULB
// rows, CRUD end to end through the SAME plan/simulate/apply rail Task 4.9
// built (PlanRail/planDiffLines are unchanged; see Controls.tsx/UlbTable.tsx).
//
// Every expected value below is derived from committed fixtures
// (msw/fixtures/budgets.ts, usage.ts, costCenters.ts, constants.ts), never
// observed output:
//   - universal: $40 -> 4,000 credits, entity acme-enterprise, PFU true.
//   - CCULB Platform: $45 -> 4,500 credits, PFU true.
//   - Individual user-07 (the ULB-display-bug fixture): $60 -> 6,000 credits, PFU true.
//   - Individual user-20 (the $0-ULB fixture): $0 -> 0 credits, PFU true.
//   - Universal-row utilization: the max cycle-to-date credits among users
//     whose resolved effectiveUlb is 'universal' (every Data & Analytics /
//     Marketing member not individually overridden, none CCULB'd) is
//     user-26 at 500 credits -> "13% used · 500 of 4,000" (500/4000 = 12.5%,
//     rounds to 13).
//   - CCULB-row utilization: the max among Platform members not individually
//     overridden is user-01 at 420 credits -> "9% used · 420 of 4,500"
//     (420/4500 = 9.33%, rounds to 9).
//   - Individual user-07's own cycle-to-date credits = 0 (no
//     copilot/metrics/reports/users-28-day row for them) -> "0% used · 0 of 6,000".
//   - Individual user-20: $0 cap -> the meter's "blocked ($0 cap)" branch.
//   - Neither user-07 nor user-20 has a /settings/billing/usage row
//     (msw/fixtures/usage.ts) -- assembleUsageState seeds simulatePlan's
//     usageState.users ONLY from that report, so newly-blocked/unblocked for
//     edits to either of their ULBs is honestly 0, asserted as 0 (not a
//     fabricated non-zero count and not omitted).

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
  // Default tab is now User-level budgets (Task 4.10 flips the design's
  // ULB-first tab order -- 'spending' was a Task 4.9 stopgap default).
  await expect(window.getByText('Always a hard stop — a $0 ULB blocks immediately.')).toBeVisible();
}

test('ULB rows render: green "both phases" badge, API-ONLY pill on CCULB only, locked hard-stop pill, $0 warning, fixture-derived utilization', async () => {
  const { app, dbDir } = await launchApp('ulb-rows');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(4);
    // Scoped to the phase-badge class itself (not a bare text match): the
    // universal row's OWN caps copy also contains the substring "both
    // phases" ("Every licensed user's total · both phases"), which would
    // otherwise double-count that row.
    await expect(table.locator('.controls-ulb__phase-badge--green')).toHaveCount(4);
    await expect(table.locator('.controls-ulb__phase-badge--green').first()).toContainText('both phases');
    await expect(table.getByText('Hard stop · always')).toHaveCount(4);
    // ULBs never expose the spending-limits hard-stop toggle (CLAUDE.md §5/§6.3).
    await expect(table.getByRole('switch')).toHaveCount(0);

    const universalRow = table.locator('[data-control-id="budget:universal:acme-enterprise"]');
    const cculbRow = table.locator('[data-control-id="budget:multi_user_cost_center:Platform"]');
    const user07Row = table.locator('[data-control-id="budget:individual:user-07"]');
    const user20Row = table.locator('[data-control-id="budget:individual:user-20"]');

    await expect(universalRow.getByText('Universal ULB')).toBeVisible();
    await expect(universalRow.getByText("Every licensed user's total · both phases")).toBeVisible();
    await expect(universalRow.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(universalRow.getByText('13% used · 500 of 4,000')).toBeVisible();

    await expect(cculbRow.getByText('CCULB · Platform')).toBeVisible();
    await expect(cculbRow.getByText('Per-user cap · every CC member')).toBeVisible();
    await expect(cculbRow.locator('.controls-ulb__apionly-pill')).toHaveText('API-ONLY');
    await expect(cculbRow.getByText('9% used · 420 of 4,500')).toBeVisible();

    await expect(user07Row.getByText('Individual · user-07')).toBeVisible();
    await expect(user07Row.getByText("One named user's total")).toBeVisible();
    await expect(user07Row.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(user07Row.getByText('0% used · 0 of 6,000')).toBeVisible();
    await expect(user07Row.locator('.controls-ulb__zero-warn')).toHaveCount(0);

    await expect(user20Row.getByText('Individual · user-20')).toBeVisible();
    await expect(user20Row.getByText('blocked ($0 cap)')).toBeVisible();
    await expect(user20Row.locator('.controls-ulb__zero-warn')).toContainText('$0/near-zero — blocks immediately');

    // Precedence explainer text (the family's one-line explainer) is present.
    await expect(window.getByText('Individual → Cost-center (CCULB) → Universal.')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('edit the universal ULB cap: stage -> diff -> dry-run -> apply with exact PATCH payload + audit event', async () => {
  const { app, dbDir } = await launchApp('ulb-universal-edit');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const universalRow = table.locator('[data-control-id="budget:universal:acme-enterprise"]');
    const rail = window.locator('.plan-rail');

    await expect(window.getByText('No staged changes')).toBeVisible();

    await universalRow.getByLabel('Cap (credits) — Universal ULB').fill('4500');
    await expect(universalRow.getByText('● staged change')).toBeVisible();

    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ universal["acme-enterprise"].cap: 4,000 → 4,500');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // user-01 (the only /usage-having Platform member) is CCULB-bound, not
    // universal-bound; user-16/user-26/user-05 have far more headroom than
    // either 4,000 or 4,500 -- this edit moves nobody's block status.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);

    // A universal-ULB amount change rolls up as POOL-phase capacity, not metered.
    const poolDeltaRow = rail.locator('.plan-rail__sim-delta', { hasText: 'pool-phase' });
    await expect(poolDeltaRow.locator('.plan-rail__sim-delta-value')).toHaveText('+500 credits · $5.00');

    await rail.getByLabel('Justification (required)').fill('e2e: raise universal ULB headroom ahead of quarter-end');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('PATCH');
    await expect(applied).toContainText('/settings/billing/budgets/budget-universal-1');
    await expect(applied).toContainText('{"budget_amount":45}');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:universal:acme-enterprise');
    await expect(window.locator('.controls-toast')).toContainText(/Simulated apply/i);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('CREATE a CCULB for Data & Analytics: the POST payload matches the PRD §2.1 example verbatim, field for field', async () => {
  const { app, dbDir } = await launchApp('ulb-cculb-create');
  try {
    const window = await app.firstWindow();

    // The 5-row post-create state (a freshly-appended list item) is exactly
    // where a React key/warning would surface, and nothing else in this file
    // asserts on it -- mirror nav.spec.ts's pageerror guard so a console
    // regression here fails loudly instead of passing silently.
    const pageErrors: Error[] = [];
    window.on('pageerror', (error) => pageErrors.push(error));

    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(4);

    await window.getByRole('button', { name: '+ New user-level budget' }).click();
    const modal = window.locator('.new-ulb-modal');
    await expect(modal).toBeVisible();

    await modal.locator('#new-ulb-scope').selectOption('multi_user_cost_center');
    await modal.locator('#new-ulb-entity').selectOption('Data & Analytics');

    const createButton = modal.getByRole('button', { name: 'Create' });
    await expect(createButton).toBeDisabled(); // no amount entered yet

    await modal.getByLabel('Cap (credits) — new user-level budget').fill('3000');
    await modal.getByLabel('Alerts on — new user-level budget').check();
    await modal.getByLabel('Alert recipients — new user-level budget').fill('data-leads@acme.example');
    await expect(createButton).toBeEnabled();
    await createButton.click();

    await expect(modal).toHaveCount(0);

    // Data & Analytics < Platform alphabetically, so the new CCULB row sorts
    // ahead of the existing one within the CCULB group.
    await expect(table.locator('.controls-table__row')).toHaveCount(5);
    const newRow = table.locator('[data-control-id="budget:multi_user_cost_center:Data & Analytics"]');
    await expect(newRow.getByText('CCULB · Data & Analytics')).toBeVisible();
    await expect(newRow.locator('.controls-ulb__apionly-pill')).toHaveText('API-ONLY');
    await expect(newRow.getByText('● staged: new')).toBeVisible();

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('+ multi_user_cost_center["Data & Analytics"]: cap 3,000 · hard-stop');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // user-16 (Data & Analytics, the only member of that CC with a /usage
    // row) has 3,000 credits of headroom even under the new 3,000-credit
    // CCULB (310 used) -- nobody newly blocks.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: new CCULB for Data & Analytics per team-lead request');
    await rail.getByRole('button', { name: /Apply changes/ }).click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('POST');
    await expect(applied).toContainText('/settings/billing/budgets');
    await expect(applied).toContainText('budget.create');
    await expect(applied).toContainText('budget:multi_user_cost_center:Data & Analytics');

    // The PRD §2.1 CCULB example, field for field -- not a loose/partial match.
    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    expect(parsedBody).toStrictEqual({
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_scope: 'multi_user_cost_center',
      budget_entity_name: 'Data & Analytics',
      budget_amount: 30,
      prevent_further_usage: true,
      budget_alerting: { will_alert: true, alert_recipients: ['data-leads@acme.example'] },
    });

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('CREATE an individual ULB (user-01): the POST carries budget_scope:"individual" + the login as budget_entity_name', async () => {
  // Complements the CCULB-create test above: create is otherwise only proven
  // for the multi_user_cost_center scope, but the plan's acceptance is "all
  // three scopes CRUD end-to-end". Individual-create exercises a genuinely
  // distinct path -- the user <select> (populated from listHeavyUsers, not the
  // cost-center list) and a budget_scope:'individual' POST. Every value is
  // fixture-derived: user-01 (a seat, not one of the two existing individual
  // ULBs user-07/user-20) is eligible; it's Platform-CCULB-bound at 420 MTD
  // credits, so a fresh 5,000-credit individual cap blocks nobody; $50 -> 50
  // USD (creditsToUsd(5000)).
  const { app, dbDir } = await launchApp('ulb-individual-create');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(4);

    await window.getByRole('button', { name: '+ New user-level budget' }).click();
    const modal = window.locator('.new-ulb-modal');
    await expect(modal).toBeVisible();

    // Individual is the default scope (first eligible), but select it
    // explicitly so the test doesn't ride on the default.
    await modal.locator('#new-ulb-scope').selectOption('individual');
    await modal.locator('#new-ulb-entity').selectOption('user-01');
    await modal.getByLabel('Cap (credits) — new user-level budget').fill('5000');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(modal).toHaveCount(0);

    await expect(table.locator('.controls-table__row')).toHaveCount(5);
    const newRow = table.locator('[data-control-id="budget:individual:user-01"]');
    await expect(newRow.getByText('Individual · user-01')).toBeVisible();
    // Individual rows never carry the CCULB-only API-ONLY pill.
    await expect(newRow.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(newRow.getByText('● staged: new')).toBeVisible();

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('+ individual["user-01"]: cap 5,000 · hard-stop');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // user-01 is already CCULB-bound (Platform, 4,500) at 420 MTD; a 5,000
    // individual cap keeps it unblocked -- nobody's status moves.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: individual ULB for user-01 per manager request');
    await rail.getByRole('button', { name: /Apply changes/ }).click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('POST');
    await expect(applied).toContainText('/settings/billing/budgets');
    await expect(applied).toContainText('budget.create');
    await expect(applied).toContainText('budget:individual:user-01');

    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    expect(parsedBody).toStrictEqual({
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_scope: 'individual',
      budget_entity_name: 'user-01',
      budget_amount: 50,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] },
    });
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('stage a $0 individual ULB (user-07): the zero_or_near_zero_ulb warning renders, and apply still succeeds with a justification', async () => {
  const { app, dbDir } = await launchApp('ulb-zero-warning');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const user07Row = table.locator('[data-control-id="budget:individual:user-07"]');
    const rail = window.locator('.plan-rail');

    await user07Row.getByLabel('Cap (credits) — Individual · user-07').fill('0');
    await expect(user07Row.getByText('● staged change')).toBeVisible();
    // The zero-warning display cue is derived from the effective amount
    // directly -- it appears immediately, before any dry-run is run.
    await expect(user07Row.locator('.controls-ulb__zero-warn')).toContainText('$0/near-zero — blocks immediately');

    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ individual["user-07"].cap: 6,000 → 0');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // user-07 has no /settings/billing/usage row -- honestly 0/0.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');

    const warning = rail.locator('.plan-rail__warning');
    await expect(warning).toHaveCount(1);
    await expect(warning).toContainText(
      'budget:individual:user-07 is 0 credits (≤ 100) — a $0/near-zero ULB hard-blocks immediately once applied.',
    );

    // The warning does not block apply -- this is an amount change, not a
    // hard-stop-off transition, so no §6.3 override checkbox is demanded,
    // just the standard justification gate.
    await expect(rail.getByRole('checkbox', { name: /I acknowledge/i })).toHaveCount(0);
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeDisabled();
    await rail.getByLabel('Justification (required)').fill('e2e: user-07 offboarding -- freeze further usage immediately');
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('PATCH');
    await expect(applied).toContainText('/settings/billing/budgets/budget-ulb-display-bug-1');
    await expect(applied).toContainText('{"budget_amount":0}');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:individual:user-07');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('delete the $0 individual ULB (user-20): diff line + DELETE request + audit event', async () => {
  const { app, dbDir } = await launchApp('ulb-delete');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const user20Row = table.locator('[data-control-id="budget:individual:user-20"]');
    const rail = window.locator('.plan-rail');

    await expect(user20Row.getByText('blocked ($0 cap)')).toBeVisible();

    await user20Row.getByRole('button', { name: '✕ delete' }).click();
    await expect(user20Row.getByText('● staged: delete')).toBeVisible();
    await expect(user20Row.getByRole('button', { name: '⤺ undo delete' })).toBeVisible();
    // Editing and deleting the same row at once would be contradictory.
    await expect(user20Row.getByLabel('Cap (credits) — Individual · user-20')).toBeDisabled();

    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('- individual["user-20"]: cap 0');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: user-20 reinstated, remove the orphaned $0 ULB');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('DELETE');
    await expect(applied).toContainText('/settings/billing/budgets/budget-ulb-zero-1');
    await expect(applied).toContainText('budget.delete');
    await expect(applied).toContainText('budget:individual:user-20');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
