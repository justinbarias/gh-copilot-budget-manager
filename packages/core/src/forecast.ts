import { creditsToUsd } from './controls.js';
import { cycleBounds } from './burndown.js';
import { poolAllowanceCredits, type AllowanceBasis } from './poolAllowance.js';

// PRD §4.3 forecaster -- scope-generic (enterprise-vs-pool, cost-center-vs-cap,
// user-vs-ULB all take the same shape via an `allowance` line function). The
// spec fixes the *ingredients* -- "blended trailing burn (trailing-7 weighted +
// cycle-to-date) with weekday seasonality -> pool-exhaustion date and metered $;
// allowance ... any forecast crossing 1 Sep uses standard allowances (a
// step-change); P50/P90 from daily-burn variance; latest day treated as
// provisional (settling window)" -- but leaves the exact *weights, variance
// model, and settling-window length open*. Those choices are made below, each
// documented at its site and exposed as a `ForecastParams` knob with a default,
// so the model can be tuned without a code change (§4 "prefer parameters").
//
// PURE (CLAUDE.md §2 portability rule): no I/O, no wall-clock. `asOfDate` is an
// explicit input, never `Date.now()`. All dates in/out are UTC calendar days.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One historical day's *incremental* (non-cumulative) burn, in credits. */
export interface DailyBurn {
  /** UTC calendar day, ISO 'YYYY-MM-DD' (any parseable date works; only the UTC day is used). */
  date: string;
  /** Credits burned that day (integer). */
  credits: number;
}

/**
 * The allowance/limit line for the scope being forecast, evaluated per day.
 * Scope-generic: enterprise-vs-pool passes {@link poolAllowanceLine} (which
 * steps at the 1 Sep 2026 cliff via `poolAllowanceCredits`); a cost-center's
 * computed included-usage cap passes the same (its limit is licenses x per-seat,
 * so it steps too); a user-vs-ULB passes {@link fixedAllowanceLine} (ULB amounts
 * are settable and persist across cycles -- a flat line, no cliff).
 */
export type AllowanceLineFn = (date: Date) => number;

/** Enterprise/cost-center pool allowance line: steps down at the 1 Sep 2026 cliff. */
export function poolAllowanceLine(licenseCount: number, basis: AllowanceBasis): AllowanceLineFn {
  return (date: Date) => poolAllowanceCredits(licenseCount, date, basis);
}

/** Flat allowance line (a settable ULB amount, or any fixed limit). */
export function fixedAllowanceLine(credits: number): AllowanceLineFn {
  return () => credits;
}

export interface ForecastParams {
  /**
   * Blend weight on the trailing-window rate vs the cycle-to-date rate (spec
   * §4.3 names both terms but leaves the split open). Default 0.7 favours the
   * recent trailing signal while retaining a cycle-to-date anchor. Chosen here.
   */
  blendWeight?: number;
  /** Trailing-window length in days (spec: "trailing-7"). Default 7. */
  trailingDays?: number;
  /**
   * Settling window: the most-recent N actual days are still settling, so they
   * are flagged `provisional` in output AND excluded from rate/variance
   * estimation (spec §4.3 "latest day treated as provisional"; the count is
   * left open). Default 1.
   */
  settlingWindowDays?: number;
  /**
   * z-multiplier for the P90 band. Default 1.2816 = the one-sided 90th
   * percentile of the standard normal (the variance model below is a normal
   * approximation). Exposed so the band model can be retuned.
   */
  zP90?: number;
}

export interface ForecastDay {
  /** UTC calendar day, ISO 'YYYY-MM-DD'. */
  date: string;
  /** Observed cumulative burn *within this day's cycle*; present only for actual (<= last actual) days. */
  actualCumulative?: number;
  /** Projected (or, on actual days, observed) cumulative burn within the cycle -- the central estimate. */
  p50Cumulative: number;
  /** Upper band; always >= p50Cumulative (invariant, enforced). */
  p90Cumulative: number;
  /** The allowance/limit line for this day (steps at the cliff for pool scopes). */
  allowanceLine: number;
  /** True on the most-recent `settlingWindowDays` actual days (still settling). */
  provisional: boolean;
}

export interface ForecastBasis {
  /** Blended, deseasonalized daily run-rate (credits/day). */
  runRate: number;
  /** Per-weekday multiplicative seasonality indices, Sunday-first (index 0 = Sunday .. 6 = Saturday); mean ~= 1. */
  weekdayIndices: number[];
  settlingWindowDays: number;
  /** asOfDate as a UTC calendar day, ISO 'YYYY-MM-DD'. */
  asOfDate: string;
  /** Residual daily variance of the deseasonalized series (credits^2), the P50/P90 band basis. */
  dailyVariance: number;
}

