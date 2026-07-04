import './ControlsTable.css';

// Spending-limits family table (Family B -- design/README.md §3). Purely
// presentational: the parent (Controls.tsx) owns live state + the staged
// `desired` overlay and hands down effective row values; every edit here only
// STAGES a change via the callbacks (nothing writes until the rail's Apply).

export interface RowUtilization {
  usedCredits: number;
  capCredits: number;
}

export interface SpendingLimitRowModel {
  /** core controlIdentity, e.g. `budget:cost_center:Platform` -- also the row's data-control-id hook. */
  id: string;
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

interface ControlsTableProps {
  rows: SpendingLimitRowModel[];
  onAmountChange: (id: string, raw: string) => void;
  onHardStopToggle: (id: string) => void;
  onWillAlertChange: (id: string, next: boolean) => void;
  onRecipientsChange: (id: string, raw: string) => void;
}

function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

// Display convention only (flagged in the Task 4.9 report): GitHub's budget
// model carries no per-budget alert *thresholds* (AlertingState is
// willAlert + recipients), so the design's "amber ≥ alert threshold" band
// uses a fixed 75% convention here rather than inventing a per-row dial the
// API doesn't have.
const METER_AMBER_FRACTION = 0.75;

function Meter({ utilization }: { utilization: RowUtilization | null }) {
  if (utilization === null) {
    return (
      <div className="controls-meter">
        <div className="controls-meter__track controls-meter__track--empty" />
        <div className="controls-meter__label mono">no per-org usage data</div>
      </div>
    );
  }

  const { usedCredits, capCredits } = utilization;
  const fraction = capCredits > 0 ? usedCredits / capCredits : 1;
  const over = capCredits <= 0 || fraction >= 1;
  const tone = over ? 'red' : fraction >= METER_AMBER_FRACTION ? 'amber' : 'green';
  const fillPct = Math.min(100, Math.max(usedCredits > 0 ? 2 : 0, Math.round(fraction * 100)));
  const label =
    capCredits > 0
      ? `${Math.round(fraction * 100)}% used · ${formatCredits(usedCredits)} of ${formatCredits(capCredits)}`
      : 'blocked ($0 cap)';

  return (
    <div className="controls-meter">
      <div className="controls-meter__track">
        <div className={`controls-meter__fill controls-meter__fill--${tone}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className={`controls-meter__label mono ${over ? 'controls-meter__label--over' : ''}`}>{label}</div>
    </div>
  );
}

export function ControlsTable({ rows, onAmountChange, onHardStopToggle, onWillAlertChange, onRecipientsChange }: ControlsTableProps) {
  return (
    <div className="controls-table">
      <div className="controls-table__head">
        <span>Control · what it caps</span>
        <span>Phase</span>
        <span>Cap (credits)</span>
        <span>Enforcement</span>
        <span>Utilization · alerts</span>
      </div>

      {rows.map((row) => (
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
              <Meter utilization={row.utilization} />
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
    </div>
  );
}
