import {
  applyPlanToControls,
  creditsToUsd,
  type BudgetControl,
  type BudgetScope,
  type CapFieldChange,
  type CapOverflow,
  type ControlState,
  type IncludedCapControl,
  type Plan,
} from './controls.js';
import { resolveEffectiveUlb, type UlbCandidate } from './ulb.js';

// CLAUDE.md §6.1's engine ("no write without simulate-before-apply") -- v1,
// deterministic, no forecast (Phase 6 upgrades this additively; see
// SimulationForecastInput below). Given a staged Plan and a point-in-time
// usage snapshot, computes who newly blocks/unblocks as a *result of the
// plan's control changes* (not general pool-exhaustion routing, which is
// poolAllowance.ts/burndown.ts's concern), plus per-scope credit/$ deltas.

export interface UserUsage {
  userLogin: string;
  /** Cost-center membership, for CCULB + included-cap resolution; null if unassigned. */
  costCenterName: string | null;
  /** Cycle-to-date pool draw, in credits. */
  poolCreditsUsed: number;
  /**
   * Cycle-to-date metered spend, in credits. A value > 0 is this v1's signal
   * that the user has already tipped into the metered phase (metered charges
   * only accrue after the pool is exhausted) -- there is no separate
   * "current phase" input.
   */
  meteredCreditsUsed: number;
}

export interface CostCenterUsage {
  costCenterName: string;
  /** Cycle-to-date aggregate pool draw attributed to this cost center. */
  poolCreditsUsed: number;
  /** Cycle-to-date aggregate metered spend attributed to this cost center. */
  meteredCreditsUsed: number;
}

export interface EnterpriseUsage {
  entityName: string;
  /** Cycle-to-date enterprise-wide metered spend, in credits. */
  meteredCreditsUsed: number;
}

export interface UsageState {
  enterprise: EnterpriseUsage;
  users: readonly UserUsage[];
  costCenters: readonly CostCenterUsage[];
}

/**
 * Reserved for the Phase 6 upgrade (PLAN.md Task 4.6: "the interface takes an
 * optional forecast input from day one so the upgrade is additive"). Phase 6
 * replaces this v1's "at current consumption" snapshot with forecasted
 * end-of-cycle projections. Accepting the shape now means simulatePlan's
 * signature never changes -- Phase 6 only starts reading it. Deliberately
 * unused by this v1 implementation.
 */
export interface SimulationForecastInput {
  projectedEndOfCycleCreditsUsedByUser: Readonly<Record<string, number>>;
  projectedEndOfCycleCreditsUsedByCostCenter: Readonly<Record<string, number>>;
  cycleEndDate: Date;
}

export type BindingConstraintKind = 'ulb' | 'included_cap' | 'spending_limit';

export interface UserBlockStatus {
  userLogin: string;
  blockedBefore: boolean;
  blockedAfter: boolean;
  /** Which lever is binding post-plan; null when not blocked. */
  bindingConstraintAfter: BindingConstraintKind | null;
}

export type CreditDeltaKind = 'ulb' | 'spending_limit';

// Only enterprise/cost-center-scoped budget changes roll up to a ScopeDelta
// (per CLAUDE.md Task 4.6: "pool-draw and metered-spend deltas ... per scope
// (enterprise/CC)"). `kind: 'ulb'` deltas come from universal/CCULB amount
// changes (pool-phase capacity); `kind: 'spending_limit'` deltas come from
// enterprise/cost-center spending-limit amount changes (metered-phase
// capacity). Individual ULBs and organization-scope spending limits affect
// blocked/unblocked status but are deliberately excluded from this rollup.
export interface ScopeDelta {
  scope: 'enterprise' | 'cost_center';
  entityName: string;
  kind: CreditDeltaKind;
  /** new - old (or -old for delete, +new for add). Positive = capacity increases. */
  deltaCredits: number;
  deltaUsd: number;
}

// The included-usage cap is never a credits amount (CLAUDE.md §5) -- its
// delta is qualitative (enabled/overflow flips), never a number.
export interface CapToggleDelta {
  costCenterName: string;
  enabledChange?: { old: boolean; new: boolean };
  overflowChange?: { old: CapOverflow; new: CapOverflow };
}

export interface SimulationSummary {
  newlyBlockedCount: number;
  newlyUnblockedCount: number;
  totalPoolCapacityDeltaCredits: number;
  totalMeteredCapacityDeltaCredits: number;
  totalPoolCapacityDeltaUsd: number;
  totalMeteredCapacityDeltaUsd: number;
}

