import { http, HttpResponse } from 'msw';
import { buildLinkHeader, paginate } from './pagination.js';
import {
  BUDGETS,
  COST_CENTER_RESOURCES,
  COST_CENTERS,
  CREDITS_USED_ITEMS,
  DEFAULT_ENTERPRISE_TEAM_SEATS,
  ENTERPRISE_TEAM_SEAT_COUNTS,
  GITHUB_API_BASE,
  SEATS,
  USAGE_ITEMS,
  type Budget,
  type BudgetScope,
  type BudgetType,
  type CostCenterResource,
} from './fixtures/index.js';

const ENTERPRISE_BASE = `${GITHUB_API_BASE}/enterprises/:enterprise`;

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? '30'));
  return { page, perPage };
}

function linkHeaders(requestUrl: string, page: number, perPage: number, total: number): Record<string, string> | undefined {
  const link = buildLinkHeader(requestUrl, page, perPage, total);
  return link ? { Link: link } : undefined;
}

// ---------------------------------------------------------------------------
// Task 4.1/4.2 shared mutation-handler plumbing: GitHub-shaped error envelope,
// generic field-error collection, and a strict allow-list validator used by
// both the budgets and cost-centers mutation handlers below. Kept in this
// file (not a new module) per the tasks' explicit file lists.
// ---------------------------------------------------------------------------

interface FieldError {
  resource: string;
  field: string;
  code: string;
}

// Mirrors GitHub's documented REST error envelope (message + documentation_url,
// with a validation `errors` array on 422s) so hand-wrapped mutation handlers
// fail the way real GitHub billing endpoints do -- CLAUDE.md §6.9 will check
// this shape against the OpenAPI description in Task 4.3.
function githubError(status: number, message: string, errors?: FieldError[]) {
  return HttpResponse.json(
    {
      message,
      documentation_url: 'https://docs.github.com/rest/billing',
      ...(errors && errors.length > 0 ? { errors } : {}),
    },
    { status },
  );
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

// Strict allow-list: any top-level key not in `allowed` is rejected outright.
// This is the single mechanism that satisfies "the cap/limit is never
// accepted as an input amount" for whatever guessed field name a caller
// might try (`cap_amount`, `computed_limit_credits`, `ai_credit_pool_limit`,
// ...) without needing to enumerate every possible forbidden name.
function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  resource: string,
  errors: FieldError[],
  fieldPrefix = '',
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) errors.push({ resource, field: `${fieldPrefix}${key}`, code: 'not_settable' });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

// ---------------------------------------------------------------------------
// Task 4.1: budget mutations (all budget_scope values this tool writes).
// ---------------------------------------------------------------------------

const BUDGET_TYPES = new Set<BudgetType>(['ProductPricing', 'SkuPricing', 'BundlePricing']);
const BUDGET_SCOPES = new Set<BudgetScope>([
  'enterprise',
  'organization',
  'cost_center',
  'repository',
  'universal',
  'individual',
  'multi_user_cost_center',
]);

const BUDGET_CREATE_ALLOWED_FIELDS = new Set([
  'budget_type',
  'budget_product_sku',
  'budget_scope',
  'budget_entity_name',
  'budget_amount',
  'prevent_further_usage',
  'budget_alerting',
]);
const BUDGET_PATCH_ALLOWED_FIELDS = new Set(['budget_amount', 'prevent_further_usage', 'budget_alerting']);

function validateBudgetAlerting(value: unknown, errors: FieldError[]): Budget['budget_alerting'] | undefined {
  if (
    !isPlainObject(value) ||
    typeof value.will_alert !== 'boolean' ||
    !Array.isArray(value.alert_recipients) ||
    !value.alert_recipients.every((r) => typeof r === 'string')
  ) {
    errors.push({ resource: 'Budget', field: 'budget_alerting', code: 'invalid' });
    return undefined;
  }
  return { will_alert: value.will_alert, alert_recipients: value.alert_recipients as string[] };
}

