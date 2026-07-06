import { describe, expect, it } from 'vitest';
import {
  type BudgetControl,
  type CostCenterControl,
  type ControlState,
  type IncludedCapControl,
} from './controls';
import {
  AT_RISK_THRESHOLD_PCT,
  effectiveResolution,
  entityRefsFromUsage,
  resolveBindingConstraint,
  resolveBindingConstraints,
  type BindingConstraint,
  type BindingConstraintContext,
  type CapBound,
  type EntityRef,
} from './bindingConstraint';
import { type CostCenterUsage, type UsageState, type UserUsage } from './simulate';

const ENTERPRISE = 'acme-enterprise';

// --- factories (mirror simulate.test.ts conventions) -----------------------

function budget(overrides: Partial<BudgetControl> = {}): BudgetControl {
  return {
    kind: 'budget',
    scope: 'individual',
    entityName: 'user-01',
    amountCredits: 6000,
    preventFurtherUsage: true,
    alerting: { willAlert: false, alertRecipients: [] },
    ...overrides,
  };
}

function cap(overrides: Partial<IncludedCapControl> = {}): IncludedCapControl {
  return {
    kind: 'included_cap',
    costCenterName: 'Eng',
    enabled: true,
    overflow: 'block',
    computedLimitCredits: 70_000,
    ...overrides,
  };
}

function costCenter(overrides: Partial<CostCenterControl> = {}): CostCenterControl {
  return {
    kind: 'cost_center',
    name: 'Eng',
    dewrDivision: 'D',
    dewrBranch: 'B',
    dewrProject: 'P',
    excludedFromEnterpriseBudget: false,
    members: [],
    includedUsageCap: { enabled: true, overflow: 'block' },
    ...overrides,
  };
}

function user(overrides: Partial<UserUsage> = {}): UserUsage {
  return { userLogin: 'user-01', costCenterName: null, poolCreditsUsed: 0, meteredCreditsUsed: 0, ...overrides };
}

function ccUsage(overrides: Partial<CostCenterUsage> = {}): CostCenterUsage {
  return { costCenterName: 'Eng', poolCreditsUsed: 0, meteredCreditsUsed: 0, ...overrides };
}

function usageState(overrides: Partial<UsageState> = {}): UsageState {
  return {
    enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: 0 },
    users: [],
    costCenters: [],
    ...overrides,
  };
}

const userRef = (userLogin: string, costCenterName: string | null = null): EntityRef => ({ kind: 'user', userLogin, costCenterName });
const ccRef = (costCenterName: string): EntityRef => ({ kind: 'cost_center', costCenterName });

// Narrowing assertions that also satisfy TS control-flow.
function assertUlb(b: BindingConstraint | null): asserts b is Extract<BindingConstraint, { type: 'ulb-bound' }> {
  expect(b?.type).toBe('ulb-bound');
}
function assertCap(b: BindingConstraint | null): asserts b is CapBound {
  expect(b?.type).toBe('cap-bound');
}
function assertBudget(b: BindingConstraint | null): asserts b is Extract<BindingConstraint, { type: 'budget-bound' }> {
  expect(b?.type).toBe('budget-bound');
}

// ===========================================================================
// Scenario 1 -- individual-override winner (precedence, NOT min over ULBs)
// ===========================================================================
describe('scenario 1: individual override wins by precedence, not lowest ULB amount', () => {
  // ULBs: individual(user-01)=2,000, CCULB(Eng)=1,500, universal=3,000.
  // Precedence picks the INDIVIDUAL (2,000). The CCULB (1,500) has a SMALLER
  // amount/headroom but is NOT a candidate -- precedence collapses the three
  // ULB scopes to one BEFORE any headroom comparison. Used total = 1,000.
  // -> ulb-bound, limit 2,000 (proves precedence: min-over-ULBs would be 1,500),
  //    headroom 2,000-1,000 = 1,000, utilization 0.5 -> ok.
  it('binds to the individual override even though the CCULB has less remaining', () => {
    const controls: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-01', amountCredits: 2_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Eng', amountCredits: 1_500 }),
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 3_000 }),
    ];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({ users: [user({ userLogin: 'user-01', costCenterName: 'Eng', poolCreditsUsed: 1_000 })] }),
      phase: 'pool',
    };
    const { current } = resolveBindingConstraint(userRef('user-01', 'Eng'), ctx);
    assertUlb(current.binding);
    expect(current.binding.ulbScope).toBe('individual');
    expect(current.binding.limitCredits).toBe(2_000);
    expect(current.binding.remainingHeadroomCredits).toBe(1_000);
    expect(current.binding.grantLever).toEqual({ kind: 'individual_override', userLogin: 'user-01' });
    // Member of Eng -> a team-wide lift is available as the blunt alternative.
    expect(current.binding.cculbLiftAlternative).toEqual({ kind: 'cculb_lift', costCenterName: 'Eng' });
    expect(current.status.level).toBe('ok');
    expect(current.status.utilization).toBeCloseTo(0.5, 10);
  });
});

