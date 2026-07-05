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

// CC display names (must equal the CostCenter.name in costCenters.ts, since
// CCULB + cost_center budgets are resolved/keyed by name -- resolveEffectiveUlb
// and fetchLiveControls).
const WORKFORCE_CC = 'Workforce Australia Platform';
const DATA_EVAL_CC = 'Data & Evaluation Platform';

// budget_amount is USD (PRD §2.3); credits = amount × 100 (1 credit = $0.01).
// ULB texture per the design brief: universal/CCULB/individual all in the
// ~1,900–6,000 credit band. Family-A ULBs always hard-stop (CLAUDE.md §5).
export const BUDGETS: Budget[] = [
  // ---- Family A: user-level budgets (ULBs) — most-specific wins ----
  {
    id: BUDGET_IDS.universal,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'universal',
    budget_entity_name: ENTERPRISE_SLUG,
    budget_amount: 46, // 4,600 credits — everyone's baseline ceiling
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['finops@dewr.gov.au'] },
  },
  // Edge fixture: individual ULB that GitHub's native "Budgets and alerts" UI is
  // known to omit from its list view (the ULB display bug — spec §1.4). The API
  // correctly returns it here; detection/repair logic (Phase 3) must find it via
  // this list, not GitHub's UI. Belongs to a Workforce lead, overriding that
  // team's 5,200 CCULB with a higher personal ceiling.
  {
    id: BUDGET_IDS.ulbDisplayBug,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: 'liam-obrien',
    budget_amount: 58, // 5,800 credits
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['copilot-admins@dewr.gov.au'] },
  },
  // Edge fixture: a $0 individual ULB, which hard-blocks that user immediately in
  // both phases (spec §1.3). An offboarding external contractor. Exercises the
  // "warn on $0/near-zero ULBs" validation (CLAUDE.md §6.4) and the Users
  // screen's "✕ blocked · $0 ULB" rendering.
  {
    id: BUDGET_IDS.zeroUlb,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: 'ext-dmorrow',
    budget_amount: 0,
    prevent_further_usage: true,
    budget_alerting: { will_alert: false, alert_recipients: [] },
  },
  // CCULB on the flagship Workforce Australia Platform team (API-only control —
  // no native GitHub UI). Key kept as `cculbPlatform` for import stability.
  {
    id: BUDGET_IDS.cculbPlatform,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'multi_user_cost_center',
    budget_entity_name: WORKFORCE_CC,
    budget_amount: 52, // 5,200 credits
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['wfa-leads@dewr.gov.au'] },
  },
  // CCULB on the Data & Evaluation Platform team (the amber CC) — a higher team
  // ceiling for a heavier-usage cohort.
  {
    id: BUDGET_IDS.cculbDataEval,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'multi_user_cost_center',
    budget_entity_name: DATA_EVAL_CC,
    budget_amount: 60, // 6,000 credits
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['data-eval-leads@dewr.gov.au'] },
  },
  // Individual override: a throttled external contractor on a deliberately low
  // ceiling (near their cap this cycle → shows "at risk" on the Users screen).
  {
    id: BUDGET_IDS.individualContractor,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: 'ext-pshah',
    budget_amount: 19, // 1,900 credits (above the $1 near-zero warning threshold)
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['copilot-admins@dewr.gov.au'] },
  },
  // Individual override: a Cyber power user granted a higher personal ceiling
  // than their team's universal ULB.
  {
    id: BUDGET_IDS.individualPowerUser,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: 'sam-kelly',
    budget_amount: 54, // 5,400 credits
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['cyber-leads@dewr.gov.au'] },
  },
  // ---- Family B: spending limits (metered charges only, hard-stop off by default) ----
  {
    id: BUDGET_IDS.enterpriseMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'enterprise',
    budget_entity_name: ENTERPRISE_SLUG,
    budget_amount: 8000, // 800,000 credits — the enterprise metered ceiling
    prevent_further_usage: false,
    budget_alerting: { will_alert: true, alert_recipients: ['finops@dewr.gov.au'] },
  },
  {
    id: BUDGET_IDS.organizationMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'organization',
    budget_entity_name: 'dewr-digital',
    budget_amount: 3200, // 320,000 credits
    prevent_further_usage: false,
    budget_alerting: { will_alert: true, alert_recipients: ['org-admins@dewr.gov.au'] },
  },
  // Cost-center spending limit on Workforce Australia Platform — the write
  // engine's canonical PATCH target (engine.test.ts raises this $600 → $650).
  {
    id: BUDGET_IDS.costCenterMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'cost_center',
    budget_entity_name: WORKFORCE_CC,
    budget_amount: 600, // 60,000 credits
    prevent_further_usage: false,
    budget_alerting: { will_alert: true, alert_recipients: ['wfa-leads@dewr.gov.au'] },
  },
  // The ONLY Family-B budget shipping hard-stop ON — on Data & Evaluation
  // Platform. Every other spending-limit fixture ships prevent_further_usage:
  // false (GitHub's default, spec §1.3), which made CLAUDE.md §6.3's gated
  // transition ("making an alert-only limit requires an explicit, logged
  // override" — i.e. old: true → new: false) impossible to exercise end to end.
  // Also gives the Controls screen a green-track (hard stop) enforcement toggle
  // in live state, alongside the amber alert-only rows. Amount kept small so the
  // enterprise-cap-below-sum baseline stays comfortably unblocked
  // (60,000 + 25,000 credits << 800,000). Key kept as
  // `costCenterDataAnalyticsMetered` for import stability.
  {
    id: BUDGET_IDS.costCenterDataAnalyticsMetered,
    budget_type: 'ProductPricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'cost_center',
    budget_entity_name: DATA_EVAL_CC,
    budget_amount: 250, // 25,000 credits
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['data-eval-leads@dewr.gov.au'] },
  },
];
