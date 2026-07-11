import type { Octokit } from 'octokit';
import { AI_CREDITS_BUDGET_SKU, isAiCreditBudget } from '../api-client/budget-scope.js';
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

// R1 is the one remaining independent, single-call, enveloped list read.
// R2/R3/R4/R5/R6 are custom (pin-dumping, dependent, or multi-call) and run
// explicitly below.
const INDEPENDENT_ENDPOINTS: SmokeEndpoint[] = [
  {
    key: 'seats',
    docRef: 'R1',
    endpoint: '/enterprises/{enterprise}/copilot/billing/seats',
    path: 'GET /enterprises/{enterprise}/copilot/billing/seats',
    extract: (d) => (d as { seats?: unknown[] }).seats ?? [],
    fields: { created_at: 'string' },
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

// R4: budgets list -- field check PLUS the per-budget inventory (open item
// 20's pin for the maintainer's real budget set). One compact line per
// budget: budget_type/budget_product_sku/budget_scope/entity (the `user`
// login for user-scoped budgets) with amount + hard-stop flag, and the
// included/excluded split the AI-credit product filter
// (budget-scope.ts's isAiCreditBudget) would produce over this exact set.
async function runR4(octokit: Octokit, enterprise: string): Promise<ReadSmokeEndpointResult> {
  const path = 'GET /enterprises/{enterprise}/settings/billing/budgets';
  interface SampledBudget {
    budget_type?: string;
    budget_product_sku?: string | null;
    budget_scope: string;
    budget_entity_name?: string | null;
    user?: string | null;
    budget_amount?: number;
    prevent_further_usage?: boolean;
  }
  try {
    const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/budgets', { enterprise });
    const budgets = ((response.data as { budgets?: SampledBudget[] }).budgets ?? []);
    const { status, details } = summarizeItems(budgets, {
      budget_scope: 'string',
      budget_entity_name: 'string',
      budget_amount: 'number',
    });
    if (budgets.length === 0) return { endpoint: path, docRef: 'R4', status, details };

    const inventory = budgets
      .map((b) => {
        const entity = b.budget_scope === 'user' && typeof b.user === 'string' && b.user.length > 0 ? b.user : (b.budget_entity_name ?? '?');
        return `${b.budget_type ?? '?'}/${b.budget_product_sku ?? '<no-sku>'}/${b.budget_scope}/${entity} $${b.budget_amount ?? '?'} stop=${b.prevent_further_usage ?? '?'}`;
      })
      .join('; ');

    const included = budgets.filter(isAiCreditBudget).length;
    const excludedSkus = [...new Set(budgets.filter((b) => !isAiCreditBudget(b)).map((b) => b.budget_product_sku ?? '<no-sku>'))];
    const split = `filter: ${AI_CREDITS_BUDGET_SKU} included=${included}, excluded=${budgets.length - included}${
      excludedSkus.length > 0 ? ` (${excludedSkus.join(', ')})` : ''
    }`;

    return { endpoint: path, docRef: 'R4', status, details: `${details}; ${split}; inventory: ${inventory}` };
  } catch (err) {
    return { endpoint: path, docRef: 'R4', status: 'http_error', details: httpErrorDetails(err) };
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
    const dateHistogram = summarizeDateHistogram(allItems);

    return {
      endpoint: path,
      docRef: 'R5',
      status: ccStatus,
      details: `default call: ${defaultItems.length} cost-center-unassociated item(s); ${ccPart}; skus: ${skuInventory}; dates: ${dateHistogram}`,
    };
  } catch (err) {
    return { endpoint: path, docRef: 'R5', status: 'http_error', details: httpErrorDetails(err) };
  }
}

// Per-sku DATE histogram (2026-07-09 addendum -- the forecast blow-up pin):
// the maintainer's Forecast screen showed P50 cycle-end ~= cycle-to-date total
// x 31, i.e. the run-rate math treated a CUMULATIVE total as a DAILY rate.
// Hypothesis: live R5 items are month-to-date AGGREGATES (their tenant
// returned only n=7 AI-credit items across 8 elapsed days -- one per cost
// center, likely one shared date), not the per-day rows our fixtures model
// and buildDailyBurn assumes. This histogram pins it: per-day feeds show MANY
// distinct dates per sku; an aggregate feed shows ONE date carrying the whole
// count. The granularity fix (per-day ?day= fan-out vs run-rate =
// cumulative/daysElapsed) is deliberately deferred until this output decides.
// Format: `<sku> [date×n, ...]; ...; range=<min>..<max>`.
function summarizeDateHistogram(items: ReadonlyArray<{ sku?: string; date?: string }>): string {
  if (items.length === 0) return '(no usage items)';
  const bySku = new Map<string, Map<string, number>>();
  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const item of items) {
    const sku = item.sku ?? '<no-sku>';
    const date = item.date ?? '<no-date>';
    const dates = bySku.get(sku) ?? new Map<string, number>();
    dates.set(date, (dates.get(date) ?? 0) + 1);
    bySku.set(sku, dates);
    if (item.date) {
      if (minDate === null || item.date < minDate) minDate = item.date;
      if (maxDate === null || item.date > maxDate) maxDate = item.date;
    }
  }
  const perSku = [...bySku.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sku, dates]) => {
      const parts = [...dates.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, n]) => `${date}×${n}`)
        .join(', ');
      return `${sku} [${parts}]`;
    })
    .join('; ');
  return `${perSku}; range=${minDate ?? '?'}..${maxDate ?? '?'}`;
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