// $0 is a deliberate, valid amount (spec §1.3/§1.4 -- ULBs can and do block at
// $0; this is the documented trap, not a bug) -- only non-numeric or negative
// amounts are malformed.
function validateBudgetAmount(value: unknown, errors: FieldError[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push({ resource: 'Budget', field: 'budget_amount', code: 'invalid' });
    return undefined;
  }
  return value;
}

function validateCreateBudgetPayload(body: unknown): { ok: true; value: Budget } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) return { ok: false, errors: [{ resource: 'Budget', field: 'body', code: 'missing' }] };

  rejectUnknownKeys(body, BUDGET_CREATE_ALLOWED_FIELDS, 'Budget', errors);

  if (typeof body.budget_type !== 'string' || !BUDGET_TYPES.has(body.budget_type as BudgetType)) {
    errors.push({ resource: 'Budget', field: 'budget_type', code: 'invalid' });
  }
  if (typeof body.budget_product_sku !== 'string' || body.budget_product_sku.length === 0) {
    errors.push({ resource: 'Budget', field: 'budget_product_sku', code: 'missing_field' });
  }
  if (typeof body.budget_scope !== 'string' || !BUDGET_SCOPES.has(body.budget_scope as BudgetScope)) {
    errors.push({ resource: 'Budget', field: 'budget_scope', code: 'invalid' });
  }
  if (typeof body.budget_entity_name !== 'string' || body.budget_entity_name.length === 0) {
    errors.push({ resource: 'Budget', field: 'budget_entity_name', code: 'missing_field' });
  }
  const budgetAmount = validateBudgetAmount(body.budget_amount, errors);
  if (typeof body.prevent_further_usage !== 'boolean') {
    errors.push({ resource: 'Budget', field: 'prevent_further_usage', code: 'invalid' });
  }
  const budgetAlerting = validateBudgetAlerting(body.budget_alerting, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: '', // filled in by the caller (deterministicBudgetId needs the validated payload first)
      budget_type: body.budget_type as BudgetType,
      budget_product_sku: body.budget_product_sku as string,
      budget_scope: body.budget_scope as BudgetScope,
      budget_entity_name: body.budget_entity_name as string,
      budget_amount: budgetAmount as number,
      prevent_further_usage: body.prevent_further_usage as boolean,
      budget_alerting: budgetAlerting as Budget['budget_alerting'],
    },
  };
}

function validatePatchBudgetPayload(body: unknown): { ok: true; value: Partial<Budget> } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) return { ok: false, errors: [{ resource: 'Budget', field: 'body', code: 'missing' }] };

  rejectUnknownKeys(body, BUDGET_PATCH_ALLOWED_FIELDS, 'Budget', errors);

  const patch: Partial<Budget> = {};
  if ('budget_amount' in body) {
    const amount = validateBudgetAmount(body.budget_amount, errors);
    if (amount !== undefined) patch.budget_amount = amount;
  }
  if ('prevent_further_usage' in body) {
    if (typeof body.prevent_further_usage !== 'boolean') {
      errors.push({ resource: 'Budget', field: 'prevent_further_usage', code: 'invalid' });
    } else {
      patch.prevent_further_usage = body.prevent_further_usage;
    }
  }
  if ('budget_alerting' in body) {
    const alerting = validateBudgetAlerting(body.budget_alerting, errors);
    if (alerting !== undefined) patch.budget_alerting = alerting;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: patch };
}

// Deterministic, derived purely from the validated payload (never
// Math.random or a request counter -- the mock has no cross-request state to
// count with anyway, per Architecture Decisions: "MSW stays stateless").
// Two identical creates in the same run yield the identical id + response.
function deterministicBudgetId(payload: Budget): string {
  return `budget-${slug(payload.budget_scope)}-${slug(payload.budget_entity_name)}-${slug(payload.budget_product_sku)}`;
}

// ---------------------------------------------------------------------------
// Task 4.2: cost-center mutations (create/delete/edit) + membership
// (resource add/remove) + the included-usage cap toggle.
// ---------------------------------------------------------------------------

