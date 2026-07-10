import { describe, expect, it } from 'vitest';
import { computeUsageDistribution, countAbove, percentileNearestRank } from './distribution.js';
import type { UserCreditUsage } from './ranking.js';

function user(userId: string, creditsUsed: number): UserCreditUsage {
  return { userId, creditsUsed };
}

describe('percentileNearestRank', () => {
  // sortedAsc = [10,20,...,100], n=10.
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('p30: rank = ceil(0.30*10) = 3 -> idx 2 -> 30', () => {
    expect(percentileNearestRank(sorted, 30)).toBe(30);
  });

  it('p50: rank = ceil(0.50*10) = 5 -> idx 4 -> 50', () => {
    expect(percentileNearestRank(sorted, 50)).toBe(50);
  });

  it('p95: rank = ceil(0.95*10) = ceil(9.5) = 10 -> idx 9 -> 100', () => {
    expect(percentileNearestRank(sorted, 95)).toBe(100);
  });

  it('p0 clamps rank to 1 -> idx 0 -> 10 (rank = ceil(0) = 0, clamped up to 1)', () => {
    expect(percentileNearestRank(sorted, 0)).toBe(10);
  });

  it('p100: rank = ceil(10) = 10 -> idx 9 -> 100', () => {
    expect(percentileNearestRank(sorted, 100)).toBe(100);
  });

  it('empty array -> 0', () => {
    expect(percentileNearestRank([], 50)).toBe(0);
  });

  it('ties straddling a rank boundary: [1,1,1,1,2,2,2,2,2,2] (n=10)', () => {
    // indices 0-3 = 1 (four of them), indices 4-9 = 2 (six of them).
    const tied = [1, 1, 1, 1, 2, 2, 2, 2, 2, 2];
    // p30: rank = ceil(0.3*10) = 3 -> idx 2 -> still inside the run of 1s -> 1.
    expect(percentileNearestRank(tied, 30)).toBe(1);
    // p50: rank = ceil(0.5*10) = 5 -> idx 4 -> first index of the run of 2s -> 2.
    // (idx 3, one below, is still 1 -- this is the exact straddle point.)
    expect(percentileNearestRank(tied, 50)).toBe(2);
    // p95: rank = ceil(0.95*10) = 10 -> idx 9 -> 2.
    expect(percentileNearestRank(tied, 95)).toBe(2);
  });
});

describe('countAbove', () => {
  it('strict inequality: a user exactly at the threshold does not count', () => {
    const users = [user('a', 100), user('b', 100), user('c', 150)];
    // a, b == 100 (not counted); c == 150 > 100 (counted).
    expect(countAbove(users, 100)).toBe(1);
  });

  it('threshold above every value -> 0', () => {
    const users = [user('a', 10), user('b', 20)];
    expect(countAbove(users, 100)).toBe(0);
  });
});

