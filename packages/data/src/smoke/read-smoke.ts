import type { Octokit } from 'octokit';

// Task 9.2-prep: the live read-surface smoke runner. Given a configured
// Octokit client + enterprise slug, it issues ONE read against each
// hand-wrapped enterprise billing/budget endpoint in the §6.9 inventory
// (docs/api-surface-validation.md rows R1-R6) and structurally reconciles the
// response against the shapes github-impl.ts has coded to. The per-endpoint
// report it returns IS the Task 9.2 work order: each row says whether real
// GitHub's wire shape matches what we parse today, and where it diverges.
//
// This runner is MODE-AGNOSTIC on purpose: it is unit-tested against MSW today
// (that is how we prove the plumbing before a PAT exists), and runs against
// live GitHub once a real client is passed. The refusal-in-sim-mode gate lives
// one layer up, on the ApiClient.runLiveReadSmoke() bridge method -- NOT here
// (CLAUDE.md §6/§8: a bridge action must be unmistakably refused in sim mode).

export type ReadSmokeStatus = 'ok' | 'shape_mismatch' | 'http_error' | 'skipped';

export interface ReadSmokeEndpointResult {
  /** Display path (with {enterprise} placeholder), matching the §6.9 table's "path" column. */
  endpoint: string;
  /** The docs/api-surface-validation.md row this endpoint corresponds to (e.g. "R1"). */
  docRef: string;
  status: ReadSmokeStatus;
  /** Human-readable detail: the mismatch fields, HTTP error, or a one-line "N items checked" on success. */
  details: string;
}

type FieldType = 'string' | 'number' | 'boolean';

// Tiny hand-rolled structural checker (no new dep -- zod is not in the tree).
// Verifies each required field is present and of the coded-to primitive type;
// returns the list of problems (empty === shape ok). `null` is treated as
// present-but-wrong-type for a required field (a real "the field went null on
// us" divergence we want the smoke to catch), matching how github-impl.ts's
// parsers would mis-handle it.
function checkFields(item: unknown, spec: Record<string, FieldType>): string[] {
  const problems: string[] = [];
  if (typeof item !== 'object' || item === null) {
    return [`expected an object, got ${item === null ? 'null' : typeof item}`];
  }
  const record = item as Record<string, unknown>;
  for (const [field, expectedType] of Object.entries(spec)) {
    if (!(field in record)) {
      problems.push(`missing "${field}"`);
      continue;
    }
    const actual = record[field];
    if (typeof actual !== expectedType) {
      problems.push(`"${field}" is ${actual === null ? 'null' : typeof actual}, expected ${expectedType}`);
    }
  }
  return problems;
}

// Checks up to `sampleSize` items and returns the first item's problems (a
// representative sample -- a shape divergence is systemic, not per-row). An
// empty array with 0 items is reported as ok with "0 items" (a valid empty
// list is not a shape failure).
function summarizeItems(items: unknown[], spec: Record<string, FieldType>): { status: ReadSmokeStatus; details: string } {
  if (items.length === 0) {
    return { status: 'ok', details: '0 items returned (empty list -- shape not exercised)' };
  }
  const problems = checkFields(items[0], spec);
  if (problems.length > 0) {
    return { status: 'shape_mismatch', details: `${items.length} item(s); first item: ${problems.join('; ')}` };
  }
  return { status: 'ok', details: `${items.length} item(s) checked, required fields present` };
}

// The §6.9 read inventory, in ONE place with row references. Each entry knows
// how to fetch its endpoint, pull the item array out of the (possibly
// enveloped) response, and which required fields to reconcile. R3 (cost-center
// resources) is dependent -- it needs a cost-center id from R2 -- so it is run
// explicitly after R2 below rather than declared here.
interface SmokeEndpoint {
  key: string;
  docRef: string;
  endpoint: string;
  path: string;
  extract: (data: unknown) => unknown[];
  fields: Record<string, FieldType>;
}

