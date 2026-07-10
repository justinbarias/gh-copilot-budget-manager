import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeUsageDistribution } from '@copilot-budget/core';
import { server } from '../msw/server.js';
import {
  ENTERPRISE_SLUG,
  GITHUB_API_BASE,
  HISTORICAL_CREDITS_USED_ITEMS,
  SEATS,
} from '../msw/fixtures/index.js';
import { LONG_TAIL_CREDITS_USED_ITEMS } from '../msw/fixtures/usage-long-tail.js';
import { resetActiveScenario } from '../msw/scenario-state.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient } from './github-impl.js';

// ============================================================================
// The 'long-tail' scenario is built for the Users -> Distribution view. This
// test drives the REAL runtime path -- setScenario('long-tail') re-seeds MSW +
// re-runs the same syncNow ingestion the app runs, then getUsageDistribution /
// getUserMonthObservations (pure local-SQLite reads) feed
// computeUsageDistribution (packages/core) -- exactly what the Distribution
// screen renders. It PINS both the "Totals" (trailing-month) and "Per month"
// (whole-calendar-month) distribution statistics of the new world.
//
// FULL-ROSTER MONTHLY BACKFILL (this change): every one of the 81 seats now
// carries Mar/Apr/May 2026 history -- the 76 non-persona seats from the
// long-tail generator (LONG_TAIL_CREDITS_USED_ITEMS), the 5 history personas
// from the shared HISTORICAL_CREDITS_USED_ITEMS (disjoint by login). So the
// per-month lens is a real bell curve (non-zero P50), AND the trailing-"Totals"
// months=1 window (which reaches back to 2026-05-13) now sums every seat's
// May 13-31 history on top of its June cycle draw -- moving the Totals pins.
//
// INDEPENDENT DERIVATION (never copied from the impl's output): each test
// re-derives the per-seat / per-(seat,month) multiset by SUMMING the actual
// persisted fixture rows (LONG_TAIL_CREDITS_USED_ITEMS UNION
// HISTORICAL_CREDITS_USED_ITEMS) over the 81-seat licensed roster, then asserts
// the impl agrees AND that the pinned percentiles hold -- anchoring the pins to
// the generator + committed fixtures, not to the function under test.
// ============================================================================

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetActiveScenario();
});
afterAll(() => server.close());

// The full licensed roster (every seat appears in the distribution, 0 when idle
// that window). All long-tail + persona fixture logins are licensed seats, so
// this is exactly the impl's user set.
const ROSTER: readonly string[] = SEATS.map((s) => s.assignee.login);
const ALL_FIXTURE_ROWS = [...LONG_TAIL_CREDITS_USED_ITEMS, ...HISTORICAL_CREDITS_USED_ITEMS];

/** Re-derive a per-seat window/month multiset independently of the impl, from the raw fixture rows. */
function deriveMultiset(inWindow: (date: string) => boolean): number[] {
  const byLogin = new Map<string, number>(ROSTER.map((l) => [l, 0]));
  for (const r of ALL_FIXTURE_ROWS) {
    if (inWindow(r.date)) byLogin.set(r.user_login, (byLogin.get(r.user_login) ?? 0) + r.ai_credits_used);
  }
  return ROSTER.map((l) => Math.round(byLogin.get(l) ?? 0));
}

