import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from './server';
import { API_VERSION, BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG, GITHUB_API_BASE } from './fixtures';
import { HISTORICAL_CREDITS_USED_ITEMS, HISTORICAL_USAGE_ITEMS } from './fixtures/usage-history.js';

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
    expect(body1.total_seats).toBe(81);
    expect(body1.seats).toHaveLength(30);
    expect(page1.headers.get('link')).toContain('rel="next"');
    expect(page1.headers.get('link')).toContain('rel="last"');

    // 81 seats at 30/page -> 30 + 30 + 21; the final page has no rel="next".
    const page3 = await fetch(`${url}?page=3&per_page=30`, { headers });
    const body3 = (await page3.json()) as { seats: Array<{ assignee: { login: string } }> };
    expect(body3.seats).toHaveLength(21);
    expect(page3.headers.get('link')).not.toContain('rel="next"');
    expect(body3.seats[0]?.assignee.login).not.toBe(body1.seats[0]?.assignee.login);
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
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers/${COST_CENTER_IDS.workforce}/resource`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Array<{ type: string; name: string; via_ent_team?: string }> };
    expect(body.resources).toHaveLength(24);
    // liam-obrien carries enterprise-team provenance (Task 2.3 drill-modal
    // badges); members without provenance omit the field entirely.
    expect(body.resources[0]).toEqual({ type: 'User', name: 'liam-obrien', via_ent_team: 'payments-eng' });
    expect(body.resources[3]).toEqual({ type: 'User', name: 'd-okafor' });
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
    // The per-user report now carries ~150 rows, so it paginates -- walk every
    // page (the cliff edge-fixture rows sort at the very end of the fixture).
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-28-day`;
    const rows: Array<{ date: string; user_login: string; ai_credits_used: number }> = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${base}?page=${page}&per_page=100`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ date: string; user_login: string; ai_credits_used: number }>;
      rows.push(...body);
      if (!res.headers.get('link')?.includes('rel="next"')) break;
    }
    const cliffDates = rows.filter((row) => row.user_login === 'noah-tanaka').map((row) => row.date);
    expect(cliffDates).toEqual(expect.arrayContaining(['2026-08-31', '2026-09-01']));
  });

  // Task 5.1: the default (no year/since/until) response must stay byte-
  // identical to before the historical fixtures existed -- this is the
  // additive-only proof at the handler layer, independent of the fixture-
  // shape tests in fixtures/usage-history.test.ts and the full-ApiClient
  // pins in api-client/github-impl.test.ts.
  it('keeps the default (no date filter) usage response unchanged: 193,036 total quantity across all rows', async () => {
    const rows: Array<{ date: string; quantity: number }> = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage?page=${page}&per_page=100`, {
        headers,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { usageItems: Array<{ date: string; quantity: number }> };
      rows.push(...body.usageItems);
      if (!res.headers.get('link')?.includes('rel="next"')) break;
    }
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(193_036);
    expect(rows.some((row) => row.date.startsWith('2026-03'))).toBe(false);
  });

  it('keeps the default (no since/until) users-28-day response unchanged: 149 rows, 115,216 credits', async () => {
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-28-day`;
    const rows: Array<{ date: string; ai_credits_used: number }> = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${base}?page=${page}&per_page=100`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ date: string; ai_credits_used: number }>;
      rows.push(...body);
      if (!res.headers.get('link')?.includes('rel="next"')) break;
    }
    expect(rows).toHaveLength(149);
    expect(rows.reduce((sum, row) => sum + row.ai_credits_used, 0)).toBe(115_216);
    expect(rows.some((row) => row.date.startsWith('2026-04'))).toBe(false);
  });

  it('year/month query params additionally surface historical closed-cycle usage rows', async () => {
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage`;
    const rows: Array<{ date: string; cost_center_id: string | null; quantity: number }> = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${base}?year=2026&month=3&page=${page}&per_page=100`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { usageItems: Array<{ date: string; cost_center_id: string | null; quantity: number }> };
      rows.push(...body.usageItems);
      if (!res.headers.get('link')?.includes('rel="next"')) break;
    }
    // Only March 2026 rows -- no April/May, no current-cycle June rows.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.date.startsWith('2026-03'))).toBe(true);
    expect(
      rows.length ===
        HISTORICAL_USAGE_ITEMS.filter((item) => item.date.startsWith('2026-03')).length,
    ).toBe(true);

    // A year with no matching data returns an empty (not error) slice.
    const empty = await fetch(`${base}?year=2019`, { headers });
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { usageItems: unknown[] };
    expect(emptyBody.usageItems).toHaveLength(0);
  });

  it('year/month/day narrows to a single historical day, still respecting cost_center_id', async () => {
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage`;
    const res = await fetch(`${base}?year=2026&month=3&day=2&cost_center_id=${COST_CENTER_IDS.workforce}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usageItems: Array<{ date: string; cost_center_id: string | null }> };
    expect(body.usageItems.length).toBeGreaterThan(0);
    expect(body.usageItems.every((item) => item.date === '2026-03-02')).toBe(true);
    expect(body.usageItems.every((item) => item.cost_center_id === COST_CENTER_IDS.workforce)).toBe(true);
  });

  it('since/until additionally surface historical per-user credits-used rows', async () => {
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-28-day`;
    const rows: Array<{ date: string; user_login: string; ai_credits_used: number }> = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${base}?since=2026-03-01&until=2026-03-31&page=${page}&per_page=100`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ date: string; user_login: string; ai_credits_used: number }>;
      rows.push(...body);
      if (!res.headers.get('link')?.includes('rel="next"')) break;
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.date >= '2026-03-01' && row.date <= '2026-03-31')).toBe(true);
    expect(rows.some((row) => row.user_login === 'emily-zhao')).toBe(true);
    expect(rows.length).toBe(HISTORICAL_CREDITS_USED_ITEMS.filter((item) => item.date.startsWith('2026-03')).length);
  });
});
