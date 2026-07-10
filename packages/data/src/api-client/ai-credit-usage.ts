import type { Octokit } from 'octokit';

// Typed wrapper for the enterprise billing AI-credit usage report
// (`GET /enterprises/{enterprise}/settings/billing/ai_credit/usage`), used by
// github-impl.ts's monthly per-user backfill fan-out.
//
// §6.9 API-surface validation: this endpoint is ALREADY machine-verified against
// GitHub's published OpenAPI description (github/rest-api-description,
// ghec.2026-03-10.json) -- see docs/api-surface-validation.md rows **N1** and
// the **"Live-read smoke R7"** section. No NEW endpoint, path, or query param is
// introduced here (the backfill uses only `year`/`month` integers and the
// `user` string, all pinned in that entry); this module merely gives the
// already-verified surface a typed, reusable call site. The types below mirror
// the OpenAPI schema verbatim: query params `year`/`month`/`day` (integer),
// `organization`/`user`/`model`/`product`/`cost_center_id` (string), all
// optional; response envelope `{ timePeriod{year,month?,day?}, enterprise, user?,
// organization?, product?, model?, costCenter?{id,name}, usageItems[] }` with
// items carrying 11 required camelCase fields; NO per-item user field, NO
// per-item date, NO pagination (a single-object response). Per-user granularity
// is therefore a per-user FAN-OUT via `?user=`, not a single itemized call.

const AI_CREDIT_USAGE_PATH = 'GET /enterprises/{enterprise}/settings/billing/ai_credit/usage';

/** One usage line item -- all 11 fields REQUIRED per the OpenAPI (camelCase confirmed). Aggregated by (sku, model); carries no user or date. */
export interface AiCreditUsageLineItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

/** The report envelope. `timePeriod` carries the date grain; `user` echoes the `?user=` filter scope. */
export interface AiCreditUsageReport {
  timePeriod: { year: number; month?: number; day?: number };
  enterprise: string;
  user?: string;
  organization?: string;
  product?: string;
  model?: string;
  costCenter?: { id: string; name: string };
  usageItems: AiCreditUsageLineItem[];
}

/** The query window (a subset of the OpenAPI's optional params -- the only ones the backfill needs). */
export interface AiCreditUsageQuery {
  year: number;
  month: number;
  day?: number;
  /** The per-user fan-out filter (a seat login). Absent === the unfiltered month aggregate. */
  user?: string;
  /**
   * The per-cost-center fan-out filter (migration 0008 daily backfill). Absent
   * === the enterprise/tenant-total aggregate. Same already-verified surface:
   * `cost_center_id` (string, optional) is one of the OpenAPI query params this
   * endpoint accepts (docs/api-surface-validation.md N1 / live-read smoke R7 --
   * the machine-verified param list is year/month/day integers +
   * organization/user/model/product/cost_center_id strings). No NEW endpoint or
   * param is introduced by adding it here.
   */
  cost_center_id?: string;
}

/**
 * Fetch one AI-credit usage report for the given window. `usageItems` is
 * defensively normalized to an array so a malformed/empty envelope never throws
 * downstream (an empty items array is a legitimate "no usage" response and the
 * caller's era-floor stop condition).
 */
export async function fetchAiCreditUsage(
  octokit: Octokit,
  enterprise: string,
  query: AiCreditUsageQuery,
): Promise<AiCreditUsageReport> {
  const response = await octokit.request(AI_CREDIT_USAGE_PATH, { enterprise, ...query });
  const data = (response as { data?: unknown }).data as Partial<AiCreditUsageReport> | null;
  const usageItems = data && Array.isArray(data.usageItems) ? data.usageItems : [];
  return { ...(data ?? {}), usageItems } as AiCreditUsageReport;
}

/**
 * Sum `netQuantity` over EVERY item (no product/sku filter). This endpoint is
 * DEDICATED to AI credits, so every returned item is an AI-credit line by
 * construction -- and its own product label is 'Copilot' (capital C) vs the R5
 * general billing/usage endpoint's 'copilot', so a borrowed R5-style filter
 * would match zero items and hide all credits (the live-probe finding, 2026-07-10).
 * netQuantity is the pool+metered credit count either way.
 */
export function sumNetQuantity(report: Pick<AiCreditUsageReport, 'usageItems'>): number {
  return report.usageItems.reduce((sum, item) => sum + (item.netQuantity ?? 0), 0);
}
