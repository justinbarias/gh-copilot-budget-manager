import { describe, expect, it } from 'vitest';
import { backtest } from './backtest';
import { fixedAllowanceLine, type DailyBurn } from './forecast';

const DAY = 24 * 60 * 60 * 1000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function constantHistory(startIso: string, days: number, credits: number): DailyBurn[] {
  const start = new Date(`${startIso}T00:00:00.000Z`).getTime();
  return Array.from({ length: days }, (_, i) => ({ date: isoDay(start + i * DAY), credits }));
}

const allowance = fixedAllowanceLine(1_000_000);

describe('backtest — MAPE', () => {
  it('is 0 for a perfectly-predictable flat series', () => {
    // Constant 100/day: every forecast predicts 100, every actual is 100.
    const r = backtest({
      history: constantHistory('2026-07-01', 10, 100),
      evalStart: new Date('2026-07-05T00:00:00.000Z'),
      evalEnd: new Date('2026-07-10T00:00:00.000Z'),
      allowance,
    });
    expect(r.series.length).toBe(6);
    expect(r.mape).toBeCloseTo(0, 9);
    expect(r.series.every((p) => p.forecastP50 === 100 && p.actual === 100)).toBe(true);
  });

  it('is 10 for a series whose actual is 10% below the trained rate', () => {
    // Jul1..9 = 110/day; Jul10 = 100. Forecast for Jul10 (trained on 110-only
    // prior data) predicts 110; actual 100 -> |100−110|/100 = 0.10 -> MAPE 10.
    const history = constantHistory('2026-07-01', 9, 110).concat([{ date: '2026-07-10', credits: 100 }]);
    const r = backtest({
      history,
      evalStart: new Date('2026-07-10T00:00:00.000Z'),
      evalEnd: new Date('2026-07-10T00:00:00.000Z'),
      allowance,
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]).toMatchObject({ date: '2026-07-10', actual: 100 });
    expect(r.series[0].forecastP50).toBeCloseTo(110, 6);
    expect(r.mape).toBeCloseTo(10, 6);
  });

  it('skips zero-actual days in the MAPE denominator', () => {
    // Jul6 actual = 0 (skipped); the other eval days are flat 100 (error 0).
    const history = constantHistory('2026-07-01', 10, 100).map((d) =>
      d.date === '2026-07-06' ? { ...d, credits: 0 } : d,
    );
    const r = backtest({
      history,
      evalStart: new Date('2026-07-05T00:00:00.000Z'),
      evalEnd: new Date('2026-07-07T00:00:00.000Z'),
      allowance,
    });
    expect(r.series.map((p) => p.date)).toEqual(['2026-07-05', '2026-07-06', '2026-07-07']);
    expect(r.series.find((p) => p.date === '2026-07-06')!.actual).toBe(0);
    expect(r.mape).toBeCloseTo(0, 9); // Jul6 excluded; Jul5 & Jul7 exact
  });

  it('returns MAPE 0 when every evaluation day is zero-actual', () => {
    const r = backtest({
      history: constantHistory('2026-07-01', 10, 0),
      evalStart: new Date('2026-07-05T00:00:00.000Z'),
      evalEnd: new Date('2026-07-07T00:00:00.000Z'),
      allowance,
    });
    expect(r.mape).toBe(0);
  });
});

describe('backtest — evaluation days with no prior history are skipped', () => {
  it('drops the earliest eval day (nothing before it) but keeps the rest', () => {
    // History starts Jul3; eval window Jul3..Jul5. Jul3 has no strictly-prior
    // data -> skipped; Jul4 and Jul5 are evaluated.
    const r = backtest({
      history: constantHistory('2026-07-03', 5, 100),
      evalStart: new Date('2026-07-03T00:00:00.000Z'),
      evalEnd: new Date('2026-07-05T00:00:00.000Z'),
      allowance,
    });
    expect(r.series.map((p) => p.date)).toEqual(['2026-07-04', '2026-07-05']);
    expect(r.mape).toBeCloseTo(0, 9);
  });
});

describe('backtest — no look-ahead (by construction)', () => {
  it('is unaffected by mutating days at or after each forecast day', () => {
    const base = constantHistory('2026-07-01', 10, 100);
    const window = {
      evalStart: new Date('2026-07-05T00:00:00.000Z'),
      evalEnd: new Date('2026-07-07T00:00:00.000Z'),
      allowance,
    };
    const clean = backtest({ history: base, ...window });

    // Corrupt Jul8..10 (all strictly after the eval window) with wild values.
    const mutated = base.map((d) => (d.date >= '2026-07-08' ? { ...d, credits: 999_999 } : d));
    const tampered = backtest({ history: mutated, ...window });

    // Forecasts for Jul5..7 only saw data < their own day -> identical output.
    expect(tampered.series).toEqual(clean.series);
    expect(tampered.mape).toBeCloseTo(clean.mape, 9);
  });
});
