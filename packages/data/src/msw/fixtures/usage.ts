import { COST_CENTER_IDS, ENTERPRISE_SLUG } from './constants.js';

// REAL SKU STRINGS -- live-pinned (maintainer's 2026-07-09 authenticated
// smoke against the real tenant's usage report). The AI-credit sku is the
// title-case "Copilot AI Credits" (product 'copilot'); our old 'ai_credits'
// was a PRD guess. Real tenants ALSO carry "Copilot Business" (license
// spend: gross == net, discount 0) and "Copilot Premium Request" (a separate
// meter with its own discount/net split) rows on the SAME endpoint, with
// FRACTIONAL quantities -- see the POLLUTION FIXTURES appended to
// USAGE_ITEMS below. Pool/metered money math derives from "Copilot AI
// Credits" rows ONLY (maintainer decision, 2026-07-09); the impl-side sku
// filter is written against these exported constants.
export const AI_CREDITS_SKU = 'Copilot AI Credits';
export const COPILOT_BUSINESS_SKU = 'Copilot Business';
export const COPILOT_PREMIUM_REQUEST_SKU = 'Copilot Premium Request';

// Mirrors GitHub's enterprise billing usage/summary item shape (PRD §2.3):
// one row per date/product/SKU/entity, filterable by cost_center_id.
//
// GRAIN -- documented SIM CONVENTION (live-pinned divergence, 2026-07-09
// smoke): the REAL endpoint returns MONTHLY AGGREGATES (one row per month x
// bucket, dated first-of-month with an ISO time suffix, e.g.
// "2026-06-01T00:00:00Z") and its unparameterized call spans YEAR-TO-DATE
// months. This canonical world deliberately keeps PER-DAY rows with bare
// YYYY-MM-DD dates: the daily grain is load-bearing for every committed
// burn-down/sparkline/forecast pin, and the impl parse/aggregation layer is
// grain-agnostic + date-normalizing, so both grains exercise the same code.
// The live monthly grain has its own permanently-runnable regression world:
// fixtures/usage-live-grain.ts (served for LIVE_GRAIN_ENTERPRISE).
export interface UsageItem {
  date: string; // canonical world: YYYY-MM-DD; live-grain world: ISO datetime
  product: string;
  sku: string;
  cost_center_id: string | null;
  user_login: string | null;
  quantity: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  // Per-row organization bucket (live-grain world only): the real monthly
  // aggregate carries one row per month x org bucket, so the live-grain rows
  // pin distinct organizationName values. Canonical rows omit it and fall
  // back to the handler's single-org default.
  organization_name?: string;
}

// Mirrors a row of the Copilot usage metrics API's per-user daily report
// (users-1-day / users-28-day), which carries ai_credits_used as a per-user
// daily total only — not broken down by model or feature (PRD §2.3).
//
// `model` is a simulation-only enrichment (not a documented field on this
// report): it stands in for a best-effort join against the *other* usage
// report that IS broken down by model but NOT by user
// (`.../settings/billing/ai_credit/usage`, PRD §2.3's "pool + additional spend
// by model"). PRD §2.3 point 1: no single API gives per-user x per-model in
// one report -- so some rows legitimately can't be attributed to a model.
// `model: undefined` marks those; the Users screen's model-mix bar surfaces
// that remainder as an explicit "unattributable %" rather than guessing
// (design/README.md, never implying false precision). 2026 Copilot model
// lineup: GPT-5.1, Claude Sonnet 4.5, Claude Opus 4.5 (premium tier),
// Gemini 2.5 Pro, GPT-5 mini.
export interface CreditsUsedItem {
  date: string;
  user_id: string;
  user_login: string;
  ai_credits_used: number;
  model?: string;
}