export interface ForecastResult {
  /** Day-by-day series from the current cycle's start through the horizon; chart-ready. */
  dailySeries: ForecastDay[];
  /** First day P50 cumulative crosses the allowance; null if never within the horizon. */
  exhaustionDate: string | null;
  /** Earliest-plausible exhaustion (first day the P90 band crosses); null if never. */
  exhaustionDateP90: string | null;
  /** Whole days from asOfDate to exhaustion (0 if already exhausted); null if no exhaustion. */
  runwayDays: number | null;
  /** Projected credits burned above the allowance across the horizon (0 when paid usage is disabled -> blocked). */
  projectedMeteredCredits: number;
  /** projectedMeteredCredits x $0.01. */
  projectedMeteredDollars: number;
  basis: ForecastBasis;
}

export interface ForecastInput {
  /** Historical daily burn; may span multiple cycles (needed for weekday seasonality). Order-independent. */
  history: readonly DailyBurn[];
  asOfDate: Date;
  /** Inclusive last projected day. Cross 2026-09-01 to render the cliff step-change. */
  horizonEndDate: Date;
  allowance: AllowanceLineFn;
  /**
   * PRD §5 Q2. When false, pool exhaustion *blocks* (no metered phase): the
   * exhaustion date is still reported, but projectedMetered{Credits,Dollars}
   * are 0 (cumulative beyond the allowance represents blocked/unmet demand,
   * not spend). When true, post-exhaustion draw accrues at $0.01/credit.
   */
  paidUsageEnabled: boolean;
  params?: ForecastParams;
}

const DEFAULTS: Required<ForecastParams> = {
  blendWeight: 0.7,
  trailingDays: 7,
  settlingWindowDays: 1,
  zP90: 1.2816,
};

function dayStartMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function weekdayOf(ms: number): number {
  return new Date(ms).getUTCDay();
}

/** Weekday index for a day, defaulting to 1 (identity) when absent. */
function indexAt(weekdayIndices: readonly number[], ms: number): number {
  return weekdayIndices[weekdayOf(ms)] ?? 1;
}

interface EstimDay {
  ms: number;
  credits: number;
}

/** Per-weekday indices (Sunday-first), each = weekday-mean / overall-mean; 1.0 when data is absent/flat. */
function computeWeekdayIndices(estim: readonly EstimDay[]): number[] {
  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  let total = 0;
  for (const d of estim) {
    const wd = weekdayOf(d.ms);
    sums[wd] = (sums[wd] ?? 0) + d.credits;
    counts[wd] = (counts[wd] ?? 0) + 1;
    total += d.credits;
  }
  const overallMean = estim.length > 0 ? total / estim.length : 0;
  return sums.map((s, wd) => {
    const c = counts[wd] ?? 0;
    if (c === 0 || overallMean <= 0) return 1;
    return s / c / overallMean;
  });
}

/** Recency-weighted mean over the last `n` values with linear weights 1..n (oldest..newest). */
function trailingWeightedMean(values: readonly number[], n: number): number {
  const slice = values.slice(Math.max(0, values.length - n));
  if (slice.length === 0) return 0;
  let num = 0;
  let den = 0;
  slice.forEach((v, i) => {
    const w = i + 1; // oldest -> 1, newest -> slice.length
    num += w * v;
    den += w;
  });
  return num / den;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function populationVariance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return values.reduce((a, v) => a + (v - m) * (v - m), 0) / values.length;
}

/** The projected incremental burn on a given day: run-rate reseasonalized by that day's weekday index. */
export function projectedDailyBurn(basis: ForecastBasis, date: Date): number {
  return basis.runRate * indexAt(basis.weekdayIndices, dayStartMs(date));
}

