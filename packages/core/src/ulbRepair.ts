import { controlIdentity, isUlbScope, type ControlState, type UlbBudgetScope } from './controls.js';

// CLAUDE.md §5 / PRD FR3 / §1.4: GitHub's native "Budgets and alerts" UI has a
// known display bug -- a ULB can exist in the API's authoritative budget list
// while never appearing in that list view, blocking edit/delete there. A
// SEPARATE, real incident pattern from the same section: an accidental $0
// ULB (any scope) hard-blocks its owner(s) immediately and is easy to leave
// behind unnoticed. This module is the pure detector behind the Controls
// screen's violet "N orphaned user-level budgets detected" repair banner
// (design/README.md §3, Task 4.14) -- it takes the SAME ControlState[] the UI
// already holds from getControls() (no dedicated fetch, no new bridge method)
// and classifies which ULBs are repair candidates, and why.
//
// Two DIFFERENT kinds, deliberately not collapsed into one:
//   - 'display_bug_hidden': the UI-hides-it symptom. There is no real GitHub
//     field that reports this (the API wouldn't self-report its own UI's
//     bug) -- it rides BudgetControl.simulatedUiHidden, a simulation-only
//     enrichment (see that field's doc comment in controls.ts and
//     docs/api-surface-validation.md's enrichment entry for the honest
//     account of why this can only be detected in simulation today).
//   - 'orphaned_zero': a REAL, API-observable signal -- a $0 (or negative,
//     defensively) hard-stop ULB. This one fires identically live and in
//     simulation; no enrichment needed.
export type UlbRepairCandidateKind = 'display_bug_hidden' | 'orphaned_zero';

export interface UlbRepairCandidate {
  kind: UlbRepairCandidateKind;
  /** core's controlIdentity(control) -- round-trips straight into the UI's data-control-id row lookup. */
  id: string;
  scope: UlbBudgetScope;
  entityName: string;
  /** Human-readable justification, surfaced verbatim in the repair banner / audit trail. */
  reason: string;
}

// Deliberately a STRICTER threshold than validation.ts's
// DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS (100 credits / $1, a WARN-on-write
// heuristic for "this is suspiciously low"). Repair-candidacy is reserved
// for the harder, unambiguous "this ULB blocks its owner outright, right
// now, with zero headroom" case -- a $0 (or, defensively, negative) ULB --
// so the violet repair banner doesn't also light up for every legitimately
// low-but-nonzero individual override (e.g. a $19 throttled-contractor ULB),
// which would dilute "orphaned" into "merely small".
const ORPHANED_ZERO_THRESHOLD_CREDITS = 0;

// Pure (CLAUDE.md §2: core has no I/O). Takes the full ControlState list and
// internally narrows to ULB-scoped budgets (never spending limits, caps, or
// cost centers) -- so the UI just hands it the same getControls() result the
// Controls tab already fetched, with no second identity scheme or projection
// to keep in sync. Order is preserved from the input (getControls returns
// budgets in the wire list's own deterministic order); a caller that needs a
// specific display order sorts before or after calling this.
export function detectUlbRepairCandidates(controls: readonly ControlState[]): UlbRepairCandidate[] {
  const candidates: UlbRepairCandidate[] = [];

  for (const control of controls) {
    // Only ULB-scoped budgets are repair candidates -- spending limits
    // (Family B), included-usage caps, and cost centers are structurally
    // excluded here rather than relying on "they happen not to be $0/hidden".
    if (control.kind !== 'budget' || !isUlbScope(control.scope)) continue;
    const scope: UlbBudgetScope = control.scope;
    const id = controlIdentity(control);

    // display_bug_hidden takes precedence over orphaned_zero for the same
    // control (a hidden budget that also happens to be $0 is still
    // fundamentally a "the UI can't see this" problem first) -- `continue`
    // guarantees a control is classified at most once, never both.
    if (control.simulatedUiHidden) {
      candidates.push({
        kind: 'display_bug_hidden',
        id,
        scope,
        entityName: control.entityName,
        reason: `Present in the API, invisible in GitHub's "Budgets and alerts" list — a known GitHub UI display bug (${control.entityName}).`,
      });
      continue;
    }

    if (control.amountCredits <= ORPHANED_ZERO_THRESHOLD_CREDITS && control.preventFurtherUsage) {
      candidates.push({
        kind: 'orphaned_zero',
        id,
        scope,
        entityName: control.entityName,
        reason: `$0 hard-stop ULB (${control.entityName}) — blocks immediately; no owner intent recorded, likely orphaned.`,
      });
    }
  }

  return candidates;
}
