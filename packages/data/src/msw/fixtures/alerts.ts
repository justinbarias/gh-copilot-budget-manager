import { BUDGET_IDS } from './constants.js';

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
// the rendered list is deterministic across every run/e2e assertion. Each alert
// maps to a real condition in the fixture world (see README.md).
export const ALERTS: AlertFixture[] = [
  {
    id: 'alert-zero-ulb-ext-dmorrow',
    severity: 'critical',
    tag: 'zero-ulb',
    title: 'ext-dmorrow is fully blocked by a $0 individual budget',
    meta: 'Individual ULB overrides CCULB and universal -- always hard-stops both phases',
    timestamp: '2026-06-14T09:12:00.000Z',
    budgetId: BUDGET_IDS.zeroUlb,
  },
  {
    id: 'alert-cap-bound-payments-integrity',
    severity: 'critical',
    tag: 'cap-bound',
    title: 'Payments Integrity Engineering has exhausted its included-usage cap',
    meta: 'Overflow routing: metered (2,300 credits over) -- the cap has no grantable pool-phase delta',
    timestamp: '2026-06-14T06:20:00.000Z',
  },
  {
    id: 'alert-low-headroom-data-evaluation',
    severity: 'warning',
    tag: 'low-headroom',
    title: 'Data & Evaluation Platform is within 5,600 credits of its included-usage cap',
    meta: 'Projected to breach mid-cycle at the current run-rate -- review the cap/overflow posture',
    timestamp: '2026-06-13T18:05:00.000Z',
  },
  {
    id: 'alert-allowance-cliff',
    severity: 'info',
    tag: 'cliff',
    title: 'Promo allowance ends 2026-09-01',
    meta: 'The standard per-seat allowance is smaller (3,900 vs 7,000) -- plan the Sep 1 transition',
    timestamp: '2026-06-10T08:00:00.000Z',
  },
];
