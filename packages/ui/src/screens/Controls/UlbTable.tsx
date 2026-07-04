import type { UlbBudgetScope } from '@copilot-budget/core';
import { Meter, type RowUtilization } from './Meter';
import './ControlsTable.css';
import './UlbTable.css';

// User-level budgets family table (Family A -- design/README.md §3, Task
// 4.10). Sibling of ControlsTable.tsx (spending limits), deliberately NOT a
// generalization of it: ControlsTable.tsx is already e2e-verified (Task 4.9),
// and ULBs differ from spending limits in ways that would otherwise fork its
// internals with scope-conditionals (no hard-stop toggle -- ULBs are ALWAYS a
// hard stop, CLAUDE.md §5 -- an API-ONLY pill on CCULB rows, a $0/near-zero
// warning cue, and per-row delete). Reuses ControlsTable.css's base row/grid/
// meter/alerts classes (imported above) since only one family table is ever
// mounted at a time, so there's no risk of class collision; UlbTable.css
// layers ONLY the new classes this family needs on top.

export interface UlbRowModel {
  /** core controlIdentity, e.g. `budget:individual:user-07` -- also the row's data-control-id hook. */
  id: string;
  scope: UlbBudgetScope;
  entityName: string;
  title: string;
  capsCopy: string;
  /** CCULB only (design/README.md §3: "API-ONLY violet pill on CCULB rows"). */
  apiOnly: boolean;
  /** Editable cap value (raw digits string): the staged edit when present, else the live/staged-new amount. */
  amountRaw: string;
  /**
   * Effective hard-stop. ULBs are ALWAYS a hard stop (CLAUDE.md §5) -- the UI
   * never offers a toggle to turn this off. `true` for every real fixture;
   * `false` is rendered defensively (a loud warning, not a silent pill) in
   * case a future live read ever surfaces a ULB GitHub itself has flagged
   * alert-only, which CLAUDE.md §6.3 says must never pass silently.
   */
  hardStop: boolean;
  willAlert: boolean;
  recipientsRaw: string;
  /** Has a pending plan entry of any kind (add/change/delete) -- matches the rail 1:1. */
  staged: boolean;
  /** True for a row from `stagedNewUlbs` (not yet live) -- rendered read-only pre-apply; see Controls.tsx. */
  isNew: boolean;
  /** True once staged for deletion via the row's Delete button. */
  markedForDelete: boolean;
  /** Effective amount <= the near-zero ULB threshold -- a display-only cue, independent of (but numerically aligned with) validatePlan's zero_or_near_zero_ulb warning. */
  zeroWarning: boolean;
  /**
   * Fixture-derived utilization, or null when genuinely not derivable.
   * Individual rows: that user's own MTD credits vs their cap. Universal/
   * CCULB rows: the max-consuming member whose resolved effectiveUlb is THIS
   * control, vs the cap -- an honest "who's closest to this shared ceiling"
   * reading, never a faked/averaged number.
   */
  utilization: RowUtilization | null;
}

interface UlbTableProps {
  rows: UlbRowModel[];
  onAmountChange: (id: string, raw: string) => void;
  onWillAlertChange: (id: string, next: boolean) => void;
  onRecipientsChange: (id: string, raw: string) => void;
  onDeleteToggle: (id: string) => void;
  onDiscardNew: (id: string) => void;
}

const SCOPE_LABEL: Record<UlbBudgetScope, string> = {
  universal: 'universal',
  individual: 'individual',
  multi_user_cost_center: 'CCULB',
};

export function UlbTable({ rows, onAmountChange, onWillAlertChange, onRecipientsChange, onDeleteToggle, onDiscardNew }: UlbTableProps) {
  return (
    <div className="controls-table">
      <div className="controls-table__head">
        <span>Control · what it caps</span>
        <span>Phase</span>
        <span>Cap (credits)</span>
        <span>Enforcement</span>
        <span>Utilization · alerts</span>
      </div>

      {rows.map((row) => {
        const rowClass = [
          'controls-table__row',
          row.staged ? 'controls-table__row--staged' : '',
          row.markedForDelete ? 'controls-ulb__row--delete' : '',
          row.isNew ? 'controls-ulb__row--new' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div key={row.id} className={rowClass} data-control-id={row.id}>
            <div className="controls-table__grid">
              <div className="controls-table__control">
                <div className="controls-table__title">
                  {row.title}
                  {row.apiOnly && (
                    <span className="controls-ulb__apionly-pill" title="No native GitHub UI for this control — API-first only.">
                      API-ONLY
                    </span>
                  )}
                </div>
                <div className="controls-table__caps">{row.capsCopy}</div>
              </div>

              <div>
                {/* ULBs cap consumption across BOTH phases and always hard-stop
                    (CLAUDE.md §5) -- green badge, icon + text. */}
                <span className="controls-table__phase-badge controls-ulb__phase-badge--green mono">
                  <span aria-hidden="true">⇄ </span>both phases
                </span>
              </div>

              <div>
                <input
                  className="controls-table__cap-input"
                  aria-label={`Cap (credits) — ${row.title}`}
                  value={row.amountRaw}
                  inputMode="numeric"
                  disabled={row.isNew || row.markedForDelete}
                  onChange={(event) => onAmountChange(row.id, event.target.value)}
                />
                {row.zeroWarning && (
                  <div className="controls-ulb__zero-warn">
                    <span aria-hidden="true">⚠ </span>$0/near-zero — blocks immediately
                  </div>
                )}
              </div>

              <div className="controls-table__enforcement">
                {row.hardStop ? (
                  <span className="controls-ulb__locked-pill">Hard stop · always</span>
                ) : (
                  <div className="controls-ulb__alert-warn">
                    <span aria-hidden="true">⚠ </span>Not enforcing a hard stop — {SCOPE_LABEL[row.scope]} ULBs must
                    always hard-stop (CLAUDE.md §6.3). Repair via the API.
                  </div>
                )}
              </div>

              <div className="controls-table__util">
                <Meter utilization={row.utilization} emptyLabel="no usage data for this scope" />
                <div className="controls-table__alerts">
                  <label className="controls-table__alerts-toggle">
                    <input
                      type="checkbox"
                      aria-label={`Alerts on — ${row.title}`}
                      checked={row.willAlert}
                      disabled={row.isNew || row.markedForDelete}
                      onChange={(event) => onWillAlertChange(row.id, event.target.checked)}
                    />
                    <span>alerts</span>
                  </label>
                  <input
                    className="controls-table__alerts-input mono"
                    aria-label={`Alert recipients — ${row.title}`}
                    title="Comma-separated alert recipients"
                    placeholder="finops@example.com"
                    value={row.recipientsRaw}
                    disabled={row.isNew || row.markedForDelete}
                    onChange={(event) => onRecipientsChange(row.id, event.target.value)}
                  />
                </div>
                <div className="controls-ulb__row-actions">
                  {row.markedForDelete && <span className="controls-ulb__marker controls-ulb__marker--delete">● staged: delete</span>}
                  {!row.markedForDelete && row.isNew && <span className="controls-ulb__marker controls-ulb__marker--new">● staged: new</span>}
                  {!row.markedForDelete && !row.isNew && row.staged && <span className="controls-table__staged">● staged change</span>}
                  {row.isNew ? (
                    <button type="button" className="controls-ulb__discard-btn" onClick={() => onDiscardNew(row.id)}>
                      ✕ discard
                    </button>
                  ) : (
                    <button type="button" className="controls-ulb__delete-btn" onClick={() => onDeleteToggle(row.id)}>
                      {row.markedForDelete ? '⤺ undo delete' : '✕ delete'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
