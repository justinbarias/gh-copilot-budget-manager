import { describe, expect, it } from 'vitest';
import {
  applyPlanToControls,
  controlIdentity,
  creditsToUsd,
  diffControls,
  driftedControlIds,
  INCLUDED_CAP_CREDITS_PER_SEAT,
  isSpendingLimitScope,
  isUlbScope,
  type BudgetControl,
  type ControlState,
  type CostCenterControl,
  type IncludedCapControl,
  type PlanEntry,
} from './controls';

function budget(overrides: Partial<BudgetControl> = {}): BudgetControl {
  return {
    kind: 'budget',
    scope: 'individual',
    entityName: 'user-07',
    amountCredits: 6000,
    preventFurtherUsage: true,
    alerting: { willAlert: true, alertRecipients: ['user-07@acme.example'] },
    ...overrides,
  };
}

function cap(overrides: Partial<IncludedCapControl> = {}): IncludedCapControl {
  return {
    kind: 'included_cap',
    costCenterName: 'Platform',
    enabled: true,
    overflow: 'block',
    computedLimitCredits: 105_000,
    ...overrides,
  };
}

function costCenter(overrides: Partial<CostCenterControl> = {}): CostCenterControl {
  return {
    kind: 'cost_center',
    name: 'Platform',
    dewrDivision: 'Digital',
    dewrBranch: 'Delivery',
    dewrProject: 'PLAT',
    excludedFromEnterpriseBudget: false,
    members: [{ type: 'User', name: 'user-07' }],
    includedUsageCap: { enabled: true, overflow: 'block' },
    ...overrides,
  };
}

describe('creditsToUsd', () => {
  it('converts at $0.01/credit', () => {
    expect(creditsToUsd(6000)).toBe(60);
    expect(creditsToUsd(150)).toBe(1.5);
    expect(creditsToUsd(0)).toBe(0);
  });

  it('converts negative credits (deltas can be negative)', () => {
    expect(creditsToUsd(-250)).toBe(-2.5);
  });
});

describe('isUlbScope / isSpendingLimitScope', () => {
  it('classifies the three ULB scopes', () => {
    expect(isUlbScope('universal')).toBe(true);
    expect(isUlbScope('individual')).toBe(true);
    expect(isUlbScope('multi_user_cost_center')).toBe(true);
    expect(isUlbScope('enterprise')).toBe(false);
  });

  it('classifies the three spending-limit scopes', () => {
    expect(isSpendingLimitScope('enterprise')).toBe(true);
    expect(isSpendingLimitScope('organization')).toBe(true);
    expect(isSpendingLimitScope('cost_center')).toBe(true);
    expect(isSpendingLimitScope('universal')).toBe(false);
  });

  it('is exhaustive and mutually exclusive over BudgetScope', () => {
    const scopes = ['universal', 'individual', 'multi_user_cost_center', 'enterprise', 'organization', 'cost_center'] as const;
    for (const scope of scopes) {
      expect(isUlbScope(scope) !== isSpendingLimitScope(scope)).toBe(true);
    }
  });
});

describe('controlIdentity', () => {
  it('keys a budget by kind:scope:entityName', () => {
    expect(controlIdentity(budget({ scope: 'individual', entityName: 'user-07' }))).toBe('budget:individual:user-07');
  });

  it('keys an included cap by kind:costCenterName', () => {
    expect(controlIdentity(cap({ costCenterName: 'Platform' }))).toBe('included_cap:Platform');
  });

  it('never collides a budget and a cap that share a human-readable name', () => {
    const b = controlIdentity(budget({ scope: 'multi_user_cost_center', entityName: 'Platform' }));
    const c = controlIdentity(cap({ costCenterName: 'Platform' }));
    expect(b).not.toBe(c);
  });
});

