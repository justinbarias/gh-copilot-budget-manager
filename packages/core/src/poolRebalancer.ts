import type { ControlState } from './controls.js';
import type { UlbScope } from './ulb.js';
import type { UsageState } from './simulate.js';
import type { TriggerCondition } from './triggerCondition.js';
import {
  AT_RISK_THRESHOLD_PCT,
  effectiveResolution,
  entityRefsFromUsage,
  resolveBindingConstraints,
  type BindingResolution,
  type CapBound,
  type CapRelaxOption,
  type CculbLiftLever,
  type EntityBindingResolution,
  type EntityRef,
  type IndividualOverrideLever,
  type UlbBound,
} from './bindingConstraint.js';

// ============================================================================
// Tasks 6.2 + 6.3 + 6.4 -- the POOL-PHASE rebalancer (PRD §4.4.A, FR6-FR10).
//
// The "use-it-or-lose-it" optimiser: near cycle end, unconsumed pool slack is
// forfeited at reset while some users are already blocked or >=95% of their
// ULB. Raising a ULB doesn't grow the pool -- it lifts a ceiling so a blocked
// user can draw the UNCONSUMED SHARED SLACK before it's lost.
//
// One pattern (PRD §4.4): detect trigger (6.2) -> size a funding envelope (6.2)
// -> resolve each at-risk entity's binding constraint (6.1) -> allocate greedily
// by priority (6.3) -> simulate (6.4) -> [apply / grant / revert are Phase 5+].
//
// POOL-PHASE REDISTRIBUTION IS ULBs ONLY (CLAUDE.md §5): the binding-constraint
// resolver branches by TYPE -- `ulb-bound` entities get a grant on the
// most-specific lever; `cap-bound` teams have NO grantable delta and route to a
// separate relax branch (disable cap / overflow->metered / re-attribute). Cost-
// center budgets are metered-only and the cap doesn't grant, so ULBs are the
// entire pool-phase toolkit.
//
// PURE (CLAUDE.md §2): no I/O, no wall-clock. `asOfDate`/`cycleEndDate` are
// explicit inputs; every projection is supplied by the caller (forecast.ts is
// the estimator; this module trusts the passed snapshot + aggregate figures).
// This is money-affecting centrepiece math -- see poolRebalancer.test.ts for
// the hand-computed PRD-scenario reproductions the validator re-derives.
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayStartMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole UTC calendar days from `from` to `to` (negative if `to` precedes `from`). */
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.round((dayStartMs(to) - dayStartMs(from)) / MS_PER_DAY);
}

/** Stable key mirroring bindingConstraint's identity semantics (kind-prefixed). */
export function entityKey(e: EntityRef): string {
  return e.kind === 'user' ? `user:${e.userLogin}` : `cost_center:${e.costCenterName}`;
}

// ---------------------------------------------------------------------------
// Parameters (every open PRD/CLAUDE.md knob is here with a documented default)
// ---------------------------------------------------------------------------

export interface PoolTriggerParams {
  /**
   * "Near cycle end" window (FR6). Trigger's condition 1 fires when whole days
   * from `asOfDate` to `cycleEndDate` are within [0, this]. Spec says "near
   * cycle end" but leaves the length open -- default 7 (the PRD's day-26-of-30
   * example is 4 days out, comfortably inside a 7-day window). Chosen here.
   */
  nearCycleEndDays?: number;
  /**
   * "Projected pool underutilisation" threshold (FR6 condition 2). Fires when
   * projected END-OF-CYCLE pool utilisation is BELOW this fraction (i.e. the
   * pool is on track to be forfeited). Default 0.95 -> a projected >=5% forfeit
   * trips it. The PRD scenario's projected 82% is well under 95%. Chosen here.
   */
  underutilizationThresholdPct?: number;
  /**
   * At-risk threshold passed straight through to the 6.1 resolver (an entity is
   * at-risk at/above this fraction of its binding constraint). Default 0.95 =
   * bindingConstraint.AT_RISK_THRESHOLD_PCT (FR6 "blocked or >=95%").
   */
  atRiskThresholdPct?: number;
  /** Minimum at-risk-entity count for condition 3 (FR6 ">=1"). Default 1. */
  minAtRiskEntities?: number;
}

