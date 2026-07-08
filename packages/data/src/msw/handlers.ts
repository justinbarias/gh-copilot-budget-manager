import { http, HttpResponse } from 'msw';
import { buildLinkHeader, paginate } from './pagination.js';
import { getActiveAsOfDate } from './scenario-state.js';
import {
  AI_CREDITS_SKU,
  COPILOT_BUSINESS_SKU,
  COPILOT_PREMIUM_REQUEST_SKU,
  DEFAULT_ENTERPRISE_TEAM_SEATS,
  DOWNLOAD_HOST,
  ENTERPRISE_TEAM_SEAT_COUNTS,
  GITHUB_API_BASE,
  HISTORICAL_CREDITS_USED_ITEMS,
  HISTORICAL_USAGE_ITEMS,
  getActiveFixtures,
  type Budget,
  type BudgetScope,
  type BudgetType,
  type CostCenterResource,
  type CreditsUsedItem,
  type UsageItem,
} from './fixtures/index.js';

// Task 6.7: every READ + canonical-lookup below resolves the ACTIVE scenario's
// fixture set (getActiveFixtures) rather than closing over the committed DEWR
// arrays, so `setScenario` re-seeds the mock with no handler re-registration.
// The default scenario ('healthy') returns the exact committed arrays, so every
// pre-6.7 pin is byte-identical.

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

// Pricing-model pairings, LIVE-PINNED (maintainer's R4 per-budget sampler,
// 2026-07-09, corroborating the machine-verified model): 'ai_credits' pairs
// with BundlePricing ALWAYS (all seven real ai_credits budgets, every
// scope); ProductPricing pairs with PRODUCT skus (observed live: codespaces
// / packages / actions), SkuPricing with SKU strings (e.g. 'actions_linux').
// validateBudgetPairing below enforces the ai_credits<=>BundlePricing rule
// as a hard 422 -- the drift-guard that stops the old ProductPricing+
// ai_credits engine behavior from ever reaching the wire again. The exact
// product/sku string space stays validation-light (unpinned beyond the four
// observed strings) -- the mock must not reject what the real API accepts.
const BUDGET_TYPES = new Set<BudgetType>(['ProductPricing', 'SkuPricing', 'BundlePricing']);

function validateBudgetPairing(budgetType: unknown, productSku: unknown, errors: FieldError[]): void {
  if (typeof budgetType !== 'string' || typeof productSku !== 'string') return; // presence/enum errors already recorded
  if (productSku === 'ai_credits' && budgetType !== 'BundlePricing') {
    errors.push({ resource: 'Budget', field: 'budget_type', code: 'invalid' });
  }
  // Deliberately NO inverse rule (BundlePricing + a non-ai_credits sku is
  // NOT rejected): the live pin only establishes ai_credits => BundlePricing;
  // whether other bundle skus exist is unpinned, and the mock must not
  // reject what the real API might accept.
}
// The REAL wire enum, machine-verified against GitHub's OpenAPI description
// (wire-contract-writes.md §1). Our old internal spellings
// 'universal'/'individual' are NOT wire values and are rejected here like any
// other unknown scope -- the drift guard that surfaces any impl callsite
// still serializing the internal model onto the wire.
const BUDGET_SCOPES = new Set<BudgetScope>([
  'enterprise',
  'organization',
  'repository',
  'cost_center',
  'multi_user_customer',
  'multi_user_cost_center',
  'user',
]);

