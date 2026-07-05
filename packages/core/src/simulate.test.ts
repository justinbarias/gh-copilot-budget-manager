import { describe, expect, it } from 'vitest';
import { diffControls, type BudgetControl, type ControlState, type IncludedCapControl } from './controls';
import { simulatePlan, type CostCenterUsage, type SimulationForecastInput, type UsageState, type UserUsage } from './simulate';

const AS_OF_DATE = new Date('2026-06-14T00:00:00.000Z');
const ENTERPRISE = 'acme-enterprise';

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
    costCenterName: 'Platform',
    enabled: true,
    overflow: 'block',
    computedLimitCredits: 70_000,
    ...overrides,
  };
}

function user(overrides: Partial<UserUsage> = {}): UserUsage {
  return { userLogin: 'user-01', costCenterName: null, poolCreditsUsed: 0, meteredCreditsUsed: 0, ...overrides };
}

function costCenterUsage(overrides: Partial<CostCenterUsage> = {}): CostCenterUsage {
  return { costCenterName: 'Platform', poolCreditsUsed: 0, meteredCreditsUsed: 0, ...overrides };
}

function usageState(overrides: Partial<UsageState> = {}): UsageState {
  return {
    enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: 0 },
    users: [],
    costCenters: [],
    ...overrides,
  };
}

describe('simulatePlan -- user bound by their cost center cap, not their own ULB', () => {
  // Hand-computed table:
  //   user-26: universal ULB 100,000 credits, own usage 3,000 -> ULB headroom 97,000 (never binds)
  //   CC "Marketing": computed cap 70,000, CC pool draw 70,000 -> cap headroom 0
  //   live:    cap.enabled=false -> cap doesn't apply -> blockedBefore=false
  //   desired: cap.enabled=true, overflow='block' -> cap applies, headroom<=0 -> blockedAfter=true
  // Expect: newlyBlocked=['user-26'], bound by 'included_cap', not 'ulb'.
  it('blocks user-26 via the cost-center cap once enabled, even though their ULB has huge headroom', () => {
    const marketingCap = cap({ costCenterName: 'Marketing', enabled: false, overflow: 'block', computedLimitCredits: 70_000 });
    const live: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 100_000 }), marketingCap];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 100_000 }),
      { ...marketingCap, enabled: true },
    ];
    const plan = diffControls(live, desired);

    const usage = usageState({
      users: [user({ userLogin: 'user-26', costCenterName: 'Marketing', poolCreditsUsed: 3_000 })],
      costCenters: [costCenterUsage({ costCenterName: 'Marketing', poolCreditsUsed: 70_000 })],
    });

    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyBlockedUserLogins).toEqual(['user-26']);
    expect(result.newlyUnblockedUserLogins).toEqual([]);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-26', blockedBefore: false, blockedAfter: true, bindingConstraintAfter: 'included_cap' },
    ]);
  });

  it('does NOT block a cap-bound team when overflow is "metered" (re-routes, does not stop usage)', () => {
    // Mirrors the capBound fixture convention: CC pool draw (70,500) exceeds
    // the computed limit (70,000), overflow='metered' -> members are
    // "cap-bound" but not blocked; their generous ULB doesn't matter either.
    const live: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-27', amountCredits: 6_000 }),
      cap({ costCenterName: 'Marketing', enabled: true, overflow: 'metered', computedLimitCredits: 70_000 }),
    ];
    const plan = diffControls(live, live); // no-op plan -- this is a steady-state check, not a transition
    const usage = usageState({
      users: [user({ userLogin: 'user-27', costCenterName: 'Marketing', poolCreditsUsed: 400 })],
      costCenters: [costCenterUsage({ costCenterName: 'Marketing', poolCreditsUsed: 70_500 })],
    });

    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-27', blockedBefore: false, blockedAfter: false, bindingConstraintAfter: null },
    ]);
  });
});

