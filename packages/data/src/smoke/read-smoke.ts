import type { Octokit } from 'octokit';
import { fetchUsersReport } from '../api-client/users-report.js';

// Task 9.2-prep: the live read-surface smoke runner. Given a configured
// Octokit client + enterprise slug, it issues reads against each hand-wrapped
// enterprise billing/budget endpoint in the §6.9 inventory (rows R1-R6) and
// structurally reconciles the response against the shapes github-impl.ts codes
// to. The per-endpoint report it returns IS the work order: each row says
// whether real GitHub's wire shape matches what we parse, and where it diverges.
//
// Reconciled against the wire contract (wire-contract-r3-r5-r6.md, pinned
// against the 2026-07-08 authenticated live run):
//   R3 -> GET .../cost-centers/{id} (get-one), embedded resources[] (no
//         GET .../resource endpoint exists; disproven live 2026-07-08, 404).
//   R5 -> camelCase usage items ({date, quantity, netAmount, discountAmount});
//         default call excludes cost-center usage, so a per-CC call is what
//         surfaces a non-empty sample.
//   R6 -> users-28-day/latest + users-1-day return a download-link envelope;
//         the per-user records live in the file behind download_links. This
//         runner follows the first link and reports the real format +
//         first-record keys so the maintainer can pin the (undocumented) file
//         format on the next live run.
//
// MODE-AGNOSTIC on purpose: unit-tested against MSW today (proves the plumbing
// before a PAT exists), runs against live GitHub once a real client is passed.
// The refusal-in-sim-mode gate lives one layer up, on ApiClient.runLiveReadSmoke().

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
// us" divergence we want the smoke to catch).
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

// Checks up to the first item and returns its problems (a shape divergence is
// systemic, not per-row). An empty list is reported as ok (a valid empty list
// is not a shape failure).
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

interface SmokeEndpoint {
  key: string;
  docRef: string;
  endpoint: string;
  path: string;
  extract: (data: unknown) => unknown[];
  fields: Record<string, FieldType>;
}

// R1/R2/R4 are independent, single-call, enveloped list reads. R3/R5/R6 are
// custom (dependent or multi-call) and run explicitly below.
const INDEPENDENT_ENDPOINTS: SmokeEndpoint[] = [
  {
    key: 'seats',
    docRef: 'R1',
    endpoint: '/enterprises/{enterprise}/copilot/billing/seats',
    path: 'GET /enterprises/{enterprise}/copilot/billing/seats',
    extract: (d) => (d as { seats?: unknown[] }).seats ?? [],
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
];

// The row references this runner covers, exported so a caller/test can assert
// the smoke stays aligned with the §6.9 inventory.
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

// R3: get ONE cost center (a real endpoint) and structurally check the EMBEDDED
// resources[] items for {type, name}. The old GET .../resource path was
// disproven live 2026-07-08 (404) -- it only accepts POST/DELETE.
async function runR3(octokit: Octokit, enterprise: string): Promise<ReadSmokeEndpointResult> {
  const path = 'GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}';
  try {
    const listResponse = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', { enterprise });
    const costCenters = (listResponse.data as { costCenters?: Array<{ id?: unknown }> }).costCenters ?? [];
    const firstId = costCenters.find((c) => typeof c.id === 'string')?.id as string | undefined;
    if (!firstId) {
      return { endpoint: path, docRef: 'R3', status: 'skipped', details: 'no cost center available to read a member roster from' };
    }
    const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}', {
      enterprise,
      cost_center_id: firstId,
    });
    const resources = (response.data as { resources?: unknown[] }).resources ?? [];
    const { status, details } = summarizeItems(resources, { type: 'string', name: 'string' });
    return { endpoint: path, docRef: 'R3', status, details: `cost_center ${firstId} embedded resources[]: ${details}` };
  } catch (err) {
    return { endpoint: path, docRef: 'R3', status: 'http_error', details: httpErrorDetails(err) };
  }
}

