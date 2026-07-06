import { describe, expect, it } from 'vitest';
import type { BudgetControl, ControlState, IncludedCapControl } from './controls';
import type { CostCenterUsage, UsageState, UserUsage } from './simulate';
import {
  allocatePoolGrants,
  computeFundingEnvelope,
  evaluatePoolTrigger,
  normalCdf,
  resolvePoolBindings,
  runPoolRebalancer,
  simulatePoolRebalance,
  wholeDaysBetween,
  type PoolGrant,
  type PoolRebalanceContext,
} from './poolRebalancer';

// ===========================================================================
// Fixtures
// ===========================================================================

const ENTERPRISE = 'acme-enterprise';
const AS_OF = new Date('2026-07-26T00:00:00.000Z');
const CYCLE_END = new Date('2026-07-30T00:00:00.000Z'); // day 26 of 30 -> 4 days out

function budget(overrides: Partial<BudgetControl> = {}): BudgetControl {
  return {
    kind: 'budget',
    scope: 'universal',
    entityName: ENTERPRISE,
    amountCredits: 10_000,
    preventFurtherUsage: true,
    alerting: { willAlert: false, alertRecipients: [] },
    ...overrides,
  };
}

function includedCap(overrides: Partial<IncludedCapControl> = {}): IncludedCapControl {
  return {
    kind: 'included_cap',
    costCenterName: 'Platform',
    enabled: true,
    overflow: 'block',
    computedLimitCredits: 70_000,
    ...overrides,
  };
}

function user(userLogin: string, costCenterName: string | null, poolCreditsUsed: number, meteredCreditsUsed = 0): UserUsage {
  return { userLogin, costCenterName, poolCreditsUsed, meteredCreditsUsed };
}

function ccUsage(costCenterName: string, poolCreditsUsed: number, meteredCreditsUsed = 0): CostCenterUsage {
  return { costCenterName, poolCreditsUsed, meteredCreditsUsed };
}

function usageState(users: UserUsage[], costCenters: CostCenterUsage[] = []): UsageState {
  return { enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: 0 }, users, costCenters };
}

// ---------------------------------------------------------------------------
// The PRD §4.4.A concrete scenario, as a reusable builder.
//
// Pool P = 1,000,000 credits.
//   consumed 680,000 (68%)  -> remaining_pool 320,000
//   forecast P50 end-of-cycle 820,000 (82%)  -> 18% (180,000) forfeit slack
//   forecast P90 end-of-cycle 840,000        -> band sigma for tip risk
//   reserve 20,000 (2%)
// Controls: one universal ULB = 10,000 (governs the 17 at-risk users); two light
//   users L1/L2 on huge individual ULBs (200,000) so they never bind.
// At-risk cohort (all under the universal 10,000 ULB):
//   6 BLOCKED  (b1..b6): current pool 10,000 (== ULB, headroom 0) ; projected 20,000
//   11 AT >=95% (a01..a11): current pool 9,500 (95%)               ; projected 17,500
// Non-at-risk "held": L1/L2 current 30,000 -> projected 100,000 (50% of 200,000)
//   held = (100,000-30,000)*2 = 140,000  (their demonstrable draw to cycle end)
// Envelope = 320,000 - 20,000 - 140,000 = 160,000.
// Grant deltas (projectedDemand - currentLimit=10,000):
//   blocked   20,000-10,000 = 10,000  x6 = 60,000
//   at-risk   17,500-10,000 =  7,500  x11 = 82,500
//   Sigma = 142,500  <= envelope 160,000  -> ALL 17 funded, slack 17,500.
// Simulation: after = 820,000 + 142,500 = 962,500 = 96.25% ; tip < 3%.
// ---------------------------------------------------------------------------

const UNIVERSAL_ULB = 10_000;
const BLOCKED_LOGINS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
const APPROACHING_LOGINS = Array.from({ length: 11 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);

function scenarioControls(): ControlState[] {
  return [
    budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: UNIVERSAL_ULB }),
    budget({ scope: 'individual', entityName: 'L1', amountCredits: 200_000 }),
    budget({ scope: 'individual', entityName: 'L2', amountCredits: 200_000 }),
  ];
}

function scenarioCurrentUsage(): UsageState {
  return usageState([
    ...BLOCKED_LOGINS.map((l) => user(l, null, 10_000)),
    ...APPROACHING_LOGINS.map((l) => user(l, null, 9_500)),
    user('L1', null, 30_000),
    user('L2', null, 30_000),
  ]);
}