const BUDGET_CREATE_ALLOWED_FIELDS = new Set([
  'budget_type',
  'budget_product_sku',
  'budget_scope',
  'budget_entity_name',
  'budget_amount',
  'prevent_further_usage',
  'budget_alerting',
  'user',
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
// $0; this is the documented trap, not a bug). Machine-verified
// (wire-contract-writes.md §1): budget_amount is `type: integer`, "in whole
// dollars" -- so fractional dollars are malformed, alongside non-numeric or
// negative values.
function validateBudgetAmount(value: unknown, errors: FieldError[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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
  validateBudgetPairing(body.budget_type, body.budget_product_sku, errors);

  // Machine-verified (wire-contract-writes.md §1): `user` is "the login when
  // scope is `user`" -- required for scope 'user', a non-empty string when
  // present.
  if (body.budget_scope === 'user' && (typeof body.user !== 'string' || body.user.length === 0)) {
    errors.push({ resource: 'Budget', field: 'user', code: 'missing_field' });
  } else if ('user' in body && typeof body.user !== 'string') {
    errors.push({ resource: 'Budget', field: 'user', code: 'invalid' });
  }

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
      ...(typeof body.user === 'string' && body.user.length > 0 ? { user: body.user } : {}),
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
  // CREATE still accepts the internal nested cap shape: the 2026-07-09 round
  // pinned only the PATCH request body ({ai_credit_pool_enabled}); the create
  // body's cap field was not in the maintainer's dump. FLAGGED dialect
  // inconsistency (create=internal, patch=wire) -- next live smoke pins it.
  'included_usage_cap',
  'resources',
]);
// PATCH allow-list speaks the WIRE dialect (live-pinned 2026-07-09): the cap
// toggle is the flat `ai_credit_pool_enabled` -- the internal nested
// `included_usage_cap` (and any `overflow` key) is NOT accepted here and
// 400s as an unknown key. (CREATE below still accepts the internal shape --
// unpinned this round; see the create allow-list note.)
const COST_CENTER_EDIT_ALLOWED_FIELDS = new Set([
  'name',
  'dewr_division',
  'dewr_branch',
  'dewr_project',
  'excluded_from_enterprise_budget',
  'ai_credit_pool_enabled',
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

// ---------------------------------------------------------------------------
// Machine-verified /resource mutation body (wire-contract-writes.md §3): POST
// (add) and DELETE (remove) take the IDENTICAL four-array shape with
// `minProperties: 1`:
//   { users: [string], organizations: [string],
//     repositories: [string], enterprise_teams: [string] }
// The old invented `{resources: [{type, name}]}` shape is rejected outright
// (`resources` is an unknown key -> validation error), so any impl callsite
// still sending it fails loudly instead of silently half-working.
// ---------------------------------------------------------------------------

// Body key -> the resource `type` used by the fixture membership model (and
// by the R3-pinned embedded `resources[]` read shape, e.g. {"type": "User"}).
const RESOURCE_BODY_KEY_TO_TYPE: Record<string, CostCenterResource['type']> = {
  users: 'User',
  organizations: 'Org',
  repositories: 'Repo',
  enterprise_teams: 'EnterpriseTeam',
};
const RESOURCE_BODY_ALLOWED_FIELDS = new Set(Object.keys(RESOURCE_BODY_KEY_TO_TYPE));

function validateResourceMutationBody(
  body: unknown,
): { ok: true; entries: CostCenterResource[] } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ resource: 'CostCenter', field: 'body', code: 'missing' }] };
  }
  rejectUnknownKeys(body, RESOURCE_BODY_ALLOWED_FIELDS, 'CostCenter', errors);

  // minProperties: 1 -- machine-verified; an empty object is malformed.
  if (Object.keys(body).filter((k) => RESOURCE_BODY_ALLOWED_FIELDS.has(k)).length === 0) {
    errors.push({ resource: 'CostCenter', field: 'body', code: 'missing_field' });
  }

  const entries: CostCenterResource[] = [];
  for (const [key, type] of Object.entries(RESOURCE_BODY_KEY_TO_TYPE)) {
    if (!(key in body)) continue;
    const arr = body[key];
    if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'string' && n.length > 0)) {
      errors.push({ resource: 'CostCenter', field: key, code: 'invalid' });
      continue;
    }
    for (const name of arr as string[]) entries.push({ type, name });
  }
  // All present arrays empty -> nothing to mutate. minProperties: 1 is the
  // machine-verified floor; rejecting an all-empty no-op on top of it is a
  // plausible-server validation (mirrors the old empty-resources rejection).
  if (errors.length === 0 && entries.length === 0) {
    errors.push({ resource: 'CostCenter', field: 'body', code: 'invalid' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries };
}

// Machine-verified add response (wire-contract-writes.md §3):
// reassigned_resources[] = {resource_type, name, previous_cost_center}, or
// null when nothing moved. A resource "genuinely moves" when the canonical
// fixtures attribute it to a DIFFERENT cost center than the target.
// `previous_cost_center` carries the previous cost center's ID (fixtures key
// membership by id; the OpenAPI type is just `string`, so id-vs-name is a
// simulation choice -- flagged for the next live smoke to pin).
// `resource_type` uses the R3-pinned read-shape casing ('User'/'Org'/...);
// the contract does not quote this enum, so it too is pinned-by-consistency,
// not machine-verified.
interface ReassignedResource {
  resource_type: CostCenterResource['type'];
  name: string;
  previous_cost_center: string;
}

function findReassignments(
  costCenterResources: Readonly<Record<string, readonly CostCenterResource[]>>,
  targetCcId: string,
  entries: readonly CostCenterResource[],
): ReassignedResource[] {
  const moves: ReassignedResource[] = [];
  for (const entry of entries) {
    for (const [ccId, resources] of Object.entries(costCenterResources)) {
      if (ccId === targetCcId) continue;
      if (resources.some((r) => r.type === entry.type && r.name === entry.name)) {
        moves.push({ resource_type: entry.type, name: entry.name, previous_cost_center: ccId });
        break;
      }
    }
  }
  return moves;
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
  ai_credit_pool_enabled?: boolean;
}

// PATCH request body -- LIVE-PINNED (maintainer's 2026-07-09 R2 cap dump +
// the machine-verified schema, wire-contract-writes.md §5): the real cap
// toggle on the wire is the FLAT `ai_credit_pool_enabled: boolean`, full
// stop. No overflow/block-vs-metered field exists ANYWHERE in the schema, so
// an `overflow` key (or the old nested `included_usage_cap {enabled,
// overflow}` internal shape) in a PATCH body is rejected loudly via the
// unknown-key 400 -- any impl callsite still serializing the internal cap
// model onto the wire must surface, never silently half-work. NOTE the
// read/echo side stays dual-dialect this round: responses still emit the
// internal `included_usage_cap` shape (the sim what-if overflow knob needs
// it; impl's normalizeIncludedUsageCap maps it) -- only the PATCH REQUEST
// body speaks the wire dialect.
function validateEditCostCenterPayload(
  body: unknown,
): { ok: true; value: EditCostCenterPayload } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isPlainObject(body)) return { ok: false, errors: [{ resource: 'CostCenter', field: 'body', code: 'missing' }] };

  rejectUnknownKeys(body, COST_CENTER_EDIT_ALLOWED_FIELDS, 'CostCenter', errors);

  if ('name' in body && (typeof body.name !== 'string' || body.name.length === 0)) {
    errors.push({ resource: 'CostCenter', field: 'name', code: 'invalid' });
  }
  if ('ai_credit_pool_enabled' in body && typeof body.ai_credit_pool_enabled !== 'boolean') {
    errors.push({ resource: 'CostCenter', field: 'ai_credit_pool_enabled', code: 'invalid' });
  }

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
      ai_credit_pool_enabled: typeof body.ai_credit_pool_enabled === 'boolean' ? body.ai_credit_pool_enabled : undefined,
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

