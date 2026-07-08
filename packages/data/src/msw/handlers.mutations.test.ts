import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from './server';
import { API_VERSION, BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG, GITHUB_API_BASE } from './fixtures';

// Sibling to handlers.test.ts (per Task 4.1/4.2's Method section: "match repo
// conventions" -- kept separate rather than growing the read-handler file,
// since this suite covers ~two dozen mutation-contract cases across budgets
// and cost centers/resources/the included-usage cap).

const headers = {
  Authorization: 'Bearer fake-pat-for-tests',
  'X-GitHub-Api-Version': API_VERSION,
  'Content-Type': 'application/json',
};

const BUDGETS_URL = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/budgets`;
const COST_CENTERS_URL = `${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers`;

// Domain fact (CLAUDE.md §5 / PRD §1.3): GitHub auto-computes the included-usage
// cap from attributed licenses, ~7,000 promo credits/seat for Enterprise. Used
// here only to assert the handler's *observable output*, not its internals.
const PROMO_CREDITS_PER_SEAT = 7_000;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function validBudgetPayload(overrides: Record<string, unknown> = {}) {
  return {
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    // Wire spelling for an individual ULB (machine-verified, wire-contract-
    // writes.md §1): scope 'user' + the `user` login field.
    budget_scope: 'user',
    budget_entity_name: 'user-99',
    user: 'user-99',
    budget_amount: 100,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['finops@dewr.gov.au'] },
    ...overrides,
  };
}

// Machine-verified success envelope (wire-contract-writes.md §2):
// POST/PATCH -> 200 {message, budget}; DELETE -> 200 {message, id}.
interface BudgetEnvelope {
  message: string;
  budget: Record<string, unknown>;
}

describe('Task 4.1 -- budget mutations: create (POST)', () => {
  // The REAL seven-value budget_scope enum (machine-verified). The 'user'
  // case additionally carries the `user` login field.
  const scopeCases: Array<{ scope: string; entity: string; user?: string }> = [
    { scope: 'enterprise', entity: ENTERPRISE_SLUG },
    { scope: 'organization', entity: 'dewr-digital' },
    { scope: 'repository', entity: 'dewr-digital/wfa-portal' },
    { scope: 'cost_center', entity: 'Workforce Australia Platform' },
    { scope: 'multi_user_customer', entity: ENTERPRISE_SLUG },
    { scope: 'multi_user_cost_center', entity: 'Workforce Australia Platform' },
    { scope: 'user', entity: 'user-99', user: 'user-99' },
  ];

  it.each(scopeCases)('creates a $scope budget: 200 {message, budget} envelope + deterministic id', async ({ scope, entity, user }) => {
    const payload = validBudgetPayload({
      budget_scope: scope,
      budget_entity_name: entity,
      ...(user ? { user } : { user: undefined }),
    });
    if (!user) delete (payload as Record<string, unknown>).user;
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(200); // machine-verified: the status list has NO 201
    const body = (await res.json()) as BudgetEnvelope;
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.budget).toMatchObject(payload);
    expect(typeof body.budget.id).toBe('string');
    expect((body.budget.id as string).length).toBeGreaterThan(0);

    // Determinism: identical payload -> identical envelope (id derived from
    // the payload, never Math.random/a counter -- Architecture Decisions).
    const res2 = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    const body2 = await res2.json();
    expect(body2).toEqual(body);
  });

  it('a scope-user create echoes the user login field on the budget object', async () => {
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(validBudgetPayload()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BudgetEnvelope;
    expect(body.budget.user).toBe('user-99');
    expect(body.budget.budget_scope).toBe('user');
  });

  it('rejects a scope-user create without the user login field (422, field: user)', async () => {
    const payload = validBudgetPayload();
    delete (payload as Record<string, unknown>).user;
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ field: string }> };
    expect(body.errors.some((e) => e.field === 'user')).toBe(true);
  });

  it('accepts a $0 budget amount -- the trap; the real API allows it and so must this mock', async () => {
    const payload = validBudgetPayload({ budget_entity_name: 'user-98', user: 'user-98', budget_amount: 0, budget_alerting: { will_alert: false, alert_recipients: [] } });
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BudgetEnvelope;
    expect(body.budget.budget_amount).toBe(0);
  });

  it('matches the PRD §2.1 CCULB (multi_user_cost_center) example payload shape verbatim', async () => {
    const payload = {
      budget_amount: 52,
      prevent_further_usage: true,
      budget_scope: 'multi_user_cost_center',
      budget_entity_name: 'Workforce Australia Platform',
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_alerting: { will_alert: true, alert_recipients: ['wfa-leads@dewr.gov.au'] },
    };
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BudgetEnvelope;
    expect(body.budget).toMatchObject(payload);
  });

  it('rejects an invalid budget_scope with a GitHub-shaped 422', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_scope: 'bogus-scope' })),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { message: string; documentation_url: string; errors: unknown[] };
    expect(body.message).toBe('Validation Failed');
    expect(body.documentation_url).toMatch(/^https:\/\/docs\.github\.com/);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // Drift guard: our old INTERNAL spellings are not wire values -- any impl
  // callsite still serializing the internal model onto the wire fails here.
  it.each(['universal', 'individual'])('rejects the internal-only scope spelling %s (never a wire value)', async (scope) => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_scope: scope })),
    });
    expect(res.status).toBe(422);
  });

  it('rejects a negative budget_amount', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_amount: -5 })),
    });
    expect(res.status).toBe(422);
  });

  // LIVE-PINNED pairing matrix (maintainer's R4 sampler, 2026-07-09):
  // ai_credits <=> BundlePricing always -- ProductPricing+ai_credits (the
  // old engine serialization) must never reach the wire again.
  it('accepts BundlePricing + ai_credits (the live-pinned AI-credit pairing)', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_type: 'BundlePricing', budget_product_sku: 'ai_credits' })),
    });
    expect(res.status).toBe(200);
  });

  it('rejects ProductPricing + ai_credits with a GitHub-shaped 422 (the pairing drift-guard)', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_type: 'ProductPricing', budget_product_sku: 'ai_credits' })),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { message: string; errors: Array<{ field: string }> };
    expect(body.message).toBe('Validation Failed');
    expect(body.errors.some((e) => e.field === 'budget_type')).toBe(true);
  });

  it('rejects SkuPricing + ai_credits too (only BundlePricing pairs with ai_credits)', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_type: 'SkuPricing', budget_product_sku: 'ai_credits' })),
    });
    expect(res.status).toBe(422);
  });

  it('accepts ProductPricing + a product sku (actions) -- non-AI pairings stay validation-light', async () => {
    const payload = validBudgetPayload({
      budget_type: 'ProductPricing',
      budget_product_sku: 'actions',
      budget_scope: 'enterprise',
      budget_entity_name: ENTERPRISE_SLUG,
    });
    delete (payload as Record<string, unknown>).user;
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budget: { budget_type: string; budget_product_sku: string } };
    expect(body.budget).toMatchObject({ budget_type: 'ProductPricing', budget_product_sku: 'actions' });
  });

  it('rejects a fractional budget_amount (machine-verified: integer, whole dollars)', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ budget_amount: 12.5 })),
    });
    expect(res.status).toBe(422);
  });

  it('rejects a payload missing required fields', async () => {
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify({ budget_scope: 'enterprise' }) });
    expect(res.status).toBe(422);
  });

  it('rejects malformed JSON with a 400 ("Problems parsing JSON")', async () => {
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: '{not-json' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Problems parsing JSON');
  });

  it('rejects an unexpected top-level field on create (e.g. a client-supplied id)', async () => {
    const res = await fetch(BUDGETS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBudgetPayload({ id: 'client-supplied-id' })),
    });
    expect(res.status).toBe(422);
  });
});

describe('Task 4.1 -- budget mutations: read/update/delete by id', () => {
  it('GETs the display-bug fixture budget by id -- present in the API despite the UI bug', async () => {
    const res = await fetch(`${BUDGETS_URL}/${BUDGET_IDS.ulbDisplayBug}`, { headers });
    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string }).toMatchObject({ id: BUDGET_IDS.ulbDisplayBug });
  });

  it('404s a GET for an unknown budget id', async () => {
    const res = await fetch(`${BUDGETS_URL}/does-not-exist`, { headers });
    expect(res.status).toBe(404);
  });

  it.each([
    BUDGET_IDS.universal,
    BUDGET_IDS.ulbDisplayBug,
    BUDGET_IDS.zeroUlb,
    BUDGET_IDS.cculbPlatform,
    BUDGET_IDS.enterpriseMetered,
    BUDGET_IDS.organizationMetered,
    BUDGET_IDS.costCenterMetered,
  ])(
    // Covers all five budget_scope families (enterprise, organization,
    // cost_center, user-level multi_user_customer/user, multi_user_cost_center/
    // CCULB) -- the PATCH handler is generic-by-id, but the acceptance
    // criterion is explicit ("All five scopes create/update/delete"), so every
    // canonical scope gets its own assertion rather than relying on genericity
    // as implicit proof. Machine-verified envelope: PATCH -> 200 {message, budget}.
    'PATCHes %s across every budget_scope incl. the display-bug/$0 edge fixtures and the API-only CCULB',
    async (id) => {
      const res = await fetch(`${BUDGETS_URL}/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ budget_amount: 250 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { message: string; budget: { budget_amount: number; id: string } };
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
      expect(body.budget.budget_amount).toBe(250);
      expect(body.budget.id).toBe(id);
    },
  );

  it('rejects a PATCH containing a non-patchable field (e.g. budget_scope)', async () => {
    const res = await fetch(`${BUDGETS_URL}/${BUDGET_IDS.zeroUlb}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ budget_scope: 'enterprise' }),
    });
    expect(res.status).toBe(422);
  });

  it('404s a PATCH for an unknown budget id', async () => {
    const res = await fetch(`${BUDGETS_URL}/does-not-exist`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ budget_amount: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it.each([
    BUDGET_IDS.universal,
    BUDGET_IDS.ulbDisplayBug,
    BUDGET_IDS.zeroUlb,
    BUDGET_IDS.cculbPlatform,
    BUDGET_IDS.enterpriseMetered,
    BUDGET_IDS.organizationMetered,
    BUDGET_IDS.costCenterMetered,
  ])(
    // Same "all five scopes" acceptance criterion as the PATCH suite above,
    // covering DELETE too (edge fixtures + the API-only CCULB are mutable
    // via API despite the display-bug/UI omission). Machine-verified
    // envelope: DELETE -> 200 {message, id} -- the status list has NO 204.
    'DELETEs %s across every budget_scope with 200 {message, id}',
    async (id) => {
      const res = await fetch(`${BUDGETS_URL}/${id}`, { method: 'DELETE', headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { message: string; id: string };
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
      expect(body.id).toBe(id);
    },
  );

  it('404s a DELETE for an unknown budget id', async () => {
    const res = await fetch(`${BUDGETS_URL}/does-not-exist`, { method: 'DELETE', headers });
    expect(res.status).toBe(404);
  });

  // PRODUCT-dimension pollution budgets mutate like any other budget -- no
  // special-casing anywhere in the handlers (real GitHub serves all products
  // through the same CRUD surface; only the impl's control-family filter
  // treats ai_credits specially, and that lives client-side).
  it('PATCHes a non-AI-credit pollution budget (Actions product) like any other: 200 {message, budget}', async () => {
    const res = await fetch(`${BUDGETS_URL}/${BUDGET_IDS.actionsProductBudget}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ budget_amount: 1750 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; budget: { id: string; budget_amount: number; budget_product_sku: string } };
    expect(body.budget.id).toBe(BUDGET_IDS.actionsProductBudget);
    expect(body.budget.budget_amount).toBe(1750);
    expect(body.budget.budget_product_sku).toBe('actions');
  });

  it('creates a non-AI-credit budget (SkuPricing / actions_linux) -- the validator must not reject non-ai_credits skus', async () => {
    const payload = validBudgetPayload({
      budget_type: 'SkuPricing',
      budget_product_sku: 'actions_linux',
      budget_scope: 'enterprise',
      budget_entity_name: ENTERPRISE_SLUG,
      user: undefined,
    });
    delete (payload as Record<string, unknown>).user;
    const res = await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budget: { budget_product_sku: string; budget_type: string } };
    expect(body.budget.budget_product_sku).toBe('actions_linux');
    expect(body.budget.budget_type).toBe('SkuPricing');
  });
});

