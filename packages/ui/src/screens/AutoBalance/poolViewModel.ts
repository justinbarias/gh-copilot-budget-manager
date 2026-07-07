import {
  computeFundingEnvelope,
  entityKey,
  simulatePoolRebalance,
  type EntityRef,
  type FundingEnvelope,
  type GrantFundingStatus,
  type PoolGrant,
  type PoolRebalanceContext,
  type PoolRebalancePlan,
  type PoolRebalanceSimulation,
} from '@copilot-budget/core';
import type { PoolRebalanceContextDto } from '@copilot-budget/data';

// ============================================================================
// Task 6.8 -- the pool-mode view model. EVERY number on screen traces to a
// unit-tested core function (Checkpoint 6): this module only (a) rehydrates
// the bridge DTO's ISO date strings, (b) maps the admin's row edits onto the
// engine's own PoolGrant shape, and (c) re-invokes the SAME pure core
// functions (simulatePoolRebalance / computeFundingEnvelope) the engine-proof
// tests pin -- it never re-derives money math of its own. Cheap by design
// (pure, in-renderer), so every keystroke recomputes live with no IPC.
// ============================================================================

/** Renderer-side hydration of the bridge DTO (mirrored verbatim by the STEP-ONE
 *  integration test in packages/data/src/api-client/rebalance-context.test.ts). */
export function hydratePoolContext(dto: PoolRebalanceContextDto): PoolRebalanceContext {
  return {
    controls: dto.controls,
    currentUsage: dto.currentUsage,
    projectedUsage: dto.projectedUsage,
    poolTotalCredits: dto.poolTotalCredits,
    poolConsumedCredits: dto.poolConsumedCredits,
    projectedPoolConsumedCredits: dto.projectedPoolConsumedCredits,
    projectedPoolConsumedP90Credits: dto.projectedPoolConsumedP90Credits,
    asOfDate: new Date(`${dto.asOfDate}T00:00:00.000Z`),
    cycleEndDate: new Date(`${dto.cycleEndDate}T00:00:00.000Z`),
  };
}

/**
 * The admin's staged edits (design state note: `abAlloc` keyed `mode:entityId`
 * -- here the pool mode's slice, keyed by the engine's own row identities).
 * Grant edits are proposed-delta overrides per ULB-grant row (userLogin);
 * lifted caps are on/off per cap-relax row (entityKey) -- STRUCTURALLY no
 * number can be attached to a cap row (CLAUDE.md §5).
 */
export interface PoolEdits {
  readonly grantEdits: Readonly<Record<string, number>>;
  readonly liftedCaps: Readonly<Record<string, boolean>>;
}

export const NO_EDITS: PoolEdits = { grantEdits: {}, liftedCaps: {} };

export interface PoolDerived {
  /** The (possibly edited) grant set, statuses refreshed per row. */
  readonly grants: readonly PoolGrant[];
  /** Envelope with its `grants` segment sized to the edited allocation (engine invariant: segments sum to remaining pool). */
  readonly envelope: FundingEnvelope;
  /** Engine simulation of the edited set (+ lifted-cap pool draw via the core's cap-contribution channel). */
  readonly sim: PoolRebalanceSimulation;
  /** Sigma unlockContribution of caps toggled ON. */
  readonly capUnlockTotal: number;
  readonly fundedCount: number;
  readonly overAllocated: boolean;
}

function statusFor(funded: number, desired: number): GrantFundingStatus {
  return funded >= desired ? 'funded' : funded > 0 ? 'partial' : 'unfunded';
}

/** Re-run the pure engine over the edited rows (the live-recompute path). */
export function derivePool(plan: PoolRebalancePlan, ctx: PoolRebalanceContext, edits: PoolEdits): PoolDerived {
  const grants = plan.allocation.grants.map((g) => {
    const edited = edits.grantEdits[g.userLogin];
    if (edited === undefined) return g;
    const funded = Math.max(0, Math.round(edited));
    return {
      ...g,
      fundedCredits: funded,
      newLimitCredits: g.currentLimitCredits + funded,
      status: statusFor(funded, g.grantCredits),
    };
  });

  const capUnlockTotal = plan.allocation.capRelax.reduce(
    (sum, r) => sum + (edits.liftedCaps[entityKey(r.entity)] ? r.unlockContributionCredits : 0),
    0,
  );

  // plan.allocation.envelope.envelopeCredits is the FIXED grantable amount
  // (independent of how much is allocated), so it's the right over-allocation
  // basis for the verdict; capUnlockTotal rides the core's dedicated
  // cap-contribution channel (afterConsumed/tip only -- never the verdict).
  const sim = simulatePoolRebalance(grants, ctx, plan.allocation.envelope, capUnlockTotal);
  const envelope = computeFundingEnvelope(ctx, plan.resolutions, sim.totalGrantedCredits);

  return {
    grants,
    envelope,
    sim,
    capUnlockTotal,
    fundedCount: grants.filter((g) => g.status === 'funded').length,
    overAllocated: sim.verdict === 'over-allocated',
  };
}

// ---------------------------------------------------------------------------
// Display formatting (presentation only -- no derived money math).
// ---------------------------------------------------------------------------

export function fmt(credits: number): string {
  return Math.round(credits).toLocaleString('en-US');
}

export function pct1(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** "user: login" / "CC: name" -- the design's entity column convention. */
export function entityLabel(entity: EntityRef): string {
  return entity.kind === 'user' ? `user: ${entity.userLogin}` : `CC: ${entity.costCenterName}`;
}
