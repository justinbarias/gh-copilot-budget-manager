import { type CapOverflow, type ControlState, type BudgetControl, type IncludedCapControl, type CostCenterControl } from './controls.js';
import { resolveEffectiveUlb, type UlbCandidate, type UlbScope } from './ulb.js';
import { type CostCenterUsage, type UsageState, type UserUsage } from './simulate.js';

// ============================================================================
// Task 6.1 -- binding-constraint resolver (CLAUDE.md §5, PRD §4.4).
//
// For each entity (a user or a cost center) this resolves the *binding
// constraint*: the applicable control with the LOWEST REMAINING HEADROOM across
//   - the most-specific applicable ULB (individual > CCULB > universal),
//   - the included-usage cap (cost-center entities, POOL phase only),
//   - cost-center / org / enterprise spending limits (METERED phase only),
// and classifies it into a discriminated union that ENCODES THE REMEDIATION SET:
//   - `ulb-bound`    -> GRANTABLE   (carries the grant lever a Phase-6 allocator
//                                    raises; §5 pool-phase redistribution rules),
//   - `cap-bound`    -> RELAX-ONLY  (carries relax options; STRUCTURALLY has no
//                                    grantable-delta field -- the type makes a
//                                    grant on a cap unrepresentable, per §5),
//   - `budget-bound` -> metered spending limit (grantable by raising that limit).
//
// This is the shared first step of both rebalancers (PRD §4.4: "detect trigger
// -> size envelope -> RESOLVE BINDING CONSTRAINT -> allocate -> simulate -> apply
// most-specific lever"). Tasks 6.2/6.3 (pool) and 6.5/6.6 (metered) consume this
// module's exported type surface, so it is a CONTRACT -- see the doc comments.
//
// PURE (CLAUDE.md §2 portability rule): no I/O, no wall-clock. Resolution is
// pure headroom arithmetic over the passed usage snapshot(s); there is no date
// input because none of the math depends on the calendar (the *forecast* that
// produces `projectedUsage` is forecast.ts's concern, which does take asOfDate).
//
// --------------------------------------------------------------------------
// PRECEDENCE vs LOWEST-HEADROOM -- the subtle bit the engine builders code
// against, stated once, here:
//
//   1. ULB PRECEDENCE (most-specific-wins) decides WHICH ULB *applies* to a
//      user: individual > CCULB > universal. This is APPLICABILITY, not a min
//      over ULB amounts. If a user has an individual override, THAT is their
//      ULB even when a CCULB or universal ULB has less remaining headroom -- the
//      less-specific ULBs are not candidates at all (see resolveEffectiveUlb).
//
//   2. LOWEST-REMAINING-HEADROOM-WINS operates ACROSS control FAMILIES: the one
//      applicable ULB (already chosen by precedence) vs the cap vs the spending
//      limit. Among those cross-family candidates, the least remaining headroom
//      is the binding constraint.
//
//   So: precedence collapses the three ULB scopes to ONE candidate; then that
//   candidate competes against the cap/budget candidates on headroom. A user
//   with an applicable ULB (headroom 800) whose cost-center cap has headroom 300
//   is CAP-BOUND (relax-only) -- the cap binds first, and no ULB grant helps.
// ============================================================================

/** Which billing phase the resolution is for. Governs the candidate set. */
export type Phase = 'pool' | 'metered';

/** FR6/FR11 default at-risk threshold: at or above 95% of the binding constraint. */
export const AT_RISK_THRESHOLD_PCT = 0.95;

// ---------------------------------------------------------------------------
// Entity identity
// ---------------------------------------------------------------------------

/** The thing whose binding constraint we resolve: a user, or a cost center. */
export type EntityRef =
  | { readonly kind: 'user'; readonly userLogin: string; readonly costCenterName: string | null }
  | { readonly kind: 'cost_center'; readonly costCenterName: string };

// ---------------------------------------------------------------------------
// Grant levers (ULB-bound remediation) -- CLAUDE.md §5 pool-phase rules
// ---------------------------------------------------------------------------