// Task 9.1 validatePat twin: GET /rate_limit is the cheap probe validatePat
// reads the X-OAuth-Scopes response header off (it does not consume rate-limit
// budget -- see github-impl.ts validatePat's doc comment / the §6.9
// "X-OAuth-Scopes" row). This mock reproduces GitHub's DOCUMENTED auth-surface
// behavior deterministically, branching on the bearer token so every
// validatePat classification path is drivable from a fixed token string:
//   - classic PAT with the scope       -> 200 + `X-OAuth-Scopes: repo, manage_billing:enterprise`
//   - classic PAT without the scope     -> 200 + `X-OAuth-Scopes: repo, read:org`  (token contains "noscope")
//   - fine-grained PAT (github_pat_...) -> 200, NO X-OAuth-Scopes header at all
//   - missing / invalid token           -> 401
// The exact scopes strings are simulation values; the *mechanism* (classic
// tokens carry X-OAuth-Scopes, fine-grained don't) is the documented invariant
// validatePat keys off, pinned for live confirmation at Task 9.2 (§6.9 row).
function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (!auth) return null;
  const match = /^(?:token|bearer)\s+(.+)$/i.exec(auth.trim());
  return match?.[1] ?? auth.trim();
}

function rateLimitBody() {
  return { resources: {}, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } };
}

// ---------------------------------------------------------------------------
// R5 (wire-contract-r3-r5-r6.md): the enhanced-billing usage report's real
// wire is camelCase and never carries user_login/cost_center_id -- those stay
// FIXTURE-INTERNAL (UsageItem, fixtures/usage.ts) for filtering only and are
// PROJECTED OUT here. unitType/pricePerUnit/organizationName are additions
// the live smoke's item required but our old parse never emitted.
// ---------------------------------------------------------------------------

