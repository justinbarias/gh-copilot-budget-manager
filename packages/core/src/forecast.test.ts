import { describe, expect, it } from 'vitest';
import {
  fixedAllowanceLine,
  forecast,
  poolAllowanceLine,
  projectedDailyBurn,
  type DailyBurn,
} from './forecast';

const DAY = 24 * 60 * 60 * 1000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function constantHistory(startIso: string, days: number, credits: number): DailyBurn[] {
  const start = new Date(`${startIso}T00:00:00.000Z`).getTime();
  return Array.from({ length: days }, (_, i) => ({ date: isoDay(start + i * DAY), credits }));
}

function find(series: { date: string }[], date: string) {
  const d = series.find((s) => s.date === date);
  if (!d) throw new Error(`no series day ${date}`);
  return d as any;
}

describe('forecast — flat burn', () => {
  // History: July 1..9 = 100 credits/day (constant). asOfDate July 10, cycle
  // July (31 days). settlingWindow 0 so all 9 days estimate.
  // Deseasonalized series is flat 100 (all weekday indices = 1) -> runRate 100,
  // variance 0 -> P50 == P90. Fixed allowance 1500.
  // Cumulative: Jul9=900 (actual); +100/day projected -> Jul15 hits 1500.
  const input = {
    history: constantHistory('2026-07-01', 9, 100),
    asOfDate: new Date('2026-07-10T00:00:00.000Z'),
    horizonEndDate: new Date('2026-07-31T00:00:00.000Z'),
    allowance: fixedAllowanceLine(1500),
    paidUsageEnabled: true,
    params: { settlingWindowDays: 0 },
  };

  it('recovers a flat run-rate and unit weekday indices', () => {
    const r = forecast(input);
    expect(r.basis.runRate).toBeCloseTo(100, 10);
    expect(r.basis.dailyVariance).toBeCloseTo(0, 10);
    expect(r.basis.weekdayIndices.every((x) => Math.abs(x - 1) < 1e-9)).toBe(true);
  });

  it('projects a linear cumulative and finds the exact exhaustion date', () => {
    const r = forecast(input);
    expect(find(r.dailySeries, '2026-07-09').actualCumulative).toBe(900);
    expect(find(r.dailySeries, '2026-07-10').p50Cumulative).toBeCloseTo(1000, 6);
    expect(find(r.dailySeries, '2026-07-15').p50Cumulative).toBeCloseTo(1500, 6);
    expect(r.exhaustionDate).toBe('2026-07-15');
    expect(r.exhaustionDateP90).toBe('2026-07-15'); // variance 0 -> bands coincide
    expect(r.runwayDays).toBe(5); // Jul10 -> Jul15
  });

  it('projects metered dollars = (end-of-cycle cumulative − allowance) × $0.01 when paid usage on', () => {
    const r = forecast(input);
    // Jul31 cumulative = 900 + 100×22 = 3100; metered = 3100 − 1500 = 1600 credits.
    expect(find(r.dailySeries, '2026-07-31').p50Cumulative).toBeCloseTo(3100, 6);
    expect(r.projectedMeteredCredits).toBeCloseTo(1600, 6);
    expect(r.projectedMeteredDollars).toBeCloseTo(16, 6);
  });

  it('reports 0 metered (blocked) when paid usage is disabled, but still an exhaustion date', () => {
    const r = forecast({ ...input, paidUsageEnabled: false });
    expect(r.exhaustionDate).toBe('2026-07-15');
    expect(r.projectedMeteredCredits).toBe(0);
    expect(r.projectedMeteredDollars).toBe(0);
  });
});

