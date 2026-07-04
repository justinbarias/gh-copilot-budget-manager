import { COST_CENTER_IDS } from './constants.js';

export interface CostCenter {
  id: string;
  name: string;
  state: 'active' | 'archived';
}

export interface CostCenterResource {
  type: 'User' | 'Org' | 'Repo';
  name: string;
}

export const COST_CENTERS: CostCenter[] = [
  { id: COST_CENTER_IDS.platform, name: 'Platform', state: 'active' },
  { id: COST_CENTER_IDS.dataAnalytics, name: 'Data & Analytics', state: 'active' },
  // Edge fixture: this team has fully consumed its GitHub-computed included-usage
  // cap for the pool phase. There is no settable amount to point at — the cap
  // itself isn't in this MVP's schema — so "cap-bound" here means downstream
  // consumers (forecasting/rebalancing) must treat this cost center as having
  // zero pool headroom despite unused enterprise budget elsewhere.
  { id: COST_CENTER_IDS.capBound, name: 'Marketing (Cap-Bound)', state: 'active' },
];

function userResources(logins: string[]): CostCenterResource[] {
  return logins.map((name) => ({ type: 'User', name }));
}

function seatLogin(n: number): string {
  return `user-${String(n).padStart(2, '0')}`;
}

export const COST_CENTER_RESOURCES: Record<string, CostCenterResource[]> = {
  [COST_CENTER_IDS.platform]: userResources(Array.from({ length: 15 }, (_, i) => seatLogin(i + 1))),
  [COST_CENTER_IDS.dataAnalytics]: userResources(Array.from({ length: 10 }, (_, i) => seatLogin(i + 16))),
  [COST_CENTER_IDS.capBound]: userResources(Array.from({ length: 10 }, (_, i) => seatLogin(i + 26))),
};
