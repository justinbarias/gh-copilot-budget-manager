# Forecasting — algorithm reference

The forecaster projects an entity's cumulative credit burn forward to a horizon,
reports a P50 (central) and P90 (upper) band, derives the pool-exhaustion date
and runway, and estimates metered spend past the allowance. It is the engine
behind PRD **§4.3** (forecasting) and feeds money-affecting decisions — so its
uncertainty estimates must be honest, especially early in a cycle when data is
scarce.

Source: `packages/core/src/forecast.ts` (pure, no I/O, no wall-clock — `asOfDate`
is an explicit input, all dates are UTC calendar days; CLAUDE.md §2). Tests:
`packages/core/src/forecast.test.ts`.

It is **scope-generic**: enterprise-vs-pool, cost-center-vs-cap, and user-vs-ULB
all take the same shape. The only scope-specific input is the **allowance line**
function (below).

---

## Inputs (`ForecastInput`)

| Input | Meaning |
| --- | --- |
| `history: DailyBurn[]` | Per-day **incremental** (non-cumulative) burn in credits. May span multiple cycles (needed for weekday seasonality). Order-independent. |
| `asOfDate: Date` | "Now" — the last day for which actuals are trusted. Explicit (never `Date.now()`), so the forecast is deterministic and testable. |
| `horizonEndDate: Date` | Inclusive last projected day. Cross `2026-09-01` to render the allowance cliff. |
| `allowance: AllowanceLineFn` | `(date) => credits`, the limit line for the scope. `poolAllowanceLine(licenses, basis)` steps at the 1 Sep 2026 cliff; `fixedAllowanceLine(credits)` is flat (a settable ULB amount). |
| `paidUsageEnabled: boolean` | PRD §5 Q2. `false` → pool exhaustion **blocks** (metered credits/dollars reported as 0; the exhaustion date is still reported). `true` → post-exhaustion draw accrues at $0.01/credit. |
| `params?: ForecastParams` | Tuning knobs; see the table below. Every choice the spec left open is a defaulted parameter, so the model can be retuned without a code change. |

**Unit:** 1 credit = $0.01 (PRD §1.1).

---

## Pipeline (in order)

Given `history`, `asOfDate`, and the params:

1. **Sort & settling window.** Sort history by day. The most-recent
   `settlingWindowDays` actual days are still settling (late-arriving usage), so
   they are flagged `provisional` in the output **and excluded from estimation**
   (rate + variance). Guard: never drop the entire history. `estim` = the
   remaining days; `nEstim = estim.length`.

2. **Weekday seasonality indices — two sets.** For each weekday (Sunday-first)
   compute a **raw** multiplicative index
   `rawIndex_wd = weekday-mean / overall-mean` (exactly 1 for weekdays with 0
   observations or a non-positive overall mean). Then derive a second,
   **shrunk** set by pulling each raw index toward 1.0 (empirical-Bayes style)
   by that weekday's observation count `n_wd`:

   ```
   shrunkIndex_wd = 1 + (rawIndex_wd − 1) · n_wd / (n_wd + seasonalityShrinkK)
   ```

   The two sets serve different paths: the **point estimate (P50) uses the RAW
   indices**; the **band variance uses the SHRUNK indices**. See **Why the
   point and band deseasonalize differently** below.

3. **Deseasonalize (point path — raw indices).** Divide each estimation day's
   burn by its **raw** weekday index, so the run-rate blend isn't
   double-counting seasonality when it is reseasonalized back on projection. A
   unit index (flat/no-data) is identity.

4. **Run-rate blend.** Two terms over the raw-deseasonalized series:
   - **trailing** — a recency-weighted mean of the last `trailingDays` values
     (linear weights `1..n`, oldest→newest).
   - **cycle-to-date (ctd)** — the simple mean of the deseasonalized values in
     the current cycle (`cycleBounds(asOfDate)`); falls back to `trailing` if the
     cycle has no estimation days yet.

   ```
   runRate = blendWeight · trailing + (1 − blendWeight) · ctd
   ```

