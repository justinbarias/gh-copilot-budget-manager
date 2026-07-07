import { Octokit } from 'octokit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateMeteredRebalance,
  grantSpecsFromPlan,
  normalCdf,
  runPoolRebalancer,
  simulateMeteredGrants,
  type PoolRebalanceContext,
  type UsageState,
} from '@copilot-budget/core';
import { assembleUsageState, fetchLiveControls } from '../../write/live-state.js';
import { server } from '../server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from './constants.js';
import { METERED_SCENARIO_INPUTS, POOL_SCENARIO_INPUTS, type PoolScenarioInputs } from './scenarios.js';
import {
  SCENARIO_SUMMARIES,
  getActiveScenarioSummary,
  resetActiveScenario,
  setActiveScenarioId,
  type ScenarioId,
} from '../scenario-state.js';

// ============================================================================
// Task 6.7 -- ENGINE-PROOF tests. Each scenario's assembled state (currentUsage
// + controls from the SAME MSW rollup the UI reads) is fed to the ACTUAL core
// rebalancers; the pinned literals below are the 6.8/6.9 UI contract. The
// projection + pool/metered scalars come from the scenario's exported inputs.
// ============================================================================

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetActiveScenario();
});
afterAll(() => server.close());

const octokit = new Octokit({ baseUrl: GITHUB_API_BASE });
const asOfOf = (id: ScenarioId) => new Date(`${SCENARIO_SUMMARIES.find((s) => s.id === id)!.asOfDate}T00:00:00.000Z`);

async function assemble(id: ScenarioId) {
  setActiveScenarioId(id);
  const asOf = asOfOf(id);
  const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, asOf);
  const currentUsage = await assembleUsageState(octokit, ENTERPRISE_SLUG, live.costCenterIdByName, asOf);
  return { controls: live.controls, currentUsage, asOf };
}

// Task 6.8 (maintainer-ratified 2026-07-07): the context is built from the
// scenario's EXPORTED PoolScenarioInputs (fixtures/scenarios.ts) -- the same
// source getRebalanceContext (the Auto-balance screen's bridge assembly)
// reads -- rather than inline copies of the same scalars. Each scenario block
// still PINS the scalar literals via `expectPoolScalars`, so a fixture edit
// can't silently move the goalposts. `projectedUsage: null` = no growth ->
// mirror the assembled currentUsage (see PoolScenarioInputs's doc comment).
function poolCtx(
  controls: PoolRebalanceContext['controls'],
  currentUsage: UsageState,
  inp: PoolScenarioInputs,
  asOf: Date,
): PoolRebalanceContext {
  return {
    controls,
    currentUsage,
    projectedUsage: inp.projectedUsage ?? currentUsage,
    poolTotalCredits: inp.poolTotalCredits,
    poolConsumedCredits: inp.poolConsumedCredits,
    projectedPoolConsumedCredits: inp.projectedPoolConsumedCredits,
    projectedPoolConsumedP90Credits: inp.projectedPoolConsumedP90Credits,
    asOfDate: asOf,
    cycleEndDate: new Date(`${inp.cycleEndDate}T00:00:00.000Z`),
  };
}

/** Pin a scenario's fixture scalars to their ratified literals (drift guard). */
function expectPoolScalars(
  inp: PoolScenarioInputs,
  expected: { total: number; consumed: number; p50: number; p90: number; cycleEnd: string },
): void {
  expect(inp.poolTotalCredits).toBe(expected.total);
  expect(inp.poolConsumedCredits).toBe(expected.consumed);
  expect(inp.projectedPoolConsumedCredits).toBe(expected.p50);
  expect(inp.projectedPoolConsumedP90Credits).toBe(expected.p90);
  expect(inp.cycleEndDate).toBe(expected.cycleEnd);
}

// ---------------------------------------------------------------------------
// Metadata self-consistency: every summary's atRiskCount/triggerFired must be
// what the engine proves below (guards scenario-state.ts against drift).
// ---------------------------------------------------------------------------
describe('scenario metadata is engine-consistent', () => {
  it('carries the four demo states in selector order', () => {
    expect(SCENARIO_SUMMARIES.map((s) => s.id)).toEqual(['healthy', 'at-risk', 'surplus', 'metered']);
  });
});

