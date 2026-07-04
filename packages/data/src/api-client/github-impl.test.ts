import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG } from '../msw/fixtures/index.js';
import { createGitHubApiClient } from './github-impl.js';

// One mock, three consumers (CLAUDE.md §7): this test drives the same MSW
// server that simulation mode and Playwright e2e attach — never a fixture
// import, so a broken handler here would also break the running app.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('createGitHubApiClient', () => {
  const client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG });

  it('aggregates usage across the whole fixture set', async () => {
    const summary = await client.getUsageSummary();
    expect(summary.asOfDate).toBe('2026-09-01');
    expect(summary.totalQuantity).toBe(420 + 310 + 500 + 380 + 380);
    expect(summary.totalNetAmountUsd).toBeCloseTo(0 + 0 + 5.0 + 0 + 1.9, 5);
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

  it('tracks sync status across a syncNow call', async () => {
    expect((await client.getSyncStatus()).lastSyncedAt).toBeNull();
    const result = await client.syncNow();
    expect(result.inProgress).toBe(false);
    expect(result.lastSyncedAt).not.toBeNull();
    expect((await client.getSyncStatus()).lastSyncedAt).toBe(result.lastSyncedAt);
  });
});