// ===========================================================================
// R7: the filterable AI-credit usage report
// (`GET /enterprises/{enterprise}/settings/billing/ai_credit/usage`, + its
// pre-June-billing sibling `.../premium_request/usage`) -- the candidate
// per-user replacement for the R6 metrics-report backfill (which zero-fills
// history past retention; see api-surface-validation.md's 2026-07-11 note).
//
// §6.9 OpenAPI validation (github/rest-api-description, ghec.2026-03-10.json,
// parsed 2026-07-10) -- the endpoint is machine-verified:
//   * BOTH paths exist. Query params (all optional): year/month/day (integer),
//     organization/user/model/product/cost_center_id (string). No page/per_page
//     param and NO Link/pagination header in the schema -> the response is a
//     SINGLE object, never paginated (so there is nothing to page-cap here).
//   * 200 envelope: { timePeriod:{year*,month,day}, enterprise*, user?,
//     organization?, product?, model?, costCenter?:{id*,name*}, usageItems*[] }.
//   * usageItem (all required, CONFIRMED camelCase -- the docs page's camelCase
//     was authoritative): { product, sku, model, unitType, pricePerUnit,
//     grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity,
//     netAmount }.
//   CRITICAL docs-vs-schema finding: items carry NO per-user field and NO
//   per-item date. User granularity is available ONLY via the `user` query
//   param (one call per user, the top-level `user` echoes the scope); date
//   grain is the top-level `timePeriod`, not a per-item column. So this is a
//   FILTERABLE AGGREGATE report, not a per-user-per-day itemized feed -- a
//   single unfiltered call cannot enumerate distinct users. This probe records
//   that mechanism rather than fabricating a distinct-user count off a field
//   that does not exist on the wire.
//
// GITHUB-SOURCE-ONLY: unlike R1-R6, this endpoint has no MSW twin. runReadSmoke
// (unit-tested against MSW) does NOT call it; runLiveReadSmoke appends the R7
// row in its live (github) branch, and refuses whole in simulation like the
// rest of the smoke. §6.6: this row emits only counts/dates/sums/booleans and
// field-NAME lists -- never a user login/id, an enterprise value, or a cost
// center value.
// ===========================================================================

/** The camelCase usage line item real GitHub returns from ai_credit/premium_request usage (all fields optional here -- this is a live probe, defensive to any wire drift). */
export interface AiCreditUsageItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  pricePerUnit?: number;
  grossQuantity?: number;
  grossAmount?: number;
  discountQuantity?: number;
  discountAmount?: number;
  netQuantity?: number;
  netAmount?: number;
  // Defensive: NOT in the OpenAPI schema (items carry no user attribution).
  // Detected only so a future wire that DID add one would be surfaced, not
  // silently missed.
  user?: string;
  user_login?: string;
  userLogin?: string;
}

