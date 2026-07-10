import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { desc } from 'drizzle-orm';
import { driftedControlIds, poolAllowanceLine } from '@copilot-budget/core';
import { assembleEnterpriseSeries, computeScopeForecast } from '../forecast/compute.js';
import { server } from '../msw/server.js';
import { BUDGET_IDS, COST_CENTER_IDS, CREDITS_USED_ITEMS, ENTERPRISE_SLUG, GITHUB_API_BASE, HISTORICAL_CREDITS_USED_ITEMS, HISTORICAL_USAGE_ITEMS, SIM_CURRENT_DATE, USAGE_ITEMS } from '../msw/fixtures/index.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { costCenter, costCenterMember, creditsUsedFact, forecast as forecastTable, license, snapshot } from '../db/schema.js';
import { createGitHubApiClient, type GitHubApiClientConfig } from './github-impl.js';
import { setWriteArmed } from '../write/arming.js';

// One mock, three consumers (CLAUDE.md §7): this test drives the same MSW
// server that simulation mode and Playwright e2e attach — never a fixture
// import, so a broken handler here would also break the running app.
// All pinned values are from the DEWR fixture world (81 seats, 6 cost
// centers) — see msw/fixtures/README.md for the coherence equations.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('createGitHubApiClient', () => {
  let tmpDir: string;
  let db: Db;
  let client: ReturnType<typeof createGitHubApiClient>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-github-impl-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    const config: GitHubApiClientConfig = { enterprise: ENTERPRISE_SLUG, db, source: 'msw' };
    client = createGitHubApiClient(config);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aggregates usage: ALL FOUR headline totals are cycle-scoped', async () => {
    const summary = await client.getUsageSummary();
    expect(summary.asOfDate).toBe('2026-09-01');
    // Cycle-scoped quantity (maintainer follow-up decision, 2026-07-09,
    // aligning quantity with the USD fields): June AI-credit rows only --
    // 189,800 pool credits + faisal-noor's 2,300 metered overflow = 192,100.
    // The two cliff rows (468 + 468) drop out (old report-span pin: 193,036).
    expect(summary.totalQuantity).toBe(192_100);
    // CYCLE-SCOPED money total (2026-07-09 addendum): only the June cycle's
    // metered spend -- the cap-bound CC's 2,300-credit overflow ($23.00). The
    // Sep-1 cliff row's $2.34 is out-of-cycle (old span total: $25.34).
    expect(summary.totalNetAmountUsd).toBeCloseTo(23.0, 5);
  });

  it('computes Overview burn-down inputs anchored to the fixture "current" date', async () => {
    const summary = await client.getUsageSummary();
    expect(summary.licenseCount).toBe(81);
    expect(summary.cycleAsOfDate).toBe('2026-06-14');
    // Cycle start (2026-06-01, day 0) through the anchor (2026-06-14, day 13) inclusive.
    expect(summary.dailyBurn).toHaveLength(14);
    expect(summary.dailyBurn[0]).toEqual({ date: '2026-06-01', cumulativePoolCredits: 0 });
    // Pool-covered credits only (discount_amount-derived): Σ of every CC's
    // itemised June pool rows = 189,800 of the 567,000 allowance (~33.5%).
    // The cap-bound CC contributes its full 56,000 cap draw; its 2,300 metered
    // overflow (discount 0) contributes nothing.
    expect(summary.dailyBurn.at(-1)).toEqual({ date: '2026-06-14', cumulativePoolCredits: 189_800 });
    // The Aug31/Sep1 cliff edge-fixture rows fall outside this cycle window entirely.
    expect(summary.dailyBurn.some((p) => p.date === '2026-08-31' || p.date === '2026-09-01')).toBe(false);
  });

  it('filters usage by cost center', async () => {
    const summary = await client.getUsageSummary({ costCenterId: COST_CENTER_IDS.workforce });
    // Cycle-scoped quantity (2026-07-09 follow-up decision): Workforce's June
    // pool rows only (30,200) -- noah-tanaka's Aug31/Sep1 cliff rows (468 +
    // 468, the old span pin's extra 936) are out-of-cycle. The Workforce
    // POLLUTION rows (Business qty 24.5 + Premium 320.25, net $468.31) are
    // sku-filtered out either way.
    expect(summary.totalQuantity).toBe(30_200);
    // Cycle-scoped money total (2026-07-09 addendum): Workforce's June rows
    // are fully pool-covered (net $0); the Sep-1 cliff row's $2.34 metered
    // half is out-of-cycle (old span total: 2.34).
    expect(summary.totalNetAmountUsd).toBeCloseTo(0, 5);
  });

  // The dashboard fix (live-pinned 2026-07-09): pool/metered money math
  // derives from copilot/"Copilot AI Credits" rows ONLY. The fixture world
  // now carries live-shaped pollution (Copilot Business + Premium Request,
  // fractional quantities) -- this test proves the pins hold BECAUSE of the
  // filter, not vacuously.
  it('getUsageSummary excludes non-AI-credit skus from every money sum (the 0-pool/$64k-phantom-metered live bug)', async () => {
    // Guard against vacuity: the fixture world genuinely contains pollution.
    expect(USAGE_ITEMS.some((i) => i.sku !== 'Copilot AI Credits')).toBe(true);

    const summary = await client.getUsageSummary();
    // AI-credit rows only; ALL headline totals cycle-scoped (2026-07-09
    // decisions): June qty = 192,100 (189,800 pool + 2,300 overflow; cliff
    // rows out); June gross = span 1,930.36 minus the cliff rows' 4.68 + 4.68
    // = 1,921.00; June net = 23.00. Unfiltered, in-cycle pollution would add
    // qty 514.5 and gross $850.08.
    expect(summary.totalQuantity).toBe(192_100);
    expect(summary.totalGrossAmountUsd).toBeCloseTo(1_921.0, 5);
    expect(summary.totalNetAmountUsd).toBeCloseTo(23.0, 5);
    // The burn-down is filtered too: still exactly 189,800 pool credits by
    // day 13 (the Business/Premium rows carry discount $4 + $10 that would
    // otherwise add 1,400 phantom pool credits).
    expect(summary.dailyBurn.at(-1)).toEqual({ date: '2026-06-14', cumulativePoolCredits: 189_800 });
  });

  it('returns an empty-but-valid summary when nothing matches the filter', async () => {
    const summary = await client.getUsageSummary({ costCenterId: 'cc-does-not-exist' });
    expect(summary.asOfDate).toBeNull();
    expect(summary.totalQuantity).toBe(0);
  });

  // Item 23 (live-pinned 2026-07-09): the real tenant's R5 shape -- YTD
  // MONTHLY aggregates, ISO-datetime dates, the current month's row
  // month-to-date cumulative. The old buildDailyBurn NaN'd on the dates and
  // windowed by day: live Overview showed actual burn = 0. Grain-adaptive
  // path: month-bucket the cycle rows, take the LEVEL from the R5 MTD pool
  // total, and synthesize the daily SHAPE (R6 daily sums where present; a
  // flat MTD/elapsed ramp otherwise -- July has no R6 fixture rows, so this
  // exercises the flat fallback). Magnitudes from the maintainer's real data.
  it('getUsageSummary builds a live-shaped burn-down from monthly aggregates: MTD level, flat ramp shape', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/usage`, ({ request }) => {
        const ccId = new URL(request.url).searchParams.get('cost_center_id');
        if (ccId !== null) return HttpResponse.json({ usageItems: [] });
        // Default call: YTD monthly aggregates (June closed + July MTD).
        return HttpResponse.json({
          usageItems: [
            { date: '2026-06-01T00:00:00Z', product: 'copilot', sku: 'Copilot AI Credits', quantity: 486_084.5584155, unitType: 'credits', pricePerUnit: 0.01, grossAmount: 4860.84, discountAmount: 3500, netAmount: 1360.84, organizationName: 'dewr-digital' },
            { date: '2026-07-01T00:00:00Z', product: 'copilot', sku: 'Copilot AI Credits', quantity: 486_860, unitType: 'credits', pricePerUnit: 0.01, grossAmount: 4868.6, discountAmount: 3825.88, netAmount: 1042.72, organizationName: 'dewr-digital' },
          ],
        });
      }),
    );

    // nowDate pins the clock seam to the live run's day (July 9) without
    // touching the scenario state.
    const liveShapedClient = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw', nowDate: '2026-07-09' });
    const summary = await liveShapedClient.getUsageSummary();

    // ALL headline totals are CYCLE-SCOPED (2026-07-09 decisions) -- the
    // exact fix for "a YTD sum against a monthly cap": July's MTD only, with
    // fractional quantities surviving (486,860, not the YTD 972,944.5584155);
    // net $1,042.72; June's closed month stays out entirely.
    expect(summary.totalQuantity).toBeCloseTo(486_860, 6);
    expect(summary.totalNetAmountUsd).toBeCloseTo(1_042.72, 5);
    expect(summary.asOfDate).toBe('2026-07-01'); // normalized to day precision

    // The burn-down: July cycle, day 9 -> 9 points (Jul 1..Jul 9). Level =
    // July's MTD pool total round(3825.88 x 100) = 382,588 -- NOT zero (the
    // old NaN bug) and NOT June-polluted. Shape = flat ramp (no July R6 rows):
    // point i = round(382,588 x i/8); midpoint i=4 -> 191,294.
    expect(summary.dailyBurn).toHaveLength(9);
    expect(summary.dailyBurn[0]).toEqual({ date: '2026-07-01', cumulativePoolCredits: 0 });
    expect(summary.dailyBurn[4]).toEqual({ date: '2026-07-05', cumulativePoolCredits: 191_294 });
    expect(summary.dailyBurn.at(-1)).toEqual({ date: '2026-07-09', cumulativePoolCredits: 382_588 });
  });

  it('lists cost centers with member counts from the resource endpoint', async () => {
    const centers = await client.listCostCenters();
    const workforce = centers.find((c) => c.id === COST_CENTER_IDS.workforce);
    expect(workforce?.memberCount).toBe(24);
    expect(centers).toHaveLength(6);
  });

  // 2026-07-09 Cost Centers live-correctness round: MTD burn is DERIVED from
  // the R5 per-CC fan-out (cycle-month, AI-credit rows), never the sim-only
  // mtd_burn_credits enrichment; DEWR mapping is app-local (null when nothing
  // supplies it); a cap-disabled CC and a no-usage CC render defined values,
  // never NaN. This is the live world that showed "undefined → undefined →
  // undefined" and NaN on all six real CCs.
  it('listCostCenters against real-wire CCs: derived MTD burn, null mapping, 0 (never NaN) for a no-usage CC', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/cost-centers`, () =>
        HttpResponse.json({
          costCenters: [
            // The live shape: NO dewr_*, NO mtd_burn_credits, cap disabled.
            { id: 'cc-live-1', name: 'TSD-Premium', state: 'active', ai_credit_pool_enabled: false, resources: [{ type: 'User', name: 'monalisa' }] },
            { id: 'cc-live-2', name: 'DES-NoFunds', state: 'active', resources: [] },
          ],
        }),
      ),
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/usage`, ({ request }) => {
        const ccId = new URL(request.url).searchParams.get('cost_center_id');
        if (ccId === 'cc-live-1') {
          // July monthly aggregate, ISO-dated, FRACTIONAL quantity -- plus a
          // pollution row and a June row, both of which must not count.
          return HttpResponse.json({
            usageItems: [
              { date: '2026-07-01T00:00:00Z', product: 'copilot', sku: 'Copilot AI Credits', quantity: 486_084.5584155, unitType: 'credits', pricePerUnit: 0.01, grossAmount: 4860.84, discountAmount: 3825.88, netAmount: 1034.96, organizationName: 'dewr' },
              { date: '2026-07-01T00:00:00Z', product: 'copilot', sku: 'Copilot Business', quantity: 24.5, unitType: 'seats', pricePerUnit: 19, grossAmount: 465.5, discountAmount: 0, netAmount: 465.5, organizationName: 'dewr' },
              { date: '2026-06-01T00:00:00Z', product: 'copilot', sku: 'Copilot AI Credits', quantity: 300_000, unitType: 'credits', pricePerUnit: 0.01, grossAmount: 3000, discountAmount: 3000, netAmount: 0, organizationName: 'dewr' },
            ],
          });
        }
        return HttpResponse.json({ usageItems: [] });
      }),
    );

    const liveShapedClient = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw', nowDate: '2026-07-09' });
    const centers = await liveShapedClient.listCostCenters();
    expect(centers).toHaveLength(2);

    const withUsage = centers.find((c) => c.id === 'cc-live-1')!;
    // Derived: round(486,084.5584155) from the July MTD aggregate only --
    // the June aggregate (300,000) and the Business pollution row (24.5) are
    // bucketed/filtered out. Fractional survives to the rounding boundary.
    expect(withUsage.mtdBurnCredits).toBe(486_085);
    expect(Number.isNaN(withUsage.mtdBurnCredits)).toBe(false);
    // App-local mapping absent everywhere -> honest nulls (never "undefined").
    expect(withUsage.dewrDivision).toBeNull();
    expect(withUsage.dewrBranch).toBeNull();
    expect(withUsage.dewrProject).toBeNull();
    expect(withUsage.includedUsageCap.enabled).toBe(false);

    // A CC with NO usage rows at all: 0, never NaN.
    const noUsage = centers.find((c) => c.id === 'cc-live-2')!;
    expect(noUsage.mtdBurnCredits).toBe(0);
    expect(noUsage.includedUsageCap).toEqual({ enabled: false, computedLimitCredits: 0, overflow: 'block' });
  });

  // The sanctioned updateCostCenterMapping method: app-local DB metadata only.
  it('updateCostCenterMapping round-trips through listCostCenters and NEVER issues a GitHub request', async () => {
    const githubRequests: string[] = [];
    const listener = ({ request }: { request: Request }): void => {
      if (new URL(request.url).hostname === 'api.github.com') githubRequests.push(request.url);
    };

    server.events.on('request:start', listener);
    try {
      await client.updateCostCenterMapping(COST_CENTER_IDS.cyber, {
        dewrDivision: 'Corporate & Enabling Group',
        dewrBranch: 'Cyber Security Branch',
        dewrProject: 'CYB-EDIT',
      });
    } finally {
      server.events.removeListener('request:start', listener);
    }
    // The write is local DB metadata -- zero GitHub traffic (§6.8-adjacent:
    // works identically in both modes, safe pre-9.3).
    expect(githubRequests).toEqual([]);

    // The edited mapping WINS over the sim fixtures' wire enrichment.
    const centers = await client.listCostCenters();
    const cyber = centers.find((c) => c.id === COST_CENTER_IDS.cyber)!;
    expect(cyber.dewrDivision).toBe('Corporate & Enabling Group');
    expect(cyber.dewrBranch).toBe('Cyber Security Branch');
    expect(cyber.dewrProject).toBe('CYB-EDIT');

    // ...and SURVIVES a sync: syncNow's cost-center upsert only sets
    // name/state, never these columns.
    await client.syncNow();
    const afterSync = (await client.listCostCenters()).find((c) => c.id === COST_CENTER_IDS.cyber)!;
    expect(afterSync.dewrProject).toBe('CYB-EDIT');
  });

  it('carries the DEWR mapping, MTD burn, and read-only included-usage cap per cost center', async () => {
    const centers = await client.listCostCenters();

    const workforce = centers.find((c) => c.id === COST_CENTER_IDS.workforce);
    expect(workforce?.dewrDivision).toBe('Employment Systems Group');
    expect(workforce?.dewrBranch).toBe('Digital Delivery Branch');
    expect(workforce?.dewrProject).toBe('WFA-DIGITAL');
    // Reconciles with its June USAGE_ITEMS rows; cap = 24 seats x 7,000 promo credits.
    expect(workforce?.mtdBurnCredits).toBe(30_200);
    expect(workforce?.includedUsageCap).toEqual({ enabled: true, computedLimitCredits: 168_000, overflow: 'block' });
    expect(workforce?.excludedFromEnterpriseBudget).toBe(false);

    // Cap-bound edge fixture: GitHub-reported MTD (56,000 pool + 2,300 metered
    // overflow) exceeds its 8 x 7,000 computed cap -> negative headroom downstream.
    const capBound = centers.find((c) => c.id === COST_CENTER_IDS.capBound);
    expect(capBound?.mtdBurnCredits).toBe(58_300);
    expect(capBound?.includedUsageCap).toEqual({ enabled: true, computedLimitCredits: 56_000, overflow: 'metered' });

    // Amber fixture: within cap but under the 8,000-credit low-headroom
    // threshold (63,000 - 57,400 = 5,600).
    const dataEval = centers.find((c) => c.id === COST_CENTER_IDS.dataEval);
    expect(dataEval?.mtdBurnCredits).toBe(57_400);
    expect(dataEval?.includedUsageCap).toEqual({ enabled: true, computedLimitCredits: 63_000, overflow: 'block' });
  });

  // --- Live crash repro (2026-07-08): real GHEC cost centers carry flat
  // ai_credit_pool_enabled + ai_credit_pool_state, NOT the internal
  // included_usage_cap -- reading .included_usage_cap.enabled crashed
  // listCostCenters/getControls/syncNow live. The shared mapper
  // (cost-center-cap.ts, unit-pinned in cost-center-cap.test.ts) folds both
  // dialects; this proves it through the real listCostCenters path. ---------
  it('listCostCenters does not crash on real-wire cost centers (no included_usage_cap) and maps the ai_credit_pool_* fields', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/cost-centers`, () =>
        HttpResponse.json({
          costCenters: [
            {
              // The exact live crash shape: NONE of the cap fields at all.
              id: 'cc-real-bare',
              name: 'Real Wire Bare',
              state: 'active',
              resources: [{ type: 'User', name: 'monalisa' }],
            },
            {
              // Cap enabled on the real wire: flat flag + read-only state.
              id: 'cc-real-capped',
              name: 'Real Wire Capped',
              state: 'active',
              resources: [{ type: 'User', name: 'hubot' }],
              ai_credit_pool_enabled: true,
              ai_credit_pool_state: { target_amount: 560, current_amount: 123.45 },
            },
          ],
        }),
      ),
    );

    const centers = await client.listCostCenters();
    expect(centers).toHaveLength(2);

    // No cap fields -> the disabled default world, never a throw.
    const bare = centers.find((c) => c.id === 'cc-real-bare');
    expect(bare?.includedUsageCap).toEqual({ enabled: false, computedLimitCredits: 0, overflow: 'block' });
    expect(bare?.members.map((m) => m.login)).toEqual(['monalisa']);

    // ai_credit_pool_* mapped: enabled true; $560.00 target -> 56,000 credits
    // (FLAGGED USD unit assumption); overflow 'block' (FLAGGED default -- no
    // overflow-suggestive key on this object).
    const capped = centers.find((c) => c.id === 'cc-real-capped');
    expect(capped?.includedUsageCap).toEqual({ enabled: true, computedLimitCredits: 56_000, overflow: 'block' });
  });

  it('joins per-member cycle burn and enterprise-team provenance into the membership list', async () => {
    const centers = await client.listCostCenters();

    const capBound = centers.find((c) => c.id === COST_CENTER_IDS.capBound);
    expect(capBound?.members).toHaveLength(8);
    expect(capBound?.members.find((m) => m.login === 'faisal-noor')).toEqual({
      login: 'faisal-noor',
      mtdBurnCredits: 4_180,
      entTeam: 'assurance',
    });
    // No credits rows in the current cycle and no ent-team provenance.
    expect(capBound?.members.find((m) => m.login === 'dev-raman')).toEqual({
      login: 'dev-raman',
      mtdBurnCredits: 0,
      entTeam: null,
    });

    // noah-tanaka's credits rows (Aug 31 / Sep 1 cliff fixtures) fall outside the
    // June cycle window, so their member burn is 0 -- cycle-filtered, not lifetime.
    const workforce = centers.find((c) => c.id === COST_CENTER_IDS.workforce);
    expect(workforce?.members.find((m) => m.login === 'noah-tanaka')?.mtdBurnCredits).toBe(0);
    expect(workforce?.members.find((m) => m.login === 'liam-obrien')).toEqual({
      login: 'liam-obrien',
      mtdBurnCredits: 4_930,
      entTeam: 'payments-eng',
    });
  });

  // Distribution D2 (maintainer-approved sync change, 2026-07-10): syncNow
  // persists the prior-cycle per-user backfill (the SAME already-fetched
  // records the forecast trains on) into credits_used_fact alongside the
  // current cycle's, each row carrying the report's user_login.
  it('syncNow persists the prior-cycle backfill into credits_used_fact, every row carrying user_login', async () => {
    await client.syncNow();
    const rows = db.select().from(creditsUsedFact).all();

    // Backfill window (fetchHistoricalCreditsUsedItems): 2026-03-01 through
    // 2026-05-31 -- 31 + 30 + 31 = 92 days, and the historical fixture
    // generator emits one row per persona per day (5 personas; even the
    // smallest weekend value rounds above zero, e.g. faisal-noor's March
    // weekend 4180/13 x 0.7 x 0.3 = 67.5 -> 68). 5 x 92 = 460 rows.
    const historical = rows.filter((r) => r.date < '2026-06-01');
    expect(historical).toHaveLength(460);
    expect(HISTORICAL_CREDITS_USED_ITEMS).toHaveLength(460); // the generator emits exactly the persisted set
    expect(historical.every((r) => r.userLogin !== null)).toBe(true);
    expect(rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0]!.date)).toBe('2026-03-01');

    // Hand-computed spot check: emily-zhao (user 5182), Monday 2026-03-02, a
    // March weekday -- dailyRate 5480/13 x MONTH_RAMP[3] 0.7 = 295.0769...
    // -> Math.round -> 295 (usage-history.ts's generator).
    expect(historical.find((r) => r.userId === '5182' && r.date === '2026-03-02')).toMatchObject({
      userLogin: 'emily-zhao',
      creditsUsed: 295,
    });

    // Current-cycle rows still land, now with logins (liam-obrien's pinned
    // 2026-06-03 row: 822 credits), and the total is backfill + the June
    // cycle-window fixture rows (2026-06-01..14; the R6 fan-out serves the
    // fixture rows verbatim, one JSONL record per row).
    expect(rows.find((r) => r.date === '2026-06-03' && r.userId === '5107')).toMatchObject({
      userLogin: 'liam-obrien',
      creditsUsed: 822,
    });
    const juneWindowCount = CREDITS_USED_ITEMS.filter((i) => i.date >= '2026-06-01' && i.date <= '2026-06-14').length;
    expect(rows).toHaveLength(460 + juneWindowCount);
  });

  it('ranks the full 81-user licensed roster by cycle-to-date credits used, descending', async () => {
    const users = await client.listHeavyUsers();
    // Task 2.4: every licensed seat appears, not just users with a usage row --
    // the Users screen's pagination and "No usage" filter need the full roster.
    expect(users).toHaveLength(81);
    for (let i = 1; i < users.length; i++) {
      expect(users[i - 1]!.creditsUsed).toBeGreaterThanOrEqual(users[i]!.creditsUsed);
    }

    // noah-tanaka's credits rows (Aug 31/Sep 1 cliff fixtures) fall outside the
    // June cycle window -- cycle-filtered the same way listCostCenters' member
    // burn is, so this is 0 MTD this cycle, not the 936 lifetime total across
    // both cliff rows.
    const cliffUser = users.find((u) => u.userLogin === 'noah-tanaka');
    expect(cliffUser?.creditsUsed).toBe(0);

    // The top of the leaderboard is the Data & Evaluation heavy cohort.
    expect(users[0]).toMatchObject({ userLogin: 'emily-zhao', creditsUsed: 5_480 });
    const liam = users.find((u) => u.userLogin === 'liam-obrien');
    expect(liam?.creditsUsed).toBe(4_930);
    const faisal = users.find((u) => u.userLogin === 'faisal-noor');
    expect(faisal?.creditsUsed).toBe(4_180);
  });

  it('joins cost-center name, daily series, model mix, and the precedence-resolved effective ULB', async () => {
    const users = await client.listHeavyUsers();

    // sarah-huang: Workforce CC, no individual override -> falls back to the
    // Workforce CCULB (budget-cculb-workforce, $52 -> 5,200 credits).
    const sarah = users.find((u) => u.userLogin === 'sarah-huang')!;
    expect(sarah.costCenterName).toBe('Workforce Australia Platform');
    expect(sarah.effectiveUlb).toEqual({ amountCredits: 5_200, scope: 'cost-center' });
    expect(sarah.dailySeries).toHaveLength(14);
    expect(sarah.dailySeries.reduce((sum, p) => sum + p.creditsUsed, 0)).toBe(4_760);
    expect(sarah.modelMix.segments.reduce((sum, s) => sum + s.pct, 0) + sarah.modelMix.unattributablePct).toBe(100);

    // noah-tanaka: no usage this cycle -> empty daily series, not zero-filled.
    const noah = users.find((u) => u.userLogin === 'noah-tanaka')!;
    expect(noah.dailySeries).toEqual([]);
    expect(noah.modelMix).toEqual({ segments: [], unattributablePct: 0 });

    // ext-dmorrow: the $0 individual ULB edge fixture (budget-ulb-zero) --
    // always blocks, wins over Corporate Systems' universal fallback (no CCULB
    // exists for that CC).
    const dmorrow = users.find((u) => u.userLogin === 'ext-dmorrow')!;
    expect(dmorrow.costCenterName).toBe('Corporate Systems');
    expect(dmorrow.effectiveUlb).toEqual({ amountCredits: 0, scope: 'individual' });

    // liam-obrien: the ULB-display-bug edge fixture (budget-ulb-display-bug,
    // $58 individual) -- overrides the Workforce CCULB for this one person only.
    const liam = users.find((u) => u.userLogin === 'liam-obrien')!;
    expect(liam.costCenterName).toBe('Workforce Australia Platform');
    expect(liam.effectiveUlb).toEqual({ amountCredits: 5_800, scope: 'individual' });

    // faisal-noor: Payments Integrity (cap-bound) CC has no CCULB fixture ->
    // falls back to the universal ULB (budget-universal-dewr, $46 -> 4,600 credits).
    const faisal = users.find((u) => u.userLogin === 'faisal-noor')!;
    expect(faisal.costCenterName).toBe('Payments Integrity Engineering');
    expect(faisal.effectiveUlb).toEqual({ amountCredits: 4_600, scope: 'universal' });
  });

  // Open item 20: an actions/storage budget's dollar cap is NOT an AI-credit
  // ceiling -- fetchBudgetsRaw excludes non-AI-credit budgets before ULB
  // precedence resolution, so a user-scoped actions budget can never
  // masquerade as (or outrank) someone's individual AI-credit ULB.
  it('ULB resolution ignores non-AI-credit budgets: a user-scoped actions budget never becomes an effective ULB', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/budgets`, () =>
        HttpResponse.json({
          budgets: [
            {
              id: 'bud-universal-ai',
              budget_type: 'BundlePricing',
              budget_product_sku: 'ai_credits',
              budget_scope: 'multi_user_customer',
              budget_entity_name: ENTERPRISE_SLUG,
              budget_amount: 46,
              prevent_further_usage: true,
              budget_alerting: { will_alert: false, alert_recipients: [] },
            },
            {
              // A $2 user-scoped ACTIONS budget for emily-zhao. Unfiltered it
              // would resolve as her individual ULB (individual > universal)
              // and (200 credits < her 5,480 MTD) mislabel her as blocked.
              id: 'bud-actions-user',
              budget_type: 'ProductPricing',
              budget_product_sku: 'actions',
              budget_scope: 'user',
              budget_entity_name: ENTERPRISE_SLUG,
              user: 'emily-zhao',
              budget_amount: 2,
              prevent_further_usage: true,
              budget_alerting: { will_alert: false, alert_recipients: [] },
            },
          ],
        }),
      ),
    );

    const users = await client.listHeavyUsers();
    const emily = users.find((u) => u.userLogin === 'emily-zhao')!;
    // The actions budget is filtered out at the read boundary: emily falls
    // back to the universal AI-credit ULB ($46 -> 4,600 credits), never the
    // $2 actions cap.
    expect(emily.effectiveUlb).toEqual({ amountCredits: 4_600, scope: 'universal' });
  });

  it('surfaces the pre-baked fixture alerts', async () => {
    const alerts = await client.listAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((a) => a.budgetId === BUDGET_IDS.zeroUlb)).toBe(true);
  });

  it('syncNow ingests real rows into SQLite and getSyncStatus is derived from them', async () => {
    expect((await client.getSyncStatus()).lastSyncedAt).toBeNull();

    const result = await client.syncNow();
    expect(result.inProgress).toBe(false);
    expect(result.lastSyncedAt).not.toBeNull();
    expect((await client.getSyncStatus()).lastSyncedAt).toBe(result.lastSyncedAt);

    // Not just a status flag flipping -- confirm rows actually landed, matching
    // the fixture set (81 seats, 6 cost centers, their resource memberships:
    // 24 + 16 + 8 + 9 + 11 + 13 = 81, every seat in exactly one CC).
    expect(db.select().from(costCenter).all()).toHaveLength(6);
    expect(db.select().from(license).all()).toHaveLength(81);
    expect(db.select().from(costCenterMember).all()).toHaveLength(81);

    // A second sync must not duplicate dimension rows.
    await client.syncNow();
    expect(db.select().from(costCenter).all()).toHaveLength(6);
    expect(db.select().from(license).all()).toHaveLength(81);
    expect(db.select().from(costCenterMember).all()).toHaveLength(81);
  });

  // --- Trailing-gap surface (SyncStatus.perUserDataThroughDay, maintainer-
  // approved optional extension 2026-07-08). The tolerance MECHANICS are
  // pinned by users-report.test.ts; these two prove the wiring through the
  // real ApiClient surface: absent pre-sync, full coverage in sim, and the
  // honest earlier day when the as-of day's report is not yet available. ---

  it('perUserDataThroughDay: absent before any sync, then the as-of day after a sim sync (no gap fires in simulation)', async () => {
    expect((await client.getSyncStatus()).perUserDataThroughDay).toBeUndefined();

    const result = await client.syncNow();
    expect(result.perUserDataThroughDay).toBe(SIM_CURRENT_DATE); // mock serves the as-of day -> full coverage
    expect((await client.getSyncStatus()).perUserDataThroughDay).toBe(SIM_CURRENT_DATE);
  });

  it('perUserDataThroughDay: a live-shaped not-yet-available as-of day is skipped and coverage honestly reports the prior day', async () => {
    // The live signature: the as-of day's users-1-day 400s on the documented
    // query form ("Date must be ... not in the future"-class failure) and the
    // path-param fallback 404s (docs-faithful tenant).
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-1-day`, ({ request }) => {
        if (new URL(request.url).searchParams.get('day') === SIM_CURRENT_DATE) {
          return HttpResponse.json({ message: 'Invalid day parameter. Date must be within the last year and not in the future.' }, { status: 400 });
        }
        return undefined; // fall through to the canonical handler
      }),
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-1-day/:day`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );

    const result = await client.syncNow();
    // The Sync SUCCEEDED (rows landed, status is real) despite the trailing gap...
    expect(result.lastSyncedAt).not.toBeNull();
    expect(db.select().from(license).all()).toHaveLength(81);
    // ...and coverage reports the last day that actually had a report:
    // 2026-06-13, the day before the SIM_CURRENT_DATE (2026-06-14) as-of day.
    expect(result.perUserDataThroughDay).toBe('2026-06-13');
    expect((await client.getSyncStatus()).perUserDataThroughDay).toBe('2026-06-13');
  });

  // --- Task 4.15: syncNow's controls phase + getLastSyncedControls, wired
  // through the real ApiClient surface (deep ingestion/append-only/strip
  // behaviour is covered exhaustively against the bare sync-now.ts functions
  // by sync-now.test.ts; these confirm createGitHubApiClient wires
  // fetchLiveControls into syncNow's IngestData.controls correctly, and that
  // getLastSyncedControls reads it back through the SAME client). ---------

  it('getLastSyncedControls is null before any sync, then agrees with a fresh getControls() read immediately after one (MSW never actually drifts)', async () => {
    expect(await client.getLastSyncedControls()).toBeNull();

    await client.syncNow();
    const live = await client.getControls();
    const lastSynced = await client.getLastSyncedControls();

    expect(lastSynced).not.toBeNull();
    expect(lastSynced!.capturedAt).not.toBeNull();
    // The REAL comparator the Controls screen's drift marker uses (core's
    // driftedControlIds): a sync immediately followed by a live re-read must
    // show ZERO drift, including for the display-bug budget whose
    // simulatedUiHidden enrichment is present live but stripped from the
    // persisted record -- proving that asymmetry never false-positives here,
    // end-to-end through the real ApiClient, not just at the unit level.
    expect(driftedControlIds(lastSynced!.controls, live)).toEqual(new Set());
  });

  it('syncNow ingests controls into a NEW generation each call (append-only), not just usage/dimension rows', async () => {
    const first = await client.syncNow();
    const second = await client.syncNow();
    expect(second.lastSyncedAt).not.toBe(first.lastSyncedAt);

    // Both generations' worth of control_snapshot rows exist -- proven
    // indirectly here (schema-level row counts are sync-now.test.ts's job):
    // getLastSyncedControls must still resolve to a real, non-null result
    // after two syncs, keyed to the LATEST one.
    const lastSynced = await client.getLastSyncedControls();
    expect(lastSynced).not.toBeNull();
    expect(lastSynced!.capturedAt).toBe(second.lastSyncedAt);
  });

  // --- Task 5.4: forecast persistence + compute-on-sync + getForecast, wired
  // through the real ApiClient surface against the full DEWR fixture world
  // (81 seats, 6 cost centers) -- the pure fold/glue logic itself
  // (toDailyBurn/assemble*Series/computeScopeForecast's window-picking) is
  // covered exhaustively by forecast/compute.test.ts; these confirm
  // createGitHubApiClient's syncNow wires the RIGHT rosters/allowances/flags
  // into it end to end. ---------------------------------------------------

  describe('Task 5.4: forecast-on-sync + getForecast', () => {
    it('getForecast is null for every scope before any sync has run', async () => {
      expect(await client.getForecast('enterprise')).toBeNull();
      expect(await client.getForecast('cost_center', COST_CENTER_IDS.workforce)).toBeNull();
      expect(await client.getForecast('user', '5182')).toBeNull();
    });

    it('syncNow persists exactly one forecast row per (enterprise, every active cost center, every licensed user)', async () => {
      await client.syncNow();

      const rows = db.select().from(forecastTable).all();
      // 1 enterprise + 6 DEWR cost centers + 81 licensed seats.
      expect(rows).toHaveLength(1 + 6 + 81);
      expect(rows.filter((r) => r.scope === 'enterprise')).toHaveLength(1);
      expect(rows.filter((r) => r.scope === 'cost_center')).toHaveLength(6);
      expect(rows.filter((r) => r.scope === 'user')).toHaveLength(81);

      // Every cost-center forecast row is keyed to a real DEWR cost-center id.
      const ccEntityRefs = new Set(rows.filter((r) => r.scope === 'cost_center').map((r) => r.entityRef));
      expect(ccEntityRefs).toEqual(new Set(Object.values(COST_CENTER_IDS)));

      // The enterprise row carries no entity ref.
      expect(rows.find((r) => r.scope === 'enterprise')!.entityRef).toBeNull();

      // Every row references the SAME (only) snapshot generation this one
      // sync produced -- the FR18 "forecast basis".
      const latestSnapshot = db.select().from(snapshot).orderBy(desc(snapshot.id)).limit(1).all()[0]!;
      expect(new Set(rows.map((r) => r.snapshotId))).toEqual(new Set([latestSnapshot.id]));

      // computedAt is the SIM_CURRENT_DATE as-of anchor, never wall-clock.
      expect(rows.every((r) => r.computedAt === SIM_CURRENT_DATE)).toBe(true);
    });

    it("the persisted enterprise forecast matches core's forecast() run directly on the same assembled series (byte-equal)", async () => {
      await client.syncNow();

      const stored = await client.getForecast('enterprise');
      expect(stored).not.toBeNull();
      expect(stored!.entityId).toBeNull();
      expect(stored!.computedAt).toBe(SIM_CURRENT_DATE);

      // Independently re-derive the SAME series from the raw fixtures (not
      // from any github-impl internals) and re-run compute.ts's own
      // forecast+backtest glue on it -- github-impl's persisted row must
      // match this byte-for-byte, proving the ONLY thing github-impl adds is
      // correct wiring (roster size, allowance basis, paid-usage flag), not a
      // second, independently-computed answer. The AI-credit sku filter
      // (usage-fetch.ts's live pin) is part of the derivation rule this test
      // hand-reproduces: the fixture world's Copilot Business / Premium
      // Request pollution rows must NOT train the forecast.
      const asOfDate = new Date(`${SIM_CURRENT_DATE}T00:00:00.000Z`);
      const usageRows = [...USAGE_ITEMS, ...HISTORICAL_USAGE_ITEMS]
        .filter((i) => i.product === 'copilot' && i.sku === 'Copilot AI Credits')
        .map((i) => ({
          date: i.date,
          costCenterId: i.cost_center_id,
          quantity: i.quantity,
        }));
      const series = assembleEnterpriseSeries(usageRows, asOfDate);
      const expected = computeScopeForecast({
        history: series,
        asOfDate,
        allowance: poolAllowanceLine(81, { edition: 'enterprise', existingCustomer: true }),
        paidUsageEnabled: true,
      });

      expect(stored!.result).toEqual(expected.result);
      expect(stored!.mape).toBe(expected.mape);

      // Hand-checkable pin (DEWR world: 189,800 of 567,000 burned by day 13
      // of 30 -- run-rate blends a ramping trailing-7 average against that
      // cycle-to-date pace): the pool projects to exhaust 15 days after the
      // 2026-06-14 as-of date.
      expect(stored!.result.exhaustionDate).toBe('2026-06-29');
      expect(stored!.result.runwayDays).toBe(15);
    });

    it('a cap-bound cost center (Payments Integrity) forecasts against its own license-derived cap, not the enterprise pool', async () => {
      await client.syncNow();

      const capBound = await client.getForecast('cost_center', COST_CENTER_IDS.capBound);
      expect(capBound).not.toBeNull();
      // 8 seats x 7,000 promo credits/seat (the fixture's own "8 x 7,000"
      // comment in costCenters.ts) -- the FIRST day's allowanceLine, before
      // any cliff step-down.
      expect(capBound!.result.dailySeries[0]?.allowanceLine).toBe(56_000);
    });

    it('getForecast returns null for a scope/entity that was never computed (unknown cost center)', async () => {
      await client.syncNow();
      expect(await client.getForecast('cost_center', 'cc-does-not-exist')).toBeNull();
    });

    // R6 backfill restoration (maintainer decision 2026-07-08): the user-scope
    // forecast trains on the 3 prior closed cycles (users-1-day daily backfill,
    // 2026-03-01..2026-05-31 as-of the 2026-06-14 anchor) + the current cycle
    // -- the SAME window the old `since`-based fetch targeted. emily-zhao
    // (user 5182) is a backfilled persona: with prior-cycle history her
    // backtest MAPE is computable (non-null -- May is the eval window,
    // March/April the earlier training data) and her run-rate projects
    // exhaustion of her 6,000-credit Data & Evaluation CCULB on 2026-06-15
    // (~1 day of runway) -- the exact values the committed forecast e2e pins
    // assert, which went null/earlier when the backfill was briefly cut.
    it('user-scope forecasts train on the prior-3-closed-cycle backfill: emily-zhao has a non-null MAPE and a 2026-06-15 block date', async () => {
      await client.syncNow();

      const emily = await client.getForecast('user', '5182');
      expect(emily).not.toBeNull();
      expect(emily!.mape).not.toBeNull();
      expect(emily!.result.exhaustionDate).toBe('2026-06-15');
      expect(emily!.result.runwayDays).toBe(1);

      // Contrast: sarah-huang (6218) has current-cycle rows but NO prior-cycle
      // backfill rows (not one of the 5 historical personas) -> insufficient
      // history for a backtest window -> mape stays honestly null.
      const sarah = await client.getForecast('user', '6218');
      expect(sarah).not.toBeNull();
      expect(sarah!.mape).toBeNull();
    });
  });

  // --- Task 4.8: write engine wiring through the real ApiClient surface ---
  // (deep engine behaviour -- drift/blocked/partial-failure/no-op -- is
  // covered exhaustively by write/engine.test.ts against a bare Octokit
  // instance; these confirm createGitHubApiClient wires getControls/
  // dryRunPlan/applyPlan to the engine correctly, AND that the API-version
  // header is actually set, since that hook lives here at client
  // construction, not in engine.ts.)

  it('getControls returns the live control state, including a cost-center spending limit', async () => {
    const controls = await client.getControls();
    const workforceBudget = controls.find(
      (c) => c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === 'Workforce Australia Platform',
    );
    expect(workforceBudget).toMatchObject({ amountCredits: 60_000, preventFurtherUsage: false });
  });

  it('dryRunPlan/applyPlan round-trip through the ApiClient surface: dry run previews, apply mutates and audits', async () => {
    const live = await client.getControls();
    const desiredControls = live.map((c) =>
      c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === 'Workforce Australia Platform'
        ? { ...c, amountCredits: 65_000 }
        : c,
    );

    const dryRun = await client.dryRunPlan(desiredControls);
    expect(dryRun.plan.entries).toHaveLength(1);
    expect(dryRun.validation.isBlocked).toBe(false);

    const applied = await client.applyPlan(dryRun.plan, desiredControls, { actor: 'admin@example.com' });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error(`expected 'applied', got ${applied.status}`);
    expect(applied.mutationLog).toHaveLength(1);
    expect(applied.mutationLog[0]?.path).toContain(BUDGET_IDS.costCenterMetered);
    expect(applied.auditEvents).toHaveLength(1);
    expect(applied.auditEvents[0]?.action).toBe('budget.update');
    expect(applied.auditEvents[0]?.justification).toBeNull();
  });

  it('sets X-GitHub-Api-Version on every request -- reads and mutations alike', async () => {
    const seen: { method: string; header: string | null }[] = [];
    const onRequestStart = ({ request }: { request: Request }) => {
      if (request.url.includes('api.github.com')) seen.push({ method: request.method, header: request.headers.get('x-github-api-version') });
    };
    server.events.on('request:start', onRequestStart);

    try {
      const live = await client.getControls();
      const desiredControls = live.map((c) =>
        c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === 'Workforce Australia Platform'
          ? { ...c, amountCredits: 65_000 }
          : c,
      );
      const dryRun = await client.dryRunPlan(desiredControls);
      const applied = await client.applyPlan(dryRun.plan, desiredControls, { actor: 'admin@example.com' });
      expect(applied.status).toBe('applied');
    } finally {
      server.events.removeListener('request:start', onRequestStart);
    }

    expect(seen.length).toBeGreaterThan(0);
    const mutations = seen.filter((r) => r.method !== 'GET');
    expect(mutations.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.header).toBe('2026-03-10');
  });
});

// Task 9.3-lite: the persisted mode selection + live-write arming, driven
// through the ApiClient surface (the exact methods the preload bridge exposes).
describe('Task 9.3-lite: mode selection + live-write arming', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-arming-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    setWriteArmed(false); // reset the process-memory singleton per test
  });

  afterEach(() => {
    setWriteArmed(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getAppModeSetting defaults to simulation and setAppModeSetting roundtrips', async () => {
    const client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw' });
    expect(await client.getAppModeSetting()).toBe('simulation');
    await client.setAppModeSetting('live');
    expect(await client.getAppModeSetting()).toBe('live');
    await client.setAppModeSetting('simulation');
    expect(await client.getAppModeSetting()).toBe('simulation');
  });

  it('simulation source: arming is INERT (state disarmed, arm is a no-op)', async () => {
    const client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw' });
    expect(await client.getWriteArmingState()).toEqual({ armed: false, enterpriseSlug: null, mode: 'simulation' });
    // Even a "correct" confirmation is inert in sim.
    const after = await client.setWriteArming({ action: 'arm', confirmation: ENTERPRISE_SLUG });
    expect(after).toEqual({ armed: false, enterpriseSlug: null, mode: 'simulation' });
    expect(await client.getWriteArmingState()).toEqual({ armed: false, enterpriseSlug: null, mode: 'simulation' });
  });

  it('github source: arm with the correct slug arms; wrong slug throws and stays disarmed; disarm disarms', async () => {
    const client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'github' });

    expect(await client.getWriteArmingState()).toEqual({ armed: false, enterpriseSlug: ENTERPRISE_SLUG, mode: 'live' });

    // Wrong confirmation: throws, and the flag stays disarmed.
    await expect(client.setWriteArming({ action: 'arm', confirmation: 'not-the-slug' })).rejects.toThrow(
      'Confirmation does not match the enterprise slug.',
    );
    expect(await client.getWriteArmingState()).toEqual({ armed: false, enterpriseSlug: ENTERPRISE_SLUG, mode: 'live' });

    // Correct confirmation: arms.
    const armed = await client.setWriteArming({ action: 'arm', confirmation: ENTERPRISE_SLUG });
    expect(armed).toEqual({ armed: true, enterpriseSlug: ENTERPRISE_SLUG, mode: 'live' });
    expect(await client.getWriteArmingState()).toEqual({ armed: true, enterpriseSlug: ENTERPRISE_SLUG, mode: 'live' });

    // Disarm needs no confirmation.
    const disarmed = await client.setWriteArming({ action: 'disarm' });
    expect(disarmed).toEqual({ armed: false, enterpriseSlug: ENTERPRISE_SLUG, mode: 'live' });
    expect(await client.getWriteArmingState()).toEqual({ armed: false, enterpriseSlug: ENTERPRISE_SLUG, mode: 'live' });
  });
});
