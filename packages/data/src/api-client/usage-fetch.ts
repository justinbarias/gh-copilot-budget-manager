import type { Octokit } from 'octokit';
import { paginateAll } from './paginate.js';

// R5 reconciliation (wire-contract-r3-r5-r6.md, 2026-07-08 live smoke): the
// enterprise billing usage report
// (`GET /enterprises/{enterprise}/settings/billing/usage`) returns camelCase
// items and carries NEITHER `user_login` NOR `cost_center_id` on the items
// themselves. Cost-center identity comes ONLY from the query that returned an
// item, and -- per GitHub's docs -- "by default this endpoint will return
// usage that does not have a cost center". So the correct enterprise-wide read
// is a fan-out: ONE default (unassociated) call + ONE call per known
// cost-center id, attributing each response's items to the cost center whose
// id was queried. A single unfiltered call would silently undercount (it omits
// all cost-center-attributed usage).
//
// Shared by api-client/github-impl.ts (getUsageSummary/syncNow/forecast fetch)
// and write/live-state.ts (assembleUsageState). It imports only paginate.ts +
// the Octokit type, so both cycle-adjacent modules can depend on it without a
// module cycle (same rationale as paginate.ts's own doc comment).

const USAGE_PATH = '/enterprises/{enterprise}/settings/billing/usage';

// ---------------------------------------------------------------------------
// AI-credit sku filter (live-pinned 2026-07-08, third smoke run's R5
// inventory). The usage endpoint returns EVERY enhanced-billing product; on
// the maintainer's tenant three Copilot skus coexist:
//   copilot / "Copilot AI Credits"       <- THE pool/metered meter (this one)
//   copilot / "Copilot Business"        <- seat licenses (pure metered $)
//   copilot / "Copilot Premium Request" <- a separate meter, own allowance
// Deriving pool/metered from unfiltered items polluted every rollup with the
// whole GitHub bill (the 0-pool / $64k-phantom-metered dashboard). Pool/
// metered/forecast money math therefore filters to EXACTLY this (product,
// sku) pair -- CASE-SENSITIVE, verbatim from the live inventory pin (title
// case with spaces; NOT the PRD's guessed 'ai_credits'; exact match because
// sku strings are opaque platform identifiers, and a fuzzy match could
// silently swallow a future "Copilot AI Credits (something)" sku whose
// billing semantics we have not verified). Maintainer decision: pool/metered
// derive from "Copilot AI Credits" ONLY.
// ---------------------------------------------------------------------------
export const COPILOT_PRODUCT = 'copilot';
export const AI_CREDITS_SKU = 'Copilot AI Credits';

export function isAiCreditUsageItem(item: Pick<WireUsageItem, 'product' | 'sku'>): boolean {
  return item.product === COPILOT_PRODUCT && item.sku === AI_CREDITS_SKU;
}

/** The derivation-boundary filter every pool/metered/forecast consumer applies (fetches stay RAW -- see github-impl syncNow's persist-raw ruling). */
export function aiCreditItems<T extends Pick<WireUsageItem, 'product' | 'sku'>>(items: readonly T[]): T[] {
  return items.filter(isAiCreditUsageItem);
}

// The camelCase item shape real GitHub returns (2026-03-10). `net_amount`/
// `discount_amount`/`gross_amount` (our old snake_case parse) do not exist on
// the wire -- reading them yielded `Math.round(undefined * 100) === NaN`
// through every money rollup, which is exactly what the live smoke caught.
export interface WireUsageItem {
  date: string; // YYYY-MM-DD
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  pricePerUnit: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  organizationName: string;
  repositoryName?: string;
}

// A wire item tagged with the cost center it was attributed to -- from the
// QUERY that returned it (or null for the default/unassociated call), NEVER
// from an item field (there is none). This tag is the only cost-center signal
// downstream rollups can trust post-reconciliation.
export interface AttributedUsageItem extends WireUsageItem {
  costCenterId: string | null;
}

function extractUsageItems(data: unknown): WireUsageItem[] {
  return (data as { usageItems?: WireUsageItem[] }).usageItems ?? [];
}

// The default (no cost_center_id) call -- returns ONLY cost-center-unassociated
// usage per GitHub's docs. `extra` carries any year/month/day window params.
export async function fetchUsageDefault(
  octokit: Octokit,
  enterprise: string,
  extra: Record<string, string | number | undefined> = {},
): Promise<AttributedUsageItem[]> {
  const raw = await paginateAll<WireUsageItem>(octokit, USAGE_PATH, { enterprise, ...extra }, extractUsageItems);
  return raw.map((item) => ({ ...item, costCenterId: null }));
}

// One cost center's usage -- `cost_center_id=<id>`; every returned item is
// attributed to that id (the query is the sole source of that identity).
export async function fetchUsageForCostCenter(
  octokit: Octokit,
  enterprise: string,
  costCenterId: string,
  extra: Record<string, string | number | undefined> = {},
): Promise<AttributedUsageItem[]> {
  const raw = await paginateAll<WireUsageItem>(
    octokit,
    USAGE_PATH,
    { enterprise, cost_center_id: costCenterId, ...extra },
    extractUsageItems,
  );
  return raw.map((item) => ({ ...item, costCenterId }));
}

// Enterprise-wide read = default (unassociated) + one call per known cost
// center. The union is every usage item exactly once, each correctly
// attributed. `extra` (e.g. `{ year }`) applies uniformly to all calls.
export async function fetchUsageFanout(
  octokit: Octokit,
  enterprise: string,
  costCenterIds: readonly string[],
  extra: Record<string, string | number | undefined> = {},
): Promise<AttributedUsageItem[]> {
  const [unassociated, ...perCostCenter] = await Promise.all([
    fetchUsageDefault(octokit, enterprise, extra),
    ...costCenterIds.map((id) => fetchUsageForCostCenter(octokit, enterprise, id, extra)),
  ]);
  return [...unassociated, ...perCostCenter.flat()];
}