describe('long-tail scenario: Users -> Distribution', () => {
  let tmpDir: string;
  let db: Db;
  let client: ReturnType<typeof createGitHubApiClient>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-longtail-dist-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw', baseUrl: GITHUB_API_BASE });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- "Totals" lens (calendar-anchored), months=1 ----------------------------
  //
  //   Calendar-anchored: toDate = MAX NONZERO fact date = 2026-06-12 -> the
  //   current month is JUNE, and months=1 is June-to-date ONLY (no May tail).
  //   fromDate = first day of the (only) contributing month = 2026-06-01;
  //   monthsIncluded=1 -> not truncated. n = 81.
  //
  //   Each seat's window value = its June cycle draw (rows dated 2026-06-*, <=
  //   06-12). Over the 81-value multiset, nearest-rank percentiles:
  //     P30 = 25th value -> 649
  //     P50 = 41st value -> 1,100
  //     P95 = 77th value -> 4,600
  //   total 127,398 -> mean 1,572.81 (> median 1,100: right skew visible);
  //   usersAboveP95 = 3; user-window-values strictly above the ×1 = 4,600
  //   universal ULB = 3.
  it('Totals months=1: a real syncNow -> getUsageDistribution reproduces the pinned June-to-date distribution', async () => {
    await client.setScenario('long-tail'); // re-seeds MSW + runs the app's syncNow
    const window = await client.getUsageDistribution({ months: 1 });

    expect(window.fromDate).toBe('2026-06-01');
    expect(window.toDate).toBe('2026-06-12');
    expect(window.truncated).toBe(false);
    expect(window.monthsIncluded).toBe(1);
    expect(window.users.length).toBe(81);

    // The impl's per-seat window multiset equals the independent derivation
    // (June rows only, through toDate 06-12).
    const implVals = window.users.map((u) => u.creditsUsed).sort((a, b) => a - b);
    const derivedVals = deriveMultiset((d) => d >= '2026-06-01' && d <= '2026-06-12').sort((a, b) => a - b);
    expect(implVals).toEqual(derivedVals);

    const dist = computeUsageDistribution(window.users.map((u) => ({ userId: u.userLogin, creditsUsed: u.creditsUsed })));
    expect(dist.n).toBe(81);
    expect(dist.total).toBe(127_398);
    expect(dist.mean).toBeCloseTo(127_398 / 81, 6);
    expect(dist.mean).toBeGreaterThan(dist.p50); // right skew

    expect(dist.p30).toBe(649);
    expect(dist.p50).toBe(1_100);
    expect(dist.p95).toBe(4_600);
    expect(dist.spread).toBeCloseTo(4_600 / 1_100, 6);

    expect(dist.usersAboveP95).toBe(3);
    const above4600 = window.users.filter((u) => u.creditsUsed > 4_600).length;
    expect(above4600).toBe(3);

    // P30/P50 non-zero (the whole point) -- 'healthy' reads P30=P50=0 here.
    expect(dist.p30).toBeGreaterThan(0);
    expect(dist.p50).toBeGreaterThan(0);
  });

  // -- "Per month" lens (whole calendar month) ---------------------------------
  //
  //   Coverage 2026-03-01 .. 2026-06-12 -> complete months Mar/Apr/May (partial
  //   June excluded). Every one of the 81 seats emits one observation per
  //   included month (0 when idle). The multiset is derived by summing each
  //   seat's fixture rows within the month.
  it('Per month months=1 [2026-05]: 81 user-months, a non-zero-median bell curve', async () => {
    await client.setScenario('long-tail');
    const result = await client.getUserMonthObservations({ months: 1 });

    expect(result.months).toEqual(['2026-05']);
    expect(result.truncated).toBe(false);
    expect(result.observations.length).toBe(81);

    const implVals = result.observations.map((o) => o.creditsUsed).sort((a, b) => a - b);
    const derivedVals = deriveMultiset((d) => d >= '2026-05-01' && d <= '2026-05-31').sort((a, b) => a - b);
    expect(implVals).toEqual(derivedVals);

    const dist = computeUsageDistribution(result.observations.map((o) => ({ userId: o.userLogin, creditsUsed: o.creditsUsed })));
    expect(dist.n).toBe(81);
    expect(dist.total).toBe(159_447);
    expect(dist.mean).toBeCloseTo(159_447 / 81, 6);
    expect(dist.mean).toBeGreaterThan(dist.p50); // right skew

    // Nearest-rank percentiles over the 81 May observations:
    //   P30 = 25th -> 697 · P50 = 41st -> 1,172 · P95 = 77th -> 6,699 (noah-tanaka)
    expect(dist.p30).toBe(697);
    expect(dist.p50).toBe(1_172);
    expect(dist.p95).toBe(6_699);
    expect(dist.usersAboveP95).toBe(4);

    // User-months strictly above the plain 4,600 monthly ULB (5 personas + 3
    // higher-ULB generator seats at their May ceiling).
    const above4600 = result.observations.filter((o) => o.creditsUsed > 4_600).length;
    expect(above4600).toBe(8);

    expect(dist.p30).toBeGreaterThan(0);
    expect(dist.p50).toBeGreaterThan(0);
  });

  it('Per month months=3 [Mar, Apr, May]: 243 user-months across the full backfill', async () => {
    await client.setScenario('long-tail');
    const result = await client.getUserMonthObservations({ months: 3 });

    expect(result.months).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(result.truncated).toBe(false);
    expect(result.observations.length).toBe(243); // 81 seats x 3 months

    // 243 per-(seat, month) observations: each seat contributes ONE value per
    // month (its within-month sum), NOT a single 3-month total.
    const implVals = result.observations.map((o) => o.creditsUsed).sort((a, b) => a - b);
    const derivedVals = [
      ...deriveMultiset((d) => d.slice(0, 7) === '2026-03'),
      ...deriveMultiset((d) => d.slice(0, 7) === '2026-04'),
      ...deriveMultiset((d) => d.slice(0, 7) === '2026-05'),
    ].sort((a, b) => a - b);
    expect(implVals).toEqual(derivedVals);

    const dist = computeUsageDistribution(result.observations.map((o) => ({ userId: o.userLogin, creditsUsed: o.creditsUsed })));
    expect(dist.n).toBe(243);
    expect(dist.total).toBe(466_983);
    expect(dist.mean).toBeCloseTo(466_983 / 243, 6);
    expect(dist.mean).toBeGreaterThan(dist.p50);

    // Nearest-rank over 243 obs: P30 = 73rd, P50 = 122nd, P95 = 231st.
    expect(dist.p30).toBe(663);
    expect(dist.p50).toBe(1_207);
    expect(dist.p95).toBe(6_000);
    expect(dist.usersAboveP95).toBe(12);

    const above4600 = result.observations.filter((o) => o.creditsUsed > 4_600).length;
    expect(above4600).toBe(25);

    expect(dist.p50).toBeGreaterThan(0);
  });
});
