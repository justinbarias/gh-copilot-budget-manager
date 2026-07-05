import { describe, expect, it } from 'vitest';
import { detectUlbRepairCandidates } from './ulbRepair';
import type { BudgetControl, ControlState, UlbBudgetScope } from './controls';

// Task 4.14 (PRD FR3 / CLAUDE.md §5's ULB display-bug domain fact). Inputs
// below are synthetic (abstract shapes, not the DEWR fixture world) so this
// suite documents the DETECTOR's rules in isolation -- the exact
// fixture-derived candidates (liam-obrien / ext-dmorrow) are pinned instead
// in packages/data/src/api-client/ulb-repair.test.ts and
// apps/desktop/e2e/controls-repair.spec.ts, per Task 4.14's build brief.

interface UlbOverrides {
  scope?: UlbBudgetScope;
  entityName?: string;
  amountCredits?: number;
  preventFurtherUsage?: boolean;
  simulatedUiHidden?: boolean;
}

// Builds a BudgetControl (a ControlState) -- detectUlbRepairCandidates takes
// the same getControls() list the UI holds, so the tests feed it real
// ControlState objects and let the detector compute each id via
// controlIdentity (`budget:${scope}:${entityName}`).
function ulb(overrides: UlbOverrides = {}): BudgetControl {
  return {
    kind: 'budget',
    scope: overrides.scope ?? 'individual',
    entityName: overrides.entityName ?? 'user-a',
    amountCredits: overrides.amountCredits ?? 5_000,
    preventFurtherUsage: overrides.preventFurtherUsage ?? true,
    alerting: { willAlert: false, alertRecipients: [] },
    ...(overrides.simulatedUiHidden === undefined ? {} : { simulatedUiHidden: overrides.simulatedUiHidden }),
  };
}

describe('detectUlbRepairCandidates -- the healthy-list negative case', () => {
  // This is how "healthy fixtures show no banner" (Task 4.14's acceptance
  // criterion) is actually verified: the RUNNING app has no healthy-world
  // fixture variant to launch against today (that's Task 6.7's
  // Healthy/At-risk/Surplus scenario selector, not yet built) -- so this
  // unit test is the only place the negative case is exercised until then.
  // Flagged explicitly, not silently assumed.
  it('returns empty for an empty list', () => {
    expect(detectUlbRepairCandidates([])).toEqual([]);
  });

  it('returns empty for a list of ordinary, non-zero, non-hidden ULBs across every scope', () => {
    const controls = [
      ulb({ scope: 'universal', entityName: 'acme', amountCredits: 4_600 }),
      ulb({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 5_200 }),
      ulb({ entityName: 'user-a', amountCredits: 1_900 }),
      ulb({ entityName: 'user-b', amountCredits: 54_00 }),
    ];
    expect(detectUlbRepairCandidates(controls)).toEqual([]);
  });
});

describe('detectUlbRepairCandidates -- non-ULB controls are structurally ignored', () => {
  it('never flags a spending-limit budget, an included-usage cap, or a cost center -- even a $0 hard-stop spending limit', () => {
    const controls: ControlState[] = [
      // A $0 hard-stop ENTERPRISE-scope budget: would look like orphaned_zero
      // if the detector didn't filter by ULB scope first, but it's Family B.
      {
        kind: 'budget',
        scope: 'enterprise',
        entityName: 'dewr',
        amountCredits: 0,
        preventFurtherUsage: true,
        alerting: { willAlert: false, alertRecipients: [] },
      },
      { kind: 'included_cap', costCenterName: 'Platform', enabled: true, overflow: 'block', computedLimitCredits: 70_000 },
      {
        kind: 'cost_center',
        name: 'Platform',
        dewrDivision: 'd',
        dewrBranch: 'b',
        dewrProject: 'p',
        excludedFromEnterpriseBudget: false,
        members: [],
        includedUsageCap: { enabled: true, overflow: 'block' },
      },
    ];
    expect(detectUlbRepairCandidates(controls)).toEqual([]);
  });
});