describe('computeUsageDistribution', () => {
  it('main roster: 8 users incl. two zeros and one big outlier', () => {
    // creditsUsed = [0, 0, 50, 100, 150, 200, 250, 5000] (already ascending).
    const users = [
      user('u1', 0),
      user('u2', 0),
      user('u3', 50),
      user('u4', 100),
      user('u5', 150),
      user('u6', 200),
      user('u7', 250),
      user('u8', 5000),
    ];
    const d = computeUsageDistribution(users);

    // n = 8.
    expect(d.n).toBe(8);
    // total = 0+0+50+100+150+200+250+5000 = 5750.
    expect(d.total).toBe(5750);
    // mean = 5750 / 8 = 718.75.
    expect(d.mean).toBe(718.75);

    // p30: rank = ceil(0.30*8) = ceil(2.4) = 3 -> idx 2 -> 50.
    expect(d.p30).toBe(50);
    // p50: rank = ceil(0.50*8) = 4 -> idx 3 -> 100.
    expect(d.p50).toBe(100);
    // p95: rank = ceil(0.95*8) = ceil(7.6) = 8 -> idx 7 -> 5000 (the max --
    // at n=8, rank(95) always equals n, so p95 is necessarily the maximum
    // value; see the dedicated n=20 case below for a roster where p95 is
    // NOT the max, so usersAboveP95/tailSharePct can be nonzero).
    expect(d.p95).toBe(5000);
    // spread = p95 / p50 = 5000 / 100 = 50.
    expect(d.spread).toBe(50);

    // usersAboveP95: strictly > 5000 -> nobody (u8 == 5000, not counted).
    // This is the "a user EQUAL to p95 does not count" case: the outlier
    // IS the p95 value and is correctly excluded.
    expect(d.usersAboveP95).toBe(0);
    // tailSharePct: sum(creditsUsed > 5000) = 0 -> 0 / 5750 * 100 = 0.
    expect(d.tailSharePct).toBe(0);

    // xMax = ceil(max * 1.08) = ceil(5000 * 1.08) = ceil(5400) = 5400
    // (5000 * 1.08 == 5400 exactly in float64 -- verified, no rounding surprise).
    expect(d.xMax).toBe(5400);

    // Bins: binCount defaults to 28. binWidth = 5400 / 28 = 192.857142857...
    // Hand-assigning each value via floor(v / binWidth):
    //   0    -> floor(0 / 192.857..)    = 0  -> bin 0
    //   0    -> 0                       -> bin 0
    //   50   -> floor(50 / 192.857..)   = 0  -> bin 0
    //   100  -> floor(100 / 192.857..)  = 0  -> bin 0
    //   150  -> floor(150 / 192.857..)  = 0  -> bin 0   (bin 0 total: 5)
    //   200  -> floor(200 / 192.857..)  = 1  -> bin 1
    //   250  -> floor(250 / 192.857..)  = 1  -> bin 1   (bin 1 total: 2)
    //   5000 -> floor(5000 / 192.857..) = 25 -> bin 25  (bin 25 total: 1)
    // All other bins: 0. Sum of counts must equal n = 8.
    expect(d.bins).toHaveLength(28);
    const binWidth = 5400 / 28;
    expect(d.bins[0]).toEqual({ start: 0, end: binWidth, count: 5 });
    expect(d.bins[1]).toEqual({ start: binWidth, end: 2 * binWidth, count: 2 });
    expect(d.bins[25]).toEqual({ start: 25 * binWidth, end: 26 * binWidth, count: 1 });
    const totalCounted = d.bins.reduce((sum, b) => sum + b.count, 0);
    expect(totalCounted).toBe(8);
    for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27]) {
      expect(d.bins[i].count).toBe(0);
    }
  });

  it('n=20 roster (10,20,...,200): usersAboveP95 > 0 and nonzero tailSharePct', () => {
    // At n=20, rank(95) = ceil(0.95*20) = ceil(19) = 19, which is LESS than
    // n=20 -- unlike the n=8 case above, p95 is not the maximum, so a user
    // can sit strictly above it. (0.95*20 == 19.0 exactly, an integer, so
    // ceil is a no-op; this only happens for n >= 20.)
    const users: UserCreditUsage[] = [];
    for (let k = 1; k <= 20; k++) users.push(user(`u${k}`, 10 * k));
    const d = computeUsageDistribution(users);

    expect(d.n).toBe(20);
    // total = 10*(1+2+...+20) = 10*210 = 2100.
    expect(d.total).toBe(2100);
    // mean = 2100/20 = 105.
    expect(d.mean).toBe(105);

    // p30: rank = ceil(0.3*20) = 6 -> idx 5 -> sorted[5] = 60.
    expect(d.p30).toBe(60);
    // p50: rank = ceil(0.5*20) = 10 -> idx 9 -> sorted[9] = 100.
    expect(d.p50).toBe(100);
    // p95: rank = ceil(0.95*20) = 19 -> idx 18 -> sorted[18] = 190.
    expect(d.p95).toBe(190);
    // spread = 190/100 = 1.9.
    expect(d.spread).toBe(1.9);

    // usersAboveP95: strictly > 190 -> only the 200 user. count = 1.
    expect(d.usersAboveP95).toBe(1);
    // tailSharePct = 200 / 2100 * 100 = 9.523809523809524.
    expect(d.tailSharePct).toBeCloseTo(9.523809523809524, 10);

    // xMax = ceil(200 * 1.08) = ceil(216) = 216 (exact in float64).
    expect(d.xMax).toBe(216);
  });

  it('bin-assignment boundary: a value exactly on a bin edge lands in the upper bin (floor semantics)', () => {
    // Chosen so binWidth is an exact float: max=250 -> xMax = ceil(250*1.08)
    // = ceil(270) = 270 (270 = 250*1.08 exactly); binCount=27 -> binWidth =
    // 270/27 = 10 exactly. Edge value 30 = 3*binWidth exactly.
    const users = [user('edge', 30), user('max', 250)];
    const d = computeUsageDistribution(users, 27);

    expect(d.xMax).toBe(270);
    const binWidth = 270 / 27;
    expect(binWidth).toBe(10);

    // floor(30/10) = 3 exactly -> bin 3 (not bin 2), and bin 3's start is
    // exactly 30 -- the edge value belongs to the bin it starts, not the one
    // it would end.
    expect(d.bins[3]).toEqual({ start: 30, end: 40, count: 1 });
    // floor(250/10) = 25 -> bin 25.
    expect(d.bins[25]).toEqual({ start: 250, end: 260, count: 1 });
    const totalCounted = d.bins.reduce((sum, b) => sum + b.count, 0);
    expect(totalCounted).toBe(2);
  });

  it('empty roster -> all-zero result, 28 bins all count 0', () => {
    const d = computeUsageDistribution([]);
    expect(d.n).toBe(0);
    expect(d.total).toBe(0);
    expect(d.mean).toBe(0);
    expect(d.p30).toBe(0);
    expect(d.p50).toBe(0);
    expect(d.p95).toBe(0);
    expect(d.spread).toBe(0);
    expect(d.usersAboveP95).toBe(0);
    expect(d.tailSharePct).toBe(0);
    // xMax = max(1, ceil(0*1.08)) = max(1, 0) = 1.
    expect(d.xMax).toBe(1);
    expect(d.bins).toHaveLength(28);
    expect(d.bins.every((b) => b.count === 0)).toBe(true);
  });

  it('single user', () => {
    const d = computeUsageDistribution([user('solo', 77)]);
    expect(d.n).toBe(1);
    expect(d.total).toBe(77);
    expect(d.mean).toBe(77);
    // All percentile ranks clamp to idx 0 for n=1 -> 77.
    expect(d.p30).toBe(77);
    expect(d.p50).toBe(77);
    expect(d.p95).toBe(77);
    // spread = 77/77 = 1.
    expect(d.spread).toBe(1);
    // usersAboveP95: 77 is not > 77 -> 0.
    expect(d.usersAboveP95).toBe(0);
    expect(d.tailSharePct).toBe(0);
    // xMax = ceil(77*1.08) = ceil(83.16..) = 84.
    expect(d.xMax).toBe(84);
  });

  it('all-zero credits (licensed but inactive roster)', () => {
    const users = [user('a', 0), user('b', 0), user('c', 0), user('d', 0), user('e', 0)];
    const d = computeUsageDistribution(users);
    expect(d.n).toBe(5);
    expect(d.total).toBe(0);
    expect(d.mean).toBe(0);
    expect(d.p30).toBe(0);
    expect(d.p50).toBe(0);
    expect(d.p95).toBe(0);
    // spread: p50 === 0 -> 0 (guard against 0/0 = NaN).
    expect(d.spread).toBe(0);
    // usersAboveP95: nobody is > 0 -> 0.
    expect(d.usersAboveP95).toBe(0);
    // tailSharePct: total === 0 -> 0 (guard against 0/0 = NaN).
    expect(d.tailSharePct).toBe(0);
    // xMax = max(1, ceil(0)) = 1.
    expect(d.xMax).toBe(1);
    // All 5 users land in bin 0 (floor(0 / binWidth) = 0).
    expect(d.bins[0].count).toBe(5);
    expect(d.bins.slice(1).every((b) => b.count === 0)).toBe(true);
  });

  it('binCount=1: a single bin holds every value', () => {
    const users = [user('a', 10), user('b', 50), user('c', 90)];
    const d = computeUsageDistribution(users, 1);
    // xMax = ceil(90*1.08) = ceil(97.2) = 98.
    expect(d.xMax).toBe(98);
    expect(d.bins).toHaveLength(1);
    expect(d.bins[0]).toEqual({ start: 0, end: 98, count: 3 });
  });

  it('rejects a non-positive binCount', () => {
    expect(() => computeUsageDistribution([user('a', 1)], 0)).toThrow(/binCount/);
    expect(() => computeUsageDistribution([user('a', 1)], -1)).toThrow(/binCount/);
  });

  it('rejects a non-integer binCount', () => {
    expect(() => computeUsageDistribution([user('a', 1)], 2.5)).toThrow(/binCount/);
  });
});
