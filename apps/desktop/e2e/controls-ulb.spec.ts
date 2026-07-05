import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 4.10: User-level budgets (ULB) family -- universal + individual + CCULB
// rows, CRUD end to end through the SAME plan/simulate/apply rail Task 4.9
// built (PlanRail/planDiffLines are unchanged; see Controls.tsx/UlbTable.tsx).
//
// Every expected value below is derived from committed fixtures against the
// DEWR world (msw/fixtures/{budgets,usage,costCenters,constants}.ts,
// packages/data/src/msw/fixtures/README.md), never observed output:
//   - universal: $46 -> 4,600 credits, entity `dewr`, PFU true.
//   - CCULB Workforce Australia Platform: $52 -> 5,200 credits, PFU true.
//   - CCULB Data & Evaluation Platform: $60 -> 6,000 credits, PFU true.
//   - Individual liam-obrien (the ULB-display-bug fixture): $58 -> 5,800
//     credits, PFU true.
//   - Individual ext-dmorrow (the $0-ULB fixture): $0 -> 0 credits, PFU true.
//   - Individual ext-pshah / sam-kelly exist too (1,900 / 5,400 credits) but
//     aren't exercised below -- rpatel2 (a plain Workforce member with no
//     override) is this file's CREATE target instead, so those two stay
//     available as an untouched control group.
//   - Universal-row utilization: the max cycle-to-date (metrics-report)
//     credits among users whose resolved effectiveUlb is 'universal' (nobody
//     individually overridden, no CCULB'd cost center) is hannah-webb
//     (Employer & Provider Portals) at 4,360 -> "95% used · 4,360 of 4,600"
//     (4,360/4,600 = 94.78%, rounds to 95).
//   - CCULB-Workforce utilization: the max among Workforce Australia
//     Platform's CCULB-bound members (liam-obrien is excluded -- his
//     individual override outranks the CCULB) is sarah-huang at 4,760 ->
//     "92% used · 4,760 of 5,200" (91.54%, rounds to 92).
//   - CCULB-Data & Evaluation utilization: the max among that CC's CCULB-bound
//     members is emily-zhao at 5,480 -> "91% used · 5,480 of 6,000" (91.33%,
//     rounds to 91 -- the same number the Users screen reports as her own
//     91.3% at-risk utilization, since she's the CCULB's binding user).
//   - Individual liam-obrien's own cycle-to-date credits = 4,930 ->
//     "85% used · 4,930 of 5,800" (exactly 85% -- fixture-authored clean).
//   - Individual ext-dmorrow: $0 cap -> the meter's "blocked ($0 cap)" branch.
//   - simulatePlan's usageState.users is seeded ONLY from the enterprise-wide
//     /settings/billing/usage report (packages/data/src/write/live-state.ts's
//     assembleUsageState) -- a DIFFERENT GitHub report than the per-user
//     metrics report (CREDITS_USED_ITEMS) the Users screen and the utilization
//     meters above read. In this fixture world that billing report carries
//     per-user rows for exactly two logins: faisal-noor (2,300 metered
//     credits, Payments Integrity Engineering) and noah-tanaka (936 credits
//     split pool/metered, Workforce, the allowance-cliff fixture) -- never
//     liam-obrien, ext-dmorrow, rpatel2, or anyone else this file edits. So
//     every dry-run below honestly shows 0 newly-blocked / 0 newly-unblocked
//     regardless of the cap staged, whether raised, dropped to $0, created, or
//     deleted -- asserted as 0 throughout (not a fabricated non-zero count and
//     not omitted).

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

