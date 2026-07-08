import { AI_CREDITS_SKU, COPILOT_BUSINESS_SKU, COPILOT_PREMIUM_REQUEST_SKU, type UsageItem } from './usage.js';

// ============================================================================
// LIVE-GRAIN usage world -- the maintainer's 2026-07-09 live smoke pinned
// THREE R5 semantics the canonical per-day world diverges from:
//
//   (1) GRAIN: live items are MONTHLY AGGREGATES -- one row per month x
//       bucket, dated first-of-month -- never per-day rows.
//   (2) DATES: live dates carry ISO time suffixes ("2026-06-01T00:00:00Z"),
//       not bare "YYYY-MM-DD".
//   (3) SPAN: the unparameterized call returns YEAR-TO-DATE months.
//       Verbatim pin: AI Credits [2026-06-01T00:00:00Z x4,
//       2026-07-01T00:00:00Z x3]; Business [2026-01-01 x3 .. 2026-07-01 x3];
//       Premium [2026-01-01 x3 .. 2026-05-01 x2].
//
// RULING (kept contained, coordinator 2026-07-09): the canonical world
// (fixtures/usage.ts) KEEPS per-day rows with bare dates -- a documented sim
// convention, load-bearing for every committed daily-shape UI/e2e pin. THIS
// world mirrors the live grain verbatim and exists as a permanently-runnable
// regression target for it. The impl parse/aggregation layer is
// GRAIN-AGNOSTIC + date-normalizing, so both worlds exercise the same code.
//
// DELIVERY: served by the SAME usage handler for a DIFFERENT enterprise slug
// (LIVE_GRAIN_ENTERPRISE below) -- deliberately NOT a scenario-selector
// entry: the renderer-facing ScenarioId/ScenarioSummary surface (and its
// four-entry selector, with committed e2e pins) stays untouched, and impl
// tests reach this world by pointing a client at the slug. Stateless and
// deterministic like everything else here; anchored to the smoke date
// (July 2026 = current month), independent of the scenario clock.
//
// Every row is cost-center-UNASSOCIATED (cost_center_id null), matching the
// live smoke's unparameterized (default) call, so the default view returns
// the full YTD set and a cost_center_id-filtered call returns nothing.
//
// HAND-COMPUTABLE VALUES (all gross = quantity x the sku's pinned rate;
// magnitudes per the maintainer's neighborhood: June AI disc ~= $2,4xx, July
// MTD AI disc ~= $1,4xx):
//
//   Copilot AI Credits ($0.01/credit) -- June (closed) x4 org buckets:
//     digital  qty 90,000 -> gross 900.00, disc 900.00, net 0
//     data     qty 70,000 -> gross 700.00, disc 700.00, net 0
//     corp     qty 50,000 -> gross 500.00, disc 500.00, net 0
//     platform qty 30,000 -> gross 300.00, disc 300.00, net 0
//     June totals: qty 240,000, disc $2,400.00, net $0.
//   Copilot AI Credits -- July MTD x3 org buckets:
//     digital qty 70,000 -> 700.00 · data qty 50,000 -> 500.00 ·
//     corp qty 25,000 -> 250.00; July totals: qty 145,000, disc $1,450.00.
//   Copilot Business ($19/seat-month) -- Jan..Jul (7 months) x3 buckets,
//     constant per month (gross == net, disc 0; fractional seats):
//     digital 20.50 -> 389.50 · data 12.25 -> 232.75 · corp 8.25 -> 156.75
//     per-month totals: qty 41.00, gross $779.00;
//     YTD totals: 21 rows, qty 287.00, gross $5,453.00.
//   Copilot Premium Request ($0.04/request) -- Jan..May (5 months) x2
//     buckets, constant per month (own discount/net split):
//     digital qty 1,000.25 -> gross 40.01, disc 30.00, net 10.01
//     data    qty   500.50 -> gross 20.02, disc 15.00, net  5.02
//     per-month totals: qty 1,500.75, gross $60.03, disc $45.00, net $15.03;
//     YTD totals: 10 rows, qty 7,503.75, gross $300.15, disc $225.00,
//     net $75.15.
//
//   Grand total: 7 + 21 + 10 = 38 rows.
// ============================================================================

/** Requests for this enterprise slug get the live-grain monthly world. */
export const LIVE_GRAIN_ENTERPRISE = 'dewr-live';

const ORG_DIGITAL = 'dewr-digital';
const ORG_DATA = 'dewr-data';
const ORG_CORP = 'dewr-corporate';
const ORG_PLATFORM = 'dewr-platform';

// First-of-month ISO datetime, exactly as the live wire carries it (pin #2).
function monthStart(month: number): string {
  return `2026-${String(month).padStart(2, '0')}-01T00:00:00Z`;
}

interface MonthlyBucket {
  organization: string;
  quantity: number;
  gross: number;
  disc: number;
  net: number;
}

function monthlyRows(sku: string, months: readonly number[], buckets: readonly MonthlyBucket[]): UsageItem[] {
  return months.flatMap((month) =>
    buckets.map((b) => ({
      date: monthStart(month),
      product: 'copilot',
      sku,
      cost_center_id: null,
      user_login: null,
      quantity: b.quantity,
      gross_amount: b.gross,
      discount_amount: b.disc,
      net_amount: b.net,
      organization_name: b.organization,
    })),
  );
}

export const LIVE_GRAIN_USAGE_ITEMS: UsageItem[] = [
  // AI credits: June (closed month) x4 buckets -- disc $2,400.00 total.
  ...monthlyRows(AI_CREDITS_SKU, [6], [
    { organization: ORG_DIGITAL, quantity: 90_000, gross: 900, disc: 900, net: 0 },
    { organization: ORG_DATA, quantity: 70_000, gross: 700, disc: 700, net: 0 },
    { organization: ORG_CORP, quantity: 50_000, gross: 500, disc: 500, net: 0 },
    { organization: ORG_PLATFORM, quantity: 30_000, gross: 300, disc: 300, net: 0 },
  ]),
  // AI credits: July MTD x3 buckets -- disc $1,450.00 total.
  ...monthlyRows(AI_CREDITS_SKU, [7], [
    { organization: ORG_DIGITAL, quantity: 70_000, gross: 700, disc: 700, net: 0 },
    { organization: ORG_DATA, quantity: 50_000, gross: 500, disc: 500, net: 0 },
    { organization: ORG_CORP, quantity: 25_000, gross: 250, disc: 250, net: 0 },
  ]),
  // Business licenses: Jan..Jul x3 buckets (gross == net, disc 0).
  ...monthlyRows(COPILOT_BUSINESS_SKU, [1, 2, 3, 4, 5, 6, 7], [
    { organization: ORG_DIGITAL, quantity: 20.5, gross: 389.5, disc: 0, net: 389.5 },
    { organization: ORG_DATA, quantity: 12.25, gross: 232.75, disc: 0, net: 232.75 },
    { organization: ORG_CORP, quantity: 8.25, gross: 156.75, disc: 0, net: 156.75 },
  ]),
  // Premium requests: Jan..May x2 buckets (own discount/net split).
  ...monthlyRows(COPILOT_PREMIUM_REQUEST_SKU, [1, 2, 3, 4, 5], [
    { organization: ORG_DIGITAL, quantity: 1_000.25, gross: 40.01, disc: 30, net: 10.01 },
    { organization: ORG_DATA, quantity: 500.5, gross: 20.02, disc: 15, net: 5.02 },
  ]),
];