// ===========================================================================
// HEALTHY -- the DEWR world, no auto-balance trigger fires (day 13/30).
// ===========================================================================
describe('HEALTHY scenario', () => {
  it('assembles the byte-identical DEWR rollup (81 seats, 189,800 not needed here) and does NOT fire', async () => {
    const { controls, currentUsage, asOf } = await assemble('healthy');
    expect(currentUsage.users.length).toBe(81);
    // No projected growth (projectedUsage: null -> mirror current). Scalars:
    // on-pace (annualised ~437,800 of 567,000 -> 77.2% util, underutilised)
    // but day 13/30 (16 days out) is OUTSIDE the 7-day near-cycle-end window.
    const inp = POOL_SCENARIO_INPUTS['healthy']!;
    expectPoolScalars(inp, { total: 567_000, consumed: 189_800, p50: 437_800, p90: 460_000, cycleEnd: '2026-06-30' });
    expect(inp.projectedUsage).toBeNull(); // no growth -- the promoted fixture's contract
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    expect(plan.trigger.fired).toBe(false);
    // near-cycle-end UNMET (16 days out); underutilised MET; at-risk MET (the
    // DEWR world's standing cap-bound Payments team + ext-dmorrow's $0-ULB
    // block) -- truthful chips, pinned in full by rebalance-context.test.ts.
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([false, true, true]);
    expect(plan.trigger.daysRemaining).toBe(16);
    expect(getActiveScenarioSummary().atRiskCount).toBe(0); // badge: trigger not fired
  });
});

// ===========================================================================
// AT-RISK -- pool trigger fires. 7 ULB grants (12,800 credits), 9 cap-relax.
// ===========================================================================
describe('AT-RISK scenario', () => {
  it('assembles the expected cohort usage', async () => {
    const { currentUsage } = await assemble('at-risk');
    const pool = (login: string) => currentUsage.users.find((u) => u.userLogin === login)!.poolCreditsUsed;
    expect(pool('karen-fox')).toBe(4_600); // blocked (== universal ULB)
    expect(pool('mia-larsson')).toBe(4_400); // approaching
    expect(pool('blake-ferris')).toBe(1_000); // held (non-at-risk)
    const payments = currentUsage.costCenters.find((c) => c.costCenterName === 'Payments Integrity Engineering')!;
    expect(payments.poolCreditsUsed).toBe(55_000); // cap-bound team, current draw at 55,000 of 56,000
  });

  it('fires the pool trigger with truthful chips', async () => {
    const { controls, currentUsage, asOf } = await assemble('at-risk');
    const inp = POOL_SCENARIO_INPUTS['at-risk']!;
    expectPoolScalars(inp, { total: 567_000, consumed: 511_150, p50: 520_000, p90: 545_000, cycleEnd: '2026-06-30' });
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([true, true, true]);
    expect(plan.trigger.daysRemaining).toBe(3);
    expect(plan.trigger.projectedUtilization).toBeCloseTo(0.917, 3);
    expect(plan.trigger.atRiskCount).toBe(17);
    expect(plan.trigger.blockedCount).toBe(4); // 3 Corporate-blocked + ext-dmorrow $0-ULB
    expect(getActiveScenarioSummary().atRiskCount).toBe(17);
  });

  it('allocates 7 funded ULB grants (12,800 credits) + 9 cap-relax rows; envelope 28,350/7,500/12,800/7,200', async () => {
    const { controls, currentUsage, asOf } = await assemble('at-risk');
    const inp = POOL_SCENARIO_INPUTS['at-risk']!;
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    const a = plan.allocation;
    expect(a.grants.length).toBe(7);
    expect(a.fundedCount).toBe(7);
    expect(a.totalGrantedCredits).toBe(12_800);
    expect(a.grants.every((g) => g.status === 'funded')).toBe(true);
    // envelope segments (reserve + held + grants + slack === remaining_pool 55,850)
    expect(a.envelope.segments).toEqual({ reserve: 28_350, held: 7_500, grants: 12_800, slack: 7_200 });
    expect(a.envelope.envelopeCredits).toBe(20_000);
    // cap-relax: 8 Payments members + the CC entity, each unlocking 61,000-56,000
    expect(a.capRelax.length).toBe(9);
    expect(a.capRelax.every((r) => r.costCenterName === 'Payments Integrity Engineering')).toBe(true);
    expect(a.capRelax.every((r) => r.unlockContributionCredits === 5_000)).toBe(true);
  });

  it('simulates 520,000 -> 532,800 (7 unblocked), verdict ok', async () => {
    const { controls, currentUsage, asOf } = await assemble('at-risk');
    const inp = POOL_SCENARIO_INPUTS['at-risk']!;
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    const s = plan.simulation;
    expect(s.beforeConsumedCredits).toBe(520_000);
    expect(s.afterConsumedCredits).toBe(532_800);
    expect(s.afterUtilization).toBeCloseTo(0.9397, 4);
    expect(s.usersUnblockedCount).toBe(7);
    expect(s.verdict).toBe('ok');
    const expTip = 1 - normalCdf((567_000 - 532_800) / ((545_000 - 520_000) / 1.2816));
    expect(s.tipProbability).toBeCloseTo(expTip, 6);
  });
});

