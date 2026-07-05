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

// Enterprise-scope series: total credits burned per day across every cost
// center (both pool-covered AND metered draw -- `quantity`, not
// `discount_amount`-derived pool-only credits; see this module's README note
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
