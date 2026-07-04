export const ENTERPRISE_SLUG = 'acme-enterprise';
export const GITHUB_API_BASE = 'https://api.github.com';
export const API_VERSION = '2026-03-10';

// Simulation-mode "now" for cycle-relative math (Overview runway tiles/burn-down).
// Deliberately NOT the max date across all usage items: the 1 Sep 2026 cliff
// rows in usage.ts are future-dated edge fixtures for Phase-4 forecast/backtest
// testing, not "today" -- anchoring there collapses the current cycle to day 0
// with a single data point. This date is where the bulk of non-edge fixture
// activity clusters (usage.ts's June rows, licenses.ts's last_activity_at).
// TODO: live mode needs a real wall-clock source once a PAT exists (no PAT in MVP).
export const SIM_CURRENT_DATE = '2026-06-14';

export const COST_CENTER_IDS = {
  platform: 'cc-platform',
  dataAnalytics: 'cc-data-analytics',
  capBound: 'cc-marketing-cap-bound',
} as const;

export const BUDGET_IDS = {
  universal: 'budget-universal-1',
  ulbDisplayBug: 'budget-ulb-display-bug-1',
  zeroUlb: 'budget-ulb-zero-1',
  cculbPlatform: 'budget-cculb-platform-1',
  enterpriseMetered: 'budget-enterprise-metered-1',
  // Task 4.1: Family-B spending-limit fixtures added so PATCH/DELETE-by-id
  // mutation contract tests have a canonical id to exercise for these two
  // budget_scope values too (organization, cost_center), matching PRD §2.1.
  organizationMetered: 'budget-organization-metered-1',
  costCenterMetered: 'budget-cost-center-platform-metered-1',
} as const;
