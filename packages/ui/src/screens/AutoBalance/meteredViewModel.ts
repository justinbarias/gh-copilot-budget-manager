import {
  creditsToUsd,
  entityKey,
  simulateMeteredGrants,
  type BindingConstraint,
  type BudgetControl,
  type MeteredEnvelope,
  type MeteredGrant,
  type MeteredGrantSpec,
  type MeteredRebalanceInput,
  type MeteredRebalancePlan,
  type MeteredSimulation,
} from '@copilot-budget/core';
import type { MeteredRebalanceContextDto } from '@copilot-budget/data';

// ============================================================================
// Task 6.9 -- the metered-mode view model, the twin of poolViewModel.ts. Same
// discipline (Checkpoint 6): every number on screen traces to a unit-tested
// core function -- this module only (a) rehydrates the bridge DTO (a no-op
// here: the metered engine takes no Dates, see MeteredRebalanceContextDto's
// doc comment), (b) maps the admin's row edits onto the engine's own
// MeteredGrantSpec shape, and (c) re-invokes simulateMeteredGrants -- the SAME
// pure core function the engine-proof test pins -- plus one small, EXPLICITLY
// DOCUMENTED arithmetic re-derivation for the envelope's granted/slack
// segments (evaluateMeteredRebalance has no standalone "recompute the
// envelope from an edited grant set" export the way the pool engine's
// computeFundingEnvelope does; see deriveMetered's doc comment for why the
// formula used is the type's OWN declared invariant, not new business logic).
// ============================================================================

/**
 * Renderer-side hydration of the metered bridge DTO. Unlike hydratePoolContext,
 * this is an identity pass-through: MeteredRebalanceContextDto's own doc
 * comment notes the metered engine takes no Dates, so the DTO already IS a
 * MeteredRebalanceInput. Kept as a named function (not a raw cast) so the
 * renderer's hydration step reads symmetrically with the pool mode's, and so a
 * future date-bearing field on the DTO can't silently skip hydration.
 */
export function hydrateMeteredContext(dto: MeteredRebalanceContextDto): MeteredRebalanceInput {
  return {
    controls: dto.controls,
    currentUsage: dto.currentUsage,
    projectedUsage: dto.projectedUsage,
    entities: dto.entities,
    meteredPhaseActive: dto.meteredPhaseActive,
    reserveCredits: dto.reserveCredits,
  };
}

/**
 * The admin's staged edits (design state note: `abAlloc` keyed `mode:entityId`
 * -- here the metered slice, keyed by core's own `entityKey(entity)` so a
 * cost-center-budget-raise row and an individual-ULB row share one lookup
 * shape; unlike the pool slice there is no separate cap-toggle map -- the
 * metered engine's grant levers are all delta-bearing (CLAUDE.md §5: caps
 * don't bind in the metered phase). Values are CREDITS (the admin's dollar
 * keystrokes are converted before landing here -- see AutoBalance.tsx's
 * parseDeltaUsd), so this module never does its own $<->credits guessing.
 */
export interface MeteredEdits {
  readonly grantEdits: Readonly<Record<string, number>>;
}

export const NO_METERED_EDITS: MeteredEdits = { grantEdits: {} };

export type MeteredRowStatus = 'funded' | 'partial' | 'unfunded';

/** Same three-way mapping poolViewModel's local statusFor uses -- presentation only (not money math): which of funded/partial/unfunded a row's (possibly edited) grant reflects against its ORIGINAL needed delta. */
export function meteredGrantStatus(funded: number, desired: number): MeteredRowStatus {
  return funded >= desired ? 'funded' : funded > 0 ? 'partial' : 'unfunded';
}

/**
 * used/limit for a grantable binding (ulb-bound | budget-bound), the SAME
 * identity bindingConstraint.ts's own AtRiskStatus.utilization documents:
 * "utilization: used / limit ... (Infinity for a $0-limit with usage)". Both
 * grantable variants carry `remainingHeadroomCredits` under that exact field
 * name, so `used = limit - remainingHeadroom` needs no per-variant branch
 * beyond the cap-bound limit field's different name (defensive only -- a cap
 * never reaches a MeteredGrant row; caps don't bind in the metered phase, per
 * 6.1's candidate set).
 */
export function bindingUtilization(binding: BindingConstraint): number {
  const limit = binding.type === 'cap-bound' ? binding.computedLimitCredits : binding.limitCredits;
  if (limit <= 0) return Number.POSITIVE_INFINITY;
  return (limit - binding.remainingHeadroomCredits) / limit;
}

