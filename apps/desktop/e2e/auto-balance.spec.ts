import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication, type Page, type Request } from '@playwright/test';

// ============================================================================
// Task 6.8 -- the Auto-balance screen, POOL mode, dry-run only. Every pinned
// number below is an ENGINE literal (packages/data/src/msw/fixtures/
// scenarios.engine.test.ts + packages/data/src/api-client/
// rebalance-context.test.ts prove the same values through the same bridge
// assembly): 17 at-risk; envelope segments 28,350 / 7,500 / 12,800 / 7,200
// (sum = remaining pool 55,850; grantable envelope 20,000); 7 funded ULB
// grants + 9 cap-relax rows (unlock 5,000 each); sim 520,000 -> 532,800
// (91.7% -> 94.0%), tip 4.0%, 7 unblocked.
//
// Checkpoint 6: NO mutation may be issuable from this screen -- asserted here
// via (a) the permanently disabled gated apply button, (b) zero POST/PATCH/
// DELETE renderer requests across every interaction, and (c) an audit chain
// that stays EMPTY (every real write appends an audit event).
// ============================================================================

async function launch(): Promise<{ app: ElectronApplication; window: Page; cleanup: () => void }> {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-autobalance-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-autobalance-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });
  const window = await app.firstWindow();
  return {
    app,
    window,
    cleanup: () => {
      rmSync(dbDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function forceScenario(window: Page, id: string): Promise<void> {
  // The 6.7 force-a-scenario-per-test pattern (scenarios.spec.ts): drive the
  // bridge directly, then reload so the renderer re-reads the new world.
  const res = await window.evaluate(
    (scenarioId) =>
      (window as unknown as { api: { setScenario(i: string): Promise<{ refused: boolean }> } }).api.setScenario(scenarioId),
    id,
  );
  expect(res.refused).toBe(false);
  await window.reload();
}

async function openAutoBalance(window: Page): Promise<void> {
  await window.getByRole('button', { name: /^Auto-balance/ }).click();
}

const CAP_CC_TOGGLE = 'ab-cap-toggle-cost_center:Payments Integrity Engineering';

test('AT-RISK: full ①→④ flow renders the engine literals, recomputes live on edits, and exposes no apply path', async () => {
  const { app, window, cleanup } = await launch();
  const pageErrors: Error[] = [];
  window.on('pageerror', (error) => pageErrors.push(error));
  const mutationRequests: string[] = [];
  window.on('request', (req: Request) => {
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method())) mutationRequests.push(`${req.method()} ${req.url()}`);
  });

  try {
    await forceScenario(window, 'at-risk');
    await openAutoBalance(window);

    // Mode switch defaults to the scenario's phase (pool) with the design tag.
    await expect(window.getByTestId('ab-mode-pool')).toHaveAttribute('aria-selected', 'true');

    // -- ① trigger: fired, amber, engine sentence + truthful chips.
    await expect(window.getByTestId('ab-trigger-sentence')).toHaveText(
      'Day 26/30 · pool 90.1% consumed · projected 91.7% at reset → ~8.3% forfeit · 4 blocked, 13 approaching.',
    );
    await expect(window.getByTestId('ab-day')).toHaveText('Day 26/30');
    const chips = window.locator('.ab-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(0)).toContainText('3 day(s) remaining (window: 7)');
    await expect(chips.nth(1)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(2)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(2)).toContainText('17 at-risk (4 blocked, 13 approaching)');

    // -- ② envelope: 20,000 redistributable; segments sum to 55,850.
    await expect(window.getByTestId('ab-env-redistributable')).toHaveText('20,000 redistributable');
    await expect(window.getByTestId('ab-env-reserve')).toHaveText('28,350');
    await expect(window.getByTestId('ab-env-held')).toHaveText('7,500');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('12,800');
    await expect(window.getByTestId('ab-env-slack')).toHaveText('7,200');

    // -- ③ table: 7 editable ULB grant rows + 9 cap-relax toggle rows = 16.
    await expect(window.locator('.ab-row')).toHaveCount(16);
    await expect(window.locator('.ab-row__input')).toHaveCount(7); // ULB rows only carry a number input
    await expect(window.locator('.ab-cap-toggle')).toHaveCount(9); // cap rows only carry a toggle
    // Blocked-first, then login-asc within the tie (the engine's ranking).
    await expect(window.locator('.ab-row__entity').first()).toHaveText('user: ali-rezaei');
    // The converts-from sub-label: every grant here converts from the Universal ULB.
    await expect(window.getByTestId('ab-row-ali-rezaei')).toContainText('converts from Universal ULB');
    await expect(window.getByTestId('ab-delta-ali-rezaei')).toHaveValue('2400');
    await expect(window.getByTestId('ab-status-ali-rezaei')).toContainText('funded');
    // Cap rows: no number input, fixed 5,000 unlock, GitHub-computed cap 56,000.
    const capRow = window.getByTestId('ab-cap-row-cost_center:Payments Integrity Engineering');
    await expect(capRow).toContainText('Lift usage cap');
    await expect(capRow).toContainText('cap 56,000 · auto-computed — not settable');
    await expect(capRow).toContainText('~5,000 blocked demand');
    await expect(capRow.locator('input')).toHaveCount(0); // structurally never a number field
    await expect(window.getByTestId('ab-footer-funded')).toContainText('7 of 7 funded');
    await expect(window.getByTestId('ab-footer-alloc')).toContainText('allocated 12,800 · unallocated 7,200');

    // -- ④ simulate: engine literals.
    await expect(window.getByTestId('ab-sim-util')).toHaveText('91.7% → 94.0%');
    await expect(window.getByTestId('ab-sim-tip')).toHaveText('4.0%');
    await expect(window.getByTestId('ab-sim-unblocked')).toHaveText('7');
    await expect(window.getByTestId('ab-assurance')).toContainText(
      'Stays within the remaining pool — 12,800 of the 20,000 envelope used',
    );

    // -- LIVE EDIT (pinned before/after pair): ali-rezaei 2,400 -> 1,000.
    //    Envelope bar: grants 12,800 -> 11,400, slack 7,200 -> 8,600;
    //    rail: after 94.0% -> 93.7%, tip 4.0% -> 3.4%, unblocked 7 -> 6;
    //    footer: 7 of 7 -> 6 of 7, allocated 11,400 · unallocated 8,600.
    await window.getByTestId('ab-delta-ali-rezaei').fill('1000');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('11,400');
    await expect(window.getByTestId('ab-env-slack')).toHaveText('8,600');
    await expect(window.getByTestId('ab-sim-util')).toHaveText('91.7% → 93.7%');
    await expect(window.getByTestId('ab-sim-tip')).toHaveText('3.4%');
    await expect(window.getByTestId('ab-sim-unblocked')).toHaveText('6');
    await expect(window.getByTestId('ab-status-ali-rezaei')).toContainText('partial');
    await expect(window.getByTestId('ab-footer-funded')).toContainText('6 of 7 funded');
    await expect(window.getByTestId('ab-footer-alloc')).toContainText('allocated 11,400 · unallocated 8,600');

    // -- OVER-ALLOCATION: ali-rezaei -> 12,000 (Sigma 22,400 > 20,000 envelope).
    //    Red warning; the (already gated) apply stays disabled.
    await window.getByTestId('ab-delta-ali-rezaei').fill('12000');
    await expect(window.getByTestId('ab-assurance')).toContainText(
      'Allocation exceeds the envelope — 22,400 granted against 20,000 redistributable',
    );
    await expect(window.getByTestId('ab-footer-alloc')).toContainText('allocated 22,400 · over the envelope by 2,400');
    await expect(window.getByTestId('ab-apply')).toBeDisabled();

    // -- RESET restores the engine's suggested allocation.
    await window.getByRole('button', { name: 'reset to suggested' }).click();
    await expect(window.getByTestId('ab-delta-ali-rezaei')).toHaveValue('2400');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('12,800');
    await expect(window.getByTestId('ab-assurance')).toContainText('Stays within the remaining pool');

    // -- CAP TOGGLE contributes its FIXED 5,000 unlock to the simulated draw
    //    (532,800 + 5,000 = 537,800 -> 94.9%, tip 6.7%) WITHOUT becoming a
    //    grant: the envelope's grants segment, allocated total, and unblocked
    //    count are untouched.
    await window.getByTestId(CAP_CC_TOGGLE).click();
    await expect(window.getByTestId(CAP_CC_TOGGLE)).toContainText('lift → +5,000');
    await expect(window.getByTestId('ab-sim-util')).toHaveText('91.7% → 94.9%');
    await expect(window.getByTestId('ab-sim-tip')).toHaveText('6.7%');
    await expect(window.getByTestId('ab-sim-unblocked')).toHaveText('7');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('12,800');
    await expect(window.getByTestId('ab-footer-cap')).toHaveText('· cap unlock +5,000');
    // Toggle back off: contribution reverts.
    await window.getByTestId(CAP_CC_TOGGLE).click();
    await expect(window.getByTestId(CAP_CC_TOGGLE)).toContainText('keep cap');
    await expect(window.getByTestId('ab-sim-util')).toHaveText('91.7% → 94.0%');

    // -- ⑤ gated apply: permanently disabled dry-run copy; NO mutation issued.
    const apply = window.getByTestId('ab-apply');
    await expect(apply).toHaveText('Dry-run only — auto-apply arrives with guardrails');
    await expect(apply).toBeDisabled();
    expect(mutationRequests).toEqual([]); // no POST/PATCH/DELETE left the renderer
    // The audit chain stays empty -- every real write path appends an event.
    const audit = await window.evaluate(() =>
      (window as unknown as { api: { getAuditChain(): Promise<unknown[]> } }).api.getAuditChain(),
    );
    expect(audit).toEqual([]);

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('HEALTHY (default): not-fired trigger with truthful chips, honest empty table, gated apply', async () => {
  const { app, window, cleanup } = await launch();
  const pageErrors: Error[] = [];
  window.on('pageerror', (error) => pageErrors.push(error));

  try {
    await openAutoBalance(window);

    // Not fired: neutral dot state, honest sentence, and TRUTHFUL chips --
    // near-cycle-end UNMET (16 days out), underutilisation MET, at-risk MET
    // (the DEWR world's standing cap-bound team + $0-ULB block).
    await expect(window.getByTestId('ab-trigger-sentence')).toHaveText(
      'Day 13/30 · pool 33.5% consumed · projected 77.2% at reset → ~22.8% forfeit · trigger conditions not met — no redistribution proposed.',
    );
    const chips = window.locator('.ab-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute('data-met', 'false');
    await expect(chips.nth(0)).toContainText('not met');
    await expect(chips.nth(0)).toContainText('16 day(s) remaining (window: 7)');
    await expect(chips.nth(1)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(2)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(2)).toContainText('10 at-risk (10 blocked, 0 approaching)');

    // Honest empty state -- no grants table content when the trigger hasn't fired.
    await expect(window.getByTestId('ab-empty')).toContainText('Trigger conditions not met — no redistribution proposed');
    await expect(window.locator('.ab-row')).toHaveCount(0);

    // Envelope still renders engine truth (reserve carved out, all slack).
    await expect(window.getByTestId('ab-env-reserve')).toHaveText('28,350');
    await expect(window.getByTestId('ab-env-slack')).toHaveText('348,850');

    // Rail: nothing changes (before == after), zero unblocked; gated apply.
    await expect(window.getByTestId('ab-sim-util')).toHaveText('77.2% → 77.2%');
    await expect(window.getByTestId('ab-sim-unblocked')).toHaveText('0');
    await expect(window.getByTestId('ab-apply')).toBeDisabled();

    // Metered pane: HEALTHY carries no metered-rebalancer inputs (a pool-phase
    // scenario) -- the bridge honestly refuses ({ available: false }, Task 6.9's
    // getRebalanceContext('metered') branch), rendered as the same unavailable
    // card pattern the pool pane already uses for its own refusal shape.
    await window.getByTestId('ab-mode-metered').click();
    await expect(window.getByTestId('ab-unavailable')).toContainText(
      'the active scenario ("healthy") carries no metered-rebalancer inputs',
    );
    await window.getByTestId('ab-mode-pool').click();
    await expect(window.getByTestId('ab-trigger-sentence')).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});

// ============================================================================
// Task 6.9 -- METERED mode. Every pinned number is an ENGINE literal, the same
// scenarios.engine.test.ts + rebalance-context.test.ts source the pool test
// above draws from: envelope base/reserve/held/allocatable/granted/slack
// 500,000 / 0 / 0 / 500,000 / 6,000 / 494,000 credits ($5,000 / $0 / $0 /
// $5,000 / $60 / $4,940); 2 grants (Data & Evaluation Platform cc-budget
// raise +5,000 credits/$50, sam-kelly individual override +1,000 credits/$10,
// both fully funded); bill delta $60, projected total metered $3,060,
// remaining headroom $4,940, 2 unblocked.
// ============================================================================

const DATA_EVAL_KEY = 'cost_center:Data & Evaluation Platform';
const SAM_KEY = 'user:sam-kelly';

test('METERED: full ①→④ flow renders the engine literals, recomputes live on edits, and exposes no apply path', async () => {
  const { app, window, cleanup } = await launch();
  const pageErrors: Error[] = [];
  window.on('pageerror', (error) => pageErrors.push(error));
  const mutationRequests: string[] = [];
  window.on('request', (req: Request) => {
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method())) mutationRequests.push(`${req.method()} ${req.url()}`);
  });

  try {
    await forceScenario(window, 'metered');
    await openAutoBalance(window);

    // Mode switch defaults to the scenario's phase (metered).
    await expect(window.getByTestId('ab-mode-metered')).toHaveAttribute('aria-selected', 'true');

    // -- ① trigger: fired, engine sentence + truthful chips.
    await expect(window.getByTestId('ab-trigger-sentence')).toHaveText(
      'Metered phase · enterprise budget $8,000, $5,000 unused · 2 entities at or above a hard-stop metered cap.',
    );
    const chips = window.locator('.ab-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(1)).toHaveAttribute('data-met', 'true');
    await expect(chips.nth(1)).toContainText('2 entities ≥ 95% of a hard-stop metered cap.');
    await expect(chips.nth(2)).toHaveAttribute('data-met', 'true');
    // Engine's own detail template is UNFORMATTED (usd() just divides by 100, no $/comma -- meteredRebalancer.ts's condition builder).
    await expect(chips.nth(2)).toContainText('Enterprise budget has 5000 allocatable above reserve.');

    // -- ② envelope: $5,000 allocatable; reserve $0, held absent (0), grants $60, slack $4,940.
    await expect(window.getByTestId('ab-env-allocatable')).toHaveText('$5,000 allocatable');
    await expect(window.getByTestId('ab-env-reserve')).toHaveText('$0');
    await expect(window.locator('[data-testid="ab-env-held"]')).toHaveCount(0); // held segment is 0 -- not rendered
    await expect(window.getByTestId('ab-env-grants')).toHaveText('$60');
    await expect(window.getByTestId('ab-env-slack')).toHaveText('$4,940');

    // -- ③ table: 2 editable grant rows, ranked Data & Evaluation (util 120%) then sam-kelly (util 118.5%).
    await expect(window.locator('.ab-row')).toHaveCount(2);
    await expect(window.locator('.ab-row__input')).toHaveCount(2);
    await expect(window.locator('.ab-row').first()).toHaveAttribute('data-testid', `ab-row-${DATA_EVAL_KEY}`);
    await expect(window.getByTestId(`ab-row-${DATA_EVAL_KEY}`)).toContainText('CC: Data & Evaluation Platform');
    await expect(window.getByTestId(`ab-row-${DATA_EVAL_KEY}`)).toContainText('Cost-center budget');
    await expect(window.getByTestId(`ab-row-${DATA_EVAL_KEY}`)).toContainText('120.0%');
    await expect(window.getByTestId(`ab-row-${DATA_EVAL_KEY}`)).toContainText('~$50 remaining demand');
    await expect(window.getByTestId(`ab-delta-${DATA_EVAL_KEY}`)).toHaveValue('50');
    await expect(window.getByTestId(`ab-status-${DATA_EVAL_KEY}`)).toContainText('funded');

    await expect(window.getByTestId(`ab-row-${SAM_KEY}`)).toContainText('user: sam-kelly');
    await expect(window.getByTestId(`ab-row-${SAM_KEY}`)).toContainText('Individual ULB');
    await expect(window.getByTestId(`ab-row-${SAM_KEY}`)).toContainText('118.5%');
    await expect(window.getByTestId(`ab-row-${SAM_KEY}`)).toContainText('~$10 remaining demand');
    await expect(window.getByTestId(`ab-delta-${SAM_KEY}`)).toHaveValue('10');
    await expect(window.getByTestId(`ab-status-${SAM_KEY}`)).toContainText('funded');

    await expect(window.getByTestId('ab-footer-funded')).toContainText('2 of 2 funded');
    await expect(window.getByTestId('ab-footer-alloc')).toContainText('allocated $60 · unallocated $4,940');

    // No flagged-enterprise-raise row in this scenario (both entities resolve
    // to a grantable ULB/cc-budget binding, per the engine-proof test).
    await expect(window.locator('.ab-row--flagged')).toHaveCount(0);

    // -- ④ simulate: bill delta hero + engine literals.
    await expect(window.getByTestId('ab-sim-bill-delta')).toHaveText('+$60');
    await expect(window.getByTestId('ab-sim-projected')).toHaveText('$3,060');
    await expect(window.getByTestId('ab-sim-headroom')).toHaveText('$4,940');
    await expect(window.getByTestId('ab-sim-unblocked')).toHaveText('2');
    await expect(window.getByTestId('ab-assurance')).toContainText('Stays within enterprise headroom');

    // -- LIVE EDIT (pinned before/after pair): Data & Eval $50 -> $20 (2,000
    //    credits) -- new limit 27,000 < demand 30,000 -> STILL blocked, so it
    //    drops out of "unblocked" and its own bill-delta contribution shrinks
    //    to 27,000-25,000=2,000 credits ($20). sam-kelly untouched ($10, $10
    //    bill, stays unblocked). Envelope: grants $60 -> $30, slack $4,940 ->
    //    $4,970. Rail: bill delta +$60 -> +$30, projected $3,060 -> $3,030,
    //    headroom $4,940 -> $4,970, unblocked 2 -> 1. Footer: 2 of 2 -> 1 of 2,
    //    allocated $30 · unallocated $4,970.
    await window.getByTestId(`ab-delta-${DATA_EVAL_KEY}`).fill('20');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('$30');
    await expect(window.getByTestId('ab-env-slack')).toHaveText('$4,970');
    await expect(window.getByTestId('ab-sim-bill-delta')).toHaveText('+$30');
    await expect(window.getByTestId('ab-sim-projected')).toHaveText('$3,030');
    await expect(window.getByTestId('ab-sim-headroom')).toHaveText('$4,970');
    await expect(window.getByTestId('ab-sim-unblocked')).toHaveText('1');
    await expect(window.getByTestId(`ab-status-${DATA_EVAL_KEY}`)).toContainText('partial');
    await expect(window.getByTestId('ab-footer-funded')).toContainText('1 of 2 funded');
    await expect(window.getByTestId('ab-footer-alloc')).toContainText('allocated $30 · unallocated $4,970');

    // -- OVER-ALLOCATION: sam-kelly -> $6,000 (600,000 credits). Combined with
    //    the still-edited Data & Eval $20 (2,000 credits), granted-from-envelope
    //    = 602,000 credits > 500,000 allocatable -> slack -102,000 credits
    //    (-$1,020). Red warning; the (already gated) apply stays disabled.
    await window.getByTestId(`ab-delta-${SAM_KEY}`).fill('6000');
    await expect(window.getByTestId('ab-assurance')).toContainText('Allocation exceeds enterprise headroom');
    await expect(window.getByTestId('ab-footer-alloc')).toContainText('over the envelope by $1,020');
    await expect(window.getByTestId('ab-apply')).toBeDisabled();

    // -- RESET restores the engine's suggested allocation.
    await window.getByRole('button', { name: 'reset to suggested' }).click();
    await expect(window.getByTestId(`ab-delta-${DATA_EVAL_KEY}`)).toHaveValue('50');
    await expect(window.getByTestId(`ab-delta-${SAM_KEY}`)).toHaveValue('10');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('$60');
    await expect(window.getByTestId('ab-assurance')).toContainText('Stays within enterprise headroom');

    // -- ⑤ gated apply: permanently disabled dry-run copy; NO mutation issued.
    const apply = window.getByTestId('ab-apply');
    await expect(apply).toHaveText('Dry-run only — auto-apply arrives with guardrails');
    await expect(apply).toBeDisabled();
    expect(mutationRequests).toEqual([]); // no POST/PATCH/DELETE left the renderer
    const audit = await window.evaluate(() =>
      (window as unknown as { api: { getAuditChain(): Promise<unknown[]> } }).api.getAuditChain(),
    );
    expect(audit).toEqual([]);

    // Pool pane: METERED carries no pool-rebalancer inputs -- the bridge
    // honestly refuses, same unavailable-card treatment as the reverse case.
    await window.getByTestId('ab-mode-pool').click();
    await expect(window.getByTestId('ab-unavailable')).toContainText(
      'the active scenario ("metered") carries no pool-rebalancer inputs',
    );

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});

// ============================================================================
// Task 6.9 -- per-mode edit retention (design state note: `abAlloc` keyed
// `mode:entityId`). No single scenario fires BOTH rebalancers with editable
// rows at once (a fixture-set property, not a UI one -- METERED_SCENARIO_INPUTS
// only covers the 'metered' scenario id, POOL_SCENARIO_INPUTS only covers the
// pool-phase ids), so this is proven as two round-trips -- an edit in the
// AVAILABLE mode must survive a detour through the OTHER mode's (unavailable,
// for this scenario) pane and back, which is exactly what "switching modes
// doesn't unmount-and-lose state" requires: the abAlloc map lives above both
// mode subtrees regardless of which pane is currently mounted.
// ============================================================================

test('mode-switch retention: a pool-mode edit survives a detour through the metered pane and back', async () => {
  const { app, window, cleanup } = await launch();

  try {
    await forceScenario(window, 'at-risk');
    await openAutoBalance(window);

    await window.getByTestId('ab-delta-ali-rezaei').fill('1000');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('11,400');

    await window.getByTestId('ab-mode-metered').click();
    await expect(window.getByTestId('ab-unavailable')).toBeVisible(); // at-risk carries no metered inputs

    await window.getByTestId('ab-mode-pool').click();
    await expect(window.getByTestId('ab-delta-ali-rezaei')).toHaveValue('1000'); // edit preserved
    await expect(window.getByTestId('ab-env-grants')).toHaveText('11,400');
  } finally {
    await app.close();
    cleanup();
  }
});

test('mode-switch retention: a metered-mode edit survives a detour through the pool pane and back', async () => {
  const { app, window, cleanup } = await launch();

  try {
    await forceScenario(window, 'metered');
    await openAutoBalance(window);

    await window.getByTestId(`ab-delta-${SAM_KEY}`).fill('20');
    await expect(window.getByTestId('ab-env-grants')).toHaveText('$70'); // 5,000 + 2,000 credits

    await window.getByTestId('ab-mode-pool').click();
    await expect(window.getByTestId('ab-unavailable')).toBeVisible(); // metered carries no pool inputs

    await window.getByTestId('ab-mode-metered').click();
    await expect(window.getByTestId(`ab-delta-${SAM_KEY}`)).toHaveValue('20'); // edit preserved
    await expect(window.getByTestId('ab-env-grants')).toHaveText('$70');
  } finally {
    await app.close();
    cleanup();
  }
});