interface WireUsageItem {
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

// GitHub's enhanced-billing usage docs don't pin a `unitType` value for
// Copilot usage rows -- 'Unit' is a defensible placeholder (same "pending
// the next live smoke" treatment as R6's report-file format below).
// `pricePerUnit` is per-sku (the endpoint mixes skus -- live-pinned
// 2026-07-09): AI credits are $0.01 exactly (CLAUDE.md §5), Copilot Business
// license spend $19/seat-month, Premium Requests $0.04/request. Every
// fixture row satisfies gross_amount === quantity x its sku's rate, so this
// map is a constant lookup, never a floating-point division.
const USAGE_UNIT_TYPE = 'Unit';
const USAGE_PRICE_PER_UNIT_USD: Record<string, number> = {
  [AI_CREDITS_SKU]: 0.01,
  [COPILOT_BUSINESS_SKU]: 19,
  [COPILOT_PREMIUM_REQUEST_SKU]: 0.04,
};
// DEWR's enterprise-owned GitHub organization -- reused from budgets.ts's
// `organization`-scope spending-limit fixture (budget_entity_name:
// 'dewr-digital') rather than inventing a second org name, since the fixture
// model doesn't otherwise track a per-usage-item organization.
const USAGE_ORGANIZATION_NAME = 'dewr-digital';

function toWireUsageItem(item: UsageItem): WireUsageItem {
  return {
    date: item.date,
    product: item.product,
    sku: item.sku,
    quantity: item.quantity,
    unitType: USAGE_UNIT_TYPE,
    pricePerUnit: USAGE_PRICE_PER_UNIT_USD[item.sku] ?? 0.01,
    grossAmount: item.gross_amount,
    discountAmount: item.discount_amount,
    netAmount: item.net_amount,
    organizationName: USAGE_ORGANIZATION_NAME,
  };
}

// ---------------------------------------------------------------------------
// R6 (wire-contract-r3-r5-r6.md): users-1-day / users-28-day/latest return an
// async report ENVELOPE; the per-user rows live in a file behind
// `download_links`, served below by a companion handler on DOWNLOAD_HOST.
// File format: LIVE-PINNED (maintainer's 2026-07-08 authenticated smoke
// against the real tenant): **JSONL** -- one JSON object per line, first
// record's keys exactly [user_id, user_login, ai_credits_used] (1,111 records
// on their tenant). The mock emits the same JSONL (plus the sim-only `model`
// enrichment where a fixture row carries it -- parsed optionally impl-side).
// A day with no records is an EMPTY body (zero lines), which the impl's
// sniffReportFormat (api-client/users-report.ts) classifies as 'empty' ->
// zero records.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

// Inclusive [start, end] window of `days` calendar days ending at `endDate`
// (UTC, no wall-clock -- endDate is always a fixture/scenario "now", never
// `new Date()`). days=28 matches the real users-28-day report's trailing
// window; the mock computes it once here so both the envelope's
// report_start_day/report_end_day and the file-serving handler agree.
function trailingWindow(endDate: string, days: number): { start: string; end: string } {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: endDate };
}

interface UsersReportRecord {
  user_id: string;
  user_login: string;
  ai_credits_used: number;
  date: string;
  model?: string;
}

function toReportRecord(item: CreditsUsedItem): UsersReportRecord {
  return {
    user_id: item.user_id,
    user_login: item.user_login,
    ai_credits_used: item.ai_credits_used,
    date: item.date,
    ...(item.model ? { model: item.model } : {}),
  };
}

function allCreditsUsedItems(): CreditsUsedItem[] {
  return [...getActiveFixtures().creditsUsedItems, ...HISTORICAL_CREDITS_USED_ITEMS];
}

