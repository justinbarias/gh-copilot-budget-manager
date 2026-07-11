import {
  backtest,
  cycleBounds,
  forecast,
  type AllowanceLineFn,
  type DailyBurn,
  type ForecastResult,
} from '@copilot-budget/core';

// Task 5.4: folds fetched usage rows into the DailyBurn[] series core's
// forecast()/backtest() consume, and glues those two pure functions together
// into "one ready-to-persist forecast" per scope. This module is Node-free
// (no octokit/db import) -- github-impl.ts does the fetching (async, I/O) and
// sync-now.ts does the persisting (db writes); this is the pure fold in
// between, kept out of `core` only because it shapes fixture/wire rows
// (UsageItem/CreditsUsedItem-flavoured), not domain primitives.

const DAY_MS = 24 * 60 * 60 * 1000;

function dayStartMs(iso: string): number {
  return Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
}

// Horizon: far enough past the 1 Sep 2026 cliff (spec §1.1) for every scope's
// persisted forecast to render the step-change, whichever month `asOfDate`
// falls in -- 90 days comfortably covers a mid-cycle sync in any month of the
// promo window and the one full cycle after the cliff. Not spec-mandated
// (forecast.ts's own doc comment leaves the exact horizon length open, same
// as its other tuning knobs); exposed as a parameter default for the same
// reason those are.
export const DEFAULT_FORECAST_HORIZON_DAYS = 90;

export interface DatedCredits {
  date: string; // 'YYYY-MM-DD'
  credits: number;
}

// Folds raw (possibly unsorted, possibly multiple-rows-per-day) dated credit
// rows into one DailyBurn per day, summed. Rows strictly AFTER `asOfDate` are
// dropped -- forecast()/backtest() do NOT filter look-ahead themselves (only
// backtest's own internal replay does, via its evalStart/evalEnd slicing);
// callers are trusted to pass only genuine history. Without this filter, the
// MSW fixture world's Aug31/Sep1 promo-cliff edge rows (dated AFTER the
// June `asOfDate` -- they exist purely to demonstrate the cliff, not as real
// "already happened" history) would leak into the trailing-mean/seasonality
// estimation as if they'd already occurred.
export function toDailyBurn(rows: readonly DatedCredits[], asOfDate: Date): DailyBurn[] {
  const asOfMs = Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), asOfDate.getUTCDate());
  const byDate = new Map<string, number>();
  for (const row of rows) {
    if (dayStartMs(row.date) > asOfMs) continue;
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.credits);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, credits]) => ({ date, credits }));
}

export interface AssembleUsageRow {
  date: string;
  costCenterId: string | null;
  quantity: number;
}

