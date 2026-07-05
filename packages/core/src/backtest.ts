import {
  forecast,
  projectedDailyBurn,
  type AllowanceLineFn,
  type DailyBurn,
  type ForecastParams,
} from './forecast.js';

// PRD §4.3 "nightly backtest (MAPE)". Replay: for each historical day d in the
// evaluation window, build a forecast from ONLY the data strictly before d (no
// look-ahead -- enforced by construction: the replay slices `history` to days
// < d before calling the forecaster), then compare the forecast's predicted
// incremental burn for d against the actual burn on d. MAPE = mean absolute
// percentage error across the window.
//
// PURE (CLAUDE.md §2): no I/O, no wall-clock; the window is passed explicitly.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayStartMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface BacktestPoint {
  /** UTC calendar day, ISO 'YYYY-MM-DD'. */
  date: string;
  /** Observed incremental burn on this day (credits). */
  actual: number;
  /** Forecast's predicted incremental burn for this day, from data strictly before it. */
  forecastP50: number;
}

export interface BacktestResult {
  /** Actual-vs-forecast aligned series the backtest chart renders. */
  series: BacktestPoint[];
  /**
   * Mean absolute percentage error (%) over evaluation days with a non-zero
   * actual. Zero-actual days are skipped (MAPE is undefined at actual=0 -- a
   * division by zero); if every evaluation day is zero-actual, mape is 0.
   */
  mape: number;
}

export interface BacktestInput {
  /** Full historical daily burn (both the training tail and the evaluation window's actuals). */
  history: readonly DailyBurn[];
  /** Inclusive evaluation-window start (UTC day). */
  evalStart: Date;
  /** Inclusive evaluation-window end (UTC day). */
  evalEnd: Date;
  /** Same allowance line the live forecast uses (irrelevant to the daily prediction, kept for parity). */
  allowance: AllowanceLineFn;
  params?: ForecastParams;
}

export function backtest(input: BacktestInput): BacktestResult {
  const sorted = [...input.history]
    .map((h) => ({ ms: dayStartMs(new Date(h.date)), credits: h.credits }))
    .sort((a, b) => a.ms - b.ms);
  const actualByDay = new Map<number, number>();
  for (const d of sorted) actualByDay.set(d.ms, (actualByDay.get(d.ms) ?? 0) + d.credits);

  const startMs = dayStartMs(input.evalStart);
  const endMs = dayStartMs(input.evalEnd);

  const series: BacktestPoint[] = [];
  const errors: number[] = [];

  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    // No look-ahead, enforced by construction: only days strictly before `ms`.
    const priorHistory = sorted.filter((d) => d.ms < ms).map((d) => ({ date: isoDay(d.ms), credits: d.credits }));
    if (priorHistory.length === 0) continue;

    const day = new Date(ms);
    const { basis } = forecast({
      history: priorHistory,
      asOfDate: day,
      horizonEndDate: day,
      allowance: input.allowance,
      paidUsageEnabled: false,
      params: input.params,
    });
    const forecastP50 = projectedDailyBurn(basis, day);
    const actual = actualByDay.get(ms) ?? 0;

    series.push({ date: isoDay(ms), actual, forecastP50 });
    if (actual !== 0) errors.push(Math.abs(actual - forecastP50) / Math.abs(actual));
  }

  const mape = errors.length > 0 ? (errors.reduce((a, b) => a + b, 0) / errors.length) * 100 : 0;
  return { series, mape };
}