export interface SimulationResult {
  /** Sorted ascending; the design rail's "newly blocked (red)" count/list. */
  newlyBlockedUserLogins: readonly string[];
  /** Sorted ascending; the design rail's "newly unblocked (green)" count/list. */
  newlyUnblockedUserLogins: readonly string[];
  /** Full before/after detail per user -- richer than the two lists above, for reuse by Phase 6's binding-constraint resolver. */
  userBlockStatus: readonly UserBlockStatus[];
  scopeDeltas: readonly ScopeDelta[];
  capToggleDeltas: readonly CapToggleDelta[];
  summary: SimulationSummary;
}

function budgetControls(controls: readonly ControlState[]): BudgetControl[] {
  return controls.filter((c): c is BudgetControl => c.kind === 'budget');
}

function capControls(controls: readonly ControlState[]): IncludedCapControl[] {
  return controls.filter((c): c is IncludedCapControl => c.kind === 'included_cap');
}

function toUlbCandidates(controls: readonly ControlState[]): UlbCandidate[] {
  return budgetControls(controls)
    .filter(
      (b): b is BudgetControl & { scope: UlbCandidate['scope'] } =>
        b.scope === 'universal' || b.scope === 'individual' || b.scope === 'multi_user_cost_center',
    )
    .map((b) => ({ scope: b.scope, entityName: b.entityName, amountCredits: b.amountCredits }));
}

function capByCostCenter(controls: readonly ControlState[]): Map<string, IncludedCapControl> {
  return new Map(capControls(controls).map((c) => [c.costCenterName, c]));
}

function findBudget(
  controls: readonly ControlState[],
  scope: 'enterprise' | 'cost_center',
  entityName: string,
): BudgetControl | undefined {
  return budgetControls(controls).find((b) => b.scope === scope && b.entityName === entityName);
}

interface Candidate {
  kind: BindingConstraintKind;
  headroomCredits: number;
  canBlock: boolean;
}

// Lowest-remaining-headroom-wins (CLAUDE.md §5) among the user's effective
// ULB, their cost center's included-usage cap (if a member and enabled), and
// applicable spending limits (their cost center's and the enterprise's) --
// but only levers that can actually *block* determine `blocked`: a ULB
// always can (both phases, always hard-stop, CLAUDE.md §5); the cap only
// when overflow='block' (overflow='metered' re-routes rather than stopping
// usage -- see the capBound fixture convention this mirrors); a spending
// limit only once the entity has tipped into metered (meteredCreditsUsed >
// 0) AND its own hard-stop flag is on (spending limits default to alert-only,
// CLAUDE.md §5).
//
// Known v1 limitation: a user who has *just* tipped into metered with
// meteredCreditsUsed still at 0 (e.g. a $0 hard-stop metered spending limit)
// isn't detected as bound by that limit -- distinguishing "in the metered
// phase with 0 spent so far" from "still in the pool phase" needs
// pool-allowance/exhaustion data this v1 deliberately doesn't take as input.
//
// Known v1 limitation (org spending limits): the `organization`-scope
// spending limit (a real Family-B control this tool administers, PRD §2.1) is
// deliberately NOT resolved as a per-user binding constraint here -- doing so
// needs a user->org mapping and per-org metered aggregate that UsageState/
// UserUsage don't carry. Org-limit blocking is owned by Phase 6's
// binding-constraint resolver (PLAN.md Task 6.1, which explicitly lists
// cost-center/org/enterprise spending limits) once that usage attribution
// exists. v1 resolves the two spending limits it *can* attribute: the user's
// cost-center limit and the enterprise-wide limit.
function resolveUserBlockStatus(
  user: UserUsage,
  usage: UsageState,
  controls: readonly ControlState[],
): { blocked: boolean; bindingConstraint: BindingConstraintKind | null } {
  const effectiveUlb = resolveEffectiveUlb(user.userLogin, user.costCenterName, toUlbCandidates(controls));
  const totalUsedCredits = user.poolCreditsUsed + user.meteredCreditsUsed;

  const candidates: Candidate[] = [];

  if (effectiveUlb) {
    candidates.push({ kind: 'ulb', headroomCredits: effectiveUlb.amountCredits - totalUsedCredits, canBlock: true });
  }

  const costCenterUsage = user.costCenterName
    ? usage.costCenters.find((cc) => cc.costCenterName === user.costCenterName)
    : undefined;
  const cap = user.costCenterName ? capByCostCenter(controls).get(user.costCenterName) : undefined;
  if (cap?.enabled && costCenterUsage) {
    candidates.push({
      kind: 'included_cap',
      headroomCredits: cap.computedLimitCredits - costCenterUsage.poolCreditsUsed,
      canBlock: cap.overflow === 'block',
    });
  }

  if (user.meteredCreditsUsed > 0) {
    if (costCenterUsage) {
      const ccBudget = findBudget(controls, 'cost_center', costCenterUsage.costCenterName);
      if (ccBudget) {
        candidates.push({
          kind: 'spending_limit',
          headroomCredits: ccBudget.amountCredits - costCenterUsage.meteredCreditsUsed,
          canBlock: ccBudget.preventFurtherUsage,
        });
      }
    }
    const entBudget = findBudget(controls, 'enterprise', usage.enterprise.entityName);
    if (entBudget) {
      candidates.push({
        kind: 'spending_limit',
        headroomCredits: entBudget.amountCredits - usage.enterprise.meteredCreditsUsed,
        canBlock: entBudget.preventFurtherUsage,
      });
    }
  }

  const blocking = candidates.filter((c) => c.canBlock && c.headroomCredits <= 0);
  if (blocking.length === 0) return { blocked: false, bindingConstraint: null };

  // Among the levers that are actually exceeded and can block, the one with
  // the lowest (most negative) remaining headroom is reported as binding.
  const binding = blocking.reduce((lowest, c) => (c.headroomCredits < lowest.headroomCredits ? c : lowest));
  return { blocked: true, bindingConstraint: binding.kind };
}

