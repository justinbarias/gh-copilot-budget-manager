import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from './server';
import { API_VERSION, BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG, GITHUB_API_BASE } from './fixtures';
import { HISTORICAL_USAGE_ITEMS } from './fixtures/usage-history.js';

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

  // R3 (wire-contract-r3-r5-r6.md, live smoke 2026-07-08): GET .../resource
  // 404s live -- it never existed. Membership rides as an embedded
  // `resources[]` on the cost-center object itself, on BOTH the list handler
  // (this test) and the get-one handler (next test) -- same membership data,
  // new location.
  it('embeds membership resources on each cost center in the LIST response', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers`, {
      headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      costCenters: Array<{ id: string; resources: Array<{ type: string; name: string; via_ent_team?: string }> }>;
    };
    const workforce = body.costCenters.find((c) => c.id === COST_CENTER_IDS.workforce);
    expect(workforce?.resources).toHaveLength(24);
    // liam-obrien carries enterprise-team provenance (Task 2.3 drill-modal
    // badges); members without provenance omit the field entirely.
    expect(workforce?.resources[0]).toEqual({ type: 'User', name: 'liam-obrien', via_ent_team: 'payments-eng' });
    expect(workforce?.resources[3]).toEqual({ type: 'User', name: 'd-okafor' });
  });

  it('GETs a single cost center by id (get-one, a real endpoint), embedding the same resources[]', async () => {
    const res = await fetch(
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers/${COST_CENTER_IDS.workforce}`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      resources: Array<{ type: string; name: string }>;
    };
    expect(body.id).toBe(COST_CENTER_IDS.workforce);
    expect(body.resources).toHaveLength(24);
    expect(body.resources[0]).toMatchObject({ type: 'User', name: 'liam-obrien' });
  });

  it('404s a get-one for an unknown cost center id', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers/does-not-exist`, {
      headers,
    });
    expect(res.status).toBe(404);
  });

  // Real GitHub 404s this path (it never existed -- live smoke 2026-07-08).
  // The mock's handler for it is DELETED outright (not replaced with a 404
  // stub -- contract-file distinction from R6's bare users-28-day path,
  // which explicitly does get a 404 stub): this suite runs with
  // `onUnhandledRequest: 'error'`, so an unhandled request throws rather than
  // 404ing, proving no handler answers this path anymore.
  it('has no handler left for the disproven GET .../resource path (live smoke 2026-07-08: no such endpoint)', async () => {
    await expect(
      fetch(
        `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers/${COST_CENTER_IDS.workforce}/resource`,
        { headers },
      ),
    ).rejects.toThrow();
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

// R5 wire item: what the mock now emits on `.../settings/billing/usage`
// (wire-contract-r3-r5-r6.md). camelCase; no cost_center_id/user_login.
interface WireUsageItemShape {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  pricePerUnit: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  organizationName: string;
}

describe('usage reporting handler (R5: camelCase, projected, default-excludes-cost-center)', () => {
  it('emits camelCase fields and never emits cost_center_id/user_login/snake_case amounts on the wire', async () => {
    const res = await fetch(
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage?cost_center_id=${COST_CENTER_IDS.capBound}`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usageItems: WireUsageItemShape[] };
    expect(body.usageItems.length).toBeGreaterThan(0);
    for (const item of body.usageItems) {
      expect(item).toEqual(
        expect.objectContaining({
          date: expect.any(String),
          product: expect.any(String),
          sku: expect.any(String),
          quantity: expect.any(Number),
          unitType: expect.any(String),
          pricePerUnit: expect.any(Number),
          grossAmount: expect.any(Number),
          discountAmount: expect.any(Number),
          netAmount: expect.any(Number),
          organizationName: expect.any(String),
        }),
      );
      // Every key on the wire item is camelCase-shaped; none of the old
      // snake_case/internal-only fields leak through.
      expect(Object.keys(item)).not.toEqual(expect.arrayContaining(['cost_center_id', 'user_login', 'gross_amount', 'discount_amount', 'net_amount']));
    }
    // Edge fixture: cap-bound cost center's draw has already tipped into metered spend.
    expect(body.usageItems.some((item) => item.netAmount > 0)).toBe(true);
    // pricePerUnit is the domain-fixed $0.01/credit rate (CLAUDE.md §5), and
    // grossAmount reconciles with it for every row (quantity * 0.01).
    for (const item of body.usageItems) {
      expect(item.pricePerUnit).toBe(0.01);
      expect(item.grossAmount).toBeCloseTo(item.quantity * 0.01, 6);
    }
  });

  // Docs verbatim (wire-contract-r3-r5-r6.md's R5): "By default this endpoint
  // will return usage that does not have a cost center." Every DEWR fixture
  // row (usage.ts's USAGE_ITEMS) IS cost-center-attributed, so the honest,
  // correct default response here is an EMPTY page -- this is the behavior
  // change from the pre-fix "return everything" default.
  it('the default call (no cost_center_id param) returns ONLY cost-center-unassociated rows -- empty for this fixture set', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usageItems: unknown[] };
    expect(body.usageItems).toHaveLength(0);
  });

  // Regression guard for the money-critical current-cycle total (previously
  // asserted via one unfiltered call; now the correct live-shaped fetch is
  // one call per known cost-center id, attributed by which call returned the
  // item -- summed here to prove the reshape preserved every fixture value.
  // Hand-computed per-CC quantities (packages/data/src/msw/fixtures/usage.ts,
  // COST_CENTER_IDS): workforce 31,136 (incl. the two Aug/Sep cliff rows) +
  // employer 18,900 + capBound 58,300 (56,000 pool + 2,300 metered overflow)
  // + dataEval 57,400 + cyber 15,000 + corporate 12,300 = 193,036.
  it('per-cost-center calls sum to the pinned enterprise total quantity: 193,036 across all six CCs', async () => {
    const perCcExpected: Record<string, number> = {
      [COST_CENTER_IDS.workforce]: 31_136,
      [COST_CENTER_IDS.employer]: 18_900,
      [COST_CENTER_IDS.capBound]: 58_300,
      [COST_CENTER_IDS.dataEval]: 57_400,
      [COST_CENTER_IDS.cyber]: 15_000,
      [COST_CENTER_IDS.corporate]: 12_300,
    };
    let grandTotal = 0;
    for (const [ccId, expectedQuantity] of Object.entries(perCcExpected)) {
      const rows: WireUsageItemShape[] = [];
      for (let page = 1; ; page++) {
        const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage?cost_center_id=${ccId}&page=${page}&per_page=100`, {
          headers,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { usageItems: WireUsageItemShape[] };
        rows.push(...body.usageItems);
        if (!res.headers.get('link')?.includes('rel="next"')) break;
      }
      const total = rows.reduce((sum, row) => sum + row.quantity, 0);
      expect(total).toBe(expectedQuantity);
      grandTotal += total;
    }
    expect(grandTotal).toBe(193_036);
  });

  it('year/month query params additionally surface historical closed-cycle usage rows (still cost-center-filtered)', async () => {
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage`;
    const rows: Array<{ date: string; quantity: number }> = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${base}?year=2026&month=3&cost_center_id=${COST_CENTER_IDS.workforce}&page=${page}&per_page=100`, {
        headers,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { usageItems: Array<{ date: string; quantity: number }> };
      rows.push(...body.usageItems);
      if (!res.headers.get('link')?.includes('rel="next"')) break;
    }
    // Only March 2026 rows, only workforce's -- no April/May, no current-cycle June rows.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.date.startsWith('2026-03'))).toBe(true);
    expect(rows.length).toBe(
      HISTORICAL_USAGE_ITEMS.filter((item) => item.date.startsWith('2026-03') && item.cost_center_id === COST_CENTER_IDS.workforce).length,
    );

    // A year with no matching data returns an empty (not error) slice.
    const empty = await fetch(`${base}?year=2019&cost_center_id=${COST_CENTER_IDS.workforce}`, { headers });
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { usageItems: unknown[] };
    expect(emptyBody.usageItems).toHaveLength(0);
  });

  it('year/month/day narrows to a single historical day, still respecting cost_center_id', async () => {
    const base = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/usage`;
    const res = await fetch(`${base}?year=2026&month=3&day=2&cost_center_id=${COST_CENTER_IDS.workforce}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usageItems: Array<{ date: string }> };
    expect(body.usageItems.length).toBeGreaterThan(0);
    expect(body.usageItems.every((item) => item.date === '2026-03-02')).toBe(true);
    expect(body.usageItems.length).toBe(
      HISTORICAL_USAGE_ITEMS.filter((item) => item.date === '2026-03-02' && item.cost_center_id === COST_CENTER_IDS.workforce).length,
    );
  });
});

// R6 wire shapes: the two report endpoints return an async envelope, and the
// real per-user rows live in a file behind `download_links` served from a
// companion (non-GitHub) host (wire-contract-r3-r5-r6.md).
interface ReportEnvelope {
  download_links: string[];
  report_start_day: string;
  report_end_day: string;
}
interface UsersReportRecord {
  user_id: string;
  user_login: string;
  ai_credits_used: number;
  date?: string;
  model?: string;
}

async function followDownloadLink(envelope: ReportEnvelope): Promise<UsersReportRecord[]> {
  const link = envelope.download_links[0];
  expect(typeof link).toBe('string');
  const res = await fetch(link!, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as UsersReportRecord[];
}

describe('per-user metrics report handlers (R6: /latest suffix, download-link envelope)', () => {
  it('404s the OLD bare users-28-day path (live smoke 2026-07-08: missing /latest 404s live)', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-28-day`, { headers });
    expect(res.status).toBe(404);
  });

  it('users-28-day/latest returns a download-link envelope, and the file is a trailing-28-day per-user aggregate', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-28-day/latest`, {
      headers,
    });
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as ReportEnvelope;
    expect(Array.isArray(envelope.download_links)).toBe(true);
    expect(envelope.download_links.length).toBeGreaterThan(0);
    // SIM_CURRENT_DATE (the 'healthy' scenario's asOfDate) is 2026-06-14;
    // trailing 28 days inclusive = 2026-05-18 .. 2026-06-14.
    expect(envelope.report_start_day).toBe('2026-05-18');
    expect(envelope.report_end_day).toBe('2026-06-14');

    const records = await followDownloadLink(envelope);
    // Hand-computed trailing-28d per-user totals (May 18 - Jun 14 inclusive)
    // from usage.ts's CREDITS_USED_ITEMS + usage-history.ts's
    // HISTORICAL_CREDITS_USED_ITEMS, summed per user_login.
    const byLogin = new Map(records.map((r) => [r.user_login, r.ai_credits_used]));
    expect(byLogin.get('liam-obrien')).toBe(8_884);
    expect(byLogin.get('emily-zhao')).toBe(9_872);
    expect(byLogin.get('faisal-noor')).toBe(7_530);
    expect(byLogin.get('hannah-webb')).toBe(7_856);
    expect(byLogin.get('noah-tanaka')).toBe(3_126);
    expect(records.reduce((sum, r) => sum + r.ai_credits_used, 0)).toBe(132_598);
    // One row per user (a trailing aggregate, never a daily row) -- as many
    // records as distinct users active anywhere in the window.
    expect(records).toHaveLength(new Set(records.map((r) => r.user_login)).size);
  });

  it('users-1-day?day=<cycle day> returns a download-link envelope, and the file is exactly that day\'s rows', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day?day=2026-06-12`, {
      headers,
    });
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as ReportEnvelope;
    expect(envelope.report_start_day).toBe('2026-06-12');
    expect(envelope.report_end_day).toBe('2026-06-12');

    const records = await followDownloadLink(envelope);
    expect(records).toHaveLength(36);
    expect(records.reduce((sum, r) => sum + r.ai_credits_used, 0)).toBe(20_124);
    expect(records.every((r) => r.date === '2026-06-12')).toBe(true);
  });

  it('users-1-day for a historical (pre-cycle) day still resolves via HISTORICAL_CREDITS_USED_ITEMS', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day?day=2026-05-18`, {
      headers,
    });
    const envelope = (await res.json()) as ReportEnvelope;
    const records = await followDownloadLink(envelope);
    expect(records).toHaveLength(5);
    expect(records.reduce((sum, r) => sum + r.ai_credits_used, 0)).toBe(1_635);
  });

  it('users-1-day for a day with no fixture rows returns a 200 envelope whose file is an empty array (not a 404)', async () => {
    const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day?day=2026-06-14`, {
      headers,
    });
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as ReportEnvelope;
    const records = await followDownloadLink(envelope);
    expect(records).toEqual([]);
  });

  it('users-1-day with a missing or malformed day param 400s with a GitHub-shaped error body', async () => {
    const missing = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day`, { headers });
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as { message: string; documentation_url: string };
    expect(missingBody.documentation_url).toMatch(/^https:\/\/docs\.github\.com/);

    const malformed = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day?day=not-a-date`, {
      headers,
    });
    expect(malformed.status).toBe(400);

    const badCalendarDate = await fetch(
      `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day?day=2026-13-40`,
      { headers },
    );
    expect(badCalendarDate.status).toBe(400);
  });

  it('preserves the noah-tanaka promo->standard cliff datapoints (2026-08-31 / 2026-09-01), now reachable via users-1-day', async () => {
    for (const [day, expectedCredits] of [
      ['2026-08-31', 468],
      ['2026-09-01', 468],
    ] as const) {
      const res = await fetch(`${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/metrics/reports/users-1-day?day=${day}`, {
        headers,
      });
      const envelope = (await res.json()) as ReportEnvelope;
      const records = await followDownloadLink(envelope);
      const noah = records.find((r) => r.user_login === 'noah-tanaka');
      expect(noah).toBeDefined();
      expect(noah!.ai_credits_used).toBe(expectedCredits);
    }
  });
});
