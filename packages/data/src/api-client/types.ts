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

export interface CostCenterSummary {
  id: string;
  name: string;
  state: 'active' | 'archived';
  memberCount: number;
}

export interface HeavyUser {
  userId: string;
  userLogin: string;
  creditsUsed: number;
}

export interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
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