/** The report envelope. */
export interface AiCreditUsageEnvelope {
  timePeriod?: { year?: number; month?: number; day?: number };
  enterprise?: string;
  user?: string;
  organization?: string;
  product?: string;
  model?: string;
  costCenter?: { id?: string; name?: string };
  usageItems?: AiCreditUsageItem[];
}

const PER_ITEM_USER_KEYS = ['user', 'user_login', 'userLogin'] as const;

/**
 * Per-item user attribution detector. On the machine-verified wire this returns
 * { hasField: false, distinct: 0 } (items are aggregated by sku/model, with no
 * user column). Retained defensively: if a live response ever carried a
 * per-item user field, this counts its distinct values so the divergence
 * surfaces. Counts only -- the login values themselves are NEVER emitted (§6.6).
 */
export function countPerItemUsers(items: readonly AiCreditUsageItem[]): { hasField: boolean; distinct: number } {
  const values = new Set<string>();
  let hasField = false;
  for (const item of items) {
    for (const key of PER_ITEM_USER_KEYS) {
      const v = item[key];
      if (typeof v === 'string' && v.length > 0) {
        hasField = true;
        values.add(v);
      }
    }
  }
  return { hasField, distinct: values.size };
}

/** How user granularity manifests on this response -- the answer to probe #1's core question, as a §6.6-safe phrase (no values). */
function describeUserGranularity(env: AiCreditUsageEnvelope, items: readonly AiCreditUsageItem[]): string {
  const perItem = countPerItemUsers(items);
  if (perItem.hasField) return `per-item user field present (distinct=${perItem.distinct})`;
  const envelopeUserPresent = 'user' in env;
  return `no per-item user field${envelopeUserPresent ? '' : '; no top-level user key'} -- per-user granularity requires the ?user= param (one call per user)`;
}

/**
 * Probe #1 shape record: the envelope key list, the first usageItem key list,
 * the item count, and how user granularity manifests. Keys (field names) are
 * safe to print; values are not, so none are emitted.
 */
export function summarizeAiCreditShape(env: AiCreditUsageEnvelope): string {
  const items = env.usageItems ?? [];
  const envelopeKeys = Object.keys(env);
  const firstItemKeys = items.length > 0 && typeof items[0] === 'object' && items[0] !== null ? Object.keys(items[0]) : [];
  const itemKeysPart = items.length > 0 ? `first-item keys=[${firstItemKeys.join(', ')}]` : 'no usageItems to key-dump';
  return `envelope keys=[${envelopeKeys.join(', ')}]; usageItems=${items.length}; ${itemKeysPart}; ${describeUserGranularity(env, items)}`;
}

// ---------------------------------------------------------------------------
// Per-(product, sku) breakdown (2026-07-10 addendum -- the live-probe finding
// that motivated this file). The rollup used to filter items through
// isAiCreditUsageItem -- a predicate borrowed from the R5 billing-usage SKU
// convention (product 'copilot', sku literally 'Copilot AI Credits'). On the
// maintainer's tenant this DEDICATED ai_credit/premium_request endpoint
// returned items (June rollup: 24; day 2026-06-24: 15; premium_request April:
// 15) but the filter matched ZERO of them -- these are the endpoint's OWN
// product/sku/model labels, which the R5 convention was never proven to
// share (R5 reads a DIFFERENT, general billing/usage endpoint). Filtering hid
// the quantities entirely instead of surfacing what the labels actually are.
// On a report DEDICATED to AI-credit usage, every returned item is relevant
// by construction -- there is nothing to filter. The fix: group by (product,
// sku) and print the labels + per-group sums so the real values are visible
// on the next live run, rather than guessing a filter and re-hiding them.
//
// §6.6 note: product/sku/model strings are GitHub's OWN product labels (e.g.
// "copilot" / "Copilot AI Credits" / "gpt-4.1") -- not tenant data. Printing
// their VALUES is permitted, unlike a user login/id/enterprise/cost-center
// slug (never printed anywhere in this file). Only counts/sums/booleans and
// these product-label values are emitted below.
// ---------------------------------------------------------------------------

