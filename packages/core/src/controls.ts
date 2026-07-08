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
  /**
   * DISPLAY-ONLY enrichment, never a diffable/writable field (Task 4.14, PRD
   * FR3). Carries the simulation-only "GitHub's own Budgets UI is hiding this
   * budget from its list view" signal (the display bug, CLAUDE.md §5 / §1.4)
   * so the Controls screen's ULB-repair banner can detect it -- see
   * ulbRepair.ts's detectUlbRepairCandidates. Deliberately absent from
   * BudgetDiffField/BudgetFieldChange, so diffBudget never compares it and it
   * can never enter a Plan or a mutation payload (the write engine builds
   * every request body from named fields, never a spread of this control).
   * Populated only by the live read (packages/data/src/write/live-state.ts's
   * toBudgetControl, from MSW's `simulatedUiHidden` fixture enrichment); a
   * real GitHub response never carries it, so it stays undefined live -- see
   * docs/api-surface-validation.md's "ULB display-bug detection signal" entry
   * for the honest account of why display-bug detection is simulation-only.
   */
  simulatedUiHidden?: boolean;
  /**
   * DISPLAY-ONLY (maintainer-sanctioned optional extension, 2026-07-09 --
   * open item 20): the wire `budget_product_sku` this budget covers (e.g.
   * 'ai_credits'; BundlePricing covers all AI-credit SKUs under that one sku
   * string, machine-verified against the OpenAPI description). Budgets for
   * OTHER products (actions, storage, ...) never reach this model at all --
   * the read boundary excludes them (budget-scope.ts's product filter) so a
   * same-scope/same-entity actions budget can never collide with an
   * AI-credit budget's control identity or pair against AI-credit spend.
   * Same non-diffable contract as simulatedUiHidden above: absent from
   * BudgetDiffField/BudgetFieldChange (diffBudget never compares it), never
   * part of a Plan or mutation payload, stripped from persisted control
   * snapshots by sync-now's stripDisplayOnlyFields.
   */
  productSku?: string;
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

// Task 4.13: the cost center itself as an administrable control. A cost center
// has lifecycle (create / archive-delete), a DEWR financial mapping, an
// exclude-from-enterprise-budget flag, and a membership roster -- all writes,
// so it rides the SAME staged-plan pipeline (diffControls -> validatePlan ->
// simulatePlan -> applyPlan) as budgets/caps, no bespoke write seam. Its
// included-usage cap knobs (enabled/overflow) are carried here ONLY to seed a
// create's POST payload; ongoing cap edits for an *existing* cost center flow
// through IncludedCapControl (Task 4.12), and diffCostCenter deliberately
// never diffs the cap -- so the cap is administered in exactly one place and
// stays structurally non-dial-able (its computed limit is never a control field).
export type CostCenterResourceType = 'User' | 'Org' | 'Repo' | 'EnterpriseTeam';

export interface CostCenterResourceRef {
  type: CostCenterResourceType;
  name: string;
}

export interface CostCenterControl {
  kind: 'cost_center';
  name: string;
  dewrDivision: string;
  dewrBranch: string;
  dewrProject: string;
  excludedFromEnterpriseBudget: boolean;
  /** Every attributed resource (User/Org/Repo/EnterpriseTeam) -- the diff basis for membership add/remove. */
  members: readonly CostCenterResourceRef[];
  /**
   * Initial included-usage-cap prefs, consumed ONLY when this control is
   * created ('add' -> POST /cost-centers payload). For an existing cost
   * center the cap is administered via IncludedCapControl (Task 4.12);
   * diffCostCenter never emits a cap change from here, so these fields are
   * inert on a live control beyond faithfully round-tripping current state.
   */
  includedUsageCap: { enabled: boolean; overflow: CapOverflow };
}

// Promo-enterprise per-seat included-credit funding (CLAUDE.md §5: ~7,000
// credits/seat). The included-usage cap is GitHub-computed as seats × this;
// mirrored here (matching MSW's PROMO_CREDITS_PER_SEAT_ENTERPRISE) so pure
// simulate math can recompute a cap's limit when membership moves shift its
// attributed seat count -- see applyPlanToControls' membership branch. Core
// counts only `User` resources as seats; EnterpriseTeam/Org expansion is an
// upstream (MSW/live) concern the pure layer can't roster, so a membership
// delta of those types leaves the cap limit unchanged in simulate (the real
// recomputed limit still surfaces live via the mutation response).
export const INCLUDED_CAP_CREDITS_PER_SEAT = 7_000;

export type ControlState = BudgetControl | IncludedCapControl | CostCenterControl;

