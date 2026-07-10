import type { UserCreditUsage } from './ranking.js';

// "Usage distribution" feature -- per-user credit-spend histogram with
// P30/P50/P95 markers, feeding both the distribution chart and the
// ULB-sizing insight strip ("raise the tail vs raise the shared floor").
// Semantics mirror the design reference
// (design/usage-distribution-mockup.html's <script> block: percentileNearestRank
// + the equal-width floor-binning in buildChart) so the shipped math matches
// what was designed against.
//
// PURE (CLAUDE.md §2 portability rule): no I/O, no Date.now, no randomness.

export interface DistributionBin {
  start: number;
  end: number;
  count: number;
}

export interface UsageDistribution {
  /** Number of users. */
  n: number;
  /** Sum of creditsUsed across all users. */
  total: number;
  /** total / n; 0 when n === 0. */
  mean: number;
  p30: number;
  p50: number;
  p95: number;
  /** p95 / p50; 0 when p50 === 0 (avoids Infinity/NaN on an all-zero roster). */
  spread: number;
  /** Count of users with creditsUsed STRICTLY greater than p95. */
  usersAboveP95: number;
  /** % of total held by users strictly above p95; 0 when total === 0. */
  tailSharePct: number;
  /** ceil(max * 1.08), minimum 1 (so bins stay well-formed even for all-zero data). */
  xMax: number;
  /** binCount equal-width bins covering [0, xMax]. */
  bins: DistributionBin[];
}

/**
 * Nearest-rank percentile over an ascending-sorted array: rank = ceil(p/100 * n),
 * 1-indexed, clamped to [1, n]. Returns 0 for an empty array.
 */
export function percentileNearestRank(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const clampedRank = Math.max(1, Math.min(n, rank));
  // clampedRank is in [1, n], so clampedRank - 1 is always a valid index.
  return sortedAsc[clampedRank - 1] as number;
}

/**
 * Count of users whose creditsUsed is STRICTLY greater than `threshold` (used
 * for the "N users above P95 / above this ULB" overlays -- a user exactly at
 * the threshold does not count).
 */
export function countAbove(users: readonly UserCreditUsage[], threshold: number): number {
  let count = 0;
  for (const u of users) {
    if (u.creditsUsed > threshold) count++;
  }
  return count;
}

export function computeUsageDistribution(
  users: readonly UserCreditUsage[],
  binCount = 28,
): UsageDistribution {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new Error(`computeUsageDistribution: binCount must be an integer >= 1, got ${binCount}`);
  }

  const n = users.length;
  const values: number[] = new Array(n);
  let total = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    // i < n === users.length, so users[i] is always defined.
    const v = (users[i] as UserCreditUsage).creditsUsed;
    values[i] = v;
    total += v;
    if (v > max) max = v;
  }
  const sorted = [...values].sort((a, b) => a - b);

  const mean = n === 0 ? 0 : total / n;
  const p30 = percentileNearestRank(sorted, 30);
  const p50 = percentileNearestRank(sorted, 50);
  const p95 = percentileNearestRank(sorted, 95);
  const spread = p50 === 0 ? 0 : p95 / p50;

  const usersAboveP95 = countAbove(users, p95);
  let sumAboveP95 = 0;
  for (const u of users) {
    if (u.creditsUsed > p95) sumAboveP95 += u.creditsUsed;
  }
  const tailSharePct = total === 0 ? 0 : (sumAboveP95 / total) * 100;

  const xMax = Math.max(1, Math.ceil(max * 1.08));

  const binWidth = xMax / binCount;
  const counts = new Array(binCount).fill(0) as number[];
  for (const v of values) {
    let idx = Math.floor(v / binWidth);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    // idx is clamped to [0, binCount - 1] === [0, counts.length - 1].
    counts[idx] = (counts[idx] as number) + 1;
  }
  const bins: DistributionBin[] = counts.map((count, i) => ({
    start: i * binWidth,
    end: (i + 1) * binWidth,
    count,
  }));

  return { n, total, mean, p30, p50, p95, spread, usersAboveP95, tailSharePct, xMax, bins };
}