// BILLING VIEW (drives the Overview enterprise burn-down + the Controls
// per-CC/enterprise metered meters). Each CC's cycle pool draw is itemised as
// discount-covered CC-aggregate rows (user_login null) spread across the June
// weekdays so the burn-down ramps organically; enterprise pool burned by
// 2026-06-14 = Σ(discount_amount × 100) over the cycle = 189,800 of 567,000
// (~33.5%). Payments Integrity (cap-bound) draws its full 56,000 cap from the
// pool then overflows 2,300 into metered (the net_amount > 0 row). The 2026-06-01
// (cycle day 0) row is intentionally absent so the burn-down starts at 0. The
// Aug 31 / Sep 1 rows are the promo→standard allowance-cliff edge fixture
// (spec §1.1): the same user straddling the boundary, still pool-covered the
// day before, tipped into metered the day after -- both fall OUTSIDE the June
// cycle window (cycleBounds(SIM_CURRENT_DATE)), so they never touch the burn-down.
export const USAGE_ITEMS: UsageItem[] = [
  { date: '2026-06-02', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 2876, gross_amount: 28.76, discount_amount: 28.76, net_amount: 0 },
  { date: '2026-06-04', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 4314, gross_amount: 43.14, discount_amount: 43.14, net_amount: 0 },
  { date: '2026-06-05', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 4314, gross_amount: 43.14, discount_amount: 43.14, net_amount: 0 },
  { date: '2026-06-09', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 5753, gross_amount: 57.53, discount_amount: 57.53, net_amount: 0 },
  { date: '2026-06-11', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 7191, gross_amount: 71.91, discount_amount: 71.91, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 5752, gross_amount: 57.52, discount_amount: 57.52, net_amount: 0 },
  { date: '2026-06-02', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.employer, user_login: null, quantity: 1800, gross_amount: 18, discount_amount: 18, net_amount: 0 },
  { date: '2026-06-04', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.employer, user_login: null, quantity: 2700, gross_amount: 27, discount_amount: 27, net_amount: 0 },
  { date: '2026-06-05', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.employer, user_login: null, quantity: 2700, gross_amount: 27, discount_amount: 27, net_amount: 0 },
  { date: '2026-06-09', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.employer, user_login: null, quantity: 3600, gross_amount: 36, discount_amount: 36, net_amount: 0 },
  { date: '2026-06-11', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.employer, user_login: null, quantity: 4500, gross_amount: 45, discount_amount: 45, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.employer, user_login: null, quantity: 3600, gross_amount: 36, discount_amount: 36, net_amount: 0 },
  { date: '2026-06-02', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: null, quantity: 5333, gross_amount: 53.33, discount_amount: 53.33, net_amount: 0 },
  { date: '2026-06-04', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: null, quantity: 8000, gross_amount: 80, discount_amount: 80, net_amount: 0 },
  { date: '2026-06-05', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: null, quantity: 8000, gross_amount: 80, discount_amount: 80, net_amount: 0 },
  { date: '2026-06-09', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: null, quantity: 10667, gross_amount: 106.67, discount_amount: 106.67, net_amount: 0 },
  { date: '2026-06-11', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: null, quantity: 13333, gross_amount: 133.33, discount_amount: 133.33, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: null, quantity: 10667, gross_amount: 106.67, discount_amount: 106.67, net_amount: 0 },
  { date: '2026-06-02', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.dataEval, user_login: null, quantity: 5467, gross_amount: 54.67, discount_amount: 54.67, net_amount: 0 },
  { date: '2026-06-04', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.dataEval, user_login: null, quantity: 8200, gross_amount: 82, discount_amount: 82, net_amount: 0 },
  { date: '2026-06-05', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.dataEval, user_login: null, quantity: 8200, gross_amount: 82, discount_amount: 82, net_amount: 0 },
  { date: '2026-06-09', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.dataEval, user_login: null, quantity: 10933, gross_amount: 109.33, discount_amount: 109.33, net_amount: 0 },
  { date: '2026-06-11', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.dataEval, user_login: null, quantity: 13667, gross_amount: 136.67, discount_amount: 136.67, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.dataEval, user_login: null, quantity: 10933, gross_amount: 109.33, discount_amount: 109.33, net_amount: 0 },
  { date: '2026-06-02', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.cyber, user_login: null, quantity: 1429, gross_amount: 14.29, discount_amount: 14.29, net_amount: 0 },
  { date: '2026-06-04', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.cyber, user_login: null, quantity: 2143, gross_amount: 21.43, discount_amount: 21.43, net_amount: 0 },
  { date: '2026-06-05', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.cyber, user_login: null, quantity: 2143, gross_amount: 21.43, discount_amount: 21.43, net_amount: 0 },
  { date: '2026-06-09', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.cyber, user_login: null, quantity: 2857, gross_amount: 28.57, discount_amount: 28.57, net_amount: 0 },
  { date: '2026-06-11', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.cyber, user_login: null, quantity: 3571, gross_amount: 35.71, discount_amount: 35.71, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.cyber, user_login: null, quantity: 2857, gross_amount: 28.57, discount_amount: 28.57, net_amount: 0 },
  { date: '2026-06-02', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.corporate, user_login: null, quantity: 1171, gross_amount: 11.71, discount_amount: 11.71, net_amount: 0 },
  { date: '2026-06-04', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.corporate, user_login: null, quantity: 1757, gross_amount: 17.57, discount_amount: 17.57, net_amount: 0 },
  { date: '2026-06-05', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.corporate, user_login: null, quantity: 1757, gross_amount: 17.57, discount_amount: 17.57, net_amount: 0 },
  { date: '2026-06-09', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.corporate, user_login: null, quantity: 2343, gross_amount: 23.43, discount_amount: 23.43, net_amount: 0 },
  { date: '2026-06-11', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.corporate, user_login: null, quantity: 2929, gross_amount: 29.29, discount_amount: 29.29, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.corporate, user_login: null, quantity: 2343, gross_amount: 23.43, discount_amount: 23.43, net_amount: 0 },
  { date: '2026-06-12', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.capBound, user_login: 'faisal-noor', quantity: 2300, gross_amount: 23, discount_amount: 0, net_amount: 23 },
  { date: '2026-08-31', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: 'noah-tanaka', quantity: 468, gross_amount: 4.68, discount_amount: 4.68, net_amount: 0 },
  { date: '2026-09-01', product: 'copilot', sku: AI_CREDITS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: 'noah-tanaka', quantity: 468, gross_amount: 4.68, discount_amount: 2.34, net_amount: 2.34 },
  // ---- POLLUTION FIXTURES (live-pinned regression guard, 2026-07-09) ----
  // The real usage endpoint mixes NON-AI-credit skus into the same report:
  // "Copilot Business" license rows (gross == net, discount 0) and "Copilot
  // Premium Request" rows (own discount/net split), both with FRACTIONAL
  // quantities. These four rows reproduce that pollution in sim so the
  // impl-side "Copilot AI Credits"-only filter has something real to
  // exclude. They must NOT enter any pool/metered pin (189,800 burn,
  // 193,036 AI-credit quantity, per-CC splits) -- every committed sum is an
  // AI-credit-sku-filtered sum. Hand-computable numbers (documented for the
  // impl builder's filter tests):
  //   UNASSOCIATED world (cost_center_id null; the endpoint's default view):
  //     Business:        qty 19.25  x $19.00 = gross 365.75, disc 0,    net 365.75
  //     Premium Request: qty 150.50 x $0.04  = gross   6.02, disc 4.00, net   2.02
  //     -> unassociated pollution totals: qty 169.75, gross 371.77, net 367.77
  //   WORKFORCE world (cc-workforce-australia):
  //     Business:        qty 24.50  x $19.00 = gross 465.50, disc 0,     net 465.50
  //     Premium Request: qty 320.25 x $0.04  = gross  12.81, disc 10.00, net   2.81
  //     -> workforce pollution totals: qty 344.75, gross 478.31, net 468.31
  { date: '2026-06-05', product: 'copilot', sku: COPILOT_BUSINESS_SKU, cost_center_id: null, user_login: null, quantity: 19.25, gross_amount: 365.75, discount_amount: 0, net_amount: 365.75 },
  { date: '2026-06-10', product: 'copilot', sku: COPILOT_PREMIUM_REQUEST_SKU, cost_center_id: null, user_login: null, quantity: 150.5, gross_amount: 6.02, discount_amount: 4, net_amount: 2.02 },
  { date: '2026-06-09', product: 'copilot', sku: COPILOT_BUSINESS_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 24.5, gross_amount: 465.5, discount_amount: 0, net_amount: 465.5 },
  { date: '2026-06-11', product: 'copilot', sku: COPILOT_PREMIUM_REQUEST_SKU, cost_center_id: COST_CENTER_IDS.workforce, user_login: null, quantity: 320.25, gross_amount: 12.81, discount_amount: 10, net_amount: 2.81 },
];