function toScopeDeltaTarget(
  scope: BudgetScope,
  entityName: string,
): { scope: 'enterprise' | 'cost_center'; entityName: string; kind: CreditDeltaKind } | null {
  switch (scope) {
    case 'enterprise':
      return { scope: 'enterprise', entityName, kind: 'spending_limit' };
    case 'cost_center':
      return { scope: 'cost_center', entityName, kind: 'spending_limit' };
    case 'universal':
      return { scope: 'enterprise', entityName, kind: 'ulb' };
    case 'multi_user_cost_center':
      return { scope: 'cost_center', entityName, kind: 'ulb' };
    default:
      // organization and individual scopes are excluded from the v1 scope-delta rollup.
      return null;
  }
}

function computeScopeDeltas(plan: Plan): ScopeDelta[] {
  const deltas: ScopeDelta[] = [];
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'budget') continue;
    const target = toScopeDeltaTarget(entry.scope, entry.entityName);
    if (!target) continue;

    let deltaCredits: number | null = null;
    if (entry.action === 'add') deltaCredits = entry.desired.amountCredits;
    else if (entry.action === 'delete') deltaCredits = -entry.live.amountCredits;
    else {
      const amountChange = entry.changes.find((c) => c.field === 'amountCredits');
      if (amountChange) deltaCredits = amountChange.new - amountChange.old;
    }

    if (deltaCredits !== null && deltaCredits !== 0) {
      deltas.push({ ...target, deltaCredits, deltaUsd: creditsToUsd(deltaCredits) });
    }
  }
  return deltas;
}

function isEnabledChange(c: CapFieldChange): c is Extract<CapFieldChange, { field: 'enabled' }> {
  return c.field === 'enabled';
}

function isOverflowChange(c: CapFieldChange): c is Extract<CapFieldChange, { field: 'overflow' }> {
  return c.field === 'overflow';
}

function computeCapToggleDeltas(plan: Plan): CapToggleDelta[] {
  const deltas: CapToggleDelta[] = [];
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'included_cap' || entry.action !== 'change') continue;

    const enabledChange = entry.changes.find(isEnabledChange);
    const overflowChange = entry.changes.find(isOverflowChange);
    if (!enabledChange && !overflowChange) continue;

    deltas.push({
      costCenterName: entry.costCenterName,
      ...(enabledChange ? { enabledChange: { old: enabledChange.old, new: enabledChange.new } } : {}),
      ...(overflowChange ? { overflowChange: { old: overflowChange.old, new: overflowChange.new } } : {}),
    });
  }
  return deltas;
}

function sumDeltaCredits(deltas: readonly ScopeDelta[], kind: CreditDeltaKind): number {
  return deltas.filter((d) => d.kind === kind).reduce((sum, d) => sum + d.deltaCredits, 0);
}

