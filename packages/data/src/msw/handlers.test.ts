import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from './server';
import { API_VERSION, BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG, GITHUB_API_BASE } from './fixtures';

const headers = {
  Authorization: 'Bearer fake-pat-for-tests',
  'X-GitHub-Api-Version': API_VERSION,
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('licenses/seats handler', () => {
  const url = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/billing/seats`;

  it('honors page/per_page and emits a realistic Link header across pages', async () => {
    const page1 = await fetch(`${url}?page=1&per_page=30`, { headers });
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as { total_seats: number; seats: Array<{ assignee: { login: string } }> };
    expect(body1.total_seats).toBe(35);
    expect(body1.seats).toHaveLength(30);
    expect(page1.headers.get('link')).toContain('rel="next"');
    expect(page1.headers.get('link')).toContain('rel="last"');

    const page2 = await fetch(`${url}?page=2&per_page=30`, { headers });
    const body2 = (await page2.json()) as { seats: Array<{ assignee: { login: string } }> };
    expect(body2.seats).toHaveLength(5);
    expect(page2.headers.get('link')).not.toContain('rel="next"');
    expect(body2.seats[0]?.assignee.login).not.toBe(body1.seats[0]?.assignee.login);
  });
});

describe('cost centers handler', () => {
  it('lists cost centers, including the cap-bound edge fixture', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers`, {
      headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { costCenters: Array<{ id: string }> };
    expect(body.costCenters.map((c) => c.id)).toContain(COST_CENTER_IDS.capBound);
  });

  it('lists membership resources for a specific cost center', async () => {
    const res = await fetch(
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers/${COST_CENTER_IDS.platform}/resource`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Array<{ type: string; name: string; via_ent_team?: string }> };
    expect(body.resources).toHaveLength(15);
    // user-01 carries enterprise-team provenance (Task 2.3 drill-modal badges);
    // members without provenance omit the field entirely.
    expect(body.resources[0]).toEqual({ type: 'User', name: 'user-01', via_ent_team: 'payments' });
    expect(body.resources[3]).toEqual({ type: 'User', name: 'user-04' });
  });
});

describe('budgets handler', () => {
  it('lists every budget, including all required edge fixtures', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/budgets`, {
      headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budgets: Array<{ id: string; budget_amount: number }> };
    const ids = body.budgets.map((b) => b.id);
    expect(ids).toContain(BUDGET_IDS.ulbDisplayBug);
    expect(ids).toContain(BUDGET_IDS.zeroUlb);
    expect(ids).toContain(BUDGET_IDS.cculbPlatform);

    const zeroUlb = body.budgets.find((b) => b.id === BUDGET_IDS.zeroUlb);
    expect(zeroUlb?.budget_amount).toBe(0);
  });
});

describe('usage/cost reporting handlers', () => {
  it('lists usage items and supports filtering by cost_center_id', async () => {
    const all = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage`, { headers });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { usageItems: Array<{ cost_center_id: string | null; net_amount: number }> };
    expect(allBody.usageItems.length).toBeGreaterThan(0);

    const filtered = await fetch(
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage?cost_center_id=${COST_CENTER_IDS.capBound}`,
      { headers },
    );
    const filteredBody = (await filtered.json()) as { usageItems: Array<{ cost_center_id: string | null; net_amount: number }> };
    expect(filteredBody.usageItems.length).toBeGreaterThan(0);
    expect(filteredBody.usageItems.every((item) => item.cost_center_id === COST_CENTER_IDS.capBound)).toBe(true);
    // Edge fixture: cap-bound cost center's draw has already tipped into metered spend.
    expect(filteredBody.usageItems.some((item) => item.net_amount > 0)).toBe(true);
  });

  it('reports promo -> standard cliff datapoints spanning 1 Sep 2026', async () => {
    const res = await fetch(
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-28-day`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: string; user_login: string; ai_credits_used: number }>;
    const cliffDates = body.filter((row) => row.user_login === 'user-05').map((row) => row.date);
    expect(cliffDates).toEqual(expect.arrayContaining(['2026-08-31', '2026-09-01']));
  });
});