// JSONL response body (the live-pinned report-file format, above): one JSON
// object per line, no trailing newline; zero records -> empty body ('empty'
// to the impl's sniffer, never `[]`). Content-Type is text/plain: the impl
// reads the file via `response.text()` + sniff, never the header, and the
// real signed-URL host's header is unknown -- deliberately NOT application/
// json, so nothing can accidentally start trusting a header the live host
// may not send.
function jsonlResponse(records: readonly unknown[]) {
  return new HttpResponse(records.map((r) => JSON.stringify(r)).join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export const handlers = [
  http.get(`${GITHUB_API_BASE}/rate_limit`, ({ request }) => {
    const token = bearerToken(request);
    if (!token || token.includes('invalid')) {
      return githubError(401, 'Bad credentials');
    }
    if (token.startsWith('github_pat_')) {
      // Fine-grained PAT: no X-OAuth-Scopes header (the documented discriminator).
      return HttpResponse.json(rateLimitBody());
    }
    const scopes = token.includes('noscope') ? 'repo, read:org' : 'repo, manage_billing:enterprise';
    return HttpResponse.json(rateLimitBody(), { headers: { 'X-OAuth-Scopes': scopes } });
  }),

  http.get(`${ENTERPRISE_BASE}/copilot/billing/seats`, ({ request }) => {
    const { seats: SEATS } = getActiveFixtures();
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(
      { total_seats: SEATS.length, seats: paginate(SEATS, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, SEATS.length) },
    );
  }),

  // R3 (wire-contract-r3-r5-r6.md): real GitHub has no `resources` sub-array
  // endpoint at list time either -- but the list response DOES embed each
  // cost center's `resources[]` (see the GET-one handler's comment below for
  // the full endpoint-list citation). Membership DATA is unchanged
  // (costCenterResources, fixtures/costCenters.ts) -- only where it rides.
  http.get(`${ENTERPRISE_BASE}/settings/billing/cost-centers`, () => {
    const fx = getActiveFixtures();
    const costCenters = fx.costCenters.map((cc) => ({ ...cc, resources: fx.costCenterResources[cc.id] ?? [] }));
    return HttpResponse.json({ costCenters });
  }),

  // R3 (wire-contract-r3-r5-r6.md, live smoke 2026-07-08): `GET .../resource`
  // 404s live -- it never existed. The real, confirmed endpoint list is
  // LIST / POST / GET-one / PATCH / DELETE on `.../cost-centers[/{id}]` plus
  // POST/DELETE (mutations only) on `.../cost-centers/{id}/resource`. This is
  // that GET-one endpoint (previously missing entirely), embedding the same
  // `resources[]` the list handler above now carries.
  http.get(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId`, ({ params }) => {
    const fx = getActiveFixtures();
    const canonical = fx.costCenters.find((c) => c.id === params.costCenterId);
    if (!canonical) return githubError(404, 'Not Found');
    return HttpResponse.json({ ...canonical, resources: fx.costCenterResources[canonical.id] ?? [] });
  }),

  // ---- Task 4.2: cost-center create / delete / edit (incl. included-usage-cap toggle) ----

  http.post(`${ENTERPRISE_BASE}/settings/billing/cost-centers`, async ({ request }) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    // Cost-center mutations have NO 422 in their machine-verified status
    // list (wire-contract-writes.md §4) -- validation failures are 400.
    const result = validateCreateCostCenterPayload(parsed.value);
    if (!result.ok) return githubError(400, 'Validation Failed', result.errors);

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
    const canonical = getActiveFixtures().costCenters.find((c) => c.id === params.costCenterId);
    if (!canonical) return githubError(404, 'Not Found');
    return new HttpResponse(null, { status: 204 });
  }),

  // Cost-center edit endpoint -- §6.9-confirmed real in Task 4.3
  // (docs/api-surface-validation.md): PATCH .../cost-centers/{id} exists at
  // API version 2026-03-10. Body/response wire shape pinned against live at 9.2.
  http.patch(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId`, async ({ request, params }) => {
    const fx = getActiveFixtures();
    const canonical = fx.costCenters.find((c) => c.id === params.costCenterId);
    if (!canonical) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    // 400 on validation failure, same §4 status-list ruling as create above.
    const result = validateEditCostCenterPayload(parsed.value);
    if (!result.ok) return githubError(400, 'Validation Failed', result.errors);

    const value = result.value;
    // computed_limit_credits is always freshly derived from canonical
    // membership, never taken from the client or the old fixture value --
    // reinforces "the cap is never modeled as an amount" even on edit.
    // Echo stays in the internal included_usage_cap dialect (the read side's
    // dual-dialect arrangement -- see validateEditCostCenterPayload's note):
    // `enabled` reflects the wire body's ai_credit_pool_enabled; `overflow`
    // has no wire field (live-pinned: none exists) so it always retains the
    // canonical fixture value.
    const seatCount = licensedSeatCount(fx.costCenterResources[canonical.id] ?? []);
    return HttpResponse.json({
      ...canonical,
      name: value.name ?? canonical.name,
      dewr_division: value.dewr_division ?? canonical.dewr_division,
      dewr_branch: value.dewr_branch ?? canonical.dewr_branch,
      dewr_project: value.dewr_project ?? canonical.dewr_project,
      excluded_from_enterprise_budget: value.excluded_from_enterprise_budget ?? canonical.excluded_from_enterprise_budget,
      included_usage_cap: {
        enabled: value.ai_credit_pool_enabled ?? canonical.included_usage_cap.enabled,
        overflow: canonical.included_usage_cap.overflow,
        computed_limit_credits: includedUsageCapLimitForSeats(seatCount),
      },
      // R3: the PATCH echo embeds resources too (list/get-one/create/patch --
      // every place a cost-center object rides) -- canonical membership,
      // never the request body (edit never touches membership).
      resources: fx.costCenterResources[canonical.id] ?? [],
    });
  }),

  // Membership mutations -- machine-verified wire (wire-contract-writes.md
  // §3): four-array request body (validateResourceMutationBody above), add ->
  // 200 {message, reassigned_resources|null}, remove -> 200 {message}.
  //
  // SIM-ONLY ENRICHMENT -- `simulated_included_usage_cap` (validator to rule;
  // builder's proposal): Task 4.2's acceptance criterion requires the
  // recomputed license-derived cap limit to be OBSERVABLE in the immediate
  // response, because a stateless mock can never surface it on a re-GET (the
  // canonical fixtures don't change). The real envelope has no such field, so
  // the recomputed cap rides ALONGSIDE the real keys under an unmistakably
  // simulation-scoped name (precedent: `simulatedUiHidden`, `via_ent_team`).
  // Real GitHub never sends it; impl code must never depend on it (additive
  // unknown fields are exactly what a defensive parser tolerates). The
  // alternative -- re-deriving the limit client-side -- would relocate mock
  // knowledge into UI/impl code and touch files outside the mock's seam.
  http.post(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId/resource`, async ({ request, params }) => {
    const fx = getActiveFixtures();
    const ccId = params.costCenterId as string;
    const canonical = fx.costCenters.find((c) => c.id === ccId);
    if (!canonical) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    // Cost-center mutations have NO 422 in their machine-verified status
    // list -- validation failures are 400 (wire-contract-writes.md §4).
    const result = validateResourceMutationBody(parsed.value);
    if (!result.ok) return githubError(400, 'Validation Failed', result.errors);
    const added = result.entries;

    const moves = findReassignments(fx.costCenterResources, ccId, added);
    const existing = fx.costCenterResources[ccId] ?? [];
    const recomputedSeatCount = licensedSeatCount(existing) + licensedSeatCount(added);
    return HttpResponse.json({
      message: 'Resources successfully added to the cost center.',
      reassigned_resources: moves.length > 0 ? moves : null,
      simulated_included_usage_cap: {
        enabled: canonical.included_usage_cap.enabled,
        overflow: canonical.included_usage_cap.overflow,
        computed_limit_credits: includedUsageCapLimitForSeats(recomputedSeatCount),
      },
    });
  }),

  http.delete(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId/resource`, async ({ request, params }) => {
    const fx = getActiveFixtures();
    const ccId = params.costCenterId as string;
    const canonical = fx.costCenters.find((c) => c.id === ccId);
    if (!canonical) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validateResourceMutationBody(parsed.value);
    if (!result.ok) return githubError(400, 'Validation Failed', result.errors);
    const removed = result.entries;

    const existing = fx.costCenterResources[ccId] ?? [];
    const remainingSeatCount = Math.max(0, licensedSeatCount(existing) - licensedSeatCount(removed));
    // Machine-verified: remove carries {message} ONLY -- no
    // reassigned_resources key. The sim cap enrichment rides here too (same
    // 4.2 observability rationale as the add handler above).
    return HttpResponse.json({
      message: 'Resources successfully removed from the cost center.',
      simulated_included_usage_cap: {
        enabled: canonical.included_usage_cap.enabled,
        overflow: canonical.included_usage_cap.overflow,
        computed_limit_credits: includedUsageCapLimitForSeats(remainingSeatCount),
      },
    });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/budgets`, ({ request }) => {
    const { budgets: BUDGETS } = getActiveFixtures();
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(
      { budgets: paginate(BUDGETS, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, BUDGETS.length) },
    );
  }),

  // ---- Task 4.1: budget create / read-one / edit / delete (all budget_scope values) ----

  // Machine-verified success envelope (wire-contract-writes.md §2): POST ->
  // 200 { message, budget } -- the OpenAPI status list has NO 201. Budget
  // validation failures stay 422 (the shared validation-error schema).
  http.post(`${ENTERPRISE_BASE}/settings/billing/budgets`, async ({ request }) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validateCreateBudgetPayload(parsed.value);
    if (!result.ok) return githubError(422, 'Validation Failed', result.errors);

    const value = result.value;
    return HttpResponse.json({
      message: 'Budget successfully created.',
      budget: { ...value, id: deterministicBudgetId(value) },
    });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/budgets/:budgetId`, ({ params }) => {
    const budget = getActiveFixtures().budgets.find((b) => b.id === params.budgetId);
    if (!budget) return githubError(404, 'Not Found');
    return HttpResponse.json(budget);
  }),

  http.patch(`${ENTERPRISE_BASE}/settings/billing/budgets/:budgetId`, async ({ request, params }) => {
    const budget = getActiveFixtures().budgets.find((b) => b.id === params.budgetId);
    if (!budget) return githubError(404, 'Not Found');

    const parsed = await readJsonBody(request);
    if (!parsed.ok) return githubError(400, 'Problems parsing JSON');

    const result = validatePatchBudgetPayload(parsed.value);
    if (!result.ok) return githubError(422, 'Validation Failed', result.errors);

    // Machine-verified envelope (wire-contract-writes.md §2): PATCH -> 200
    // { message, budget }. Stateless: merged into a fresh response object
    // only -- the canonical BUDGETS fixture entry is never written to, so the
    // next request (GET, list, or another PATCH) still sees the original
    // committed value.
    return HttpResponse.json({
      message: 'Budget successfully updated.',
      budget: { ...budget, ...result.value },
    });
  }),

  // Machine-verified envelope (wire-contract-writes.md §2): DELETE -> 200
  // { message, id } -- the OpenAPI status list has NO 204.
  http.delete(`${ENTERPRISE_BASE}/settings/billing/budgets/:budgetId`, ({ params }) => {
    const budget = getActiveFixtures().budgets.find((b) => b.id === params.budgetId);
    if (!budget) return githubError(404, 'Not Found');
    return HttpResponse.json({ message: 'Budget successfully deleted.', id: budget.id });
  }),

  // R5 (wire-contract-r3-r5-r6.md, live smoke 2026-07-08): real GitHub emits
  // camelCase fields and NEVER user_login/cost_center_id on the item itself
  // (both stay fixture-internal, projected out by toWireUsageItem below).
  // Docs verbatim: "By default this endpoint will return usage that does not
  // have a cost center" -- so no `cost_center_id` param means ONLY rows whose
  // fixture cost_center_id is null/absent; every DEWR fixture row IS
  // CC-attributed, so that default call legitimately returns an empty page
  // (handlers.test.ts asserts this explicitly). `cost_center_id=<id>` still
  // returns exactly that CC's rows, byte-identical to the pre-fix filter.
  // Task 5.1's `year`/`month`/`day` historical-cycle behavior is unchanged.
  http.get(`${ENTERPRISE_BASE}/settings/billing/usage`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    const costCenterId = url.searchParams.get('cost_center_id');
    const year = url.searchParams.get('year');
    const month = url.searchParams.get('month');
    const day = url.searchParams.get('day');

    const { usageItems: USAGE_ITEMS } = getActiveFixtures();
    const source = year ? [...USAGE_ITEMS, ...HISTORICAL_USAGE_ITEMS] : USAGE_ITEMS;
    let filtered = costCenterId
      ? source.filter((item) => item.cost_center_id === costCenterId)
      : source.filter((item) => item.cost_center_id === null || item.cost_center_id === undefined);
    if (year) {
      const paddedMonth = month ? month.padStart(2, '0') : null;
      const paddedDay = day ? day.padStart(2, '0') : null;
      filtered = filtered.filter((item) => {
        const [itemYear, itemMonth, itemDay] = item.date.split('-');
        if (itemYear !== year) return false;
        if (paddedMonth && itemMonth !== paddedMonth) return false;
        if (paddedDay && itemDay !== paddedDay) return false;
        return true;
      });
    }

    return HttpResponse.json(
      { usageItems: paginate(filtered, page, perPage).map(toWireUsageItem) },
      { headers: linkHeaders(request.url, page, perPage, filtered.length) },
    );
  }),

  // R6 (wire-contract-r3-r5-r6.md, live smoke 2026-07-08): the OLD bare path
  // 404s live (missing `/latest` was the actual live 404) -- reproduce that
  // 404 here too, deliberately, so drift back to "bare path returns rows"
  // can never silently reappear.
  http.get(`${ENTERPRISE_BASE}/copilot/metrics/reports/users-28-day`, () => githubError(404, 'Not Found')),

  // R6: `users-28-day/latest` returns an async report ENVELOPE
  // (`download_links`/`report_start_day`/`report_end_day`), not rows. The
  // real per-user file is a TRAILING 28-day aggregate ending at the active
  // scenario's "now" (getActiveAsOfDate -- SIM_CURRENT_DATE for the default
  // 'healthy' scenario), one record per user, never filterable to the
  // billing cycle (CLAUDE.md-brief's cycle-accuracy ruling) -- callers that
  // need cycle-accurate per-user totals must fan out over users-1-day
  // instead (below).
  http.get(`${ENTERPRISE_BASE}/copilot/metrics/reports/users-28-day/latest`, () => {
    const { start, end } = trailingWindow(getActiveAsOfDate(), 28);
    return HttpResponse.json({
      download_links: [`${DOWNLOAD_HOST}/reports/users-28-day/latest.json`],
      report_start_day: start,
      report_end_day: end,
    });
  }),

  // R6: `users-1-day?day=YYYY-MM-DD` -- same envelope shape, one calendar
  // day. A day with no fixture rows still 200s with an EMPTY file (not a
  // 404); a malformed/missing `day` is the one case that 400s.
  http.get(`${ENTERPRISE_BASE}/copilot/metrics/reports/users-1-day`, ({ request }) => {
    const url = new URL(request.url);
    const day = url.searchParams.get('day');
    if (!day || !isValidCalendarDate(day)) {
      return githubError(400, "Invalid 'day' parameter -- expected YYYY-MM-DD");
    }
    return HttpResponse.json({
      download_links: [`${DOWNLOAD_HOST}/reports/users-1-day/${day}.json`],
      report_start_day: day,
      report_end_day: day,
    });
  }),

  // Companion file host for the two envelopes above (R6): a stateless,
  // deterministic re-derivation from the SAME CREDITS_USED_ITEMS /
  // HISTORICAL_CREDITS_USED_ITEMS fixtures the old bare-array endpoint read,
  // so every committed per-user sum survives the reshape. Two distinct route
  // patterns (not one shared `:report/:file`) because the two files need
  // different aggregation, not just different filenames. Emission is JSONL
  // (live-pinned 2026-07-08 -- see the R6 block comment above); an empty day
  // emits an empty body, matching sniffReportFormat('') === 'empty'.
  http.get(`${DOWNLOAD_HOST}/reports/users-1-day/:dayFile`, ({ params }) => {
    const day = (params.dayFile as string).replace(/\.json$/, '');
    const rows = allCreditsUsedItems().filter((item) => item.date === day);
    return jsonlResponse(rows.map(toReportRecord));
  }),

  http.get(`${DOWNLOAD_HOST}/reports/users-28-day/latest.json`, () => {
    const { start, end } = trailingWindow(getActiveAsOfDate(), 28);
    const inWindow = allCreditsUsedItems().filter((item) => item.date >= start && item.date <= end);

    const totals = new Map<string, { user_id: string; user_login: string; ai_credits_used: number }>();
    for (const row of inWindow) {
      const existing = totals.get(row.user_login);
      if (existing) existing.ai_credits_used += row.ai_credits_used;
      else totals.set(row.user_login, { user_id: row.user_id, user_login: row.user_login, ai_credits_used: row.ai_credits_used });
    }
    return jsonlResponse(Array.from(totals.values()));
  }),
];
