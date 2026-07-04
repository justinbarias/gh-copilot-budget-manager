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
    expect(summary.totalQuantity).toBe(420 + 310 + 500 + 380 + 380);
    expect(summary.totalNetAmountUsd).toBeCloseTo(0 + 0 + 5.0 + 0 + 1.9, 5);
  });

  it('computes Overview burn-down inputs anchored to the fixture "current" date', async () => {
    const summary = await client.getUsageSummary();
    expect(summary.licenseCount).toBe(35);
    expect(summary.cycleAsOfDate).toBe('2026-06-14');
    // Cycle start (2026-06-01, day 0) through the anchor (2026-06-14, day 13) inclusive.
    expect(summary.dailyBurn).toHaveLength(14);
    expect(summary.dailyBurn[0]).toEqual({ date: '2026-06-01', cumulativePoolCredits: 0 });
    // Pool-covered credits only (discount_amount-derived): platform 420 + dataAnalytics 310
    // + the cap-bound cost center's fully-metered 500 (discount 0) contributes nothing.
    expect(summary.dailyBurn.at(-1)).toEqual({ date: '2026-06-14', cumulativePoolCredits: 420 + 310 });
    // The Aug31/Sep1 cliff edge-fixture rows fall outside this cycle window entirely.
    expect(summary.dailyBurn.some((p) => p.date === '2026-08-31' || p.date === '2026-09-01')).toBe(false);
  });

  it('filters usage by cost center', async () => {
    const summary = await client.getUsageSummary({ costCenterId: COST_CENTER_IDS.platform });
    expect(summary.totalQuantity).toBe(420 + 380 + 380);
  });

  it('returns an empty-but-valid summary when nothing matches the filter', async () => {
    const summary = await client.getUsageSummary({ costCenterId: 'cc-does-not-exist' });
    expect(summary.asOfDate).toBeNull();
    expect(summary.totalQuantity).toBe(0);
  });

  it('lists cost centers with member counts from the resource endpoint', async () => {
    const centers = await client.listCostCenters();
    const platform = centers.find((c) => c.id === COST_CENTER_IDS.platform);
    expect(platform?.memberCount).toBe(15);
    expect(centers).toHaveLength(3);
  });

  it('ranks heavy users by aggregated credits used, descending', async () => {
    const users = await client.listHeavyUsers();
    for (let i = 1; i < users.length; i++) {
      expect(users[i - 1]!.creditsUsed).toBeGreaterThanOrEqual(users[i]!.creditsUsed);
    }
    const user05 = users.find((u) => u.userLogin === 'user-05');
    expect(user05?.creditsUsed).toBe(380 + 380);
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
    // the fixture set (35 seats, 3 cost centers, their resource memberships).
    expect(db.select().from(costCenter).all()).toHaveLength(3);
    expect(db.select().from(license).all()).toHaveLength(35);
    expect(db.select().from(costCenterMember).all()).toHaveLength(15 + 10 + 10);

    // A second sync must not duplicate dimension rows.
    await client.syncNow();
    expect(db.select().from(costCenter).all()).toHaveLength(3);
    expect(db.select().from(license).all()).toHaveLength(35);
    expect(db.select().from(costCenterMember).all()).toHaveLength(15 + 10 + 10);
  });
});
