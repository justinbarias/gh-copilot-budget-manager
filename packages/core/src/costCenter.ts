export type HeadroomTone = 'ok' | 'low' | 'negative';

export type CostCenterStatus = 'within' | 'over-cap' | 'excluded';

// "Low headroom" boundary from the design prototype's cost-center table seed
// logic (design/*.dc.html: amber when 0 <= headroom < 8000) -- an absolute
// credit amount, not a fraction of the cap.
export const LOW_HEADROOM_THRESHOLD_CREDITS = 8_000;

// The included-usage cap's computed limit is GitHub-derived from attributed
// licenses and never settable (CLAUDE.md §5) -- callers pass it through
// read-only; only the remaining headroom is ours to derive.
export function includedCapHeadroom(computedLimitCredits: number, mtdBurnCredits: number): number {
  return computedLimitCredits - mtdBurnCredits;
}

export function classifyHeadroom(headroomCredits: number, lowThresholdCredits: number): HeadroomTone {
  if (headroomCredits < 0) return 'negative';
  if (headroomCredits < lowThresholdCredits) return 'low';
  return 'ok';
}

// Prototype precedence: excluded-from-enterprise-budget wins, then over-cap
// (strictly negative headroom), else within.
export function costCenterStatus(excludedFromEnterpriseBudget: boolean, headroomCredits: number): CostCenterStatus {
  if (excludedFromEnterpriseBudget) return 'excluded';
  if (headroomCredits < 0) return 'over-cap';
  return 'within';
}