// ===========================================================================
// Scenario 2 -- CCULB-bound member (no individual override)
// ===========================================================================
describe('scenario 2: CCULB-bound member', () => {
  // No individual override for user-02. CCULB(Eng)=5,000 applies (precedence
  // over universal). Used = 4,900 -> headroom 100, utilization 0.98 -> at-risk.
  it('binds to the CCULB with hand-checked headroom and at-risk status', () => {
    const controls: ControlState[] = [
      budget({ scope: 'multi_user_cost_center', entityName: 'Eng', amountCredits: 5_000 }),
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 3_000 }),
    ];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({ users: [user({ userLogin: 'user-02', costCenterName: 'Eng', poolCreditsUsed: 4_900 })] }),
      phase: 'pool',
    };
    const { current } = resolveBindingConstraint(userRef('user-02', 'Eng'), ctx);
    assertUlb(current.binding);
    expect(current.binding.ulbScope).toBe('cost-center');
    expect(current.binding.limitCredits).toBe(5_000);
    expect(current.binding.remainingHeadroomCredits).toBe(100);
    expect(current.status.level).toBe('at-risk');
    expect(current.status.blocked).toBe(false);
    expect(current.status.utilization).toBeCloseTo(0.98, 10);
    // Default grant lever is still the surgical individual override; CCULB lift
    // is the team alternative.
    expect(current.binding.grantLever.kind).toBe('individual_override');
    expect(current.binding.cculbLiftAlternative).toEqual({ kind: 'cculb_lift', costCenterName: 'Eng' });
  });
});

// ===========================================================================
// Scenario 3 -- universal-bound user (no individual, no CCULB)
// ===========================================================================
describe('scenario 3: universal-bound user', () => {
  // Unassigned user (no cost center). Only universal=3,000 applies. Used=900 ->
  // headroom 2,100, utilization 0.3 -> ok. No CCULB lift alternative (no team).
  it('binds to the universal ULB with no CCULB alternative', () => {
    const controls: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 3_000 })];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({ users: [user({ userLogin: 'user-03', poolCreditsUsed: 900 })] }),
      phase: 'pool',
    };
    const { current } = resolveBindingConstraint(userRef('user-03', null), ctx);
    assertUlb(current.binding);
    expect(current.binding.ulbScope).toBe('universal');
    expect(current.binding.limitCredits).toBe(3_000);
    expect(current.binding.remainingHeadroomCredits).toBe(2_100);
    expect(current.binding.cculbLiftAlternative).toBeNull();
    expect(current.status.level).toBe('ok');
  });
});

