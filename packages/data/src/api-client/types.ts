export interface UsageSummaryParams {
  costCenterId?: string;
}

export interface DailyBurnPoint {
  date: string; // YYYY-MM-DD, one entry per day of the current cycle up to cycleAsOfDate
  cumulativePoolCredits: number; // running total of pool-phase-covered credits (Overview burn-down's actual line)
}

export interface UsageSummary {
  asOfDate: string | null;
  totalQuantity: number;
  totalGrossAmountUsd: number;
  totalDiscountAmountUsd: number;
  totalNetAmountUsd: number;
  licenseCount: number; // ingested seat count, feeds poolAllowanceCredits
  cycleAsOfDate: string; // anchor date resolving the current billing cycle (see SIM_CURRENT_DATE)
  dailyBurn: DailyBurnPoint[]; // actual-only cumulative pool burn within the current cycle
}

export interface CostCenterMemberSummary {
  login: string;
  mtdBurnCredits: number; // cycle-to-date, joined from the per-user credits-used report
  entTeam: string | null; // enterprise-team provenance, when membership came via one
}

// The cap's limit is GitHub-computed from attributed licenses and never
// settable (CLAUDE.md §5) -- consumers must render computedLimitCredits
// read-only; enabled + overflow are the only knobs that exist upstream.
export interface IncludedUsageCap {
  enabled: boolean;
  computedLimitCredits: number;
  overflow: 'block' | 'metered';
}

export interface CostCenterSummary {
  id: string;
  name: string;
  state: 'active' | 'archived';
  memberCount: number;
  dewrDivision: string; // DEWR mapping is columns on the cost-center row (PLAN.md Architecture Decisions)
  dewrBranch: string;
  dewrProject: string;
  mtdBurnCredits: number; // per-CC cycle-to-date credit total (pool + metered)
  includedUsageCap: IncludedUsageCap;
  excludedFromEnterpriseBudget: boolean;
  members: CostCenterMemberSummary[];
}

export interface HeavyUser {
  userId: string;
  userLogin: string;
  creditsUsed: number;
}

export interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  tag: string; // short mono category slug, e.g. "zero-ulb", "cap-bound" (design/README.md's "mono tag")
  title: string;
  meta: string;
  timestamp: string; // ISO 8601, anchored to fixture time (SIM_CURRENT_DATE-era) -- never wall-clock
  budgetId?: string;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  inProgress: boolean;
}

export interface ApiClient {
  getUsageSummary(params?: UsageSummaryParams): Promise<UsageSummary>;
  listCostCenters(): Promise<CostCenterSummary[]>;
  listHeavyUsers(): Promise<HeavyUser[]>;
  listAlerts(): Promise<Alert[]>;
  getSyncStatus(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
}