describe('diffControls', () => {
  it('produces an empty, no-op plan for two empty lists', () => {
    const plan = diffControls([], []);
    expect(plan.entries).toEqual([]);
    expect(plan.isNoOp).toBe(true);
  });

  it('produces an empty, no-op plan when live and desired are identical', () => {
    const live = [budget(), cap()];
    const desired = [budget(), cap()];
    const plan = diffControls(live, desired);
    expect(plan.entries).toEqual([]);
    expect(plan.isNoOp).toBe(true);
  });

  it('emits an add entry for a control only in desired', () => {
    const desired = [budget({ scope: 'universal', entityName: 'acme-enterprise', amountCredits: 4000 })];
    const plan = diffControls([], desired);
    expect(plan.isNoOp).toBe(false);
    expect(plan.entries).toEqual([
      {
        id: 'budget:universal:acme-enterprise',
        controlKind: 'budget',
        action: 'add',
        scope: 'universal',
        entityName: 'acme-enterprise',
        desired: desired[0],
      },
    ]);
  });

  it('emits a delete entry for a control only in live', () => {
    const live = [budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 })];
    const plan = diffControls(live, []);
    expect(plan.entries).toEqual([
      {
        id: 'budget:individual:user-20',
        controlKind: 'budget',
        action: 'delete',
        scope: 'individual',
        entityName: 'user-20',
        live: live[0],
      },
    ]);
  });

  it('emits an exact old->new change entry for a single changed field (amountCredits)', () => {
    const live = [budget({ amountCredits: 6000 })];
    const desired = [budget({ amountCredits: 7500 })];
    const plan = diffControls(live, desired);
    expect(plan.entries).toEqual([
      {
        id: 'budget:individual:user-07',
        controlKind: 'budget',
        action: 'change',
        scope: 'individual',
        entityName: 'user-07',
        changes: [{ field: 'amountCredits', old: 6000, new: 7500 }],
      },
    ]);
  });

  it('emits a change entry for preventFurtherUsage', () => {
    const live = [budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: false })];
    const desired = [budget({ scope: 'cost_center', entityName: 'Platform', preventFurtherUsage: true })];
    const plan = diffControls(live, desired);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      action: 'change',
      changes: [{ field: 'preventFurtherUsage', old: false, new: true }],
    });
  });

  it('emits a change entry for alerting when recipients differ', () => {
    const live = [budget({ alerting: { willAlert: true, alertRecipients: ['a@acme.example'] } })];
    const desired = [budget({ alerting: { willAlert: true, alertRecipients: ['a@acme.example', 'b@acme.example'] } })];
    const plan = diffControls(live, desired);
    expect(plan.entries[0]).toMatchObject({
      changes: [
        {
          field: 'alerting',
          old: { willAlert: true, alertRecipients: ['a@acme.example'] },
          new: { willAlert: true, alertRecipients: ['a@acme.example', 'b@acme.example'] },
        },
      ],
    });
  });

  it('does not flag alerting as changed when recipients are equal but distinct arrays', () => {
    const live = [budget({ alerting: { willAlert: true, alertRecipients: ['a@acme.example'] } })];
    const desired = [budget({ alerting: { willAlert: true, alertRecipients: ['a@acme.example'] } })];
    expect(diffControls(live, desired).isNoOp).toBe(true);
  });

  it('does not flag alerting as changed when the same recipients arrive in a different order', () => {
    // Recipient order is not semantically meaningful and GitHub does not
    // guarantee a stable order across reads -- a reorder must NOT manufacture
    // drift (the live-mode-hardening alertingEqual order fix).
    const live = [budget({ alerting: { willAlert: true, alertRecipients: ['a@acme.example', 'b@acme.example', 'c@acme.example'] } })];
    const desired = [budget({ alerting: { willAlert: true, alertRecipients: ['c@acme.example', 'a@acme.example', 'b@acme.example'] } })];
    expect(diffControls(live, desired).isNoOp).toBe(true);
  });

  it('bundles multiple simultaneous field changes into one change entry', () => {
    const live = [budget({ amountCredits: 6000, preventFurtherUsage: true })];
    const desired = [budget({ amountCredits: 7000, preventFurtherUsage: false })];
    const plan = diffControls(live, desired);
    expect(plan.entries).toHaveLength(1);
    const entry = plan.entries[0] as Extract<PlanEntry, { action: 'change'; controlKind: 'budget' }>;
    expect(entry.changes).toEqual([
      { field: 'amountCredits', old: 6000, new: 7000 },
      { field: 'preventFurtherUsage', old: true, new: false },
    ]);
  });

  it('emits a named included_cap.enabled false->true diff entry', () => {
    const live = [cap({ enabled: false })];
    const desired = [cap({ enabled: true })];
    const plan = diffControls(live, desired);
    expect(plan.entries).toEqual([
      {
        id: 'included_cap:Platform',
        controlKind: 'included_cap',
        action: 'change',
        costCenterName: 'Platform',
        changes: [{ field: 'enabled', old: false, new: true }],
      },
    ]);
  });

  it('emits a named included_cap.overflow diff entry', () => {
    const live = [cap({ overflow: 'block' })];
    const desired = [cap({ overflow: 'metered' })];
    const plan = diffControls(live, desired);
    expect(plan.entries[0]).toMatchObject({
      changes: [{ field: 'overflow', old: 'block', new: 'metered' }],
    });
  });

  it('never diffs computedLimitCredits -- a cap differing only in computed limit is a no-op', () => {
    const live = [cap({ computedLimitCredits: 105_000 })];
    const desired = [cap({ computedLimitCredits: 112_000 })];
    expect(diffControls(live, desired).isNoOp).toBe(true);
  });

  it('is deterministic: running diffControls twice on identical inputs deepEquals', () => {
    const live: ControlState[] = [budget({ scope: 'universal', entityName: 'acme', amountCredits: 4000 }), cap({ enabled: false })];
    const desired: ControlState[] = [budget({ scope: 'universal', entityName: 'acme', amountCredits: 5000 }), cap({ enabled: true })];
    const first = diffControls(live, desired);
    const second = diffControls(live, desired);
    expect(second).toEqual(first);
  });

  it('sorts entries by stable id regardless of input array order', () => {
    const live: ControlState[] = [];
    const desired: ControlState[] = [
      budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 }),
      budget({ scope: 'universal', entityName: 'acme', amountCredits: 4000 }),
      cap({ costCenterName: 'Platform' }),
    ];
    const planA = diffControls(live, desired);
    const planB = diffControls(live, [...desired].reverse());
    expect(planB).toEqual(planA);
    const ids = planA.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('handles a mixed multi-control plan (add + change + delete across budgets and caps)', () => {
    const live: ControlState[] = [
      budget({ scope: 'universal', entityName: 'acme', amountCredits: 4000 }),
      budget({ scope: 'individual', entityName: 'user-99', amountCredits: 500 }),
      cap({ costCenterName: 'Platform', enabled: true }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: 'acme', amountCredits: 5000 }), // change
      cap({ costCenterName: 'Platform', enabled: false }), // change
      budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 }), // add
      // user-99's budget is absent from desired -> delete
    ];
    const plan = diffControls(live, desired);
    expect(plan.entries.map((e) => e.action).sort()).toEqual(['add', 'change', 'change', 'delete']);
    expect(plan.entries).toHaveLength(4);
    expect(plan.isNoOp).toBe(false);
  });

  it('does not emit a delete for included_cap when only computedLimitCredits would differ', () => {
    // Regression guard: an included_cap present in both live and desired,
    // differing only in computedLimitCredits, must never be seen as needing
    // any action at all (not add, not change, not delete).
    const live = [cap({ computedLimitCredits: 70_000 })];
    const desired = [cap({ computedLimitCredits: 70_000 })];
    expect(diffControls(live, desired).entries).toEqual([]);
  });

  it('does not emit a cap change entry for an unchanged enabled flag (true -> true no-op)', () => {
    // Adversarial probe: a cap re-supplied with the same enabled value (but a
    // freshly-constructed object) must not produce a spurious enabled change.
    const live = [cap({ enabled: true, overflow: 'block' })];
    const desired = [cap({ enabled: true, overflow: 'block' })];
    expect(diffControls(live, desired).entries).toEqual([]);
  });

  it('emits only the overflow change when enabled is unchanged (no phantom enabledChange)', () => {
    const live = [cap({ enabled: true, overflow: 'block' })];
    const desired = [cap({ enabled: true, overflow: 'metered' })];
    const plan = diffControls(live, desired);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      controlKind: 'included_cap',
      action: 'change',
      changes: [{ field: 'overflow', old: 'block', new: 'metered' }],
    });
    // exactly one change -- no enabled entry sneaks in.
    const entry = plan.entries[0] as Extract<PlanEntry, { action: 'change'; controlKind: 'included_cap' }>;
    expect(entry.changes).toHaveLength(1);
  });
});

