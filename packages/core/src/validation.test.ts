import { describe, expect, it } from 'vitest';
import { diffControls, type BudgetControl, type ControlState, type CostCenterControl } from './controls';
import {
  DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS,
  validatePlan,
  type AlertOnlyOverrideInput,
  type UserLicenseContext,
  type ValidationContext,
} from './validation';

function budget(overrides: Partial<BudgetControl> = {}): BudgetControl {
  return {
    kind: 'budget',
    scope: 'individual',
    entityName: 'user-07',
    amountCredits: 6000,
    preventFurtherUsage: true,
    alerting: { willAlert: true, alertRecipients: [] },
    ...overrides,
  };
}

function ctx(live: readonly ControlState[], overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { live, ...overrides };
}

describe('validatePlan -- enterprise cap below cost-center sum (blocker)', () => {
  it('blocks when the post-plan enterprise cap is below the post-plan cost-center sum', () => {
    const live: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 800_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 800_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 900_000 }), // raised above the enterprise cap
    ];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.isBlocked).toBe(true);
    expect(result.blockers).toEqual([
      {
        kind: 'enterprise_cap_below_cost_center_sum',
        enterpriseEntityName: 'acme-enterprise',
        enterpriseCapCredits: 800_000,
        costCenterSumCredits: 900_000,
      },
    ]);
  });

  it('does not block when the post-plan enterprise cap covers the sum', () => {
    const live: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 800_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 800_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 70_000 }),
    ];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.blockers).toEqual([]);
    expect(result.isBlocked).toBe(false);
  });

  it('sums *all* post-plan cost-center budgets, not just the one the plan touched', () => {
    const live: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
      budget({ scope: 'cost_center', entityName: 'Data & Analytics', amountCredits: 50_000 }), // untouched by this plan
    ];
    const desired: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }), // unchanged
      budget({ scope: 'cost_center', entityName: 'Data & Analytics', amountCredits: 50_000 }), // unchanged
    ];
    // This plan is a no-op (nothing staged) -- the sum (110,000) already
    // exceeds the enterprise cap (100,000) in *live*, so the blocker must
    // fire even though the plan itself changes nothing, because it's
    // evaluated against post-plan (== live, here) state.
    const plan = diffControls(live, desired);
    expect(plan.isNoOp).toBe(true);
    const result = validatePlan(plan, ctx(live));
    expect(result.isBlocked).toBe(true);
    expect(result.blockers[0]).toMatchObject({ costCenterSumCredits: 110_000, enterpriseCapCredits: 100_000 });
  });

  it('does not block when no enterprise budget exists post-plan', () => {
    const live: ControlState[] = [budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 })];
    const plan = diffControls(live, live);
    const result = validatePlan(plan, ctx(live));
    expect(result.blockers).toEqual([]);
  });
});

// Task 4.13: the sum is exclusion-aware -- a cost center flagged
// excludedFromEnterpriseBudget bills against its own cap, not the enterprise
// budget, so its spending limit must not count toward the enterprise-cap sum.
describe('validatePlan -- exclusion-aware enterprise-cap-below-sum (Task 4.13)', () => {
  function costCenter(name: string, excluded: boolean): CostCenterControl {
    return {
      kind: 'cost_center',
      name,
      dewrDivision: 'D',
      dewrBranch: 'B',
      dewrProject: 'P',
      excludedFromEnterpriseBudget: excluded,
      members: [],
      includedUsageCap: { enabled: true, overflow: 'block' },
    };
  }

  it('does NOT block when the over-sum is entirely due to an EXCLUDED cost center', () => {
    // Enterprise cap 100k; Platform 60k (counts) + Data 60k (EXCLUDED). Naive
    // sum 120k > 100k would block; exclusion-aware sum is 60k <= 100k.
    const live: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
      budget({ scope: 'cost_center', entityName: 'Data', amountCredits: 60_000 }),
      costCenter('Platform', false),
      costCenter('Data', true),
    ];
    const plan = diffControls(live, live);
    const result = validatePlan(plan, ctx(live));
    expect(result.isBlocked).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('STILL blocks when the non-excluded cost centers alone exceed the enterprise cap', () => {
    // Same shape but neither is excluded -> 120k > 100k -> blocked.
    const live: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
      budget({ scope: 'cost_center', entityName: 'Data', amountCredits: 60_000 }),
      costCenter('Platform', false),
      costCenter('Data', false),
    ];
    const plan = diffControls(live, live);
    const result = validatePlan(plan, ctx(live));
    expect(result.isBlocked).toBe(true);
    expect(result.blockers[0]).toMatchObject({
      kind: 'enterprise_cap_below_cost_center_sum',
      costCenterSumCredits: 120_000,
    });
  });

  it('reacts to a staged flip of the exclusion flag (post-plan state, not just live)', () => {
    // Live blocks (both counted = 120k). The plan excludes Data -> post-plan
    // sum drops to 60k -> no longer blocked.
    const live: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
      budget({ scope: 'cost_center', entityName: 'Data', amountCredits: 60_000 }),
      costCenter('Platform', false),
      costCenter('Data', false),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'enterprise', entityName: 'acme-enterprise', amountCredits: 100_000 }),
      budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 60_000 }),
      budget({ scope: 'cost_center', entityName: 'Data', amountCredits: 60_000 }),
      costCenter('Platform', false),
      costCenter('Data', true), // staged exclusion
    ];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.isBlocked).toBe(false);
  });
});

