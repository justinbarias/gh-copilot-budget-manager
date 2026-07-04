// CLAUDE.md §5 / PRD §2.1-2.2: two control families -- ULBs (Family A, always
// hard-stop, both phases) and spending limits (Family B, metered-only,
// hard-stop OFF by default) -- plus the one lever, the included-usage cap,
// which is NEVER a settable amount (auto-computed from attributed licenses).
// This module is the pure staged-change model design/README.md §3's Controls
// right rail renders: a Terraform-style desired-vs-live diff (`Plan`) of
// add/change/delete entries, reused verbatim by the write engine (Task 4.8)
// and the rebalancers (Phase 6 -- PLAN.md's "one write-path engine" decision).

// 1 AI credit = $0.01 USD (CLAUDE.md §5) -- division (not `* 0.01`) avoids
// introducing the imprecise 0.01 binary-float constant for typical integer
// credit amounts.
export function creditsToUsd(credits: number): number {
  return credits / 100;
}

// ULB scopes (Family A, always hard-stop, both phases) and spending-limit
// scopes (Family B, metered charges only, hard-stop off by default).
// Deliberately excludes `repository` -- present in the wire budget_scope enum
// (spec §2.1) but not a scope this tool administers per the Phase 4 task
// breakdown; add it additively if a later task needs it.
export type UlbBudgetScope = 'universal' | 'individual' | 'multi_user_cost_center';
export type SpendingLimitScope = 'enterprise' | 'organization' | 'cost_center';
export type BudgetScope = UlbBudgetScope | SpendingLimitScope;

const ULB_BUDGET_SCOPES = new Set<BudgetScope>(['universal', 'individual', 'multi_user_cost_center']);

export function isUlbScope(scope: BudgetScope): scope is UlbBudgetScope {
  return ULB_BUDGET_SCOPES.has(scope);
}

export function isSpendingLimitScope(scope: BudgetScope): scope is SpendingLimitScope {
  return !ULB_BUDGET_SCOPES.has(scope);
}

export type CapOverflow = 'block' | 'metered';

export interface AlertingState {
  willAlert: boolean;
  alertRecipients: readonly string[];
}

// entityName's meaning depends on scope: a user login (individual), a cost
// center name (multi_user_cost_center / cost_center), an org login
// (organization), or the enterprise slug (universal / enterprise) -- mirrors
// the wire budget_entity_name field (spec §2.1), kept generic here since core
// never imports the wire shape.
export interface BudgetControl {
  kind: 'budget';
  scope: BudgetScope;
  entityName: string;
  amountCredits: number;
  preventFurtherUsage: boolean;
  alerting: AlertingState;
}

// The included-usage cap (Lever C, CLAUDE.md §5): `enabled` + `overflow` are
// the ONLY writable fields. `computedLimitCredits` is GitHub-derived from
// attributed licenses and carried here purely for display/simulation math --
// it deliberately has no counterpart in `CapDiffField`/`CapFieldChange`
// below, so no diff entry can ever carry it. That's what makes the cap
// structurally unrepresentable as a grantable/dial-able amount: there is no
// field name a caller could pass to produce a "computedLimitCredits changed"
// entry, and `diffCap` never reads the field at all.
export interface IncludedCapControl {
  kind: 'included_cap';
  costCenterName: string;
  enabled: boolean;
  overflow: CapOverflow;
  /** Read-only. Never diffed, never staged, never appears in a PlanEntry. */
  computedLimitCredits: number;
}

export type ControlState = BudgetControl | IncludedCapControl;

// Stable identity key used to match live <-> desired controls and as the
// deterministic Plan sort key. Prefixed by kind so a `budget:` entry and an
// `included_cap:` entry can never collide even if the human-readable name
// coincides.
export function controlIdentity(control: ControlState): string {
  return control.kind === 'budget'
    ? `budget:${control.scope}:${control.entityName}`
    : `included_cap:${control.costCenterName}`;
}

// --- Diff field types ----------------------------------------------------