/**
 * The surgical, precedence-winning lever: an individual ULB override on ONE
 * user (raises only that person's ceiling; wins precedence over any CCULB /
 * universal ULB). This is 6.3's default lever ("individual ULB override by
 * default"). `userLogin` is the user to override.
 */
export interface IndividualOverrideLever {
  readonly kind: 'individual_override';
  readonly userLogin: string;
}

/**
 * The blunt lever: raise the cost center's CCULB, lifting EVERY member's
 * per-user ceiling uniformly (CLAUDE.md §5). 6.3 uses this "only for uniform
 * team lifts"; it is offered as the alternative to the surgical override.
 */
export interface CculbLiftLever {
  readonly kind: 'cculb_lift';
  readonly costCenterName: string;
}

// ---------------------------------------------------------------------------
// The binding-constraint discriminated union (THE contract)
// ---------------------------------------------------------------------------

/**
 * GRANTABLE. The binding constraint is the user's effective ULB (a hard stop in
 * both phases, CLAUDE.md §5). A Phase-6 allocator can hand this entity a delta
 * by raising the ULB via the most-specific lever.
 */
export interface UlbBound {
  readonly type: 'ulb-bound';
  /** Which ULB scope currently APPLIES (precedence winner). Also the UI's
   *  "converts from" label when an individual override is granted. */
  readonly ulbScope: UlbScope;
  /** The effective ULB amount (the precedence winner's amount). */
  readonly limitCredits: number;
  /** The user's basis usage: total pool + metered draw (a ULB caps the total). */
  readonly usedCredits: number;
  /** limitCredits - usedCredits. May be <= 0 (blocked / a $0-ULB block). */
  readonly remainingHeadroomCredits: number;
  /**
   * The recommended most-specific grant lever (CLAUDE.md §5): a surgical,
   * precedence-winning individual override on THIS user. Default for 6.3.
   */
  readonly grantLever: IndividualOverrideLever;
  /**
   * The blunt team-wide alternative, present whenever the user belongs to a
   * cost center (a CCULB lift is possible); null for unassigned users. 6.3 uses
   * `grantLever` by default and `cculbLiftAlternative` only for uniform lifts.
   */
  readonly cculbLiftAlternative: CculbLiftLever | null;
}

/** The remediation moves available for a cap-bound entity (§5: relax, never grant). */
export type CapRelaxOption = 'disable_cap' | 'overflow_to_metered' | 'reattribute_licenses';

/**
 * RELAX-ONLY. The binding constraint is a cost center's included-usage cap. Per
 * CLAUDE.md §5 the cap is NEVER a grantable/settable amount (its limit is
 * GitHub-computed from attributed licenses); the only moves are relax options.
 *
 * STRUCTURAL GUARANTEE (acceptance criterion): this interface has NO `delta`,
 * no `grantCredits`, no settable-amount field of any kind -- a reviewer can
 * point at this definition as proof that a grantable delta on a cap is
 * unrepresentable. `computedLimitCredits` is read-only (mirrors
 * IncludedCapControl's non-diffable field); `relaxOptions` are qualitative.
 */
export interface CapBound {
  readonly type: 'cap-bound';
  readonly costCenterName: string;
  readonly capEnabled: boolean;
  readonly capOverflow: CapOverflow;
  /** Read-only, GitHub-derived (licenses x per-seat). Never a settable amount. */
  readonly computedLimitCredits: number;
  /** The cost center's aggregate pool draw -- the cap's basis usage. */
  readonly poolDrawCredits: number;
  /** computedLimitCredits - poolDrawCredits. May be <= 0 (cap hit). */
  readonly remainingHeadroomCredits: number;
  /** The relax moves (disable / overflow->metered / re-attribute). No delta. */
  readonly relaxOptions: readonly CapRelaxOption[];
}

