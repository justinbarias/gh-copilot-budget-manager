import { classifyHeadroom, includedCapHeadroom, LOW_HEADROOM_THRESHOLD_CREDITS, type CapOverflow, type HeadroomTone } from '@copilot-budget/core';
import { formatCredits } from './Meter';
// Task 4.15: reuses ControlsTable.css's .controls-table__drift* classes for
// the "⤺ drift — reconcile" marker + staged-vs-drifted collision prompt --
// same cross-family reuse UlbTable.css already established for this file's
// sibling (importing rather than forking a second copy of the same rules).
import './ControlsTable.css';
import './IncludedCapsGrid.css';

// Included-usage caps family (Family C / Lever C -- design/README.md §3, Task
// 4.12): a responsive grid of per-cost-center cards. Deliberately the ONLY
// family surface with no editable amount anywhere -- CLAUDE.md §5: "the
// included-usage cap ... is NEVER a settable amount (auto-computed from
// attributed licenses)". The two knobs GitHub actually exposes are `enabled`
// and `overflow`; both are staged through Controls.tsx's `desiredCaps`
// overlay the exact same way UlbTable/ControlsTable stage BudgetControl
// edits, so this component reuses diffControls/PlanRail/the write engine's
// M7 PATCH unchanged (Controls.tsx wires the plumbing; this file is purely
// presentational, mirroring ControlsTable.tsx/UlbTable.tsx's split).
//
// "Drawn" + tone (green/amber/red) reuse the SAME core headroom convention
// the Cost Centers screen already established (CostCentersTable.tsx:
// includedCapHeadroom(computedLimitCredits, mtdBurnCredits) +
// classifyHeadroom + LOW_HEADROOM_THRESHOLD_CREDITS) rather than inventing a
// second, percentage-based banding rule for this screen alone -- the design
// prototype's own throwaway JS used a raw "drawn/computed >= 90%" cutoff, but
// that would make the SAME cost center report a different band here than on
// the Cost Centers screen it already ships on. mtdBurnCredits (not a
// separately-fetched pool-only figure) is deliberately what "drawn" reads:
// it's the identical field the Cost Centers screen's own headroom/status
// column already reads for these fixtures (msw/fixtures/costCenters.ts's
// per-CC comments cite the same absolute headroom figures, e.g. Data &
// Evaluation's +5,600), so the two screens can never show a cost center as
// "within" on one and "over cap" on the other.

export interface IncludedCapRowModel {
  /** core controlIdentity, e.g. `included_cap:Payments Integrity Engineering` -- also the card's data-control-id hook. */
  id: string;
  costCenterName: string;
  /** Effective (staged ?? live) enabled flag -- the only boolean this family ever writes. */
  enabled: boolean;
  /** Effective (staged ?? live) overflow choice -- the only other writable field. */
  overflow: CapOverflow;
  /** GitHub-computed, license-derived limit (CLAUDE.md §5) -- read-only, never part of any staged edit. */
  computedLimitCredits: number;
  /** Licenses attributed to this cost center -- the "funded by N licenses" count (listCostCenters' memberCount, never hardcoded). */
  memberCount: number;
  /** Cycle-to-date credits drawn against the cap (listCostCenters' mtdBurnCredits). */
  drawnCredits: number;
  /** Has a pending plan entry (enabled and/or overflow changed) -- matches the rail 1:1. */
  staged: boolean;
  /** Task 4.15: live moved out-of-band since the last explicit Sync Now. */
  drifted: boolean;
}

interface IncludedCapsGridProps {
  /** Already name-filtered by Controls.tsx -- this component only renders (matches ULB/Spending's "parent owns state" contract). */
  rows: IncludedCapRowModel[];
  onToggle: (id: string) => void;
  onOverflowChange: (id: string, overflow: CapOverflow) => void;
  /**
   * A2 resolved (2026-07-08/09 live + OpenAPI): NO per-CC overflow wire field
   * exists -- block-vs-metered at cap exhaustion is governed by the
   * enterprise "AI credit paid usage" policy. In LIVE mode the overflow
   * segment control renders disabled with that explanation; in SIMULATION it
   * stays the what-if lever the rebalancer scenarios use (maintainer
   * decision). Wired from Controls.tsx's existing api.getMode() read -- the
   * same signal the sim banner already keys off.
   */
  liveMode: boolean;
  /** "Controls scale features": free-text cost-center-name filter only -- no sort/pagination at 6 cards. */
  search: string;
  onSearchChange: (value: string) => void;
  /** Task 4.15: the one card id currently showing the staged-vs-drifted collision prompt, if any. */
  driftCollisionId: string | null;
  onReconcileDrift: (id: string) => void;
  onCancelDriftCollision: () => void;
}

