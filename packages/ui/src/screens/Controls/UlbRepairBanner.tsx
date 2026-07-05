import type { UlbRepairCandidate } from '@copilot-budget/core';
import './UlbRepairBanner.css';

// Task 4.14 (PRD FR3 / CLAUDE.md §5's ULB display-bug domain fact):
// design/README.md §3's violet repair banner, User-level family tab only.
// Markup/copy/colors matched to design/*.dc.html's own ulbBugShown block
// (violet-to-amber gradient, #9350ff border, #c9a3ff glyph, blue "View &
// edit" button, red "Delete the $0 ULB" button) -- purely presentational;
// Controls.tsx owns every piece of state (the candidate derivation from
// getControls(), the session-only dismissal, and what each action does).
//
// This renders whichever action(s) the CURRENT candidate set actually
// supports -- "View & edit via API" only appears if a display_bug_hidden
// candidate exists, "Delete the $0 ULB" only if an orphaned_zero one does.
// Both happen to exist in the shipped DEWR fixture world (2 candidates,
// matching the design brief's own "2 orphaned" copy verbatim), but the
// component doesn't assume that -- see Controls.tsx for how each button is
// wired to the specific candidate it acts on (the first of its kind; see
// that file's build note on why "first" is the documented, current
// limitation rather than a per-candidate action list).
export interface UlbRepairBannerProps {
  /** The FULL detected set (never the filtered/paginated table view -- CLAUDE.md's UI-honesty rule). */
  candidates: readonly UlbRepairCandidate[];
  onViewAndEdit: (candidate: UlbRepairCandidate) => void;
  onDeleteZeroUlb: (candidate: UlbRepairCandidate) => void;
  onDismiss: () => void;
}

export function UlbRepairBanner({ candidates, onViewAndEdit, onDeleteZeroUlb, onDismiss }: UlbRepairBannerProps) {
  if (candidates.length === 0) return null;

  const viewEditCandidate = candidates.find((c) => c.kind === 'display_bug_hidden');
  const deleteCandidate = candidates.find((c) => c.kind === 'orphaned_zero');
  const count = candidates.length;

  return (
    <div className="ulb-repair-banner" role="status">
      <span className="ulb-repair-banner__glyph" aria-hidden="true">
        ⚠
      </span>
      <div className="ulb-repair-banner__body">
        <div className="ulb-repair-banner__title">
          {count} orphaned user-level budget{count === 1 ? '' : 's'} detected — in the API, invisible in GitHub's UI
        </div>
        <p className="ulb-repair-banner__text">
          A known GitHub display bug hides these from the "Budgets and alerts" list, blocking edit/delete there
          {deleteCandidate && (
            <>
              {' '}
              — one is a <span className="mono">$0</span> ULB that hard-blocks its owner immediately
            </>
          )}
          . This tool reads the API's authoritative list and offers the repair the native UI can't.
        </p>
        <div className="ulb-repair-banner__actions">
          {viewEditCandidate && (
            <button type="button" className="ulb-repair-banner__view-btn" onClick={() => onViewAndEdit(viewEditCandidate)}>
              View &amp; edit via API
            </button>
          )}
          {deleteCandidate && (
            <button type="button" className="ulb-repair-banner__delete-btn" onClick={() => onDeleteZeroUlb(deleteCandidate)}>
              Delete the $0 ULB
            </button>
          )}
        </div>
      </div>
      <button type="button" className="ulb-repair-banner__dismiss" aria-label="Dismiss orphaned ULB notice" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