const RESOURCE_TYPES = new Set<CostCenterResource['type']>(['User', 'Org', 'Repo', 'EnterpriseTeam']);
const INCLUDED_USAGE_CAP_ALLOWED_FIELDS = new Set(['enabled', 'overflow']);
const COST_CENTER_CREATE_ALLOWED_FIELDS = new Set([
  'name',
  'dewr_division',
  'dewr_branch',
  'dewr_project',
  'excluded_from_enterprise_budget',
  'included_usage_cap',
  'resources',
]);
const COST_CENTER_EDIT_ALLOWED_FIELDS = new Set([
  'name',
  'dewr_division',
  'dewr_branch',
  'dewr_project',
  'excluded_from_enterprise_budget',
  'included_usage_cap',
]);

// The included-usage cap is never amount-settable (CLAUDE.md §5 / spec §1.3):
// GitHub auto-computes it from attributed licenses. `enabled`/`overflow` is
// the *entire* allowed shape -- any other key (whatever it's called) is a
// hard rejection, never a silently-ignored field.
function validateIncludedUsageCapInput(
  value: unknown,
  errors: FieldError[],
): { enabled?: boolean; overflow?: 'block' | 'metered' } | undefined {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push({ resource: 'CostCenter', field: 'included_usage_cap', code: 'invalid' });
    return undefined;
  }
  rejectUnknownKeys(value, INCLUDED_USAGE_CAP_ALLOWED_FIELDS, 'CostCenter', errors, 'included_usage_cap.');

  const result: { enabled?: boolean; overflow?: 'block' | 'metered' } = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') {
      errors.push({ resource: 'CostCenter', field: 'included_usage_cap.enabled', code: 'invalid' });
    } else {
      result.enabled = value.enabled;
    }
  }
  if ('overflow' in value) {
    if (value.overflow !== 'block' && value.overflow !== 'metered') {
      errors.push({ resource: 'CostCenter', field: 'included_usage_cap.overflow', code: 'invalid' });
    } else {
      result.overflow = value.overflow;
    }
  }
  return result;
}

interface CreateCostCenterPayload {
  name: string;
  dewr_division?: string;
  dewr_branch?: string;
  dewr_project?: string;
  excluded_from_enterprise_budget?: boolean;
  included_usage_cap?: { enabled?: boolean; overflow?: 'block' | 'metered' };
  resources?: CostCenterResource[];
}

function validateResourceList(value: unknown, errors: FieldError[]): CostCenterResource[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ resource: 'CostCenterResource', field: 'resources', code: 'missing_field' });
    return undefined;
  }
  const result: CostCenterResource[] = [];
  value.forEach((entry, i) => {
    if (!isPlainObject(entry) || typeof entry.type !== 'string' || !RESOURCE_TYPES.has(entry.type as CostCenterResource['type'])) {
      errors.push({ resource: 'CostCenterResource', field: `resources[${i}].type`, code: 'invalid' });
      return;
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      errors.push({ resource: 'CostCenterResource', field: `resources[${i}].name`, code: 'missing_field' });
      return;
    }
    result.push({ type: entry.type as CostCenterResource['type'], name: entry.name });
  });
  return result;
}

function validateCreateCostCenterPayload(
  body: unknown,
): { ok: true; value: CreateCostCenterPayload } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) return { ok: false, errors: [{ resource: 'CostCenter', field: 'body', code: 'missing' }] };

  rejectUnknownKeys(body, COST_CENTER_CREATE_ALLOWED_FIELDS, 'CostCenter', errors);

  if (typeof body.name !== 'string' || body.name.length === 0) {
    errors.push({ resource: 'CostCenter', field: 'name', code: 'missing_field' });
  }
  const cap = validateIncludedUsageCapInput(body.included_usage_cap, errors);

  let resources: CostCenterResource[] | undefined;
  if ('resources' in body) {
    resources = validateResourceList(body.resources, errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: body.name as string,
      dewr_division: typeof body.dewr_division === 'string' ? body.dewr_division : undefined,
      dewr_branch: typeof body.dewr_branch === 'string' ? body.dewr_branch : undefined,
      dewr_project: typeof body.dewr_project === 'string' ? body.dewr_project : undefined,
      excluded_from_enterprise_budget:
        typeof body.excluded_from_enterprise_budget === 'boolean' ? body.excluded_from_enterprise_budget : undefined,
      included_usage_cap: cap,
      resources,
    },
  };
}