/**
 * GRANTABLE (metered phase). The binding constraint is a spending limit
 * (cost-center / org / enterprise budget). A metered rebalancer raises THIS one
 * limit. `hardStop` mirrors `preventFurtherUsage` -- spending limits are
 * alert-only by default (CLAUDE.md §5), so a bound-but-not-hard-stopping limit
 * is reported here with `hardStop: false` for the consumer to weigh.
 *
 * NOTE (org scope): `organization` is in the type for completeness (PRD §2.1
 * lists cc/org/enterprise), but this resolver does not yet EMIT org-bound
 * results -- UsageState carries no user->org mapping or per-org metered
 * aggregate (same boundary simulate.ts documents). Org resolution lands when
 * that attribution exists; the type is ready for it.
 */
export interface BudgetBound {
  readonly type: 'budget-bound';
  readonly spendingLimitScope: 'cost_center' | 'organization' | 'enterprise';
  readonly entityName: string;
  readonly limitCredits: number;
  /** The metered draw the limit is measured against (entity-appropriate aggregate). */
  readonly meteredUsedCredits: number;
  /** limitCredits - meteredUsedCredits. */
  readonly remainingHeadroomCredits: number;
  /** preventFurtherUsage: whether this limit actually hard-stops (vs alert-only). */
  readonly hardStop: boolean;
}

export type BindingConstraint = UlbBound | CapBound | BudgetBound;

// ---------------------------------------------------------------------------
// At-risk determination
// ---------------------------------------------------------------------------

export type AtRiskLevel = 'ok' | 'at-risk' | 'blocked';

export interface AtRiskStatus {
  readonly level: AtRiskLevel;
  /** true for both 'at-risk' and 'blocked' (FR6/FR11 "at-risk entity"). */
  readonly atRisk: boolean;
  /** true iff already AT OR OVER the binding constraint (remaining headroom <= 0). */
  readonly blocked: boolean;
  /** used / limit against the binding constraint (Infinity for a $0-limit with usage). */
  readonly utilization: number;
  /** The threshold this determination used (default AT_RISK_THRESHOLD_PCT). */
  readonly thresholdPct: number;
}

/** A binding constraint plus how at-risk the entity is against it, on one usage basis. */
export interface BindingResolution {
  /** null when NO control applies to the entity in this phase (unconstrained). */
  readonly binding: BindingConstraint | null;
  readonly status: AtRiskStatus;
}

/** An entity's binding constraint on the current basis and (optionally) the projected basis. */
export interface EntityBindingResolution {
  readonly entity: EntityRef;
  /** Resolution against current cycle-to-date usage (the UI badge basis). */
  readonly current: BindingResolution;
  /** Resolution against projected end-of-cycle usage; null iff no projection
   *  was supplied. The trigger logic in 6.2/6.5 ranks on THIS. */
  readonly projected: BindingResolution | null;
}

/** The context every resolution reads. current + optional projected usage share
 *  one shape (UsageState, from simulate.ts) so the resolver runs identically on
 *  either basis. */
export interface BindingConstraintContext {
  readonly controls: readonly ControlState[];
  readonly currentUsage: UsageState;
  readonly phase: Phase;
  /**
   * Projected end-of-cycle usage, same shape as currentUsage. May be PARTIAL:
   * any user / cost center absent here falls back to its currentUsage entry, so
   * a caller can project only the entities that move. NOTE: `enterprise` is a
   * required field of UsageState, so it is NOT per-entity optional -- overlay
   * takes `projectedUsage.enterprise` wholesale. A metered-phase caller must
   * therefore carry the projected enterprise metered forward (copy it from
   * currentUsage if unchanged); leaving it at a default would understate
   * enterprise draw and overstate its headroom. When `projectedUsage` is
   * omitted entirely, `projected` is null on every result.
   */
  readonly projectedUsage?: UsageState;
  /** At-risk threshold override; defaults to AT_RISK_THRESHOLD_PCT (0.95). */
  readonly thresholdPct?: number;
}

// ---------------------------------------------------------------------------
// Lookups (local; mirror simulate.ts's private helpers to keep this pure)
// ---------------------------------------------------------------------------

function budgetControls(controls: readonly ControlState[]): BudgetControl[] {
  return controls.filter((c): c is BudgetControl => c.kind === 'budget');
}