describe('applyPlanToControls', () => {
  it('adds a control from an add entry', () => {
    const desired = budget({ scope: 'universal', entityName: 'acme', amountCredits: 4000 });
    const plan = diffControls([], [desired]);
    expect(applyPlanToControls([], plan)).toEqual([desired]);
  });

  it('removes a control from a delete entry', () => {
    const live = [budget({ scope: 'individual', entityName: 'user-20', amountCredits: 0 })];
    const plan = diffControls(live, []);
    expect(applyPlanToControls(live, plan)).toEqual([]);
  });

  it('applies field changes and preserves untouched fields', () => {
    const live = [budget({ amountCredits: 6000, preventFurtherUsage: true })];
    const desired = [budget({ amountCredits: 7500, preventFurtherUsage: true })];
    const plan = diffControls(live, desired);
    expect(applyPlanToControls(live, plan)).toEqual(desired);
  });

  it('applies cap enabled/overflow changes without ever touching computedLimitCredits', () => {
    const live = [cap({ enabled: false, overflow: 'block', computedLimitCredits: 105_000 })];
    const desired = [cap({ enabled: true, overflow: 'metered', computedLimitCredits: 999_999 })];
    const plan = diffControls(live, desired);
    const result = applyPlanToControls(live, plan);
    // enabled/overflow flip, but computedLimitCredits stays at the *live*
    // value -- it was never part of the plan, so applying the plan cannot
    // have changed it (proves the cap is unrepresentable as a dial-able amount).
    expect(result).toEqual([{ ...live[0], enabled: true, overflow: 'metered' }]);
  });

  it('round-trips: applyPlanToControls(live, diffControls(live, desired)) deepEquals desired', () => {
    const live: ControlState[] = [
      budget({ scope: 'universal', entityName: 'acme', amountCredits: 4000 }),
      budget({ scope: 'individual', entityName: 'user-07', amountCredits: 6000 }),
      cap({ costCenterName: 'Platform', enabled: true, overflow: 'block' }),
    ];
    const desired: ControlState[] = [
      budget({ scope: 'universal', entityName: 'acme', amountCredits: 5000 }),
      budget({ scope: 'individual', entityName: 'user-07', amountCredits: 6000 }),
      cap({ costCenterName: 'Platform', enabled: false, overflow: 'block' }),
    ];
    const plan = diffControls(live, desired);
    const result = applyPlanToControls(live, plan);
    expect([...result].sort((a, b) => controlIdentity(a).localeCompare(controlIdentity(b)))).toEqual(
      [...desired].sort((a, b) => controlIdentity(a).localeCompare(controlIdentity(b))),
    );
  });

  it('is a no-op over an empty plan', () => {
    const live: ControlState[] = [budget(), cap()];
    const plan = diffControls(live, live);
    expect(applyPlanToControls(live, plan)).toEqual(live);
  });
});

