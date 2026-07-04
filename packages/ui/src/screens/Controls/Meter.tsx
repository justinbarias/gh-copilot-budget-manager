// Extracted from ControlsTable.tsx (Task 4.9) so Task 4.10's UlbTable can
// reuse the exact same meter math/markup instead of forking it -- pure
// extraction, no behavior change (ControlsTable.tsx now imports this).

export interface RowUtilization {
  usedCredits: number;
  capCredits: number;
}

// Display convention only (flagged in the Task 4.9 build notes): GitHub's
// budget model carries no per-budget alert *thresholds* (AlertingState is
// willAlert + recipients), so the design's "amber >= alert threshold" band
// uses a fixed 75% convention here rather than inventing a per-row dial the
// API doesn't have.
const METER_AMBER_FRACTION = 0.75;

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function Meter({ utilization, emptyLabel }: { utilization: RowUtilization | null; emptyLabel: string }) {
  if (utilization === null) {
    return (
      <div className="controls-meter">
        <div className="controls-meter__track controls-meter__track--empty" />
        <div className="controls-meter__label mono">{emptyLabel}</div>
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
