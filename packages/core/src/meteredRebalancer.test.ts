import { describe, expect, it } from 'vitest';
import {
  type BudgetControl,
  type BudgetScope,
  type ControlState,
  type CostCenterControl,
} from './controls';
import { type CostCenterUsage, type UsageState, type UserUsage } from './simulate';
import { type EntityRef } from './bindingConstraint';
import {
  evaluateMeteredRebalance,
  grantSpecsFromPlan,
  simulateMeteredGrants,
  type MeteredGrant,
  type MeteredRebalanceInput,
} from './meteredRebalancer';

const ENTERPRISE = 'acme-enterprise';

// --- factories -------------------------------------------------------------

function budget(scope: BudgetScope, entityName: string, amountCredits: number, preventFurtherUsage = true): BudgetControl {
  return {
    kind: 'budget',
    scope,
    entityName,
    amountCredits,
    preventFurtherUsage,
    alerting: { willAlert: false, alertRecipients: [] },
  };
}

function costCenter(name: string, excludedFromEnterpriseBudget = false): CostCenterControl {
  return {
    kind: 'cost_center',
    name,
    dewrDivision: 'D',
    dewrBranch: 'B',
    dewrProject: 'P',
    excludedFromEnterpriseBudget,
    members: [],
    includedUsageCap: { enabled: false, overflow: 'metered' },
  };
}

function user(userLogin: string, costCenterName: string | null, poolCreditsUsed: number, meteredCreditsUsed: number): UserUsage {
  return { userLogin, costCenterName, poolCreditsUsed, meteredCreditsUsed };
}

function ccUsage(costCenterName: string, meteredCreditsUsed: number, poolCreditsUsed = 0): CostCenterUsage {
  return { costCenterName, poolCreditsUsed, meteredCreditsUsed };
}

function usageState(enterpriseMetered: number, users: UserUsage[], costCenters: CostCenterUsage[]): UsageState {
  return { enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: enterpriseMetered }, users, costCenters };
}

const userRef = (userLogin: string, costCenterName: string | null): EntityRef => ({ kind: 'user', userLogin, costCenterName });
const ccRef = (costCenterName: string): EntityRef => ({ kind: 'cost_center', costCenterName });

function grantByEntity(grants: readonly MeteredGrant[], key: string): MeteredGrant {
  const g = grants.find((x) => (x.entity.kind === 'user' ? x.entity.userLogin : x.entity.costCenterName) === key);
  if (!g) throw new Error(`no grant for ${key}`);
  return g;
}

// ===========================================================================
// PRD §4.4.B scenario -- the load-bearing reproduction.
//
// $-figures -> credits (x100):  enterprise budget $8,000 = 800_000; used $1,700
// = 170_000; remaining $6,300 = 630_000. Platform cc-budget $600 = 60_000; at
// 98% = 58_800 used, projected $850 = 85_000. 3 individual ULBs $200 = 20_000;
// each at 98% (15_000 pool + 4_600 metered = 19_600), projected total $250 =
// 25_000. Reserve $300 = 30_000. Non-at-risk Web cc: metered $400 -> $900
// (further $500 = 50_000 held). Enterprise projected metered kept at 400_000
// (large headroom) so nobody binds to the enterprise budget.
//
// HAND-COMPUTED expected:
//   base       = 800_000 - 170_000                 = 630_000  ($6,300)
//   held       = Web further = 90_000 - 40_000     =  50_000  ($500)
//   allocatable= 630_000 - 30_000(reserve) - 50_000= 550_000  ($5,500)
//   Platform grant = 85_000 - 60_000 = 25_000 ($250)  [cc-budget raise]
//   each user grant= 25_000 - 20_000 =  5_000 ($50)   [individual override]
//   granted    = 25_000 + 3*5_000                  =  40_000  ($400)
//   slack      = 630_000 - 30_000 - 50_000 - 40_000= 510_000  ($5,100)
//   bill delta = 40_000 ($400) (every grant fully consumed: P == limit+grant)
//   proj total metered = 170_000 + 50_000 + 40_000 = 260_000  ($2,600)
//   remaining ent headroom = 800_000 - 260_000     = 540_000  ($5,400)
// ===========================================================================