// ---------------------------------------------------------------------------
// Monthly-aggregate expansion (item 23, live-pinned 2026-07-09): live R5
// usage items are MONTHLY AGGREGATES -- one row per (month x bucket), dated
// first-of-month, the current month's row month-to-date cumulative. Fed raw
// into toDailyBurn, each month would read as a single enormous "day" and
// core's trailing-7 run-rate would treat a month total as a daily rate (the
// live P50 ~= cycle-total x 31 forecast blow-up). This transform detects the
// aggregate signature PER (costCenterId, month) GROUP -- all of a group's
// rows on ONE first-of-month date -- and spreads the group's total evenly
// across the days it covers:
//   - CLOSED months (before the as-of month): total / daysInMonth on every
//     calendar day (a complete aggregate).
//   - the CURRENT month: MTD-cumulative / elapsed-days across days
//     1..asOfDate's day-of-month (item 23's "run-rate = current-month
//     cumulative / daysElapsed").
// Per-day groups (the whole fixture world; any per-day tenant) pass through
// UNTOUCHED -- fixture-world series stay byte-identical.
//
// STATISTICAL NOTE (documented design choice): a flat spread carries NO
// weekday-seasonality signal -- monthly aggregates cannot recover it. Live
// enterprise/cost-center forecasts therefore run without weekday shape (the
// run-rate/level math is unaffected), and their backtest MAPE evaluates
// level accuracy against equally-flat actuals (self-consistent). User-scope
// forecasts are untouched: they train on R6's genuinely-daily per-user rows
// and keep real seasonality.
export function expandMonthlyAggregates(rows: readonly AssembleUsageRow[], asOfDate: Date): AssembleUsageRow[] {
  const asOfMonth = `${asOfDate.getUTCFullYear()}-${String(asOfDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const asOfDayOfMonth = asOfDate.getUTCDate();

  const groups = new Map<string, AssembleUsageRow[]>();
  for (const row of rows) {
    const key = `${row.costCenterId ?? '<none>'}|${row.date.slice(0, 7)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const result: AssembleUsageRow[] = [];
  for (const group of groups.values()) {
    const distinctDates = new Set(group.map((r) => r.date));
    const isAggregate = distinctDates.size === 1 && [...distinctDates][0]!.endsWith('-01');
    if (!isAggregate) {
      result.push(...group); // per-day grain: untouched (fixture identity)
      continue;
    }

    const month = group[0]!.date.slice(0, 7);
    const year = Number(month.slice(0, 4));
    const monthNum = Number(month.slice(5, 7));
    const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    // Future months (relative to as-of) keep the full-month spread too --
    // toDailyBurn drops post-as-of rows anyway, so only closed/current matter.
    const spreadDays = month === asOfMonth ? Math.max(1, Math.min(asOfDayOfMonth, daysInMonth)) : daysInMonth;
    const total = group.reduce((sum, r) => sum + r.quantity, 0);
    const perDay = total / spreadDays;
    const costCenterId = group[0]!.costCenterId;
    for (let day = 1; day <= spreadDays; day++) {
      result.push({ date: `${month}-${String(day).padStart(2, '0')}`, costCenterId, quantity: perDay });
    }
  }
  return result;
}

// Enterprise-scope series: total credits burned per day across every cost
// center (both pool-covered AND metered draw -- `quantity`, not the
// `discountAmount`-derived pool-only credits; see this module's README note
// below). A cost center that's already tipped into metered keeps contributing
// to this series, which is exactly what lets forecast()'s own cycleMetered
// bookkeeping (not this fold) decide, per PROJECTED day, whether the
// enterprise-wide allowance line has been crossed.
export function assembleEnterpriseSeries(rows: readonly AssembleUsageRow[], asOfDate: Date): DailyBurn[] {
  return toDailyBurn(
    rows.map((r) => ({ date: r.date, credits: r.quantity })),
    asOfDate,
  );
}

// Cost-center-scope series: same total-credits convention, filtered to one CC.
export function assembleCostCenterSeries(
  rows: readonly AssembleUsageRow[],
  costCenterId: string,
  asOfDate: Date,
): DailyBurn[] {
  return toDailyBurn(
    rows.filter((r) => r.costCenterId === costCenterId).map((r) => ({ date: r.date, credits: r.quantity })),
    asOfDate,
  );
}

// ---------------------------------------------------------------------------
// Daily billing-fact assembly (item 25, forecast history rewire): live
// enterprise/cost-center forecasts train on REAL per-day billing aggregates
// (schema.ts's ai_credit_daily_fact) instead of the month-lump flat-spread
// expandMonthlyAggregates produced. Each fact row already IS one day's truth
// for one scope -- the enterprise (costCenterId null) row is the tenant total,
// and each cost center has its own row -- so NO monthly spread is needed:
// fold each scope's rows straight into DailyBurn[] via toDailyBurn (dedup by
// day + sort + the same post-asOf look-ahead drop every series gets). The
// enterprise series is the null-costCenter rows ONLY; it is NEVER Σ over the CC
// rows, because cost centers may not partition the tenant (unassociated usage
// exists) -- the daily fact table's own grain comment. This carries genuine
// day-to-day variance into core's variance model, which the flat month-spread
// could not (a constant daily series has zero measured variance -> a degenerate
// band; see forecast.ts's variance path). Pure/DB-free like the rest of this
// module: github-impl.ts reads the facts and hands the row array in.
export interface DailyCreditsFactInput {
  date: string; // 'YYYY-MM-DD'
  /** NULL === the enterprise/tenant-total row; a cost-center id otherwise. */
  costCenterId: string | null;
  creditsUsed: number;
}

export interface DailyBurnByScope {
  /** The tenant-total series (null-costCenter facts only). */
  enterprise: DailyBurn[];
  /** Per cost-center id, that cost center's own daily series. */
  costCenter: Map<string, DailyBurn[]>;
}

export interface AssembleDailyBurnOptions {
  /**
   * Hybrid enterprise fallback (live incident 2026-07-11): the per-day metrics
   * Σ (Σ per-user creditsUsed for that date) the ENTERPRISE series falls back to
   * on any day the billing daily fact is 0 or absent. Motivation: this tenant's
   * billing ai_credit day-grain returns ZERO for the CURRENT month (real only
   * for closed months), while per-user metrics for those same days ARE real --
   * so a billing-only enterprise series read flat 0 for the whole current cycle
   * (P50=0, flat actual line). Billing wins whenever it has a nonzero value; the
   * metrics Σ is the fresh-signal floor otherwise. NOTE: the metrics Σ
   * UNDERESTIMATES the true billing total (unattributed/lag gap -- live evidence:
   * metrics July Σ≈110.6k vs billing month-grain 133k), but it is real fresh
   * data, which is strictly better than a flat 0. When the billing endpoint
   * later starts returning real current-month day values, billing naturally
   * re-wins (the refresh window + latest-snapshot-wins picks them up).
   * Cost-center series get NO fallback (metrics carry no CC attribution here).
   */
  enterpriseFallbackByDate?: ReadonlyMap<string, number>;
}

// Drop consecutive zero-credit days at the END of a series -- not-yet-reported
// trailing days, indistinguishable from billing-settling lag, so treated as
// "no data yet" rather than genuine zeros. INTERIOR zeros are KEPT (a real quiet
// day mid-series is genuine signal the variance model should see). The
// forecaster's own settling window then applies on top of this. Applied to
// every assembled scope (enterprise after the hybrid merge, and each CC).
function trimTrailingZeros(series: readonly DailyBurn[]): DailyBurn[] {
  let end = series.length;
  while (end > 0 && series[end - 1]!.credits === 0) end--;
  return series.slice(0, end);
}

// Enterprise hybrid: billing daily value per day, falling back to the metrics Σ
// for that date wherever billing is 0/absent (see AssembleDailyBurnOptions). The
// date domain is the UNION of billing enterprise dates and fallback dates (both
// clamped to asOfDate) so a day the billing feed never reported but metrics did
// still contributes its fresh signal. Without a fallback map this is exactly the
// old billing-only enterprise fold.
function assembleEnterpriseHybrid(
  rows: readonly DailyCreditsFactInput[],
  fallbackByDate: ReadonlyMap<string, number> | undefined,
  asOfDate: Date,
): DailyBurn[] {
  const billing = toDailyBurn(
    rows.filter((r) => r.costCenterId === null).map((r) => ({ date: r.date, credits: r.creditsUsed })),
    asOfDate,
  );
  if (fallbackByDate === undefined) return billing;

  const asOfMs = Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), asOfDate.getUTCDate());
  const billingByDate = new Map(billing.map((d) => [d.date, d.credits] as const));
  const dates = new Set<string>(billing.map((d) => d.date));
  for (const date of fallbackByDate.keys()) {
    if (dayStartMs(date) <= asOfMs) dates.add(date);
  }
  return [...dates]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((date) => {
      const billed = billingByDate.get(date) ?? 0;
      // billing wins whenever it has a positive value; else the metrics Σ; else 0.
      const credits = billed > 0 ? billed : (fallbackByDate.get(date) ?? 0);
      return { date, credits };
    });
}

