// Simulated enterprise: DEWR — Australia's Department of Employment and
// Workplace Relations, a mid-size GitHub Enterprise Cloud customer on the
// promo allowance (existing customer, 7,000 credits/seat, spec §1.1). See
// README.md in this directory for the full org chart, personas, and the
// coherence equations every fixture in this folder is authored against.
export const ENTERPRISE_SLUG = 'dewr';
export const GITHUB_API_BASE = 'https://api.github.com';
export const API_VERSION = '2026-03-10';

// Simulation-mode "now" for cycle-relative math (Overview runway tiles/burn-down).
// Deliberately NOT the max date across all usage items: the 1 Sep 2026 cliff
// rows in usage.ts are future-dated edge fixtures for Phase-4 forecast/backtest
// testing, not "today" -- anchoring there collapses the current cycle to day 0
// with a single data point. This date is day 13 of the June 2026 cycle, where
// the bulk of non-edge fixture activity clusters (usage.ts's June rows,
// licenses.ts's last_activity_at).
// TODO: live mode needs a real wall-clock source once a PAT exists (no PAT in MVP).
export const SIM_CURRENT_DATE = '2026-06-14';

// The six DEWR cost centers (README.md §Org chart). Every licensed seat is
// attributed to exactly one, so Σ(computed included-usage caps) == the
// enterprise pool allowance (81 seats × 7,000 = 567,000) exactly. `capBound`
// is the over-cap crisis CC; `dataEval` is the amber (low-headroom) CC.
export const COST_CENTER_IDS = {
  workforce: 'cc-workforce-australia',
  employer: 'cc-employer-portals',
  capBound: 'cc-payments-integrity',
  dataEval: 'cc-data-evaluation',
  cyber: 'cc-cyber-identity',
  corporate: 'cc-corporate-systems',
} as const;

export const BUDGET_IDS = {
  // Family A -- user-level budgets (ULBs), always hard-stop (CLAUDE.md §5).
  universal: 'budget-universal-dewr',
  ulbDisplayBug: 'budget-ulb-display-bug',
  zeroUlb: 'budget-ulb-zero',
  // CCULBs (multi_user_cost_center -- API-only, no native GitHub UI). Key name
  // kept as `cculbPlatform` for import stability; it targets the flagship
  // Workforce Australia Platform CC.
  cculbPlatform: 'budget-cculb-workforce',
  cculbDataEval: 'budget-cculb-data-evaluation',
  // Individual overrides beyond the two edge fixtures above.
  individualContractor: 'budget-ulb-contractor-pshah',
  individualPowerUser: 'budget-ulb-sam-kelly',
  // Family B -- spending limits (metered charges only, hard-stop off by default).
  enterpriseMetered: 'budget-enterprise-metered',
  organizationMetered: 'budget-organization-metered',
  // Cost-center spending limit on Workforce Australia Platform (the write
  // engine's canonical PATCH target). Key kept as `costCenterMetered`.
  costCenterMetered: 'budget-cost-center-workforce-metered',
  // The ONE Family-B fixture shipping hard-stop ON (prevent_further_usage:
  // true) -- on the Data & Evaluation Platform CC. CLAUDE.md §6.3's gated
  // alert-only transition (old true -> new false) is only exercisable end to
  // end from a live prevent_further_usage: true starting point, and every
  // other spending-limit fixture ships the GitHub default (false). Key kept as
  // `costCenterDataAnalyticsMetered` for import stability. Amount kept small so
  // the enterprise-cap-below-sum baseline stays comfortably unblocked
  // (60,000 + 25,000 credits << 800,000).
  costCenterDataAnalyticsMetered: 'budget-cost-center-data-evaluation-metered',
} as const;