describe('forecast — strong weekday seasonality', () => {
  // 84 consecutive days (12 whole weeks) ending the day before asOfDate:
  // weekdays (Mon–Fri) = 100, weekends (Sat/Sun) = 30. Each weekday appears
  // exactly 12 times -> weekday mean 100/30, overall mean (5·100+2·30)/7 = 80.
  // Indices: weekdays 100/80 = 1.25, weekends 30/80 = 0.375. Deseasonalized =
  // flat 80 -> runRate 80. Reseasonalized projection: weekday 100, weekend 30.
  const asOf = new Date('2026-07-06T00:00:00.000Z');
  const asOfMs = asOf.getTime();
  const history: DailyBurn[] = Array.from({ length: 84 }, (_, i) => {
    const ms = asOfMs - (84 - i) * DAY;
    const wd = new Date(ms).getUTCDay();
    return { date: isoDay(ms), credits: wd >= 1 && wd <= 5 ? 100 : 30 };
  });
  const input = {
    history,
    asOfDate: asOf,
    horizonEndDate: new Date(asOfMs + 7 * DAY),
    allowance: fixedAllowanceLine(1_000_000),
    paidUsageEnabled: true,
    params: { settlingWindowDays: 0 },
  };

  it('recovers the weekday indices and a deseasonalized run-rate of 80', () => {
    const r = forecast(input);
    const idx = r.basis.weekdayIndices;
    expect(idx[0]).toBeCloseTo(0.375, 9); // Sunday
    expect(idx[6]).toBeCloseTo(0.375, 9); // Saturday
    for (let w = 1; w <= 5; w++) expect(idx[w]).toBeCloseTo(1.25, 9);
    expect(r.basis.runRate).toBeCloseTo(80, 6);
  });

  it('produces a sawtooth projection: weekdays 100, weekends 30', () => {
    const r = forecast(input);
    const daily = Array.from({ length: 7 }, (_, i) => projectedDailyBurn(r.basis, new Date(asOfMs + i * DAY)));
    const rounded = daily.map((x) => Math.round(x));
    expect(rounded.filter((x) => x === 100).length).toBe(5);
    expect(rounded.filter((x) => x === 30).length).toBe(2);
    expect(daily.reduce((a, b) => a + b, 0)).toBeCloseTo(560, 6); // 5·100 + 2·30
  });
});

describe('forecast — 1 Sep 2026 cliff step-change', () => {
  // Enterprise, existing customer, 10 licenses. Aug = promo 7000/seat = 70,000;
  // Sep = standard 3900/seat = 39,000. Allowance line steps down by 31,000.
  it('steps the allowance line down at 2026-09-01 by exactly the poolAllowanceCredits delta', () => {
    const r = forecast({
      history: constantHistory('2026-08-01', 19, 100),
      asOfDate: new Date('2026-08-20T00:00:00.000Z'),
      horizonEndDate: new Date('2026-09-05T00:00:00.000Z'),
      allowance: poolAllowanceLine(10, { edition: 'enterprise', existingCustomer: true }),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0 },
    });
    const aug = find(r.dailySeries, '2026-08-31').allowanceLine;
    const sep = find(r.dailySeries, '2026-09-01').allowanceLine;
    expect(aug).toBe(70_000);
    expect(sep).toBe(39_000);
    expect(aug - sep).toBe(31_000);
  });
});

