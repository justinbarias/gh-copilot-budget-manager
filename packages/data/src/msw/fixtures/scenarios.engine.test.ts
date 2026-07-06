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
import { METERED_SCENARIO_INPUTS, POOL_SCENARIO_INPUTS } from './scenarios.js';
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

function poolCtx(
  controls: PoolRebalanceContext['controls'],
  currentUsage: UsageState,
  projectedUsage: UsageState,
  scalars: { total: number; consumed: number; p50: number; p90: number; cycleEnd: string },
  asOf: Date,
): PoolRebalanceContext {
  return {
    controls,
    currentUsage,
    projectedUsage,
    poolTotalCredits: scalars.total,
    poolConsumedCredits: scalars.consumed,
    projectedPoolConsumedCredits: scalars.p50,
    projectedPoolConsumedP90Credits: scalars.p90,
    asOfDate: asOf,
    cycleEndDate: new Date(`${scalars.cycleEnd}T00:00:00.000Z`),
  };
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
    // No projected growth -> effective basis == current. Scalars: on-pace
    // (annualised ~437,800 of 567,000 -> 77.2% util, underutilised) but day
    // 13/30 (16 days out) is OUTSIDE the 7-day near-cycle-end window.
    const plan = runPoolRebalancer(
      poolCtx(controls, currentUsage, currentUsage, { total: 567_000, consumed: 189_800, p50: 437_800, p90: 460_000, cycleEnd: '2026-06-30' }, asOf),
    );
    expect(plan.trigger.fired).toBe(false);
    expect(plan.trigger.conditions[0].met).toBe(false); // near-cycle-end: 16 days out
    expect(plan.trigger.conditions[1].met).toBe(true); // underutilised
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
    const plan = runPoolRebalancer(
      poolCtx(controls, currentUsage, inp.projectedUsage, { total: 567_000, consumed: 511_150, p50: 520_000, p90: 545_000, cycleEnd: '2026-06-30' }, asOf),
    );
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
    const plan = runPoolRebalancer(
      poolCtx(controls, currentUsage, inp.projectedUsage, { total: 567_000, consumed: 511_150, p50: 520_000, p90: 545_000, cycleEnd: '2026-06-30' }, asOf),
    );
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
    const plan = runPoolRebalancer(
      poolCtx(controls, currentUsage, inp.projectedUsage, { total: 567_000, consumed: 511_150, p50: 520_000, p90: 545_000, cycleEnd: '2026-06-30' }, asOf),
    );
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
// SURPLUS -- drastic under-consumption, NOBODY at risk -> trigger not fired.
// ===========================================================================
describe('SURPLUS scenario', () => {
  it('does NOT fire (0 at-risk) despite near-cycle-end + underutilisation; forfeit ~92.9%', async () => {
    const { controls, currentUsage, asOf } = await assemble('surplus');
    const inp = POOL_SCENARIO_INPUTS['surplus']!;
    const plan = runPoolRebalancer(
      poolCtx(controls, currentUsage, inp.projectedUsage, { total: 567_000, consumed: 14_000, p50: 40_000, p90: 60_000, cycleEnd: '2026-06-30' }, asOf),
    );
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([true, true, false]);
    expect(plan.trigger.fired).toBe(false);
    expect(plan.trigger.atRiskCount).toBe(0);
    expect(plan.trigger.projectedUtilization).toBeCloseTo(0.0705, 4);
    expect(plan.trigger.projectedForfeitPct).toBeCloseTo(0.9295, 4);
    expect(plan.allocation.grants.length).toBe(0);
    expect(getActiveScenarioSummary().atRiskCount).toBe(0);
  });
});

// ===========================================================================
// METERED -- metered rebalancer fires. cc-budget raise + individual bump.
// ===========================================================================
describe('METERED scenario', () => {
  it('assembles 300,000 enterprise metered + 24,500 Data & Evaluation metered', async () => {
    const { currentUsage } = await assemble('metered');
    expect(currentUsage.enterprise.meteredCreditsUsed).toBe(300_000);
    const dataEval = currentUsage.costCenters.find((c) => c.costCenterName === 'Data & Evaluation Platform')!;
    expect(dataEval.meteredCreditsUsed).toBe(24_500);
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
    // envelope: base 500,000, reserve 0, held 0, allocatable 500,000, granted 6,000, slack 494,000
    expect(plan.envelope.baseRemainingCredits).toBe(500_000);
    expect(plan.envelope.heldCredits).toBe(0);
    expect(plan.envelope.grantedCredits).toBe(6_000);
    expect(plan.envelope.slackCredits).toBe(494_000);

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
    expect(sim.projectedTotalMeteredCredits).toBe(306_000);
    expect(sim.remainingEnterpriseHeadroomCredits).toBe(494_000);
    expect(getActiveScenarioSummary().atRiskCount).toBe(2);
  });
});
