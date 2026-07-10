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
  // July (31 days). settlingWindow 0 so all 9 days estimate (nEstim = 9).
  // Deseasonalized series is flat 100 (all weekday indices = 1) -> runRate 100,
  // *measured* sample variance 0. Fixed allowance 1500.
  // The small-sample floor is still active at n=9: cvFloor(9) = 0.15·(14−9)/14 =
  // 0.0535714, so effectiveVariance = (0.0535714·100)² = 28.69898 (not 0), and a
  // thin P90 band exists on projected days — scarce data must not report a
  // zero-width band. The band is small vs the 100/day step, so P50 and P90 still
  // first cross 1500 on the same day (Jul15). See the exhaustion test below.
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
    expect(r.basis.dailyVariance).toBeCloseTo(0, 10); // measured sample variance
    expect(r.basis.nEstim).toBe(9);
    // Floor active at n=9: effectiveVariance = (0.15·(14−9)/14 · 100)² = 28.69898.
    expect(r.basis.effectiveVariance).toBeCloseTo(28.69898, 4);
    expect(r.basis.weekdayIndices.every((x) => Math.abs(x - 1) < 1e-9)).toBe(true);
  });

  it('projects a linear cumulative and finds the exact exhaustion date', () => {
    const r = forecast(input);
    expect(find(r.dailySeries, '2026-07-09').actualCumulative).toBe(900);
    expect(find(r.dailySeries, '2026-07-10').p50Cumulative).toBeCloseTo(1000, 6);
    expect(find(r.dailySeries, '2026-07-15').p50Cumulative).toBeCloseTo(1500, 6);
    expect(r.exhaustionDate).toBe('2026-07-15');
    // P90 band exists (floor), but at Jul14 (k=5) p90 = 1400 + 1.2816·√(5·28.699
    // + 25·3.18878) = 1419.1 < 1500, and at Jul15 (k=6) p90 = 1521.7 ≥ 1500, so
    // P90 also first crosses on Jul15 — the thin band doesn't move the date here.
    expect(r.exhaustionDateP90).toBe('2026-07-15');
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
  //
  // POINT path (RAW indices — bit-identical to the pre-shrinkage model):
  // weekdays 100/80 = 1.25, weekends 30/80 = 0.375. Raw-deseasonalized = flat
  // 80 -> runRate 80. Reseasonalized projection: weekday 100, weekend 30.
  //
  // VARIANCE path (SHRUNK indices; n_wd = 12, shrink factor 12/(12+2) = 6/7):
  //   shrunk weekday = 1 + (1.25−1)·6/7 = 1.214286 (= 17/14)
  //   shrunk weekend = 1 + (0.375−1)·6/7 = 0.464286 (= 13/28)
  // Shrunk residuals are NOT flat: weekday 100/(17/14) = 82.352941 (×60 days),
  // weekend 30/(13/28) = 64.615385 (×24 days). Mean = (60·82.352941 +
  // 24·64.615385)/84 = 77.285068; sample variance = (60·(82.352941−77.285068)²
  // + 24·(64.615385−77.285068)²)/83 = 64.981944. The residual weekday swing
  // deliberately leaks into the band variance (conservative) while p50 stays
  // exactly the plain model — the paths are decoupled by design.
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

  it('recovers the RAW weekday indices and a deseasonalized run-rate of 80', () => {
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

  it('measures the band variance against SHRUNK indices (residual leak by design)', () => {
    const r = forecast(input);
    const shrunk = r.basis.shrunkWeekdayIndices!;
    expect(shrunk[0]).toBeCloseTo(0.4642857143, 9); // Sunday, 1 + (0.375−1)·6/7
    expect(shrunk[6]).toBeCloseTo(0.4642857143, 9); // Saturday
    for (let w = 1; w <= 5; w++) expect(shrunk[w]).toBeCloseTo(1.2142857143, 9); // 1 + 0.25·6/7
    expect(r.basis.nEstim).toBe(84);
    expect(r.basis.dailyVariance).toBeCloseTo(64.981944, 5);
    expect(r.basis.effectiveVariance).toBeCloseTo(64.981944, 5); // n=84 -> floor off
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

describe('forecast — P50/P90 bands from daily variance + run-rate SE', () => {
  // 14 consecutive days: week1 all 70, week2 all 90. Each weekday appears twice
  // (once 70, once 90) -> weekday means all 80 -> indices all 1 (shrink of a
  // unit index is still 1) -> deseason = raw. nEstim = 14, so the small-sample
  // floor has fully faded (cvFloor(14) = 0) and effectiveVariance == measured.
  // SAMPLE variance of [70×7, 90×7] about mean 80 = 14·100 / (14−1) = 1400/13 =
  // 107.692308 (÷(n−1), not ÷n). SE² = effectiveVariance / nEstim = 107.692308/14
  // = 7.692308. With zP90 = 1, the band offset for projected day k is
  //   √(k·107.692308 + k²·7.692308).
  //   k=1: √(107.692308 + 7.692308) = √115.384615 = 10.741723
  //   k=4: √(430.769231 + 123.076923) = √553.846154 = 23.533936
  //   k=5: √(538.461538 + 192.307692) = √730.769231 = 27.032744
  const input = {
    history: constantHistory('2026-07-01', 7, 70).concat(constantHistory('2026-07-08', 7, 90)),
    asOfDate: new Date('2026-07-15T00:00:00.000Z'),
    horizonEndDate: new Date('2026-07-20T00:00:00.000Z'),
    allowance: fixedAllowanceLine(1_000_000),
    paidUsageEnabled: true,
    params: { settlingWindowDays: 0, zP90: 1 },
  };

  it('computes a sample daily variance of 1400/13 with the floor faded off', () => {
    const r = forecast(input);
    expect(r.basis.dailyVariance).toBeCloseTo(107.692308, 6);
    expect(r.basis.nEstim).toBe(14);
    expect(r.basis.effectiveVariance).toBeCloseTo(107.692308, 6); // floor gone at n=14
  });

  it('widens the P90 band as √(k·var + k²·SE²) over projected days', () => {
    const r = forecast(input);
    const offset = (date: string) => {
      const d = find(r.dailySeries, date);
      return d.p90Cumulative - d.p50Cumulative;
    };
    expect(offset('2026-07-15')).toBeCloseTo(10.741723, 5); // k=1
    expect(offset('2026-07-18')).toBeCloseTo(23.533936, 5); // k=4
    expect(offset('2026-07-19')).toBeCloseTo(27.032744, 5); // k=5
  });
});

describe('forecast — scarce single-cycle history yields a WIDE band (the Day-8 incident)', () => {
  // 7 days of constant 1000/day in one cycle, asOf the next day. This is the
  // degenerate shape behind the live incident: measured variance collapses to 0,
  // so the OLD model reported a zero-width P90 band on projected days. The
  // small-sample floor + run-rate SE now keep the band honest.
  //   nEstim = 7, runRate = 1000, dailyVariance(sample) = 0 (all equal).
  //   cvFloor(7) = 0.15·(14−7)/14 = 0.075 -> effectiveVariance = (0.075·1000)² = 5625.
  //   SE² = effectiveVariance/nEstim = 5625/7 = 803.571429.
  //   band offset(k) = zP90·√(k·5625 + k²·803.571429), zP90 = 1.2816 (default):
  //     k=1  -> 1.2816·√(5625 + 803.5714)      = 1.2816·√6428.5714  = 102.75660
  //     k=3  -> 1.2816·√(16875 + 7232.143)     = 1.2816·√24107.143  = 198.98730
  //     k=23 -> 1.2816·√(129375 + 425089.29)   = 1.2816·√554464.29  = 954.30959
  const input = {
    history: constantHistory('2026-07-01', 7, 1000),
    asOfDate: new Date('2026-07-08T00:00:00.000Z'),
    horizonEndDate: new Date('2026-07-31T00:00:00.000Z'),
    allowance: fixedAllowanceLine(1_000_000_000),
    paidUsageEnabled: true,
    params: { settlingWindowDays: 0 },
  };
  const off = (r: ReturnType<typeof forecast>, date: string) => {
    const d = find(r.dailySeries, date);
    return d.p90Cumulative - d.p50Cumulative;
  };

  it('has zero measured variance but a floored effectiveVariance of 5625', () => {
    const r = forecast(input);
    expect(r.basis.runRate).toBeCloseTo(1000, 6);
    expect(r.basis.nEstim).toBe(7);
    expect(r.basis.dailyVariance).toBeCloseTo(0, 10);
    expect(r.basis.effectiveVariance).toBeCloseTo(5625, 6);
  });

  it('widens the band on early projected days (k=1, k=3) from the floor + SE', () => {
    const r = forecast(input);
    expect(off(r, '2026-07-08')).toBeCloseTo(102.75660, 4); // k=1
    expect(off(r, '2026-07-10')).toBeCloseTo(198.98730, 4); // k=3
  });

  it('is MATERIALLY wide at the horizon (k=23), where the old model gave 0', () => {
    const r = forecast(input);
    const horizonOffset = off(r, '2026-07-30'); // k=23 (Jul8=1 .. Jul30=23)
    expect(horizonOffset).toBeCloseTo(954.30959, 3);
    expect(horizonOffset).toBeGreaterThan(900); // hand-derived bound; old model => 0
  });
});

describe('forecast — weekday-index shrinkage by observation count (variance path)', () => {
  // Monday elevated to 200, every other day 100. overall mean = (200 + 6·100)/7 =
  // 114.285714 -> RAW Monday index = 200/114.285714 = 1.75 (raw deviation +0.75),
  // raw other-weekday index = 100/114.285714 = 0.875 (deviation −0.125). The RAW
  // indices drive the point path and are reported in basis.weekdayIndices; the
  // SHRUNK indices (basis.shrunkWeekdayIndices) pull toward 1 by n_wd/(n_wd + 2):
  //   n=1: Monday 1 + 0.75·(1/3) = 1.25    ; other 1 + (−0.125)·(1/3) = 0.958333
  //   n=4: Monday 1 + 0.75·(4/6) = 1.50    ; other 1 + (−0.125)·(4/6) = 0.916667
  const MON = 1;
  const WED = 3;

  it('applies 1/3 of the raw deviation with 1 observation per weekday', () => {
    // 7 consecutive days = one of each weekday, exactly one Monday (n_Mon = 1).
    const r = forecast({
      history: Array.from({ length: 7 }, (_, i) => {
        const ms = Date.parse('2026-07-01T00:00:00.000Z') + i * DAY;
        return { date: isoDay(ms), credits: new Date(ms).getUTCDay() === MON ? 200 : 100 };
      }),
      asOfDate: new Date('2026-07-08T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-09T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0 },
    });
    expect(r.basis.weekdayIndices[MON]).toBeCloseTo(1.75, 9); // raw, point path
    expect(r.basis.weekdayIndices[WED]).toBeCloseTo(0.875, 9);
    expect(r.basis.shrunkWeekdayIndices![MON]).toBeCloseTo(1.25, 9); // variance path
    expect(r.basis.shrunkWeekdayIndices![WED]).toBeCloseTo(0.9583333333, 9);
    // The point of the decoupling: the Monday deviation partially survives the
    // shrunk deseasonalization and lands in the measured variance. Residuals:
    // Mon 200/1.25 = 160 (×1); others 100/0.958333 = 104.347826 (×6). Mean =
    // (160 + 6·104.347826)/7 = 112.298137; sample variance = ((160−112.298137)²
    // + 6·(104.347826−112.298137)²)/6 = (2275.467 + 6·63.207)/6 = 442.452066.
    // (Raw residuals would be flat 114.285714 -> variance 0 — false precision.)
    expect(r.basis.dailyVariance).toBeCloseTo(442.452066, 4);
  });

  it('applies 2/3 of the raw deviation with 4 observations per weekday', () => {
    // 28 consecutive days = 4 of each weekday (n_Mon = 4).
    const r = forecast({
      history: Array.from({ length: 28 }, (_, i) => {
        const ms = Date.parse('2026-06-03T00:00:00.000Z') + i * DAY;
        return { date: isoDay(ms), credits: new Date(ms).getUTCDay() === MON ? 200 : 100 };
      }),
      asOfDate: new Date('2026-07-02T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-03T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0 },
    });
    expect(r.basis.weekdayIndices[MON]).toBeCloseTo(1.75, 9); // raw unchanged by n_wd
    expect(r.basis.weekdayIndices[WED]).toBeCloseTo(0.875, 9);
    expect(r.basis.shrunkWeekdayIndices![MON]).toBeCloseTo(1.5, 9);
    expect(r.basis.shrunkWeekdayIndices![WED]).toBeCloseTo(0.9166666667, 9);
  });
});

describe('forecast — small-sample variance floor fades with history', () => {
  const base = {
    allowance: fixedAllowanceLine(1_000_000),
    paidUsageEnabled: true as const,
    params: { settlingWindowDays: 0 },
  };

  it('floors the variance at n=7 (flat history would otherwise report 0)', () => {
    const r = forecast({
      ...base,
      history: constantHistory('2026-07-01', 7, 1000),
      asOfDate: new Date('2026-07-08T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-09T00:00:00.000Z'),
    });
    expect(r.basis.dailyVariance).toBeCloseTo(0, 10);
    expect(r.basis.effectiveVariance).toBeCloseTo(5625, 6); // (0.075·1000)²
    expect(r.basis.effectiveVariance!).toBeGreaterThan(0);
  });

  it('drops the floor at n=14 (cvFloor(14) = 0), letting measured variance stand', () => {
    const r = forecast({
      ...base,
      history: constantHistory('2026-07-01', 14, 1000),
      asOfDate: new Date('2026-07-15T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-16T00:00:00.000Z'),
    });
    expect(r.basis.nEstim).toBe(14);
    expect(r.basis.dailyVariance).toBeCloseTo(0, 10);
    expect(r.basis.effectiveVariance).toBeCloseTo(0, 10); // floor gone -> measured (0) stands
  });
});

describe('forecast — long history: shrinkage ≈ raw, floor off, SE term present', () => {
  // 28 days, whole-week alternating 70/90 (weeks 70,90,70,90). Each weekday
  // appears 4×: twice at 70, twice at 90 -> weekday mean 80 -> raw index 1 ->
  // shrunk 1 (a unit index is a fixed point of shrinkage). nEstim = 28, so
  // cvFloor(28) = 0 (floor off) and effectiveVariance == measured sample var.
  // Sample var of [70×14, 90×14] about 80 = 28·100/(28−1) = 2800/27 = 103.703704.
  // SE² = 103.703704/28 = 3.703704. Band offset(k=1, z=1) = √(103.703704 +
  // 3.703704) = √107.407407 = 10.363755 (old daily-only model √103.703704 =
  // 10.183504 — the SE term adds ~1.77%).
  it('keeps unit indices, disables the floor, and adds the run-rate SE term', () => {
    const r = forecast({
      history: Array.from({ length: 28 }, (_, i) => {
        const ms = Date.parse('2026-06-08T00:00:00.000Z') + i * DAY;
        return { date: isoDay(ms), credits: Math.floor(i / 7) % 2 === 0 ? 70 : 90 };
      }),
      asOfDate: new Date('2026-07-06T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-07T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0, zP90: 1 },
    });
    expect(r.basis.weekdayIndices.every((x) => Math.abs(x - 1) < 1e-9)).toBe(true);
    expect(r.basis.shrunkWeekdayIndices!.every((x) => Math.abs(x - 1) < 1e-9)).toBe(true); // shrink(1) = 1
    expect(r.basis.nEstim).toBe(28);
    expect(r.basis.dailyVariance).toBeCloseTo(103.703704, 5);
    expect(r.basis.effectiveVariance).toBeCloseTo(103.703704, 5); // floor off -> == measured
    const d = find(r.dailySeries, '2026-07-06'); // first projected day, k=1
    expect(d.p90Cumulative - d.p50Cumulative).toBeCloseTo(10.363755, 5);
  });
});

describe('forecast — small-sample edge cases do not NaN or throw', () => {
  it('handles nEstim = 0 (empty history): SE = 0, effectiveVariance finite (0)', () => {
    const r = forecast({
      history: [],
      asOfDate: new Date('2026-07-10T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-20T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1000),
      paidUsageEnabled: true,
    });
    expect(r.basis.nEstim).toBe(0);
    expect(Number.isFinite(r.basis.effectiveVariance!)).toBe(true);
    expect(r.basis.effectiveVariance).toBe(0); // (cvFloor·runRate=0)² = 0
    expect(r.dailySeries.every((d) => Number.isFinite(d.p90Cumulative))).toBe(true);
  });

  it('handles nEstim = 1 (single day): variance 0, floor active, all finite', () => {
    const r = forecast({
      history: [{ date: '2026-07-07', credits: 500 }],
      asOfDate: new Date('2026-07-08T00:00:00.000Z'),
      horizonEndDate: new Date('2026-07-12T00:00:00.000Z'),
      allowance: fixedAllowanceLine(1_000_000),
      paidUsageEnabled: true,
      params: { settlingWindowDays: 0 },
    });
    expect(r.basis.nEstim).toBe(1);
    expect(r.basis.dailyVariance).toBe(0); // n<2 -> 0
    // cvFloor(1) = 0.15·(14−1)/14 = 0.139286 -> effVar = (0.139286·500)² = 4850.1276
    expect(r.basis.effectiveVariance).toBeCloseTo(4850.1276, 3);
    expect(
      r.dailySeries.every((d) => Number.isFinite(d.p90Cumulative) && d.p90Cumulative >= d.p50Cumulative),
    ).toBe(true);
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
    {
      // Scarce single-cycle history: the P90 band is now driven by the floor +
      // run-rate SE (the incident case). The p90 ≥ p50 invariant must still hold.
      name: 'scarce',
      input: {
        history: constantHistory('2026-07-01', 7, 1000),
        asOfDate: new Date('2026-07-08T00:00:00.000Z'),
        horizonEndDate: new Date('2026-07-31T00:00:00.000Z'),
        allowance: fixedAllowanceLine(1_000_000),
        paidUsageEnabled: true,
        params: { settlingWindowDays: 0 },
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
