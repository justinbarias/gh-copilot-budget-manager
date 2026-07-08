import { describe, expect, it } from 'vitest';
import { fixedAllowanceLine } from '@copilot-budget/core';
import {
  DEFAULT_FORECAST_HORIZON_DAYS,
  assembleCostCenterSeries,
  assembleEnterpriseSeries,
  assembleUserSeries,
  computeScopeForecast,
  expandMonthlyAggregates,
  toDailyBurn,
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