interface SkuGroupAgg {
  n: number;
  models: Set<string>;
  netQuantitySum: number;
  netAmountSum: number;
}

function groupBySkuPair(items: readonly AiCreditUsageItem[]): Map<string, SkuGroupAgg> {
  const byPair = new Map<string, SkuGroupAgg>();
  for (const item of items) {
    const key = `${item.product ?? '<no-product>'}/${item.sku ?? '<no-sku>'}`;
    const acc = byPair.get(key) ?? { n: 0, models: new Set<string>(), netQuantitySum: 0, netAmountSum: 0 };
    acc.n += 1;
    if (typeof item.model === 'string' && item.model.length > 0) acc.models.add(item.model);
    acc.netQuantitySum += item.netQuantity ?? 0;
    acc.netAmountSum += item.netAmount ?? 0;
    byPair.set(key, acc);
  }
  return byPair;
}

const SKU_GROUP_CAP = 8;

/**
 * Per-(product, sku) breakdown, name-sorted for determinism, capped at
 * `SKU_GROUP_CAP` groups with a trailing "…N more" note when the tenant
 * carries more distinct pairs than that. One line per group:
 * `product/sku: n=<count> model=<distinct model count> Σnet=<netQuantity sum> Σamt=<netAmount sum>`.
 */
export function summarizePerSkuBreakdown(items: readonly AiCreditUsageItem[]): string {
  if (items.length === 0) return '(no usage items)';
  const byPair = groupBySkuPair(items);
  const sortedKeys = [...byPair.keys()].sort();
  const shown = sortedKeys.slice(0, SKU_GROUP_CAP);
  const lines = shown.map((key) => {
    const g = byPair.get(key)!;
    return `${key}: n=${g.n} model=${g.models.size} Σnet=${g.netQuantitySum} Σamt=${g.netAmountSum.toFixed(2)}`;
  });
  const remaining = sortedKeys.length - shown.length;
  if (remaining > 0) lines.push(`…${remaining} more`);
  return lines.join('; ');
}

/** Total line over ALL returned items (no filter -- every item on this dedicated endpoint is relevant): `items=<n> ΣnetQuantity=<sum> nonzero=<count>`. */
export function summarizeTotalLine(items: readonly AiCreditUsageItem[]): string {
  const netQuantityTotal = items.reduce((sum, i) => sum + (i.netQuantity ?? 0), 0);
  const nonzero = items.filter((i) => (i.netQuantity ?? 0) > 0).length;
  return `items=${items.length} ΣnetQuantity=${netQuantityTotal} nonzero=${nonzero}`;
}

/**
 * Probe #2/#3/#4 rollup: the per-SKU breakdown (see above) plus the overall
 * total line. Replaces the old ai-credit-filtered sum -- see the block
 * comment above for why the filter was wrong on this endpoint.
 */
export function summarizeAiCreditRollup(env: AiCreditUsageEnvelope): string {
  const items = env.usageItems ?? [];
  return `${summarizePerSkuBreakdown(items)}; ${summarizeTotalLine(items)}`;
}

/**
 * Probe #5: the user-scoped fan-out mechanism check. Same per-SKU breakdown +
 * total, plus whether the envelope echoes a top-level `user` key -- but NEVER
 * the login value itself (§6.6; the login that produced this response is not
 * repeated anywhere in the output).
 */
export function summarizeUserScopedProbe(env: AiCreditUsageEnvelope): string {
  const items = env.usageItems ?? [];
  const envelopeUserKeyPresent = 'user' in env;
  return `items=${items.length}, ${summarizePerSkuBreakdown(items)}, envelope user key present=${envelopeUserKeyPresent}`;
}

// One R7 sub-call: a labeled octokit.request against the given usage path with
// the given query window. Each is independently error-reported (like every
// existing probe) and never throws out of the row.
interface AiCreditProbeCall {
  label: string;
  path: 'ai_credit' | 'premium_request';
  params: Record<string, string | number>;
  summarize: (env: AiCreditUsageEnvelope) => string;
}