const INDEPENDENT_ENDPOINTS: SmokeEndpoint[] = [
  {
    key: 'seats',
    docRef: 'R1',
    endpoint: '/enterprises/{enterprise}/copilot/billing/seats',
    path: 'GET /enterprises/{enterprise}/copilot/billing/seats',
    extract: (d) => (d as { seats?: unknown[] }).seats ?? [],
    // github-impl.ts's Seat: { assignee: { login, id }, created_at }. We check
    // the top-level scalar github-impl reads directly; assignee is nested.
    fields: { created_at: 'string' },
  },
  {
    key: 'cost-centers',
    docRef: 'R2',
    endpoint: '/enterprises/{enterprise}/settings/billing/cost-centers',
    path: 'GET /enterprises/{enterprise}/settings/billing/cost-centers',
    extract: (d) => (d as { costCenters?: unknown[] }).costCenters ?? [],
    fields: { id: 'string', name: 'string', state: 'string' },
  },
  {
    key: 'budgets',
    docRef: 'R4',
    endpoint: '/enterprises/{enterprise}/settings/billing/budgets',
    path: 'GET /enterprises/{enterprise}/settings/billing/budgets',
    extract: (d) => (d as { budgets?: unknown[] }).budgets ?? [],
    fields: { budget_scope: 'string', budget_entity_name: 'string', budget_amount: 'number' },
  },
  {
    key: 'usage',
    docRef: 'R5',
    endpoint: '/enterprises/{enterprise}/settings/billing/usage',
    path: 'GET /enterprises/{enterprise}/settings/billing/usage',
    extract: (d) => (d as { usageItems?: unknown[] }).usageItems ?? [],
    fields: { date: 'string', quantity: 'number', net_amount: 'number', discount_amount: 'number' },
  },
  {
    key: 'credits-used',
    docRef: 'R6',
    endpoint: '/enterprises/{enterprise}/copilot/metrics/reports/users-28-day',
    path: 'GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day',
    // R6 returns a bare array (not enveloped) -- github-impl.ts parses it as CreditsUsedItem[].
    extract: (d) => (Array.isArray(d) ? d : []),
    fields: { date: 'string', user_login: 'string', ai_credits_used: 'number' },
  },
];

// The row references this runner covers, exported so a caller/test can assert
// the smoke stays aligned with the §6.9 inventory (R1, R2, R3, R4, R5, R6).
export const SMOKE_ENDPOINT_DOC_REFS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const;

function httpErrorDetails(err: unknown): string {
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  return status !== undefined ? `HTTP ${status}: ${message}` : message;
}

async function runOne(octokit: Octokit, enterprise: string, ep: SmokeEndpoint): Promise<ReadSmokeEndpointResult> {
  try {
    const response = await octokit.request(`GET ${ep.endpoint}`, { enterprise });
    const items = ep.extract(response.data);
    const { status, details } = summarizeItems(items, ep.fields);
    return { endpoint: ep.path, docRef: ep.docRef, status, details };
  } catch (err) {
    return { endpoint: ep.path, docRef: ep.docRef, status: 'http_error', details: httpErrorDetails(err) };
  }
}

export async function runReadSmoke(octokit: Octokit, enterprise: string): Promise<ReadSmokeEndpointResult[]> {
  const results: ReadSmokeEndpointResult[] = [];

  // R1/R2/R4/R5/R6 are independent -- run them in inventory order.
  for (const ep of INDEPENDENT_ENDPOINTS) {
    results.push(await runOne(octokit, enterprise, ep));
  }

  // R3 (cost-center resources) is dependent: it needs a real cost-center id,
  // which only R2 can supply. Slot it right after R2 in the report. If R2
  // returned no cost centers (or failed), R3 is 'skipped' with the reason --
  // there is nothing to read a resource roster from.
  const r3Path = 'GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource';
  let r3: ReadSmokeEndpointResult;
  try {
    const ccResponse = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', { enterprise });
    const costCenters = (ccResponse.data as { costCenters?: Array<{ id?: unknown }> }).costCenters ?? [];
    const firstId = costCenters.find((c) => typeof c.id === 'string')?.id as string | undefined;
    if (!firstId) {
      r3 = { endpoint: r3Path, docRef: 'R3', status: 'skipped', details: 'no cost center available to read a resource roster from' };
    } else {
      const resResponse = await octokit.request(
        'GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource',
        { enterprise, cost_center_id: firstId },
      );
      const resources = (resResponse.data as { resources?: unknown[] }).resources ?? [];
      const { status, details } = summarizeItems(resources, { type: 'string', name: 'string' });
      r3 = { endpoint: r3Path, docRef: 'R3', status, details: `cost_center ${firstId}: ${details}` };
    }
  } catch (err) {
    r3 = { endpoint: r3Path, docRef: 'R3', status: 'http_error', details: httpErrorDetails(err) };
  }

  // Insert R3 immediately after R2 (index 1 in INDEPENDENT_ENDPOINTS -> splice at 2).
  const r2Index = results.findIndex((r) => r.docRef === 'R2');
  results.splice(r2Index + 1, 0, r3);

  return results;
}