function scenarioProjectedUsage(): UsageState {
  return usageState([
    ...BLOCKED_LOGINS.map((l) => user(l, null, 20_000)),
    ...APPROACHING_LOGINS.map((l) => user(l, null, 17_500)),
    user('L1', null, 100_000),
    user('L2', null, 100_000),
  ]);
}

function scenarioContext(overrides: Partial<PoolRebalanceContext> = {}): PoolRebalanceContext {
  return {
    controls: scenarioControls(),
    currentUsage: scenarioCurrentUsage(),
    projectedUsage: scenarioProjectedUsage(),
    poolTotalCredits: 1_000_000,
    poolConsumedCredits: 680_000,
    projectedPoolConsumedCredits: 820_000,
    projectedPoolConsumedP90Credits: 840_000,
    asOfDate: AS_OF,
    cycleEndDate: CYCLE_END,
    params: { reserveCredits: 20_000 },
    ...overrides,
  };
}

// ===========================================================================
// Utility
// ===========================================================================

describe('wholeDaysBetween', () => {
  it('counts whole UTC days (day 26 of 30 -> 4 days remaining)', () => {
    expect(wholeDaysBetween(AS_OF, CYCLE_END)).toBe(4);
    expect(wholeDaysBetween(CYCLE_END, AS_OF)).toBe(-4);
    expect(wholeDaysBetween(AS_OF, AS_OF)).toBe(0);
  });
});

// ===========================================================================
// Task 6.2 -- trigger
// ===========================================================================

describe('evaluatePoolTrigger (Task 6.2, FR6)', () => {
  it('fires on the PRD day-26 scenario with truthful per-condition chips', () => {
    const t = evaluatePoolTrigger(scenarioContext());

    expect(t.fired).toBe(true);
    expect(t.daysRemaining).toBe(4);
    expect(t.projectedUtilization).toBeCloseTo(0.82, 10);
    expect(t.projectedForfeitPct).toBeCloseTo(0.18, 10);
    expect(t.atRiskCount).toBe(17);
    expect(t.blockedCount).toBe(6);
    expect(t.approachingCount).toBe(11);

    expect(t.conditions.map((c) => c.met)).toEqual([true, true, true]);
    expect(t.conditions[0]?.label).toBe('Near cycle end');
    expect(t.conditions[0]?.detail).toContain('4 day(s) remaining');
    expect(t.conditions[1]?.detail).toContain('82.0%'); // projected utilisation
    expect(t.conditions[1]?.detail).toContain('18.0%'); // forfeit
    expect(t.conditions[2]?.detail).toContain('17 at-risk (6 blocked, 11 approaching)');
  });

  it('does NOT fire on a healthy fixture, with each unmet chip explained truthfully', () => {
    // Healthy: near cycle end (met), but pool projected 98% used (little forfeit
    // -> underutilisation NOT met) and NO at-risk entities (not met).
    const healthy = scenarioContext({
      controls: [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 1_000_000 })],
      currentUsage: usageState([user('u1', null, 5_000), user('u2', null, 6_000)]),
      projectedUsage: usageState([user('u1', null, 8_000), user('u2', null, 9_000)]),
      projectedPoolConsumedCredits: 980_000, // 98%
      projectedPoolConsumedP90Credits: 990_000,
    });
    const t = evaluatePoolTrigger(healthy);

    expect(t.fired).toBe(false);
    expect(t.conditions[0]?.met).toBe(true); // still near cycle end
    expect(t.conditions[1]?.met).toBe(false); // 98% >= 95% threshold
    expect(t.conditions[1]?.detail).toContain('98.0%');
    expect(t.conditions[2]?.met).toBe(false); // 0 at-risk
    expect(t.atRiskCount).toBe(0);
    expect(t.conditions[2]?.detail).toContain('0 at-risk');
  });

  it('does not fire when the cycle end is outside the near-window', () => {
    const far = scenarioContext({ cycleEndDate: new Date('2026-08-20T00:00:00.000Z') }); // 25 days out
    const t = evaluatePoolTrigger(far);
    expect(t.daysRemaining).toBe(25);
    expect(t.conditions[0]?.met).toBe(false);
    expect(t.fired).toBe(false);
  });
});

// ===========================================================================
// Task 6.2 -- envelope
// ===========================================================================

