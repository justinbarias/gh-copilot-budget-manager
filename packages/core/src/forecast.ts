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
  /**
   * Empirical-Bayes shrinkage strength for the weekday seasonality indices used
   * on the **variance path only** (see {@link shrinkWeekdayIndices}). Each raw
   * index is pulled toward 1.0 (no seasonality) by the factor
   * `n_wd / (n_wd + seasonalityShrinkK)`, where `n_wd` is that weekday's
   * observation count. Default 2: with 1 observation a weekday keeps 1/3 of its
   * raw deviation, 4 obs → 2/3, 12 obs → 6/7 — converging to the raw index as
   * history accumulates. Rationale: with a single cycle of history there is ~1
   * observation per weekday, so an unshrunk index reproduces its day exactly and
   * the deseasonalized residual variance collapses toward 0 — the P90 band then
   * inherits a false precision. Computing the *residual variance* against shrunk
   * indices leaves genuine weekday swings in the residuals until the seasonality
   * is actually estimable, correctly inflating the early-cycle band. The P50
   * point estimate (run-rate blend + reseasonalized projection) always uses the
   * RAW indices, so this knob never moves the central forecast. Higher = more
   * shrinkage (wider early bands); 0 = variance on raw residuals (the old model).
   */
  seasonalityShrinkK?: number;
  /**
   * Minimum coefficient-of-variation floor on the daily burn, used to keep the
   * P90 band honest before ~two weeks of history exist (see the floor at the
   * estimation site). The floor is `minCV · runRate` (as a std-dev), fades
   * linearly to 0 over {@link floorFadeDays}, and only ever *raises* the
   * variance — measured variance wins once it exceeds the floor. Default 0.15
   * (a 15% CV at 0 days of history, 7.5% at 7 days, 0 at ≥14). Rationale:
   * scarce data must produce WIDE bands, never narrow ones — this feeds
   * money-affecting decisions, and an empty/degenerate early sample would
   * otherwise report a near-zero band. 0 disables the floor.
   */
  minCV?: number;
  /**
   * Number of estimation days over which the {@link minCV} floor fades to 0.
   * Default 14 (two weeks): at `nEstim ≥ floorFadeDays` the floor is gone and
   * the measured (sample) variance stands entirely on its own.
   */
  floorFadeDays?: number;
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
  /**
   * Per-weekday multiplicative seasonality indices, Sunday-first (index 0 =
   * Sunday .. 6 = Saturday); mean ~= 1. These are the RAW (unshrunk) indices —
   * the point path (run-rate + projection) uses them; the variance path uses
   * {@link shrunkWeekdayIndices}.
   */
  weekdayIndices: number[];
  settlingWindowDays: number;
  /** asOfDate as a UTC calendar day, ISO 'YYYY-MM-DD'. */
  asOfDate: string;
  /**
   * *Measured* residual daily variance (credits^2) of the estimation series
   * deseasonalized with the SHRUNK indices ({@link shrunkWeekdayIndices}), as a
   * **sample** variance (÷(n−1); 0 when fewer than 2 estimation days). This is
   * the raw signal *before* the small-sample floor; the band actually uses
   * {@link effectiveVariance}.
   */
  dailyVariance: number;
  /**
   * The shrunk weekday indices the variance path deseasonalizes with (see
   * {@link ForecastParams.seasonalityShrinkK}). For introspection only — the
   * point path never uses them. Optional for literal back-compat; always
   * populated by {@link forecast}.
   */
  shrunkWeekdayIndices?: number[];
  /**
   * Number of estimation days (deseasonalized series length = history minus the
   * settling window). Drives the run-rate standard error and the variance-floor
   * fade. Optional so pre-existing `ForecastBasis` literals stay valid; always
   * populated by {@link forecast}.
   */
  nEstim?: number;
  /**
   * The variance the band is actually built on: `max(dailyVariance, floor)`,
   * where the floor is the {@link ForecastParams.minCV} coefficient-of-variation
   * floor that fades out by {@link ForecastParams.floorFadeDays}. Equals
   * {@link dailyVariance} once the floor has faded (enough history) or whenever
   * measured variance already exceeds it. Optional for literal back-compat;
   * always populated by {@link forecast}.
   */
  effectiveVariance?: number;
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
  seasonalityShrinkK: 2,
  minCV: 0.15,
  floorFadeDays: 14,
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

/**
 * RAW per-weekday indices (Sunday-first), each = weekday-mean / overall-mean;
 * 1.0 when data is absent/flat. Also returns each weekday's observation count
 * (`counts`), which {@link shrinkWeekdayIndices} needs. The raw indices drive
 * the POINT path (run-rate blend + reseasonalized projection) — bit-identical
 * to the pre-shrinkage model for every history.
 */
function computeWeekdayIndices(estim: readonly EstimDay[]): { indices: number[]; counts: number[] } {
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
  const indices = sums.map((s, wd) => {
    const c = counts[wd] ?? 0;
    if (c === 0 || overallMean <= 0) return 1;
    return s / c / overallMean;
  });
  return { indices, counts };
}

