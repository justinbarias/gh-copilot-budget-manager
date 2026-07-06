// Shared rebalancer trigger-condition chip (Tasks 6.2 + 6.5). Both the pool
// (poolRebalancer.ts) and metered (meteredRebalancer.ts) engines emit an ordered
// list of these as their trigger's per-condition breakdown, and the Phase-6.8/6.9
// Auto-balance UI renders both identically. Hoisted into one module (rather than
// each engine owning a same-shaped copy) so the two `export *` barrels re-export
// ONE name -- no TS2308 ambiguity -- and the UI has a single chip contract.
export interface TriggerCondition {
  /** Whether this condition is currently satisfied. */
  readonly met: boolean;
  /** Short chip label (e.g. "Near cycle end"). */
  readonly label: string;
  /** Human-readable justification with the concrete figures behind `met`. */
  readonly detail: string;
}