// --- Task 4.13: cost-center lifecycle as a control ------------------------

describe('controlIdentity (cost_center)', () => {
  it('keys a cost center by kind:name', () => {
    expect(controlIdentity(costCenter({ name: 'Payments' }))).toBe('cost_center:Payments');
  });

  it('never collides a cost_center with a cap or budget of the same name', () => {
    const id = controlIdentity(costCenter({ name: 'Platform' }));
    expect(id).not.toBe(controlIdentity(cap({ costCenterName: 'Platform' })));
    expect(id).not.toBe(controlIdentity(budget({ scope: 'multi_user_cost_center', entityName: 'Platform' })));
  });
});

describe('diffControls (cost_center)', () => {
  it('emits an add entry for a new cost center', () => {
    const desired = costCenter({ name: 'New Team', members: [] });
    const plan = diffControls([], [desired]);
    expect(plan.entries).toEqual([
      { id: 'cost_center:New Team', controlKind: 'cost_center', action: 'add', name: 'New Team', desired },
    ]);
  });

  it('emits a delete entry for an archived/removed cost center', () => {
    const live = costCenter({ name: 'Old Team' });
    const plan = diffControls([live], []);
    expect(plan.entries).toEqual([
      { id: 'cost_center:Old Team', controlKind: 'cost_center', action: 'delete', name: 'Old Team', live },
    ]);
  });

  it('emits an exact old->new change for the exclude-from-enterprise-budget flag', () => {
    const live = costCenter({ excludedFromEnterpriseBudget: false });
    const desired = costCenter({ excludedFromEnterpriseBudget: true });
    const plan = diffControls([live], [desired]);
    expect(plan.entries).toEqual([
      {
        id: 'cost_center:Platform',
        controlKind: 'cost_center',
        action: 'change',
        name: 'Platform',
        changes: [{ field: 'excludedFromEnterpriseBudget', old: false, new: true }],
      },
    ]);
  });

  it('emits DEWR field changes exactly', () => {
    const live = costCenter({ dewrDivision: 'A', dewrBranch: 'B', dewrProject: 'C' });
    const desired = costCenter({ dewrDivision: 'A2', dewrBranch: 'B', dewrProject: 'C2' });
    const plan = diffControls([live], [desired]);
    expect(plan.entries[0]).toMatchObject({
      controlKind: 'cost_center',
      action: 'change',
      changes: [
        { field: 'dewrDivision', old: 'A', new: 'A2' },
        { field: 'dewrProject', old: 'C', new: 'C2' },
      ],
    });
  });

  it('batches a membership add+remove into one membership change (set-based on type:name)', () => {
    const live = costCenter({ members: [{ type: 'User', name: 'alice' }, { type: 'User', name: 'bob' }] });
    const desired = costCenter({ members: [{ type: 'User', name: 'alice' }, { type: 'User', name: 'carol' }] });
    const plan = diffControls([live], [desired]);
    expect(plan.entries).toEqual([
      {
        id: 'cost_center:Platform',
        controlKind: 'cost_center',
        action: 'change',
        name: 'Platform',
        changes: [{ field: 'membership', added: [{ type: 'User', name: 'carol' }], removed: [{ type: 'User', name: 'bob' }] }],
      },
    ]);
  });

  it('never diffs the included-usage cap prefs from the cost-center control (cap edits are IncludedCapControl only)', () => {
    const live = costCenter({ includedUsageCap: { enabled: false, overflow: 'block' } });
    const desired = costCenter({ includedUsageCap: { enabled: true, overflow: 'metered' } });
    expect(diffControls([live], [desired]).isNoOp).toBe(true);
  });

  it('a 1:1 reassignment across two cost centers produces one removal entry and one addition entry', () => {
    const liveA = costCenter({ name: 'A', members: [{ type: 'User', name: 'mover' }] });
    const liveB = costCenter({ name: 'B', members: [] });
    const desiredA = costCenter({ name: 'A', members: [] });
    const desiredB = costCenter({ name: 'B', members: [{ type: 'User', name: 'mover' }] });
    const plan = diffControls([liveA, liveB], [desiredA, desiredB]);
    // Sorted by id: cost_center:A before cost_center:B.
    expect(plan.entries).toEqual([
      {
        id: 'cost_center:A',
        controlKind: 'cost_center',
        action: 'change',
        name: 'A',
        changes: [{ field: 'membership', added: [], removed: [{ type: 'User', name: 'mover' }] }],
      },
      {
        id: 'cost_center:B',
        controlKind: 'cost_center',
        action: 'change',
        name: 'B',
        changes: [{ field: 'membership', added: [{ type: 'User', name: 'mover' }], removed: [] }],
      },
    ]);
  });
});