describe('validatePlan -- negative amounts (blocker)', () => {
  it('blocks a newly added budget with a negative amount', () => {
    const desired: ControlState[] = [budget({ scope: 'individual', entityName: 'user-30', amountCredits: -100 })];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.isBlocked).toBe(true);
    expect(result.blockers).toEqual([
      { kind: 'negative_amount', controlId: 'budget:individual:user-30', amountCredits: -100 },
    ]);
  });

  it('blocks a change that sets an amount negative', () => {
    const live: ControlState[] = [budget({ amountCredits: 6000 })];
    const desired: ControlState[] = [budget({ amountCredits: -1 })];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.blockers).toEqual([
      { kind: 'negative_amount', controlId: 'budget:individual:user-07', amountCredits: -1 },
    ]);
  });

  it('does not block a positive or zero amount', () => {
    const desired: ControlState[] = [budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 })];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.blockers).toEqual([]);
  });
});

describe('validatePlan -- $0 / near-zero ULB (warning)', () => {
  it('warns on a newly added $0 ULB', () => {
    const desired: ControlState[] = [budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 })];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.warnings).toEqual([
      {
        kind: 'zero_or_near_zero_ulb',
        controlId: 'budget:individual:user-20',
        amountCredits: 0,
        thresholdCredits: DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS,
      },
    ]);
  });

  it('warns on a ULB changed to just at the default near-zero threshold', () => {
    const live: ControlState[] = [budget({ amountCredits: 6000 })];
    const desired: ControlState[] = [budget({ amountCredits: DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS })];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ kind: 'zero_or_near_zero_ulb' });
  });

  it('does not warn on a ULB comfortably above the threshold', () => {
    const desired: ControlState[] = [budget({ scope: 'individual', entityName: 'user-30', amountCredits: 5000 })];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.warnings).toEqual([]);
  });

  it('does not warn on a near-zero *spending limit* (not a ULB scope)', () => {
    const desired: ControlState[] = [budget({ scope: 'cost_center', entityName: 'Platform', amountCredits: 0 })];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.warnings).toEqual([]);
  });

  it('honours a parameterized threshold', () => {
    const desired: ControlState[] = [budget({ scope: 'individual', entityName: 'user-30', amountCredits: 400 })];
    const plan = diffControls([], desired);
    const strict = validatePlan(plan, ctx([], { nearZeroUlbThresholdCredits: 500 }));
    const lenient = validatePlan(plan, ctx([], { nearZeroUlbThresholdCredits: 100 }));
    expect(strict.warnings).toHaveLength(1);
    expect(lenient.warnings).toEqual([]);
  });
});

describe('validatePlan -- multi-org-licensed users (warning)', () => {
  const multiOrg: UserLicenseContext = { userLogin: 'user-07', licensedOrgLogins: ['acme-eng-org', 'acme-mkt-org'] };
  const singleOrg: UserLicenseContext = { userLogin: 'user-08', licensedOrgLogins: ['acme-eng-org'] };

  it('warns for a user licensed in more than one org', () => {
    const plan = diffControls([], []);
    const result = validatePlan(plan, ctx([], { users: [multiOrg, singleOrg] }));
    expect(result.warnings).toEqual([
      { kind: 'multi_org_licensed_user', userLogin: 'user-07', orgLogins: ['acme-eng-org', 'acme-mkt-org'] },
    ]);
  });

  it('does not warn for a user licensed in exactly one org', () => {
    const plan = diffControls([], []);
    const result = validatePlan(plan, ctx([], { users: [singleOrg] }));
    expect(result.warnings).toEqual([]);
  });

  it('is independent of plan contents -- fires even on a no-op plan', () => {
    const live: ControlState[] = [budget()];
    const plan = diffControls(live, live);
    expect(plan.isNoOp).toBe(true);
    const result = validatePlan(plan, ctx(live, { users: [multiOrg] }));
    expect(result.warnings).toHaveLength(1);
  });
});