5. **Measured variance (variance path — shrunk indices).** Deseasonalize the
   estimation series a second time, now with the **shrunk** indices, and set
   `dailyVariance` = the **sample** variance (÷(n−1), Bessel-corrected; 0 when
   `nEstim < 2`) of *those* residuals. Sample (not population) variance, because
   ÷n understates spread on the tiny samples this runs on early in a cycle. At
   small `n_wd` the shrunk indices deliberately leave part of any genuine
   weekday deviation **in** the residuals, inflating the measured variance —
   conservative by design; it converges to the plain (raw-residual) variance as
   history grows.

6. **Small-sample variance floor.** Scarce data must produce **wide** bands. The
   std-dev is floored at a coefficient-of-variation of the run rate, fading
   linearly to 0 as history accumulates:

   ```
   cvFloor(n)         = minCV · max(0, (floorFadeDays − n) / floorFadeDays)
   floorVariance      = (cvFloor(nEstim) · runRate)²
   effectiveVariance  = max(dailyVariance, floorVariance)
   ```

   The floor only ever *raises* the variance; once measured variance exceeds it,
   or `nEstim ≥ floorFadeDays`, it is inert. **The band is built on
   `effectiveVariance`, not `dailyVariance`.**

7. **Run-rate standard error.** `runRate` is itself an estimate with sampling
   error:

   ```
   SE² = effectiveVariance / nEstim      (0 when nEstim = 0)
   ```

8. **Per-cycle projection with reseasonalization.** Walk day-by-day from the
   current cycle's start to the horizon. On **actual** days (`≤` last actual)
   the series carries the observed cumulative; `p50 = p90 = actual`. On
   **projected** days the daily estimate is `runRate · rawIndex_wd` (seasonality
   put back with the **raw** indices — the point path end to end), added to the
   running cumulative `cum`. The cumulative **resets at every cycle boundary**
   (the pool resets monthly, PRD §1.2), and so does the band's `k` counter —
   each cycle's projection is independent.

9. **Band formula.** For the k-th projected day of a cycle (k = 1, 2, …):

   ```
   p50 = cum
   p90 = max(cum,  cum + zP90 · √(k · effectiveVariance + k² · SE²))
   ```

   - The `k · effectiveVariance` term is **daily noise**, which accumulates like
     a random walk (√k in std-dev).
   - The `k² · SE²` term is **run-rate parameter uncertainty**: a rate error
     repeats on *every* projected day, so it compounds linearly in k (k² in
     variance) and **dominates early in a cycle**. Omitting it — the old
     `√(k · var)` band — understated a young forecast's true uncertainty.
   - The `max(cum, …)` keeps the invariant **p90 ≥ p50** unconditionally.

10. **Exhaustion, runway, metered.**
    - **exhaustionDate** = first day `p50` crosses a positive allowance line;
      **exhaustionDateP90** = first day the `p90` band crosses it (earliest
      plausible).
    - **runwayDays** = whole days from `asOfDate` to `exhaustionDate` (clamped to
      0 if already exhausted; null if no exhaustion within the horizon).
    - **projectedMeteredCredits** (only when `paidUsageEnabled`): summed
      per-cycle, `max(0, finalCum − max(allowance, cumAtProjectionStart))` — a
      cycle already over the line meters *all* projected draw; a cycle crossing
      mid-projection meters only the portion past the line. Reset per cycle.
      `projectedMeteredDollars = credits · $0.01`.

### The 1 Sep 2026 cliff

The cliff is entirely in the **allowance line**, not the burn model. For pool
scopes, `poolAllowanceLine` returns `poolAllowanceCredits`, which pays the promo
per-seat rate (existing customers, enterprise 7000 / business 3000) through
`2026-08-31` and the standard rate (enterprise 3900 / business 1900) from
`2026-09-01`. Any forecast whose horizon crosses the cliff renders the
step-change automatically, and exhaustion/runway/metered all pick it up because
they compare against `day.allowanceLine`.

### Why the point and band deseasonalize differently

