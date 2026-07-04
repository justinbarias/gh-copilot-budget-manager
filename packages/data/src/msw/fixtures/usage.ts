import { COST_CENTER_IDS, ENTERPRISE_SLUG } from './constants.js';

// Mirrors GitHub's enterprise billing usage/summary item shape (PRD §2.3):
// one row per date/product/SKU/entity, filterable by cost_center_id.
export interface UsageItem {
  date: string; // YYYY-MM-DD
  product: string;
  sku: string;
  cost_center_id: string | null;
  user_login: string | null;
  quantity: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
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
// (design/README.md, never implying false precision).
export interface CreditsUsedItem {
  date: string;
  user_id: string;
  user_login: string;
  ai_credits_used: number;
  model?: string;
}

export const USAGE_ITEMS: UsageItem[] = [
  {
    date: '2026-06-14',
    product: 'copilot',
    sku: 'ai_credits',
    cost_center_id: COST_CENTER_IDS.platform,
    user_login: 'user-01',
    quantity: 420,
    gross_amount: 4.2,
    discount_amount: 4.2,
    net_amount: 0,
  },
  {
    date: '2026-06-14',
    product: 'copilot',
    sku: 'ai_credits',
    cost_center_id: COST_CENTER_IDS.dataAnalytics,
    user_login: 'user-16',
    quantity: 310,
    gross_amount: 3.1,
    discount_amount: 3.1,
    net_amount: 0,
  },
  // Edge fixture: cap-bound cost center. It drew its full 70,000 included-usage
  // cap from the shared pool (this discount-covered row, itemised as a CC-aggregate
  // pool draw with user_login null) and then overflowed the next 500 credits into
  // metered (the row below, net_amount > 0). Both are itemised so the enterprise
  // pool burn-down reflects this draw -- a cost center's pool draw IS enterprise
  // pool consumption (CLAUDE.md §5) -- and the CC-level total (70,500) reconciles
  // with its itemised rows. Enterprise pool burned by 2026-06-14 = 420 + 310 +
  // 70,000 = 70,730 of 245,000 (~28.9%).
  {
    date: '2026-06-14',
    product: 'copilot',
    sku: 'ai_credits',
    cost_center_id: COST_CENTER_IDS.capBound,
    user_login: null,
    quantity: 70_000,
    gross_amount: 700.0,
    discount_amount: 700.0,
    net_amount: 0,
  },
  {
    date: '2026-06-14',
    product: 'copilot',
    sku: 'ai_credits',
    cost_center_id: COST_CENTER_IDS.capBound,
    user_login: 'user-26',
    quantity: 500,
    gross_amount: 5.0,
    discount_amount: 0,
    net_amount: 5.0,
  },
  // Edge fixture: promo -> standard allowance cliff (1 Sep 2026, spec §1.1). Same user,
  // straddling the boundary: still pool-phase (no charge) the day before, tipped into
  // metered spend the day of/after once the smaller standard allowance takes over.
  {
    date: '2026-08-31',
    product: 'copilot',
    sku: 'ai_credits',
    cost_center_id: COST_CENTER_IDS.platform,
    user_login: 'user-05',
    quantity: 380,
    gross_amount: 3.8,
    discount_amount: 3.8,
    net_amount: 0,
  },
  {
    date: '2026-09-01',
    product: 'copilot',
    sku: 'ai_credits',
    cost_center_id: COST_CENTER_IDS.platform,
    user_login: 'user-05',
    quantity: 380,
    gross_amount: 3.8,
    discount_amount: 1.9,
    net_amount: 1.9,
  },
];

// user-01/16/26's single-day totals (420/310/500) are decomposed across
// several June-cycle dates and tagged per-model (Task 2.4: the Users screen's
// sparkline needs a daily shape and the model-mix bar needs per-model rows).
// Each user's rows sum to EXACTLY its prior total -- github-impl.ts's
// listCostCenters() per-member burn and github-impl.test.ts both reconcile
// against these same totals (420/310/500), so the decomposition must not
// change them. Every other licensed user (SEATS, licenses.ts) intentionally
// carries no row here at all: they exercise the Users screen's "No usage"
// filter and zero-length sparkline/model-mix rendering. user-05's Aug
// 31/Sep 1 cliff-edge rows are untouched -- they stay outside the June cycle
// window (cycleBounds(SIM_CURRENT_DATE)), so user-05 is 0 MTD this cycle
// (the "no usage yet this cycle" case) despite having lifetime rows.
export const CREDITS_USED_ITEMS: CreditsUsedItem[] = [
  // user-01 (Platform CC): 80+90 GPT-5.4, 70 Sonnet 4.6, 60 GPT-5 mini, 120 unattributable = 420.
  { date: '2026-06-10', user_id: '1001', user_login: 'user-01', ai_credits_used: 80, model: 'GPT-5.4' },
  { date: '2026-06-11', user_id: '1001', user_login: 'user-01', ai_credits_used: 90, model: 'GPT-5.4' },
  { date: '2026-06-12', user_id: '1001', user_login: 'user-01', ai_credits_used: 70, model: 'Sonnet 4.6' },
  { date: '2026-06-13', user_id: '1001', user_login: 'user-01', ai_credits_used: 60, model: 'GPT-5 mini' },
  { date: '2026-06-14', user_id: '1001', user_login: 'user-01', ai_credits_used: 120 },

  // user-16 (Data & Analytics CC): 50 GPT-5.4, 70+90 Sonnet 4.6, 40 GPT-5 mini, 60 unattributable = 310.
  { date: '2026-06-05', user_id: '1016', user_login: 'user-16', ai_credits_used: 50, model: 'GPT-5.4' },
  { date: '2026-06-08', user_id: '1016', user_login: 'user-16', ai_credits_used: 70, model: 'Sonnet 4.6' },
  { date: '2026-06-11', user_id: '1016', user_login: 'user-16', ai_credits_used: 90, model: 'Sonnet 4.6' },
  { date: '2026-06-13', user_id: '1016', user_login: 'user-16', ai_credits_used: 40, model: 'GPT-5 mini' },
  { date: '2026-06-14', user_id: '1016', user_login: 'user-16', ai_credits_used: 60 },

  // user-26 (Marketing/cap-bound CC): 60+80 GPT-5.4, 110 Sonnet 4.6, 90 GPT-5 mini, 160 unattributable = 500.
  { date: '2026-06-03', user_id: '1026', user_login: 'user-26', ai_credits_used: 60, model: 'GPT-5.4' },
  { date: '2026-06-06', user_id: '1026', user_login: 'user-26', ai_credits_used: 80, model: 'GPT-5.4' },
  { date: '2026-06-09', user_id: '1026', user_login: 'user-26', ai_credits_used: 110, model: 'Sonnet 4.6' },
  { date: '2026-06-12', user_id: '1026', user_login: 'user-26', ai_credits_used: 90, model: 'GPT-5 mini' },
  { date: '2026-06-14', user_id: '1026', user_login: 'user-26', ai_credits_used: 160 },

  // Edge fixture: promo -> standard allowance cliff (unchanged from Task 1.3/2.1/2.3 --
  // both rows fall outside the June cycle window entirely, see cycleBounds note above).
  { date: '2026-08-31', user_id: '1005', user_login: 'user-05', ai_credits_used: 380 },
  { date: '2026-09-01', user_id: '1005', user_login: 'user-05', ai_credits_used: 380 },
];

export { ENTERPRISE_SLUG as USAGE_ENTITY };
