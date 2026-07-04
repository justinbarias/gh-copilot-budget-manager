// CLAUDE.md §5: three ULB scopes, most-specific wins -- Individual > Cost-center
// (CCULB) > Universal. A ULB is always a hard stop in both phases; a $0 ULB
// blocks immediately.
export type UlbScope = 'individual' | 'cost-center' | 'universal';

export interface EffectiveUlb {
  amountCredits: number;
  scope: UlbScope;
}

// The minimal shape core needs to resolve precedence -- write-surface fields
// (prevent_further_usage, alerting, etc.) are packages/data's concern; this is
// deliberately narrower than the wire Budget type so this function stays pure
// and testable without importing anything from packages/data.
export interface UlbCandidate {
  scope: 'individual' | 'multi_user_cost_center' | 'universal';
  entityName: string; // login for individual, cost-center name for CCULB, ignored for universal
  amountCredits: number;
}

// Most-specific wins: an individual override replaces the cost-center and
// universal ULB for that one person (CLAUDE.md §5, design/README.md's ULB
// modal: "Most specific wins."). Returns null only if no budget exists at any
// scope that applies to this user.
export function resolveEffectiveUlb(
  userLogin: string,
  costCenterName: string | null,
  candidates: readonly UlbCandidate[],
): EffectiveUlb | null {
  const individual = candidates.find((c) => c.scope === 'individual' && c.entityName === userLogin);
  if (individual) return { amountCredits: individual.amountCredits, scope: 'individual' };

  if (costCenterName !== null) {
    const cculb = candidates.find((c) => c.scope === 'multi_user_cost_center' && c.entityName === costCenterName);
    if (cculb) return { amountCredits: cculb.amountCredits, scope: 'cost-center' };
  }

  const universal = candidates.find((c) => c.scope === 'universal');
  if (universal) return { amountCredits: universal.amountCredits, scope: 'universal' };

  return null;
}

// Simplification vs. the design prototype, flagged per Task 2.4's build notes:
// the prototype's "at risk" bucket (design/*.dc.html's `u.block = used>3500`) is
// a hardcoded per-row demo flag, not derived from any real ULB comparison, and
// real "approaching the limit" forecasting needs run-rate/days-to-exhaustion
// data that doesn't exist until Phase 4. Until then this is a factual,
// non-forecast proxy: a user is "at risk" once they've consumed at least this
// fraction of their effective ULB (90% mirrors the alert-threshold convention
// already used on the Controls budget rows, design/*.dc.html's `alerting:'90%'`
// seeds), or immediately if their ULB is $0 (always blocked -- CLAUDE.md §5).
export const ULB_AT_RISK_UTILIZATION_THRESHOLD = 0.9;

export function isUserAtRiskOfUlbBlock(creditsUsed: number, effectiveUlb: EffectiveUlb | null): boolean {
  if (effectiveUlb === null) return false;
  if (effectiveUlb.amountCredits <= 0) return true;
  return creditsUsed / effectiveUlb.amountCredits >= ULB_AT_RISK_UTILIZATION_THRESHOLD;
}