// ===========================================================================
// Scenario 4 -- cap-bound team WITH pool slack (relax-only, NO delta)
// ===========================================================================
describe('scenario 4: cap-bound team classifies relax-only, never grantable', () => {
  // Cost-center entity "Eng", pool phase. Cap enabled, overflow 'block',
  // computed limit 70,000, CC pool draw 70,000 -> headroom 0 -> blocked. The
  // enterprise pool still has slack, but that is not a candidate for a cap-bound
  // CC (the cap is the CC's own ceiling).
  const controls: ControlState[] = [cap({ costCenterName: 'Eng', enabled: true, overflow: 'block', computedLimitCredits: 70_000 })];
  const ctx: BindingConstraintContext = {
    controls,
    currentUsage: usageState({ costCenters: [ccUsage({ costCenterName: 'Eng', poolCreditsUsed: 70_000 })] }),
    phase: 'pool',
  };

  it('classifies cap-bound with hand-checked headroom and relax options', () => {
    const { current } = resolveBindingConstraint(ccRef('Eng'), ctx);
    assertCap(current.binding);
    expect(current.binding.computedLimitCredits).toBe(70_000);
    expect(current.binding.poolDrawCredits).toBe(70_000);
    expect(current.binding.remainingHeadroomCredits).toBe(0);
    expect(current.binding.capOverflow).toBe('block');
    expect(current.binding.relaxOptions).toEqual(['disable_cap', 'overflow_to_metered', 'reattribute_licenses']);
    expect(current.status.level).toBe('blocked');
  });

  it('makes a grantable delta on a cap UNREPRESENTABLE (type-level proof)', () => {
    const { current } = resolveBindingConstraint(ccRef('Eng'), ctx);
    assertCap(current.binding);
    const capBinding = current.binding;
    // @ts-expect-error -- cap-bound carries NO grantable delta field.
    void capBinding.delta;
    // @ts-expect-error -- cap-bound carries NO grantable credits field.
    void capBinding.grantCredits;
    // @ts-expect-error -- cap-bound carries NO grant lever (that is ulb-bound's).
    void capBinding.grantLever;
    // Runtime shape assertions: only the relax surface exists.
    expect(Object.keys(capBinding).sort()).toEqual(
      ['capEnabled', 'capOverflow', 'computedLimitCredits', 'costCenterName', 'poolDrawCredits', 'relaxOptions', 'remainingHeadroomCredits', 'type'].sort(),
    );
  });

  it('drops overflow_to_metered from relax options when overflow is already metered', () => {
    const meteredCap: ControlState[] = [cap({ costCenterName: 'Eng', enabled: true, overflow: 'metered', computedLimitCredits: 70_000 })];
    const { current } = resolveBindingConstraint(ccRef('Eng'), { ...ctx, controls: meteredCap });
    assertCap(current.binding);
    expect(current.binding.relaxOptions).toEqual(['disable_cap', 'reattribute_licenses']);
  });
});

// ===========================================================================
// Scenario 5 -- metered-phase budget-bound user (spending limit binds below ULB)
// ===========================================================================
describe('scenario 5: metered-phase spending limit binds below the ULB', () => {
  // user-05 in "Platform", metered phase.
  //   individual ULB 100,000, user total used 59,000 -> ULB headroom 41,000.
  //   CC "Platform" budget 60,000, CC metered 58,800 -> CC-budget headroom 1,200.
  //   enterprise budget 800,000, enterprise metered 170,000 -> headroom 630,000.
  // Lowest across families = CC budget 1,200 (< ULB 41,000 < ent 630,000)
  // -> budget-bound, scope cost_center, headroom 1,200, utilization 0.98 at-risk.
  it('binds to the cost-center spending limit, not the ULB', () => {
    const controls: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-05', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000, preventFurtherUsage: true }),
      budget({ scope: 'enterprise', entityName: ENTERPRISE, amountCredits: 800_000, preventFurtherUsage: true }),
      costCenter({ name: 'Platform', excludedFromEnterpriseBudget: false }),
    ];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({
        enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: 170_000 },
        users: [user({ userLogin: 'user-05', costCenterName: 'Platform', poolCreditsUsed: 200, meteredCreditsUsed: 58_800 })],
        costCenters: [ccUsage({ costCenterName: 'Platform', meteredCreditsUsed: 58_800 })],
      }),
      phase: 'metered',
    };
    const { current } = resolveBindingConstraint(userRef('user-05', 'Platform'), ctx);
    assertBudget(current.binding);
    expect(current.binding.spendingLimitScope).toBe('cost_center');
    expect(current.binding.entityName).toBe('Platform');
    expect(current.binding.limitCredits).toBe(60_000);
    expect(current.binding.remainingHeadroomCredits).toBe(1_200);
    expect(current.binding.hardStop).toBe(true);
    expect(current.status.level).toBe('at-risk');
    expect(current.status.utilization).toBeCloseTo(0.98, 10);
  });
});

