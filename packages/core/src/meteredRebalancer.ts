import { creditsToUsd, type BudgetControl, type ControlState } from './controls.js';
import {
  AT_RISK_THRESHOLD_PCT,
  effectiveResolution,
  resolveBindingConstraint,
  type BindingConstraint,
  type BudgetBound,
  type CculbLiftLever,
  type EntityRef,
  type IndividualOverrideLever,
} from './bindingConstraint.js';
import type { UsageState } from './simulate.js';
import type { TriggerCondition } from './triggerCondition.js';

// ============================================================================
// Tasks 6.5 + 6.6 -- the METERED-phase rebalancer (PRD §4.4.B, FR11-FR14).
//
// The metered twin of the pool rebalancer (6.2-6.4). After the shared pool is
// gone, some cost centers / individuals hit their metered ceiling while the
// enterprise budget still has large unused headroom; this engine redistributes
// that headroom -- raise the ONE binding budget per at-risk entity (resolved by
// 6.1's binding-constraint resolver), greedily, against a hard funding envelope.
//
// It follows the same five-step pattern as the pool engine and the pool
// engine's typed shapes where the semantics coincide (condition chips, a
// reserve/held/grants/slack envelope-segment breakdown, "N of M funded"):
//   detect trigger -> size envelope -> resolve each binding -> allocate greedily
//   -> simulate (6.6) -> [apply is a later, guardrailed phase].
//
// PURE (CLAUDE.md §2): no I/O, no wall-clock. The *forecast* that produces
// `projectedUsage` is forecast.ts's concern (it takes asOfDate); this engine is
// pure arithmetic over the current + projected usage snapshots it is handed.
//
// ---------------------------------------------------------------------------
// UNIT DISCIPLINE (decided once, here): every amount is in CREDITS (integers),
// exactly as bindingConstraint.ts / simulate.ts / forecast.ts represent money.
// USD is a derived *view* (creditsToUsd = credits / 100) exposed on every money
// field with a `Usd` suffix. The PRD §4.4.B scenario is stated in dollars; the
// mapping is $X <-> X * 100 credits (1 credit = $0.01, CLAUDE.md §5). So the
// spec's "$8,000 budget / $6,300 unused / +$250 grant" are 800_000 / 630_000 /
// 25_000 credits internally. No `* 0.01` float ever enters the math.
//
// ---------------------------------------------------------------------------
// ASYMMETRY WITH THE POOL ENGINE (6.2-6.4), stated for the UI (6.9) contract:
//   - Pool phase redistributes ULBs ONLY (CLAUDE.md §5). Metered phase raises
//     whichever budget BINDS -- a ULB (near-ULB user) OR a cost-center budget
//     (near-cap cost center). So this engine's grant lever is a *union*:
//     individual-override / CCULB-lift (ULB-bound) + cost-center-budget-raise.
//   - The envelope base is the enterprise (or org) SPENDING LIMIT's remaining
//     headroom, not the shared pool's remaining slack.
//   - The hero simulation output is the **bill delta** (FR14): real dollars the
//     grants add to the invoice -- the pool engine has no billing consequence
//     (raising a ULB just draws already-paid-for pool slack).
//   - Two branches the pool engine lacks: (a) EXCLUDED cost centers fund from
//     their OWN budget, never the shared enterprise envelope (PRD §4.4.B); (b)
//     raising the ENTERPRISE budget itself is policy+approval-only, so an
//     enterprise-bound entity is emitted as a FLAGGED recommendation, never an
//     allocation (FR13).
// ============================================================================

// ---------------------------------------------------------------------------
// Parameterized defaults (each documented at its use site; all overridable so
// the engine tunes without a code change, per forecast.ts's convention).
// ---------------------------------------------------------------------------

/** FR12 mandatory reserve buffer, absolute credits. Default 0 (no reserve). */
export const DEFAULT_RESERVE_CREDITS = 0;

/** FR13 guardrail: max grant per entity, credits. Default unbounded. */
export const DEFAULT_MAX_GRANT_PER_ENTITY_CREDITS = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------------------
// Trigger (FR11) -- condition chips, mirroring the pool engine's UI structure.
// ---------------------------------------------------------------------------

/** FR11 trigger: fires iff ALL conditions are met. */
export interface MeteredTrigger {
  readonly fired: boolean;
  /** Ordered: [metered phase active, >=1 blocking-at-risk entity, higher-scope headroom]. */
  readonly conditions: readonly TriggerCondition[];
  readonly atRiskCount: number;
}

