import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 4.12: Included-usage caps family (per-cost-center cards) -- the third
// and last Controls family tab, staged/diffed/applied through the SAME
// plan/simulate/apply rail Tasks 4.9/4.10 built (PlanRail/planDiffLines are
// unchanged; see Controls.tsx/IncludedCapsGrid.tsx). CLAUDE.md §5: the cap's
// limit is auto-computed from attributed licenses and is NEVER a settable
// amount -- this family exposes exactly two knobs (enabled, overflow) and no
// amount input anywhere, unlike the other two families' cap-input fields.
//
// Every expected value below is derived from committed fixtures
// (msw/fixtures/costCenters.ts's per-CC included_usage_cap + mtd_burn_credits,
// licenses.ts's seat roster, usage.ts's per-user credit rows), never observed
// output:
//   - computedLimitCredits == memberCount x 7,000 for all six cost centers
//     (costCenters.ts's own comment: "every member holds a seat in
//     licenses.ts, so computed_limit_credits == members x 7,000").
//   - "drawn" reads mtdBurnCredits (listCostCenters' per-CC cycle-to-date
//     total), the SAME field + headroom convention (core's
//     includedCapHeadroom/classifyHeadroom) the Cost Centers screen already
//     uses for these fixtures -- so a cost center can't read "within cap" on
//     one screen and "over cap" on the other.
//   - Workforce Australia Platform: 168,000 limit (24 x 7,000), 30,200 drawn,
//     18% (round(30200/168000*100)), overflow 'block'.
//   - Employer & Provider Portals: 112,000 limit (16 x 7,000), 18,900 drawn,
//     17%, overflow 'block'.
//   - Payments Integrity Engineering (the cap-bound fixture): 56,000 limit
//     (8 x 7,000), 58,300 drawn (56,000 pool + 2,300 metered overflow per
//     costCenters.ts's own comment) -- OVER cap (drawn > limit), overflow
//     'metered' (the only CC that overflows instead of blocking).
//   - Data & Evaluation Platform (the amber "watch this one" fixture): 63,000
//     limit (9 x 7,000), 57,400 drawn, 91%, overflow 'block' -- headroom
//     +5,600 (< the 8,000 low-headroom threshold), the exact figure
//     costCenters.ts's own comment cites.
//   - Cyber & Identity Services: 77,000 limit (11 x 7,000), 15,000 drawn, 19%,
//     overflow 'block'.
//   - Corporate Systems: 91,000 limit (13 x 7,000), 12,300 drawn, 14%,
//     overflow 'block'.
//
// PlanRail's planDiffLines (unchanged, Task 4.9) renders a cap's `enabled`
// field with a +/- marker (mirroring preventFurtherUsage's own +/- marker,
// NOT a generic '~'): turning a cap OFF is a '-' line, ON would be '+'. Only
// the `overflow` field ever renders '~'. This file pins that REAL behavior
// (verified by reading packages/ui/src/screens/Controls/PlanRail.tsx's
// planDiffLines directly) rather than assuming '~' for every field.
//
// The money test (Payments Integrity Engineering's overflow 'metered' ->
// 'block'): core's resolveUserBlockStatus (packages/core/src/simulate.ts)
// resolves a member's included-cap candidate as
// { headroomCredits: computedLimitCredits - costCenterUsage.poolCreditsUsed,
//   canBlock: overflow === 'block' }. Payments Integrity's pool draw is
// exactly 56,000 (usage.ts's discount_amount rows for cc-payments-integrity
// sum to $560.00 -> 56,000 credits, matching computed_limit_credits exactly)
// -> headroom 0 regardless of overflow. Today (overflow 'metered'),
// canBlock=false, so this candidate never blocks anyone -- confirmed by the
// disable-preview in an earlier task's dry-run notes ("disabling Payments
// Integrity previews 0 unblocks", CLAUDE.md build history). Flipping to
// 'block' makes canBlock=true with headroom 0 <= 0, so EVERY member of this
// cost center becomes cap-bound UNLESS already blocked by their own ULB.
// Hand-derived from usage.ts's per-user credit rows (all 8 members are
// universal-ULB-governed -- no CCULB, no individual override in this CC, per
// budgets.ts): faisal-noor 4,180, grace-omalley 4,020, hugo-almeida 3,480,
// ling-zhou 2,980, yusuf-demir 2,640, peter-nkosi 2,210, sofia-marin 720,
// dev-raman 0 -- every one comfortably under the 4,600-credit universal ULB,
// so nobody is blocked via the ULB lever either before or after. Net: all 8
// newly block, 0 newly unblock -- pinned as the REAL engine output (verified
// by reading resolveUserBlockStatus + the fixture rows directly), matching
// the plan's own hand-derivation.

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

async function openControlsCaps(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Controls');
  await window.getByRole('tab', { name: 'Included-usage caps' }).click();
  await expect(window.getByText(/auto-computed from attributed licenses; choose block or overflow\./)).toBeVisible();
}