export type BudgetDiffField = 'amountCredits' | 'preventFurtherUsage' | 'alerting';
// computedLimitCredits is deliberately absent -- see IncludedCapControl's doc comment.
export type CapDiffField = 'enabled' | 'overflow';

export type BudgetFieldChange =
  | { field: 'amountCredits'; old: number; new: number }
  | { field: 'preventFurtherUsage'; old: boolean; new: boolean }
  | { field: 'alerting'; old: AlertingState; new: AlertingState };

export type CapFieldChange =
  | { field: 'enabled'; old: boolean; new: boolean }
  | { field: 'overflow'; old: CapOverflow; new: CapOverflow };

// --- Plan ------------------------------------------------------------------

export type PlanEntry =
  | {
      id: string;
      controlKind: 'budget';
      action: 'add';
      scope: BudgetScope;
      entityName: string;
      desired: BudgetControl;
    }
  | {
      id: string;
      controlKind: 'budget';
      action: 'delete';
      scope: BudgetScope;
      entityName: string;
      live: BudgetControl;
    }
  | {
      id: string;
      controlKind: 'budget';
      action: 'change';
      scope: BudgetScope;
      entityName: string;
      changes: readonly BudgetFieldChange[];
    }
  | {
      id: string;
      controlKind: 'included_cap';
      action: 'add';
      costCenterName: string;
      desired: IncludedCapControl;
    }
  | {
      id: string;
      controlKind: 'included_cap';
      action: 'delete';
      costCenterName: string;
      live: IncludedCapControl;
    }
  | {
      id: string;
      controlKind: 'included_cap';
      action: 'change';
      costCenterName: string;
      changes: readonly CapFieldChange[];
    };

export interface Plan {
  entries: readonly PlanEntry[];
  /** True iff entries is empty -- the UI's "apply disabled" signal. */
  isNoOp: boolean;
}

function alertingEqual(a: AlertingState, b: AlertingState): boolean {
  return (
    a.willAlert === b.willAlert &&
    a.alertRecipients.length === b.alertRecipients.length &&
    a.alertRecipients.every((r, i) => r === b.alertRecipients[i])
  );
}

function diffBudget(live: BudgetControl, desired: BudgetControl): BudgetFieldChange[] {
  const changes: BudgetFieldChange[] = [];
  if (live.amountCredits !== desired.amountCredits) {
    changes.push({ field: 'amountCredits', old: live.amountCredits, new: desired.amountCredits });
  }
  if (live.preventFurtherUsage !== desired.preventFurtherUsage) {
    changes.push({
      field: 'preventFurtherUsage',
      old: live.preventFurtherUsage,
      new: desired.preventFurtherUsage,
    });
  }
  if (!alertingEqual(live.alerting, desired.alerting)) {
    changes.push({ field: 'alerting', old: live.alerting, new: desired.alerting });
  }
  return changes;
}

// computedLimitCredits is intentionally never read here -- see IncludedCapControl.
function diffCap(live: IncludedCapControl, desired: IncludedCapControl): CapFieldChange[] {
  const changes: CapFieldChange[] = [];
  if (live.enabled !== desired.enabled) {
    changes.push({ field: 'enabled', old: live.enabled, new: desired.enabled });
  }
  if (live.overflow !== desired.overflow) {
    changes.push({ field: 'overflow', old: live.overflow, new: desired.overflow });
  }
  return changes;
}