test('ULB rows render: green "both phases" badge, API-ONLY pill on CCULB rows only, locked hard-stop pill, $0 warning, fixture-derived utilization', async () => {
  const { app, dbDir } = await launchApp('ulb-rows');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    // universal + 2 CCULBs (Workforce, Data & Evaluation) + 4 individual
    // overrides (liam-obrien, ext-dmorrow, ext-pshah, sam-kelly) = 7.
    await expect(table.locator('.controls-table__row')).toHaveCount(7);
    // Scoped to the phase-badge class itself (not a bare text match): the
    // universal row's OWN caps copy also contains the substring "both
    // phases" ("Every licensed user's total · both phases"), which would
    // otherwise double-count that row.
    await expect(table.locator('.controls-ulb__phase-badge--green')).toHaveCount(7);
    await expect(table.locator('.controls-ulb__phase-badge--green').first()).toContainText('both phases');
    await expect(table.getByText('Hard stop · always')).toHaveCount(7);
    // ULBs never expose the spending-limits hard-stop toggle (CLAUDE.md §5/§6.3).
    await expect(table.getByRole('switch')).toHaveCount(0);
    // API-ONLY pill appears on exactly the 2 CCULB rows, never the universal
    // or the 4 individual rows.
    await expect(table.locator('.controls-ulb__apionly-pill')).toHaveCount(2);

    const universalRow = table.locator('[data-control-id="budget:universal:dewr"]');
    const workforceCculbRow = table.locator('[data-control-id="budget:multi_user_cost_center:Workforce Australia Platform"]');
    const dataEvalCculbRow = table.locator('[data-control-id="budget:multi_user_cost_center:Data & Evaluation Platform"]');
    const liamObrienRow = table.locator('[data-control-id="budget:individual:liam-obrien"]');
    const extDmorrowRow = table.locator('[data-control-id="budget:individual:ext-dmorrow"]');

    await expect(universalRow.getByText('Universal ULB')).toBeVisible();
    await expect(universalRow.getByText("Every licensed user's total · both phases")).toBeVisible();
    await expect(universalRow.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(universalRow.getByText('95% used · 4,360 of 4,600')).toBeVisible();

    await expect(workforceCculbRow.getByText('CCULB · Workforce Australia Platform')).toBeVisible();
    await expect(workforceCculbRow.getByText('Per-user cap · every CC member')).toBeVisible();
    await expect(workforceCculbRow.locator('.controls-ulb__apionly-pill')).toHaveText('API-ONLY');
    await expect(workforceCculbRow.getByText('92% used · 4,760 of 5,200')).toBeVisible();

    await expect(dataEvalCculbRow.getByText('CCULB · Data & Evaluation Platform')).toBeVisible();
    await expect(dataEvalCculbRow.locator('.controls-ulb__apionly-pill')).toHaveText('API-ONLY');
    await expect(dataEvalCculbRow.getByText('91% used · 5,480 of 6,000')).toBeVisible();

    await expect(liamObrienRow.getByText('Individual · liam-obrien')).toBeVisible();
    await expect(liamObrienRow.getByText("One named user's total")).toBeVisible();
    await expect(liamObrienRow.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(liamObrienRow.getByText('85% used · 4,930 of 5,800')).toBeVisible();
    await expect(liamObrienRow.locator('.controls-ulb__zero-warn')).toHaveCount(0);

    await expect(extDmorrowRow.getByText('Individual · ext-dmorrow')).toBeVisible();
    await expect(extDmorrowRow.getByText('blocked ($0 cap)')).toBeVisible();
    await expect(extDmorrowRow.locator('.controls-ulb__zero-warn')).toContainText('$0/near-zero — blocks immediately');

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
    const universalRow = table.locator('[data-control-id="budget:universal:dewr"]');
    const rail = window.locator('.plan-rail');

    await expect(window.getByText('No staged changes')).toBeVisible();

    await universalRow.getByLabel('Cap (credits) — Universal ULB').fill('5100');
    await expect(universalRow.getByText('● staged change')).toBeVisible();

    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ universal["dewr"].cap: 4,600 → 5,100');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // The only two users simulatePlan ever evaluates (faisal-noor,
    // noah-tanaka -- see the file-header note) are neither universal-bound
    // in a way this raise moves: faisal-noor IS universal-bound but his
    // billing-report usage (2,300 credits) stays well under both 4,600 and
    // 5,100; noah-tanaka is Workforce-CCULB-bound, unaffected by this control
    // entirely. This edit moves nobody's block status.
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
    await expect(applied).toContainText('/settings/billing/budgets/budget-universal-dewr');
    await expect(applied).toContainText('{"budget_amount":51}');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:universal:dewr');
    await expect(window.locator('.controls-toast')).toContainText(/Simulated apply/i);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('CREATE a CCULB for Employer & Provider Portals: the POST payload matches the PRD §2.1 example verbatim, field for field', async () => {
  const { app, dbDir } = await launchApp('ulb-cculb-create');
  try {
    const window = await app.firstWindow();

    // The 8-row post-create state (a freshly-appended list item) is exactly
    // where a React key/warning would surface, and nothing else in this file
    // asserts on it -- mirror nav.spec.ts's pageerror guard so a console
    // regression here fails loudly instead of passing silently.
    const pageErrors: Error[] = [];
    window.on('pageerror', (error) => pageErrors.push(error));

    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(7);

    await window.getByRole('button', { name: '+ New user-level budget' }).click();
    const modal = window.locator('.new-ulb-modal');
    await expect(modal).toBeVisible();

    // Workforce Australia Platform and Data & Evaluation Platform already
    // have CCULBs -- the entity picker is filtered to the 4 cost centers
    // without one (Employer & Provider Portals, Payments Integrity
    // Engineering, Cyber & Identity Services, Corporate Systems).
    await modal.locator('#new-ulb-scope').selectOption('multi_user_cost_center');
    await modal.locator('#new-ulb-entity').selectOption('Employer & Provider Portals');

    const createButton = modal.getByRole('button', { name: 'Create' });
    await expect(createButton).toBeDisabled(); // no amount entered yet

    await modal.getByLabel('Cap (credits) — new user-level budget').fill('5000');
    await modal.getByLabel('Alerts on — new user-level budget').check();
    await modal.getByLabel('Alert recipients — new user-level budget').fill('provider-portal-leads@dewr.gov.au');
    await expect(createButton).toBeEnabled();
    await createButton.click();

    await expect(modal).toHaveCount(0);

    // 'Employer & Provider Portals' sorts ahead of 'Data & Evaluation
    // Platform' and 'Workforce Australia Platform' alphabetically, so the new
    // CCULB row sorts first within the CCULB group.
    await expect(table.locator('.controls-table__row')).toHaveCount(8);
    const newRow = table.locator('[data-control-id="budget:multi_user_cost_center:Employer & Provider Portals"]');
    await expect(newRow.getByText('CCULB · Employer & Provider Portals')).toBeVisible();
    await expect(newRow.locator('.controls-ulb__apionly-pill')).toHaveText('API-ONLY');
    await expect(newRow.getByText('● staged: new')).toBeVisible();

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText(
      '+ multi_user_cost_center["Employer & Provider Portals"]: cap 5,000 · hard-stop',
    );

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // Neither of the two users simulatePlan evaluates (faisal-noor,
    // noah-tanaka) is an Employer & Provider Portals member -- this control
    // can never move either of their block statuses, at any cap.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: new CCULB for Employer & Provider Portals per team-lead request');
    await rail.getByRole('button', { name: /Apply changes/ }).click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('POST');
    await expect(applied).toContainText('/settings/billing/budgets');
    await expect(applied).toContainText('budget.create');
    await expect(applied).toContainText('budget:multi_user_cost_center:Employer & Provider Portals');

    // The PRD §2.1 CCULB example, field for field -- not a loose/partial match.
    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    expect(parsedBody).toStrictEqual({
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_scope: 'multi_user_cost_center',
      budget_entity_name: 'Employer & Provider Portals',
      budget_amount: 50,
      prevent_further_usage: true,
      budget_alerting: { will_alert: true, alert_recipients: ['provider-portal-leads@dewr.gov.au'] },
    });

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('CREATE an individual ULB (rpatel2): the POST carries budget_scope:"individual" + the login as budget_entity_name', async () => {
  // Complements the CCULB-create test above: create is otherwise only proven
  // for the multi_user_cost_center scope, but the plan's acceptance is "all
  // three scopes CRUD end-to-end". Individual-create exercises a genuinely
  // distinct path -- the user <select> (populated from listHeavyUsers, not the
  // cost-center list) and a budget_scope:'individual' POST. Every value is
  // fixture-derived: rpatel2 (a Workforce Australia Platform seat, not one of
  // the four existing individual ULBs) is eligible; it's Workforce-CCULB-bound
  // at 4,170 MTD credits (metrics report), so a fresh 5,000-credit individual
  // cap blocks nobody; $50 -> 50 USD (creditsToUsd(5000)).
  const { app, dbDir } = await launchApp('ulb-individual-create');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(7);

    await window.getByRole('button', { name: '+ New user-level budget' }).click();
    const modal = window.locator('.new-ulb-modal');
    await expect(modal).toBeVisible();

    // Individual is the default scope (first eligible), but select it
    // explicitly so the test doesn't ride on the default.
    await modal.locator('#new-ulb-scope').selectOption('individual');
    await modal.locator('#new-ulb-entity').selectOption('rpatel2');
    await modal.getByLabel('Cap (credits) — new user-level budget').fill('5000');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(modal).toHaveCount(0);

    await expect(table.locator('.controls-table__row')).toHaveCount(8);
    const newRow = table.locator('[data-control-id="budget:individual:rpatel2"]');
    await expect(newRow.getByText('Individual · rpatel2')).toBeVisible();
    // Individual rows never carry the CCULB-only API-ONLY pill.
    await expect(newRow.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(newRow.getByText('● staged: new')).toBeVisible();

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('+ individual["rpatel2"]: cap 5,000 · hard-stop');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // rpatel2 isn't one of the two logins simulatePlan's usageState.users
    // carries (faisal-noor, noah-tanaka) -- nobody's status moves.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: individual ULB for rpatel2 per manager request');
    await rail.getByRole('button', { name: /Apply changes/ }).click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('POST');
    await expect(applied).toContainText('/settings/billing/budgets');
    await expect(applied).toContainText('budget.create');
    await expect(applied).toContainText('budget:individual:rpatel2');

    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    expect(parsedBody).toStrictEqual({
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_scope: 'individual',
      budget_entity_name: 'rpatel2',
      budget_amount: 50,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] },
    });
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('stage a $0 individual ULB (liam-obrien): the zero_or_near_zero_ulb warning renders, and apply still succeeds with a justification', async () => {
  const { app, dbDir } = await launchApp('ulb-zero-warning');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const liamObrienRow = table.locator('[data-control-id="budget:individual:liam-obrien"]');
    const rail = window.locator('.plan-rail');

    await liamObrienRow.getByLabel('Cap (credits) — Individual · liam-obrien').fill('0');
    await expect(liamObrienRow.getByText('● staged change')).toBeVisible();
    // The zero-warning display cue is derived from the effective amount
    // directly -- it appears immediately, before any dry-run is run.
    await expect(liamObrienRow.locator('.controls-ulb__zero-warn')).toContainText('$0/near-zero — blocks immediately');

    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ individual["liam-obrien"].cap: 5,800 → 0');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // liam-obrien isn't one of the two logins simulatePlan's usageState.users
    // carries (faisal-noor, noah-tanaka) -- honestly 0/0.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');

    const warning = rail.locator('.plan-rail__warning');
    await expect(warning).toHaveCount(1);
    await expect(warning).toContainText(
      'budget:individual:liam-obrien is 0 credits (≤ 100) — a $0/near-zero ULB hard-blocks immediately once applied.',
    );

    // The warning does not block apply -- this is an amount change, not a
    // hard-stop-off transition, so no §6.3 override checkbox is demanded,
    // just the standard justification gate.
    await expect(rail.getByRole('checkbox', { name: /I acknowledge/i })).toHaveCount(0);
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeDisabled();
    await rail.getByLabel('Justification (required)').fill('e2e: liam-obrien offboarding -- freeze further usage immediately');
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('PATCH');
    await expect(applied).toContainText('/settings/billing/budgets/budget-ulb-display-bug');
    await expect(applied).toContainText('{"budget_amount":0}');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:individual:liam-obrien');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('delete the $0 individual ULB (ext-dmorrow): diff line + DELETE request + audit event', async () => {
  const { app, dbDir } = await launchApp('ulb-delete');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const extDmorrowRow = table.locator('[data-control-id="budget:individual:ext-dmorrow"]');
    const rail = window.locator('.plan-rail');

    await expect(extDmorrowRow.getByText('blocked ($0 cap)')).toBeVisible();

    await extDmorrowRow.getByRole('button', { name: '✕ delete' }).click();
    await expect(extDmorrowRow.getByText('● staged: delete')).toBeVisible();
    await expect(extDmorrowRow.getByRole('button', { name: '⤺ undo delete' })).toBeVisible();
    // Editing and deleting the same row at once would be contradictory.
    await expect(extDmorrowRow.getByLabel('Cap (credits) — Individual · ext-dmorrow')).toBeDisabled();

    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('- individual["ext-dmorrow"]: cap 0');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: ext-dmorrow reinstated, remove the orphaned $0 ULB');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('DELETE');
    await expect(applied).toContainText('/settings/billing/budgets/budget-ulb-zero');
    await expect(applied).toContainText('budget.delete');
    await expect(applied).toContainText('budget:individual:ext-dmorrow');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
