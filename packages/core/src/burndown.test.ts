import { describe, expect, it } from 'vitest';
import { cycleBounds, poolConsumedPct } from './burndown';

describe('poolConsumedPct', () => {
  it('returns 0 when the pool size is 0', () => {
    expect(poolConsumedPct(500, 0)).toBe(0);
  });

  it('returns 0 when the pool size is negative', () => {
    expect(poolConsumedPct(500, -10)).toBe(0);
  });

  it('computes the consumed fraction', () => {
    expect(poolConsumedPct(950, 1900)).toBe(0.5);
  });

  it('clamps at 1 when consumption exceeds pool size', () => {
    expect(poolConsumedPct(2500, 1900)).toBe(1);
  });

  it('returns 0 when nothing has been consumed', () => {
    expect(poolConsumedPct(0, 1900)).toBe(0);
  });
});

describe('cycleBounds', () => {
  it('anchors to the first instant of the UTC month for a mid-month date', () => {
    const bounds = cycleBounds(new Date('2026-06-15T12:00:00.000Z'));
    expect(bounds.cycleStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(bounds.cycleEnd.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(bounds.daysInCycle).toBe(30);
    expect(bounds.daysElapsed).toBe(14);
  });

  it('treats the first instant of the month as day 0 elapsed', () => {
    const bounds = cycleBounds(new Date('2026-06-01T00:00:00.000Z'));
    expect(bounds.daysElapsed).toBe(0);
  });

  it('treats the last instant of the month as fully elapsed', () => {
    const bounds = cycleBounds(new Date('2026-06-30T23:59:59.999Z'));
    expect(bounds.daysElapsed).toBe(29);
    expect(bounds.daysInCycle).toBe(30);
  });

  it('handles a 31-day month and a leap-year February', () => {
    const july = cycleBounds(new Date('2026-07-10T00:00:00.000Z'));
    expect(july.daysInCycle).toBe(31);

    const leapFeb = cycleBounds(new Date('2028-02-10T00:00:00.000Z'));
    expect(leapFeb.daysInCycle).toBe(29);

    const nonLeapFeb = cycleBounds(new Date('2026-02-10T00:00:00.000Z'));
    expect(nonLeapFeb.daysInCycle).toBe(28);
  });

  it('rolls over across the 1 Sep 2026 allowance cliff without special-casing it', () => {
    const bounds = cycleBounds(new Date('2026-09-01T00:00:00.000Z'));
    expect(bounds.cycleStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(bounds.cycleEnd.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(bounds.daysElapsed).toBe(0);
  });
});
