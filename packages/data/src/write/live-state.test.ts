import { Octokit } from 'octokit';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/index.js';
import { assembleUsageState, fetchLiveControls } from './live-state.js';

// Task 4.11b (CLAUDE.md §6.1 preview-fidelity fix, docs/pending/todo.md's
// REQUIRED pre-Checkpoint-4 line): pins assembleUsageState's folded
// billing-report + metrics-report usage state -- the fix for
// simulatePlan previewing "0 newly blocked" for every user the billing
// report doesn't itemise by login (i.e. everyone except faisal-noor and
// noah-tanaka). Every expected value below is hand-derived from the fixtures
// (msw/fixtures/{usage,costCenters,licenses}.ts, README.md's coherence
// equations), never observed output.
//
// One mock, three consumers (CLAUDE.md §7): this test drives the same MSW
// server that simulation mode and Playwright e2e attach.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('assembleUsageState', () => {
  it('folds the billing (metered-attribution) report into the per-user metrics (total-burn) report, seeded from the full 81-seat roster', async () => {
    const octokit = new Octokit({ baseUrl: GITHUB_API_BASE });
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const usage = await assembleUsageState(octokit, ENTERPRISE_SLUG, live.costCenterIdByName);

    // Seat-seeding proof (subtlety 4): every licensed seat gets a row, not
    // just the two logins the billing report itemises -- 81 total (README.md
    // §Org chart: 24+16+8+9+11+13).
    expect(usage.users).toHaveLength(81);

    const byLogin = new Map(usage.users.map((u) => [u.userLogin, u]));

    // emily-zhao: the CCULB $0-preview fixture this task exists to fix.
    // CREDITS_USED_ITEMS June rows: 914+1142+913+685+913+913 = 5,480. She has
    // no billing-report per-user row at all -> metered 0, pool = total.
    const emily = byLogin.get('emily-zhao');
    expect(emily).toMatchObject({ costCenterName: 'Data & Evaluation Platform', poolCreditsUsed: 5_480, meteredCreditsUsed: 0 });

    // faisal-noor: the two-report reconciliation proof (subtlety 1). Metrics
    // report June total: 1,393+1,161+929+697 = 4,180 (his TOTAL, per the
    // reconciliation rule -- never summed with the billing figure). Billing
    // report's per-user row (2026-06-12, net_amount $23) attributes his
    // METERED portion: 2,300. Pool is the remainder: 4,180 − 2,300 = 1,880.
    const faisal = byLogin.get('faisal-noor');
    expect(faisal).toMatchObject({
      costCenterName: 'Payments Integrity Engineering',
      meteredCreditsUsed: 2_300,
      poolCreditsUsed: 1_880,
    });
    expect((faisal!.poolCreditsUsed ?? 0) + (faisal!.meteredCreditsUsed ?? 0)).toBe(4_180);

    // noah-tanaka: the cycle-filter proof (subtlety 2). His only rows in
    // EITHER report (Aug 31 / Sep 1, the allowance-cliff fixture) fall
    // outside cycleBounds(SIM_CURRENT_DATE)'s June window -- both reports'
    // contributions are excluded, so he reads 0/0 this cycle, not the leaked
    // 468 pool credits v1's unfiltered sum produced.
    const noah = byLogin.get('noah-tanaka');
    expect(noah).toMatchObject({ costCenterName: 'Workforce Australia Platform', poolCreditsUsed: 0, meteredCreditsUsed: 0 });

    // A zero-usage seat is present too (not just seats WITH a usage row) --
    // the other half of the seat-seeding proof: a $0 ULB must be able to
    // preview blocking someone who has never used Copilot this cycle at all.
    const zeroUsageSeat = byLogin.get('tania-osei');
    expect(zeroUsageSeat).toMatchObject({ costCenterName: 'Workforce Australia Platform', poolCreditsUsed: 0, meteredCreditsUsed: 0 });

    // Spot CC aggregate, UNCHANGED by the cycle-filter fix: Data & Evaluation
    // Platform has no per-user billing rows and no out-of-cycle rows at all,
    // so its cost-center pool/metered totals are identical before and after
    // this task (57,400 == its mtd_burn_credits fixture value, all pool).
    const dataEval = usage.costCenters.find((cc) => cc.costCenterName === 'Data & Evaluation Platform');
    expect(dataEval).toMatchObject({ poolCreditsUsed: 57_400, meteredCreditsUsed: 0 });

    // Workforce Australia Platform's CC aggregate, CHANGED by the cycle-filter
    // fix: v1's unfiltered sum leaked noah-tanaka's Aug 31 (468 pool) + Sep 1
    // (234 pool, 234 metered) cliff rows into this cost center's totals
    // (30,200 + 468 + 234 = 30,902 pool; 0 + 234 = 234 metered). Post-fix it reads
    // exactly its billing mtd_burn_credits (30,200 pool, 0 metered) -- the
    // cliff rows contribute to lifetime aggregates only, never this cycle's.
    const workforce = usage.costCenters.find((cc) => cc.costCenterName === 'Workforce Australia Platform');
    expect(workforce).toMatchObject({ poolCreditsUsed: 30_200, meteredCreditsUsed: 0 });

    // Enterprise-wide metered total: only faisal-noor's in-cycle 2,300 --
    // noah-tanaka's Sep 1 metered row (234) is cycle-filtered out too.
    expect(usage.enterprise.meteredCreditsUsed).toBe(2_300);
  });
});
