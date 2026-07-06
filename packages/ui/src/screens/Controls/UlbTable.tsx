import type { UlbBudgetScope } from '@copilot-budget/core';
import { Meter, type RowUtilization } from './Meter';
import { ScalePager, SortHeaderCell } from './ScaleControls';
import type { ScaleSortField, ScaleSortState } from './tableScale';
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
//
// "Controls scale features": individual ULBs are unbounded (one per user), so
// this table gained free-text search, a scope filter, sortable columns
// (name/cap/utilization), and 10/page pagination -- all owned by the PARENT
// (Controls.tsx), which filters/sorts/paginates `pageRows` before handing
// them down (matching this component's existing "purely presentational,
// parent owns state" contract). Staged-NEW rows (from the create modal)
// deliberately bypass every filter/sort/page: they're not yet real, so they
// render as `pinnedNewRows`, always fully visible above the paginated body --
// otherwise a freshly-created row could vanish the instant an unrelated
// filter/page change was made, which would read as data loss. Controls.tsx
// renders the "N staged changes not shown by current filters" honesty note
// (design brief's own layout, not this component -- PlanRail stays frozen).

export interface UlbRowModel {
  /** core controlIdentity, e.g. `budget:individual:liam-obrien` -- also the row's data-control-id hook. */
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
  /**
   * Task 4.15: live moved out-of-band since the last explicit Sync Now.
   * Always false for `isNew` rows (no live counterpart exists yet to have
   * drifted) -- see Controls.tsx's ulbRows construction.
   */
  drifted: boolean;
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

export type UlbScopeFilter = 'all' | UlbBudgetScope;

interface UlbTableProps {
  /** Already filtered/sorted/paginated by Controls.tsx -- this component only renders. */
  pageRows: UlbRowModel[];
  /** Staged-new rows (from the create modal): always shown, pinned above `pageRows`, never filtered/sorted/paginated. */
  pinnedNewRows: UlbRowModel[];
  onAmountChange: (id: string, raw: string) => void;
  onWillAlertChange: (id: string, next: boolean) => void;
  onRecipientsChange: (id: string, raw: string) => void;
  onDeleteToggle: (id: string) => void;
  onDiscardNew: (id: string) => void;
  /** Task 4.14: the ULB-repair banner's "View & edit via API" target, if any -- renders a violet locator ring on that row. */
  highlightedId?: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  scopeFilter: UlbScopeFilter;
  onScopeFilterChange: (value: UlbScopeFilter) => void;
  sort: ScaleSortState;
  onSortToggle: (field: ScaleSortField) => void;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Task 4.15: the one row id currently showing the staged-vs-drifted collision prompt, if any. */
  driftCollisionId: string | null;
  onReconcileDrift: (id: string) => void;
  onCancelDriftCollision: () => void;
}

const SCOPE_LABEL: Record<UlbBudgetScope, string> = {
  universal: 'universal',
  individual: 'individual',
  multi_user_cost_center: 'CCULB',
};

export function UlbTable({
  pageRows,
  pinnedNewRows,
  onAmountChange,
  onWillAlertChange,
  onRecipientsChange,
  onDeleteToggle,
  onDiscardNew,
  highlightedId,
  search,
  onSearchChange,
  scopeFilter,
  onScopeFilterChange,
  sort,
  onSortToggle,
  page,
  pageCount,
  onPageChange,
  driftCollisionId,
  onReconcileDrift,
  onCancelDriftCollision,
}: UlbTableProps) {
  function renderRow(row: UlbRowModel) {
    const rowClass = [
      'controls-table__row',
      row.staged ? 'controls-table__row--staged' : '',
      row.markedForDelete ? 'controls-ulb__row--delete' : '',
      row.isNew ? 'controls-ulb__row--new' : '',
      row.id === highlightedId ? 'controls-ulb__row--repair-highlight' : '',
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
                always hard-stop. Repair via the API.
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
              {row.drifted && driftCollisionId !== row.id && (
                <button type="button" className="controls-table__drift" onClick={() => onReconcileDrift(row.id)}>
                  ⤺ drift — reconcile
                </button>
              )}
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

        {/* Task 4.15: full-width (matches ControlsTable.tsx's alert-only pill
            convention -- needs room for text + two buttons, unlike the
            narrow utility column the "⤺ drift — reconcile" link above lives
            in). Never silently reconciles a row that also has a pending
            staged edit. */}
        {row.drifted && driftCollisionId === row.id && (
          <div className="controls-table__drift-collision" role="alert">
            <span aria-hidden="true">⚠ </span>This row also has a staged edit made before this drift was detected —
            review it before reconciling.
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
  }

  return (
    <div className="controls-table">
      <div className="controls-table__toolbar">
        <input
          className="controls-table__search"
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search control or entity…"
          aria-label="Search user-level budgets"
        />
        <select
          className="controls-table__scope-filter"
          value={scopeFilter}
          onChange={(event) => onScopeFilterChange(event.target.value as UlbScopeFilter)}
          aria-label="Filter by scope"
        >
          <option value="all">All scopes</option>
          <option value="universal">Universal</option>
          <option value="multi_user_cost_center">CCULB</option>
          <option value="individual">Individual</option>
        </select>
      </div>

      <div className="controls-table__head">
        <SortHeaderCell label="Control · what it caps" field="name" sort={sort} onSortToggle={onSortToggle} />
        <span>Phase</span>
        <SortHeaderCell label="Cap (credits)" field="cap" sort={sort} onSortToggle={onSortToggle} />
        <span>Enforcement</span>
        <SortHeaderCell label="Utilization · alerts" field="utilization" sort={sort} onSortToggle={onSortToggle} />
      </div>

      {pinnedNewRows.map(renderRow)}
      {pageRows.map(renderRow)}
      {pinnedNewRows.length === 0 && pageRows.length === 0 && (
        <p className="controls-table__empty">No user-level budgets match these filters.</p>
      )}

      <ScalePager page={page} pageCount={pageCount} onPageChange={onPageChange} />
    </div>
  );
}