export function assembleDailyBurnByScope(
  rows: readonly DailyCreditsFactInput[],
  asOfDate: Date,
  opts?: AssembleDailyBurnOptions,
): DailyBurnByScope {
  const enterprise = trimTrailingZeros(assembleEnterpriseHybrid(rows, opts?.enterpriseFallbackByDate, asOfDate));
  const costCenter = new Map<string, DailyBurn[]>();
  const ccIds = new Set<string>();
  for (const r of rows) if (r.costCenterId !== null) ccIds.add(r.costCenterId);
  for (const ccId of ccIds) {
    costCenter.set(
      ccId,
      trimTrailingZeros(
        toDailyBurn(
          rows.filter((r) => r.costCenterId === ccId).map((r) => ({ date: r.date, credits: r.creditsUsed })),
          asOfDate,
        ),
      ),
    );
  }
  return { enterprise, costCenter };
}

export interface AssembleCreditsUsedRow {
  date: string;
  userId: string;
  creditsUsed: number;
}

// User-scope series: the per-user metrics report's own credit unit (no
// pool-vs-metered distinction exists at this grain -- a ULB is a hard stop in
// BOTH phases, CLAUDE.md §5, so "credits used" is the only figure that
// matters for a user's own block-date projection).
export function assembleUserSeries(rows: readonly AssembleCreditsUsedRow[], userId: string, asOfDate: Date): DailyBurn[] {
  return toDailyBurn(
    rows.filter((r) => r.userId === userId).map((r) => ({ date: r.date, credits: r.creditsUsed })),
    asOfDate,
  );
}