// ===========================================================================
// Scenario 6 -- excluded-CC funding source (PRD §4.4.B)
// ===========================================================================
describe('scenario 6: excluded cost center funds from its own budget, not enterprise', () => {
  // A/B on the SAME numbers, differing only by excludedFromEnterpriseBudget:
  //   enterprise budget 800,000, enterprise metered 799,500 -> ent headroom 500.
  //   CC budget 50,000, CC metered 49,000 -> CC-budget headroom 1,000.
  // Enterprise headroom (500) < CC headroom (1,000).
  //   NON-excluded member: enterprise is a candidate -> enterprise binds (500).
  //   EXCLUDED member: enterprise NOT a candidate -> CC budget binds (1,000).
  function build(excluded: boolean): BindingConstraintContext {
    const ccName = excluded ? 'Excluded' : 'Included';
    return {
      controls: [
        budget({ scope: 'cost_center', entityName: ccName, amountCredits: 50_000, preventFurtherUsage: true }),
        budget({ scope: 'enterprise', entityName: ENTERPRISE, amountCredits: 800_000, preventFurtherUsage: true }),
        budget({ scope: 'individual', entityName: 'user-06', amountCredits: 100_000 }),
        costCenter({ name: ccName, excludedFromEnterpriseBudget: excluded }),
      ],
      currentUsage: usageState({
        enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: 799_500 },
        users: [user({ userLogin: 'user-06', costCenterName: ccName, meteredCreditsUsed: 10_000 })],
        costCenters: [ccUsage({ costCenterName: ccName, meteredCreditsUsed: 49_000 })],
      }),
      phase: 'metered',
    };
  }

  it('non-excluded member binds to the enterprise limit (lower headroom)', () => {
    const { current } = resolveBindingConstraint(userRef('user-06', 'Included'), build(false));
    assertBudget(current.binding);
    expect(current.binding.spendingLimitScope).toBe('enterprise');
    expect(current.binding.remainingHeadroomCredits).toBe(500);
  });

  it('excluded member binds to its OWN cost-center budget, never enterprise', () => {
    const { current } = resolveBindingConstraint(userRef('user-06', 'Excluded'), build(true));
    assertBudget(current.binding);
    expect(current.binding.spendingLimitScope).toBe('cost_center');
    expect(current.binding.entityName).toBe('Excluded');
    expect(current.binding.remainingHeadroomCredits).toBe(1_000);
  });
});

// ===========================================================================
// Scenario 7 -- lowest-remaining-headroom-wins across families (both directions)
// ===========================================================================
describe('scenario 7: precedence for ULB applicability vs lowest-headroom across families', () => {
  // Direction A (precedence != min-over-ULBs): individual override 2,000 (used
  // 1,000 -> headroom 1,000) with a CCULB of 1,500 that WOULD have headroom 500
  // if it applied. Precedence picks the individual; the CCULB's lower headroom
  // is ignored because it is not a candidate. -> ulb-bound, limit 2,000.
  it('direction A: a lower-headroom CCULB does NOT bind when an individual override applies', () => {
    const controls: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-7a', amountCredits: 2_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Eng', amountCredits: 1_500 }),
    ];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({ users: [user({ userLogin: 'user-7a', costCenterName: 'Eng', poolCreditsUsed: 1_000 })] }),
      phase: 'pool',
    };
    const { current } = resolveBindingConstraint(userRef('user-7a', 'Eng'), ctx);
    assertUlb(current.binding);
    expect(current.binding.ulbScope).toBe('individual');
    expect(current.binding.limitCredits).toBe(2_000);
    expect(current.binding.remainingHeadroomCredits).toBe(1_000);
  });

  // Direction B (across families, lowest headroom wins): individual ULB 5,000
  // (used 4,200 -> headroom 800) vs the cost center's cap (computed 100,000, CC
  // pool draw 99,700 -> headroom 300). 300 < 800 -> CAP binds. Even though the
  // user has a ULB, the cap is the binding constraint: relax-only, NOT a grant.
  it('direction B: the cap binds below the ULB -> cap-bound (relax-only), not a ULB grant', () => {
    const controls: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-7b', amountCredits: 5_000 }),
      cap({ costCenterName: 'Cap', enabled: true, overflow: 'block', computedLimitCredits: 100_000 }),
    ];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({
        users: [user({ userLogin: 'user-7b', costCenterName: 'Cap', poolCreditsUsed: 4_200 })],
        costCenters: [ccUsage({ costCenterName: 'Cap', poolCreditsUsed: 99_700 })],
      }),
      phase: 'pool',
    };
    const { current } = resolveBindingConstraint(userRef('user-7b', 'Cap'), ctx);
    assertCap(current.binding);
    expect(current.binding.remainingHeadroomCredits).toBe(300);
    expect(current.status.level).toBe('at-risk'); // 99,700/100,000 = 0.997 >= 0.95
  });
});