export interface PoolRebalanceParams extends PoolTriggerParams {
  /**
   * Mandatory reserve buffer (PRD §4.4 "Guardrails") as a fraction of the pool
   * TOTAL. Default 0.05 (5%). The reserve is held back from the grantable
   * envelope so the rebalancer never hands out the whole remaining pool.
   * Overridden by `reserveCredits` when that is supplied.
   */
  reservePct?: number;
  /** Absolute reserve override (credits). Takes precedence over `reservePct`. */
  reserveCredits?: number;
  /**
   * Metered credits the pool posture permits past pool exhaustion (PRD §5 Q4 --
   * a controlled metered budget vs a hard stop). Widens ONLY the safety ceiling
   * (`Sigma raised ceilings <= remaining_pool + allowedMetered`); the grantable
   * envelope itself is still pool-slack only. Default 0 (hard-stop at pool).
   */
  allowedMeteredCredits?: number;
  /**
   * z-multiplier translating the forecast band (P90 - P50) back into a standard
   * deviation for the tip-into-metered probability. Default 1.2816 = the
   * one-sided 90th percentile of the standard normal, matching forecast.ts's
   * `zP90` (so the band this consumes and the band forecast.ts emits agree).
   */
  bandZ?: number;
  /**
   * Optional business-priority score per entity key ({@link entityKey}). Higher
   * = funded earlier (after the hard blocked-first rule). Absent -> 0 for all,
   * so ordering falls through to proximity/throughput. The PRD lists "business
   * priority" as a ranking key but leaves its source open; this is the hook.
   */
  businessPriorityByEntity?: Readonly<Record<string, number>>;
}