The P50 point estimate and the P90 band variance intentionally use **different**
index sets (raw vs shrunk). Shrinkage is an *uncertainty-honesty* device, not a
better point estimator: an early trial that also shrank the point path shifted
p50 outcomes at fixture scale — a user's ULB exhaustion date moved a day earlier
(runway 1 → 0), the enterprise backtest MAPE degraded from 1.2% to 14.0%, and
projected metered spend moved from $3,851 to $4,261 — because a partially
deseasonalized series feeds a recency-weighted blend that no longer cancels the
weekday pattern exactly. Decoupling gives both properties at once:

- **Point path (raw indices):** the central forecast — run-rate, projection,
  exhaustion dates, runway, metered $ — is **bit-identical to the pre-shrinkage
  model** for every history. Point accuracy and business-pinned outcomes are
  untouched.
- **Variance path (shrunk indices):** at small `n_wd` a raw index reproduces its
  own day exactly (residual 0 — false precision), so the residuals are measured
  against shrunk indices instead, deliberately leaking unshrunk seasonal
  deviation into the variance. Bands are conservative while the seasonality is
  not yet estimable and converge to the plain model as the shrink factor
  `n_wd/(n_wd+K) → 1`.

---

## Parameters (`ForecastParams`)

| Name | Default | What it does | Why this default |
| --- | --- | --- | --- |
| `blendWeight` | `0.7` | Weight on the trailing rate vs cycle-to-date in the run-rate blend. | Favors the recent trailing signal while keeping a cycle-to-date anchor. |
| `trailingDays` | `7` | Length of the recency-weighted trailing window. | Spec §4.3 names "trailing-7". |
| `settlingWindowDays` | `1` | Most-recent actual days flagged provisional and excluded from estimation. | Spec §4.3 "latest day treated as provisional"; late usage settles. |
| `zP90` | `1.2816` | z-multiplier for the P90 band (normal approximation). | One-sided 90th percentile of the standard normal. |
| `seasonalityShrinkK` | `2` | Empirical-Bayes shrinkage strength for the weekday indices used on the **variance path only**; `n_wd/(n_wd+K)` of the raw deviation survives. Never moves p50. | 1 obs → 1/3, 4 obs → 2/3, 12 obs → 6/7. Keeps genuine seasonality in the band residuals until it is estimable. `0` = variance on raw residuals (the old model). |
| `minCV` | `0.15` | Coefficient-of-variation floor on the daily std-dev at 0 days of history. | A 15% CV at day 0, 7.5% at 7 days — a conservative floor that prevents a near-zero early band. `0` disables the floor. |
| `floorFadeDays` | `14` | Days over which the `minCV` floor fades to 0. | Two weeks of history; past that the measured sample variance stands alone. |

---

## Basis (`ForecastBasis`, on the result)