describe('simulatePlan -- $0 universal ULB blocks everyone whose most-specific ULB IS universal, but shields overrides', () => {
  // Hand-computed table (plan: universal ULB 4,000 -> 0):
  //   user-A: no CC, no individual override -> effective ULB = universal.
  //           usage 500 -> before headroom 3,500 (ok) / after headroom -500 (blocked). NEWLY BLOCKED.
  //   user-B: individual override 6,000 (untouched by the plan) -> effective ULB = individual, always.
  //           usage 500 -> headroom 5,500 both before/after. NEVER BLOCKED (shielded by the override).
  //   user-C: member of CC "Platform" with a CCULB 4,500 (untouched, no cap control at all) ->
  //           effective ULB = CCULB (more specific than universal), unaffected by the universal change.
  //           usage 500 -> headroom 4,000 both before/after. NEVER BLOCKED (shielded by the CCULB).
  it('blocks the unshielded user, and does not block individual- or CCULB-shielded users', () => {
    const live: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
      budget({ scope: 'individual', entityName: 'user-B', amountCredits: 6_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 4_500 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 0 }),
      budget({ scope: 'individual', entityName: 'user-B', amountCredits: 6_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 4_500 }),
    ];
    const plan = diffControls(live, desired);

    const usage = usageState({
      users: [
        user({ userLogin: 'user-A', costCenterName: null, poolCreditsUsed: 500 }),
        user({ userLogin: 'user-B', costCenterName: null, poolCreditsUsed: 500 }),
        user({ userLogin: 'user-C', costCenterName: 'Platform', poolCreditsUsed: 500 }),
      ],
    });

    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyBlockedUserLogins).toEqual(['user-A']);
    expect(result.newlyUnblockedUserLogins).toEqual([]);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-A', blockedBefore: false, blockedAfter: true, bindingConstraintAfter: 'ulb' },
      { userLogin: 'user-B', blockedBefore: false, blockedAfter: false, bindingConstraintAfter: null },
      { userLogin: 'user-C', blockedBefore: false, blockedAfter: false, bindingConstraintAfter: null },
    ]);
  });
});

describe('simulatePlan -- ULB precedence (individual > CCULB > universal)', () => {
  it('resolves the individual override over a near-zero CCULB (a precedence bug would report this user blocked)', () => {
    const live: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-D', amountCredits: 6_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 100 }),
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
    ];
    const plan = diffControls(live, live);
    const usage = usageState({ users: [user({ userLogin: 'user-D', costCenterName: 'Platform', poolCreditsUsed: 500 })] });

    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    // Individual (6,000) - 500 = 5,500 headroom -- not blocked. If precedence
    // were wrong and picked the CCULB (100), headroom would be -400 (blocked).
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-D', blockedBefore: false, blockedAfter: false, bindingConstraintAfter: null },
    ]);
  });

  it('resolves the CCULB over a generous universal ULB (a precedence bug would report this user unblocked)', () => {
    const live: ControlState[] = [
      budget({ scope: 'multi_user_cost_center', entityName: 'Data & Analytics', amountCredits: 100 }),
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
    ];
    const plan = diffControls(live, live);
    const usage = usageState({
      users: [user({ userLogin: 'user-E', costCenterName: 'Data & Analytics', poolCreditsUsed: 500 })],
    });

    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    // CCULB (100) - 500 = -400 -- blocked. If precedence were wrong and used
    // the universal ULB (4,000), headroom would be 3,500 (not blocked).
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-E', blockedBefore: true, blockedAfter: true, bindingConstraintAfter: 'ulb' },
    ]);
  });
});