interface EditCostCenterPayload {
  name?: string;
  dewr_division?: string;
  dewr_branch?: string;
  dewr_project?: string;
  excluded_from_enterprise_budget?: boolean;
  included_usage_cap?: { enabled?: boolean; overflow?: 'block' | 'metered' };
}

// No PATCH route for cost centers is listed in the PRD §2.2 API inventory
// (only GET list/POST create/GET+DELETE by id/POST+DELETE resource) -- this
// route is this handler's own inference of the "cost-center create/edit API"
// the plan calls for (needed so the cap toggle has a post-creation edit
// path). §6.9-pending: validate this route/shape against real docs.
function validateEditCostCenterPayload(
  body: unknown,
): { ok: true; value: EditCostCenterPayload } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) return { ok: false, errors: [{ resource: 'CostCenter', field: 'body', code: 'missing' }] };

  rejectUnknownKeys(body, COST_CENTER_EDIT_ALLOWED_FIELDS, 'CostCenter', errors);

  if ('name' in body && (typeof body.name !== 'string' || body.name.length === 0)) {
    errors.push({ resource: 'CostCenter', field: 'name', code: 'invalid' });
  }
  const cap = validateIncludedUsageCapInput(body.included_usage_cap, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: typeof body.name === 'string' ? body.name : undefined,
      dewr_division: typeof body.dewr_division === 'string' ? body.dewr_division : undefined,
      dewr_branch: typeof body.dewr_branch === 'string' ? body.dewr_branch : undefined,
      dewr_project: typeof body.dewr_project === 'string' ? body.dewr_project : undefined,
      excluded_from_enterprise_budget:
        typeof body.excluded_from_enterprise_budget === 'boolean' ? body.excluded_from_enterprise_budget : undefined,
      included_usage_cap: cap,
    },
  };
}

// GitHub auto-computes the included-usage cap from the licenses attributed to
// the cost center (~7,000 promo credits/seat, Enterprise -- CLAUDE.md §5).
// Only User and EnterpriseTeam resources carry per-seat Copilot licenses in
// this simulation model; Org/Repo resources don't contribute a seat count
// directly (a simplification -- real attribution would expand an Org's
// members, which this stateless mock has no roster to do).
const PROMO_CREDITS_PER_SEAT_ENTERPRISE = 7_000;

function licensedSeatCount(resources: readonly CostCenterResource[]): number {
  return resources.reduce((count, r) => {
    if (r.type === 'User') return count + 1;
    if (r.type === 'EnterpriseTeam') return count + (ENTERPRISE_TEAM_SEAT_COUNTS[r.name] ?? DEFAULT_ENTERPRISE_TEAM_SEATS);
    return count;
  }, 0);
}

function includedUsageCapLimitForSeats(seatCount: number): number {
  return seatCount * PROMO_CREDITS_PER_SEAT_ENTERPRISE;
}

