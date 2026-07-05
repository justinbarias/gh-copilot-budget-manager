import './BacktestChart.css';

export interface BacktestChartProps {
  /** Task 5.4's StoredForecast.mape; null wherever computeMape's window-guard found insufficient closed-cycle history for this scope. */
  mape: number | null;
}

function mapeTone(mape: number): 'green' | 'amber' | 'red' {
  if (mape < 10) return 'green';
  if (mape < 20) return 'amber';
  return 'red';
}

// Task 5.5 design gap (see the build report): design/README.md's backtest
// card is an actual-vs-forecast LINE CHART (design/*.dc.html's
// renderBacktest). core's own backtest() (packages/core/src/backtest.ts)
// DOES return a { series, mape } pair, but Task 5.4's persistence only
// carries the scalar `mape` through IngestForecastItem/StoredForecast --
// sync-now.ts never persists backtest()'s day-by-day `series`. Re-deriving
// it in the renderer would need the raw daily-burn history, which the
// ApiClient surface doesn't expose (adding one is an ask-first bridge
// extension per CLAUDE.md, out of scope for this task) -- so this renders
// the MAPE pill honestly, with a note, rather than fabricating a chart from
// data that was never fetched.
export function BacktestChart({ mape }: BacktestChartProps) {
  return (
    <div className="backtest-chart" data-testid="backtest-chart">
      <div className="backtest-chart__header">
        <div className="backtest-chart__title">Backtest — forecast vs. actual</div>
        {mape !== null && (
          <span className={`backtest-chart__mape backtest-chart__mape--${mapeTone(mape)}`} data-testid="mape-pill">
            MAPE {mape.toFixed(1)}%
          </span>
        )}
      </div>
      <p className="backtest-chart__body">
        How close past forecasts landed to what actually happened. MAPE (Mean Absolute Percentage Error) is the average
        miss over the trailing evaluation window; lower is better, and under 10% is within target.
      </p>
      {mape === null ? (
        <p className="backtest-chart__note" data-testid="backtest-empty-note">
          Not enough closed-cycle history yet for this scope to backtest — MAPE needs at least one prior full cycle.
        </p>
      ) : (
        <p className="backtest-chart__note" data-testid="backtest-gap-note">
          The day-by-day actual-vs-forecast series isn't persisted for this scope yet (only the summary MAPE is) — the
          chart itself lands once that's available.
        </p>
      )}
    </div>
  );
}
