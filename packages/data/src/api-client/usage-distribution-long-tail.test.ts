import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeUsageDistribution } from '@copilot-budget/core';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE, HISTORICAL_CREDITS_USED_ITEMS } from '../msw/fixtures/index.js';
import { LONG_TAIL_CYCLE_BY_LOGIN } from '../msw/fixtures/usage-long-tail.js';
import { resetActiveScenario } from '../msw/scenario-state.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient } from './github-impl.js';

// ============================================================================
// The 'long-tail' scenario is built for the Users -> Distribution view. This
// test drives the REAL runtime path -- setScenario('long-tail') re-seeds MSW +
// re-runs the same syncNow ingestion the app runs, then getUsageDistribution
// (a pure local-SQLite read) feeds computeUsageDistribution (packages/core) --
// exactly what the Distribution screen renders. It PINS the months=1
// distribution statistics of the new world.
//
// INDEPENDENT DERIVATION of the pins (never copied from the impl's output):
//
//   getUsageDistribution({months:1}) sums each seat's credits over the trailing
//   month ending at the report's MAX date. The long-tail current-cycle rows all
//   land on June weekdays <= 2026-06-12 (usage-long-tail.ts), and the
//   scenario-blind per-user backfill (HISTORICAL_CREDITS_USED_ITEMS) ends
//   2026-05-31, so MAX date = 2026-06-12 -> window [2026-05-13, 2026-06-12]
//   (06-12 minus 1 month + 1 day), fully covered (earliest fact 2026-03-01) ->
//   truncated=false. n = 81 (the full licensed roster).
//
//   Each seat's window value = its long-tail CYCLE draw (LONG_TAIL_CYCLE_BY_LOGIN,
//   the seeded log-normal generator) PLUS, for the five history-carrying
//   personas, their backfill rows that fall inside the window. Those five
//   window sums are a deterministic function of the committed historical
//   fixture: emily-zhao 5,804 · liam-obrien 5,225 · hannah-webb 4,620 ·
//   faisal-noor 4,427 · noah-tanaka 4,131 (the SAME rows 'healthy' shows in
//   this window). `deriveWindowValues()` below re-computes the full 81-seat
//   multiset independently (NOT via getUsageDistribution) and the test asserts
//   the two agree, so the pins are anchored to the generator + the fixture, not
//   to the function under test.
//
//   Over that 81-value multiset (7 idle seats -> 0; the 6 lowest roster ranks
//   plus ext-dmorrow's $0-ULB clamp): nearest-rank percentiles are
//     P30 = value at ceil(.30*81)=25th  -> 697
//     P50 = value at ceil(.50*81)=41st  -> 1,209
//     P95 = value at ceil(.95*81)=77th  -> 5,445  (hannah-webb: 825 + 4,620)
//   total 151,605 -> mean 1,871.67 (> median 1,209: the right skew is visible);
//   usersAboveP95 = 4; users strictly above the 4,600 universal ULB = 8 (each
//   governed by a higher, more-specific ULB or carrying cross-cycle history).
// ============================================================================

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetActiveScenario();
});
afterAll(() => server.close());

/** Re-derive the months=1 per-seat window multiset independently of the impl. */
function deriveWindowValues(fromDate: string, toDate: string): number[] {
  const byLogin = new Map<string, number>(LONG_TAIL_CYCLE_BY_LOGIN);
  for (const h of HISTORICAL_CREDITS_USED_ITEMS) {
    if (h.date >= fromDate && h.date <= toDate) {
      byLogin.set(h.user_login, (byLogin.get(h.user_login) ?? 0) + h.ai_credits_used);
    }
  }
  return [...byLogin.values()];
}

describe('long-tail scenario: Users -> Distribution (months=1)', () => {
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

  it('a real syncNow -> getUsageDistribution -> computeUsageDistribution reproduces the pinned distribution', async () => {
    await client.setScenario('long-tail'); // re-seeds MSW + runs the app's syncNow
    const window = await client.getUsageDistribution({ months: 1 });

    // Window boundaries (derivation above).
    expect(window.fromDate).toBe('2026-05-13');
    expect(window.toDate).toBe('2026-06-12');
    expect(window.truncated).toBe(false);
    expect(window.users.length).toBe(81);

    // The impl's per-seat window multiset equals the independent derivation.
    const implVals = window.users.map((u) => u.creditsUsed).sort((a, b) => a - b);
    const derivedVals = deriveWindowValues(window.fromDate, window.toDate).sort((a, b) => a - b);
    expect(implVals).toEqual(derivedVals);

    // computeUsageDistribution takes core's UserCreditUsage[] ({userId, creditsUsed});
    // the window rows are UsageDistributionUser[] ({userLogin, creditsUsed, ...}) --
    // map login -> userId (only creditsUsed is read, but keep the contract honest).
    const dist = computeUsageDistribution(window.users.map((u) => ({ userId: u.userLogin, creditsUsed: u.creditsUsed })));
    expect(dist.n).toBe(81);
    expect(dist.total).toBe(151_605);
    // Right skew: mean (1,871.67) strictly greater than the median (1,209).
    expect(dist.mean).toBeCloseTo(151_605 / 81, 6);
    expect(dist.mean).toBeGreaterThan(dist.p50);

    // Nearest-rank percentiles (the Distribution view's P30/P50/P95 tiles).
    expect(dist.p30).toBe(697);
    expect(dist.p50).toBe(1_209);
    expect(dist.p95).toBe(5_445);
    expect(dist.spread).toBeCloseTo(5_445 / 1_209, 6);

    // The heavy tail + the ULB overlay pill.
    expect(dist.usersAboveP95).toBe(4);
    const above4600 = window.users.filter((u) => u.creditsUsed > 4_600).length;
    expect(above4600).toBe(8);

    // ~8% idle: the 6 lowest roster ranks + ext-dmorrow's $0-ULB clamp.
    expect(window.users.filter((u) => u.creditsUsed === 0).length).toBe(7);

    // P30/P50 are non-zero here (the whole point) -- 'healthy' reads P30=P50=0.
    expect(dist.p30).toBeGreaterThan(0);
    expect(dist.p50).toBeGreaterThan(0);
  });
});