// METRICS VIEW (drives the Users screen MTD/sparkline/model-mix + the Cost
// Centers drill per-member burn). Per-user daily rows for the ~36 active users
// of the 81-seat roster; every other seat carries NO row (the "no usage this
// cycle" cohort). Each user's rows sum EXACTLY to their intended cycle total
// and each row's `model` tag makes the model-mix + unattributable split sum to
// that same total. Weekend dates (Jun 6/7/13) carry no rows, so every
// sparkline is weekday-shaped. Each CC's members' burns sum to LESS than that
// CC's billing mtd_burn_credits (costCenters.ts) -- the gap is shared/automated
// pool draw; see README.md §Coherence. noah-tanaka's Aug 31 / Sep 1 rows are
// the cliff edge fixture (outside the June cycle → 0 MTD this cycle despite
// having lifetime rows). Generated from hand-authored totals + model splits.
export const CREDITS_USED_ITEMS: CreditsUsedItem[] = [
  { date: '2026-06-03', user_id: '5107', user_login: 'liam-obrien', ai_credits_used: 822, model: 'GPT-5.1' },
  { date: '2026-06-05', user_id: '5107', user_login: 'liam-obrien', ai_credits_used: 1027, model: 'GPT-5.1' },
  { date: '2026-06-08', user_id: '5107', user_login: 'liam-obrien', ai_credits_used: 822, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-10', user_id: '5107', user_login: 'liam-obrien', ai_credits_used: 616, model: 'Claude Opus 4.5' },
  { date: '2026-06-11', user_id: '5107', user_login: 'liam-obrien', ai_credits_used: 822, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '5107', user_login: 'liam-obrien', ai_credits_used: 821 },
  { date: '2026-06-03', user_id: '6218', user_login: 'sarah-huang', ai_credits_used: 794, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-05', user_id: '6218', user_login: 'sarah-huang', ai_credits_used: 992, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-08', user_id: '6218', user_login: 'sarah-huang', ai_credits_used: 793, model: 'GPT-5.1' },
  { date: '2026-06-10', user_id: '6218', user_login: 'sarah-huang', ai_credits_used: 595, model: 'Claude Opus 4.5' },
  { date: '2026-06-11', user_id: '6218', user_login: 'sarah-huang', ai_credits_used: 793, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '6218', user_login: 'sarah-huang', ai_credits_used: 793 },
  { date: '2026-06-04', user_id: '4471', user_login: 'rpatel2', ai_credits_used: 1390, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-09', user_id: '4471', user_login: 'rpatel2', ai_credits_used: 1158, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-11', user_id: '4471', user_login: 'rpatel2', ai_credits_used: 927, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '4471', user_login: 'rpatel2', ai_credits_used: 695 },
  { date: '2026-06-04', user_id: '7043', user_login: 'd-okafor', ai_credits_used: 1180, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '7043', user_login: 'd-okafor', ai_credits_used: 983, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '7043', user_login: 'd-okafor', ai_credits_used: 787, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '7043', user_login: 'd-okafor', ai_credits_used: 590 },
  { date: '2026-06-04', user_id: '5389', user_login: 'jr-mitchell', ai_credits_used: 1003, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-09', user_id: '5389', user_login: 'jr-mitchell', ai_credits_used: 836, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-11', user_id: '5389', user_login: 'jr-mitchell', ai_credits_used: 669, model: 'GPT-5 mini' },
  { date: '2026-06-12', user_id: '5389', user_login: 'jr-mitchell', ai_credits_used: 502 },
  { date: '2026-06-04', user_id: '8102', user_login: 'amir-haddad', ai_credits_used: 827, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-09', user_id: '8102', user_login: 'amir-haddad', ai_credits_used: 689, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-11', user_id: '8102', user_login: 'amir-haddad', ai_credits_used: 551, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '8102', user_login: 'amir-haddad', ai_credits_used: 413 },
  { date: '2026-06-04', user_id: '4630', user_login: 'claire-donnelly', ai_credits_used: 643, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '4630', user_login: 'claire-donnelly', ai_credits_used: 536, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '4630', user_login: 'claire-donnelly', ai_credits_used: 429, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '4630', user_login: 'claire-donnelly', ai_credits_used: 322 },
  { date: '2026-06-10', user_id: '6884', user_login: 'wei-lin', ai_credits_used: 730, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '6884', user_login: 'wei-lin', ai_credits_used: 292 },
  { date: '2026-06-12', user_id: '6884', user_login: 'wei-lin', ai_credits_used: 438, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-10', user_id: '5560', user_login: 'ben-fraser', ai_credits_used: 490, model: 'GPT-5 mini' },
  { date: '2026-06-11', user_id: '5560', user_login: 'ben-fraser', ai_credits_used: 196 },
  { date: '2026-06-12', user_id: '5560', user_login: 'ben-fraser', ai_credits_used: 294, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-04', user_id: '5921', user_login: 'hannah-webb', ai_credits_used: 1453, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '5921', user_login: 'hannah-webb', ai_credits_used: 1211, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '5921', user_login: 'hannah-webb', ai_credits_used: 969, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '5921', user_login: 'hannah-webb', ai_credits_used: 727 },
  { date: '2026-06-04', user_id: '4088', user_login: 'george-apostol', ai_credits_used: 1327, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-09', user_id: '4088', user_login: 'george-apostol', ai_credits_used: 1106, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-11', user_id: '4088', user_login: 'george-apostol', ai_credits_used: 884, model: 'GPT-5.1' },
  { date: '2026-06-12', user_id: '4088', user_login: 'george-apostol', ai_credits_used: 663 },
  { date: '2026-06-04', user_id: '7710', user_login: 'nadia-rahman', ai_credits_used: 1157, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '7710', user_login: 'nadia-rahman', ai_credits_used: 964, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '7710', user_login: 'nadia-rahman', ai_credits_used: 771, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '7710', user_login: 'nadia-rahman', ai_credits_used: 578 },
  { date: '2026-06-04', user_id: '6355', user_login: 'oscar-lindgren', ai_credits_used: 947, model: 'GPT-5 mini' },
  { date: '2026-06-09', user_id: '6355', user_login: 'oscar-lindgren', ai_credits_used: 789, model: 'GPT-5 mini' },
  { date: '2026-06-11', user_id: '6355', user_login: 'oscar-lindgren', ai_credits_used: 631, model: 'GPT-5.1' },
  { date: '2026-06-12', user_id: '6355', user_login: 'oscar-lindgren', ai_credits_used: 473 },
  { date: '2026-06-10', user_id: '4902', user_login: 'ext-pshah', ai_credits_used: 860, model: 'GPT-5 mini' },
  { date: '2026-06-11', user_id: '4902', user_login: 'ext-pshah', ai_credits_used: 344 },
  { date: '2026-06-12', user_id: '4902', user_login: 'ext-pshah', ai_credits_used: 516, model: 'GPT-5.1' },
  { date: '2026-06-10', user_id: '8261', user_login: 'ivy-cheng', ai_credits_used: 320, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '8261', user_login: 'ivy-cheng', ai_credits_used: 128 },
  { date: '2026-06-12', user_id: '8261', user_login: 'ivy-cheng', ai_credits_used: 192, model: 'GPT-5.1' },
  { date: '2026-06-04', user_id: '5044', user_login: 'faisal-noor', ai_credits_used: 1393, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '5044', user_login: 'faisal-noor', ai_credits_used: 1161, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '5044', user_login: 'faisal-noor', ai_credits_used: 929, model: 'GPT-5.1' },
  { date: '2026-06-12', user_id: '5044', user_login: 'faisal-noor', ai_credits_used: 697 },
  { date: '2026-06-04', user_id: '6627', user_login: 'grace-omalley', ai_credits_used: 1340, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '6627', user_login: 'grace-omalley', ai_credits_used: 1117, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '6627', user_login: 'grace-omalley', ai_credits_used: 893, model: 'GPT-5 mini' },
  { date: '2026-06-12', user_id: '6627', user_login: 'grace-omalley', ai_credits_used: 670 },
  { date: '2026-06-04', user_id: '4319', user_login: 'hugo-almeida', ai_credits_used: 1160, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '4319', user_login: 'hugo-almeida', ai_credits_used: 967, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '4319', user_login: 'hugo-almeida', ai_credits_used: 773, model: 'Claude Opus 4.5' },
  { date: '2026-06-12', user_id: '4319', user_login: 'hugo-almeida', ai_credits_used: 580 },
  { date: '2026-06-04', user_id: '7856', user_login: 'ling-zhou', ai_credits_used: 993, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '7856', user_login: 'ling-zhou', ai_credits_used: 828, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '7856', user_login: 'ling-zhou', ai_credits_used: 662, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-12', user_id: '7856', user_login: 'ling-zhou', ai_credits_used: 497 },
  { date: '2026-06-04', user_id: '5271', user_login: 'yusuf-demir', ai_credits_used: 880, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '5271', user_login: 'yusuf-demir', ai_credits_used: 733, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '5271', user_login: 'yusuf-demir', ai_credits_used: 587, model: 'GPT-5.1' },
  { date: '2026-06-12', user_id: '5271', user_login: 'yusuf-demir', ai_credits_used: 440 },
  { date: '2026-06-04', user_id: '8408', user_login: 'peter-nkosi', ai_credits_used: 737, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '8408', user_login: 'peter-nkosi', ai_credits_used: 614, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '8408', user_login: 'peter-nkosi', ai_credits_used: 491, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-12', user_id: '8408', user_login: 'peter-nkosi', ai_credits_used: 368 },
  { date: '2026-06-10', user_id: '4763', user_login: 'sofia-marin', ai_credits_used: 360, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '4763', user_login: 'sofia-marin', ai_credits_used: 144 },
  { date: '2026-06-12', user_id: '4763', user_login: 'sofia-marin', ai_credits_used: 216, model: 'GPT-5 mini' },
  { date: '2026-06-03', user_id: '5182', user_login: 'emily-zhao', ai_credits_used: 914, model: 'GPT-5.1' },
  { date: '2026-06-05', user_id: '5182', user_login: 'emily-zhao', ai_credits_used: 1142, model: 'GPT-5.1' },
  { date: '2026-06-08', user_id: '5182', user_login: 'emily-zhao', ai_credits_used: 913, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-10', user_id: '5182', user_login: 'emily-zhao', ai_credits_used: 685, model: 'Claude Opus 4.5' },
  { date: '2026-06-11', user_id: '5182', user_login: 'emily-zhao', ai_credits_used: 913, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-12', user_id: '5182', user_login: 'emily-zhao', ai_credits_used: 913 },
  { date: '2026-06-03', user_id: '6749', user_login: 'aran-mehta', ai_credits_used: 869, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-05', user_id: '6749', user_login: 'aran-mehta', ai_credits_used: 1086, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-08', user_id: '6749', user_login: 'aran-mehta', ai_credits_used: 868, model: 'GPT-5.1' },
  { date: '2026-06-10', user_id: '6749', user_login: 'aran-mehta', ai_credits_used: 651, model: 'Claude Opus 4.5' },
  { date: '2026-06-11', user_id: '6749', user_login: 'aran-mehta', ai_credits_used: 868, model: 'Claude Opus 4.5' },
  { date: '2026-06-12', user_id: '6749', user_login: 'aran-mehta', ai_credits_used: 868 },
  { date: '2026-06-04', user_id: '4205', user_login: 'kirsty-boyd', ai_credits_used: 1573, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '4205', user_login: 'kirsty-boyd', ai_credits_used: 1311, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '4205', user_login: 'kirsty-boyd', ai_credits_used: 1049, model: 'GPT-5 mini' },
  { date: '2026-06-12', user_id: '4205', user_login: 'kirsty-boyd', ai_credits_used: 787 },
  { date: '2026-06-04', user_id: '7532', user_login: 'diego-santos', ai_credits_used: 1360, model: 'Claude Opus 4.5' },
  { date: '2026-06-09', user_id: '7532', user_login: 'diego-santos', ai_credits_used: 1133, model: 'Claude Opus 4.5' },
  { date: '2026-06-11', user_id: '7532', user_login: 'diego-santos', ai_credits_used: 907, model: 'GPT-5.1' },
  { date: '2026-06-12', user_id: '7532', user_login: 'diego-santos', ai_credits_used: 680 },
  { date: '2026-06-04', user_id: '5896', user_login: 'wendy-oakes', ai_credits_used: 1120, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '5896', user_login: 'wendy-oakes', ai_credits_used: 933, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '5896', user_login: 'wendy-oakes', ai_credits_used: 747, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-12', user_id: '5896', user_login: 'wendy-oakes', ai_credits_used: 560 },
  { date: '2026-06-04', user_id: '8017', user_login: 'raymond-li', ai_credits_used: 847, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '8017', user_login: 'raymond-li', ai_credits_used: 706, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '8017', user_login: 'raymond-li', ai_credits_used: 564, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '8017', user_login: 'raymond-li', ai_credits_used: 423 },
  { date: '2026-06-03', user_id: '5613', user_login: 'sam-kelly', ai_credits_used: 805, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-05', user_id: '5613', user_login: 'sam-kelly', ai_credits_used: 1006, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-08', user_id: '5613', user_login: 'sam-kelly', ai_credits_used: 805, model: 'Claude Opus 4.5' },
  { date: '2026-06-10', user_id: '5613', user_login: 'sam-kelly', ai_credits_used: 604, model: 'Claude Opus 4.5' },
  { date: '2026-06-11', user_id: '5613', user_login: 'sam-kelly', ai_credits_used: 805, model: 'GPT-5 mini' },
  { date: '2026-06-12', user_id: '5613', user_login: 'sam-kelly', ai_credits_used: 805 },
  { date: '2026-06-04', user_id: '4488', user_login: 'ruby-carter', ai_credits_used: 1430, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '4488', user_login: 'ruby-carter', ai_credits_used: 1192, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '4488', user_login: 'ruby-carter', ai_credits_used: 953, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-12', user_id: '4488', user_login: 'ruby-carter', ai_credits_used: 715 },
  { date: '2026-06-04', user_id: '7126', user_login: 'omar-farah', ai_credits_used: 1140, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '7126', user_login: 'omar-farah', ai_credits_used: 950, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '7126', user_login: 'omar-farah', ai_credits_used: 760, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-12', user_id: '7126', user_login: 'omar-farah', ai_credits_used: 570 },
  { date: '2026-06-10', user_id: '6042', user_login: 'lucas-meyer', ai_credits_used: 445, model: 'Gemini 2.5 Pro' },
  { date: '2026-06-11', user_id: '6042', user_login: 'lucas-meyer', ai_credits_used: 178 },
  { date: '2026-06-12', user_id: '6042', user_login: 'lucas-meyer', ai_credits_used: 267, model: 'GPT-5.1' },
  { date: '2026-06-04', user_id: '5934', user_login: 'karen-fox', ai_credits_used: 1253, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '5934', user_login: 'karen-fox', ai_credits_used: 1044, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '5934', user_login: 'karen-fox', ai_credits_used: 836, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-12', user_id: '5934', user_login: 'karen-fox', ai_credits_used: 627 },
  { date: '2026-06-04', user_id: '4177', user_login: 'ali-rezaei', ai_credits_used: 1027, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-09', user_id: '4177', user_login: 'ali-rezaei', ai_credits_used: 856, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '4177', user_login: 'ali-rezaei', ai_credits_used: 684, model: 'GPT-5.1' },
  { date: '2026-06-12', user_id: '4177', user_login: 'ali-rezaei', ai_credits_used: 513 },
  { date: '2026-06-04', user_id: '7605', user_login: 'josh-bright', ai_credits_used: 813, model: 'GPT-5.1' },
  { date: '2026-06-09', user_id: '7605', user_login: 'josh-bright', ai_credits_used: 678, model: 'GPT-5.1' },
  { date: '2026-06-11', user_id: '7605', user_login: 'josh-bright', ai_credits_used: 542, model: 'GPT-5 mini' },
  { date: '2026-06-12', user_id: '7605', user_login: 'josh-bright', ai_credits_used: 407 },
  { date: '2026-06-10', user_id: '6488', user_login: 'mia-larsson', ai_credits_used: 840, model: 'Claude Sonnet 4.5' },
  { date: '2026-06-11', user_id: '6488', user_login: 'mia-larsson', ai_credits_used: 336 },
  { date: '2026-06-12', user_id: '6488', user_login: 'mia-larsson', ai_credits_used: 504, model: 'GPT-5.1' },
  { date: '2026-08-31', user_id: '7219', user_login: 'noah-tanaka', ai_credits_used: 468 },
  { date: '2026-09-01', user_id: '7219', user_login: 'noah-tanaka', ai_credits_used: 468 },
];

export { ENTERPRISE_SLUG as USAGE_ENTITY };
