import type { Octokit } from 'octokit';
import { fetchUsageFanout } from '../api-client/usage-fetch.js';
import { downloadReportRecords, type UsersReportEnvelope } from '../api-client/users-report.js';

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

// R1/R4 are independent, single-call, enveloped list reads. R2/R3/R5/R6 are
// custom (pin-dumping, dependent, or multi-call) and run explicitly below.
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

// R2: list cost centers, check the coded-to fields (id/name/state) -- AND dump
// the cap-related raw wire verbatim. The 2026-07-08 live run proved real GHEC
// cost centers carry flat `ai_credit_pool_enabled` + `ai_credit_pool_state`
// instead of the internal `included_usage_cap` shape, leaving two facts
// unpinned: (a) which wire field carries the block-vs-metered overflow choice
// (undocumented anywhere), and (b) the UNITS of ai_credit_pool_state.
// target_amount (USD vs credits -- money-critical). This row's details are the
// pin for both on the maintainer's next run: the first cost-center object's
// full top-level key list, ai_credit_pool_enabled verbatim, the ENTIRE
// ai_credit_pool_state subobject verbatim, and every key whose name suggests
// overflow/exceed/block behavior with its value.
async function runR2(octokit: Octokit, enterprise: string): Promise<ReadSmokeEndpointResult> {
  const path = 'GET /enterprises/{enterprise}/settings/billing/cost-centers';
  try {
    const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', { enterprise });
    const costCenters = (response.data as { costCenters?: unknown[] }).costCenters ?? [];
    const { status, details } = summarizeItems(costCenters, { id: 'string', name: 'string', state: 'string' });
    if (costCenters.length === 0 || typeof costCenters[0] !== 'object' || costCenters[0] === null) {
      return { endpoint: path, docRef: 'R2', status, details };
    }

    const first = costCenters[0] as Record<string, unknown>;
    const parts: string[] = [details];
    parts.push(`first-cc keys=[${Object.keys(first).join(', ')}]`);
    parts.push(`ai_credit_pool_enabled=${'ai_credit_pool_enabled' in first ? JSON.stringify(first.ai_credit_pool_enabled) : '<absent>'}`);
    parts.push(`ai_credit_pool_state=${'ai_credit_pool_state' in first ? JSON.stringify(first.ai_credit_pool_state) : '<absent>'}`);

    // Overflow-candidate sweep: the top-level object AND the pool-state
    // subobject (same scope the parse-layer sniff covers).
    const overflowPattern = /overflow|exceed|block/i;
    const candidates: string[] = [];
    const sweep = (obj: Record<string, unknown>, prefix: string): void => {
      for (const [key, value] of Object.entries(obj)) {
        if (overflowPattern.test(key)) candidates.push(`${prefix}${key}=${JSON.stringify(value)}`);
      }
    };
    sweep(first, '');
    const poolState = first.ai_credit_pool_state;
    if (typeof poolState === 'object' && poolState !== null && !Array.isArray(poolState)) {
      sweep(poolState as Record<string, unknown>, 'ai_credit_pool_state.');
    }
    parts.push(`overflow-suggestive keys: ${candidates.length > 0 ? candidates.join(', ') : 'none'}`);

    return { endpoint: path, docRef: 'R2', status, details: parts.join('; ') };
  } catch (err) {
    return { endpoint: path, docRef: 'R2', status: 'http_error', details: httpErrorDetails(err) };
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

    // (Product, sku) inventory across the FULL fan-out (default + one call per
    // cost center -- the exact read Sync ingestion performs). Live finding
    // (2026-07-08): ingestion has NO product/sku filter, and the live usage
    // endpoint returns EVERY enhanced-billing product (Actions, storage, ...)
    // -- so pool/metered sums are polluted with the whole GitHub bill (0 pool
    // consumed / $64k phantom metered on the maintainer's dashboard). The
    // FILTER is deferred until this inventory pins the real Copilot AI-credit
    // (product, sku) pair (our fixtures' 'copilot'/'ai_credits' is a PRD
    // guess; filtering on a wrong guess would zero real data). One line per
    // distinct pair: n, summed quantity/gross/discount/net.
    const ccIds = costCenters.map((c) => c.id).filter((id): id is string => typeof id === 'string');
    const allItems = await fetchUsageFanout(octokit, enterprise, ccIds);
    const skuInventory = summarizeSkuInventory(allItems);

    return {
      endpoint: path,
      docRef: 'R5',
      status: ccStatus,
      details: `default call: ${defaultItems.length} cost-center-unassociated item(s); ${ccPart}; skus: ${skuInventory}`,
    };
  } catch (err) {
    return { endpoint: path, docRef: 'R5', status: 'http_error', details: httpErrorDetails(err) };
  }
}

// One compact line per distinct (product, sku) pair, name-sorted for
// deterministic output: `<product>/<sku> n=<items> qty=<Σquantity>
// gross=<Σ$> disc=<Σ$> net=<Σ$>`.
function summarizeSkuInventory(
  items: ReadonlyArray<{ product?: string; sku?: string; quantity?: number; grossAmount?: number; discountAmount?: number; netAmount?: number }>,
): string {
  if (items.length === 0) return '(no usage items)';
  const byPair = new Map<string, { n: number; qty: number; gross: number; disc: number; net: number }>();
  for (const item of items) {
    const key = `${item.product ?? '<no-product>'}/${item.sku ?? '<no-sku>'}`;
    const acc = byPair.get(key) ?? { n: 0, qty: 0, gross: 0, disc: 0, net: 0 };
    acc.n += 1;
    acc.qty += item.quantity ?? 0;
    acc.gross += item.grossAmount ?? 0;
    acc.disc += item.discountAmount ?? 0;
    acc.net += item.netAmount ?? 0;
    byPair.set(key, acc);
  }
  return [...byPair.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, s]) => `${key} n=${s.n} qty=${s.qty} gross=${s.gross.toFixed(2)} disc=${s.disc.toFixed(2)} net=${s.net.toFixed(2)}`)
    .join('; ');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// R6: DECISIVE multi-variant probe (2026-07-08 second live smoke: the