function prdScenario(): MeteredRebalanceInput {
  const controls: ControlState[] = [
    budget('enterprise', ENTERPRISE, 800_000),
    budget('cost_center', 'Platform', 60_000),
    budget('cost_center', 'Data', 500_000),
    budget('cost_center', 'Web', 200_000),
    budget('individual', 'u1', 20_000),
    budget('individual', 'u2', 20_000),
    budget('individual', 'u3', 20_000),
  ];
  const current = usageState(
    170_000,
    [user('u1', 'Data', 15_000, 4_600), user('u2', 'Data', 15_000, 4_600), user('u3', 'Data', 15_000, 4_600)],
    [ccUsage('Platform', 58_800), ccUsage('Data', 100_000), ccUsage('Web', 40_000)],
  );
  const projected = usageState(
    400_000,
    [user('u1', 'Data', 15_000, 10_000), user('u2', 'Data', 15_000, 10_000), user('u3', 'Data', 15_000, 10_000)],
    [ccUsage('Platform', 85_000), ccUsage('Data', 130_000), ccUsage('Web', 90_000)],
  );
  return {
    controls,
    currentUsage: current,
    projectedUsage: projected,
    entities: [ccRef('Platform'), ccRef('Web'), userRef('u1', 'Data'), userRef('u2', 'Data'), userRef('u3', 'Data')],
    meteredPhaseActive: true,
    reserveCredits: 30_000,
  };
}

describe('PRD §4.4.B metered scenario', () => {
  const plan = evaluateMeteredRebalance(prdScenario());

  it('fires the trigger with truthful chips', () => {
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([true, true, true]);
    expect(plan.trigger.atRiskCount).toBe(4);
  });

  it('sizes the funding envelope exactly ($6,300 base, $500 held, $5,500 allocatable)', () => {
    expect(plan.envelope.baseRemainingCredits).toBe(630_000);
    expect(plan.envelope.reserveCredits).toBe(30_000);
    expect(plan.envelope.heldCredits).toBe(50_000);
    expect(plan.envelope.allocatableCredits).toBe(550_000);
    expect(plan.envelope.grantedCredits).toBe(40_000);
    expect(plan.envelope.slackCredits).toBe(510_000);
    // USD view
    expect(plan.envelope.baseRemainingUsd).toBe(6_300);
    expect(plan.envelope.allocatableUsd).toBe(5_500);
    // segment invariant
    expect(
      plan.envelope.reserveCredits + plan.envelope.heldCredits + plan.envelope.grantedCredits + plan.envelope.slackCredits,
    ).toBe(plan.envelope.baseRemainingCredits);
  });

  it('proposes the +$250 Platform CC-budget grant + three $50 individual-ULB bumps, each on its actual binding', () => {
    expect(plan.grants).toHaveLength(4);
    expect(plan.fundedCount).toBe(4);
    expect(plan.flaggedEnterpriseRaises).toHaveLength(0);

    // ranking: Platform (util 1.417) first, then u1,u2,u3 (util 1.25) by name
    expect(plan.grants.map((g) => (g.entity.kind === 'user' ? g.entity.userLogin : g.entity.costCenterName))).toEqual([
      'Platform',
      'u1',
      'u2',
      'u3',
    ]);

    const platform = grantByEntity(plan.grants, 'Platform');
    expect(platform.binding.type).toBe('budget-bound');
    expect(platform.lever).toEqual({ kind: 'cost_center_budget_raise', costCenterName: 'Platform' });
    expect(platform.neededDeltaCredits).toBe(25_000);
    expect(platform.grantedDeltaCredits).toBe(25_000);
    expect(platform.grantedDeltaUsd).toBe(250);
    expect(platform.fundingSource).toBe('enterprise_envelope');
    expect(platform.billDeltaCredits).toBe(25_000);

    for (const login of ['u1', 'u2', 'u3']) {
      const g = grantByEntity(plan.grants, login);
      expect(g.binding.type).toBe('ulb-bound');
      expect(g.lever).toEqual({ kind: 'individual_override', userLogin: login });
      expect(g.neededDeltaCredits).toBe(5_000);
      expect(g.grantedDeltaCredits).toBe(5_000);
      expect(g.grantedDeltaUsd).toBe(50);
      expect(g.billDeltaCredits).toBe(5_000);
    }
  });

  it('simulates the bill delta = $400 with consistent enterprise headroom (FR14)', () => {
    const sim = simulateMeteredGrants(prdScenario(), grantSpecsFromPlan(plan));
    expect(sim.unblockedCount).toBe(4);
    expect(sim.billDeltaCredits).toBe(40_000);
    expect(sim.billDeltaUsd).toBe(400);
    expect(sim.projectedTotalMeteredCredits).toBe(260_000);
    expect(sim.projectedTotalMeteredUsd).toBe(2_600);
    expect(sim.remainingEnterpriseHeadroomCredits).toBe(540_000);
    expect(sim.remainingEnterpriseHeadroomUsd).toBe(5_400);
    // headroom consistent with the envelope: reserve + slack == headroom (grants fully consumed)
    expect(plan.envelope.reserveCredits + plan.envelope.slackCredits).toBe(sim.remainingEnterpriseHeadroomCredits);
  });
});

