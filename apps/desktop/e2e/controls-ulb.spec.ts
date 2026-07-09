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
//
// Task 4.11b (CLAUDE.md §6.1 preview-fidelity fix, docs/pending/todo.md's
// REQUIRED pre-Checkpoint-4 line): simulatePlan's usageState.users used to be
// seeded ONLY from the enterprise-wide /settings/billing/usage report
// (packages/data/src/write/live-state.ts's assembleUsageState) -- a
// DIFFERENT GitHub report than the per-user metrics report
// (CREDITS_USED_ITEMS) the Users screen and the utilization meters above
// read, and one that carries per-user rows for exactly two logins in this
// fixture world (faisal-noor, noah-tanaka). assembleUsageState now ALSO folds
// in that metrics report over the full 81-seat roster
// (write/live-state.test.ts pins the fold itself), so every dry-run below is
// now a REAL, roster-wide simulation, not an accidental 0/0. Two of the six
// tests below now genuinely flip:
//   - Staging a $0 individual ULB for liam-obrien (4,930 MTD, see above) now
//     correctly shows him newly BLOCKED (0 − 4,930 <= 0).
//   - Deleting ext-dmorrow's $0 individual ULB now correctly shows him newly
//     UNBLOCKED: his metrics-report usage this cycle is 0 (no rows at all),
//     and headroom = cap − usage = 0 − 0 = 0 <= 0 is the boundary case that
//     STILL blocks (a zero-usage user against a $0 cap is blocked, not
//     exempt) -- so he was blocked before the delete and isn't after (his
//     Corporate Systems cost center has no CCULB, so he falls back to the
//     4,600-credit universal ULB, 4,600 credits of headroom against 0 used).
// The other four (universal-ULB raise, CCULB-create for Employer & Provider
// Portals, individual-create for rpatel2) hand-derive to a genuine,
// roster-wide 0/0 -- not because nobody is tracked, but because nobody in the
// affected population actually crosses either boundary (see each test's own
// comment for the derivation).
//
// "Controls scale features": 5 more individual ULBs were added (12 ULB rows
// total: universal + 2 CCULBs + 9 individuals) so the ULB tab has enough rows
// to exercise 10/page pagination (see fixtures/README.md's "Controls-scale
// fixtures" note) -- declan-ryan (2,500), devi-anand (3,300), jomo-mburu
// (2,900), nina-popov (4,800), tegan-ellis (3,700), all zero-usage seats. The
// default view (no search/scope-filter/sort, page 1) therefore now shows the
// first 10 rows in ULB_SCOPE_ORDER-then-name order: universal, CCULB Data &
// Evaluation, CCULB Workforce, then individuals alphabetically -- declan-ryan,
// devi-anand, ext-dmorrow, ext-pshah, jomo-mburu, liam-obrien, nina-popov
// (page 1 of 2; sam-kelly and tegan-ellis land on page 2). Every row this
// file's tests drill into (universal, both CCULBs, liam-obrien, ext-dmorrow)
// stays on page 1 by construction -- the 5 new logins were deliberately
// chosen to sort into positions 4-5 and 8, 10 (never bumping an existing
// tested row past the page-1/page-2 boundary). See controls-scale.spec.ts for
// the new search/filter/sort/pagination/staging-integrity coverage.

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
    // "Controls scale features": 12 ULB rows total now paginate 10/page --
    // page 1 (default, no search/filter/sort) shows universal + 2 CCULBs
    // (Workforce, Data & Evaluation) + 7 individuals (declan-ryan, devi-anand,
    // ext-dmorrow, ext-pshah, jomo-mburu, liam-obrien, nina-popov) = 10; the
    // remaining 2 individuals (sam-kelly, tegan-ellis) sit on page 2 (see
    // controls-scale.spec.ts's pagination test for that page).
    await expect(table.locator('.controls-table__row')).toHaveCount(10);
    // Scoped to the phase-badge class itself (not a bare text match): the
    // universal row's OWN caps copy also contains the substring "both
    // phases" ("Every licensed user's total · both phases"), which would
    // otherwise double-count that row.
    await expect(table.locator('.controls-ulb__phase-badge--green')).toHaveCount(10);
    await expect(table.locator('.controls-ulb__phase-badge--green').first()).toContainText('both phases');
    await expect(table.getByText('Hard stop · always')).toHaveCount(10);
    // ULBs never expose the spending-limits hard-stop toggle (CLAUDE.md §5/§6.3).
    await expect(table.getByRole('switch')).toHaveCount(0);
    // API-ONLY pill appears on exactly the 2 CCULB rows, never the universal
    // or the individual rows -- unaffected by the fixture addition (no new
    // CCULBs were added), and both CCULB rows are on page 1.
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

    // Genuinely 0/0 across the full roster (post-4.11b fold), hand-derived:
    // the universal ULB only governs users with NEITHER an individual
    // override NOR CCULB-cost-center membership -- i.e. Employer & Provider
    // Portals (minus ext-pshah), Payments Integrity Engineering, Cyber &
    // Identity Services (minus sam-kelly), and Corporate Systems (minus
    // ext-dmorrow); Workforce Australia Platform and Data & Evaluation
    // Platform are entirely CCULB-governed instead. That population's highest
    // MTD burn this cycle is hannah-webb's 4,360 (the same figure the
    // universal row's own utilization meter above shows) -- under BOTH 4,600
    // (today) and 5,100 (staged). Nobody else in that ~45-user population
    // comes close (next-highest: faisal-noor 4,180, grace-omalley 4,020,
    // ruby-carter 4,290, karen-fox 3,760). So this raise moves nobody's block
    // status -- not because they're untracked, but because nobody in the
    // governed population is within 1,000 credits of either boundary.
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

    // The 11-row post-create state (a freshly-appended list item) is exactly
    // where a React key/warning would surface, and nothing else in this file
    // asserts on it -- mirror nav.spec.ts's pageerror guard so a console
    // regression here fails loudly instead of passing silently.
    const pageErrors: Error[] = [];
    window.on('pageerror', (error) => pageErrors.push(error));

    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    // Page 1 of the 12 live ULB rows (see this file's header note).
    await expect(table.locator('.controls-table__row')).toHaveCount(10);

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

    // "Controls scale features": staged-NEW rows bypass search/filter/sort/
    // pagination entirely and pin above the (unaffected) page-1 body -- so the
    // total goes from 10 to 11 (1 pinned + the SAME 10 page-1 live rows),
    // rather than folding into the sorted CCULB group.
    await expect(table.locator('.controls-table__row')).toHaveCount(11);
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
    // Genuinely 0/0 (post-4.11b fold), hand-derived: this CCULB (5,000)
    // governs every Employer & Provider Portals member without an individual
    // override (ext-pshah keeps his own 1,900 ULB) -- and since 5,000 is
    // HIGHER than the 4,600 universal fallback it replaces for them, it can
    // only ever unblock someone, never newly block. Nobody in that population
    // was blocked under the 4,600 universal fallback to begin with (highest
    // MTD: hannah-webb 4,360, under 4,600) -- so there is nobody left to
    // unblock either. Net: 0/0, for a real (not accidental) reason.
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