Surfaced for inspection and downstream reasoning: `runRate`, `weekdayIndices`
(**raw** — the point path; back-compatible), `shrunkWeekdayIndices` (the
variance path's indices, for introspection), `settlingWindowDays`, `asOfDate`,
`dailyVariance` (measured sample variance of the shrunk residuals,
**pre-floor**), `nEstim` (estimation-day count), and `effectiveVariance`
(**post-floor** — what the band is actually built on). `shrunkWeekdayIndices`,
`nEstim`, and `effectiveVariance` are optional fields, added additively so
existing `ForecastBasis` literals stay valid; `forecast()` always populates them.

---

## Small-sample behavior — the Day-8 incident

**Observed live (Day 8 of a 31-day cycle, ~98k cumulative):** P50 at horizon
337,147 vs P90 342,551 — a **1.6% band**, implying a daily std-dev of only ~880
on a ~12k/day run rate. That is far too confident for eight days of data feeding
a spend decision. Three compounding causes, and how the model now fixes each:

1. **Weekday-seasonality overfit.** Fitting 7 indices against a single cycle's
   ~7 days gives ~1 observation per weekday, so each raw index reproduces its day
   exactly and the deseasonalized residual variance collapses toward 0. →
   **Shrinkage** (`seasonalityShrinkK`) on the **variance path** measures the
   residuals against shrunk indices, leaving most of a weekday's swing in the
   variance until several observations exist, so the early band stays honest,
   converging to the true seasonal model as history grows. (The point path keeps
   the raw indices — see *Why the point and band deseasonalize differently*.)

2. **No run-rate parameter uncertainty.** The old band was `zP90·√(k·var)` —
   daily noise only. The run-rate estimate's own standard error repeats on every
   projected day. → The **`k²·SE²` term** adds exactly that, and dominates early
   in a cycle (linear-in-k compounding).

3. **Population variance (÷n) on tiny samples** understated spread; and a flat or
   degenerate early sample can measure literally 0 variance. → **Sample variance
   (÷(n−1))** plus the **fading CV floor** guarantee a non-trivial band before
   ~two weeks of history, fading out once the data can speak for itself.

**Design principle:** *scarce data must produce WIDE bands, never narrow ones.*
Each mechanism widens the early band and then gets out of the way as history
accumulates.

### Worked example (a unit-test fixture)

Constant **1000 credits/day for 7 days**, one cycle, projecting the next day
(`settlingWindowDays: 0`, default `zP90 = 1.2816`). This is the degenerate shape
behind the incident — flat history, so measured variance is 0 and the *old* model
reported a **zero-width** band.

```
raw indices        : each present weekday = 1000/1000 = 1  (flat, no seasonality)
shrunk indices     : 1 + (1−1)·n/(n+2) = 1                 (a unit index is a
                                                            fixed point of shrinkage)
point path         : raw-deseasonalized = 1000, 1000, … (÷1) → flat
trailing (7, wtd)  : 1000 ;  ctd (July) : 1000
runRate            : 0.7·1000 + 0.3·1000 = 1000
variance path      : shrunk-deseasonalized = same flat 1000s here (indices equal)
sample variance    : 0            (all values equal)
nEstim             : 7
cvFloor(7)         : 0.15·(14−7)/14 = 0.075
floorVariance      : (0.075·1000)² = 5625
effectiveVariance  : max(0, 5625) = 5625
SE²                : 5625 / 7 = 803.571429
band offset(k)     : 1.2816 · √(k·5625 + k²·803.571429)
  k=1  : 1.2816 · √(5625 + 803.571)      = 1.2816 · √6428.571  = 102.75660
  k=3  : 1.2816 · √(16875 + 7232.143)    = 1.2816 · √24107.143 = 198.98730
  k=23 : 1.2816 · √(129375 + 425089.29)  = 1.2816 · √554464.29 = 954.30959
```

For a fixture where the two paths *diverge* (real seasonality, few
observations), see the `weekday-index shrinkage by observation count` test:
Monday 200 / others 100 over one week gives raw Monday index 1.75 (point path;
residuals flat 114.286, plain-model p50) but shrunk Monday index 1.25 (variance
path; residuals 160 vs 104.348, sample variance 442.45 instead of the raw
residuals' false 0).

So at the horizon (k=23, the incident's Day-8 shape) the band is **±954 credits**
on ~23,000 projected — a materially wide, honest band where the old model would
have reported **0**.

---

## What is NOT modeled (yet)

- **P10 / lower band.** Only P50 and a one-sided P90 upper band are produced.
- **Autocorrelation.** Daily residuals are treated as independent; real bursts
  are correlated, which the √k / k² accumulation does not capture.
- **Trend, burst, and regime changes.** The run-rate is a blended level, not a
  slope; a genuine ramp or a step-change in behavior is not extrapolated.
- **Backtest-driven recalibration.** MAPE backtesting (PRD §4.3) activates only
  **after one closed cycle** exists to score against; until then the parameter
  defaults above stand and the model has not been empirically recalibrated.

---

*See also: PRD §4.3 (forecasting), §1.1 (credit unit), §1.2 (monthly pool reset),
§5 Q2 (paid-usage flag). Allowance/cliff math: `packages/core/src/poolAllowance.ts`.*