// Task 4.13 -- membership-move depth (the honest subset, boundary documented
// on simulatePlan below). Folds every cost_center membership change in the
// plan into a login -> new-cost-center map: an added `User` resource re-homes
// that login to the entry's cost center; a removed one tentatively unassigns
// (null) unless a later addition re-homes them (a 1:1 reassignment is exactly
// remove-from-A + add-to-B, so the login lands on B). The guard on removals
// makes the result order-independent, matching diffControls' stable ordering.
function membershipMovesByLogin(plan: Plan): Map<string, string | null> {
  const moves = new Map<string, string | null>();
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'cost_center' || entry.action !== 'change') continue;
    for (const change of entry.changes) {
      if (change.field !== 'membership') continue;
      for (const r of change.removed) {
        if (r.type === 'User' && !moves.has(r.name)) moves.set(r.name, null);
      }
      for (const r of change.added) {
        if (r.type === 'User') moves.set(r.name, entry.name);
      }
    }
  }
  return moves;
}

export function simulatePlan(
  plan: Plan,
  usageState: UsageState,
  controlsState: readonly ControlState[],
  asOfDate: Date,
  forecast?: SimulationForecastInput,
): SimulationResult {
  // v1 is a deterministic point-in-time snapshot (no projection): asOfDate is
  // threaded through per the "no Date.now(), asOfDate explicit" convention,
  // and `forecast` is accepted but unused -- see SimulationForecastInput.
  void asOfDate;
  void forecast;

  // applyPlanToControls already folds cost_center membership moves into the
  // post-plan control set -- notably recomputing an affected cost center's
  // included-usage cap limit by ±7,000/seat moved (see controls.ts). Task
  // 4.13 membership-move depth (the honest subset): a mover is re-homed to
  // their NEW cost center for the AFTER block/unblock resolution, so a move
  // that changes which CCULB governs them (or which cap applies) is reflected.
  //
  // Documented boundary (kept surgical -- simulate.ts is shared with Task
  // 6.4): a mover's own cycle-to-date POOL DRAW is NOT re-attributed between
  // the two cost centers' aggregates (usageState.costCenters stays as read),
  // so a cap's *headroom* uses the recomputed limit against the pre-move CC
  // aggregate draw. Full pool-draw re-attribution needs per-user-per-CC draw
  // the UsageState doesn't carry; that fidelity is left for a later pass.
  const postPlanControls = applyPlanToControls(controlsState, plan);
  const moves = membershipMovesByLogin(plan);

  const userBlockStatus: UserBlockStatus[] = usageState.users
    .map((user) => {
      const before = resolveUserBlockStatus(user, usageState, controlsState);
      const afterUser = moves.has(user.userLogin)
        ? { ...user, costCenterName: moves.get(user.userLogin) ?? null }
        : user;
      const after = resolveUserBlockStatus(afterUser, usageState, postPlanControls);
      return {
        userLogin: user.userLogin,
        blockedBefore: before.blocked,
        blockedAfter: after.blocked,
        bindingConstraintAfter: after.bindingConstraint,
      };
    })
    .sort((a, b) => a.userLogin.localeCompare(b.userLogin));

  const newlyBlockedUserLogins = userBlockStatus
    .filter((u) => u.blockedAfter && !u.blockedBefore)
    .map((u) => u.userLogin);
  const newlyUnblockedUserLogins = userBlockStatus
    .filter((u) => !u.blockedAfter && u.blockedBefore)
    .map((u) => u.userLogin);

  const scopeDeltas = computeScopeDeltas(plan);
  const capToggleDeltas = computeCapToggleDeltas(plan);

  const totalPoolCapacityDeltaCredits = sumDeltaCredits(scopeDeltas, 'ulb');
  const totalMeteredCapacityDeltaCredits = sumDeltaCredits(scopeDeltas, 'spending_limit');

  return {
    newlyBlockedUserLogins,
    newlyUnblockedUserLogins,
    userBlockStatus,
    scopeDeltas,
    capToggleDeltas,
    summary: {
      newlyBlockedCount: newlyBlockedUserLogins.length,
      newlyUnblockedCount: newlyUnblockedUserLogins.length,
      totalPoolCapacityDeltaCredits,
      totalMeteredCapacityDeltaCredits,
      totalPoolCapacityDeltaUsd: creditsToUsd(totalPoolCapacityDeltaCredits),
      totalMeteredCapacityDeltaUsd: creditsToUsd(totalMeteredCapacityDeltaCredits),
    },
  };
}