describe('applyPlanToControls (cost_center)', () => {
  it('applies a membership add+remove to the post-plan roster', () => {
    const live: ControlState[] = [
      costCenter({ members: [{ type: 'User', name: 'alice' }, { type: 'User', name: 'bob' }] }),
    ];
    const desired: ControlState[] = [
      costCenter({ members: [{ type: 'User', name: 'alice' }, { type: 'User', name: 'carol' }] }),
    ];
    const result = applyPlanToControls(live, diffControls(live, desired));
    const cc = result.find((c): c is CostCenterControl => c.kind === 'cost_center')!;
    expect(cc.members).toEqual([{ type: 'User', name: 'alice' }, { type: 'User', name: 'carol' }]);
  });

  it('recomputes an affected cap limit by +7,000 when a User joins a cap-ON team', () => {
    const live: ControlState[] = [
      costCenter({ name: 'Platform', members: [{ type: 'User', name: 'alice' }] }),
      cap({ costCenterName: 'Platform', computedLimitCredits: 7_000 }),
    ];
    const desired: ControlState[] = [
      costCenter({ name: 'Platform', members: [{ type: 'User', name: 'alice' }, { type: 'User', name: 'bob' }] }),
      cap({ costCenterName: 'Platform', computedLimitCredits: 7_000 }),
    ];
    const result = applyPlanToControls(live, diffControls(live, desired));
    const post = result.find((c): c is IncludedCapControl => c.kind === 'included_cap')!;
    expect(post.computedLimitCredits).toBe(7_000 + INCLUDED_CAP_CREDITS_PER_SEAT);
  });

  it('recomputes an affected cap limit by −7,000 when a User leaves, floored at 0', () => {
    const live: ControlState[] = [
      costCenter({ name: 'Platform', members: [{ type: 'User', name: 'alice' }] }),
      cap({ costCenterName: 'Platform', computedLimitCredits: 7_000 }),
    ];
    const desired: ControlState[] = [
      costCenter({ name: 'Platform', members: [] }),
      cap({ costCenterName: 'Platform', computedLimitCredits: 7_000 }),
    ];
    const result = applyPlanToControls(live, diffControls(live, desired));
    const post = result.find((c): c is IncludedCapControl => c.kind === 'included_cap')!;
    expect(post.computedLimitCredits).toBe(0);
  });

  it('round-trips a cost-center create through diff+apply', () => {
    const desired: ControlState[] = [costCenter({ name: 'Fresh', members: [{ type: 'User', name: 'x' }] })];
    const result = applyPlanToControls([], diffControls([], desired));
    expect(result).toEqual(desired);
  });
});