// Terraform-style desired-vs-live diff (design/README.md §3's right rail: `+`
// add, `~` change with old -> new, `-` delete). Deterministic: entries are
// sorted by their stable identity key regardless of input order, so
// identical inputs always produce a deepEqual plan no matter how live/desired
// were assembled.
export function diffControls(live: readonly ControlState[], desired: readonly ControlState[]): Plan {
  const liveById = new Map(live.map((c) => [controlIdentity(c), c]));
  const desiredById = new Map(desired.map((c) => [controlIdentity(c), c]));
  const allIds = new Set<string>([...liveById.keys(), ...desiredById.keys()]);

  const entries: PlanEntry[] = [];
  for (const id of allIds) {
    const liveControl = liveById.get(id);
    const desiredControl = desiredById.get(id);

    if (!liveControl && desiredControl) {
      entries.push(
        desiredControl.kind === 'budget'
          ? {
              id,
              controlKind: 'budget',
              action: 'add',
              scope: desiredControl.scope,
              entityName: desiredControl.entityName,
              desired: desiredControl,
            }
          : {
              id,
              controlKind: 'included_cap',
              action: 'add',
              costCenterName: desiredControl.costCenterName,
              desired: desiredControl,
            },
      );
      continue;
    }

    if (liveControl && !desiredControl) {
      entries.push(
        liveControl.kind === 'budget'
          ? {
              id,
              controlKind: 'budget',
              action: 'delete',
              scope: liveControl.scope,
              entityName: liveControl.entityName,
              live: liveControl,
            }
          : {
              id,
              controlKind: 'included_cap',
              action: 'delete',
              costCenterName: liveControl.costCenterName,
              live: liveControl,
            },
      );
      continue;
    }

    if (liveControl && desiredControl) {
      // The identity-key prefix bakes in `kind`, so a shared id guarantees
      // matching kinds -- narrow explicitly (rather than casting) so a
      // future third ControlState variant fails to compile here instead of
      // silently mismatching.
      if (liveControl.kind === 'budget' && desiredControl.kind === 'budget') {
        const changes = diffBudget(liveControl, desiredControl);
        if (changes.length > 0) {
          entries.push({
            id,
            controlKind: 'budget',
            action: 'change',
            scope: liveControl.scope,
            entityName: liveControl.entityName,
            changes,
          });
        }
      } else if (liveControl.kind === 'included_cap' && desiredControl.kind === 'included_cap') {
        const changes = diffCap(liveControl, desiredControl);
        if (changes.length > 0) {
          entries.push({
            id,
            controlKind: 'included_cap',
            action: 'change',
            costCenterName: liveControl.costCenterName,
            changes,
          });
        }
      } else {
        throw new Error(`diffControls: control kind mismatch for id ${id}`);
      }
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, isNoOp: entries.length === 0 };
}

function applyBudgetChanges(control: BudgetControl, changes: readonly BudgetFieldChange[]): BudgetControl {
  let next = control;
  for (const change of changes) {
    if (change.field === 'amountCredits') next = { ...next, amountCredits: change.new };
    else if (change.field === 'preventFurtherUsage') next = { ...next, preventFurtherUsage: change.new };
    else next = { ...next, alerting: change.new };
  }
  return next;
}

function applyCapChanges(control: IncludedCapControl, changes: readonly CapFieldChange[]): IncludedCapControl {
  let next = control;
  for (const change of changes) {
    if (change.field === 'enabled') next = { ...next, enabled: change.new };
    else next = { ...next, overflow: change.new };
  }
  return next;
}

// Applies a Plan onto a live control list to produce the post-plan state --
// what `live` becomes after Apply. Shared by validatePlan (post-plan checks
// like the enterprise-cap-below-sum blocker) and simulatePlan (before-vs-
// after blocked-status comparison) so both derive "what would this plan
// change" from one place rather than each re-deriving it.
export function applyPlanToControls(live: readonly ControlState[], plan: Plan): ControlState[] {
  const byId = new Map(live.map((c) => [controlIdentity(c), c]));

  for (const entry of plan.entries) {
    if (entry.action === 'delete') {
      byId.delete(entry.id);
      continue;
    }
    if (entry.action === 'add') {
      byId.set(entry.id, entry.desired);
      continue;
    }
    // action === 'change'
    const current = byId.get(entry.id);
    if (!current) continue; // defensive: a change entry implies live already had this id
    if (entry.controlKind === 'budget' && current.kind === 'budget') {
      byId.set(entry.id, applyBudgetChanges(current, entry.changes));
    } else if (entry.controlKind === 'included_cap' && current.kind === 'included_cap') {
      byId.set(entry.id, applyCapChanges(current, entry.changes));
    }
  }

  return [...byId.values()];
}