describe('Task 4.1 -- budget mutations: statelessness', () => {
  it('a PATCH never mutates the canonical fixture the GET/list handlers see', async () => {
    const before = (await (await fetch(`${BUDGETS_URL}/${BUDGET_IDS.zeroUlb}`, { headers })).json()) as { budget_amount: number };
    expect(before.budget_amount).toBe(0);

    const patched = (await (
      await fetch(`${BUDGETS_URL}/${BUDGET_IDS.zeroUlb}`, { method: 'PATCH', headers, body: JSON.stringify({ budget_amount: 999 }) })
    ).json()) as { budget: { budget_amount: number } };
    expect(patched.budget.budget_amount).toBe(999);

    // Interleaved read immediately after: canonical fixture is untouched.
    const after = (await (await fetch(`${BUDGETS_URL}/${BUDGET_IDS.zeroUlb}`, { headers })).json()) as { budget_amount: number };
    expect(after.budget_amount).toBe(0);

    const list = (await (await fetch(BUDGETS_URL, { headers })).json()) as { budgets: Array<{ id: string; budget_amount: number }> };
    expect(list.budgets.find((b) => b.id === BUDGET_IDS.zeroUlb)?.budget_amount).toBe(0);
  });

  it('running the identical create mutation twice yields byte-identical responses', async () => {
    const payload = validBudgetPayload({ budget_entity_name: 'user-95', user: 'user-95', budget_amount: 50 });
    const first = await (await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) })).json();
    const second = await (await fetch(BUDGETS_URL, { method: 'POST', headers, body: JSON.stringify(payload) })).json();
    expect(second).toEqual(first);
  });
});