function toUlbCandidates(controls: readonly ControlState[]): UlbCandidate[] {
  return budgetControls(controls)
    .filter(
      (b): b is BudgetControl & { scope: UlbCandidate['scope'] } =>
        b.scope === 'universal' || b.scope === 'individual' || b.scope === 'multi_user_cost_center',
    )
    .map((b) => ({ scope: b.scope, entityName: b.entityName, amountCredits: b.amountCredits }));
}

function findSpendingLimit(
  controls: readonly ControlState[],
  scope: 'enterprise' | 'cost_center',
  entityName: string,
): BudgetControl | undefined {
  return budgetControls(controls).find((b) => b.scope === scope && b.entityName === entityName);
}

function findCap(controls: readonly ControlState[], costCenterName: string): IncludedCapControl | undefined {
  return controls.find((c): c is IncludedCapControl => c.kind === 'included_cap' && c.costCenterName === costCenterName);
}

function findCostCenter(controls: readonly ControlState[], name: string): CostCenterControl | undefined {
  return controls.find((c): c is CostCenterControl => c.kind === 'cost_center' && c.name === name);
}

/** Excluded cost centers fund from their OWN cap/budget, never the enterprise
 *  envelope (PRD §4.4.B). Defaults false when the cost center isn't modeled. */
function isExcludedFromEnterprise(controls: readonly ControlState[], costCenterName: string | null): boolean {
  if (costCenterName === null) return false;
  return findCostCenter(controls, costCenterName)?.excludedFromEnterpriseBudget ?? false;
}

function findUser(usage: UsageState, userLogin: string): UserUsage | undefined {
  return usage.users.find((u) => u.userLogin === userLogin);
}

function findCostCenterUsage(usage: UsageState, costCenterName: string): CostCenterUsage | undefined {
  return usage.costCenters.find((cc) => cc.costCenterName === costCenterName);
}

// ---------------------------------------------------------------------------
// Candidate model
// ---------------------------------------------------------------------------

interface Candidate {
  readonly constraint: BindingConstraint;
  readonly headroom: number;
  /** Tiebreak on EQUAL headroom (lower wins). A relax-only cap DOMINATES a
   *  grantable ULB/budget so the resolver never offers a grant that a co-binding
   *  cap would neutralize; between grantable levers the surgical ULB wins. */
  readonly tieRank: number;
}

const TIE_RANK = { cap: 0, ulb: 1, budget: 2 } as const;

function ulbCandidate(entity: Extract<EntityRef, { kind: 'user' }>, controls: readonly ControlState[], usage: UsageState): Candidate | null {
  const effective = resolveEffectiveUlb(entity.userLogin, entity.costCenterName, toUlbCandidates(controls));
  if (!effective) return null;
  const user = findUser(usage, entity.userLogin);
  const used = user ? user.poolCreditsUsed + user.meteredCreditsUsed : 0;
  const headroom = effective.amountCredits - used;
  const constraint: UlbBound = {
    type: 'ulb-bound',
    ulbScope: effective.scope,
    limitCredits: effective.amountCredits,
    usedCredits: used,
    remainingHeadroomCredits: headroom,
    grantLever: { kind: 'individual_override', userLogin: entity.userLogin },
    cculbLiftAlternative: entity.costCenterName !== null ? { kind: 'cculb_lift', costCenterName: entity.costCenterName } : null,
  };
  return { constraint, headroom, tieRank: TIE_RANK.ulb };
}

function capCandidate(costCenterName: string, controls: readonly ControlState[], usage: UsageState): Candidate | null {
  const cap = findCap(controls, costCenterName);
  if (!cap || !cap.enabled) return null;
  const ccUsage = findCostCenterUsage(usage, costCenterName);
  const poolDraw = ccUsage?.poolCreditsUsed ?? 0;
  const headroom = cap.computedLimitCredits - poolDraw;
  // overflow_to_metered is only a *new* move when the cap currently blocks.
  const relaxOptions: CapRelaxOption[] =
    cap.overflow === 'block'
      ? ['disable_cap', 'overflow_to_metered', 'reattribute_licenses']
      : ['disable_cap', 'reattribute_licenses'];
  const constraint: CapBound = {
    type: 'cap-bound',
    costCenterName,
    capEnabled: cap.enabled,
    capOverflow: cap.overflow,
    computedLimitCredits: cap.computedLimitCredits,
    poolDrawCredits: poolDraw,
    remainingHeadroomCredits: headroom,
    relaxOptions,
  };
  return { constraint, headroom, tieRank: TIE_RANK.cap };
}