const AI_CREDIT_PATH = 'GET /enterprises/{enterprise}/settings/billing/ai_credit/usage';
const PREMIUM_REQUEST_PATH = 'GET /enterprises/{enterprise}/settings/billing/premium_request/usage';
const SEATS_PATH = '/enterprises/{enterprise}/copilot/billing/seats';

/**
 * Probe #5's dependency: the FIRST seat's login, fetched with `per_page: 1`
 * (the same already-validated `seats` path R1 reads, standard Octokit-typed
 * pagination param -- no new endpoint or query shape; §6.9-exempt as a
 * reuse of an already-machine-verified surface). Returns `null` if the
 * tenant has no seats to sample. The login is returned to the CALLER only so
 * it can be passed back into the ?user= query param -- it is never rendered
 * into any smoke output (§6.6; see summarizeUserScopedProbe).
 */
async function fetchFirstSeatLogin(octokit: Octokit, enterprise: string): Promise<string | null> {
  const response = await octokit.request(`GET ${SEATS_PATH}`, { enterprise, per_page: 1 });
  const seats = (response.data as { seats?: Array<{ assignee?: { login?: string } }> }).seats ?? [];
  const login = seats[0]?.assignee?.login;
  return typeof login === 'string' && login.length > 0 ? login : null;
}

/**
 * §6.6 defense-in-depth scrub for the user-scoped probe's ERROR path. Success
 * paths emit only booleans/counts/product-labels (never the login), but
 * `httpErrorDetails` echoes an error's `message` verbatim -- and a failing
 * `?user=<login>` request's error text can carry that login (a GitHub
 * validation echo of the query, a network `cause` string embedding the request
 * URL, or any non-Octokit throw). Octokit's own RequestError redacts secrets in
 * `err.request.url` but NOT `err.message`, and we render `err.message`. This
 * removes every occurrence of the sampled login so no error path can leak it.
 * No-op when no login was sampled (seat-fetch failure -- no login was ever
 * sent, so there is nothing tenant-identifying to scrub).
 */
function redactLogin(detail: string, login: string | null): string {
  return login !== null && login.length > 0 ? detail.split(login).join('<redacted-user>') : detail;
}

/**
 * R7 runner. `currentMonth` (year+month from the caller's clock seam, never
 * wall-clock) drives call #1's "current month" window; calls #2/#3 pin
 * JUNE 2026 (the usage-based-billing transition month -- the "is per-user
 * history really there" check) and call #4 pins APRIL 2026 on the
 * premium_request sibling (the pre-June billing era). Call #5 fetches the
 * FIRST seat's login (internally -- see fetchFirstSeatLogin; plumbing the R1
 * seats fetch's result out of runReadSmoke's {status, details} row shape
 * would be more awkward than one extra per_page=1 call) and probes the
 * `?user=` fan-out mechanism against June 2026 -- proving that path end to
 * end before the backfill rewire that depends on it. Returns ONE row whose
 * details carry all five labeled sub-reports.
 */