describe('simulatePlan -- lowest-remaining-headroom-wins picks the more-exceeded lever, not array order', () => {
  it('reports the spending limit as binding when it is more exceeded than the ULB, even though the ULB is checked first', () => {
    // user-F: individual ULB 1,000; usage 800 pool + 210 metered = 1,010 total -> ULB headroom -10.
    // CC "Platform" cost-center spending limit 60,000 credits, hard-stop on; CC metered spend 60,500 -> headroom -500.
    // Both are exceeded and can block; -500 < -10, so the spending limit -- not the ULB -- is "the" binding constraint.
    const live: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-F', amountCredits: 1_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000, preventFurtherUsage: true }),
    ];
    const plan = diffControls(live, live);
    const usage = usageState({
      users: [user({ userLogin: 'user-F', costCenterName: 'Platform', poolCreditsUsed: 800, meteredCreditsUsed: 210 })],
      costCenters: [costCenterUsage({ costCenterName: 'Platform', poolCreditsUsed: 60_000, meteredCreditsUsed: 60_500 })],
    });

    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-F', blockedBefore: true, blockedAfter: true, bindingConstraintAfter: 'spending_limit' },
    ]);
  });
});

describe('simulatePlan -- deleting a binding ULB unblocks via fallback', () => {
  it('unblocks a user whose $0 individual ULB is deleted, falling back to a generous universal ULB', () => {
    const live: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-G', amountCredits: 0 }),
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
    ];
    const desired: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 })];
    const plan = diffControls(live, desired);
    expect(plan.entries).toEqual([
      expect.objectContaining({ action: 'delete', scope: 'individual', entityName: 'user-G' }),
    ]);

    const usage = usageState({ users: [user({ userLogin: 'user-G', costCenterName: null, poolCreditsUsed: 50 })] });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyUnblockedUserLogins).toEqual(['user-G']);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-G', blockedBefore: true, blockedAfter: false, bindingConstraintAfter: null },
    ]);
  });
});

describe('simulatePlan -- known v1 limitation: a hard $0 metered spending limit at exactly 0 metered spend', () => {
  it('does not flag a user as blocked by a $0 enterprise spending limit before any metered spend is recorded', () => {
    // Documented v1 limitation (no forecast/pool-exhaustion input): the
    // metered-phase signal is meteredCreditsUsed > 0, so a user who has just
    // tipped into metered with 0 recorded so far isn't caught by even a $0
    // hard-stop spending limit. This locks in the documented behaviour.
    const live: ControlState[] = [budget({ scope: 'enterprise', entityName: ENTERPRISE, amountCredits: 0, preventFurtherUsage: true })];
    const plan = diffControls(live, live);
    const usage = usageState({
      users: [user({ userLogin: 'user-H', costCenterName: null, poolCreditsUsed: 1_000, meteredCreditsUsed: 0 })],
      enterprise: { entityName: ENTERPRISE, meteredCreditsUsed: 0 },
    });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.userBlockStatus[0]).toMatchObject({ blockedAfter: false });
  });
});

