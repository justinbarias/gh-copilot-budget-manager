import { BUDGET_IDS, ENTERPRISE_SLUG } from './constants.js';

export type BudgetType = 'ProductPricing' | 'SkuPricing' | 'BundlePricing';
export type BudgetScope =
  | 'universal'
  | 'individual'
  | 'multi_user_cost_center'
  | 'enterprise'
  | 'organization'
  | 'cost_center'
  | 'repository';

export interface Budget {
  id: string;
  budget_type: BudgetType;
  budget_product_sku: string;
  budget_scope: BudgetScope;
  budget_entity_name: string;
  budget_amount: number;
  prevent_further_usage: boolean;
  budget_alerting: { will_alert: boolean; alert_recipients: string[] };
}

const platformCostCenterName = 'Platform';

export const BUDGETS: Budget[] = [
  {
    id: BUDGET_IDS.universal,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'universal',
    budget_entity_name: ENTERPRISE_SLUG,
    budget_amount: 40,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['finops@acme.example'] },
  },
  // Edge fixture: individual ULB that GitHub's native "Budgets and alerts" UI is known
  // to omit from its list view (the ULB display bug — spec §1.4). The API correctly
  // returns it here; detection/repair logic (Phase 3) must find it via this list, not
  // GitHub's UI.
  {
    id: BUDGET_IDS.ulbDisplayBug,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: 'user-07',
    budget_amount: 60,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['user-07@acme.example'] },
  },
  // Edge fixture: a $0 individual ULB, which hard-blocks that user immediately in both
  // phases (spec §1.3). Exercises the "warn on $0/near-zero ULBs" validation (CLAUDE.md §6.4).
  {
    id: BUDGET_IDS.zeroUlb,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: 'user-20',
    budget_amount: 0,
    prevent_further_usage: true,
    budget_alerting: { will_alert: false, alert_recipients: [] },
  },
  {
    id: BUDGET_IDS.cculbPlatform,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'multi_user_cost_center',
    budget_entity_name: platformCostCenterName,
    budget_amount: 45,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['platform-leads@acme.example'] },
  },
  {
    id: BUDGET_IDS.enterpriseMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'enterprise',
    budget_entity_name: ENTERPRISE_SLUG,
    budget_amount: 8000,
    prevent_further_usage: false,
    budget_alerting: { will_alert: true, alert_recipients: ['finops@acme.example'] },
  },
  // Task 4.1: Family-B spending-limit fixtures (organization/cost_center scope --
  // metered charges only, hard-stop off by default per spec §1.3) so the budget
  // mutation handlers' GET/PATCH/DELETE-by-id contract tests have a canonical id
  // to exercise for every budget_scope this tool writes, not just enterprise/ULB.
  {
    id: BUDGET_IDS.organizationMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'organization',
    budget_entity_name: 'acme-eng-org',
    budget_amount: 3200,
    prevent_further_usage: false,
    budget_alerting: { will_alert: true, alert_recipients: ['org-admins@acme.example'] },
  },
  {
    id: BUDGET_IDS.costCenterMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'cost_center',
    budget_entity_name: platformCostCenterName,
    budget_amount: 600,
    prevent_further_usage: false,
    budget_alerting: { will_alert: true, alert_recipients: ['platform-leads@acme.example'] },
  },
  // Task 4.9 (flagged addition -- a genuinely missing spending-limit fixture):
  // the ONLY Family-B budget with hard-stop ON. Every fixture above ships
  // prevent_further_usage: false (GitHub's spending-limit default, spec §1.3),
  // which made CLAUDE.md §6.3's gated transition ("making an alert-only limit
  // requires an explicit, logged override" -- i.e. old: true -> new: false)
  // impossible to exercise end to end. This also gives the Controls screen a
  // green-track (hard stop) enforcement toggle in live state, alongside the
  // amber alert-only rows. Amount kept small so the enterprise-cap-below-sum
  // baseline stays comfortably unblocked (60,000 + 25,000 credits << 800,000).
  {
    id: BUDGET_IDS.costCenterDataAnalyticsMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'cost_center',
    budget_entity_name: 'Data & Analytics',
    budget_amount: 250,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['data-leads@acme.example'] },
  },
];