// documented `users-28-day/latest` route 400'd with a day-parse error on the
// maintainer's tenant -- its router serves `/users-28-day/{day}` and has no
// literal `/latest`; docs still say otherwise). Each of the FOUR candidate
// wire forms is attempted INDEPENDENTLY (raw octokit.request, deliberately
// NOT via fetchUsersReport's fallback memo -- the probe's job is to pin the
// tenant's full surface, not to find one working form and stop):
//   28d/latest    GET .../users-28-day/latest              (documented)
//   28d/{day}     GET .../users-28-day/{day}               (observed tenant)
//   1d?day=       GET .../users-1-day?day=YYYY-MM-DD       (documented)
//   1d/{day}      GET .../users-1-day/{day}                (inferred same-router)
// Per-variant OK/HTTP-status is reported in details, plus format= +
// first-record keys from the first variant that returns a valid envelope --
// this output is what pins the tenant's actual metrics-report surface.
async function runR6(octokit: Octokit, enterprise: string, probeDay: string): Promise<ReadSmokeEndpointResult> {
  const path = 'GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest (+ 3 variant probes)';

  interface VariantProbe {
    label: string;
    report: '28d' | '1d';
    request: () => Promise<unknown>;
  }
  const probes: VariantProbe[] = [
    {
      label: '28d/latest',
      report: '28d',
      request: async () =>
        (await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest', { enterprise })).data,
    },
    {
      label: `28d/{${probeDay}}`,
      report: '28d',
      request: async () =>
        (
          await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/{day}', {
            enterprise,
            day: probeDay,
          })
        ).data,
    },
    {
      label: `1d?day=${probeDay}`,
      report: '1d',
      request: async () =>
        (await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day', { enterprise, day: probeDay }))
          .data,
    },
    {
      label: `1d/{${probeDay}}`,
      report: '1d',
      request: async () =>
        (
          await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day/{day}', {
            enterprise,
            day: probeDay,
          })
        ).data,
    },
  ];

  const parts: string[] = [];
  const okByReport = { '28d': false, '1d': false };
  let sawEnvelopeMismatch = false;
  let pinnedEnvelope: UsersReportEnvelope | null = null;
  let pinnedVia: string | null = null;

  for (const probe of probes) {
    try {
      const data = (await probe.request()) as UsersReportEnvelope;
      if (!isStringArray(data.download_links)) {
        sawEnvelopeMismatch = true;
        parts.push(`${probe.label}=ENVELOPE_MISMATCH (no string[] download_links)`);
        continue;
      }
      okByReport[probe.report] = true;
      parts.push(`${probe.label}=OK`);
      if (!pinnedEnvelope) {
        pinnedEnvelope = data;
        pinnedVia = probe.label;
      }
    } catch (err) {
      parts.push(`${probe.label}=${httpErrorDetails(err)}`);
    }
  }

  // Format pin from the first working variant's envelope. A download-link
  // failure is tracked separately from the envelope mismatches: it must
  // downgrade the row even when every variant's ENVELOPE was reachable --
  // otherwise an "ok" row would mask a failed format pin (this row's whole
  // job), and the maintainer would have no cue to capture it. (Validator
  // hardening, 2026-07-08.)
  let downloadFailed = false;
  if (pinnedEnvelope) {
    try {
      const { records, format } = await downloadReportRecords(pinnedEnvelope);
      const firstRecordKeys = records[0] ? Object.keys(records[0]) : [];
      parts.push(`format=${format}, first-record keys=[${firstRecordKeys.join(', ')}] (${records.length} record(s), via ${pinnedVia})`);
    } catch (err) {
      parts.push(`download-link fetch failed: ${httpErrorDetails(err)}`);
      downloadFailed = true;
    }
  }

  const bothReportsReachable = okByReport['28d'] && okByReport['1d'];
  const status: ReadSmokeStatus =
    bothReportsReachable && !downloadFailed ? 'ok' : sawEnvelopeMismatch || downloadFailed ? 'shape_mismatch' : 'http_error';
  return { endpoint: path, docRef: 'R6', status, details: parts.join('; ') };
}

// `probeDay` (YYYY-MM-DD) is the day the R6 variant probes exercise -- an
// elapsed cycle day supplied by the caller's clock seam (never wall-clock in
// sim). Defaults to YESTERDAY (UTC) for a bare live invocation: the most
// recent day whose report can be expected to exist and be complete (today's
// may not be generated yet).
export async function runReadSmoke(
  octokit: Octokit,
  enterprise: string,
  probeDay: string = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
): Promise<ReadSmokeEndpointResult[]> {
  const [r1, r4] = await Promise.all(INDEPENDENT_ENDPOINTS.map((ep) => runOne(octokit, enterprise, ep)));
  const r2 = await runR2(octokit, enterprise);
  const r3 = await runR3(octokit, enterprise);
  const r5 = await runR5(octokit, enterprise);
  const r6 = await runR6(octokit, enterprise, probeDay);

  // Inventory order: R1, R2, R3, R4, R5, R6.
  return [r1!, r2, r3, r4!, r5, r6];
}