describe('simulatePlan -- scope deltas ($/credit, enterprise & cost-center only)', () => {
  it('reports a spending-limit delta for an enterprise budget change', () => {
    const live: ControlState[] = [budget({ scope: 'enterprise', entityName: ENTERPRISE, amountCredits: 800_000 })];
    const desired: ControlState[] = [budget({ scope: 'enterprise', entityName: ENTERPRISE, amountCredits: 850_000 })];
    const plan = diffControls(live, desired);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.scopeDeltas).toEqual([
      { scope: 'enterprise', entityName: ENTERPRISE, kind: 'spending_limit', deltaCredits: 50_000, deltaUsd: 500 },
    ]);
    expect(result.summary.totalMeteredCapacityDeltaCredits).toBe(50_000);
    expect(result.summary.totalMeteredCapacityDeltaUsd).toBe(500);
    expect(result.summary.totalPoolCapacityDeltaCredits).toBe(0);
  });

  it('reports a spending-limit delta for a newly added cost-center budget (add = full amount)', () => {
    const desired: ControlState[] = [budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 })];
    const plan = diffControls([], desired);
    const result = simulatePlan(plan, usageState(), [], AS_OF_DATE);
    expect(result.scopeDeltas).toEqual([
      { scope: 'cost_center', entityName: 'Platform', kind: 'spending_limit', deltaCredits: 60_000, deltaUsd: 600 },
    ]);
  });

  it('reports a ulb-kind delta (rolled up to "enterprise") for a universal ULB change', () => {
    const live: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 })];
    const desired: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 5_000 })];
    const plan = diffControls(live, desired);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.scopeDeltas).toEqual([
      { scope: 'enterprise', entityName: ENTERPRISE, kind: 'ulb', deltaCredits: 1_000, deltaUsd: 10 },
    ]);
    expect(result.summary.totalPoolCapacityDeltaCredits).toBe(1_000);
    expect(result.summary.totalMeteredCapacityDeltaCredits).toBe(0);
  });

  it('reports a negative ulb-kind delta (rolled up to "cost_center") for a deleted CCULB', () => {
    const live: ControlState[] = [budget({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 4_500 })];
    const plan = diffControls(live, []);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.scopeDeltas).toEqual([
      { scope: 'cost_center', entityName: 'Platform', kind: 'ulb', deltaCredits: -4_500, deltaUsd: -45 },
    ]);
  });

  it('excludes individual-ULB and organization-scope changes from scope deltas', () => {
    const live: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-01', amountCredits: 6_000 }),
      budget({ scope: 'organization', entityName: 'acme-eng-org', amountCredits: 320_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-01', amountCredits: 7_000 }),
      budget({ scope: 'organization', entityName: 'acme-eng-org', amountCredits: 330_000 }),
    ];
    const plan = diffControls(live, desired);
    expect(plan.entries).toHaveLength(2); // sanity: the plan really does contain both changes
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.scopeDeltas).toEqual([]);
  });

  it('sums multiple deltas of the same kind into the summary totals', () => {
    const live: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
      budget({ scope: 'cost_center', entityName: 'Data & Analytics', amountCredits: 40_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 65_000 }),
      budget({ scope: 'cost_center', entityName: 'Data & Analytics', amountCredits: 45_000 }),
    ];
    const plan = diffControls(live, desired);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.summary.totalMeteredCapacityDeltaCredits).toBe(10_000);
    expect(result.summary.totalMeteredCapacityDeltaUsd).toBe(100);
  });
});

describe('simulatePlan -- included-usage cap toggle deltas (never a credits amount)', () => {
  it('reports an enabledChange with no numeric amount anywhere on the delta', () => {
    const live: ControlState[] = [cap({ enabled: false })];
    const desired: ControlState[] = [cap({ enabled: true })];
    const plan = diffControls(live, desired);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.capToggleDeltas).toEqual([
      { costCenterName: 'Platform', enabledChange: { old: false, new: true } },
    ]);
    expect(result.capToggleDeltas[0]).not.toHaveProperty('deltaCredits');
    expect(result.capToggleDeltas[0]).not.toHaveProperty('computedLimitCredits');
  });

  it('reports both enabledChange and overflowChange when both are staged together', () => {
    const live: ControlState[] = [cap({ enabled: false, overflow: 'block' })];
    const desired: ControlState[] = [cap({ enabled: true, overflow: 'metered' })];
    const plan = diffControls(live, desired);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.capToggleDeltas).toEqual([
      { costCenterName: 'Platform', enabledChange: { old: false, new: true }, overflowChange: { old: 'block', new: 'metered' } },
    ]);
  });

  it('is unaffected by a computedLimitCredits difference alone (already a no-op at the diff level)', () => {
    const live: ControlState[] = [cap({ computedLimitCredits: 70_000 })];
    const desired: ControlState[] = [cap({ computedLimitCredits: 112_000 })];
    const plan = diffControls(live, desired);
    const result = simulatePlan(plan, usageState(), live, AS_OF_DATE);
    expect(result.capToggleDeltas).toEqual([]);
  });
});