// ===========================================================================
// FR14 -- edited grant set: bill delta only bills to the extent consumed.
// ===========================================================================
describe('FR14 edited-grant recomputation is deterministic', () => {
  const input = prdScenario();
  const plan = evaluateMeteredRebalance(input);

  it('over-granting a user beyond projected demand does NOT inflate the bill delta', () => {
    // Bump u1 from 5_000 to 8_000. Projected total demand is still 25_000, ULB
    // limit 20_000 -> consumption unlocked = min(25_000, 28_000) - 20_000 =
    // 5_000, unchanged. Total bill delta stays 40_000 ($400).
    const specs = grantSpecsFromPlan(plan).map((s) =>
      s.entity.kind === 'user' && s.entity.userLogin === 'u1' ? { ...s, grantedDeltaCredits: 8_000 } : s,
    );
    const sim = simulateMeteredGrants(input, specs);
    expect(sim.billDeltaCredits).toBe(40_000);
    expect(sim.unblockedCount).toBe(4);
  });

  it('under-granting a user leaves them blocked and lowers the bill delta exactly', () => {
    // Reduce u1 to 2_000 -> new limit 22_000 < demand 25_000 -> still blocked;
    // consumption unlocked = 22_000 - 20_000 = 2_000. Total = 25_000 (Platform)
    // + 2_000 (u1) + 5_000 (u2) + 5_000 (u3) = 37_000 ($370). Unblocked = 3.
    const specs = grantSpecsFromPlan(plan).map((s) =>
      s.entity.kind === 'user' && s.entity.userLogin === 'u1' ? { ...s, grantedDeltaCredits: 2_000 } : s,
    );
    const sim = simulateMeteredGrants(input, specs);
    expect(sim.billDeltaCredits).toBe(37_000);
    expect(sim.unblockedCount).toBe(3);
  });

  it('hand-priced credits->dollars: 25_000 credits granted == $250', () => {
    const platform = grantByEntity(plan.grants, 'Platform');
    expect(platform.grantedDeltaCredits).toBe(25_000);
    expect(platform.grantedDeltaUsd).toBe(250);
  });
});

