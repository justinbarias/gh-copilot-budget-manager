import { BUDGET_IDS, COST_CENTER_IDS } from './constants.js';

export interface AlertFixture {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  tag: string;
  title: string;
  meta: string;
  timestamp: string;
  budgetId?: string;
}

// Pre-baked, not derived from usage/budget math: custom alerting/anomaly
// detection is a later-phase capability (PRD FR17). MVP's ApiClient.listAlerts()
// just surfaces this fixture list as-is, verbatim and in this order (see
// PLAN.md's Architecture Decisions) -- no sorting/derivation happens in
// packages/ui. Timestamps are fixed ISO instants clustered around
// SIM_CURRENT_DATE (2026-06-14, see constants.ts) rather than wall-clock, so
// the rendered list is deterministic across every run/e2e assertion.
export const ALERTS: AlertFixture[] = [
  {
    id: 'alert-zero-ulb-user-20',
    severity: 'critical',
    tag: 'zero-ulb',
    title: 'user-20 is fully blocked by a $0 individual budget',
    meta: 'Individual ULB overrides CCULB and universal -- always hard-stops both phases',
    timestamp: '2026-06-14T09:12:00.000Z',
    budgetId: BUDGET_IDS.zeroUlb,
  },
  {
    id: 'alert-cap-bound-marketing',
    severity: 'warning',
    tag: 'cap-bound',
    title: `Cost center ${COST_CENTER_IDS.capBound} has exhausted its included-usage cap`,
    meta: 'Overflow routing: metered -- the cap has no grantable pool-phase delta',
    timestamp: '2026-06-13T22:40:00.000Z',
  },
  {
    id: 'alert-allowance-cliff',
    severity: 'info',
    tag: 'cliff',
    title: 'Promo allowance ends 2026-09-01',
    meta: 'The standard per-seat allowance is smaller -- plan the Sep 1 transition',
    timestamp: '2026-06-10T08:00:00.000Z',
  },
];