export function forecast(input: ForecastInput): ForecastResult {
  const params = { ...DEFAULTS, ...input.params };
  const asOfMs = dayStartMs(input.asOfDate);
  const horizonMs = dayStartMs(input.horizonEndDate);

  const sorted = [...input.history]
    .map((h) => ({ ms: dayStartMs(new Date(h.date)), credits: h.credits }))
    .sort((a, b) => a.ms - b.ms);

  // Settling window: drop the most-recent `settlingWindowDays` actual days from
  // estimation (they're still settling). Guard: never drop the entire history.
  const settling = Math.min(params.settlingWindowDays, Math.max(0, sorted.length - 1));
  const provisionalFromMs =
    sorted.length > 0 && settling > 0 ? (sorted[sorted.length - settling]?.ms ?? Infinity) : Infinity;
  const estim = settling > 0 ? sorted.slice(0, sorted.length - settling) : sorted;

  const weekdayIndices = computeWeekdayIndices(estim);

  // Deseasonalize estimation history (divide out the weekday index) so the
  // run-rate blend isn't double-counting seasonality when it's reseasonalized
  // back on projection. index 0 (flat/no-data) -> identity.
  const deseason = estim.map((d) => {
    const idx = indexAt(weekdayIndices, d.ms);
    return { ms: d.ms, value: idx > 0 ? d.credits / idx : d.credits };
  });

  const trailing = trailingWeightedMean(
    deseason.map((d) => d.value),
    params.trailingDays,
  );

  const { cycleStart } = cycleBounds(input.asOfDate);
  const cycleStartMs = cycleStart.getTime();
  const ctdValues = deseason.filter((d) => d.ms >= cycleStartMs).map((d) => d.value);
  const ctd = ctdValues.length > 0 ? mean(ctdValues) : trailing;

  const runRate = params.blendWeight * trailing + (1 - params.blendWeight) * ctd;
  const dailyVariance = populationVariance(deseason.map((d) => d.value));

  const basis: ForecastBasis = {
    runRate,
    weekdayIndices,
    settlingWindowDays: params.settlingWindowDays,
    asOfDate: isoDay(asOfMs),
    dailyVariance,
  };

  const actualByDay = new Map<number, number>();
  for (const d of sorted) actualByDay.set(d.ms, (actualByDay.get(d.ms) ?? 0) + d.credits);
  const lastActualMs = sorted.length > 0 ? (sorted[sorted.length - 1]?.ms ?? -Infinity) : -Infinity;

  // Build the day-by-day series from the current cycle's start through horizon.
  // Cumulative resets at every cycle boundary (the pool resets monthly, PRD
  // §1.2); the P90 band's uncertainty (k projected days) also resets per cycle,
  // since each cycle's projection is independent.
  const dailySeries: ForecastDay[] = [];
  let curCycleMs = -Infinity;
  let cum = 0; // p50 cumulative within the current cycle (actual then projected)
  let kProjected = 0; // projected days elapsed within the current cycle (band basis)

  interface CycleMetered {
    projectionStartCum: number; // cum at last actual day of the cycle (0 if fully projected)
    allowance: number;
    finalCum: number;
    hadProjected: boolean;
  }
  const cycleMetered: CycleMetered[] = [];
  // `cur` is (re)assigned on the first loop iteration, since curCycleMs starts
  // at -Infinity and always differs from the first day's cycle. The initial
  // placeholder is never read nor pushed -- it exists only to satisfy the type.
  let cur: CycleMetered = { projectionStartCum: 0, allowance: 0, finalCum: 0, hadProjected: false };

  for (let ms = dayStartMs(cycleStart); ms <= horizonMs; ms += MS_PER_DAY) {
    const dayCycleMs = cycleBounds(new Date(ms)).cycleStart.getTime();
    if (dayCycleMs !== curCycleMs) {
      curCycleMs = dayCycleMs;
      cum = 0;
      kProjected = 0;
      cur = { projectionStartCum: 0, allowance: 0, finalCum: 0, hadProjected: false };
      cycleMetered.push(cur);
    }
    const allowance = input.allowance(new Date(ms));
    cur.allowance = allowance;

    if (ms <= lastActualMs) {
      const actualDaily = actualByDay.get(ms) ?? 0;
      cum += actualDaily;
      cur.projectionStartCum = cum; // updated on each actual day; frozen once projection starts
      cur.finalCum = cum;
      dailySeries.push({
        date: isoDay(ms),
        actualCumulative: cum,
        p50Cumulative: cum,
        p90Cumulative: cum,
        allowanceLine: allowance,
        provisional: ms >= provisionalFromMs,
      });
    } else {
      const projDaily = runRate * indexAt(weekdayIndices, ms);
      cum += projDaily;
      kProjected += 1;
      const std = Math.sqrt(kProjected * dailyVariance);
      const p90 = Math.max(cum, cum + params.zP90 * std);
      cur.hadProjected = true;
      cur.finalCum = cum;
      dailySeries.push({
        date: isoDay(ms),
        p50Cumulative: cum,
        p90Cumulative: p90,
        allowanceLine: allowance,
        provisional: false,
      });
    }
  }

  // Exhaustion: first day the (P50 / P90) cumulative crosses a positive allowance.
  let exhaustionDate: string | null = null;
  let exhaustionDateP90: string | null = null;
  for (const day of dailySeries) {
    if (exhaustionDate === null && day.allowanceLine > 0 && day.p50Cumulative >= day.allowanceLine) {
      exhaustionDate = day.date;
    }
    if (exhaustionDateP90 === null && day.allowanceLine > 0 && day.p90Cumulative >= day.allowanceLine) {
      exhaustionDateP90 = day.date;
    }
  }

  const runwayDays =
    exhaustionDate === null
      ? null
      : Math.max(0, Math.round((new Date(`${exhaustionDate}T00:00:00.000Z`).getTime() - asOfMs) / MS_PER_DAY));

  // Projected metered: per cycle, the projected draw above the allowance. Base =
  // max(allowance, cum-at-projection-start) so a cycle already over the line
  // meters *all* projected draw, and a cycle crossing mid-projection meters only
  // the portion past the line. Only cycles with projected days contribute.
  let projectedMeteredCredits = 0;
  if (input.paidUsageEnabled) {
    for (const c of cycleMetered) {
      if (!c.hadProjected) continue;
      const base = Math.max(c.allowance, c.projectionStartCum);
      projectedMeteredCredits += Math.max(0, c.finalCum - base);
    }
  }

  return {
    dailySeries,
    exhaustionDate,
    exhaustionDateP90,
    runwayDays,
    projectedMeteredCredits,
    projectedMeteredDollars: creditsToUsd(projectedMeteredCredits),
    basis,
  };
}