// ===========================================================================
// No-trigger cases -- each with a truthful chip explanation.
// ===========================================================================
describe('no-trigger cases', () => {
  it('metered phase NOT active -> chip[0] false, trigger not fired', () => {
    const input = { ...prdScenario(), meteredPhaseActive: false };
    const plan = evaluateMeteredRebalance(input);
    expect(plan.trigger.fired).toBe(false);
    expect(plan.trigger.conditions[0]?.met).toBe(false);
    expect(plan.trigger.conditions[0]?.label).toBe('Metered phase active');
  });

  it('no at-risk entity -> chip[1] false, atRiskCount 0', () => {
    // Same controls, but projected usage stays well under every cap.
    const input = prdScenario();
    const healthy: MeteredRebalanceInput = {
      ...input,
      projectedUsage: usageState(
        200_000,
        [user('u1', 'Data', 5_000, 1_000), user('u2', 'Data', 5_000, 1_000), user('u3', 'Data', 5_000, 1_000)],
        [ccUsage('Platform', 20_000), ccUsage('Data', 60_000), ccUsage('Web', 60_000)],
      ),
    };
    const plan = evaluateMeteredRebalance(healthy);
    expect(plan.trigger.fired).toBe(false);
    expect(plan.trigger.conditions[1]?.met).toBe(false);
    expect(plan.trigger.atRiskCount).toBe(0);
    expect(plan.grants).toHaveLength(0);
  });

  it('at-risk but ZERO higher-scope headroom -> chip[2] false', () => {
    // Enterprise budget fully consumed (remaining 0); Platform still binds to
    // its own cc-budget (headroom -25_000 < enterprise 0), so it is at-risk.
    const controls: ControlState[] = [budget('enterprise', ENTERPRISE, 800_000), budget('cost_center', 'Platform', 60_000)];
    const input: MeteredRebalanceInput = {
      controls,
      currentUsage: usageState(800_000, [], [ccUsage('Platform', 58_800)]),
      projectedUsage: usageState(800_000, [], [ccUsage('Platform', 85_000)]),
      entities: [ccRef('Platform')],
      meteredPhaseActive: true,
    };
    const plan = evaluateMeteredRebalance(input);
    expect(plan.trigger.conditions[1]?.met).toBe(true); // Platform is at-risk
    expect(plan.trigger.conditions[2]?.met).toBe(false); // no enterprise headroom
    expect(plan.trigger.fired).toBe(false);
    expect(plan.envelope.baseRemainingCredits).toBe(0);
    expect(plan.envelope.allocatableCredits).toBe(0);
    // envelope empty -> Platform grant is unfunded
    expect(plan.grants[0]?.grantedDeltaCredits).toBe(0);
    expect(plan.grants[0]?.fullyFunded).toBe(false);
  });
});

// ===========================================================================
// Excluded-CC A/B: an excluded CC self-funds; its non-excluded twin draws the
// enterprise envelope. Identical numbers, only the exclude flag differs.
// ===========================================================================
describe('excluded cost center funds from its own budget, not the enterprise envelope', () => {
  function abInput(costCenterName: string, excluded: boolean): MeteredRebalanceInput {
    return {
      controls: [
        budget('enterprise', ENTERPRISE, 800_000),
        budget('cost_center', costCenterName, 60_000),
        costCenter(costCenterName, excluded),
      ],
      currentUsage: usageState(170_000, [], [ccUsage(costCenterName, 58_800)]),
      projectedUsage: usageState(400_000, [], [ccUsage(costCenterName, 85_000)]),
      entities: [ccRef(costCenterName)],
      meteredPhaseActive: true,
    };
  }

  it('non-excluded twin draws 25_000 from the enterprise envelope', () => {
    const plan = evaluateMeteredRebalance(abInput('Ops', false));
    const g = grantByEntity(plan.grants, 'Ops');
    expect(g.grantedDeltaCredits).toBe(25_000);
    expect(g.fundingSource).toBe('enterprise_envelope');
    expect(plan.envelope.grantedCredits).toBe(25_000); // charged to the envelope
    expect(plan.envelope.slackCredits).toBe(630_000 - 25_000); // base - granted (reserve/held 0)
  });

  it('excluded twin self-funds the SAME 25_000 without touching the envelope', () => {
    const plan = evaluateMeteredRebalance(abInput('Sec', true));
    const g = grantByEntity(plan.grants, 'Sec');
    expect(g.grantedDeltaCredits).toBe(25_000); // same grant amount
    expect(g.fundingSource).toBe('own_budget');
    expect(plan.envelope.grantedCredits).toBe(0); // envelope untouched
    expect(plan.envelope.slackCredits).toBe(630_000); // full base remains as slack
  });

  it('own-funded bill delta is tracked separately from enterprise headroom', () => {
    const input = abInput('Sec', true);
    const plan = evaluateMeteredRebalance(input);
    const sim = simulateMeteredGrants(input, grantSpecsFromPlan(plan));
    expect(sim.billDeltaOwnFundedCredits).toBe(25_000);
    expect(sim.billDeltaEnterpriseCredits).toBe(0);
    // enterprise headroom unaffected by the self-funded grant: base - held(0) - 0
    expect(sim.remainingEnterpriseHeadroomCredits).toBe(800_000 - 170_000);
  });
});