/**
 * Shrink raw weekday indices toward 1.0 (empirical-Bayes style) by each
 * weekday's observation count `n_wd`:
 *
 *   index_wd = 1 + (rawIndex_wd − 1) · n_wd / (n_wd + shrinkK)
 *
 * Used by the VARIANCE path only. With one cycle of history there is ~1
 * observation per weekday, so an unshrunk `rawIndex` reproduces its own day
 * exactly and the deseasonalized residual variance collapses toward 0 — the
 * band would then claim false precision. Shrinking the indices the *residuals*
 * are measured against keeps most of a weekday's swing in the variance until
 * several observations exist (converging to the raw index as `n_wd` grows).
 * Weekdays with 0 observations stay at exactly 1 (raw is already 1 there).
 */
function shrinkWeekdayIndices(raw: readonly number[], counts: readonly number[], shrinkK: number): number[] {
  return raw.map((idx, wd) => {
    const c = counts[wd] ?? 0;
    if (c === 0) return 1; // no observations (raw is 1 too); also avoids 0/0 when shrinkK is 0
    const shrink = c / (c + shrinkK); // grows to 1 with history; shrinkK 0 → raw
    return 1 + (idx - 1) * shrink;
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

/**
 * Sample variance (÷(n−1), Bessel-corrected) of the deseasonalized daily series.
 * Returns 0 for n < 2 (undefined dispersion) — the small-sample variance floor
 * at the estimation site then keeps the band from collapsing. Population
 * variance (÷n) understates spread on the tiny samples this forecaster runs on
 * early in a cycle, so the unbiased sample estimator is used instead.
 */
function sampleVariance(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  return values.reduce((a, v) => a + (v - m) * (v - m), 0) / (n - 1);
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

  const { indices: weekdayIndices, counts: weekdayCounts } = computeWeekdayIndices(estim);
  const shrunkWeekdayIndices = shrinkWeekdayIndices(weekdayIndices, weekdayCounts, params.seasonalityShrinkK);

  // POINT path: deseasonalize with the RAW indices (divide out the weekday
  // index) so the run-rate blend isn't double-counting seasonality when it's
  // reseasonalized back on projection. index 0 (flat/no-data) -> identity.
  // Deliberately NOT shrunk: the central (P50) estimate stays bit-identical to
  // the pre-shrinkage model — shrinking here was found to shift business-pinned
  // p50 outcomes (exhaustion dates, metered $) and degrade backtest MAPE at
  // fixture scale. Shrinkage is an uncertainty-honesty device, not a better
  // point estimator, so it lives on the variance path only (below).
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

  // VARIANCE path: deseasonalize the estimation series with the SHRUNK indices
  // and measure the residual variance on THOSE residuals. At small n_wd a raw
  // index reproduces its own day exactly (residual 0 — false precision); a
  // shrunk index deliberately leaves part of the genuine weekday deviation IN
  // the residuals, so the band is conservative while the seasonality is not yet
  // estimable, and converges to the plain (raw-residual) model as history grows
  // (shrink factor n_wd/(n_wd+K) → 1). The point estimate above is untouched:
  // decoupling the two paths keeps p50 (exhaustion dates, metered $, backtest
  // MAPE) bit-identical to the pre-change model while widening only the band.
  const deseasonShrunk = estim.map((d) => {
    const idx = indexAt(shrunkWeekdayIndices, d.ms);
    return idx > 0 ? d.credits / idx : d.credits;
  });

  // Band variance, in three parts (all in credits^2 of daily deseasonalized burn):
  //
  //  1. `dailyVariance` — the *measured* sample variance (÷(n−1)) of the
  //     shrunk-deseasonalized residuals above. This is the daily-noise signal.
  //  2. Small-sample floor — scarce data must produce WIDE bands, never narrow
  //     ones (money-affecting). Before `floorFadeDays` of history the measured
  //     variance is untrustworthy (it can even be 0 on a flat/degenerate early
  //     sample), so we floor the std-dev at `cvFloor · runRate`, where the CV
  //     fades linearly from `minCV` at 0 days to 0 at `floorFadeDays`. The floor
  //     only ever *raises* the variance; once history is long enough (or the
  //     measured variance already exceeds it) the measured value stands alone.
  //  3. Run-rate standard error (added in the band below) — `runRate` is itself
  //     an estimate; SE² = effectiveVariance / nEstim. A run-rate error repeats
  //     on *every* projected day, so it compounds as k² (vs the k of daily
  //     noise) and dominates early in a cycle. Modeling only daily noise (the
  //     old √(k·var) band) understates the true uncertainty of a young forecast.
  const nEstim = deseason.length;
  const dailyVariance = sampleVariance(deseasonShrunk);
  const cvFloor = params.minCV * Math.max(0, (params.floorFadeDays - nEstim) / params.floorFadeDays);
  const floorVariance = (cvFloor * runRate) ** 2;
  const effectiveVariance = Math.max(dailyVariance, floorVariance);
  const rateVariance = nEstim > 0 ? effectiveVariance / nEstim : 0; // SE² of the run-rate estimate

  const basis: ForecastBasis = {
    runRate,
    weekdayIndices,
    shrunkWeekdayIndices,
    settlingWindowDays: params.settlingWindowDays,
    asOfDate: isoDay(asOfMs),
    dailyVariance,
    nEstim,
    effectiveVariance,
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
      // Daily noise accumulates as k·var; the run-rate SE repeats each projected
      // day, so it accumulates as k²·SE². Both use the floored effectiveVariance.
      const std = Math.sqrt(kProjected * effectiveVariance + kProjected * kProjected * rateVariance);
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