// ===========================================================================
// Scenario 8 -- at-risk boundary tests + threshold override
// ===========================================================================
describe('scenario 8: at-risk boundaries and threshold override', () => {
  // Universal ULB 1,000, unassigned user; vary used.
  function statusAt(used: number, thresholdPct?: number) {
    const ctx: BindingConstraintContext = {
      controls: [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 1_000 })],
      currentUsage: usageState({ users: [user({ userLogin: 'u8', poolCreditsUsed: used })] }),
      phase: 'pool',
      ...(thresholdPct !== undefined ? { thresholdPct } : {}),
    };
    return resolveBindingConstraint(userRef('u8', null), ctx).current.status;
  }

  it('exactly at 95% -> at-risk (>= threshold), not blocked', () => {
    const s = statusAt(950);
    expect(s.level).toBe('at-risk');
    expect(s.blocked).toBe(false);
    expect(s.utilization).toBeCloseTo(0.95, 10);
  });

  it('just below 95% -> ok', () => {
    expect(statusAt(949).level).toBe('ok');
  });

  it('exactly at the limit (100%) -> blocked', () => {
    const s = statusAt(1_000);
    expect(s.level).toBe('blocked');
    expect(s.blocked).toBe(true);
    expect(s.atRisk).toBe(true);
  });

  it('over the limit -> blocked', () => {
    expect(statusAt(1_100).level).toBe('blocked');
  });

  it('threshold override is honored (0.90 flips 900 to at-risk; default keeps it ok)', () => {
    expect(statusAt(900).level).toBe('ok'); // 0.90 < default 0.95
    expect(statusAt(900, 0.9).level).toBe('at-risk');
    expect(statusAt(900).thresholdPct).toBe(AT_RISK_THRESHOLD_PCT);
    expect(statusAt(900, 0.9).thresholdPct).toBe(0.9);
  });

  it('$0 ULB is always blocked (CLAUDE.md §5)', () => {
    const ctx: BindingConstraintContext = {
      controls: [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 0 })],
      currentUsage: usageState({ users: [user({ userLogin: 'u8', poolCreditsUsed: 0 })] }),
      phase: 'pool',
    };
    expect(resolveBindingConstraint(userRef('u8', null), ctx).current.status.level).toBe('blocked');
  });
});

// ===========================================================================
// Scenario 9 -- projected-vs-current divergence
// ===========================================================================
describe('scenario 9: projected vs current determinations both correct', () => {
  // Universal ULB 1,000. Current used 800 (0.80 -> ok). Projected end-of-cycle
  // used 1,050 (1.05 -> blocked). Same ULB binds on both bases.
  it('current ok, projected blocked, same binding lever', () => {
    const controls: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 1_000 })];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({ users: [user({ userLogin: 'u9', poolCreditsUsed: 800 })] }),
      projectedUsage: usageState({ users: [user({ userLogin: 'u9', poolCreditsUsed: 1_050 })] }),
      phase: 'pool',
    };
    const res = resolveBindingConstraint(userRef('u9', null), ctx);
    expect(res.current.status.level).toBe('ok');
    expect(res.current.status.atRisk).toBe(false);
    expect(res.projected).not.toBeNull();
    expect(res.projected?.status.level).toBe('blocked');
    expect(res.projected?.status.atRisk).toBe(true);
    assertUlb(res.current.binding);
    assertUlb(res.projected?.binding ?? null);
    // effectiveResolution prefers the projected basis (the trigger basis).
    expect(effectiveResolution(res).status.level).toBe('blocked');
  });
});

