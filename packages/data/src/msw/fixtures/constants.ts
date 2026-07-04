export const ENTERPRISE_SLUG = 'acme-enterprise';
export const GITHUB_API_BASE = 'https://api.github.com';
export const API_VERSION = '2026-03-10';

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
} as const;