describe('computeFundingEnvelope (Task 6.2, FR7)', () => {
  it('reproduces the PRD envelope: 320,000 - 20,000 reserve - 140,000 held = 160,000', () => {
    const ctx = scenarioContext();
    const env = computeFundingEnvelope(ctx, resolvePoolBindings(ctx));

    expect(env.remainingPoolCredits).toBe(320_000);
    expect(env.reserveCredits).toBe(20_000);
    expect(env.heldForNonAtRiskCredits).toBe(140_000);
    expect(env.envelopeCredits).toBe(160_000);
    // Before allocation the whole envelope is slack.
    expect(env.segments).toEqual({ reserve: 20_000, held: 140_000, grants: 0, slack: 160_000 });
  });

  it('derives reserve from reservePct when no absolute override is given (5% of pool)', () => {
    const ctx = scenarioContext({ params: {} }); // default reservePct 0.05
    const env = computeFundingEnvelope(ctx, resolvePoolBindings(ctx));
    expect(env.reserveCredits).toBe(50_000); // 0.05 * 1,000,000
    expect(env.envelopeCredits).toBe(320_000 - 50_000 - 140_000); // 130,000
  });

  it('segments always sum to remaining_pool (property, seeded variation)', () => {
    for (let s = 0; s < 60; s++) {
      const poolTotal = 200_000 + s * 13_000;
      const poolConsumed = Math.round(poolTotal * (0.3 + (s % 5) * 0.1));
      const grantsAllocated = s * 2_137;
      const ctx = scenarioContext({
        poolTotalCredits: poolTotal,
        poolConsumedCredits: poolConsumed,
        params: { reserveCredits: s * 900 },
      });
      const env = computeFundingEnvelope(ctx, resolvePoolBindings(ctx), grantsAllocated);
      const { reserve, held, grants, slack } = env.segments;
      expect(reserve + held + grants + slack).toBe(env.remainingPoolCredits);
      expect(env.remainingPoolCredits).toBe(poolTotal - poolConsumed);
    }
  });
});

// ===========================================================================
// Task 6.3 -- allocator
// ===========================================================================

