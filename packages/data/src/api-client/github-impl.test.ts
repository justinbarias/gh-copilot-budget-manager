import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG } from '../msw/fixtures/index.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { costCenter, costCenterMember, license } from '../db/schema.js';
import { createGitHubApiClient, type GitHubApiClientConfig } from './github-impl.js';

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

  it('aggregates usage across the whole fixture set', async () => {
    const summary = await client.getUsageSummary();
    expect(summary.asOfDate).toBe('2026-09-01');
    expect(summary.totalQuantity).toBe(193_036);
    // Metered spend: the cap-bound CC's 2,300-credit overflow ($23.00) + the
    // Sep-1 cliff row's metered half ($2.34).
    expect(summary.totalNetAmountUsd).toBeCloseTo(23.0 + 2.34, 5);
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
    // Workforce's June pool rows (30,200) + noah-tanaka's Aug31/Sep1 cliff rows (468 + 468).
    expect(summary.totalQuantity).toBe(30_200 + 468 + 468);
  });

  it('returns an empty-but-valid summary when nothing matches the filter', async () => {
    const summary = await client.getUsageSummary({ costCenterId: 'cc-does-not-exist' });
    expect(summary.asOfDate).toBeNull();
    expect(summary.totalQuantity).toBe(0);
  });

  it('lists cost centers with member counts from the resource endpoint', async () => {
    const centers = await client.listCostCenters();
    const workforce = centers.find((c) => c.id === COST_CENTER_IDS.workforce);
    expect(workforce?.memberCount).toBe(24);
    expect(centers).toHaveLength(6);
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