/** The enterprise budget's TOTAL amount (not remaining) -- the trigger sentence's "$8,000 budget" figure, mirroring meteredRebalancer.ts's own (non-exported) enterpriseBudget lookup over the SAME fields (kind/scope/entityName). Read-only display lookup, not a re-derivation of any money math (the amount is stored verbatim on the control). */
export function enterpriseBudgetTotalUsd(ctx: MeteredRebalanceInput): number {
  const control = ctx.controls.find(
    (c): c is BudgetControl => c.kind === 'budget' && c.scope === 'enterprise' && c.entityName === ctx.currentUsage.enterprise.entityName,
  );
  return control ? creditsToUsd(control.amountCredits) : 0;
}

export interface MeteredDerived {
  /** The (possibly edited) grant set, statuses refreshed per row. */
  readonly grants: readonly MeteredGrant[];
  /** Envelope with granted/slack resized to the edited allocation (reserve/held are FIXED -- see doc comment below). */
  readonly envelope: MeteredEnvelope;
  /** Engine simulation of the edited set (simulateMeteredGrants -- unchanged core call). */
  readonly sim: MeteredSimulation;
  readonly fundedCount: number;
  /** true iff the edited allocation has pushed the envelope's slack negative (the engine's own over-commitment signal -- MeteredEnvelope's doc comment). */
  readonly overAllocated: boolean;
}

/**
 * Re-run the pure engine over the edited rows (the live-recompute path),
 * mirroring poolViewModel's derivePool. `simulateMeteredGrants` is called
 * UNCHANGED -- it already recomputes the bill delta / unblocked / projected
 * metered / headroom from any grant spec set, so those four numbers are pure
 * core output with zero re-derivation here.
 *
 * The ENVELOPE's granted/slack segments have no equivalent standalone export
 * (evaluateMeteredRebalance always re-derives its OWN suggested allocation
 * from scratch rather than accepting an edited set the way the pool engine's
 * separate computeFundingEnvelope does). baseRemaining/reserve/held are FIXED
 * -- they come from resolveEntities' non-at-risk projection, which never
 * depends on how much is actually granted -- so only granted/slack need to
 * move, via the EXACT formula MeteredEnvelope's own doc comment declares as
 * its invariant: `slack = base - reserve - held - grantedFromEnvelope` (own-
 * funded/excluded-CC grants are, per that same doc comment, excluded from
 * `grantedFromEnvelope`). This is the type's documented contract, not a
 * hidden re-derivation of the allocator's business logic.
 */
export function deriveMetered(plan: MeteredRebalancePlan, ctx: MeteredRebalanceInput, edits: MeteredEdits): MeteredDerived {
  const grants = plan.grants.map((g) => {
    const edited = edits.grantEdits[entityKey(g.entity)];
    if (edited === undefined) return g;
    const granted = Math.max(0, Math.round(edited));
    return {
      ...g,
      grantedDeltaCredits: granted,
      grantedDeltaUsd: creditsToUsd(granted),
      fullyFunded: granted >= g.neededDeltaCredits,
    };
  });

  const grantSpecs: MeteredGrantSpec[] = grants.map((g) => ({
    entity: g.entity,
    grantedDeltaCredits: g.grantedDeltaCredits,
    fundingSource: g.fundingSource,
  }));
  const sim = simulateMeteredGrants(ctx, grantSpecs);

  const grantedFromEnvelope = grants.reduce(
    (sum, g) => sum + (g.fundingSource === 'enterprise_envelope' ? g.grantedDeltaCredits : 0),
    0,
  );
  const slackCredits =
    plan.envelope.baseRemainingCredits - plan.envelope.reserveCredits - plan.envelope.heldCredits - grantedFromEnvelope;

  const envelope: MeteredEnvelope = {
    ...plan.envelope,
    grantedCredits: grantedFromEnvelope,
    grantedUsd: creditsToUsd(grantedFromEnvelope),
    slackCredits,
    slackUsd: creditsToUsd(slackCredits),
  };

  return {
    grants,
    envelope,
    sim,
    fundedCount: grants.filter((g) => g.fullyFunded).length,
    overAllocated: slackCredits < 0,
  };
}

// ---------------------------------------------------------------------------
// Display formatting (presentation only -- no derived money math).
// ---------------------------------------------------------------------------

/** Whole-dollar display, matching design's $-denominated metered mode (the fixture's metered scenario is authored in whole dollars throughout). */
export function fmtUsd(usd: number): string {
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}