// R5: camelCase usage items. The default (no cost_center_id) call returns ONLY
// cost-center-unassociated usage, so a per-cost-center call is what surfaces a
// non-empty sample to check the camelCase field spec against.
async function runR5(octokit: Octokit, enterprise: string): Promise<ReadSmokeEndpointResult> {
  const path = 'GET /enterprises/{enterprise}/settings/billing/usage';
  const spec: Record<string, FieldType> = { date: 'string', quantity: 'number', netAmount: 'number', discountAmount: 'number' };
  try {
    const defaultResponse = await octokit.request('GET /enterprises/{enterprise}/settings/billing/usage', { enterprise });
    const defaultItems = (defaultResponse.data as { usageItems?: unknown[] }).usageItems ?? [];

    const listResponse = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', { enterprise });
    const costCenters = (listResponse.data as { costCenters?: Array<{ id?: unknown }> }).costCenters ?? [];
    const firstId = costCenters.find((c) => typeof c.id === 'string')?.id as string | undefined;

    let ccPart: string;
    let ccStatus: ReadSmokeStatus = 'ok';
    if (!firstId) {
      ccPart = 'no cost center available for a per-CC sample';
    } else {
      const ccResponse = await octokit.request('GET /enterprises/{enterprise}/settings/billing/usage', {
        enterprise,
        cost_center_id: firstId,
      });
      const ccItems = (ccResponse.data as { usageItems?: unknown[] }).usageItems ?? [];
      const summary = summarizeItems(ccItems, spec);
      ccStatus = summary.status;
      ccPart = `cost_center ${firstId}: ${summary.details}`;
    }

    return {
      endpoint: path,
      docRef: 'R5',
      status: ccStatus,
      details: `default call: ${defaultItems.length} cost-center-unassociated item(s); ${ccPart}`,
    };
  } catch (err) {
    return { endpoint: path, docRef: 'R5', status: 'http_error', details: httpErrorDetails(err) };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// R6: the per-user metrics reports return a download-link ENVELOPE; the records
// live in the file behind download_links (format undocumented). This row's
// output IS the format pin: it follows the first link and reports
// format=<json|jsonl|csv> + first-record keys, and also exercises users-1-day.
async function runR6(octokit: Octokit, enterprise: string, probeDay: string): Promise<ReadSmokeEndpointResult> {
  const path = 'GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest';
  try {
    const latest = await fetchUsersReport(octokit, enterprise, 'users-28-day');
    if (!isStringArray(latest.envelope.download_links)) {
      return {
        endpoint: path,
        docRef: 'R6',
        status: 'shape_mismatch',
        details: 'users-28-day/latest: envelope missing a string[] "download_links"',
      };
    }
    const firstRecordKeys = latest.records[0] ? Object.keys(latest.records[0]) : [];
    const latestPart = `users-28-day/latest: format=${latest.format}, first-record keys=[${firstRecordKeys.join(', ')}] (${latest.records.length} record(s))`;

    const oneDay = await fetchUsersReport(octokit, enterprise, 'users-1-day', { day: probeDay });
    if (!isStringArray(oneDay.envelope.download_links)) {
      return {
        endpoint: path,
        docRef: 'R6',
        status: 'shape_mismatch',
        details: `${latestPart}; users-1-day?day=${probeDay}: envelope missing a string[] "download_links"`,
      };
    }
    const oneDayPart = `users-1-day?day=${probeDay}: format=${oneDay.format}, envelope ok (${oneDay.records.length} record(s))`;

    return { endpoint: path, docRef: 'R6', status: 'ok', details: `${latestPart}; ${oneDayPart}` };
  } catch (err) {
    return { endpoint: path, docRef: 'R6', status: 'http_error', details: httpErrorDetails(err) };
  }
}

// `probeDay` (YYYY-MM-DD) is the users-1-day day the R6 row exercises -- an
// elapsed cycle day supplied by the caller's clock seam (never wall-clock in
// sim). Defaults to today for a bare live invocation.
export async function runReadSmoke(
  octokit: Octokit,
  enterprise: string,
  probeDay: string = new Date().toISOString().slice(0, 10),
): Promise<ReadSmokeEndpointResult[]> {
  const [r1, r2, r4] = await Promise.all(INDEPENDENT_ENDPOINTS.map((ep) => runOne(octokit, enterprise, ep)));
  const r3 = await runR3(octokit, enterprise);
  const r5 = await runR5(octokit, enterprise);
  const r6 = await runR6(octokit, enterprise, probeDay);

  // Inventory order: R1, R2, R3, R4, R5, R6.
  return [r1!, r2!, r3, r4!, r5, r6];
}
