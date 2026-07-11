import { describe, expect, it } from 'vitest';
import { fixedAllowanceLine } from '@copilot-budget/core';
import {
  DEFAULT_FORECAST_HORIZON_DAYS,
  assembleCostCenterSeries,
  assembleDailyBurnByScope,
  assembleEnterpriseSeries,
  assembleUserSeries,
  computeScopeForecast,
  expandMonthlyAggregates,
  toDailyBurn,
  type DailyCreditsFactInput,
} from './compute.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function flatHistory(startIso: string, days: number, creditsPerDay: number): { date: string; credits: number }[] {
  const start = Date.parse(`${startIso}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
    credits: creditsPerDay,
  }));
}

describe('toDailyBurn', () => {
  it('sums same-day rows and returns them sorted ascending', () => {
    const rows = [
      { date: '2026-06-02', credits: 10 },
      { date: '2026-06-01', credits: 5 },
      { date: '2026-06-01', credits: 3 },
    ];
    expect(toDailyBurn(rows, new Date('2026-06-14T00:00:00.000Z'))).toEqual([
      { date: '2026-06-01', credits: 8 },
      { date: '2026-06-02', credits: 10 },
    ]);
  });

  it('drops rows strictly AFTER asOfDate -- no look-ahead into future/hypothetical fixture rows', () => {
    const rows = [
      { date: '2026-06-14', credits: 10 },
      { date: '2026-06-15', credits: 999 }, // e.g. the MSW Aug31/Sep1 promo-cliff edge fixture, relative to an earlier asOfDate
    ];
    expect(toDailyBurn(rows, new Date('2026-06-14T00:00:00.000Z'))).toEqual([{ date: '2026-06-14', credits: 10 }]);
  });

  it('returns an empty series for no rows', () => {
    expect(toDailyBurn([], new Date('2026-06-14T00:00:00.000Z'))).toEqual([]);
  });
});

describe('assembleEnterpriseSeries / assembleCostCenterSeries / assembleUserSeries', () => {
  const usageRows = [
    { date: '2026-06-01', costCenterId: 'cc-a', quantity: 100 },
    { date: '2026-06-01', costCenterId: 'cc-b', quantity: 50 },
    { date: '2026-06-02', costCenterId: 'cc-a', quantity: 200 },
  ];
  const asOfDate = new Date('2026-06-14T00:00:00.000Z');

  it('enterprise scope sums total credits across every cost center', () => {
    expect(assembleEnterpriseSeries(usageRows, asOfDate)).toEqual([
      { date: '2026-06-01', credits: 150 },
      { date: '2026-06-02', credits: 200 },
    ]);
  });

  it('cost-center scope filters to one CC only', () => {
    expect(assembleCostCenterSeries(usageRows, 'cc-a', asOfDate)).toEqual([
      { date: '2026-06-01', credits: 100 },
      { date: '2026-06-02', credits: 200 },
    ]);
    expect(assembleCostCenterSeries(usageRows, 'cc-does-not-exist', asOfDate)).toEqual([]);
  });

  it('user scope filters credits-used rows to one user only', () => {
    const creditRows = [
      { date: '2026-06-01', userId: 'u1', creditsUsed: 40 },
      { date: '2026-06-01', userId: 'u2', creditsUsed: 999 },
    ];
    expect(assembleUserSeries(creditRows, 'u1', asOfDate)).toEqual([{ date: '2026-06-01', credits: 40 }]);
  });
});

describe('computeScopeForecast', () => {
  const asOfDate = new Date('2026-06-14T00:00:00.000Z');

  it('mape is null when there is no full prior closed month of history before the eval window', () => {
    // Only the open June cycle's own data -- no April/May at all.
    const history = flatHistory('2026-06-01', 14, 100);
    const { mape } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: false,
    });
    expect(mape).toBeNull();
  });

  it('mape is computed (non-null) once a full prior closed month of history exists', () => {
    const history = [
      ...flatHistory('2026-04-01', 30, 100),
      ...flatHistory('2026-05-01', 31, 100),
      ...flatHistory('2026-06-01', 14, 100),
    ];
    const { mape } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: false,
    });
    expect(mape).not.toBeNull();
    // A perfectly flat series replayed against a flat forecast should settle
    // at a near-zero error, not merely "some number".
    expect(mape as number).toBeLessThan(1);
  });

  it('a permanently-zero allowance (cap-off CC / no-binding-ULB user) never reports exhaustion', () => {
    const history = flatHistory('2026-06-01', 14, 5000); // heavy daily burn -- would exhaust any real cap
    const { result } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(0),
      paidUsageEnabled: false,
    });
    expect(result.exhaustionDate).toBeNull();
    expect(result.exhaustionDateP90).toBeNull();
    expect(result.runwayDays).toBeNull();
    expect(result.projectedMeteredCredits).toBe(0);
  });

  it('the default horizon extends 90 days past asOfDate, crossing the 1 Sep 2026 cliff', () => {
    const history = flatHistory('2026-06-01', 14, 100);
    const { result } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: false,
    });
    expect(DEFAULT_FORECAST_HORIZON_DAYS).toBe(90);
    expect(result.dailySeries.at(-1)?.date).toBe('2026-09-12');
    expect(result.dailySeries.some((d) => d.date === '2026-09-01')).toBe(true);
  });

  it('a custom horizonDays overrides the default', () => {
    const history = flatHistory('2026-06-01', 14, 100);
    const { result } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: false,
      horizonDays: 7,
    });
    expect(result.dailySeries.at(-1)?.date).toBe('2026-06-21');
  });
});

// Item 23 (live-pinned 2026-07-09): live R5 months arrive as ONE aggregate
// row per (month x bucket), first-of-month-dated, the current month
// MTD-cumulative. Fed raw into toDailyBurn, core's trailing-7 run-rate reads
// a month total as a daily rate (the live P50 ~= total x 31 forecast
// blow-up). expandMonthlyAggregates spreads aggregates into flat daily rows;
// per-day rows pass through untouched. Every expectation hand-computed.
describe('expandMonthlyAggregates', () => {
  const asOf = new Date('2026-07-09T00:00:00.000Z'); // day 9 of July

  it('spreads a CLOSED month aggregate evenly across every calendar day (June: 300,000 / 30 = 10,000/day)', () => {
    const rows = expandMonthlyAggregates([{ date: '2026-06-01', costCenterId: 'cc-1', quantity: 300_000 }], asOf);
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({ date: '2026-06-01', costCenterId: 'cc-1', quantity: 10_000 });
    expect(rows[29]).toEqual({ date: '2026-06-30', costCenterId: 'cc-1', quantity: 10_000 });
    // The spread is total-preserving.
    expect(rows.reduce((s, r) => s + r.quantity, 0)).toBeCloseTo(300_000, 6);
  });

  it('spreads the CURRENT month MTD-cumulative across the elapsed days only (July day 9: 90,000 / 9 = 10,000/day)', () => {
    const rows = expandMonthlyAggregates([{ date: '2026-07-01', costCenterId: null, quantity: 90_000 }], asOf);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({ date: '2026-07-01', costCenterId: null, quantity: 10_000 });
    expect(rows[8]).toEqual({ date: '2026-07-09', costCenterId: null, quantity: 10_000 });
  });

  it('groups per (costCenterId, month): two cost centers in the same aggregate month spread independently', () => {
    const rows = expandMonthlyAggregates(
      [
        { date: '2026-06-01', costCenterId: 'cc-a', quantity: 3_000 },
        { date: '2026-06-01', costCenterId: 'cc-b', quantity: 6_000 },
      ],
      asOf,
    );
    const a = rows.filter((r) => r.costCenterId === 'cc-a');
    const b = rows.filter((r) => r.costCenterId === 'cc-b');
    expect(a).toHaveLength(30);
    expect(b).toHaveLength(30);
    expect(a[0]!.quantity).toBeCloseTo(100, 9);
    expect(b[0]!.quantity).toBeCloseTo(200, 9);
  });

  it('passes PER-DAY groups through untouched (the whole fixture world -- simulation stays byte-identical)', () => {
    const perDay = [
      { date: '2026-06-02', costCenterId: 'cc-1', quantity: 2_876 },
      { date: '2026-06-04', costCenterId: 'cc-1', quantity: 4_314 },
      // A single row NOT on the 1st (the Aug-31 cliff fixture shape) is
      // per-day too -- the aggregate signature requires first-of-month.
      { date: '2026-08-31', costCenterId: 'cc-1', quantity: 468 },
    ];
    expect(expandMonthlyAggregates(perDay, asOf)).toEqual(perDay);
  });

  it('run-rate sanity end to end: an expanded live-shaped history yields a daily-rate series, not a month-total spike', () => {
    // June closed aggregate (300,000) + July MTD aggregate (90,000 by day 9):
    // the enterprise series must read 10,000/day THROUGHOUT -- the trailing-7
    // rate a forecast sees is 10,000/day, never 90,000/day.
    const series = assembleEnterpriseSeries(
      expandMonthlyAggregates(
        [
          { date: '2026-06-01', costCenterId: 'cc-1', quantity: 300_000 },
          { date: '2026-07-01', costCenterId: 'cc-1', quantity: 90_000 },
        ],
        asOf,
      ),
      asOf,
    );
    expect(series).toHaveLength(39); // 30 June days + 9 elapsed July days
    expect(series.every((d) => Math.abs(d.credits - 10_000) < 1e-6)).toBe(true);
  });
});

describe('assembleDailyBurnByScope (item 25 daily billing facts)', () => {
  const asOf = new Date('2026-06-14T00:00:00.000Z');

  it('splits enterprise (null costCenterId) from per-CC series; enterprise is the null rows ONLY, never Σ CC rows', () => {
    const rows: DailyCreditsFactInput[] = [
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 }, // tenant total
      { date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 60 },
      { date: '2026-06-01', costCenterId: 'cc-b', creditsUsed: 30 },
      { date: '2026-06-02', costCenterId: null, creditsUsed: 120 },
      { date: '2026-06-02', costCenterId: 'cc-a', creditsUsed: 70 },
    ];
    const { enterprise, costCenter } = assembleDailyBurnByScope(rows, asOf);
    // Enterprise = the tenant-total rows (100, 120) -- NOT 60+30=90 / 70.
    expect(enterprise).toEqual([
      { date: '2026-06-01', credits: 100 },
      { date: '2026-06-02', credits: 120 },
    ]);
    expect(costCenter.get('cc-a')).toEqual([
      { date: '2026-06-01', credits: 60 },
      { date: '2026-06-02', credits: 70 },
    ]);
    expect(costCenter.get('cc-b')).toEqual([{ date: '2026-06-01', credits: 30 }]);
  });

  it('sums same (date, scope) rows, sorts ascending, and drops rows strictly after asOfDate', () => {
    const rows: DailyCreditsFactInput[] = [
      { date: '2026-06-02', costCenterId: null, creditsUsed: 10 },
      { date: '2026-06-01', costCenterId: null, creditsUsed: 5 },
      { date: '2026-06-01', costCenterId: null, creditsUsed: 3 }, // same (date, scope) -> summed
      { date: '2026-06-30', costCenterId: null, creditsUsed: 999 }, // strictly after asOf -> dropped
    ];
    expect(assembleDailyBurnByScope(rows, asOf).enterprise).toEqual([
      { date: '2026-06-01', credits: 8 },
      { date: '2026-06-02', credits: 10 },
    ]);
  });
});

describe('daily-fact forecast: materially wide variance band (item 25)', () => {
  // The fix's crux: a REAL per-day series carries day-to-day variance the core
  // variance model surfaces as a wide P90 band; the old month-lump flat-spread
  // produced a CONSTANT daily series whose measured variance is 0 (a degenerate
  // band). Both cases run the SAME full pipeline (assemble -> computeScopeForecast
  // -> core forecast()).
  //
  // The varied series is a flat-weekday-index construction so every number below
  // is hand-derivable: 35 consecutive days (2026-05-01 .. 2026-06-04), value by
  // 7-day block = [90, 110, 80, 120, 100]. Any 7 consecutive days cover each
  // weekday once, so every weekday sees {90,110,80,120,100} -> weekday mean 100 =
  // overall mean -> ALL weekday indices == 1 (no seasonality to deseasonalize).
  // forecast() drops the last settling day (settlingWindowDays default 1), so
  //   nEstim = 34; estimation values = [90x7, 110x7, 80x7, 120x7, 100x6], mean 100.
  //   SS = 7*10^2 + 7*10^2 + 7*20^2 + 7*20^2 + 0 = 700+700+2800+2800 = 7000
  //   dailyVariance (sample, /(n-1)) = 7000/33 = 212.121212...
  //   floor faded (nEstim 34 >= floorFadeDays 14) -> effectiveVariance = dailyVariance
  //   first projected day (k=1): std = sqrt(effVar + effVar/nEstim)
  //                                   = sqrt(212.1212 + 212.1212/34) = 14.77701
  //   band gap (p90 - p50) = zP90(1.2816) * std = 18.938 credits
  const BLOCK_VALUES = [90, 110, 80, 120, 100];
  const START_MS = Date.parse('2026-05-01T00:00:00.000Z');
  const variedFacts: DailyCreditsFactInput[] = Array.from({ length: 35 }, (_, i) => ({
    date: new Date(START_MS + i * DAY_MS).toISOString().slice(0, 10),
    costCenterId: null,
    creditsUsed: BLOCK_VALUES[Math.floor(i / 7)]!,
  }));
  const asOfDate = new Date('2026-06-04T00:00:00.000Z');

  it('varied daily facts -> nEstim/dailyVariance/effectiveVariance and the k=1 band gap match the hand-derived model values', () => {
    const history = assembleDailyBurnByScope(variedFacts, asOfDate).enterprise;
    expect(history).toHaveLength(35);

    const { result } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000_000), // huge -> never exhausts; band gap is allowance-independent
      paidUsageEnabled: false,
    });

    expect(result.basis.nEstim).toBe(34);
    expect(result.basis.dailyVariance).toBeCloseTo(7000 / 33, 6); // 212.121212...
    expect(result.basis.effectiveVariance).toBeCloseTo(7000 / 33, 6); // floor faded -> equals measured

    // First projected day: hand-derived gap from nEstim / effectiveVariance / SE.
    const firstProjected = result.dailySeries.find((d) => d.actualCumulative === undefined);
    expect(firstProjected).toBeDefined();
    const effVar = 7000 / 33;
    const expectedStd = Math.sqrt(effVar + effVar / 34);
    const expectedGap = 1.2816 * expectedStd;
    expect(expectedGap).toBeCloseTo(18.938, 2);
    expect(firstProjected!.p90Cumulative - firstProjected!.p50Cumulative).toBeCloseTo(expectedGap, 4);
    // Materially wide, not a rounding artifact.
    expect(firstProjected!.p90Cumulative - firstProjected!.p50Cumulative).toBeGreaterThan(15);
  });

  it('contrast: a CONSTANT (month-lump flat-spread-shaped) series has zero measured variance -> a degenerate band', () => {
    const flat = flatHistory('2026-05-01', 35, 100); // same total shape, no day-to-day swing
    const { result } = computeScopeForecast({
      history: flat,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000_000),
      paidUsageEnabled: false,
    });
    expect(result.basis.dailyVariance).toBe(0);
    expect(result.basis.effectiveVariance).toBe(0); // floor faded AND measured 0 -> band collapses
    const firstProjected = result.dailySeries.find((d) => d.actualCumulative === undefined);
    expect(firstProjected!.p90Cumulative - firstProjected!.p50Cumulative).toBe(0);
  });
});

// ===========================================================================
// Hybrid enterprise assembly + trailing-zero trim (live incident 2026-07-11).
// This tenant's billing ai_credit DAY-grain returns 0 for the CURRENT month
// (real only for closed months), so a billing-only enterprise series read flat
// 0 all cycle (P50=0, flat actual line). The fix: where the billing daily value
// is 0/absent, the enterprise series falls back to the per-user metrics daily Σ
// for that day; and every scope trims consecutive trailing zeros (not-yet-
// reported days, indistinguishable from settling lag). Interior zeros stay.
// ===========================================================================
describe('assembleDailyBurnByScope hybrid enterprise fallback (live incident 2026-07-11)', () => {
  const asOf = new Date('2026-06-14T00:00:00.000Z');

  it('billing 0 + metrics 500 -> 500 (metrics fills the billing gap)', () => {
    const rows: DailyCreditsFactInput[] = [{ date: '2026-06-01', costCenterId: null, creditsUsed: 0 }];
    const fallback = new Map([['2026-06-01', 500]]);
    expect(assembleDailyBurnByScope(rows, asOf, { enterpriseFallbackByDate: fallback }).enterprise).toEqual([
      { date: '2026-06-01', credits: 500 },
    ]);
  });

  it('billing 300 + metrics 500 -> 300 (billing wins whenever it has a nonzero value)', () => {
    const rows: DailyCreditsFactInput[] = [{ date: '2026-06-01', costCenterId: null, creditsUsed: 300 }];
    const fallback = new Map([['2026-06-01', 500]]);
    expect(assembleDailyBurnByScope(rows, asOf, { enterpriseFallbackByDate: fallback }).enterprise).toEqual([
      { date: '2026-06-01', credits: 300 },
    ]);
  });

  it('trailing days where BOTH billing and metrics are 0 are trimmed', () => {
    const rows: DailyCreditsFactInput[] = [
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
      { date: '2026-06-02', costCenterId: null, creditsUsed: 0 },
    ];
    const fallback = new Map([['2026-06-02', 0]]); // both 0 on the trailing day
    expect(assembleDailyBurnByScope(rows, asOf, { enterpriseFallbackByDate: fallback }).enterprise).toEqual([
      { date: '2026-06-01', credits: 100 },
    ]);
  });

  it('an INTERIOR zero (billing 0, metrics 0, real days both sides) is KEPT as 0', () => {
    const rows: DailyCreditsFactInput[] = [
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
      { date: '2026-06-02', costCenterId: null, creditsUsed: 0 },
      { date: '2026-06-03', costCenterId: null, creditsUsed: 120 },
    ];
    const fallback = new Map([['2026-06-02', 0]]);
    expect(assembleDailyBurnByScope(rows, asOf, { enterpriseFallbackByDate: fallback }).enterprise).toEqual([
      { date: '2026-06-01', credits: 100 },
      { date: '2026-06-02', credits: 0 }, // interior quiet day preserved
      { date: '2026-06-03', credits: 120 },
    ]);
  });

  it('a metrics-only date (billing feed never reported it) still contributes via the union', () => {
    const rows: DailyCreditsFactInput[] = [{ date: '2026-06-01', costCenterId: null, creditsUsed: 100 }];
    const fallback = new Map([
      ['2026-06-01', 999], // billing 100 > 0 wins over this
      ['2026-06-02', 250], // no billing row at all -> metrics fills it
    ]);
    expect(assembleDailyBurnByScope(rows, asOf, { enterpriseFallbackByDate: fallback }).enterprise).toEqual([
      { date: '2026-06-01', credits: 100 },
      { date: '2026-06-02', credits: 250 },
    ]);
  });
});

describe('assembleDailyBurnByScope trailing-zero trim (all scopes)', () => {
  const asOf = new Date('2026-06-14T00:00:00.000Z');

  it('CC series [100,120,0,0] -> [100,120] (trailing zeros dropped)', () => {
    const rows: DailyCreditsFactInput[] = [
      { date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 100 },
      { date: '2026-06-02', costCenterId: 'cc-a', creditsUsed: 120 },
      { date: '2026-06-03', costCenterId: 'cc-a', creditsUsed: 0 },
      { date: '2026-06-04', costCenterId: 'cc-a', creditsUsed: 0 },
    ];
    expect(assembleDailyBurnByScope(rows, asOf).costCenter.get('cc-a')).toEqual([
      { date: '2026-06-01', credits: 100 },
      { date: '2026-06-02', credits: 120 },
    ]);
  });

  it('CC series [100,0,120] -> unchanged (interior zero kept)', () => {
    const rows: DailyCreditsFactInput[] = [
      { date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 100 },
      { date: '2026-06-02', costCenterId: 'cc-a', creditsUsed: 0 },
      { date: '2026-06-03', costCenterId: 'cc-a', creditsUsed: 120 },
    ];
    expect(assembleDailyBurnByScope(rows, asOf).costCenter.get('cc-a')).toEqual([
      { date: '2026-06-01', credits: 100 },
      { date: '2026-06-02', credits: 0 },
      { date: '2026-06-03', credits: 120 },
    ]);
  });
});

// End-to-end shaped like the live incident: a 35-day contiguous enterprise
// series spanning 2026-06-07 .. 2026-07-11 (asOf), split by provenance --
//   - JUNE days (06-07..06-30): REAL billing day-grain (nonzero).
//   - JULY days (07-01..07-11): billing day-grain ZERO (the tenant's current-
//     month behavior) but per-user metrics Σ carry real values.
// The block-value construction ([90,110,80,120,100] per 7-day block) is the same
// flat-weekday-index series the item-25 variance test uses, so every model number
// is hand-derivable AND every weekday index is 1 (35 = 5x7 contiguous days ->
// each weekday sees each block value exactly once -> weekday mean == overall mean).
describe('hybrid assembly end-to-end (live incident shape: June billing + July metrics)', () => {
  const BLOCK_VALUES = [90, 110, 80, 120, 100];
  const START_MS = Date.parse('2026-06-07T00:00:00.000Z'); // day0
  const asOfDate = new Date('2026-07-11T00:00:00.000Z'); // day34
  const dayIso = (i: number): string => new Date(START_MS + i * DAY_MS).toISOString().slice(0, 10);
  const blockAt = (i: number): number => BLOCK_VALUES[Math.floor(i / 7)]!;

  // June = day0..day23 (2026-06-07..06-30); July = day24..day34 (2026-07-01..07-11).
  const JUNE_LAST_INDEX = 23;

  // Billing facts: June carries the real block value; July is all zeros.
  const billingRows: DailyCreditsFactInput[] = Array.from({ length: 35 }, (_, i) => ({
    date: dayIso(i),
    costCenterId: null,
    creditsUsed: i <= JUNE_LAST_INDEX ? blockAt(i) : 0,
  }));
  // Metrics Σ per date: July carries the real block value; June carries a WRONG
  // value (999) that billing must override -- proving billing wins on June days.
  const fallbackByDate = new Map<string, number>(
    Array.from({ length: 35 }, (_, i) => [dayIso(i), i <= JUNE_LAST_INDEX ? 999 : blockAt(i)] as const),
  );

  const expectedSeries = Array.from({ length: 35 }, (_, i) => ({ date: dayIso(i), credits: blockAt(i) }));

  it('assembles June-billing + July-metrics into the full block series (billing wins June, metrics fills July)', () => {
    const { enterprise } = assembleDailyBurnByScope(billingRows, asOfDate, { enterpriseFallbackByDate: fallbackByDate });
    expect(enterprise).toEqual(expectedSeries);
  });

  it('CONTRAST: billing-only assembly (no fallback) trims ALL trailing July zeros -> the flat-0 bug', () => {
    const { enterprise } = assembleDailyBurnByScope(billingRows, asOfDate);
    // Every July day was 0 -> trimmed as trailing; the series ends on 2026-06-30
    // (day23), so July's current cycle has NO history -> the P50=0 / flat-actual
    // symptom the maintainer reported.
    expect(enterprise).toHaveLength(24);
    expect(enterprise[enterprise.length - 1]).toEqual({ date: '2026-06-30', credits: blockAt(JUNE_LAST_INDEX) });
  });

  it('the hybrid series yields a nonzero run-rate, nonzero July P50, and a materially wide band (hand-derived)', () => {
    const history = assembleDailyBurnByScope(billingRows, asOfDate, { enterpriseFallbackByDate: fallbackByDate }).enterprise;
    const { result } = computeScopeForecast({
      history,
      asOfDate,
      allowance: fixedAllowanceLine(1_000_000_000), // huge -> never exhausts; band is allowance-independent
      paidUsageEnabled: false,
    });

    // Run-rate is nonzero (the bug drove it to 0).
    expect(result.basis.runRate).toBeGreaterThan(0);

    // Model numbers, hand-derived exactly as the item-25 variance test:
    //   nEstim = 35 - settling(1) = 34; estimation = [90x7,110x7,80x7,120x7,100x6],
    //   mean 100; SS = 700+700+2800+2800 = 7000; dailyVariance = 7000/33; floor
    //   faded (nEstim 34 >= 14) -> effectiveVariance = dailyVariance.
    expect(result.basis.nEstim).toBe(34);
    expect(result.basis.dailyVariance).toBeCloseTo(7000 / 33, 6);
    expect(result.basis.effectiveVariance).toBeCloseTo(7000 / 33, 6);

    // July cumulative at asOf (2026-07-11) is NONZERO -- the crux of the fix.
    // Current cycle = July; actual July burn = day24..27 (07-01..04) 120 each +
    // day28..34 (07-05..11) 100 each = 4*120 + 7*100 = 1180.
    const asOfPoint = result.dailySeries.find((d) => d.date === '2026-07-11');
    expect(asOfPoint).toBeDefined();
    expect(asOfPoint!.actualCumulative).toBe(1180);
    expect(asOfPoint!.p50Cumulative).toBe(1180);

    // First projected day (2026-07-12, kProjected=1) band gap:
    //   std = sqrt(effVar + effVar/nEstim); gap = zP90(1.2816) * std ~= 18.938.
    const firstProjected = result.dailySeries.find((d) => d.actualCumulative === undefined);
    expect(firstProjected).toBeDefined();
    expect(firstProjected!.date).toBe('2026-07-12');
    const effVar = 7000 / 33;
    const expectedGap = 1.2816 * Math.sqrt(effVar + effVar / 34);
    expect(expectedGap).toBeCloseTo(18.938, 2);
    expect(firstProjected!.p90Cumulative - firstProjected!.p50Cumulative).toBeCloseTo(expectedGap, 4);
    expect(firstProjected!.p90Cumulative - firstProjected!.p50Cumulative).toBeGreaterThan(15);
  });
});
