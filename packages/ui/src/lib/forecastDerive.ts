import { cycleBounds } from '@copilot-budget/core';
import type { ForecastResult } from '@copilot-budget/data';

// Task 5.5: pure, client-side helpers the Forecast screen (and its chart
// sub-components) use to turn a persisted, possibly-multi-cycle
// StoredForecast/ForecastResult into the single-cycle, day-indexed shape
// BurndownChart's MVP (Task 2.1) `data`/`daysInCycle` props already use. No
// I/O, no wall-clock -- everything here is a fold over the ForecastResult the
// caller already fetched via getForecast().

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayMs(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getTime();
}

export interface DayPoint {
  day: number; // days elapsed since THIS cycle's start (0 = cycle start)
  credits: number;
}

export interface CycleForecastView {
  /** Whole days in the cycle dailySeries[0] belongs to (core's cycleBounds). */
  daysInCycle: number;
  /** Actual cumulative burn, day-indexed. */
  actual: DayPoint[];
  /**
   * P50 forecast line, day-indexed, PREFIXED with the last actual point so a
   * dashed continuation line joins the solid actual line with no visual gap
   * (mirrors design/*.dc.html's renderBurndown: `[{d:pd.today,v:pd.last}].concat(pd.p50)`).
   */
  p50: DayPoint[];
  /** P90 upper-band line, same day domain/prefix as `p50`. */
  p90: DayPoint[];
  /** This cycle's flat allowance/limit value (already correctly stepped for its calendar dates by core's AllowanceLineFn). */
  allowance: number;
  /**
   * Day index of the most recent day core's forecaster actually had an
   * observed data point for -- NOT necessarily `asOfDate`'s own day-elapsed:
   * the DEWR fixture world's itemised usage rows stop a couple of days short
   * of `asOfDate` on some scopes (no row = no `actualCumulative` entry, per
   * forecast.ts's `lastActualMs`), so this is the honest boundary between the
   * chart's solid (observed) and dashed (projected) segments, not a
   * recomputation of the calendar "today".
   */
  lastActualDay: number;
  /** Day index of the real persisted exhaustion date, if it falls within this cycle's slice (null if the exhaustion/runway lands in a later cycle, or never). */
  exhaustionDay: number | null;
  /** Day index of the settling/provisional column (core's settlingWindowDays), if any actual day in this cycle is still settling. */
  provisionalDay: number | null;
}

/**
 * Slices a (possibly multi-cycle) persisted ForecastResult down to the single
 * cycle its `dailySeries[0]` belongs to. `forecast()` (packages/core/src/forecast.ts)
 * always starts a scope's series at THAT cycle's start, then keeps projecting
 * through a long horizon spanning several more cycles (each reset to a fresh
 * cumulative at its own boundary -- forecast.ts's per-cycle `cum = 0`
 * bookkeeping, "the pool resets monthly, no carryover"). The Forecast
 * screen's burn-down chart, like Overview's MVP one, is scoped to ONE cycle
 * at a time (design/README.md's own burn-down chart is single-cycle,
 * `cycle=30`) -- this takes only the contiguous prefix belonging to the
 * first cycle and re-indexes dates to days-elapsed-since-cycle-start.
 *
 * Returns null only when the series is empty (never reachable through
 * getForecast() today, but kept honest rather than throwing).
 */
export function cycleForecastView(result: ForecastResult): CycleForecastView | null {
  const series = result.dailySeries;
  if (series.length === 0) return null;

  const first = series[0]!;
  const bounds = cycleBounds(new Date(`${first.date}T00:00:00.000Z`));
  const cycleStartMs = bounds.cycleStart.getTime();
  const cycleEndMs = bounds.cycleEnd.getTime();
  const slice = series.filter((d) => {
    const ms = dayMs(d.date);
    return ms >= cycleStartMs && ms < cycleEndMs;
  });
  if (slice.length === 0) return null;

  const toDay = (iso: string): number => Math.round((dayMs(iso) - cycleStartMs) / MS_PER_DAY);

  const actual = slice
    .filter((d) => d.actualCumulative !== undefined)
    .map((d): DayPoint => ({ day: toDay(d.date), credits: d.actualCumulative! }));
  const lastActual: DayPoint = actual.at(-1) ?? { day: 0, credits: 0 };
  const projected = slice.filter((d) => d.actualCumulative === undefined);

  const p50: DayPoint[] = [lastActual, ...projected.map((d): DayPoint => ({ day: toDay(d.date), credits: d.p50Cumulative }))];
  const p90: DayPoint[] = [lastActual, ...projected.map((d): DayPoint => ({ day: toDay(d.date), credits: d.p90Cumulative }))];

  const provisionalEntry = [...slice].reverse().find((d) => d.provisional);
  const exhaustionDay =
    result.exhaustionDate !== null && slice.some((d) => d.date === result.exhaustionDate) ? toDay(result.exhaustionDate) : null;

  return {
    daysInCycle: bounds.daysInCycle,
    actual,
    p50,
    p90,
    allowance: first.allowanceLine,
    lastActualDay: lastActual.day,
    exhaustionDay,
    provisionalDay: provisionalEntry ? toDay(provisionalEntry.date) : null,
  };
}

/**
 * First day (in ascending-day order) `points`' cumulative crosses `allowance`;
 * null if it never does, or `allowance` isn't a real positive ceiling.
 * Used ONLY to re-derive a hypothetical crossing day when the Forecast
 * screen's allowance-basis toggle overrides the real (correctly-stepped)
 * allowance with a flat hypothetical promo/standard value -- see
 * Forecast.tsx's basis-toggle handling and its build-report gap note.
 */
export function crossingDay(points: readonly DayPoint[], allowance: number): number | null {
  if (allowance <= 0) return null;
  for (const p of points) {
    if (p.credits >= allowance) return p.day;
  }
  return null;
}

/** ISO 'YYYY-MM-DD' for a day index within a cycle starting on `cycleStartIso`. */
export function isoForCycleDay(cycleStartIso: string, day: number): string {
  const ms = dayMs(cycleStartIso) + day * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export function formatMape(mape: number): string {
  return `${mape.toFixed(1)}%`;
}