describe('allocatePoolGrants (Task 6.3, FR8/FR9) -- PRD 17-user scenario', () => {
  it('funds all 17 at-risk users, blocked-first, from the 160,000 envelope', () => {
    const ctx = scenarioContext();
    const result = allocatePoolGrants(ctx);

    expect(result.grantCandidateCount).toBe(17);
    expect(result.fundedCount).toBe(17);
    expect(result.summaryLabel).toBe('17 of 17 funded');
    expect(result.capRelax).toEqual([]);

    // Ranking: the 6 blocked first (b1..b6), then the 11 approaching (a01..a11).
    expect(result.grants.slice(0, 6).map((g) => g.userLogin)).toEqual(BLOCKED_LOGINS);
    expect(result.grants.slice(6).map((g) => g.userLogin)).toEqual(APPROACHING_LOGINS);
    expect(result.grants.slice(0, 6).every((g) => g.blocked)).toBe(true);
    expect(result.grants.slice(6).every((g) => !g.blocked)).toBe(true);

    // A blocked grant: raise 10,000, converts from Universal, no CCULB (unassigned).
    const b1 = result.grants[0]!;
    expect(b1).toMatchObject({
      userLogin: 'b1',
      grantCredits: 10_000,
      fundedCredits: 10_000,
      currentLimitCredits: 10_000,
      newLimitCredits: 20_000,
      projectedDemandCredits: 20_000,
      status: 'funded',
      convertsFrom: 'universal',
      cculbLiftAlternative: null,
      throughputCredits: 10_000,
    });
    expect(b1.lever).toEqual({ kind: 'individual_override', userLogin: 'b1' });

    // An approaching grant: raise 7,500 (17,500 - 10,000).
    const a01 = result.grants[6]!;
    expect(a01).toMatchObject({ userLogin: 'a01', grantCredits: 7_500, fundedCredits: 7_500, status: 'funded' });

    // Totals: 6*10,000 + 11*7,500 = 142,500 <= 160,000.
    expect(result.totalGrantedCredits).toBe(142_500);
    expect(result.envelope.segments).toEqual({
      reserve: 20_000,
      held: 140_000,
      grants: 142_500,
      slack: 17_500,
    });

    // Safety: 142,500 <= remaining_pool 320,000 (+ 0 allowed metered).
    expect(result.safetyCeilingCredits).toBe(320_000);
    expect(result.safetyOk).toBe(true);
  });

  it('reports a partially-funded tail when the envelope exhausts mid-list', () => {
    // Shrink the envelope: reserve 260,000 -> envelope = 320,000-260,000-140,000
    // = -80,000 -> floored 0? Too blunt. Instead hold the envelope to exactly
    // 65,000 via a 115,000 reserve: 320,000-115,000-140,000 = 65,000.
    //   b1..b6 fund fully: 6*10,000 = 60,000 (remaining 5,000)
    //   a01 wants 7,500 -> only 5,000 left -> PARTIAL (5,000), remaining 0
    //   a02..a11 -> UNFUNDED (0)
    const ctx = scenarioContext({ params: { reserveCredits: 115_000 } });
    const result = allocatePoolGrants(ctx);

    expect(result.envelope.envelopeCredits).toBe(65_000);
    expect(result.fundedCount).toBe(6);
    expect(result.summaryLabel).toBe('6 of 17 funded');
    expect(result.totalGrantedCredits).toBe(65_000);

    const a01 = result.grants.find((g) => g.userLogin === 'a01')!;
    expect(a01).toMatchObject({ status: 'partial', fundedCredits: 5_000, grantCredits: 7_500, newLimitCredits: 15_000 });

    const a02 = result.grants.find((g) => g.userLogin === 'a02')!;
    expect(a02).toMatchObject({ status: 'unfunded', fundedCredits: 0, newLimitCredits: 10_000 });

    expect(result.grants.filter((g) => g.status === 'unfunded')).toHaveLength(10);
    expect(result.safetyOk).toBe(true); // 65,000 <= 320,000
  });

  it('routes a cap-bound team to the relax branch: options, no delta, unlock contribution', () => {
    // Platform: cap enabled/block, computed 70,000, CC pool draw 70,000 (at cap
    // -> headroom 0 -> blocked). One member has a roomy universal ULB (100,000),
    // so the cap binds (lowest headroom), NOT the ULB -> cap-bound, no grant.
    // Projected CC pool 90,000 -> unlock = max(0, 90,000 - 70,000) = 20,000.
    const controls: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 100_000 }),
      includedCap({ costCenterName: 'Platform', enabled: true, overflow: 'block', computedLimitCredits: 70_000 }),
    ];
    const ctx = scenarioContext({
      controls,
      currentUsage: usageState([user('p1', 'Platform', 5_000)], [ccUsage('Platform', 70_000)]),
      projectedUsage: usageState([user('p1', 'Platform', 6_000)], [ccUsage('Platform', 90_000)]),
    });
    const result = allocatePoolGrants(ctx);

    expect(result.grants).toEqual([]); // cap-bound is never grantable
    const platform = result.capRelax.find((r) => r.entity.kind === 'cost_center')!;
    expect(platform).toMatchObject({
      costCenterName: 'Platform',
      computedLimitCredits: 70_000,
      poolDrawCredits: 70_000,
      projectedDemandCredits: 90_000,
      unlockContributionCredits: 20_000,
    });
    expect(platform.options).toEqual(['disable_cap', 'overflow_to_metered', 'reattribute_licenses']);
    // Structural: no settable-amount field exists on the recommendation.
    expect('grantCredits' in platform).toBe(false);
    expect('delta' in platform).toBe(false);
  });

  it('grants an individual override converting from a CCULB, with the blunt CCULB lift as the alternative', () => {
    const controls: ControlState[] = [
      budget({ scope: 'multi_user_cost_center', entityName: 'Team', amountCredits: 10_000 }),
    ];
    const ctx = scenarioContext({
      controls,
      currentUsage: usageState([user('t1', 'Team', 9_500)]),
      projectedUsage: usageState([user('t1', 'Team', 15_000)]),
    });
    const result = allocatePoolGrants(ctx);

    expect(result.grants).toHaveLength(1);
    const g = result.grants[0]!;
    expect(g).toMatchObject({
      userLogin: 't1',
      grantCredits: 5_000, // 15,000 - 10,000
      convertsFrom: 'cost-center',
    });
    expect(g.lever).toEqual({ kind: 'individual_override', userLogin: 't1' });
    expect(g.cculbLiftAlternative).toEqual({ kind: 'cculb_lift', costCenterName: 'Team' });
  });

  it('Sigma raised ceilings never exceeds remaining_pool + allowed metered (safety property, seeded)', () => {
    for (let s = 0; s < 40; s++) {
      const k = 3 + (s % 8); // 3..10 at-risk users
      const ulb = 8_000;
      const poolTotal = 300_000 + s * 17_000;
      const poolConsumed = Math.round(poolTotal * 0.6);
      const allowedMetered = (s % 4) * 2_500;
      const currentUsers = Array.from({ length: k }, (_, i) => user(`u${i}`, null, ulb)); // all blocked
      const projectedUsers = Array.from({ length: k }, (_, i) =>
        user(`u${i}`, null, ulb + 1_000 * (1 + ((s + i) % 6))),
      );
      const ctx = scenarioContext({
        controls: [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: ulb })],
        currentUsage: usageState(currentUsers),
        projectedUsage: usageState(projectedUsers),
        poolTotalCredits: poolTotal,
        poolConsumedCredits: poolConsumed,
        params: { reserveCredits: s * 700, allowedMeteredCredits: allowedMetered },
      });
      const result = allocatePoolGrants(ctx);
      const remainingPool = poolTotal - poolConsumed;
      expect(result.totalGrantedCredits).toBeLessThanOrEqual(remainingPool + allowedMetered);
      expect(result.safetyCeilingCredits).toBe(remainingPool + allowedMetered);
      expect(result.safetyOk).toBe(true);
      // And never beyond the grantable envelope either.
      expect(result.totalGrantedCredits).toBeLessThanOrEqual(result.envelope.envelopeCredits);
    }
  });
});