test('caps grid renders 6 fixture-derived cards (API-ONLY pills, cap-bound over/100%, metered selected) with NO number inputs anywhere', async () => {
  const { app, dbDir } = await launchApp('caps-rows');
  try {
    const window = await app.firstWindow();
    await openControlsCaps(window);

    const grid = window.locator('.included-caps__grid');
    await expect(grid.locator('.included-caps__card')).toHaveCount(6);
    // Every included-usage cap card is API-only (CLAUDE.md §5: no native
    // GitHub UI exists for this control at all) -- unconditional, unlike
    // UlbTable's CCULB-only pill.
    await expect(grid.locator('.included-caps__apionly-pill')).toHaveCount(6);
    await expect(grid.locator('.included-caps__apionly-pill').first()).toHaveText('API-ONLY');

    // The defining acceptance check (CLAUDE.md §5 / plan Task 4.12): no
    // dial-able amount anywhere on this tab -- zero number inputs, and the
    // ONLY <input> at all is "Controls scale features"'s free-text name
    // filter (a text search box, never an amount).
    await expect(window.locator('.controls__main input')).toHaveCount(1);
    await expect(window.locator('.controls__main input[type="number"]')).toHaveCount(0);
    await expect(window.getByLabel('Search included-usage caps')).toHaveAttribute('type', 'text');

    const workforce = grid.locator('[data-control-id="included_cap:Workforce Australia Platform"]');
    await expect(workforce.getByText('≈168,000')).toBeVisible();
    await expect(workforce.getByText('funded by 24 licenses')).toBeVisible();
    await expect(workforce.getByText('30,200 drawn')).toBeVisible();
    await expect(workforce.getByText('18% of carve drawn')).toBeVisible();
    await expect(workforce.getByRole('button', { name: 'Block', pressed: true })).toBeVisible();
    await expect(workforce.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    const employer = grid.locator('[data-control-id="included_cap:Employer & Provider Portals"]');
    await expect(employer.getByText('≈112,000')).toBeVisible();
    await expect(employer.getByText('funded by 16 licenses')).toBeVisible();
    await expect(employer.getByText('18,900 drawn')).toBeVisible();
    await expect(employer.getByText('17% of carve drawn')).toBeVisible();
    await expect(employer.getByRole('button', { name: 'Block', pressed: true })).toBeVisible();

    const payments = grid.locator('[data-control-id="included_cap:Payments Integrity Engineering"]');
    await expect(payments.getByText('≈56,000')).toBeVisible();
    await expect(payments.getByText('funded by 8 licenses')).toBeVisible();
    await expect(payments.getByText('58,300 drawn')).toBeVisible();
    await expect(payments.getByText('over cap · overflowing')).toBeVisible();
    await expect(payments.getByRole('button', { name: 'Overflow → metered', pressed: true })).toBeVisible();
    await expect(payments.getByRole('button', { name: 'Block', pressed: false })).toBeVisible();
    await expect(payments.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    const dataEval = grid.locator('[data-control-id="included_cap:Data & Evaluation Platform"]');
    await expect(dataEval.getByText('≈63,000')).toBeVisible();
    await expect(dataEval.getByText('funded by 9 licenses')).toBeVisible();
    await expect(dataEval.getByText('57,400 drawn')).toBeVisible();
    await expect(dataEval.getByText('91% of carve drawn')).toBeVisible();
    await expect(dataEval.getByRole('button', { name: 'Block', pressed: true })).toBeVisible();

    const cyber = grid.locator('[data-control-id="included_cap:Cyber & Identity Services"]');
    await expect(cyber.getByText('≈77,000')).toBeVisible();
    await expect(cyber.getByText('funded by 11 licenses')).toBeVisible();
    await expect(cyber.getByText('15,000 drawn')).toBeVisible();
    await expect(cyber.getByText('19% of carve drawn')).toBeVisible();

    const corporate = grid.locator('[data-control-id="included_cap:Corporate Systems"]');
    await expect(corporate.getByText('≈91,000')).toBeVisible();
    await expect(corporate.getByText('funded by 13 licenses')).toBeVisible();
    await expect(corporate.getByText('12,300 drawn')).toBeVisible();
    await expect(corporate.getByText('14% of carve drawn')).toBeVisible();

    // No staged changes yet -- the rail's empty state.
    await expect(window.getByText('No staged changes')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('disable the Data & Evaluation Platform cap: stage -> "-" diff -> 0/0 dry-run -> apply PATCHes cc-data-evaluation with EXACTLY {enabled:false}', async () => {
  const { app, dbDir } = await launchApp('caps-disable');
  try {
    const window = await app.firstWindow();
    await openControlsCaps(window);

    const grid = window.locator('.included-caps__grid');
    const dataEval = grid.locator('[data-control-id="included_cap:Data & Evaluation Platform"]');
    const rail = window.locator('.plan-rail');

    await dataEval.getByRole('switch', { name: 'Included-usage cap enabled — Data & Evaluation Platform' }).click();

    await expect(dataEval).toHaveClass(/included-caps__card--disabled/);
    await expect(dataEval.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(dataEval.getByText('● staged change')).toBeVisible();

    // planDiffLines' `enabled` field uses a +/- marker (mirroring
    // preventFurtherUsage), not '~' -- disabling renders as a '-' removal
    // line, verified against PlanRail.tsx directly (see file header).
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText(
      '- included_cap["Data & Evaluation Platform"].enabled: true → false',
    );
    await expect(rail.locator('.plan-rail__diff-line--delete')).toHaveCount(1);

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // Data & Evaluation's cap headroom is +5,600 (63,000 - 57,400) -- never
    // <= 0 -- so this cap has never been anyone's binding constraint,
    // enabled or not: disabling it removes a non-blocking candidate, moving
    // nobody's status. Genuinely 0/0, not an accidental empty simulation.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);
    await expect(rail.locator('.plan-rail__warning')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: Data & Evaluation cap paused pending license true-up');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('Simulated apply');
    await expect(applied).toContainText('PATCH');
    await expect(applied).toContainText('/settings/billing/cost-centers/cc-data-evaluation');
    await expect(applied).toContainText('included_cap.update');
    await expect(applied).toContainText('included_cap:Data & Evaluation Platform');

    // Strict payload assertion: EXACTLY the machine-verified flat wire body
    // {ai_credit_pool_enabled:false} (W1 closed 2026-07-09; the nested
    // included_usage_cap shape was our internal model, never the wire) -- no
    // amount field, no extra keys (CLAUDE.md §5's never-dial-able cap).
    const mutationBodyText = await applied.locator('.plan-rail__mutation-body').innerText();
    const parsedBody: unknown = JSON.parse(mutationBodyText);
    expect(parsedBody).toStrictEqual({ ai_credit_pool_enabled: false });

    await expect(window.locator('.controls-toast')).toContainText(/Simulated apply/i);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('the money test: flip Payments Integrity Engineering from overflow-to-metered to Block -- all 8 members newly cap-block; overflow is a sim-only what-if, so NO wire mutation is issued', async () => {
  const { app, dbDir } = await launchApp('caps-money');
  try {
    const window = await app.firstWindow();
    await openControlsCaps(window);

    const grid = window.locator('.included-caps__grid');
    const payments = grid.locator('[data-control-id="included_cap:Payments Integrity Engineering"]');
    const rail = window.locator('.plan-rail');

    await expect(payments.getByRole('button', { name: 'Overflow → metered', pressed: true })).toBeVisible();

    await payments.getByRole('button', { name: 'Block' }).click();

    await expect(payments.getByRole('button', { name: 'Block', pressed: true })).toBeVisible();
    await expect(payments.getByText('● staged change')).toBeVisible();
    // Enabling stays untouched by this edit -- the cap remains on the whole time.
    await expect(payments.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    // Only the `overflow` field ever renders the '~' marker (see file header).
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText(
      '~ included_cap["Payments Integrity Engineering"].overflow: metered → block',
    );
    await expect(rail.locator('.plan-rail__diff-line--change')).toHaveCount(1);

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // The money assertion (see file header derivation): Payments Integrity's
    // pool draw (56,000) exactly equals its computed cap (56,000) -> headroom
    // 0. Under 'metered' that candidate can never block (overflow re-routes
    // rather than stopping usage); flipping to 'block' makes it binding at
    // exactly zero headroom for every member, since the CC-aggregate headroom
    // doesn't vary per member. All 8 are universal-ULB-governed with MTD
    // usage well under the 4,600-credit universal cap (see file header), so
    // none was already blocked via their own ULB -- all 8 newly block.
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('8');
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-users')).toHaveText(
      'dev-raman, faisal-noor, grace-omalley, hugo-almeida, ling-zhou, peter-nkosi, sofia-marin, yusuf-demir',
    );
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);

    await rail.getByLabel('Justification (required)').fill('e2e: Payments Integrity cap now hard-blocks at the carve line');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    // A2 resolved (2026-07-09, OpenAPI + live R2 dump): NO per-CC overflow
    // wire field exists -- block-vs-metered hangs off the enterprise "AI
    // credit paid usage" policy. The overflow knob is a SIM-ONLY what-if
    // (maintainer decision), so this apply issues ZERO HTTP mutations; the
    // audit event is the record of the internal what-if. (The old assertion
    // here pinned a PATCH body {included_usage_cap:{overflow:'block'}} -- a
    // disproven wire shape our own invented handler used to accept.)
    await expect(applied).toContainText('included_cap.update');
    await expect(applied).toContainText('included_cap:Payments Integrity Engineering');
    await expect(applied.locator('.plan-rail__mutation-body')).toHaveCount(0);
    await expect(applied).not.toContainText('PATCH');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