const TONE_TO_BAR_CLASS: Record<HeadroomTone, string> = {
  ok: 'included-caps__bar-fill--green',
  low: 'included-caps__bar-fill--amber',
  negative: 'included-caps__bar-fill--red',
};

export function IncludedCapsGrid({
  rows,
  onToggle,
  onOverflowChange,
  liveMode,
  search,
  onSearchChange,
  driftCollisionId,
  onReconcileDrift,
  onCancelDriftCollision,
}: IncludedCapsGridProps) {
  return (
    <div className="included-caps" data-testid="controls-caps-family">
      <div className="included-caps__toolbar">
        <input
          className="included-caps__search"
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search cost center…"
          aria-label="Search included-usage caps"
        />
      </div>
      {rows.length === 0 && <p className="included-caps__empty">No cost centers match this search.</p>}
      <div className="included-caps__grid">
      {rows.map((row) => {
        const headroom = includedCapHeadroom(row.computedLimitCredits, row.drawnCredits);
        const tone = classifyHeadroom(headroom, LOW_HEADROOM_THRESHOLD_CREDITS);
        const over = headroom < 0;
        const pct = row.computedLimitCredits > 0 ? Math.min(100, Math.round((row.drawnCredits / row.computedLimitCredits) * 100)) : 100;

        const cardClass = [
          'included-caps__card',
          row.staged ? 'included-caps__card--staged' : '',
          !row.enabled ? 'included-caps__card--disabled' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div key={row.id} className={cardClass} data-control-id={row.id}>
            <div className="included-caps__header">
              <div className="included-caps__name-col">
                <div className="included-caps__name-row">
                  <span className="included-caps__name">{row.costCenterName}</span>
                  <span
                    className="included-caps__apionly-pill"
                    title="No native GitHub UI for this control — API-first only."
                  >
                    API-ONLY
                  </span>
                </div>
                <div className="included-caps__subtitle">Pool phase · caps shared-pool draw</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={row.enabled}
                aria-label={`Included-usage cap enabled — ${row.costCenterName}`}
                className={`included-caps__toggle ${row.enabled ? 'included-caps__toggle--on' : 'included-caps__toggle--off'}`}
                onClick={() => onToggle(row.id)}
              >
                <span className="included-caps__toggle-knob" aria-hidden="true" />
              </button>
            </div>

            <div className="included-caps__limit-row">
              <span className="included-caps__limit-value mono">≈{formatCredits(row.computedLimitCredits)}</span>
              <span className="included-caps__limit-sub">funded by {row.memberCount} licenses</span>
            </div>

            <div className="included-caps__bar-track">
              <div className={`included-caps__bar-fill ${TONE_TO_BAR_CLASS[tone]}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="included-caps__drawn-row mono">
              <span>{formatCredits(row.drawnCredits)} drawn</span>
              <span className={over ? 'included-caps__drawn-row--over' : ''}>
                {over ? 'over cap · overflowing' : `${pct}% of carve drawn`}
              </span>
            </div>

            <div className="included-caps__overflow-row">
              <span className="included-caps__overflow-label">At cap</span>
              <div className="included-caps__seg" role="group" aria-label={`Overflow behavior — ${row.costCenterName}`}>
                <button
                  type="button"
                  aria-pressed={row.overflow === 'block'}
                  className={`included-caps__seg-btn ${row.overflow === 'block' ? 'included-caps__seg-btn--active' : ''}`}
                  onClick={() => onOverflowChange(row.id, 'block')}
                  disabled={liveMode}
                >
                  Block
                </button>
                <button
                  type="button"
                  aria-pressed={row.overflow === 'metered'}
                  className={`included-caps__seg-btn ${row.overflow === 'metered' ? 'included-caps__seg-btn--active' : ''}`}
                  onClick={() => onOverflowChange(row.id, 'metered')}
                  disabled={liveMode}
                >
                  Overflow → metered
                </button>
              </div>
            </div>
            {liveMode && (
              <div className="included-caps__policy-note mono">
                Governed by the enterprise “AI credit paid usage” policy
              </div>
            )}

            {row.staged && <div className="included-caps__staged">● staged change</div>}
            {row.drifted && driftCollisionId !== row.id && (
              <button type="button" className="controls-table__drift" onClick={() => onReconcileDrift(row.id)}>
                ⤺ drift — reconcile
              </button>
            )}
            {row.drifted && driftCollisionId === row.id && (
              <div className="controls-table__drift-collision" role="alert">
                <span aria-hidden="true">⚠ </span>This cost center also has a staged edit made before this drift was
                detected — review it before reconciling.
                <div className="controls-table__drift-collision-actions">
                  <button type="button" className="controls-table__drift-confirm" onClick={() => onReconcileDrift(row.id)}>
                    ⤺ Reconcile anyway
                  </button>
                  <button type="button" className="controls-table__drift-cancel" onClick={onCancelDriftCollision}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