// Stable identity key used to match live <-> desired controls and as the
// deterministic Plan sort key. Prefixed by kind so entries of different kinds
// can never collide even if the human-readable name coincides.
export function controlIdentity(control: ControlState): string {
  switch (control.kind) {
    case 'budget':
      return `budget:${control.scope}:${control.entityName}`;
    case 'included_cap':
      return `included_cap:${control.costCenterName}`;
    case 'cost_center':
      return `cost_center:${control.name}`;
  }
}

function resourceKey(r: CostCenterResourceRef): string {
  return `${r.type}:${r.name}`;
}

// Core counts a `User` resource as one seat; EnterpriseTeam/Org expansion is
// not modeled in the pure layer (see INCLUDED_CAP_CREDITS_PER_SEAT).
function userSeatCount(resources: readonly CostCenterResourceRef[]): number {
  return resources.reduce((n, r) => (r.type === 'User' ? n + 1 : n), 0);
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

// Cost-center 'change' fields. `name` is deliberately absent: the identity
// key is the name, so a rename would present as delete+add, not a change --
// and no Task 4.13 flow renames a live cost center. `membership` batches the
// resource delta (added/removed) in one change; the executor issues removals
// before additions so a 1:1 reassignment never briefly double-attributes a
// resource. The included-usage cap is NOT here (see CostCenterControl).
export type CostCenterFieldChange =
  | { field: 'dewrDivision'; old: string; new: string }
  | { field: 'dewrBranch'; old: string; new: string }
  | { field: 'dewrProject'; old: string; new: string }
  | { field: 'excludedFromEnterpriseBudget'; old: boolean; new: boolean }
  | { field: 'membership'; added: readonly CostCenterResourceRef[]; removed: readonly CostCenterResourceRef[] };

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
    }
  | {
      id: string;
      controlKind: 'cost_center';
      action: 'add';
      name: string;
      desired: CostCenterControl;
    }
  | {
      id: string;
      controlKind: 'cost_center';
      action: 'delete';
      name: string;
      live: CostCenterControl;
    }
  | {
      id: string;
      controlKind: 'cost_center';
      action: 'change';
      name: string;
      changes: readonly CostCenterFieldChange[];
    };

export interface Plan {
  entries: readonly PlanEntry[];
  /** True iff entries is empty -- the UI's "apply disabled" signal. */
  isNoOp: boolean;
}