// ---------------------------------------------------------------------------
// Funding envelope (FR12) -- reserve / held / grants / slack segment breakdown.
// INVARIANT (tested): reserve + held + grants + slack === baseRemaining.
// ---------------------------------------------------------------------------

export interface MeteredEnvelope {
  /** remaining_enterprise = enterprise spending-limit amount - current enterprise metered. */
  readonly baseRemainingCredits: number;
  readonly baseRemainingUsd: number;
  /** FR12 reserve buffer (held back from allocation). */
  readonly reserveCredits: number;
  readonly reserveUsd: number;
  /** Σ projected FURTHER metered draw of NON-at-risk, NON-excluded entities (protected). */
  readonly heldCredits: number;
  readonly heldUsd: number;
  /** max(0, base - reserve - held): the amount the allocator may actually spend. */
  readonly allocatableCredits: number;
  readonly allocatableUsd: number;
  /** Σ granted deltas drawn FROM THE ENVELOPE (excludes own-funded excluded-CC grants). */
  readonly grantedCredits: number;
  readonly grantedUsd: number;
  /**
   * The unallocated remainder, defined as base - reserve - held - granted so the
   * SEGMENT INVARIANT reserve + held + granted + slack === baseRemaining holds
   * unconditionally. When reserve + held exceed the base (an over-reserved error
   * state), slack goes NEGATIVE -- the UI's red "over-reserved" signal -- while
   * allocatableCredits stays clamped at 0 and no grant is made.
   */
  readonly slackCredits: number;
  readonly slackUsd: number;
}

// ---------------------------------------------------------------------------
// Grant levers (union: 6.1's ULB levers + a cost-center-budget raise).
// ---------------------------------------------------------------------------

/** Raise a cost center's metered spending limit (the near-cap-CC lever). */
export interface CostCenterBudgetRaiseLever {
  readonly kind: 'cost_center_budget_raise';
  readonly costCenterName: string;
}

export type MeteredGrantLever = IndividualOverrideLever | CculbLiftLever | CostCenterBudgetRaiseLever;

/** Where a grant is funded from. Excluded cost centers self-fund (PRD §4.4.B). */
export type GrantFundingSource = 'enterprise_envelope' | 'own_budget';

// ---------------------------------------------------------------------------
// A proposed grant (FR13).
// ---------------------------------------------------------------------------

export interface MeteredGrant {
  readonly entity: EntityRef;
  /** The resolved binding constraint (on the PROJECTED basis) this grant raises. */
  readonly binding: BindingConstraint;
  /** Most-specific lever: individual override (near-ULB) or CC-budget raise (near-cap). */
  readonly lever: MeteredGrantLever;
  /** The delta that covers projected remaining demand: max(0, projectedUsed - limit). */
  readonly neededDeltaCredits: number;
  readonly neededDeltaUsd: number;
  /** Actually granted: min(needed, maxGrantPerEntity, remaining envelope) (own-funded grants ignore the envelope). */
  readonly grantedDeltaCredits: number;
  readonly grantedDeltaUsd: number;
  readonly fullyFunded: boolean;
  readonly fundingSource: GrantFundingSource;
  /** FR14: consumption the grant actually unlocks = min(P, limit+granted) - min(P, limit). */
  readonly billDeltaCredits: number;
  readonly billDeltaUsd: number;
}

/**
 * FR13 flagged case: the binding constraint is the ENTERPRISE budget itself.
 * Raising it is policy+approval-only, so it is surfaced as a recommendation,
 * NEVER an allocation, and NEVER draws from the envelope. Typed distinctly from
 * MeteredGrant so a consumer (or reviewer) cannot mistake it for an auto-grant.
 */
export interface FlaggedEnterpriseRaise {
  readonly entity: EntityRef;
  readonly binding: BudgetBound;
  /** The shortfall an enterprise-budget raise would have to cover. */
  readonly neededDeltaCredits: number;
  readonly neededDeltaUsd: number;
  readonly reason: string;
}

