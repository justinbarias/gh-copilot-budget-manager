import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 4.9: Controls screen -- Spending-limits family end to end through the
// REAL UI (stage -> dry-run -> apply), against MSW. write-engine.spec.ts
// already proves the window.api write surface round-trips; this spec proves
// the screen drives it correctly: staging is local-only, the rail's diff is
// exact, the dry-run numbers are fixture-derived, blockers gate Apply, the
// §6.3 hard-stop-off override gates Apply, and a §6.8 apply is unmistakably
// simulated.
//
// Every expected value below is derived from committed fixtures
// (msw/fixtures/budgets.ts, usage.ts, costCenters.ts), never observed output:
//   - Platform cost-center spending limit: $600 -> 60,000 credits (PFU false).
//   - Data & Analytics cost-center spending limit: $250 -> 25,000 credits
//     (PFU TRUE -- the one hard-stop-on Family-B fixture, added for §6.3).
//   - Enterprise spending limit: $8,000 -> 800,000 credits.
//   - Cost-center sum post-fixtures: 60,000 + 25,000 = 85,000.
//   - Platform 60,000 -> 65,000 stages one 'change' entry; simulatePlan yields
//     0 newly blocked / 0 newly unblocked (nobody is spending-limit-bound at
//     current usage) and a +5,000-credit / $50.00 metered-capacity delta.
//   - PATCH body for that change: {"budget_amount":650} (65,000 credits = $650).

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

async function openControls(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Controls');
  // Task 4.10 flips the screen's default tab to User-level budgets (the
  // design's ULB-first tab order) -- this spec is about Spending limits, so
  // navigate there explicitly rather than relying on the default.
  await window.getByRole('tab', { name: 'Spending limits' }).click();
  await expect(window.getByText(/Cap metered charges only/)).toBeVisible();
}