test('CREATE an individual ULB (rpatel2): the POST carries the wire form budget_scope:"user" + the login in the user field', async () => {
  // Complements the CCULB-create test above: create is otherwise only proven
  // for the multi_user_cost_center scope, but the plan's acceptance is "all
  // three scopes CRUD end-to-end". Individual-create exercises a genuinely
  // distinct path -- the user <select> (populated from listHeavyUsers, not the
  // cost-center list) and a wire budget_scope:'user' POST (OpenAPI-pinned,
  // wire-contract-writes.md §1: the internal 'individual' spelling does not
  // exist on the wire). Every value is
  // fixture-derived: rpatel2 (a Workforce Australia Platform seat, not one of
  // the four existing individual ULBs) is eligible; it's Workforce-CCULB-bound
  // at 4,170 MTD credits (metrics report), so a fresh 5,000-credit individual
  // cap blocks nobody; $50 -> 50 USD (creditsToUsd(5000)).
  const { app, dbDir } = await launchApp('ulb-individual-create');
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    // Page 1 of the 12 live ULB rows (see this file's header note).
    await expect(table.locator('.controls-table__row')).toHaveCount(10);

    await window.getByRole('button', { name: '+ New user-level budget' }).click();
    const modal = window.locator('.new-ulb-modal');
    await expect(modal).toBeVisible();

    // Individual is the default scope (first eligible), but select it
    // explicitly so the test doesn't ride on the default. The User field is
    // now a searchable downshift combobox (maintainer feedback: the old
    // plain <select> over the full roster doesn't scale to a real tenant) --
    // no more default pre-picked entry, so the flow is type-to-filter, then
    // click the matching row.
    await modal.locator('#new-ulb-scope').selectOption('individual');
    await modal.locator('#new-ulb-entity').fill('rpatel2');
    await modal.getByRole('option', { name: /rpatel2/ }).click();
    await modal.getByLabel('Cap (credits) — new user-level budget').fill('5000');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(modal).toHaveCount(0);

    // Staged-new rows pin above the (unaffected) page-1 body -- 1 pinned + the
    // same 10 page-1 live rows = 11 (see "Controls scale features" note above).
    await expect(table.locator('.controls-table__row')).toHaveCount(11);
    const newRow = table.locator('[data-control-id="budget:individual:rpatel2"]');
    await expect(newRow.getByText('Individual · rpatel2')).toBeVisible();
    // Individual rows never carry the CCULB-only API-ONLY pill.
    await expect(newRow.locator('.controls-ulb__apionly-pill')).toHaveCount(0);
    await expect(newRow.getByText('● staged: new')).toBeVisible();

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('+ individual["rpatel2"]: cap 5,000 · hard-stop');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // Genuinely 0/0 (post-4.11b fold): rpatel2 is now tracked for real (4,170
    // MTD, see the test's own header derivation). Her new individual ULB
    // (5,000) replaces her Workforce CCULB (5,200) as her effective cap --
    // LOWER, but still comfortably above her 4,170 MTD (830 headroom) -- so
    // nobody's status moves.
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
      // OpenAPI-pinned wire form (wire-contract-writes.md §1): internal
      // 'individual' serializes as scope 'user' + the `user` login field.
      budget_scope: 'user',
      budget_entity_name: 'rpatel2',
      user: 'rpatel2',
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

    // Post-4.11b fold: liam-obrien is now tracked for real (4,930 MTD, see
    // the file header). His individual ULB going 5,800 -> 0 flips his
    // headroom from +870 to -4,930 -- correctly newly BLOCKED, exactly the
    // preview-fidelity gap this task fixes (the old code silently showed 0/0
    // here for a money-affecting $0-cap stage).
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('1');
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-users')).toHaveText('liam-obrien');
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
    // Post-4.11b fold: ext-dmorrow has NO usage rows at all this cycle (0
    // MTD) -- against his live $0 ULB, headroom = 0 - 0 = 0, and
    // simulatePlan's <= 0 predicate blocks at exactly zero headroom, so he
    // reads blockedBefore: true (the boundary case the file header calls
    // out: a zero-usage user against a $0 cap IS blocked, not exempt).
    // Deleting the $0 ULB falls him back to Corporate Systems' universal ULB
    // (no CCULB there): 4,600 credits of headroom against 0 used -> newly
    // UNBLOCKED.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('1');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-users')).toHaveText('ext-dmorrow');
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