// ===========================================================================
// Supporting behavior: unconstrained entity, batch, entity refs, no projection
// ===========================================================================
describe('supporting behavior', () => {
  it('unconstrained entity -> binding null, status ok, no projection', () => {
    const ctx: BindingConstraintContext = {
      controls: [],
      currentUsage: usageState({ users: [user({ userLogin: 'lonely', poolCreditsUsed: 999_999 })] }),
      phase: 'pool',
    };
    const res = resolveBindingConstraint(userRef('lonely', null), ctx);
    expect(res.current.binding).toBeNull();
    expect(res.current.status.level).toBe('ok');
    expect(res.projected).toBeNull();
  });

  it('projected null when no projectedUsage supplied', () => {
    const ctx: BindingConstraintContext = {
      controls: [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 1_000 })],
      currentUsage: usageState({ users: [user({ userLogin: 'u', poolCreditsUsed: 500 })] }),
      phase: 'pool',
    };
    expect(resolveBindingConstraint(userRef('u', null), ctx).projected).toBeNull();
  });

  it('metered phase: the included-usage cap no longer binds (team already tipped)', () => {
    // Pool-phase cap would bind at headroom 0, but in metered phase it is not a
    // candidate; only the (huge-headroom) ULB remains -> ulb-bound, ok.
    const controls: ControlState[] = [
      budget({ scope: 'individual', entityName: 'um', amountCredits: 100_000 }),
      cap({ costCenterName: 'Eng', enabled: true, computedLimitCredits: 70_000 }),
    ];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({
        users: [user({ userLogin: 'um', costCenterName: 'Eng', meteredCreditsUsed: 1_000 })],
        costCenters: [ccUsage({ costCenterName: 'Eng', poolCreditsUsed: 70_000 })],
      }),
      phase: 'metered',
    };
    const { current } = resolveBindingConstraint(userRef('um', 'Eng'), ctx);
    assertUlb(current.binding);
    expect(current.status.level).toBe('ok');
  });

  it('batch + entityRefsFromUsage resolves users and (opt-in) cost centers', () => {
    const controls: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 1_000 }),
      cap({ costCenterName: 'Eng', enabled: true, computedLimitCredits: 70_000 }),
    ];
    const usage = usageState({
      users: [user({ userLogin: 'a', poolCreditsUsed: 100 }), user({ userLogin: 'b', poolCreditsUsed: 100 })],
      costCenters: [ccUsage({ costCenterName: 'Eng', poolCreditsUsed: 10_000 })],
    });
    const ctx: BindingConstraintContext = { controls, currentUsage: usage, phase: 'pool' };

    const refsNoCc = entityRefsFromUsage(usage);
    expect(refsNoCc).toHaveLength(2);
    const refsWithCc = entityRefsFromUsage(usage, { includeCostCenters: true });
    expect(refsWithCc).toHaveLength(3);
    expect(refsWithCc.some((r) => r.kind === 'cost_center' && r.costCenterName === 'Eng')).toBe(true);

    const results = resolveBindingConstraints(refsWithCc, ctx);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.entity.kind).sort()).toEqual(['cost_center', 'user', 'user']);
  });

  it('partial projectedUsage overlays onto current (unlisted entities fall back)', () => {
    // Only user-x is projected; the CC aggregate falls back to current. Here the
    // ULB binds and only the user's projected total matters.
    const controls: ControlState[] = [budget({ scope: 'individual', entityName: 'x', amountCredits: 1_000 })];
    const ctx: BindingConstraintContext = {
      controls,
      currentUsage: usageState({ users: [user({ userLogin: 'x', poolCreditsUsed: 500 }), user({ userLogin: 'y', poolCreditsUsed: 0 })] }),
      // projectedUsage lists ONLY x; y falls back to current.
      projectedUsage: usageState({ users: [user({ userLogin: 'x', poolCreditsUsed: 990 })] }),
      phase: 'pool',
    };
    const res = resolveBindingConstraint(userRef('x', null), ctx);
    expect(res.current.status.utilization).toBeCloseTo(0.5, 10);
    expect(res.projected?.status.utilization).toBeCloseTo(0.99, 10);
    expect(res.projected?.status.level).toBe('at-risk');
  });
});