describe('validatePlan -- alert-only-without-hard-stop override (warning, justification-required)', () => {
  it('flags a newly added ULB staged with hard-stop off, requiring justification', () => {
    const desired: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-30', preventFurtherUsage: false }),
    ];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.warnings).toEqual([
      {
        kind: 'alert_only_without_hard_stop',
        controlId: 'budget:individual:user-30',
        override: { status: 'required' },
      },
    ]);
  });

  it('marks the override acknowledged when a non-empty justification is supplied', () => {
    const desired: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-30', preventFurtherUsage: false }),
    ];
    const plan = diffControls([], desired);
    const overrides: AlertOnlyOverrideInput[] = [
      { controlId: 'budget:individual:user-30', justification: 'Approved by FinOps: contractor ramp-down.' },
    ];
    const result = validatePlan(plan, ctx([], { alertOnlyOverrides: overrides }));
    expect(result.warnings).toEqual([
      {
        kind: 'alert_only_without_hard_stop',
        controlId: 'budget:individual:user-30',
        override: { status: 'acknowledged', justification: 'Approved by FinOps: contractor ramp-down.' },
      },
    ]);
  });

  it('treats a whitespace-only justification as not provided (still required)', () => {
    const desired: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-30', preventFurtherUsage: false }),
    ];
    const plan = diffControls([], desired);
    const overrides: AlertOnlyOverrideInput[] = [{ controlId: 'budget:individual:user-30', justification: '   ' }];
    const result = validatePlan(plan, ctx([], { alertOnlyOverrides: overrides }));
    expect(result.warnings[0]).toMatchObject({ override: { status: 'required' } });
  });

  it('does not flag a freshly staged spending limit with hard-stop off (the documented default)', () => {
    const desired: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: false }),
    ];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.warnings).toEqual([]);
  });

  it('flags turning an existing spending limit from hard-stop on to alert-only', () => {
    const live: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: true, amountCredits: 60_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: false, amountCredits: 60_000 }),
    ];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.warnings).toEqual([
      {
        kind: 'alert_only_without_hard_stop',
        controlId: 'budget:cost_center:Platform',
        override: { status: 'required' },
      },
    ]);
  });

  it('does not flag tightening a spending limit from alert-only to hard-stop', () => {
    const live: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: false, amountCredits: 60_000 }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: true, amountCredits: 60_000 }),
    ];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.warnings).toEqual([]);
  });

  it('flags an existing ULB changed to hard-stop off', () => {
    const live: ControlState[] = [budget({ preventFurtherUsage: true })];
    const desired: ControlState[] = [budget({ preventFurtherUsage: false })];
    const plan = diffControls(live, desired);
    const result = validatePlan(plan, ctx(live));
    expect(result.warnings).toEqual([
      { kind: 'alert_only_without_hard_stop', controlId: 'budget:individual:user-07', override: { status: 'required' } },
    ]);
  });
});

describe('validatePlan -- blockers vs warnings are distinct, and isBlocked reflects only blockers', () => {
  it('isBlocked is true only when a blocker is present, regardless of warnings', () => {
    const desired: ControlState[] = [budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 })]; // warning only
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.blockers).toEqual([]);
    expect(result.isBlocked).toBe(false);
  });

  it('a plan can carry both a blocker and an unrelated warning simultaneously', () => {
    const desired: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-40', amountCredits: -5 }), // blocker (negative) -- also near-zero, so it warns too
      budget({ scope: 'individual', entityName: 'user-41', amountCredits: 20 }), // warning only (near-zero, not negative)
    ];
    const plan = diffControls([], desired);
    const result = validatePlan(plan, ctx([]));
    expect(result.isBlocked).toBe(true);
    expect(result.blockers).toEqual([
      { kind: 'negative_amount', controlId: 'budget:individual:user-40', amountCredits: -5 },
    ]);
    expect(result.warnings.map((w) => (w as { controlId: string }).controlId).sort()).toEqual([
      'budget:individual:user-40',
      'budget:individual:user-41',
    ]);
  });
});