describe('simulatePlan -- empty plan and determinism', () => {
  it('returns all-zero/empty results for an empty plan', () => {
    const live: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 })];
    const plan = diffControls(live, live);
    expect(plan.isNoOp).toBe(true);
    const usage = usageState({ users: [user({ userLogin: 'user-01', poolCreditsUsed: 500 })] });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyBlockedUserLogins).toEqual([]);
    expect(result.newlyUnblockedUserLogins).toEqual([]);
    expect(result.scopeDeltas).toEqual([]);
    expect(result.capToggleDeltas).toEqual([]);
    expect(result.summary).toEqual({
      newlyBlockedCount: 0,
      newlyUnblockedCount: 0,
      totalPoolCapacityDeltaCredits: 0,
      totalMeteredCapacityDeltaCredits: 0,
      totalPoolCapacityDeltaUsd: 0,
      totalMeteredCapacityDeltaUsd: 0,
    });
  });

  it('is deterministic: running simulatePlan twice on identical inputs deepEquals', () => {
    const live: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
      cap({ enabled: false }),
    ];
    const desired: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 0 }), cap({ enabled: true })];
    const plan = diffControls(live, desired);
    const usage = usageState({
      users: [user({ userLogin: 'user-01', poolCreditsUsed: 500 }), user({ userLogin: 'user-02', costCenterName: 'Platform', poolCreditsUsed: 100 })],
      costCenters: [costCenterUsage({ poolCreditsUsed: 70_000 })],
    });
    const first = simulatePlan(plan, usage, live, AS_OF_DATE);
    const second = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(second).toEqual(first);
  });

  it('sorts userBlockStatus and the blocked/unblocked lists ascending by login', () => {
    const live: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 })];
    const desired: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 0 })];
    const plan = diffControls(live, desired);
    const usage = usageState({
      users: [user({ userLogin: 'user-zz', poolCreditsUsed: 10 }), user({ userLogin: 'user-aa', poolCreditsUsed: 10 })],
    });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyBlockedUserLogins).toEqual(['user-aa', 'user-zz']);
    expect(result.userBlockStatus.map((u) => u.userLogin)).toEqual(['user-aa', 'user-zz']);
  });
});

describe('simulatePlan -- multi-entry plan re-resolves precedence (delete CCULB + add individual override, same user)', () => {
  // Adversarial probe: one plan both deletes the CCULB that was binding a user
  // AND adds an individual override for that same user. The two entries have
  // distinct identity keys, so both land; post-plan precedence must resolve to
  // the freshly-added individual override (most specific), unblocking the user.
  it('unblocks a CCULB-bound user when the CCULB is deleted and an individual override is added in the same plan', () => {
    const live: ControlState[] = [
      budget({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 100 }),
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 4_000 }),
      budget({ scope: 'individual', entityName: 'user-X', amountCredits: 6_000 }),
    ];
    const plan = diffControls(live, desired);
    // sanity: the plan carries exactly the delete + the add.
    expect(plan.entries.map((e) => e.action).sort()).toEqual(['add', 'delete']);

    const usage = usageState({
      users: [user({ userLogin: 'user-X', costCenterName: 'Platform', poolCreditsUsed: 500 })],
    });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    // BEFORE: CCULB 100 - 500 = -400 -> blocked by ulb.
    // AFTER:  individual 6,000 - 500 = 5,500 -> not blocked (override wins over universal too).
    expect(result.newlyUnblockedUserLogins).toEqual(['user-X']);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'user-X', blockedBefore: true, blockedAfter: false, bindingConstraintAfter: null },
    ]);
  });
});