describe('Task 4.2 -- cost center mutations: create (POST)', () => {
  it('creates a cost center with default (disabled) cap state when none is supplied', async () => {
    const res = await fetch(COST_CENTERS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'New Squad', dewr_division: 'Digital & Technology Group' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; state: string; included_usage_cap: unknown; id: string };
    expect(body.name).toBe('New Squad');
    expect(body.state).toBe('active');
    expect(body.included_usage_cap).toEqual({ enabled: false, overflow: 'block', computed_limit_credits: 0 });
    expect(typeof body.id).toBe('string');
  });

  it('creates with an initial cap + resources, computing the limit from attributed seats (2 x 7,000)', async () => {
    const res = await fetch(COST_CENTERS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Seeded Squad',
        included_usage_cap: { enabled: true, overflow: 'metered' },
        resources: [
          { type: 'User', name: 'user-90' },
          { type: 'User', name: 'user-91' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { included_usage_cap: { enabled: boolean; overflow: string; computed_limit_credits: number } };
    expect(body.included_usage_cap).toEqual({ enabled: true, overflow: 'metered', computed_limit_credits: 2 * PROMO_CREDITS_PER_SEAT });
  });

  // Machine-verified (wire-contract-writes.md §4): cost-center mutations have
  // NO 422 in their OpenAPI status lists -- validation failures are 400.
  it('rejects any attempt to set a cap amount at create time (400)', async () => {
    const res = await fetch(COST_CENTERS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Sneaky Squad',
        included_usage_cap: { enabled: true, overflow: 'block', computed_limit_credits: 999_999 },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ field: string }> };
    expect(body.errors.some((e) => e.field.includes('included_usage_cap'))).toBe(true);
  });

  it('rejects a create payload missing a name (400)', async () => {
    const res = await fetch(COST_CENTERS_URL, { method: 'POST', headers, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown top-level field on create (400)', async () => {
    const res = await fetch(COST_CENTERS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'x', computed_limit_credits: 5000 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Task 4.2 -- cost center mutations: delete', () => {
  it('deletes a known cost center with 204', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.dataEval}`, { method: 'DELETE', headers });
    expect(res.status).toBe(204);
  });

  it('404s deleting an unknown cost center', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/does-not-exist`, { method: 'DELETE', headers });
    expect(res.status).toBe(404);
  });
});

describe('Task 4.2 -- cost center mutations: edit (PATCH) / cap toggle (wire body: ai_credit_pool_enabled)', () => {
  // LIVE-PINNED (2026-07-09 R2 cap dump + machine-verified schema): the cap
  // toggle's PATCH request body is the FLAT {ai_credit_pool_enabled: bool};
  // no overflow field exists anywhere on the wire. The RESPONSE echo stays in
  // the internal included_usage_cap dialect (dual-dialect read arrangement --
  // the sim what-if overflow knob still reads it; impl's
  // normalizeIncludedUsageCap maps it).
  it('accepts {ai_credit_pool_enabled: false}, echoing enabled=false with overflow retained and the limit recomputed from canonical membership', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ai_credit_pool_enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { included_usage_cap: { enabled: boolean; overflow: string; computed_limit_credits: number } };
    expect(body.included_usage_cap.enabled).toBe(false);
    expect(body.included_usage_cap.overflow).toBe('block'); // no wire field exists -> always retains canonical fixture value
    expect(body.included_usage_cap.computed_limit_credits).toBe(24 * PROMO_CREDITS_PER_SEAT);
  });

  it('accepts {ai_credit_pool_enabled: true} alongside other editable fields', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Workforce Australia Platform (renamed)', ai_credit_pool_enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; included_usage_cap: { enabled: boolean } };
    expect(body.name).toBe('Workforce Australia Platform (renamed)');
    expect(body.included_usage_cap.enabled).toBe(true);
  });

  it('rejects the OLD nested included_usage_cap shape loudly (400) -- any missed impl callsite must surface', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ included_usage_cap: { enabled: false } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an overflow key in the PATCH body (400) -- machine-verified: no overflow field exists on the wire', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ai_credit_pool_enabled: true, overflow: 'metered' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean ai_credit_pool_enabled (400)', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ai_credit_pool_enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects any attempt to set a cap amount on edit, under any guessed field name (400 -- §4 status-list ruling)', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ included_usage_cap: { overflow: 'metered', amount: 50_000 } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown top-level field on edit (400)', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ mtd_burn_credits: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('404s editing an unknown cost center', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/does-not-exist`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(404);
  });
});

// Machine-verified /resource wire (wire-contract-writes.md §3): four-array
// request body {users, organizations, repositories, enterprise_teams}
// (minProperties 1); add -> 200 {message, reassigned_resources|null},
// remove -> 200 {message}. `simulated_included_usage_cap` is the mock's
// SIM-ONLY enrichment preserving Task 4.2's recomputed-limit observability
// (see the handler comment; validator to ratify).
describe('Task 4.2 -- cost center mutations: membership (resource add/remove)', () => {
  interface ResourceAddResponse {
    message: string;
    reassigned_resources: Array<{ resource_type: string; name: string; previous_cost_center: string }> | null;
    simulated_included_usage_cap: { enabled: boolean; overflow: string; computed_limit_credits: number };
  }

  it('adds 2 users to the 9-seat Data & Evaluation Platform CC: 200 {message, reassigned_resources: null} + recomputed sim limit for 11 seats', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.dataEval}/resource`, {
      method: 'POST',
      headers,
      // tess-whitford / jordan-mackay belong to NO fixture cost center, so
      // nothing is reassigned -- machine-verified null, not [].
      body: JSON.stringify({ users: ['tess-whitford', 'jordan-mackay'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourceAddResponse;
    expect(typeof body.message).toBe('string');
    expect(body.reassigned_resources).toBeNull();
    expect(body.simulated_included_usage_cap.computed_limit_credits).toBe(11 * PROMO_CREDITS_PER_SEAT);
  });

  it('reports a genuine cross-cost-center move in reassigned_resources (raymond-li: Data & Evaluation -> Workforce)', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ users: ['raymond-li'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourceAddResponse;
    expect(body.reassigned_resources).toEqual([
      { resource_type: 'User', name: 'raymond-li', previous_cost_center: COST_CENTER_IDS.dataEval },
    ]);
  });

  it('supports adding an enterprise-team resource via the enterprise_teams array', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enterprise_teams: ['design-guild'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourceAddResponse;
    expect(body.reassigned_resources).toBeNull();
    // design-guild is not in ENTERPRISE_TEAM_SEAT_COUNTS -> the 1-seat
    // default on top of Workforce's canonical 24 seats.
    expect(body.simulated_included_usage_cap.computed_limit_credits).toBe(25 * PROMO_CREDITS_PER_SEAT);
  });

  it('removes a user: 200 {message} WITHOUT reassigned_resources, sim limit recomputed downward', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.dataEval}/resource`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ users: ['raymond-li'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.message).toBe('string');
    // Machine-verified: the remove envelope carries NO reassigned_resources key.
    expect('reassigned_resources' in body).toBe(false);
    expect((body.simulated_included_usage_cap as { computed_limit_credits: number }).computed_limit_credits).toBe(
      8 * PROMO_CREDITS_PER_SEAT,
    );
  });

  it('404s adding a resource to an unknown cost center', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/does-not-exist/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ users: ['user-01'] }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects the OLD invented {resources: [{type, name}]} body shape loudly (400) -- any missed impl callsite must surface', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}/resource`, {
        method,
        headers,
        body: JSON.stringify({ resources: [{ type: 'User', name: 'x' }] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects an empty body object (machine-verified minProperties: 1) with 400', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a body whose present arrays are all empty (400)', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ users: [], enterprise_teams: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-string array entries (400)', async () => {
    const res = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.workforce}/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ users: [42] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Task 4.2 -- cost center mutations: statelessness', () => {
  it('adding members does not change what the canonical GET handlers report afterward', async () => {
    await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.dataEval}/resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ users: ['tess-whitford'] }),
    });

    // R3: membership now rides embedded on the cost-center object (list AND
    // get-one) -- there is no separate GET .../resource endpoint anymore.
    const getOneRes = await fetch(`${COST_CENTERS_URL}/${COST_CENTER_IDS.dataEval}`, { headers });
    const getOneBody = (await getOneRes.json()) as { resources: unknown[] };
    expect(getOneBody.resources).toHaveLength(9); // canonical fixture count, unchanged

    const centersBody = (await (await fetch(COST_CENTERS_URL, { headers })).json()) as {
      costCenters: Array<{ id: string; resources: unknown[]; included_usage_cap: { computed_limit_credits: number } }>;
    };
    const dataEval = centersBody.costCenters.find((c) => c.id === COST_CENTER_IDS.dataEval);
    expect(dataEval?.resources).toHaveLength(9); // canonical fixture count, unchanged
    expect(dataEval?.included_usage_cap.computed_limit_credits).toBe(63_000); // untouched canonical value
  });

  it('consistency pin: licensedSeatCount x 7,000 reproduces every committed computed_limit_credits at zero delta', async () => {
    const centersBody = (await (await fetch(COST_CENTERS_URL, { headers })).json()) as {
      costCenters: Array<{ id: string; included_usage_cap: { overflow: 'block' | 'metered'; computed_limit_credits: number } }>;
    };
    // All six DEWR cost centers: member counts 24/16/8/9/11/13, every seat in
    // exactly one CC, so these six caps sum to the 567,000 pool allowance.
    const expectations: Array<[string, number]> = [
      [COST_CENTER_IDS.workforce, 24 * PROMO_CREDITS_PER_SEAT],
      [COST_CENTER_IDS.employer, 16 * PROMO_CREDITS_PER_SEAT],
      [COST_CENTER_IDS.capBound, 8 * PROMO_CREDITS_PER_SEAT],
      [COST_CENTER_IDS.dataEval, 9 * PROMO_CREDITS_PER_SEAT],
      [COST_CENTER_IDS.cyber, 11 * PROMO_CREDITS_PER_SEAT],
      [COST_CENTER_IDS.corporate, 13 * PROMO_CREDITS_PER_SEAT],
    ];

    for (const [id, expected] of expectations) {
      const cc = centersBody.costCenters.find((c) => c.id === id);
      expect(cc?.included_usage_cap.computed_limit_credits).toBe(expected);

      // A zero-member-delta PATCH (the wire cap toggle re-asserted to its
      // canonical value) recomputes to the exact same committed number --
      // proves the recompute formula agrees with the frozen fixture values
      // rather than merely echoing them back.
      const editRes = await fetch(`${COST_CENTERS_URL}/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ai_credit_pool_enabled: true }),
      });
      const edited = (await editRes.json()) as { included_usage_cap: { computed_limit_credits: number } };
      expect(edited.included_usage_cap.computed_limit_credits).toBe(expected);
    }
  });
});