const DEFAULT_NEAR_CYCLE_END_DAYS = 7;
const DEFAULT_UNDERUTIL_THRESHOLD = 0.95;
const DEFAULT_MIN_AT_RISK = 1;
const DEFAULT_RESERVE_PCT = 0.05;
const DEFAULT_BAND_Z = 1.2816;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PoolRebalanceContext {
  readonly controls: readonly ControlState[];
  /** Cycle-to-date usage (the current basis). */
  readonly currentUsage: UsageState;
  /**
   * Forecast end-of-cycle usage per entity (from forecast.ts, adapted). Drives
   * BOTH the at-risk determination (6.1 resolves on the projected basis) and
   * grant sizing. May be partial per bindingConstraint's overlay semantics.
   */
  readonly projectedUsage: UsageState;
  /** The shared pool allowance for the cycle (credits). */
  readonly poolTotalCredits: number;
  /** Cycle-to-date aggregate pool draw. `remaining_pool = poolTotal - this`. */
  readonly poolConsumedCredits: number;
  /**
   * Forecast CENTRAL (P50) end-of-cycle aggregate pool draw under CURRENT
   * controls (no rebalance) -- the "projected 82%" figure. The trigger's
   * underutilisation test and the simulation's before-utilisation read this.
   */
  readonly projectedPoolConsumedCredits: number;
  /**
   * Forecast P90 end-of-cycle aggregate pool draw (band upper). Sets the
   * tip-into-metered variance (sigma = (P90 - P50) / bandZ). Omitted/<=P50 ->
   * zero variance (deterministic tip test).
   */
  readonly projectedPoolConsumedP90Credits?: number;
  readonly asOfDate: Date;
  readonly cycleEndDate: Date;
  /** Resolve cost-center entities too (the cap-bound relax branch). Default true. */
  readonly includeCostCenters?: boolean;
  readonly params?: PoolRebalanceParams;
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

/** Resolve every entity's pool-phase binding constraint on current + projected bases. */
export function resolvePoolBindings(ctx: PoolRebalanceContext): EntityBindingResolution[] {
  const entities = entityRefsFromUsage(ctx.currentUsage, {
    includeCostCenters: ctx.includeCostCenters ?? true,
  });
  return resolveBindingConstraints(entities, {
    controls: ctx.controls,
    currentUsage: ctx.currentUsage,
    phase: 'pool',
    projectedUsage: ctx.projectedUsage,
    thresholdPct: ctx.params?.atRiskThresholdPct ?? AT_RISK_THRESHOLD_PCT,
  });
}

function isAtRisk(r: EntityBindingResolution): boolean {
  // At-RISK membership is the EFFECTIVE (projected-when-available) basis -- the
  // trigger fires and the allocator ranks on where entities are HEADED.
  return effectiveResolution(r).status.atRisk;
}

function isCurrentlyBlocked(r: EntityBindingResolution): boolean {
  // "Blocked" (the PRD's "6 blocked" and the blocked-first ranking key) is the
  // CURRENT snapshot -- who is hard-stopped RIGHT NOW, distinct from the larger
  // set merely projected to breach by cycle end (those are "approaching").
  return r.current.status.blocked;
}

function ulbOf(res: BindingResolution): UlbBound | null {
  return res.binding?.type === 'ulb-bound' ? res.binding : null;
}

function findUserUsage(usage: UsageState, login: string) {
  return usage.users.find((u) => u.userLogin === login);
}

function findCcUsage(usage: UsageState, name: string) {
  return usage.costCenters.find((cc) => cc.costCenterName === name);
}

/** A user's projected end-of-cycle TOTAL usage (pool + metered); falls back to current. */
function projectedUserTotal(ctx: PoolRebalanceContext, login: string): number {
  const proj = findUserUsage(ctx.projectedUsage, login);
  if (proj) return proj.poolCreditsUsed + proj.meteredCreditsUsed;
  const cur = findUserUsage(ctx.currentUsage, login);
  return cur ? cur.poolCreditsUsed + cur.meteredCreditsUsed : 0;
}

/** A user's projected ADDITIONAL pool draw from now to cycle end (>=0). */
function projectedUserAdditionalDraw(ctx: PoolRebalanceContext, login: string): number {
  const cur = findUserUsage(ctx.currentUsage, login)?.poolCreditsUsed ?? 0;
  const proj = findUserUsage(ctx.projectedUsage, login)?.poolCreditsUsed ?? cur;
  return Math.max(0, proj - cur);
}

// ===========================================================================
// Task 6.2 -- trigger (condition chips)
// ===========================================================================

export interface PoolTriggerResult {
  /** All three conditions met (FR6). */
  readonly fired: boolean;
  /** Fixed order: [near-cycle-end, underutilisation, at-risk-entities]. */
  readonly conditions: readonly TriggerCondition[];
  readonly daysRemaining: number;
  readonly projectedUtilization: number;
  readonly projectedForfeitPct: number;
  readonly atRiskCount: number;
  readonly blockedCount: number;
  readonly approachingCount: number;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function evaluatePoolTrigger(
  ctx: PoolRebalanceContext,
  resolutions: readonly EntityBindingResolution[] = resolvePoolBindings(ctx),
): PoolTriggerResult {
  const p = ctx.params ?? {};
  const nearWindow = p.nearCycleEndDays ?? DEFAULT_NEAR_CYCLE_END_DAYS;
  const underutilThreshold = p.underutilizationThresholdPct ?? DEFAULT_UNDERUTIL_THRESHOLD;
  const minAtRisk = p.minAtRiskEntities ?? DEFAULT_MIN_AT_RISK;

  const daysRemaining = wholeDaysBetween(ctx.asOfDate, ctx.cycleEndDate);
  const nearCycleEnd = daysRemaining >= 0 && daysRemaining <= nearWindow;

  const projectedUtilization =
    ctx.poolTotalCredits > 0 ? ctx.projectedPoolConsumedCredits / ctx.poolTotalCredits : 1;
  const projectedForfeitPct = Math.max(0, 1 - projectedUtilization);
  const underutilised = projectedUtilization < underutilThreshold;

  const atRisk = resolutions.filter(isAtRisk);
  const blockedCount = atRisk.filter(isCurrentlyBlocked).length;
  const approachingCount = atRisk.length - blockedCount;
  const hasAtRisk = atRisk.length >= minAtRisk;

  const conditions: TriggerCondition[] = [
    {
      met: nearCycleEnd,
      label: 'Near cycle end',
      detail: `${daysRemaining} day(s) remaining (window: ${nearWindow})`,
    },
    {
      met: underutilised,
      label: 'Projected pool underutilisation',
      detail: `projected ${pct(projectedUtilization)} end-of-cycle utilisation (${pct(
        projectedForfeitPct,
      )} forfeit); threshold ${pct(underutilThreshold)}`,
    },
    {
      met: hasAtRisk,
      label: 'At-risk entities',
      detail: `${atRisk.length} at-risk (${blockedCount} blocked, ${approachingCount} approaching); need >=${minAtRisk}`,
    },
  ];

  return {
    fired: conditions.every((c) => c.met),
    conditions,
    daysRemaining,
    projectedUtilization,
    projectedForfeitPct,
    atRiskCount: atRisk.length,
    blockedCount,
    approachingCount,
  };
}

// ===========================================================================
// Task 6.2 -- funding envelope (FR7)
// ===========================================================================

/**
 * The envelope-bar segments (6.8 renders these directly). INVARIANT (property-
 * tested): `reserve + held + grants + slack === remaining_pool`, always. `slack`
 * is the residual, so the identity holds for any inputs; a NEGATIVE slack flags
 * over-subscription (reserve + held already exceed the remaining pool -> no
 * grantable envelope).
 */
export interface EnvelopeSegments {
  /** Held-back reserve buffer. */
  readonly reserve: number;
  /** Projected consumption of non-at-risk users to cycle end (they'll draw it). */
  readonly held: number;
  /** Grants allocated so far (Sigma funded ceiling raises). */
  readonly grants: number;
  /** Unallocated pool slack (residual). */
  readonly slack: number;
}

export interface FundingEnvelope {
  readonly remainingPoolCredits: number;
  readonly reserveCredits: number;
  readonly heldForNonAtRiskCredits: number;
  /** The grantable amount: `max(0, remaining_pool - reserve - held)` (FR7). */
  readonly envelopeCredits: number;
  readonly segments: EnvelopeSegments;
}

function resolveReserve(ctx: PoolRebalanceContext): number {
  const p = ctx.params ?? {};
  if (p.reserveCredits !== undefined) return Math.max(0, p.reserveCredits);
  return Math.max(0, Math.round((p.reservePct ?? DEFAULT_RESERVE_PCT) * ctx.poolTotalCredits));
}

/** Sigma projected additional pool draw of non-at-risk USERS (cost centers are
 *  aggregates of users -- counting them too would double-count the held slack). */
function heldForNonAtRisk(ctx: PoolRebalanceContext, resolutions: readonly EntityBindingResolution[]): number {
  let held = 0;
  for (const r of resolutions) {
    if (r.entity.kind !== 'user') continue;
    if (isAtRisk(r)) continue;
    held += projectedUserAdditionalDraw(ctx, r.entity.userLogin);
  }
  return held;
}

/**
 * FR7 envelope. `grantsAllocated` fills the `grants` segment (0 before
 * allocation, Sigma funded after). The three known quantities plus the residual
 * `slack` always sum to `remaining_pool`.
 */
export function computeFundingEnvelope(
  ctx: PoolRebalanceContext,
  resolutions: readonly EntityBindingResolution[] = resolvePoolBindings(ctx),
  grantsAllocated = 0,
): FundingEnvelope {
  const remainingPool = ctx.poolTotalCredits - ctx.poolConsumedCredits;
  const reserve = resolveReserve(ctx);
  const held = heldForNonAtRisk(ctx, resolutions);
  const envelopeCredits = Math.max(0, remainingPool - reserve - held);
  const grants = grantsAllocated;
  const slack = remainingPool - reserve - held - grants;
  return {
    remainingPoolCredits: remainingPool,
    reserveCredits: reserve,
    heldForNonAtRiskCredits: held,
    envelopeCredits,
    segments: { reserve, held, grants, slack },
  };
}

// ===========================================================================
// Task 6.3 -- allocator (grants + relax branch)
// ===========================================================================

export type GrantFundingStatus = 'funded' | 'partial' | 'unfunded';

/** A proposed ULB grant on ONE at-risk, ULB-bound user (FR8/FR9). */
export interface PoolGrant {
  readonly entity: EntityRef;
  readonly userLogin: string;
  /** Desired ceiling raise = `max(0, projectedDemand - currentLimit)`. */
  readonly grantCredits: number;
  /** Credits actually covered by the envelope (== grantCredits when 'funded'). */
  readonly fundedCredits: number;
  /** The ceiling we'd actually write = `currentLimit + fundedCredits`. */
  readonly newLimitCredits: number;
  readonly currentLimitCredits: number;
  /** Projected end-of-cycle total usage the full grant covers. */
  readonly projectedDemandCredits: number;
  readonly status: GrantFundingStatus;
  /** Most-specific lever: a surgical, precedence-winning individual override. */
  readonly lever: IndividualOverrideLever;
  /** Blunt team-wide alternative (CCULB lift); null for unassigned users. */
  readonly cculbLiftAlternative: CculbLiftLever | null;
  /** ULB scope the override CONVERTS FROM (UI sub-label, e.g. "from Universal"). */
  readonly convertsFrom: UlbScope;
  // Ranking diagnostics (why this row sits where it does):
  readonly blocked: boolean;
  readonly utilization: number;
  readonly businessPriority: number;
  /** Demonstrated throughput = projected additional pool draw. */
  readonly throughputCredits: number;
}

/**
 * A cap-bound team's relax options (FR8/FR9). STRUCTURALLY carries NO delta --
 * the included-usage cap is never a grantable amount (CLAUDE.md §5). It carries
 * the fixed pool draw that lifting the cap would UNLOCK, purely informational.
 */
export interface CapRelaxRecommendation {
  readonly entity: EntityRef;
  readonly costCenterName: string;
  readonly options: readonly CapRelaxOption[];
  readonly computedLimitCredits: number;
  readonly poolDrawCredits: number;
  /** Projected end-of-cycle pool demand for the cost center. */
  readonly projectedDemandCredits: number;
  /**
   * Fixed pool draw lifting the cap would unlock:
   *   `max(0, projectedDemand - computedLimit)`
   * -- the projected draw the team wants BEYOND the GitHub-computed cap. Not a
   * grant, not settable; the cap binds at `computedLimit`, so this is exactly
   * the pool the team is being denied. Bounded below by 0.
   */
  readonly unlockContributionCredits: number;
}

export interface PoolAllocationResult {
  /** Ranked ULB grants (blocked-first), each with its funding status. */
  readonly grants: readonly PoolGrant[];
  /** Cap-bound teams routed to the relax branch (no deltas). */
  readonly capRelax: readonly CapRelaxRecommendation[];
  /** The envelope with its `grants` segment filled to Sigma funded. */
  readonly envelope: FundingEnvelope;
  /** Fully-funded grant count (the "N" in "N of M funded"). */
  readonly fundedCount: number;
  /** Grant candidates needing a raise (the "M"). */
  readonly grantCandidateCount: number;
  readonly summaryLabel: string;
  /** Sigma funded ceiling raises. */
  readonly totalGrantedCredits: number;
  /** Safety ceiling = `remaining_pool + allowedMetered` (CLAUDE.md §5 / FR8). */
  readonly safetyCeilingCredits: number;
  /** `totalGranted <= safetyCeiling` -- must always hold (property-tested). */
  readonly safetyOk: boolean;
}

interface GrantSeed {
  readonly entity: Extract<EntityRef, { kind: 'user' }>;
  readonly grantCredits: number;
  readonly currentLimitCredits: number;
  readonly projectedDemandCredits: number;
  readonly lever: IndividualOverrideLever;
  readonly cculbLiftAlternative: CculbLiftLever | null;
  readonly convertsFrom: UlbScope;
  readonly blocked: boolean;
  readonly utilization: number;
  readonly businessPriority: number;
  readonly throughputCredits: number;
}

/**
 * Ranking (FR8): blocked-first is the only hard rule the PRD pins; the remaining
 * keys follow the spec's listed order. Implemented as a strict LEXICOGRAPHIC
 * comparator (not a weighted sum) for explainability -- the government-posture
 * audit (CLAUDE.md §6.5) needs "why funded before" to be a readable rule, not an
 * opaque score. Order: blocked desc -> proximity (utilisation) desc -> business
 * priority desc -> demonstrated throughput desc -> login asc (determinism).
 */
function compareGrantSeeds(a: GrantSeed, b: GrantSeed): number {
  if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
  if (a.utilization !== b.utilization) return b.utilization - a.utilization;
  if (a.businessPriority !== b.businessPriority) return b.businessPriority - a.businessPriority;
  if (a.throughputCredits !== b.throughputCredits) return b.throughputCredits - a.throughputCredits;
  return a.entity.userLogin.localeCompare(b.entity.userLogin);
}

export function allocatePoolGrants(
  ctx: PoolRebalanceContext,
  resolutions: readonly EntityBindingResolution[] = resolvePoolBindings(ctx),
): PoolAllocationResult {
  const priorities = ctx.params?.businessPriorityByEntity ?? {};

  // Split at-risk entities by binding TYPE (CLAUDE.md §5: the remediation sets
  // don't overlap -- ULB-bound get grants, cap-bound relax, never both).
  const seeds: GrantSeed[] = [];
  const capRelax: CapRelaxRecommendation[] = [];

  for (const r of resolutions) {
    if (!isAtRisk(r)) continue;
    const eff = effectiveResolution(r);
    const binding = eff.binding;
    if (!binding) continue;

    if (binding.type === 'cap-bound') {
      capRelax.push(buildCapRelax(ctx, r, binding));
      continue;
    }
    if (binding.type !== 'ulb-bound') continue; // budget-bound can't arise in pool phase

    if (r.entity.kind !== 'user') continue;
    const currentUlb = ulbOf(r.current) ?? binding;
    const currentLimit = currentUlb.limitCredits;
    const projectedDemand = projectedUserTotal(ctx, r.entity.userLogin);
    const grantCredits = Math.max(0, projectedDemand - currentLimit);
    if (grantCredits <= 0) continue; // at-risk but fits without a raise -> no grant

    seeds.push({
      entity: r.entity,
      grantCredits,
      currentLimitCredits: currentLimit,
      projectedDemandCredits: projectedDemand,
      lever: currentUlb.grantLever,
      cculbLiftAlternative: currentUlb.cculbLiftAlternative,
      convertsFrom: currentUlb.ulbScope,
      blocked: isCurrentlyBlocked(r),
      utilization: eff.status.utilization,
      businessPriority: priorities[entityKey(r.entity)] ?? 0,
      throughputCredits: projectedUserAdditionalDraw(ctx, r.entity.userLogin),
    });
  }

  seeds.sort(compareGrantSeeds);

  const envelope0 = computeFundingEnvelope(ctx, resolutions, 0);
  let remaining = envelope0.envelopeCredits;

  const grants: PoolGrant[] = seeds.map((s) => {
    const funded = Math.min(s.grantCredits, Math.max(0, remaining));
    remaining -= funded;
    const status: GrantFundingStatus =
      funded >= s.grantCredits ? 'funded' : funded > 0 ? 'partial' : 'unfunded';
    return {
      entity: s.entity,
      userLogin: s.entity.userLogin,
      grantCredits: s.grantCredits,
      fundedCredits: funded,
      newLimitCredits: s.currentLimitCredits + funded,
      currentLimitCredits: s.currentLimitCredits,
      projectedDemandCredits: s.projectedDemandCredits,
      status,
      lever: s.lever,
      cculbLiftAlternative: s.cculbLiftAlternative,
      convertsFrom: s.convertsFrom,
      blocked: s.blocked,
      utilization: s.utilization,
      businessPriority: s.businessPriority,
      throughputCredits: s.throughputCredits,
    };
  });

  const totalGranted = grants.reduce((sum, g) => sum + g.fundedCredits, 0);
  const fundedCount = grants.filter((g) => g.status === 'funded').length;
  const remainingPool = ctx.poolTotalCredits - ctx.poolConsumedCredits;
  const safetyCeiling = remainingPool + Math.max(0, ctx.params?.allowedMeteredCredits ?? 0);

  return {
    grants,
    capRelax,
    envelope: computeFundingEnvelope(ctx, resolutions, totalGranted),
    fundedCount,
    grantCandidateCount: grants.length,
    summaryLabel: `${fundedCount} of ${grants.length} funded`,
    totalGrantedCredits: totalGranted,
    safetyCeilingCredits: safetyCeiling,
    safetyOk: totalGranted <= safetyCeiling,
  };
}

function buildCapRelax(
  ctx: PoolRebalanceContext,
  r: EntityBindingResolution,
  binding: CapBound,
): CapRelaxRecommendation {
  const projCc = findCcUsage(ctx.projectedUsage, binding.costCenterName);
  const curCc = findCcUsage(ctx.currentUsage, binding.costCenterName);
  // Report the CURRENT draw at the cap (the actual "at 70,000 of a 70,000 cap"
  // figure); demand is the projected end-of-cycle draw. `binding` is the
  // effective (projected) resolution, so its own poolDraw is the projected one.
  const poolDraw = curCc?.poolCreditsUsed ?? binding.poolDrawCredits;
  const projectedDemand = projCc?.poolCreditsUsed ?? curCc?.poolCreditsUsed ?? binding.poolDrawCredits;
  return {
    entity: r.entity,
    costCenterName: binding.costCenterName,
    options: binding.relaxOptions,
    computedLimitCredits: binding.computedLimitCredits,
    poolDrawCredits: poolDraw,
    projectedDemandCredits: projectedDemand,
    // Fixed pool the cap denies: projected demand beyond the GitHub-computed cap.
    unlockContributionCredits: Math.max(0, projectedDemand - binding.computedLimitCredits),
  };
}

// ===========================================================================
// Task 6.4 -- pool simulation (FR10)
// ===========================================================================

export type PoolAssuranceVerdict = 'ok' | 'over-allocated';

export interface PoolRebalanceSimulation {
  readonly beforeConsumedCredits: number;
  readonly afterConsumedCredits: number;
  readonly beforeUtilization: number;
  readonly afterUtilization: number;
  readonly usersUnblockedCount: number;
  /** P(final draw > pool total) from the forecast band. In [0, 1]. */
  readonly tipProbability: number;
  /** `ok` unless Sigma ceiling raises exceed the grantable envelope. */
  readonly verdict: PoolAssuranceVerdict;
  readonly envelopeCredits: number;
  /** Sigma applied ceiling raises (the over-allocation basis). */
  readonly totalGrantedCredits: number;
}

// Abramowitz & Stegun 7.1.26 erf approximation (max abs error ~1.5e-7) -> a
// standard-normal CDF, so the tip probability is fully deterministic and pure.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * FR10 simulation of a (possibly user-edited) grant set.
 *
 * - `afterConsumed = beforeConsumed + Sigma min(fundedCredits, grantCredits)` --
 *   the pre-rebalance projection already counts each at-risk user's draw UP TO
 *   their old ceiling, so the pool the grant NEWLY unlocks is exactly the raise
 *   beyond that ceiling (capped at the raise; over-granting past demand lifts a
 *   ceiling but draws no extra pool).
 * - `usersUnblocked` = fully-funded grants (a partial raise leaves the ceiling
 *   below projected demand, so they still block by cycle end).
 * - `tipProbability` = P(draw > pool total) under N(afterConsumed, sigma^2) with
 *   sigma = (P90 - P50) / bandZ -- the forecast's OWN band width. Grants shift
 *   the mean up; the run-rate uncertainty (band) is unchanged by a deterministic
 *   grant, so sigma stays put.
 * - `verdict` flips to `over-allocated` once Sigma applied raises exceed the
 *   grantable envelope (a hand envelope is the over-commit guard, PRD §4.4).
 * - `extraPoolDrawCredits` (Task 6.8): the CAP-RELAX contribution channel.
 *   Lifting an included-usage cap unlocks a FIXED pool draw
 *   (CapRelaxRecommendation.unlockContributionCredits) that shifts the
 *   projected end-of-cycle draw exactly like a funded grant's applied draw
 *   does -- but it is NOT a grant (CLAUDE.md §5: a cap has no grantable
 *   delta), so it is deliberately EXCLUDED from `totalGrantedCredits` and the
 *   over-allocation `verdict` (a lifted cap doesn't draw from the ULB
 *   envelope) and from `usersUnblockedCount` (it unblocks a team's cap, not a
 *   ULB'd user). It feeds only afterConsumed/afterUtilization/tipProbability.
 *   Defaults to 0, so every pre-6.8 caller (incl. runPoolRebalancer) is
 *   byte-identical.
 */
export function simulatePoolRebalance(
  grants: readonly PoolGrant[],
  ctx: PoolRebalanceContext,
  envelope: FundingEnvelope,
  extraPoolDrawCredits = 0,
): PoolRebalanceSimulation {
  const totalGranted = grants.reduce((sum, g) => sum + Math.max(0, g.fundedCredits), 0);
  const appliedDraw =
    grants.reduce((sum, g) => sum + Math.min(Math.max(0, g.fundedCredits), g.grantCredits), 0) +
    Math.max(0, extraPoolDrawCredits);

  const before = ctx.projectedPoolConsumedCredits;
  const after = before + appliedDraw;
  const total = ctx.poolTotalCredits;

  const usersUnblocked = grants.filter((g) => g.fundedCredits >= g.grantCredits && g.grantCredits > 0).length;

  const bandZ = ctx.params?.bandZ ?? DEFAULT_BAND_Z;
  const p90 = ctx.projectedPoolConsumedP90Credits ?? before;
  const sigma = bandZ > 0 ? Math.max(0, (p90 - before) / bandZ) : 0;
  let tip: number;
  if (sigma <= 0) {
    tip = after >= total ? 1 : 0;
  } else {
    tip = 1 - normalCdf((total - after) / sigma);
    tip = Math.min(1, Math.max(0, tip));
  }

  return {
    beforeConsumedCredits: before,
    afterConsumedCredits: after,
    beforeUtilization: total > 0 ? before / total : 0,
    afterUtilization: total > 0 ? after / total : 0,
    usersUnblockedCount: usersUnblocked,
    tipProbability: tip,
    verdict: totalGranted > envelope.envelopeCredits ? 'over-allocated' : 'ok',
    envelopeCredits: envelope.envelopeCredits,
    totalGrantedCredits: totalGranted,
  };
}

// ===========================================================================
// Orchestration -- the whole dry-run in one call (6.8 consumes this)
// ===========================================================================

export interface PoolRebalancePlan {
  readonly trigger: PoolTriggerResult;
  readonly allocation: PoolAllocationResult;
  readonly simulation: PoolRebalanceSimulation;
  readonly resolutions: readonly EntityBindingResolution[];
}

/** Run the full pool-phase rebalancer dry-run (trigger -> envelope -> allocate ->
 *  simulate) from one context, resolving bindings exactly once. */
export function runPoolRebalancer(ctx: PoolRebalanceContext): PoolRebalancePlan {
  const resolutions = resolvePoolBindings(ctx);
  const trigger = evaluatePoolTrigger(ctx, resolutions);
  const allocation = allocatePoolGrants(ctx, resolutions);
  const simulation = simulatePoolRebalance(allocation.grants, ctx, allocation.envelope);
  return { trigger, allocation, simulation, resolutions };
}