// ===========================================================================
// Task 6.4 -- simulation
// ===========================================================================

describe('simulatePoolRebalance (Task 6.4, FR10) -- PRD scenario', () => {
  it('simulates to ~96% utilisation with <3% tip risk and an ok verdict', () => {
    const ctx = scenarioContext();
    const alloc = allocatePoolGrants(ctx);
    const sim = simulatePoolRebalance(alloc.grants, ctx, alloc.envelope);

    expect(sim.beforeConsumedCredits).toBe(820_000);
    expect(sim.beforeUtilization).toBeCloseTo(0.82, 10);
    // after = 820,000 + 142,500 = 962,500 = 96.25%.
    expect(sim.afterConsumedCredits).toBe(962_500);
    expect(sim.afterUtilization).toBeCloseTo(0.9625, 10);
    expect(sim.usersUnblockedCount).toBe(17);

    // sigma = (840,000-820,000)/1.2816 = 15,605.5 ; z = 37,500/sigma = 2.4030 ;
    // tip = 1 - Phi(2.4030) ~= 0.0081.
    expect(sim.tipProbability).toBeLessThan(0.03);
    expect(sim.tipProbability).toBeCloseTo(0.0081, 3);
    expect(sim.verdict).toBe('ok');
  });

  it('flips to over-allocated when Sigma grants exceed the envelope', () => {
    const ctx = scenarioContext();
    const alloc = allocatePoolGrants(ctx);
    // User edits one grant far past the envelope (200,000 > 160,000).
    const edited: PoolGrant[] = [{ ...alloc.grants[0]!, grantCredits: 200_000, fundedCredits: 200_000 }];
    const sim = simulatePoolRebalance(edited, ctx, alloc.envelope);
    expect(sim.totalGrantedCredits).toBe(200_000);
    expect(sim.verdict).toBe('over-allocated');
  });

  it('editing one grant changes outputs deterministically', () => {
    const ctx = scenarioContext();
    const alloc = allocatePoolGrants(ctx);
    const base = simulatePoolRebalance(alloc.grants, ctx, alloc.envelope);

    // Reduce b1's funded raise by 4,000 (10,000 -> 6,000; still within its demand
    // so applied draw drops by exactly 4,000, and it is no longer fully funded).
    const edited = alloc.grants.map((g) => (g.userLogin === 'b1' ? { ...g, fundedCredits: 6_000 } : g));
    const sim = simulatePoolRebalance(edited, ctx, alloc.envelope);

    expect(base.afterConsumedCredits - sim.afterConsumedCredits).toBe(4_000);
    expect(sim.afterConsumedCredits).toBe(958_500);
    expect(sim.usersUnblockedCount).toBe(16); // b1 now partially funded -> still blocked
    expect(sim.tipProbability).toBeLessThan(base.tipProbability); // lower draw -> lower tip risk
  });
});

describe('normalCdf', () => {
  it('matches standard-normal reference points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.2816)).toBeCloseTo(0.9, 4); // the P90 z-multiplier
    expect(normalCdf(-1.2816)).toBeCloseTo(0.1, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
  });
});

// ===========================================================================
// Orchestration
// ===========================================================================

describe('runPoolRebalancer (end-to-end dry run)', () => {
  it('ties trigger + allocation + simulation together on the PRD scenario', () => {
    const plan = runPoolRebalancer(scenarioContext());
    expect(plan.trigger.fired).toBe(true);
    expect(plan.allocation.summaryLabel).toBe('17 of 17 funded');
    expect(plan.simulation.afterConsumedCredits).toBe(962_500);
    expect(plan.simulation.verdict).toBe('ok');
    expect(plan.resolutions.filter((r) => r.entity.kind === 'user')).toHaveLength(19); // 17 at-risk + 2 light
  });
});