// ===========================================================================
// Enterprise-budget-itself binding -> flagged recommendation, never allocated.
// ===========================================================================
describe('enterprise-bound entity is flagged, not granted', () => {
  const input: MeteredRebalanceInput = {
    controls: [budget('enterprise', ENTERPRISE, 800_000), budget('cost_center', 'Legacy', 500_000)],
    // enterprise nearly exhausted; Legacy's cc-budget has ample headroom, so
    // the enterprise budget (headroom -2_000) is Legacy's binding constraint.
    currentUsage: usageState(795_000, [], [ccUsage('Legacy', 100_000)]),
    projectedUsage: usageState(802_000, [], [ccUsage('Legacy', 120_000)]),
    entities: [ccRef('Legacy')],
    meteredPhaseActive: true,
  };
  const plan = evaluateMeteredRebalance(input);

  it('emits a flagged enterprise raise and NO grant', () => {
    expect(plan.grants).toHaveLength(0);
    expect(plan.flaggedEnterpriseRaises).toHaveLength(1);
    const f = plan.flaggedEnterpriseRaises[0];
    expect(f?.binding.type).toBe('budget-bound');
    expect(f?.binding.spendingLimitScope).toBe('enterprise');
    expect(f?.neededDeltaCredits).toBe(2_000); // 802_000 - 800_000
    expect(f?.reason).toContain('policy');
  });

  it('never allocates the envelope for the flagged entity (segment invariant holds)', () => {
    expect(plan.envelope.grantedCredits).toBe(0);
    const e = plan.envelope;
    expect(e.reserveCredits + e.heldCredits + e.grantedCredits + e.slackCredits).toBe(e.baseRemainingCredits);
  });
});

// ===========================================================================
// Alert-only (hardStop=false) budget: NOT at-risk of blocking -> no grant.
// ===========================================================================
describe('alert-only spending-limit ruling', () => {
  function twin(costCenterName: string, preventFurtherUsage: boolean): MeteredRebalanceInput {
    return {
      controls: [budget('enterprise', ENTERPRISE, 800_000), budget('cost_center', costCenterName, 60_000, preventFurtherUsage)],
      currentUsage: usageState(170_000, [], [ccUsage(costCenterName, 58_800)]),
      projectedUsage: usageState(400_000, [], [ccUsage(costCenterName, 85_000)]),
      entities: [ccRef(costCenterName)],
      meteredPhaseActive: true,
    };
  }

  it('a HARD-STOP budget at 98% is at-risk and granted', () => {
    const plan = evaluateMeteredRebalance(twin('HardCap', true));
    expect(plan.atRiskConsidered).toBe(1);
    expect(plan.grants).toHaveLength(1);
    expect(plan.grants[0]?.grantedDeltaCredits).toBe(25_000);
  });

  it('an ALERT-ONLY budget at 98% is NOT at-risk (it never blocks) -> no grant; its draw is HELD', () => {
    const plan = evaluateMeteredRebalance(twin('AlertOnly', false));
    expect(plan.atRiskConsidered).toBe(0);
    expect(plan.grants).toHaveLength(0);
    expect(plan.trigger.conditions[1]?.met).toBe(false);
    expect(plan.trigger.fired).toBe(false);
    // its projected further draw (85_000 - 58_800 = 26_200) is protected as held
    expect(plan.envelope.heldCredits).toBe(26_200);
  });
});