function alertingEqual(a: AlertingState, b: AlertingState): boolean {
  if (a.willAlert !== b.willAlert) return false;
  if (a.alertRecipients.length !== b.alertRecipients.length) return false;
  // Recipient order is not semantically meaningful (it's a set of notify
  // addresses, not an ordered list), and GitHub does not guarantee a stable
  // order across reads -- comparing position-by-position would manufacture
  // phantom drift ("⤺ drift — reconcile") whenever live and desired hold the
  // same recipients in a different order. Sort both copies before comparing so
  // equality is set-equality over the (already length-checked) arrays.
  const sortedA = [...a.alertRecipients].sort();
  const sortedB = [...b.alertRecipients].sort();
  return sortedA.every((r, i) => r === sortedB[i]);
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

// Membership delta is set-based on (type, name); DEWR/exclude are scalar
// comparisons. includedUsageCap is intentionally never read here -- see
// CostCenterControl's doc comment (cap edits are IncludedCapControl's job).
function diffCostCenter(live: CostCenterControl, desired: CostCenterControl): CostCenterFieldChange[] {
  const changes: CostCenterFieldChange[] = [];
  if (live.dewrDivision !== desired.dewrDivision) {
    changes.push({ field: 'dewrDivision', old: live.dewrDivision, new: desired.dewrDivision });
  }
  if (live.dewrBranch !== desired.dewrBranch) {
    changes.push({ field: 'dewrBranch', old: live.dewrBranch, new: desired.dewrBranch });
  }
  if (live.dewrProject !== desired.dewrProject) {
    changes.push({ field: 'dewrProject', old: live.dewrProject, new: desired.dewrProject });
  }
  if (live.excludedFromEnterpriseBudget !== desired.excludedFromEnterpriseBudget) {
    changes.push({
      field: 'excludedFromEnterpriseBudget',
      old: live.excludedFromEnterpriseBudget,
      new: desired.excludedFromEnterpriseBudget,
    });
  }
  const liveKeys = new Set(live.members.map(resourceKey));
  const desiredKeys = new Set(desired.members.map(resourceKey));
  const added = desired.members.filter((r) => !liveKeys.has(resourceKey(r)));
  const removed = live.members.filter((r) => !desiredKeys.has(resourceKey(r)));
  if (added.length > 0 || removed.length > 0) {
    changes.push({ field: 'membership', added, removed });
  }
  return changes;
}

function buildAddEntry(id: string, desired: ControlState): PlanEntry {
  switch (desired.kind) {
    case 'budget':
      return { id, controlKind: 'budget', action: 'add', scope: desired.scope, entityName: desired.entityName, desired };
    case 'included_cap':
      return { id, controlKind: 'included_cap', action: 'add', costCenterName: desired.costCenterName, desired };
    case 'cost_center':
      return { id, controlKind: 'cost_center', action: 'add', name: desired.name, desired };
  }
}

function buildDeleteEntry(id: string, live: ControlState): PlanEntry {
  switch (live.kind) {
    case 'budget':
      return { id, controlKind: 'budget', action: 'delete', scope: live.scope, entityName: live.entityName, live };
    case 'included_cap':
      return { id, controlKind: 'included_cap', action: 'delete', costCenterName: live.costCenterName, live };
    case 'cost_center':
      return { id, controlKind: 'cost_center', action: 'delete', name: live.name, live };
  }
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
      entries.push(buildAddEntry(id, desiredControl));
      continue;
    }

    if (liveControl && !desiredControl) {
      entries.push(buildDeleteEntry(id, liveControl));
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
      } else if (liveControl.kind === 'cost_center' && desiredControl.kind === 'cost_center') {
        const changes = diffCostCenter(liveControl, desiredControl);
        if (changes.length > 0) {
          entries.push({ id, controlKind: 'cost_center', action: 'change', name: liveControl.name, changes });
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

function membershipDelta(changes: readonly CostCenterFieldChange[]): Extract<CostCenterFieldChange, { field: 'membership' }> | undefined {
  return changes.find((c): c is Extract<CostCenterFieldChange, { field: 'membership' }> => c.field === 'membership');
}

function applyCostCenterChanges(control: CostCenterControl, changes: readonly CostCenterFieldChange[]): CostCenterControl {
  let next = control;
  for (const change of changes) {
    switch (change.field) {
      case 'dewrDivision':
        next = { ...next, dewrDivision: change.new };
        break;
      case 'dewrBranch':
        next = { ...next, dewrBranch: change.new };
        break;
      case 'dewrProject':
        next = { ...next, dewrProject: change.new };
        break;
      case 'excludedFromEnterpriseBudget':
        next = { ...next, excludedFromEnterpriseBudget: change.new };
        break;
      case 'membership': {
        const removedKeys = new Set(change.removed.map(resourceKey));
        const kept = next.members.filter((r) => !removedKeys.has(resourceKey(r)));
        next = { ...next, members: [...kept, ...change.added] };
        break;
      }
    }
  }
  return next;
}

// Task 4.15: browse-time drift detection (Controls screen row markers) --
// deliberately built on diffControls, the SAME comparator applyPlan's §6.2
// apply-time drift-abort and the Controls rail's staged-vs-live diff both
// use, rather than a bespoke equality check. `previous` is the last-synced
// (persisted, append-only) control snapshot; `current` is a fresh live read
// -- any id diffControls would emit an add/change/delete entry for is
// "drifted": live moved out-of-band since the last explicit Sync Now.
// BudgetControl.simulatedUiHidden safely never causes a false-positive here:
// diffBudget's field list deliberately excludes it (see that field's own doc
// comment), so a control present-with-the-flag on one side and
// absent-without-it on the other still compares equal.
export function driftedControlIds(previous: readonly ControlState[], current: readonly ControlState[]): ReadonlySet<string> {
  return new Set(diffControls(previous, current).entries.map((entry) => entry.id));
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
    } else if (entry.controlKind === 'cost_center' && current.kind === 'cost_center') {
      byId.set(entry.id, applyCostCenterChanges(current, entry.changes));
      // A membership move shifts the cost center's attributed seats, so its
      // GitHub-computed included-usage cap limit shifts by ±7,000/seat (only
      // `User` seats are modeled in the pure layer -- see INCLUDED_CAP_
      // CREDITS_PER_SEAT). This keeps post-plan cap governance honest in
      // simulate: a member joining a cap-ON team lifts that team's ceiling,
      // a member leaving lowers it. computedLimitCredits is never a diffable
      // control field, so mutating it here can never produce a phantom plan
      // entry -- it only feeds the after-state block/headroom math.
      const membership = membershipDelta(entry.changes);
      if (membership) {
        const capId = `included_cap:${entry.name}`;
        const cap = byId.get(capId);
        if (cap && cap.kind === 'included_cap') {
          const seatDelta = userSeatCount(membership.added) - userSeatCount(membership.removed);
          if (seatDelta !== 0) {
            byId.set(capId, {
              ...cap,
              computedLimitCredits: Math.max(0, cap.computedLimitCredits + seatDelta * INCLUDED_CAP_CREDITS_PER_SEAT),
            });
          }
        }
      }
    }
  }

  return [...byId.values()];
}
