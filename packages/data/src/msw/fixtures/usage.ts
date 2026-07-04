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
export interface CreditsUsedItem {
  date: string;
  user_id: string;
  user_login: string;
  ai_credits_used: number;
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
  // Edge fixture: cap-bound cost center has fully consumed its computed included-usage
  // cap for the pool phase, so its draw is already routing to metered (net_amount > 0)
  // while the enterprise budget elsewhere still has headroom.
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

export const CREDITS_USED_ITEMS: CreditsUsedItem[] = [
  { date: '2026-06-14', user_id: '1001', user_login: 'user-01', ai_credits_used: 420 },
  { date: '2026-06-14', user_id: '1016', user_login: 'user-16', ai_credits_used: 310 },
  { date: '2026-06-14', user_id: '1026', user_login: 'user-26', ai_credits_used: 500 },
  { date: '2026-08-31', user_id: '1005', user_login: 'user-05', ai_credits_used: 380 },
  { date: '2026-09-01', user_id: '1005', user_login: 'user-05', ai_credits_used: 380 },
];

export { ENTERPRISE_SLUG as USAGE_ENTITY };
