import { BUDGET_IDS, COST_CENTER_IDS } from './constants.js';

export interface AlertFixture {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  budgetId?: string;
}

// Pre-baked, not derived from usage/budget math: custom alerting/anomaly
// detection is a later-phase capability (PRD FR17). MVP's ApiClient.listAlerts()
// just surfaces this fixture list as-is (see PLAN.md's Architecture Decisions).
export const ALERTS: AlertFixture[] = [
  {
    id: 'alert-zero-ulb-user-20',
    severity: 'critical',
    message: 'user-20 is fully blocked by a $0 individual budget.',
    budgetId: BUDGET_IDS.zeroUlb,
  },
  {
    id: 'alert-cap-bound-marketing',
    severity: 'warning',
    message: `Cost center ${COST_CENTER_IDS.capBound} has exhausted its included-usage cap and is routing to metered spend.`,
  },
  {
    id: 'alert-allowance-cliff',
    severity: 'info',
    message: 'Promo allowance ends 2026-09-01; the standard per-seat allowance is smaller.',
  },
];