describe('detectUlbRepairCandidates -- display_bug_hidden', () => {
  it('flags a control carrying the simulatedUiHidden signal, regardless of amount', () => {
    const hidden = ulb({ entityName: 'liam', amountCredits: 5_800, simulatedUiHidden: true });
    const result = detectUlbRepairCandidates([hidden]);
    expect(result).toEqual([
      {
        kind: 'display_bug_hidden',
        id: 'budget:individual:liam',
        scope: 'individual',
        entityName: 'liam',
        reason: expect.stringContaining('invisible'),
      },
    ]);
  });

  it('does not flag a control where simulatedUiHidden is explicitly false or absent', () => {
    const explicit = ulb({ simulatedUiHidden: false });
    const absent = ulb({ entityName: 'user-c' });
    expect(detectUlbRepairCandidates([explicit, absent])).toEqual([]);
  });

  it('classifies a hidden AND $0 control ONLY as display_bug_hidden, never double-counted as orphaned_zero too', () => {
    const hiddenAndZero = ulb({ amountCredits: 0, simulatedUiHidden: true });
    const result = detectUlbRepairCandidates([hiddenAndZero]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('display_bug_hidden');
  });
});

describe('detectUlbRepairCandidates -- orphaned_zero', () => {
  it('flags an exactly-$0 hard-stop individual ULB', () => {
    const zero = ulb({ entityName: 'ext-x', amountCredits: 0 });
    const result = detectUlbRepairCandidates([zero]);
    expect(result).toEqual([
      {
        kind: 'orphaned_zero',
        id: 'budget:individual:ext-x',
        scope: 'individual',
        entityName: 'ext-x',
        reason: expect.stringContaining('$0'),
      },
    ]);
  });

  it('also flags a $0 hard-stop ULB at universal or CCULB scope -- not restricted to individual (PRD §1.4: "accidental $0 universal ULB blocking everyone")', () => {
    const zeroUniversal = ulb({ scope: 'universal', entityName: 'acme', amountCredits: 0 });
    const zeroCculb = ulb({ scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 0 });
    const result = detectUlbRepairCandidates([zeroUniversal, zeroCculb]);
    expect(result.map((c) => c.kind)).toEqual(['orphaned_zero', 'orphaned_zero']);
  });

  it('flags a negative amount defensively too (never valid domain data, mirrors validation.ts negative-amount handling)', () => {
    const negative = ulb({ amountCredits: -5 });
    expect(detectUlbRepairCandidates([negative])).toHaveLength(1);
  });

  it("does NOT flag a near-zero-but-nonzero ULB -- a stricter threshold than validation.ts's $1/100-credit near-zero WARNING, deliberately", () => {
    const nearZero = ulb({ amountCredits: 50 }); // under validation.ts's 100-credit warn threshold, but not $0
    expect(detectUlbRepairCandidates([nearZero])).toEqual([]);
  });

  it("does NOT flag a $0 ULB that is not a hard stop (defensive: real ULBs are always hard-stop per CLAUDE.md §5, but the detector's own criterion is explicit, not assumed)", () => {
    const zeroAlertOnly = ulb({ amountCredits: 0, preventFurtherUsage: false });
    expect(detectUlbRepairCandidates([zeroAlertOnly])).toEqual([]);
  });
});

describe('detectUlbRepairCandidates -- mixed lists', () => {
  it('returns every candidate found, preserving input order, alongside untouched healthy rows', () => {
    const healthy = ulb({ entityName: 'healthy', amountCredits: 4_800 });
    const hidden = ulb({ entityName: 'hidden-one', simulatedUiHidden: true });
    const zero = ulb({ entityName: 'zero-one', amountCredits: 0 });
    const result = detectUlbRepairCandidates([healthy, hidden, zero]);
    expect(result.map((c) => c.id)).toEqual(['budget:individual:hidden-one', 'budget:individual:zero-one']);
    expect(result.map((c) => c.kind)).toEqual(['display_bug_hidden', 'orphaned_zero']);
  });

  it("a mirror of the DEWR fixture world's two edge fixtures (abstracted): exactly 2 candidates out of a larger healthy roster", () => {
    const roster: ControlState[] = [
      ulb({ scope: 'universal', entityName: 'dewr', amountCredits: 4_600 }),
      ulb({ scope: 'multi_user_cost_center', entityName: 'Workforce', amountCredits: 5_200 }),
      ulb({ entityName: 'liam-obrien', amountCredits: 5_800, simulatedUiHidden: true }),
      ulb({ entityName: 'ext-dmorrow', amountCredits: 0 }),
      ulb({ entityName: 'ext-pshah', amountCredits: 1_900 }),
      ulb({ entityName: 'sam-kelly', amountCredits: 5_400 }),
    ];
    const result = detectUlbRepairCandidates(roster);
    expect(result).toHaveLength(2);
    expect(result.map((c) => ({ kind: c.kind, entityName: c.entityName }))).toEqual([
      { kind: 'display_bug_hidden', entityName: 'liam-obrien' },
      { kind: 'orphaned_zero', entityName: 'ext-dmorrow' },
    ]);
  });
});