function costCenterBudgetCandidate(costCenterName: string, controls: readonly ControlState[], usage: UsageState): Candidate | null {
  const budget = findSpendingLimit(controls, 'cost_center', costCenterName);
  if (!budget) return null;
  const ccUsage = findCostCenterUsage(usage, costCenterName);
  const metered = ccUsage?.meteredCreditsUsed ?? 0;
  const headroom = budget.amountCredits - metered;
  const constraint: BudgetBound = {
    type: 'budget-bound',
    spendingLimitScope: 'cost_center',
    entityName: costCenterName,
    limitCredits: budget.amountCredits,
    meteredUsedCredits: metered,
    remainingHeadroomCredits: headroom,
    hardStop: budget.preventFurtherUsage,
  };
  return { constraint, headroom, tieRank: TIE_RANK.budget };
}

function enterpriseBudgetCandidate(controls: readonly ControlState[], usage: UsageState): Candidate | null {
  const budget = findSpendingLimit(controls, 'enterprise', usage.enterprise.entityName);
  if (!budget) return null;
  const metered = usage.enterprise.meteredCreditsUsed;
  const headroom = budget.amountCredits - metered;
  const constraint: BudgetBound = {
    type: 'budget-bound',
    spendingLimitScope: 'enterprise',
    entityName: usage.enterprise.entityName,
    limitCredits: budget.amountCredits,
    meteredUsedCredits: metered,
    remainingHeadroomCredits: headroom,
    hardStop: budget.preventFurtherUsage,
  };
  return { constraint, headroom, tieRank: TIE_RANK.budget };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const OK_STATUS = (thresholdPct: number): AtRiskStatus => ({
  level: 'ok',
  atRisk: false,
  blocked: false,
  utilization: 0,
  thresholdPct,
});

function statusFor(limit: number, used: number, thresholdPct: number): AtRiskStatus {
  const remaining = limit - used;
  const blocked = remaining <= 0;
  const utilization = limit > 0 ? used / limit : used > 0 ? Infinity : 1;
  const level: AtRiskLevel = blocked ? 'blocked' : utilization >= thresholdPct ? 'at-risk' : 'ok';
  return { level, atRisk: level !== 'ok', blocked, utilization, thresholdPct };
}

function statusOfBinding(binding: BindingConstraint, thresholdPct: number): AtRiskStatus {
  switch (binding.type) {
    case 'ulb-bound':
      return statusFor(binding.limitCredits, binding.usedCredits, thresholdPct);
    case 'cap-bound':
      return statusFor(binding.computedLimitCredits, binding.poolDrawCredits, thresholdPct);
    case 'budget-bound':
      return statusFor(binding.limitCredits, binding.meteredUsedCredits, thresholdPct);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function gatherCandidates(entity: EntityRef, ctx: { controls: readonly ControlState[]; phase: Phase }, usage: UsageState): Candidate[] {
  const { controls, phase } = ctx;
  const candidates: Candidate[] = [];

  if (entity.kind === 'user') {
    const ulb = ulbCandidate(entity, controls, usage);
    if (ulb) candidates.push(ulb);

    if (phase === 'pool') {
      // Caps bind in the pool phase (a cap-hit team forfeits pool / tips to metered).
      if (entity.costCenterName !== null) {
        const cap = capCandidate(entity.costCenterName, controls, usage);
        if (cap) candidates.push(cap);
      }
    } else {
      // Metered phase: spending limits bind; the cap no longer does (already tipped).
      if (entity.costCenterName !== null) {
        const ccBudget = costCenterBudgetCandidate(entity.costCenterName, controls, usage);
        if (ccBudget) candidates.push(ccBudget);
      }
      // Excluded cost centers fund from their own cap/budget, NOT the enterprise
      // envelope (PRD §4.4.B) -- so the enterprise limit is not a candidate for
      // their members.
      if (!isExcludedFromEnterprise(controls, entity.costCenterName)) {
        const entBudget = enterpriseBudgetCandidate(controls, usage);
        if (entBudget) candidates.push(entBudget);
      }
    }
  } else {
    // Cost-center entity: cap in pool phase; spending limits in metered phase.
    if (phase === 'pool') {
      const cap = capCandidate(entity.costCenterName, controls, usage);
      if (cap) candidates.push(cap);
    } else {
      const ccBudget = costCenterBudgetCandidate(entity.costCenterName, controls, usage);
      if (ccBudget) candidates.push(ccBudget);
      if (!isExcludedFromEnterprise(controls, entity.costCenterName)) {
        const entBudget = enterpriseBudgetCandidate(controls, usage);
        if (entBudget) candidates.push(entBudget);
      }
    }
  }

  return candidates;
}

function resolveAgainst(entity: EntityRef, controls: readonly ControlState[], phase: Phase, usage: UsageState, thresholdPct: number): BindingResolution {
  const candidates = gatherCandidates(entity, { controls, phase }, usage);
  if (candidates.length === 0) {
    return { binding: null, status: OK_STATUS(thresholdPct) };
  }
  // Lowest remaining headroom wins; on a tie, the lower tieRank (see Candidate).
  const winner = candidates.reduce((best, c) =>
    c.headroom < best.headroom || (c.headroom === best.headroom && c.tieRank < best.tieRank) ? c : best,
  );
  return { binding: winner.constraint, status: statusOfBinding(winner.constraint, thresholdPct) };
}

/** Overlay `over` onto `base` (per-entity): any user / cost center present in
 *  `over` replaces its `base` counterpart; the rest fall back to `base`. Lets a
 *  caller supply a partial projected snapshot. */
function overlayUsage(base: UsageState, over: UsageState): UsageState {
  const users = new Map(base.users.map((u) => [u.userLogin, u]));
  for (const u of over.users) users.set(u.userLogin, u);
  const costCenters = new Map(base.costCenters.map((c) => [c.costCenterName, c]));
  for (const c of over.costCenters) costCenters.set(c.costCenterName, c);
  return { enterprise: over.enterprise, users: [...users.values()], costCenters: [...costCenters.values()] };
}

/** Resolve one entity's binding constraint on the current and (if provided) projected bases. */
export function resolveBindingConstraint(entity: EntityRef, ctx: BindingConstraintContext): EntityBindingResolution {
  const thresholdPct = ctx.thresholdPct ?? AT_RISK_THRESHOLD_PCT;
  const current = resolveAgainst(entity, ctx.controls, ctx.phase, ctx.currentUsage, thresholdPct);
  const projected = ctx.projectedUsage
    ? resolveAgainst(entity, ctx.controls, ctx.phase, overlayUsage(ctx.currentUsage, ctx.projectedUsage), thresholdPct)
    : null;
  return { entity, current, projected };
}

/** Batch form: resolve a list of entities against one context. */
export function resolveBindingConstraints(entities: readonly EntityRef[], ctx: BindingConstraintContext): EntityBindingResolution[] {
  return entities.map((e) => resolveBindingConstraint(e, ctx));
}

/**
 * The determination the triggers (6.2/6.5) rank on: the projected basis when
 * available, else current. A one-liner, but naming it keeps every consumer
 * choosing the same basis.
 */
export function effectiveResolution(r: EntityBindingResolution): BindingResolution {
  return r.projected ?? r.current;
}

/** Build entity refs from a usage snapshot: every user, and (opt-in) every cost center. */
export function entityRefsFromUsage(usage: UsageState, opts?: { includeCostCenters?: boolean }): EntityRef[] {
  const refs: EntityRef[] = usage.users.map((u) => ({ kind: 'user', userLogin: u.userLogin, costCenterName: u.costCenterName }));
  if (opts?.includeCostCenters) {
    for (const cc of usage.costCenters) refs.push({ kind: 'cost_center', costCenterName: cc.costCenterName });
  }
  return refs;
}