export async function runR7(
  octokit: Octokit,
  enterprise: string,
  currentMonth: { year: number; month: number },
  yesterday: { year: number; month: number; day: number },
): Promise<ReadSmokeEndpointResult> {
  const endpoint = `${AI_CREDIT_PATH} (+ premium_request/usage)`;
  const yesterdayIso = `${yesterday.year}-${String(yesterday.month).padStart(2, '0')}-${String(yesterday.day).padStart(2, '0')}`;
  const calls: AiCreditProbeCall[] = [
    {
      label: `current[${currentMonth.year}-${String(currentMonth.month).padStart(2, '0')}] shape`,
      path: 'ai_credit',
      params: { year: currentMonth.year, month: currentMonth.month },
      summarize: summarizeAiCreditShape,
    },
    // CURRENT-MONTH DAY-GRAIN evidence probe (live incident 2026-07-11): the only
    // day-grain call ever run was 2026-06-24, a CLOSED month -- current-month
    // day-grain behavior was never verified, and it turned out to return ZERO on
    // this tenant (billing day-grain appears to materialize only for closed
    // months; observed, not spec'd). This probes YESTERDAY (clock-seam, never
    // wall-clock) so the maintainer's next smoke pins current-month day-grain
    // definitively and can watch it settle over time. Rendered like the closed-
    // month day probe below (per-SKU breakdown + total line).
    {
      label: `ai_credit yesterday[${yesterdayIso}] day`,
      path: 'ai_credit',
      params: { year: yesterday.year, month: yesterday.month, day: yesterday.day },
      summarize: summarizeAiCreditRollup,
    },
    {
      label: 'ai_credit June-2026 rollup',
      path: 'ai_credit',
      params: { year: 2026, month: 6 },
      summarize: summarizeAiCreditRollup,
    },
    {
      label: 'ai_credit 2026-06-24 day',
      path: 'ai_credit',
      params: { year: 2026, month: 6, day: 24 },
      summarize: summarizeAiCreditRollup,
    },
    {
      label: 'premium_request April-2026 rollup',
      path: 'premium_request',
      params: { year: 2026, month: 4 },
      summarize: summarizeAiCreditRollup,
    },
  ];

  const parts: string[] = [];
  let sawHttpError = false;
  let sawShapeIssue = false;

  for (const call of calls) {
    const route = call.path === 'ai_credit' ? AI_CREDIT_PATH : PREMIUM_REQUEST_PATH;
    try {
      const response = await octokit.request(route, { enterprise, ...call.params });
      const env = (response as { data?: unknown }).data as AiCreditUsageEnvelope;
      if (env === null || typeof env !== 'object' || !('usageItems' in env)) {
        sawShapeIssue = true;
        parts.push(`${call.label}=SHAPE_MISMATCH (no usageItems in envelope)`);
        continue;
      }
      parts.push(`${call.label}: ${call.summarize(env)}`);
    } catch (err) {
      sawHttpError = true;
      parts.push(`${call.label}=${httpErrorDetails(err)}`);
    }
  }

  // Call #5: the user-scoped fan-out probe (§6.6 -- no login is ever
  // rendered; see fetchFirstSeatLogin + summarizeUserScopedProbe).
  const userScopedLabel = 'user-scoped June probe (first seat)';
  // Hoisted so the catch can scrub it from any error detail (§6.6, redactLogin).
  let sampledLogin: string | null = null;
  try {
    sampledLogin = await fetchFirstSeatLogin(octokit, enterprise);
    if (sampledLogin === null) {
      parts.push(`${userScopedLabel}: skipped (no seat available to sample)`);
    } else {
      const response = await octokit.request(AI_CREDIT_PATH, { enterprise, user: sampledLogin, year: 2026, month: 6 });
      const env = (response as { data?: unknown }).data as AiCreditUsageEnvelope;
      if (env === null || typeof env !== 'object' || !('usageItems' in env)) {
        sawShapeIssue = true;
        parts.push(`${userScopedLabel}=SHAPE_MISMATCH (no usageItems in envelope)`);
      } else {
        parts.push(`${userScopedLabel}: ${summarizeUserScopedProbe(env)}`);
      }
    }
  } catch (err) {
    sawHttpError = true;
    parts.push(`${userScopedLabel}=${redactLogin(httpErrorDetails(err), sampledLogin)}`);
  }

  const status: ReadSmokeStatus = sawHttpError ? 'http_error' : sawShapeIssue ? 'shape_mismatch' : 'ok';
  return { endpoint, docRef: 'R7', status, details: parts.join('; ') };
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
  const [r1] = await Promise.all(INDEPENDENT_ENDPOINTS.map((ep) => runOne(octokit, enterprise, ep)));
  const r2 = await runR2(octokit, enterprise);
  const r3 = await runR3(octokit, enterprise);
  const r4 = await runR4(octokit, enterprise);
  const r5 = await runR5(octokit, enterprise);
  const r6 = await runR6(octokit, enterprise, probeDay);

  // Inventory order: R1, R2, R3, R4, R5, R6.
  return [r1!, r2, r3, r4, r5, r6];
}