// Task 4.15: the Controls screen's browse-time drift marker ("⤺ drift —
// reconcile") is derived entirely from this comparator, fed
// (lastSyncedControls, liveControls).
describe('driftedControlIds', () => {
  it('is empty when the two lists are identical', () => {
    const controls: ControlState[] = [budget(), cap()];
    expect(driftedControlIds(controls, controls)).toEqual(new Set());
  });

  it('flags a control whose field changed out-of-band', () => {
    const previous: ControlState[] = [budget({ amountCredits: 6000 })];
    const current: ControlState[] = [budget({ amountCredits: 7000 })];
    expect(driftedControlIds(previous, current)).toEqual(new Set([controlIdentity(budget())]));
  });

  it('flags a control added live since the last sync', () => {
    const previous: ControlState[] = [];
    const current: ControlState[] = [budget({ scope: 'individual', entityName: 'new-hire' })];
    expect(driftedControlIds(previous, current)).toEqual(new Set([controlIdentity(current[0]!)]));
  });

  it('flags a control removed live since the last sync', () => {
    const previous: ControlState[] = [budget()];
    const current: ControlState[] = [];
    expect(driftedControlIds(previous, current)).toEqual(new Set([controlIdentity(budget())]));
  });

  it('never flags a budget purely for BudgetControl.simulatedUiHidden differing (display-only, not diffed)', () => {
    const previous: ControlState[] = [budget({ simulatedUiHidden: true })];
    const current: ControlState[] = [budget()];
    expect(driftedControlIds(previous, current)).toEqual(new Set());
  });

  it('leaves unrelated, unchanged controls out of the drifted set', () => {
    const previous: ControlState[] = [budget({ entityName: 'user-07' }), budget({ scope: 'individual', entityName: 'user-08' })];
    const current: ControlState[] = [
      budget({ entityName: 'user-07', amountCredits: 9999 }),
      budget({ scope: 'individual', entityName: 'user-08' }),
    ];
    expect(driftedControlIds(previous, current)).toEqual(new Set([controlIdentity(budget({ entityName: 'user-07' }))]));
  });
});