// ===========================================================================
// Envelope segment invariant -- property-style over seeded deterministic runs.
// ===========================================================================
describe('envelope segment invariant holds across seeded variations', () => {
  // No Math.random: a fixed matrix of (reserve, platformProjected, webProjected).
  const seeds = [
    { reserve: 0, platform: 85_000, web: 90_000 },
    { reserve: 30_000, platform: 70_000, web: 200_000 },
    { reserve: 100_000, platform: 120_000, web: 45_000 },
    { reserve: 600_000, platform: 61_000, web: 41_000 },
    { reserve: 640_000, platform: 90_000, web: 90_000 }, // over-reserved: slack < 0
    { reserve: 30_000, platform: 55_000, web: 90_000 }, // Platform under cap -> not at-risk
  ];

  for (const [i, seed] of seeds.entries()) {
    it(`seed #${i} (reserve ${seed.reserve})`, () => {
      const input: MeteredRebalanceInput = {
        controls: [budget('enterprise', ENTERPRISE, 800_000), budget('cost_center', 'Platform', 60_000), budget('cost_center', 'Web', 200_000)],
        currentUsage: usageState(170_000, [], [ccUsage('Platform', 58_800), ccUsage('Web', 40_000)]),
        projectedUsage: usageState(400_000, [], [ccUsage('Platform', seed.platform), ccUsage('Web', seed.web)]),
        entities: [ccRef('Platform'), ccRef('Web')],
        meteredPhaseActive: true,
        reserveCredits: seed.reserve,
      };
      const e = evaluateMeteredRebalance(input).envelope;
      // segment invariant, unconditional
      expect(e.reserveCredits + e.heldCredits + e.grantedCredits + e.slackCredits).toBe(e.baseRemainingCredits);
      // allocatable is clamped >= 0 and grants never exceed it
      expect(e.allocatableCredits).toBeGreaterThanOrEqual(0);
      expect(e.grantedCredits).toBeLessThanOrEqual(e.allocatableCredits);
      // no NaN leaks
      for (const v of Object.values(e)) expect(Number.isNaN(v)).toBe(false);
    });
  }
});

// ===========================================================================
// Grants never exceed each entity's needed delta (greedy correctness).
// ===========================================================================
describe('grant correctness', () => {
  it('grantedDelta <= neededDelta for every grant, and fullyFunded reflects it', () => {
    const plan = evaluateMeteredRebalance(prdScenario());
    for (const g of plan.grants) {
      expect(g.grantedDeltaCredits).toBeLessThanOrEqual(g.neededDeltaCredits);
      expect(g.fullyFunded).toBe(g.grantedDeltaCredits >= g.neededDeltaCredits);
    }
  });

  it('a tight envelope partially funds the tail and reports "N of M funded"', () => {
    // Envelope allocatable = base - reserve = 630_000 - 610_000 = 20_000 (held 0).
    // Platform needs 25_000 -> funded 20_000 (partial), fullyFunded false.
    const input: MeteredRebalanceInput = {
      controls: [budget('enterprise', ENTERPRISE, 800_000), budget('cost_center', 'Platform', 60_000)],
      currentUsage: usageState(170_000, [], [ccUsage('Platform', 58_800)]),
      projectedUsage: usageState(400_000, [], [ccUsage('Platform', 85_000)]),
      entities: [ccRef('Platform')],
      meteredPhaseActive: true,
      reserveCredits: 610_000,
    };
    const plan = evaluateMeteredRebalance(input);
    expect(plan.envelope.allocatableCredits).toBe(20_000);
    expect(plan.grants[0]?.grantedDeltaCredits).toBe(20_000);
    expect(plan.grants[0]?.fullyFunded).toBe(false);
    expect(plan.fundedCount).toBe(0);
    expect(plan.atRiskConsidered).toBe(1);
  });
});