export const handlers = [
  http.get(`${ENTERPRISE_BASE}/copilot/billing/seats`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(
      { total_seats: SEATS.length, seats: paginate(SEATS, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, SEATS.length) },
    );
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/cost-centers`, () => {
    return HttpResponse.json({ costCenters: COST_CENTERS });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId/resource`, ({ request, params }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    const all = COST_CENTER_RESOURCES[params.costCenterId as string] ?? [];
    return HttpResponse.json(
      { resources: paginate(all, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, all.length) },
    );
  }),

  // ---- Task 4.2: cost-center create / delete / edit (incl. included-usage-cap toggle) ----

  http.post(`${ENTERPRISE_BASE}/settings/billing/cost-centers`, async ({ request }) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validateCreateCostCenterPayload(parsed.value);
    if (!result.ok) return githubError(422, 'Validation Failed', result.errors);

    const value = result.value;
    const resources = value.resources ?? [];
    return HttpResponse.json(
      {
        id: `cc-${slug(value.name)}`,
        name: value.name,
        state: 'active',
        dewr_division: value.dewr_division ?? '',
        dewr_branch: value.dewr_branch ?? '',
        dewr_project: value.dewr_project ?? '',
        mtd_burn_credits: 0,
        included_usage_cap: {
          enabled: value.included_usage_cap?.enabled ?? false,
          overflow: value.included_usage_cap?.overflow ?? 'block',
          computed_limit_credits: includedUsageCapLimitForSeats(licensedSeatCount(resources)),
        },
        excluded_from_enterprise_budget: value.excluded_from_enterprise_budget ?? false,
        resources,
      },
      { status: 201 },
    );
  }),

  http.delete(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId`, ({ params }) => {
    const canonical = COST_CENTERS.find((c) => c.id === params.costCenterId);
    if (!canonical) return githubError(404, 'Not Found');
    return new HttpResponse(null, { status: 204 });
  }),

  // "Create/edit" cost-center API (PLAN.md Task 4.2) -- see the §6.9-pending
  // note above validateEditCostCenterPayload: no PATCH route for cost centers
  // appears in PRD §2.2's inventory, so this route/shape is this handler's
  // own inference, flagged for Task 4.3.
  http.patch(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId`, async ({ request, params }) => {
    const canonical = COST_CENTERS.find((c) => c.id === params.costCenterId);
    if (!canonical) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validateEditCostCenterPayload(parsed.value);
    if (!result.ok) return githubError(422, 'Validation Failed', result.errors);

    const value = result.value;
    // computed_limit_credits is always freshly derived from canonical
    // membership, never taken from the client or the old fixture value --
    // reinforces "the cap is never modeled as an amount" even on edit.
    const seatCount = licensedSeatCount(COST_CENTER_RESOURCES[canonical.id] ?? []);
    return HttpResponse.json({
      ...canonical,
      name: value.name ?? canonical.name,
      dewr_division: value.dewr_division ?? canonical.dewr_division,
      dewr_branch: value.dewr_branch ?? canonical.dewr_branch,
      dewr_project: value.dewr_project ?? canonical.dewr_project,
      excluded_from_enterprise_budget: value.excluded_from_enterprise_budget ?? canonical.excluded_from_enterprise_budget,
      included_usage_cap: {
        enabled: value.included_usage_cap?.enabled ?? canonical.included_usage_cap.enabled,
        overflow: value.included_usage_cap?.overflow ?? canonical.included_usage_cap.overflow,
        computed_limit_credits: includedUsageCapLimitForSeats(seatCount),
      },
    });
  }),

  // Membership mutations: the recomputed included_usage_cap.computed_limit_credits
  // in the immediate response is derived purely from canonical fixture
  // membership + this request's resources (never persisted -- Architecture
  // Decisions: "MSW stays stateless"). Real GitHub's add/remove-resource
  // endpoints may well return 204 No Content; this task explicitly requires
  // the recomputed limit in the response body, so 200/201 + body is a
  // deliberate, task-driven shape -- not an accidental divergence for 4.3 to
  // "correct" back to 204.
  http.post(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId/resource`, async ({ request, params }) => {
    const ccId = params.costCenterId as string;
    const canonical = COST_CENTERS.find((c) => c.id === ccId);
    if (!canonical) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const errors: FieldError[] = [];
    if (!isPlainObject(parsed.value)) {
      return githubError(422, 'Validation Failed', [{ resource: 'CostCenterResource', field: 'body', code: 'missing' }]);
    }
    const added = validateResourceList(parsed.value.resources, errors);
    if (!added || added.length === 0) {
      errors.push({ resource: 'CostCenterResource', field: 'resources', code: 'invalid' });
    }
    if (errors.length > 0 || !added) return githubError(422, 'Validation Failed', errors);

    const existing = COST_CENTER_RESOURCES[ccId] ?? [];
    const recomputedSeatCount = licensedSeatCount(existing) + licensedSeatCount(added);
    return HttpResponse.json(
      {
        cost_center_id: ccId,
        added,
        member_count: existing.length + added.length,
        included_usage_cap: {
          enabled: canonical.included_usage_cap.enabled,
          overflow: canonical.included_usage_cap.overflow,
          computed_limit_credits: includedUsageCapLimitForSeats(recomputedSeatCount),
        },
      },
      { status: 201 },
    );
  }),

  http.delete(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId/resource`, async ({ request, params }) => {
    const ccId = params.costCenterId as string;
    const canonical = COST_CENTERS.find((c) => c.id === ccId);
    if (!canonical) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const errors: FieldError[] = [];
    if (!isPlainObject(parsed.value)) {
      return githubError(422, 'Validation Failed', [{ resource: 'CostCenterResource', field: 'body', code: 'missing' }]);
    }
    const removed = validateResourceList(parsed.value.resources, errors);
    if (!removed || removed.length === 0) {
      errors.push({ resource: 'CostCenterResource', field: 'resources', code: 'invalid' });
    }
    if (errors.length > 0 || !removed) return githubError(422, 'Validation Failed', errors);

    const existing = COST_CENTER_RESOURCES[ccId] ?? [];
    const remainingSeatCount = Math.max(0, licensedSeatCount(existing) - licensedSeatCount(removed));
    return HttpResponse.json({
      cost_center_id: ccId,
      removed,
      member_count: Math.max(0, existing.length - removed.length),
      included_usage_cap: {
        enabled: canonical.included_usage_cap.enabled,
        overflow: canonical.included_usage_cap.overflow,
        computed_limit_credits: includedUsageCapLimitForSeats(remainingSeatCount),
      },
    });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/budgets`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(
      { budgets: paginate(BUDGETS, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, BUDGETS.length) },
    );
  }),

  // ---- Task 4.1: budget create / read-one / edit / delete (all budget_scope values) ----

  http.post(`${ENTERPRISE_BASE}/settings/billing/budgets`, async ({ request }) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validateCreateBudgetPayload(parsed.value);
    if (!result.ok) return githubError(422, 'Validation Failed', result.errors);

    const value = result.value;
    return HttpResponse.json({ ...value, id: deterministicBudgetId(value) }, { status: 201 });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/budgets/:budgetId`, ({ params }) => {
    const budget = BUDGETS.find((b) => b.id === params.budgetId);
    if (!budget) return githubError(404, 'Not Found');
    return HttpResponse.json(budget);
  }),

  http.patch(`${ENTERPRISE_BASE}/settings/billing/budgets/:budgetId`, async ({ request, params }) => {
    const budget = BUDGETS.find((b) => b.id === params.budgetId);
    if (!budget) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validatePatchBudgetPayload(parsed.value);
    if (!result.ok) return githubError(422, 'Validation Failed', result.errors);

    // Stateless: merged into a fresh response object only -- the canonical
    // BUDGETS fixture entry is never written to, so the next request (GET,
    // list, or another PATCH) still sees the original committed value.
    return HttpResponse.json({ ...budget, ...result.value });
  }),

  http.delete(`${ENTERPRISE_BASE}/settings/billing/budgets/:budgetId`, ({ params }) => {
    const budget = BUDGETS.find((b) => b.id === params.budgetId);
    if (!budget) return githubError(404, 'Not Found');
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/usage`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    const costCenterId = url.searchParams.get('cost_center_id');
    const filtered = costCenterId ? USAGE_ITEMS.filter((item) => item.cost_center_id === costCenterId) : USAGE_ITEMS;
    return HttpResponse.json(
      { usageItems: paginate(filtered, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, filtered.length) },
    );
  }),

  http.get(`${ENTERPRISE_BASE}/copilot/metrics/reports/users-28-day`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(paginate(CREDITS_USED_ITEMS, page, perPage), {
      headers: linkHeaders(request.url, page, perPage, CREDITS_USED_ITEMS.length),
    });
  }),
];