// Task 4.13: membership-move depth. A 1:1 reassignment re-homes the mover to
// their NEW cost center for the AFTER resolution, so a move that changes which
// CCULB governs them changes their block status.
describe('simulatePlan -- cost-center membership moves re-home the mover (Task 4.13)', () => {
  function costCenter(name: string, members: Array<{ type: 'User'; name: string }>): ControlState {
    return {
      kind: 'cost_center',
      name,
      dewrDivision: 'D',
      dewrBranch: 'B',
      dewrProject: 'P',
      excludedFromEnterpriseBudget: false,
      members,
      includedUsageCap: { enabled: false, overflow: 'block' },
    };
  }

  it('newly blocks a mover reassigned from a generous CCULB to a team with only the (lower) universal ULB', () => {
    // mover: 8,000 used. Generous CCULB = 10,000 (headroom 2,000, not blocked).
    // Stingy has no CCULB -> universal 5,000 (headroom -3,000, blocked).
    const live: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 5_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Generous', amountCredits: 10_000 }),
      costCenter('Generous', [{ type: 'User', name: 'mover' }]),
      costCenter('Stingy', []),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 5_000 }),
      budget({ scope: 'multi_user_cost_center', entityName: 'Generous', amountCredits: 10_000 }),
      costCenter('Generous', []),
      costCenter('Stingy', [{ type: 'User', name: 'mover' }]),
    ];
    const plan = diffControls(live, desired);
    // Sanity: exactly the two membership change entries (remove from Generous, add to Stingy).
    expect(plan.entries).toHaveLength(2);

    const usage = usageState({
      users: [user({ userLogin: 'mover', costCenterName: 'Generous', poolCreditsUsed: 8_000 })],
    });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyBlockedUserLogins).toEqual(['mover']);
    expect(result.userBlockStatus).toEqual([
      { userLogin: 'mover', blockedBefore: false, blockedAfter: true, bindingConstraintAfter: 'ulb' },
    ]);
  });

  it('is a no-op (no block change) when the move keeps the mover under a ULB with headroom', () => {
    // mover: 4,000 used, universal 5,000 everywhere; neither team has a CCULB.
    const live: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 5_000 }),
      costCenter('A', [{ type: 'User', name: 'mover' }]),
      costCenter('B', []),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 5_000 }),
      costCenter('A', []),
      costCenter('B', [{ type: 'User', name: 'mover' }]),
    ];
    const plan = diffControls(live, desired);
    const usage = usageState({ users: [user({ userLogin: 'mover', costCenterName: 'A', poolCreditsUsed: 4_000 })] });
    const result = simulatePlan(plan, usage, live, AS_OF_DATE);
    expect(result.newlyBlockedUserLogins).toEqual([]);
    expect(result.newlyUnblockedUserLogins).toEqual([]);
  });
});

// Checkpoint 5: PLAN.md Task 4.6 promised simulatePlan takes an optional
// forecast input "from day one so the [Phase 6] upgrade is additive". This
// locks that promise: the SimulationForecastInput surface still compiles
// end-to-end when a forecast is actually PROVIDED (not just when the arg is
// omitted), and -- because v1 deliberately accepts-but-ignores it (`void
// forecast`) -- passing one is inert: identical result to the no-forecast
// call. Phase 6 only starts READING this input; the signature never changes.
describe('simulatePlan -- optional forecast input (Task 4.6 additive surface)', () => {
  it('compiles with a SimulationForecastInput provided and treats it as inert in v1', () => {
    const live: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 5_000 })];
    const desired: ControlState[] = [budget({ scope: 'universal', entityName: ENTERPRISE, amountCredits: 6_000 })];
    const plan = diffControls(live, desired);
    const usage = usageState({ users: [user({ userLogin: 'user-01', poolCreditsUsed: 4_500 })] });

    // Type-level proof: this shape must satisfy the exported interface exactly.
    const forecast: SimulationForecastInput = {
      projectedEndOfCycleCreditsUsedByUser: { 'user-01': 9_000 },
      projectedEndOfCycleCreditsUsedByCostCenter: { Platform: 42_000 },
      cycleEndDate: new Date('2026-06-30T00:00:00.000Z'),
    };

    const withForecast = simulatePlan(plan, usage, live, AS_OF_DATE, forecast);
    const withoutForecast = simulatePlan(plan, usage, live, AS_OF_DATE);

    // v1 ignores the forecast (`void forecast`) -> byte-for-byte identical.
    expect(withForecast).toEqual(withoutForecast);
  });
});