export interface MeteredRebalancePlan {
  readonly trigger: MeteredTrigger;
  readonly envelope: MeteredEnvelope;
  /** Proposed grants, ranked (blocked first, then proximity, then name). */
  readonly grants: readonly MeteredGrant[];
  /** Enterprise-bound (and org-bound) entities that require policy approval, not auto-grants. */
  readonly flaggedEnterpriseRaises: readonly FlaggedEnterpriseRaise[];
  /** Count of blocking-at-risk entities the allocator considered. */
  readonly atRiskConsidered: number;
  /** Grants fully funded (the "N" in "N of M funded"). */
  readonly fundedCount: number;
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

export interface MeteredRebalanceInput {
  readonly controls: readonly ControlState[];
  /** Cycle-to-date usage. */
  readonly currentUsage: UsageState;
  /**
   * Projected end-of-cycle usage (metered grows). MUST carry projected
   * enterprise metered forward (see bindingConstraint.ts's overlay note) so
   * enterprise headroom is not overstated.
   */
  readonly projectedUsage: UsageState;
  /**
   * The candidate entity set to consider. The CALLER curates it to avoid
   * double-counting: pass a cost center OR its individual members, never both,
   * since a member's metered draw rolls up into its cost center's aggregate.
   */
  readonly entities: readonly EntityRef[];
  /** FR11 gate: metered phase must be active (pool exhausted). Pure engines can't infer the phase, so it is explicit. */
  readonly meteredPhaseActive: boolean;
  /** FR12 reserve buffer, credits. Default {@link DEFAULT_RESERVE_CREDITS}. */
  readonly reserveCredits?: number;
  /** At-risk threshold; default {@link AT_RISK_THRESHOLD_PCT} (0.95). */
  readonly thresholdPct?: number;
  /** FR13 per-entity grant cap, credits. Default {@link DEFAULT_MAX_GRANT_PER_ENTITY_CREDITS}. */
  readonly maxGrantPerEntityCredits?: number;
}

// ---------------------------------------------------------------------------
// Helpers (pure).
// ---------------------------------------------------------------------------

const usd = creditsToUsd;

function enterpriseBudget(controls: readonly ControlState[], enterpriseName: string): BudgetControl | undefined {
  return controls.find(
    (c): c is BudgetControl => c.kind === 'budget' && c.scope === 'enterprise' && c.entityName === enterpriseName,
  );
}

/** remaining_enterprise = enterprise spending-limit amount - current enterprise metered (0 if no limit). */
function enterpriseRemainingCredits(input: MeteredRebalanceInput): number {
  const budget = enterpriseBudget(input.controls, input.currentUsage.enterprise.entityName);
  if (!budget) return 0;
  return budget.amountCredits - input.currentUsage.enterprise.meteredCreditsUsed;
}

function enterpriseLimitCredits(input: MeteredRebalanceInput): number {
  return enterpriseBudget(input.controls, input.currentUsage.enterprise.entityName)?.amountCredits ?? 0;
}

/** The entity's metered draw in a given usage snapshot (0 when absent). */
function entityMetered(usage: UsageState, entity: EntityRef): number {
  if (entity.kind === 'user') {
    return usage.users.find((u) => u.userLogin === entity.userLogin)?.meteredCreditsUsed ?? 0;
  }
  return usage.costCenters.find((cc) => cc.costCenterName === entity.costCenterName)?.meteredCreditsUsed ?? 0;
}

/** The entity's cost center (its own name, or a user's membership); null for an unassigned user. */
function entityCostCenter(entity: EntityRef): string | null {
  return entity.kind === 'user' ? entity.costCenterName : entity.costCenterName;
}

function isExcludedCostCenter(controls: readonly ControlState[], costCenterName: string | null): boolean {
  if (costCenterName === null) return false;
  const cc = controls.find((c) => c.kind === 'cost_center' && c.name === costCenterName);
  return cc?.kind === 'cost_center' ? cc.excludedFromEnterpriseBudget : false;
}

/** The used side of a binding (projected basis): a ULB's total draw, a budget's metered draw. */
function bindingUsed(binding: BindingConstraint): number {
  switch (binding.type) {
    case 'ulb-bound':
      return binding.usedCredits;
    case 'budget-bound':
      return binding.meteredUsedCredits;
    case 'cap-bound':
      return binding.poolDrawCredits;
  }
}

function bindingLimit(binding: BindingConstraint): number {
  switch (binding.type) {
    case 'ulb-bound':
      return binding.limitCredits;
    case 'budget-bound':
      return binding.limitCredits;
    case 'cap-bound':
      return binding.computedLimitCredits;
  }
}

/**
 * ALERT-ONLY RULING (FR11 / CLAUDE.md §5). At-risk *of blocking* requires the
 * binding to actually hard-stop. A ULB always hard-stops (both phases). A
 * spending limit hard-stops only when preventFurtherUsage is on (limits default
 * to alert-only). An alert-only binding won't block the user -- usage flows on
 * and bills -- so the rebalancer, whose job is to keep people UNBLOCKED, does
 * NOT treat such an entity as at-risk and never grants it headroom (a grant
 * would relieve a ceiling that isn't stopping anyone). A cap only reaches here
 * defensively (caps don't bind in the metered phase, per 6.1's candidate set).
 */
function bindingHardStops(binding: BindingConstraint): boolean {
  switch (binding.type) {
    case 'ulb-bound':
      return true;
    case 'budget-bound':
      return binding.hardStop;
    case 'cap-bound':
      return binding.capOverflow === 'block';
  }
}

interface Resolved {
  readonly entity: EntityRef;
  readonly binding: BindingConstraint;
  readonly utilization: number;
  /** at-risk of BLOCKING: >= threshold utilization AND the binding hard-stops. */
  readonly blockingAtRisk: boolean;
  readonly projectedBlocked: boolean;
  readonly excluded: boolean;
  readonly meteredCurrent: number;
  readonly meteredProjected: number;
}

/** Resolve every candidate entity against the PROJECTED basis (the trigger/allocation basis). */
function resolveEntities(input: MeteredRebalanceInput): Resolved[] {
  const thresholdPct = input.thresholdPct ?? AT_RISK_THRESHOLD_PCT;
  const resolved: Resolved[] = [];
  for (const entity of input.entities) {
    const r = resolveBindingConstraint(entity, {
      controls: input.controls,
      currentUsage: input.currentUsage,
      projectedUsage: input.projectedUsage,
      phase: 'metered',
      thresholdPct,
    });
    const eff = effectiveResolution(r);
    if (eff.binding === null) continue; // unconstrained -> nothing to protect or grant
    const blockingAtRisk = eff.status.atRisk && bindingHardStops(eff.binding);
    resolved.push({
      entity,
      binding: eff.binding,
      utilization: eff.status.utilization,
      blockingAtRisk,
      projectedBlocked: eff.status.blocked,
      excluded: isExcludedCostCenter(input.controls, entityCostCenter(entity)),
      meteredCurrent: entityMetered(input.currentUsage, entity),
      meteredProjected: entityMetered(input.projectedUsage, entity),
    });
  }
  return resolved;
}

/** FR12 held segment: Σ projected FURTHER metered of non-at-risk, NON-excluded entities. */
function computeHeldCredits(resolved: readonly Resolved[]): number {
  let held = 0;
  for (const r of resolved) {
    if (r.blockingAtRisk || r.excluded) continue;
    held += Math.max(0, r.meteredProjected - r.meteredCurrent);
  }
  return held;
}

/** Rank blocking-at-risk entities: blocked first, then proximity (utilization desc), then a stable name tiebreak. */
function rankAtRisk(a: Resolved, b: Resolved): number {
  if (a.projectedBlocked !== b.projectedBlocked) return a.projectedBlocked ? -1 : 1;
  if (a.utilization !== b.utilization) return b.utilization - a.utilization;
  return entityKey(a.entity).localeCompare(entityKey(b.entity));
}

function entityKey(entity: EntityRef): string {
  return entity.kind === 'user' ? `user:${entity.userLogin}` : `cc:${entity.costCenterName}`;
}

/** The most-specific grant lever for a grantable binding; null for the enterprise/org flagged case. */
function grantLeverFor(binding: BindingConstraint): MeteredGrantLever | null {
  if (binding.type === 'ulb-bound') return binding.grantLever; // surgical individual override by default
  if (binding.type === 'budget-bound' && binding.spendingLimitScope === 'cost_center') {
    return { kind: 'cost_center_budget_raise', costCenterName: binding.entityName };
  }
  return null; // enterprise / organization -> flagged, not grantable here
}

/** Consumption unlocked by raising `limit` by `granted`, given projected demand `used`. */
function billDeltaCredits(used: number, limit: number, granted: number): number {
  return Math.min(used, limit + granted) - Math.min(used, limit);
}

// ---------------------------------------------------------------------------
// FR11-FR13: evaluate the rebalance (trigger + envelope + allocation).
// ---------------------------------------------------------------------------

export function evaluateMeteredRebalance(input: MeteredRebalanceInput): MeteredRebalancePlan {
  const reserveCredits = input.reserveCredits ?? DEFAULT_RESERVE_CREDITS;
  const maxGrant = input.maxGrantPerEntityCredits ?? DEFAULT_MAX_GRANT_PER_ENTITY_CREDITS;

  const resolved = resolveEntities(input);
  const atRisk = resolved.filter((r) => r.blockingAtRisk).sort(rankAtRisk);

  const baseRemaining = enterpriseRemainingCredits(input);
  const held = computeHeldCredits(resolved);
  const allocatable = Math.max(0, baseRemaining - reserveCredits - held);

  // --- Trigger (FR11): all three conditions ---
  const higherScopeHeadroom = baseRemaining - reserveCredits > 0;
  const conditions: TriggerCondition[] = [
    {
      met: input.meteredPhaseActive,
      label: 'Metered phase active',
      detail: input.meteredPhaseActive ? 'Pool exhausted; usage is billing at $0.01/credit.' : 'Still in the pooled phase.',
    },
    {
      met: atRisk.length > 0,
      label: 'Entity at or above metered cap',
      detail:
        atRisk.length > 0
          ? `${atRisk.length} entit${atRisk.length === 1 ? 'y' : 'ies'} ≥ ${Math.round(
              (input.thresholdPct ?? AT_RISK_THRESHOLD_PCT) * 100,
            )}% of a hard-stop metered cap.`
          : 'No entity is at risk of a metered block.',
    },
    {
      met: higherScopeHeadroom,
      label: 'Higher-scope headroom exists',
      detail: higherScopeHeadroom
        ? `Enterprise budget has ${usd(baseRemaining - reserveCredits)} allocatable above reserve.`
        : 'Enterprise budget has no headroom to redistribute.',
    },
  ];
  const fired = conditions.every((c) => c.met);

  // --- Allocate (FR13): greedy by rank against the hard envelope ---
  const grants: MeteredGrant[] = [];
  const flaggedEnterpriseRaises: FlaggedEnterpriseRaise[] = [];
  let remainingEnvelope = allocatable;
  let grantedFromEnvelope = 0;

  for (const r of atRisk) {
    const used = bindingUsed(r.binding);
    const limit = bindingLimit(r.binding);
    const needed = Math.max(0, used - limit);

    const lever = grantLeverFor(r.binding);
    if (lever === null) {
      // Enterprise/org-bound: policy+approval-only. Flag, never allocate.
      const b = r.binding as BudgetBound;
      flaggedEnterpriseRaises.push({
        entity: r.entity,
        binding: b,
        neededDeltaCredits: needed,
        neededDeltaUsd: usd(needed),
        reason:
          b.spendingLimitScope === 'enterprise'
            ? 'Binding constraint is the enterprise budget itself; raising it is policy + approval only.'
            : 'Organization-scope redistribution is not attributed by the resolver (6.1 boundary).',
      });
      continue;
    }

    const ownFunded = r.excluded; // excluded CCs self-fund; never touch the shared envelope
    const cap = ownFunded ? maxGrant : Math.min(maxGrant, remainingEnvelope);
    const granted = Math.max(0, Math.min(needed, cap));
    const bill = billDeltaCredits(used, limit, granted);

    if (!ownFunded) {
      remainingEnvelope -= granted;
      grantedFromEnvelope += granted;
    }

    grants.push({
      entity: r.entity,
      binding: r.binding,
      lever,
      neededDeltaCredits: needed,
      neededDeltaUsd: usd(needed),
      grantedDeltaCredits: granted,
      grantedDeltaUsd: usd(granted),
      fullyFunded: granted >= needed,
      fundingSource: ownFunded ? 'own_budget' : 'enterprise_envelope',
      billDeltaCredits: bill,
      billDeltaUsd: usd(bill),
    });
  }

  // slack via base - reserve - held - granted (NOT allocatable - granted) so the
  // segment invariant holds even when reserve+held overrun the base (slack < 0).
  const slack = baseRemaining - reserveCredits - held - grantedFromEnvelope;

  const envelope: MeteredEnvelope = {
    baseRemainingCredits: baseRemaining,
    baseRemainingUsd: usd(baseRemaining),
    reserveCredits,
    reserveUsd: usd(reserveCredits),
    heldCredits: held,
    heldUsd: usd(held),
    allocatableCredits: allocatable,
    allocatableUsd: usd(allocatable),
    grantedCredits: grantedFromEnvelope,
    grantedUsd: usd(grantedFromEnvelope),
    slackCredits: slack,
    slackUsd: usd(slack),
  };

  return {
    trigger: { fired, conditions, atRiskCount: atRisk.length },
    envelope,
    grants,
    flaggedEnterpriseRaises,
    atRiskConsidered: atRisk.length,
    fundedCount: grants.filter((g) => g.fullyFunded).length,
  };
}

// ---------------------------------------------------------------------------
// FR14: metered simulation of a (possibly edited) grant set.
// ---------------------------------------------------------------------------

/** A grant to simulate: the entity, the (possibly admin-edited) delta, and its funding source. */
export interface MeteredGrantSpec {
  readonly entity: EntityRef;
  readonly grantedDeltaCredits: number;
  readonly fundingSource: GrantFundingSource;
}

export interface MeteredSimulation {
  /** Entities that stay UNBLOCKED after the grants (projected demand fits the raised limit). */
  readonly unblockedEntities: readonly EntityRef[];
  readonly unblockedCount: number;
  /** Projected end-of-cycle enterprise metered = current + held + Σ enterprise-funded bill delta. */
  readonly projectedTotalMeteredCredits: number;
  readonly projectedTotalMeteredUsd: number;
  /** Enterprise budget limit - projected total metered (consistent with the envelope). */
  readonly remainingEnterpriseHeadroomCredits: number;
  readonly remainingEnterpriseHeadroomUsd: number;
  /** FR14 hero: Σ bill delta over ALL grants (what the invoice actually gains). */
  readonly billDeltaCredits: number;
  readonly billDeltaUsd: number;
  /** Bill delta split by funding source (excluded-CC grants bill against their own budget). */
  readonly billDeltaEnterpriseCredits: number;
  readonly billDeltaOwnFundedCredits: number;
}

/**
 * Turn a plan's grants into a simulate-ready spec set (the identity edit: no
 * changes). An admin edit is just this list with one entry's
 * grantedDeltaCredits changed before re-simulating.
 */
export function grantSpecsFromPlan(plan: MeteredRebalancePlan): MeteredGrantSpec[] {
  return plan.grants.map((g) => ({
    entity: g.entity,
    grantedDeltaCredits: g.grantedDeltaCredits,
    fundingSource: g.fundingSource,
  }));
}

export function simulateMeteredGrants(
  input: MeteredRebalanceInput,
  grants: readonly MeteredGrantSpec[],
): MeteredSimulation {
  const resolved = resolveEntities(input);
  const byKey = new Map(resolved.map((r) => [entityKey(r.entity), r]));

  const held = computeHeldCredits(resolved);
  const currentEnterpriseMetered = input.currentUsage.enterprise.meteredCreditsUsed;

  const unblockedEntities: EntityRef[] = [];
  let billDeltaEnterprise = 0;
  let billDeltaOwnFunded = 0;

  for (const spec of grants) {
    const r = byKey.get(entityKey(spec.entity));
    if (!r) continue; // a spec for an entity outside the candidate set contributes nothing
    const used = bindingUsed(r.binding);
    const limit = bindingLimit(r.binding);
    const g = spec.grantedDeltaCredits;
    const bill = billDeltaCredits(used, limit, g);

    if (used <= limit + g) unblockedEntities.push(r.entity); // projected demand now fits
    if (spec.fundingSource === 'own_budget') billDeltaOwnFunded += bill;
    else billDeltaEnterprise += bill;
  }

  const projectedTotalMetered = currentEnterpriseMetered + held + billDeltaEnterprise;
  const remainingHeadroom = enterpriseLimitCredits(input) - projectedTotalMetered;
  const billDeltaTotal = billDeltaEnterprise + billDeltaOwnFunded;

  return {
    unblockedEntities,
    unblockedCount: unblockedEntities.length,
    projectedTotalMeteredCredits: projectedTotalMetered,
    projectedTotalMeteredUsd: usd(projectedTotalMetered),
    remainingEnterpriseHeadroomCredits: remainingHeadroom,
    remainingEnterpriseHeadroomUsd: usd(remainingHeadroom),
    billDeltaCredits: billDeltaTotal,
    billDeltaUsd: usd(billDeltaTotal),
    billDeltaEnterpriseCredits: billDeltaEnterprise,
    billDeltaOwnFundedCredits: billDeltaOwnFunded,
  };
}