test('stage -> dry-run -> apply: exact diff, fixture-derived simulation, correct PATCH payload, audit event, visibly simulated', async () => {
  const { app, dbDir } = await launchApp('controls-apply');
  try {
    const window = await app.firstWindow();
    await openControls(window);

    // All four Family-B fixture rows render (enterprise, org, 2 cost centers),
    // each with the amber icon+text phase badge.
    const table = window.locator('.controls-table');
    await expect(table.locator('.controls-table__row')).toHaveCount(4);
    await expect(table.getByText('metered only')).toHaveCount(4);

    const platformRow = table.locator('[data-control-id="budget:cost_center:Platform"]');
    await expect(platformRow.getByText('CC: Platform')).toBeVisible();

    // Utilization meters are fixture-derived, never faked: Platform's metered
    // spend is 190 credits (user-05's 2026-09-01 net $1.90) against 60,000.
    // The org row has no per-org usage attribution -> honest empty meter.
    await expect(platformRow.getByText('0% used · 190 of 60,000')).toBeVisible();
    const orgRow = table.locator('[data-control-id="budget:organization:acme-eng-org"]');
    await expect(orgRow.getByText('no per-org usage data')).toBeVisible();

    // Before any edit: the rail shows the empty-plan card, no staged markers.
    await expect(window.getByText('No staged changes')).toBeVisible();
    await expect(table.getByText('● staged change')).toHaveCount(0);

    // Stage: raise the Platform cap 60,000 -> 65,000. Local-only (nothing writes).
    await platformRow.getByLabel('Cap (credits) — CC: Platform').fill('65000');
    await expect(platformRow.getByText('● staged change')).toBeVisible();

    // The rail's Terraform-style diff line is exact.
    const rail = window.locator('.plan-rail');
    await expect(rail.getByText('Plan — desired vs. live')).toBeVisible();
    await expect(rail.locator('.plan-rail__diff-line')).toHaveCount(1);
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ cost_center["Platform"].cap: 60,000 → 65,000');

    // No dry-run yet -> no justification/apply section at all.
    await expect(rail.getByLabel('Justification (required)')).toHaveCount(0);

    // Dry-run: fixture-derived simulation numbers.
    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await expect(rail.locator('.plan-rail__sim-tile--blocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-tile--unblocked .plan-rail__sim-count')).toHaveText('0');
    await expect(rail.locator('.plan-rail__sim-delta-value')).toHaveText('+5,000 credits · $50.00');
    await expect(rail.locator('.plan-rail__blocker')).toHaveCount(0);

    // Apply gating: justification required.
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeDisabled();
    await rail.getByLabel('Justification (required)').fill('e2e: raise Platform metered cap for Q1 crunch');
    await expect(applyButton).toBeEnabled();

    // §6.8: the apply affordance itself says it is simulated, before clicking.
    await expect(applyButton).toHaveText('Apply changes (simulated)');
    await expect(rail.getByText(/apply is simulated — no real GitHub budget or cap will change/i)).toBeVisible();

    await applyButton.click();

    // Applied arm: the result panel surfaces the actual mutation issued --
    // correct method, endpoint, and payload (65,000 credits = $650) -- plus
    // the audit event that was appended, and it is visibly simulated.
    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied.getByText(/Simulated apply — no real GitHub budget or cap was changed/i)).toBeVisible();
    await expect(applied).toContainText('PATCH');
    await expect(applied).toContainText('/settings/billing/budgets/budget-cost-center-platform-metered-1');
    await expect(applied).toContainText('{"budget_amount":650}');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:cost_center:Platform');
    await expect(applied).toContainText('you (FinOps)');

    // Success toast (§6.8: never looks live).
    await expect(window.locator('.controls-toast')).toContainText(/Simulated apply/i);

    // Staged state cleared after a successful apply.
    await expect(table.getByText('● staged change')).toHaveCount(0);
    await expect(window.getByText('No staged changes')).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('blocker path: enterprise cap below the sum of cost-center limits renders the blocker and keeps Apply disabled', async () => {
  const { app, dbDir } = await launchApp('controls-blocker');
  try {
    const window = await app.firstWindow();
    await openControls(window);

    const table = window.locator('.controls-table');
    const entRow = table.locator('[data-control-id="budget:enterprise:acme-enterprise"]');

    // Stage the enterprise cap (800,000) below the cost-center sum (85,000).
    await entRow.getByLabel('Cap (credits) — Enterprise metered budget').fill('50000');

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('~ enterprise["acme-enterprise"].cap: 800,000 → 50,000');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // The CLAUDE.md §6.4 blocker renders with the fixture-derived numbers...
    const blocker = rail.locator('.plan-rail__blocker');
    await expect(blocker).toHaveCount(1);
    await expect(blocker).toContainText('Enterprise cap (50,000) is below the sum of cost-center spending limits (85,000)');

    // ...and actually prevents apply, even with a justification present.
    await rail.getByLabel('Justification (required)').fill('e2e: attempt a blocked enterprise cut');
    await expect(rail.getByRole('button', { name: /Apply changes/ })).toBeDisabled();
    await expect(rail.getByText(/blocked — resolve the blocker/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('§6.3 path: turning a hard stop off demands the explicit override acknowledgment + justification before Apply enables', async () => {
  const { app, dbDir } = await launchApp('controls-6-3');
  try {
    const window = await app.firstWindow();
    await openControls(window);

    const table = window.locator('.controls-table');
    const daRow = table.locator('[data-control-id="budget:cost_center:Data & Analytics"]');

    // Live state: the D&A limit is the one hard-stop-ON Family-B fixture --
    // green toggle, no alert-only pill.
    const toggle = daRow.getByRole('switch', { name: 'Hard stop — CC: Data & Analytics' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(daRow.getByText(/Alert-only — spend continues past this limit/)).toHaveCount(0);

    // Stage: toggle the hard stop off. The loud pill appears immediately and
    // the diff line records the hard_stop transition.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(daRow.getByText('⚠ Alert-only — spend continues past this limit. No hard stop.')).toBeVisible();
    await expect(daRow.getByText('● staged change')).toBeVisible();

    const rail = window.locator('.plan-rail');
    await expect(rail.locator('.plan-rail__diff-line')).toHaveText('- cost_center["Data & Analytics"].hard_stop: true → false');

    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();

    // The validation warning surfaces, and the §6.3 explicit override
    // acknowledgment is demanded on top of the justification.
    await expect(rail.locator('.plan-rail__warning')).toContainText(/Turning off the hard stop/);
    const ack = rail.getByRole('checkbox', { name: /I acknowledge: this removes the hard stop/i });
    await expect(ack).toBeVisible();

    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await rail.getByLabel('Justification (required)').fill('e2e: alert-only for D&A during migration');
    await expect(applyButton).toBeDisabled(); // justification alone is NOT enough (§6.3)
    await ack.check();
    await expect(applyButton).toBeEnabled();

    await applyButton.click();

    // The issued mutation is exactly the hard-stop flip, and it is visibly simulated.
    const applied = rail.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('{"prevent_further_usage":false}');
    await expect(applied).toContainText('budget.update');
    await expect(applied).toContainText('budget:cost_center:Data & Analytics');
    await expect(window.locator('.controls-toast')).toContainText(/Simulated apply/i);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('stale dry-run: any further edit invalidates the simulation and disables Apply until re-run', async () => {
  const { app, dbDir } = await launchApp('controls-stale');
  try {
    const window = await app.firstWindow();
    await openControls(window);

    const table = window.locator('.controls-table');
    const platformRow = table.locator('[data-control-id="budget:cost_center:Platform"]');
    const rail = window.locator('.plan-rail');

    await platformRow.getByLabel('Cap (credits) — CC: Platform').fill('65000');
    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await rail.getByLabel('Justification (required)').fill('e2e: staleness check');
    const applyButton = rail.getByRole('button', { name: /Apply changes/ });
    await expect(applyButton).toBeEnabled();

    // Edit again after the dry-run: the plan changed, so the simulation is stale.
    await platformRow.getByLabel('Cap (credits) — CC: Platform').fill('70000');
    await expect(rail.getByText(/Plan changed since the last dry-run/)).toBeVisible();
    await expect(applyButton).toBeDisabled();

    // Re-running restores an appliable state.
    await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await expect(applyButton).toBeEnabled();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