describe('forecast — multi-cycle horizon meters each cycle independently', () => {
  it('meters a fully-projected future cycle against its own (reset) allowance', () => {
    // Flat 100/day, allowance 1500 both months. asOf July 10 (current cycle
    // July, actual Jul1..9 = 900). Horizon reaches Aug 31.
    //  July: finalCum = 900 + 100×22 = 3100; base = max(1500, 900) = 1500;
    //        metered = 1600.
    //  Aug (fully projected, pool resets): finalCum = 100×31 = 3100;
    //        base = max(1500, 0) = 1500; metered = 1600.
    //  Total metered = 3200 credits, $32.00.
    const r = forecast({
      history: constantHistory('2026-07-01', 9, 100),
      asOfDate: new Date('2026-07-10T00:00:00.000Z'),
      horizonEndDate: new Date('2026-08-31T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1500),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0 },
    });
    // Cumulative resets at the Aug 1 cycle boundary.
    expect(find(r.dailySeries, '2026-08-01').p50Cumulative).toBeCloseTo(100, 6);
    expect(r.projectedMeteredCredits).toBeCloseTo(3200, 6);
    expect(r.projectedMeteredDollars).toBeCloseTo(32, 6);
  });
});

describe('forecast — empty history', () => {
  it('yields a zero run-rate and no exhaustion', () => {
    const r = forecast({
      history: [],
      asOfDate: new Date('2026-07-10T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-20T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1000),
      paidUsageEnabled: true,
    });
    expect(r.basis.runRate).toBe(0);
    expect(r.exhaustionDate).toBeNull();
    expect(r.projectedMeteredCredits).toBe(0);
  });
});

describe('forecast — zero-usage entity', () => {
  it('has no exhaustion, null runway, and flat P50=P90=0', () => {
    const r = forecast({
      history: constantHistory('2026-07-01', 9, 0),
      asOfDate: new Date('2026-07-10T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-31T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1000),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0 },
    });
    expect(r.basis.runRate).toBe(0);
    expect(r.basis.weekdayIndices.every((x) => x === 1)).toBe(true); // overall mean 0 guard
    expect(r.exhaustionDate).toBeNull();
    expect(r.exhaustionDateP90).toBeNull();
    expect(r.runwayDays).toBeNull();
    expect(r.projectedMeteredCredits).toBe(0);
    expect(r.dailySeries.every((d) => d.p50Cumulative === 0 && d.p90Cumulative === 0)).toBe(true);
  });
});

describe('forecast — already-exhausted entity', () => {
  // Allowance 500. History Jul1..3 = 300/day (cumulative 300, 600, 900).
  // Crosses 500 on Jul2 (an actual day). asOfDate Jul4 -> runway clamps to 0.
  const input = {
    history: constantHistory('2026-07-01', 3, 300),
    asOfDate: new Date('2026-07-04T00:00:00.000Z'),
    horizonEndDate: new Date('2026-07-31T00:00:00.000Z'),
    allowance: fixedAllowanceLine(500),
    paidUsageEnabled: true,
    params: { settlingWindowDays: 0 },
  };

  it('reports the crossing day as exhaustion and clamps runway to 0', () => {
    const r = forecast(input);
    expect(find(r.dailySeries, '2026-07-02').p50Cumulative).toBe(600);
    expect(r.exhaustionDate).toBe('2026-07-02');
    expect(r.runwayDays).toBe(0);
  });

  it('meters all projected draw when already over (paid usage on)', () => {
    const r = forecast(input);
    // runRate 300; projected Jul4..31 = 28×300 = 8400; base = max(500,900)=900;
    // finalCum = 900 + 8400 = 9300; metered = 9300 − 900 = 8400.
    expect(r.projectedMeteredCredits).toBeCloseTo(8400, 6);
    expect(r.projectedMeteredDollars).toBeCloseTo(84, 6);
  });

  it('blocks (0 metered) when paid usage disabled, still reporting the exhaustion date', () => {
    const r = forecast({ ...input, paidUsageEnabled: false });
    expect(r.exhaustionDate).toBe('2026-07-02');
    expect(r.projectedMeteredCredits).toBe(0);
  });
});

describe('forecast — P50/P90 bands from daily variance', () => {
  // 14 consecutive days: week1 all 70, week2 all 90. Each weekday appears twice
  // (once 70, once 90) -> weekday means all 80 -> indices all 1 -> deseason =
  // raw. Population variance of [70×7, 90×7] about mean 80 = 100.
  // With zP90 = 1, the band offset for projected day k is 1·√(k·100) = 10√k.
  const input = {
    history: constantHistory('2026-07-01', 7, 70).concat(constantHistory('2026-07-08', 7, 90)),
    asOfDate: new Date('2026-07-15T00:00:00.000Z'),
    horizonEndDate: new Date('2026-07-20T00:00:00.000Z'),
    allowance: fixedAllowanceLine(1_000_000),
    paidUsageEnabled: true,
    params: { settlingWindowDays: 0, zP90: 1 },
  };

  it('computes daily variance of 100', () => {
    expect(forecast(input).basis.dailyVariance).toBeCloseTo(100, 6);
  });

  it('widens the P90 band as 10·√k over projected days', () => {
    const r = forecast(input);
    const offset = (date: string) => {
      const d = find(r.dailySeries, date);
      return d.p90Cumulative - d.p50Cumulative;
    };
    expect(offset('2026-07-15')).toBeCloseTo(10, 6); // k=1 -> 10·√1
    expect(offset('2026-07-18')).toBeCloseTo(20, 6); // k=4 -> 10·√4
    expect(offset('2026-07-19')).toBeCloseTo(10 * Math.sqrt(5), 6); // k=5
  });
});

describe('forecast — settling window', () => {
  it('flags the most-recent actual day provisional and excludes it from the rate', () => {
    // Jul1..6 = 100/day, Jul7 = 1000 (a spike). settlingWindowDays 1 excludes
    // Jul7 from estimation -> runRate stays ~100 (not inflated by the spike).
    const r = forecast({
      history: constantHistory('2026-07-01', 6, 100).concat([{ date: '2026-07-07', credits: 1000 }]),
      asOfDate: new Date('2026-07-08T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-12T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 1 },
    });
    expect(r.basis.runRate).toBeCloseTo(100, 6);
    expect(find(r.dailySeries, '2026-07-07').provisional).toBe(true);
    expect(find(r.dailySeries, '2026-07-06').provisional).toBe(false);
    // The provisional day's actual cumulative still reflects the observed spike.
    expect(find(r.dailySeries, '2026-07-07').actualCumulative).toBe(1600);
  });
});

describe('forecast — invariants', () => {
  const scenarios = [
    {
      name: 'flat',
      input: {
        history: constantHistory('2026-07-01', 9, 100),
        asOfDate: new Date('2026-07-10T00:00:00.000Z'),
        horizonEndDate: new Date('2026-07-31T00:00:00.000Z'),
        allowance: fixedAllowanceLine(1500),
        paidUsageEnabled: true,
        params: { settlingWindowDays: 0 },
      },
    },
    {
      name: 'variance',
      input: {
        history: constantHistory('2026-07-01', 7, 70).concat(constantHistory('2026-07-08', 7, 90)),
        asOfDate: new Date('2026-07-15T00:00:00.000Z'),
        horizonEndDate: new Date('2026-08-31T00:00:00.000Z'),
        allowance: fixedAllowanceLine(50_000),
        paidUsageEnabled: true,
        params: { settlingWindowDays: 0, zP90: 1.2816 },
      },
    },
  ];

  for (const s of scenarios) {
    it(`P50 ≤ P90 at every point (${s.name})`, () => {
      for (const d of forecast(s.input).dailySeries) {
        expect(d.p90Cumulative).toBeGreaterThanOrEqual(d.p50Cumulative);
      }
    });

    it(`cumulative is non-decreasing within each cycle (${s.name})`, () => {
      const series = forecast(s.input).dailySeries;
      let prev = -Infinity;
      let prevMonth = '';
      for (const d of series) {
        const month = d.date.slice(0, 7);
        if (month !== prevMonth) prev = -Infinity; // pool resets at cycle boundary
        expect(d.p50Cumulative).toBeGreaterThanOrEqual(prev);
        prev = d.p50Cumulative;
        prevMonth = month;
      }
    });

    it(`is deterministic (${s.name})`, () => {
      expect(forecast(s.input)).toEqual(forecast(s.input));
    });
  }
});