export interface ComputedScopeForecast {
  result: ForecastResult;
  mape: number | null;
}

// Picks the backtest evaluation window (PRD §4.3 "nightly backtest (MAPE)"):
// the last FULLY CLOSED calendar month before asOfDate's current cycle. Only
// runs the backtest at all if `history` has at least one day strictly before
// that window's start -- i.e. at least one earlier month of training data
// exists. Without this guard, an entity with no history before the window
// (most heavy users here only have the current, still-open cycle) would
// backtest against an empty window and silently report a meaningless mape:0
// (backtest()'s own "0 errors observed -> mape 0" fallback, indistinguishable
// from a genuinely perfect forecast) rather than the honest "insufficient
// history" null this function returns instead.
function computeMape(history: readonly DailyBurn[], asOfDate: Date, allowance: AllowanceLineFn): number | null {
  const { cycleStart } = cycleBounds(asOfDate);
  const evalEndMs = cycleStart.getTime() - DAY_MS;
  const evalEnd = new Date(evalEndMs);
  const evalStart = new Date(Date.UTC(evalEnd.getUTCFullYear(), evalEnd.getUTCMonth(), 1));

  const hasEarlierData = history.some((d) => dayStartMs(d.date) < evalStart.getTime());
  if (!hasEarlierData) return null;

  return backtest({ history, evalStart, evalEnd, allowance }).mape;
}

// Glues forecast()+backtest() together for one scope/entity: the horizon
// crosses the 1 Sep 2026 cliff (see DEFAULT_FORECAST_HORIZON_DAYS), and mape
// is null wherever computeMape's window-guard says history doesn't suffice.
export function computeScopeForecast(params: {
  history: readonly DailyBurn[];
  asOfDate: Date;
  allowance: AllowanceLineFn;
  paidUsageEnabled: boolean;
  horizonDays?: number;
}): ComputedScopeForecast {
  const asOfMs = Date.UTC(params.asOfDate.getUTCFullYear(), params.asOfDate.getUTCMonth(), params.asOfDate.getUTCDate());
  const horizonEndDate = new Date(asOfMs + (params.horizonDays ?? DEFAULT_FORECAST_HORIZON_DAYS) * DAY_MS);

  const result = forecast({
    history: params.history,
    asOfDate: params.asOfDate,
    horizonEndDate,
    allowance: params.allowance,
    paidUsageEnabled: params.paidUsageEnabled,
  });

  const mape = computeMape(params.history, params.asOfDate, params.allowance);
  return { result, mape };
}
