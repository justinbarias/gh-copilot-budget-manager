import { Octokit } from 'octokit';
import { http, HttpResponse } from 'msw';
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const usage = await assembleUsageState(octokit, ENTERPRISE_SLUG, live.costCenterIdByName, new Date('2026-06-14T00:00:00.000Z'));

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

    // faisal-noor: R5/R6 reconciliation after the live-wire fix. His CROSS-PHASE
    // TOTAL is the users-report figure: 1,393+1,161+929+697 = 4,180 (the ULB-
    // binding meter). The per-user pool-vs-metered SPLIT is GONE from the real
    // wire (R5 usage items carry no user_login, R6 records carry no split), so
    // meteredCreditsUsed is the honest 0 and the whole 4,180 reads as pool.
    // (His 2,300-credit metered draw still shows up in the ENTERPRISE and
    // Payments Integrity cost-center metered totals below -- just not
    // attributed back to him personally. See assembleUsageState's FLAGGED note.)
    const faisal = byLogin.get('faisal-noor');
    expect(faisal).toMatchObject({
      costCenterName: 'Payments Integrity Engineering',
      meteredCreditsUsed: 0,
      poolCreditsUsed: 4_180,
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

    // Payments Integrity Engineering (cap-bound): its June pool rows sum to
    // 56,000 (53.33+80+80+106.67+133.33+106.67 = $560.00) and faisal-noor's
    // 2,300-credit metered overflow row is attributed to it by the fan-out
    // query -- this is where his metered draw now lives (no longer on his
    // per-user row). Proves per-CC metered attribution survives the wire fix.
    const payments = usage.costCenters.find((cc) => cc.costCenterName === 'Payments Integrity Engineering');
    expect(payments).toMatchObject({ poolCreditsUsed: 56_000, meteredCreditsUsed: 2_300 });

    // Enterprise-wide metered total: only faisal-noor's in-cycle 2,300 --
    // noah-tanaka's Sep 1 metered row (234) is cycle-filtered out too.
    expect(usage.enterprise.meteredCreditsUsed).toBe(2_300);
  });
});

// Live crash repro (2026-07-08): real GHEC cost centers carry flat
// ai_credit_pool_enabled + ai_credit_pool_state, NOT the internal
// included_usage_cap -- toCapControl's .included_usage_cap.enabled read was
// the TypeError that killed getControls/syncNow/dryRun live. The shared
// mapper (api-client/cost-center-cap.ts) normalizes at the fetch boundary;
// this proves it through fetchLiveControls, the exact crashing path.
describe('fetchLiveControls against real-wire cost centers', () => {
  it('does not crash on cost centers without included_usage_cap and builds cap/cost-center controls from the mapped shape', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/cost-centers`, () =>
        HttpResponse.json({
          costCenters: [
            {
              // The exact live crash shape: none of the cap fields at all.
              id: 'cc-real-bare',
              name: 'Real Wire Bare',
              state: 'active',
              resources: [{ type: 'User', name: 'monalisa' }],
            },
            {
              id: 'cc-real-capped',
              name: 'Real Wire Capped',
              state: 'active',
              resources: [],
              ai_credit_pool_enabled: true,
              ai_credit_pool_state: { target_amount: 560, current_amount: 0 },
            },
          ],
        }),
      ),
    );

    const octokit = new Octokit({ baseUrl: GITHUB_API_BASE });
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));

    // No-cap-fields CC -> the disabled default, and the roster still maps.
    const bareCap = live.controls.find((c) => c.kind === 'included_cap' && c.costCenterName === 'Real Wire Bare');
    expect(bareCap).toMatchObject({ enabled: false, computedLimitCredits: 0, overflow: 'block' });
    const bareCc = live.controls.find((c) => c.kind === 'cost_center' && c.name === 'Real Wire Bare');
    expect(bareCc).toMatchObject({
      members: [{ type: 'User', name: 'monalisa' }],
      includedUsageCap: { enabled: false, overflow: 'block' },
    });

    // ai_credit_pool_* -> mapped per the FLAGGED assumptions ($560 USD ->
    // 56,000 credits; 'block' overflow default).
    const cappedCap = live.controls.find((c) => c.kind === 'included_cap' && c.costCenterName === 'Real Wire Capped');
    expect(cappedCap).toMatchObject({ enabled: true, computedLimitCredits: 56_000, overflow: 'block' });

    // The wire-id map still resolves (writes target the right cost center).
    expect(live.costCenterIdByName.get('Real Wire Bare')).toBe('cc-real-bare');
  });
});