// ===========================================================================
// SURPLUS -- drastic under-consumption WITH a tiny throttled cohort -> the pool
// trigger fires and funds all four in full, leaving enormous slack (the retune
// ratified 2026-07-08). 4 ULB grants (5,000 credits), 0 cap-relax.
// ===========================================================================
describe('SURPLUS scenario', () => {
  it('assembles the four-contractor cohort on a tight 500-credit individual ULB', async () => {
    const { currentUsage } = await assemble('surplus');
    const pool = (login: string) => currentUsage.users.find((u) => u.userLogin === login)!.poolCreditsUsed;
    expect(pool('ext-rknott')).toBe(500); // blocked (== 500 individual ULB)
    expect(pool('ext-tlau')).toBe(500); // blocked
    expect(pool('aria-fahey')).toBe(480); // approaching (96% of 500)
    expect(pool('seb-rowe')).toBe(480); // approaching
    expect(pool('rpatel2')).toBe(1_200); // light, non-at-risk (grown in projection -> held)
  });

  it('FIRES (4 at-risk) on near-cycle-end + underutilisation; forfeit ~96.5%', async () => {
    const { controls, currentUsage, asOf } = await assemble('surplus');
    const inp = POOL_SCENARIO_INPUTS['surplus']!;
    expectPoolScalars(inp, { total: 567_000, consumed: 16_000, p50: 20_000, p90: 30_000, cycleEnd: '2026-06-30' });
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([true, true, true]);
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.daysRemaining).toBe(3);
    expect(plan.trigger.atRiskCount).toBe(4);
    expect(plan.trigger.blockedCount).toBe(2); // ext-rknott + ext-tlau (used == 500 ULB)
    expect(plan.trigger.approachingCount).toBe(2); // aria-fahey + seb-rowe (96%)
    expect(plan.trigger.projectedUtilization).toBeCloseTo(0.0353, 4);
    expect(plan.trigger.projectedForfeitPct).toBeCloseTo(0.9647, 4);
    expect(getActiveScenarioSummary().atRiskCount).toBe(4);
  });

  it('allocates 4 funded ULB grants (5,000 credits) + 0 cap-relax; envelope 28,350/1,000/5,000/516,650', async () => {
    const { controls, currentUsage, asOf } = await assemble('surplus');
    const inp = POOL_SCENARIO_INPUTS['surplus']!;
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    const a = plan.allocation;
    expect(a.grants.length).toBe(4);
    expect(a.fundedCount).toBe(4);
    expect(a.totalGrantedCredits).toBe(5_000);
    expect(a.grants.every((g) => g.status === 'funded')).toBe(true);
    // Blocked-first, then login-asc within each tier (the engine's ranking).
    expect(a.grants.map((g) => g.userLogin)).toEqual(['ext-rknott', 'ext-tlau', 'aria-fahey', 'seb-rowe']);
    // Every grant raises an already-individual ULB (no shared scope to convert from).
    expect(a.grants.every((g) => g.convertsFrom === 'individual')).toBe(true);
    expect(a.grants.find((g) => g.userLogin === 'ext-rknott')!.grantCredits).toBe(1_500);
    expect(a.grants.find((g) => g.userLogin === 'aria-fahey')!.grantCredits).toBe(1_000);
    // Huge forfeit-bound envelope; a 5,000 sliver in a sea of 516,650 slack.
    expect(a.envelope.segments).toEqual({ reserve: 28_350, held: 1_000, grants: 5_000, slack: 516_650 });
    expect(a.envelope.envelopeCredits).toBe(521_650);
    expect(a.capRelax.length).toBe(0); // surplus world -- no cap-bound team
  });

  it('simulates 20,000 -> 25,000 (4 unblocked), tip 0.0%, verdict ok', async () => {
    const { controls, currentUsage, asOf } = await assemble('surplus');
    const inp = POOL_SCENARIO_INPUTS['surplus']!;
    const plan = runPoolRebalancer(poolCtx(controls, currentUsage, inp, asOf));
    const s = plan.simulation;
    expect(s.beforeConsumedCredits).toBe(20_000);
    expect(s.afterConsumedCredits).toBe(25_000);
    expect(s.beforeUtilization).toBeCloseTo(0.0353, 4);
    expect(s.afterUtilization).toBeCloseTo(0.0441, 4);
    expect(s.usersUnblockedCount).toBe(4);
    expect(s.verdict).toBe('ok');
    const expTip = 1 - normalCdf((567_000 - 25_000) / ((30_000 - 20_000) / 1.2816));
    expect(s.tipProbability).toBeCloseTo(expTip, 6);
    expect(s.tipProbability).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// METERED -- metered rebalancer fires. cc-budget raise + individual bump.
// ===========================================================================
describe('METERED scenario', () => {
  it('assembles the 100%-consumed pool (567,000), 480,000 enterprise metered + 24,500 Data & Evaluation metered', async () => {
    const { currentUsage } = await assemble('metered');
    // Pool 100% consumed: every CC sits at its cap, Σ == 567,000.
    expect(currentUsage.costCenters.reduce((s, cc) => s + cc.poolCreditsUsed, 0)).toBe(567_000);
    expect(currentUsage.enterprise.meteredCreditsUsed).toBe(480_000);
    const dataEval = currentUsage.costCenters.find((c) => c.costCenterName === 'Data & Evaluation Platform')!;
    expect(dataEval.meteredCreditsUsed).toBe(24_500);
    expect(dataEval.poolCreditsUsed).toBe(63_000); // == cap, exhausted
    const sam = currentUsage.users.find((u) => u.userLogin === 'sam-kelly')!;
    expect(sam.poolCreditsUsed).toBe(4_900);
    expect(sam.meteredCreditsUsed).toBe(500);
  });

  it('fires the metered trigger: 2 grants (5,000 cc-budget + 1,000 individual), $60 bill delta', async () => {
    const { controls, currentUsage } = await assemble('metered');
    const inp = METERED_SCENARIO_INPUTS['metered']!;
    const plan = evaluateMeteredRebalance({
      controls,
      currentUsage,
      projectedUsage: inp.projectedUsage,
      entities: inp.entities,
      meteredPhaseActive: inp.meteredPhaseActive,
      reserveCredits: inp.reserveCredits,
    });
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([true, true, true]);
    expect(plan.trigger.atRiskCount).toBe(2);
    expect(plan.fundedCount).toBe(2);
    // envelope: base 320,000 (800,000 - 480,000), reserve 0, held 0, allocatable 320,000, granted 6,000, slack 314,000
    expect(plan.envelope.baseRemainingCredits).toBe(320_000);
    expect(plan.envelope.heldCredits).toBe(0);
    expect(plan.envelope.grantedCredits).toBe(6_000);
    expect(plan.envelope.slackCredits).toBe(314_000);

    const dataEvalGrant = plan.grants.find((g) => g.lever.kind === 'cost_center_budget_raise')!;
    expect(dataEvalGrant.grantedDeltaCredits).toBe(5_000);
    expect(dataEvalGrant.billDeltaCredits).toBe(5_000);
    const samGrant = plan.grants.find((g) => g.lever.kind === 'individual_override')!;
    expect(samGrant.grantedDeltaCredits).toBe(1_000);
    expect(samGrant.billDeltaCredits).toBe(1_000);

    const sim = simulateMeteredGrants(
      { controls, currentUsage, projectedUsage: inp.projectedUsage, entities: inp.entities, meteredPhaseActive: inp.meteredPhaseActive, reserveCredits: inp.reserveCredits },
      grantSpecsFromPlan(plan),
    );
    expect(sim.unblockedCount).toBe(2);
    expect(sim.billDeltaCredits).toBe(6_000); // $60
    expect(sim.projectedTotalMeteredCredits).toBe(486_000); // 480,000 current + 6,000 enterprise-funded bill delta
    expect(sim.remainingEnterpriseHeadroomCredits).toBe(314_000); // 800,000 - 486,000
    expect(getActiveScenarioSummary().atRiskCount).toBe(2);
  });
});
