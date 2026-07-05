import type { SpendingLimitScope } from '@copilot-budget/core';
import { Meter, type RowUtilization } from './Meter';
import { ScalePager, SortHeaderCell } from './ScaleControls';
import type { ScaleSortField, ScaleSortState } from './tableScale';
import './ControlsTable.css';

// Spending-limits family table (Family B -- design/README.md §3). Purely
// presentational: the parent (Controls.tsx) owns live state + the staged
// `desired` overlay and hands down effective row values; every edit here only
// STAGES a change via the callbacks (nothing writes until the rail's Apply).
//
// Task 4.10: Meter/RowUtilization/formatCredits moved to Meter.tsx (a pure
// extraction, no behavior change) so UlbTable.tsx can reuse the exact same
// meter math/markup instead of forking it.
//
// "Controls scale features": free-text search, a scope filter, an
// enforcement filter, sortable columns (name/cap/utilization), and 10/page
// pagination -- all state owned by Controls.tsx (matching this component's
// existing "parent owns state, this renders" contract), which hands down the
// already filtered/sorted/paginated `pageRows`.

export type { RowUtilization };

export interface SpendingLimitRowModel {
  /** core controlIdentity, e.g. `budget:cost_center:Workforce Australia Platform` -- also the row's data-control-id hook. */
  id: string;
  /** Needed for the scope filter (All/Enterprise/Organization/Cost center). */
  scope: SpendingLimitScope;
  title: string;
  capsCopy: string;
  /** Editable cap value (raw digits string): the staged edit when present, else the live amount. */
  amountRaw: string;
  /** Effective hard-stop (staged ?? live). Spending limits: toggleable; OFF renders the loud alert-only pill. */
  hardStop: boolean;
  willAlert: boolean;
  recipientsRaw: string;
  staged: boolean;
  /**
   * Fixture-derived metered utilization, or null when it genuinely is not
   * derivable for this scope (org rows: no per-org usage attribution exists
   * in the data layer) -- rendered as an honestly-empty meter with a text
   * cue, never faked numbers.
   */
  utilization: RowUtilization | null;
}

export type SpendingScopeFilter = 'all' | SpendingLimitScope;
export type SpendingEnforcementFilter = 'all' | 'hard' | 'alert';

interface ControlsTableProps {
  /** Already filtered/sorted/paginated by Controls.tsx -- this component only renders. */
  pageRows: SpendingLimitRowModel[];
  onAmountChange: (id: string, raw: string) => void;
  onHardStopToggle: (id: string) => void;
  onWillAlertChange: (id: string, next: boolean) => void;
  onRecipientsChange: (id: string, raw: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  scopeFilter: SpendingScopeFilter;
  onScopeFilterChange: (value: SpendingScopeFilter) => void;
  enforcementFilter: SpendingEnforcementFilter;
  onEnforcementFilterChange: (value: SpendingEnforcementFilter) => void;
  sort: ScaleSortState;
  onSortToggle: (field: ScaleSortField) => void;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function ControlsTable({
  pageRows,
  onAmountChange,
  onHardStopToggle,
  onWillAlertChange,
  onRecipientsChange,
  search,
  onSearchChange,
  scopeFilter,
  onScopeFilterChange,
  enforcementFilter,
  onEnforcementFilterChange,
  sort,
  onSortToggle,
  page,
  pageCount,
  onPageChange,
}: ControlsTableProps) {
  return (
    <div className="controls-table">
      <div className="controls-table__toolbar">
        <input
          className="controls-table__search"
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search control or entity…"
          aria-label="Search spending limits"
        />
        <select
          className="controls-table__scope-filter"
          value={scopeFilter}
          onChange={(event) => onScopeFilterChange(event.target.value as SpendingScopeFilter)}
          aria-label="Filter by scope"
        >
          <option value="all">All scopes</option>
          <option value="enterprise">Enterprise</option>
          <option value="organization">Organization</option>
          <option value="cost_center">Cost center</option>
        </select>
        <select
          className="controls-table__scope-filter"
          value={enforcementFilter}
          onChange={(event) => onEnforcementFilterChange(event.target.value as SpendingEnforcementFilter)}
          aria-label="Filter by enforcement"
        >
          <option value="all">All enforcement</option>
          <option value="hard">Hard stop</option>
          <option value="alert">Alert-only</option>
        </select>
      </div>

      <div className="controls-table__head">
        <SortHeaderCell label="Control · what it caps" field="name" sort={sort} onSortToggle={onSortToggle} />
        <span>Phase</span>
        <SortHeaderCell label="Cap (credits)" field="cap" sort={sort} onSortToggle={onSortToggle} />
        <span>Enforcement</span>
        <SortHeaderCell label="Utilization · alerts" field="utilization" sort={sort} onSortToggle={onSortToggle} />
      </div>

      {pageRows.map((row) => (
        <div key={row.id} className={`controls-table__row ${row.staged ? 'controls-table__row--staged' : ''}`} data-control-id={row.id}>
          <div className="controls-table__grid">
            <div className="controls-table__control">
              <div className="controls-table__title">{row.title}</div>
              <div className="controls-table__caps">{row.capsCopy}</div>
            </div>

            <div>
              {/* Spending limits cap metered charges only (CLAUDE.md §5) --
                  amber badge, icon + text, never color-only. */}
              <span className="controls-table__phase-badge mono">
                <span aria-hidden="true">↪ </span>metered only
              </span>
            </div>

            <div>
              <input
                className="controls-table__cap-input"
                aria-label={`Cap (credits) — ${row.title}`}
                value={row.amountRaw}
                inputMode="numeric"
                onChange={(event) => onAmountChange(row.id, event.target.value)}
              />
            </div>

            <div className="controls-table__enforcement">
              <button
                type="button"
                role="switch"
                aria-checked={row.hardStop}
                aria-label={`Hard stop — ${row.title}`}
                className={`controls-toggle ${row.hardStop ? 'controls-toggle--on' : 'controls-toggle--alert'}`}
                onClick={() => onHardStopToggle(row.id)}
              >
                <span className="controls-toggle__knob" aria-hidden="true" />
              </button>
              <span className={`controls-table__enforcement-label ${row.hardStop ? 'controls-table__enforcement-label--hard' : 'controls-table__enforcement-label--alert'}`}>
                {row.hardStop ? 'Hard stop' : 'Alert-only'}
              </span>
            </div>

            <div className="controls-table__util">
              <Meter utilization={row.utilization} emptyLabel="no per-org usage data" />
              <div className="controls-table__alerts">
                <label className="controls-table__alerts-toggle">
                  <input
                    type="checkbox"
                    aria-label={`Alerts on — ${row.title}`}
                    checked={row.willAlert}
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
                  onChange={(event) => onRecipientsChange(row.id, event.target.value)}
                />
              </div>
              {row.staged && <span className="controls-table__staged">● staged change</span>}
            </div>
          </div>

          {/* The loud pill (design §3): an alert-only spending limit is
              spelled out, icon + text, directly on the row. */}
          {!row.hardStop && (
            <div className="controls-table__alert-only-pill">
              ⚠ Alert-only — spend continues past this limit. No hard stop.
            </div>
          )}
        </div>
      ))}
      {pageRows.length === 0 && <p className="controls-table__empty">No spending limits match these filters.</p>}

      <ScalePager page={page} pageCount={pageCount} onPageChange={onPageChange} />
    </div>
  );
}
