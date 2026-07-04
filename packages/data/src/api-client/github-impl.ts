import { Octokit } from 'octokit';
import { cycleBounds, rankHeavyUsers } from '@copilot-budget/core';
import { ALERTS } from '../msw/fixtures/alerts.js';
import { SIM_CURRENT_DATE } from '../msw/fixtures/constants.js';
import {
  getSyncStatus as readSyncStatus,
  syncNow as ingestSnapshot,
  type IngestCostCenterMember,
  type IngestData,
  type IngestResourceType,
} from '../sync/sync-now.js';
import type { Db } from '../db/client.js';
import type {
  Alert,
  ApiClient,
  CostCenterMemberSummary,
  CostCenterSummary,
  DailyBurnPoint,
  HeavyUser,
  SyncStatus,
  UsageSummary,
  UsageSummaryParams,
} from './types.js';

export interface GitHubApiClientConfig {
  enterprise: string;
  db: Db;
  source: 'msw' | 'github';
  auth?: string;
  baseUrl?: string;
}

interface UsageItem {
  date: string;
  cost_center_id: string | null;
  user_login: string | null;
  sku: string;
  quantity: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
}

interface CostCenter {
  id: string;
  name: string;
  state: 'active' | 'archived';
  dewr_division: string;
  dewr_branch: string;
  dewr_project: string;
  mtd_burn_credits: number;
  // Read-only upstream: the limit is license-derived by GitHub, never settable (CLAUDE.md §5).
  included_usage_cap: { enabled: boolean; computed_limit_credits: number; overflow: 'block' | 'metered' };
  excluded_from_enterprise_budget: boolean;
}

interface CostCenterResource {
  type: 'User' | 'Org' | 'Repo';
  name: string;
  via_ent_team?: string;
}

interface CreditsUsedItem {
  date: string;
  user_id: string;
  user_login: string;
  ai_credits_used: number;
}

interface Seat {
  assignee: { login: string; id: number; type: 'User' };
  created_at: string;
}

const RESOURCE_TYPE_MAP: Record<CostCenterResource['type'], IngestResourceType> = {
  User: 'user',
  Org: 'org',
  Repo: 'repository',
};

const DAY_MS = 24 * 60 * 60 * 1000;

// discount_amount is the $ portion of a usage row covered by the shared pool
// (vs. net_amount, the metered portion) -- dividing by $0.01/credit converts
// it back to the pool-phase credit count the Overview burn-down needs, so a
// cost center that's tipped into metered (discount 0) doesn't inflate the
// enterprise-wide pool-consumed figure it never actually drew from.
function poolCreditsForItem(item: Pick<UsageItem, 'discount_amount'>): number {
  return Math.round(item.discount_amount * 100);
}

// One point per calendar day from the cycle start through the as-of anchor
// (inclusive), cumulative -- days with no matching usage row legitimately
// carry the prior total forward rather than being omitted, so the actual
// line reflects "no observed usage" instead of a misleading gap.
function buildDailyBurn(items: UsageItem[], cycleStart: Date, daysElapsed: number): DailyBurnPoint[] {
  const creditsByDate = new Map<string, number>();
  for (const item of items) {
    const itemTime = Date.parse(`${item.date}T00:00:00.000Z`);
    const dayIndex = Math.floor((itemTime - cycleStart.getTime()) / DAY_MS);
    if (dayIndex < 0 || dayIndex > daysElapsed) continue;
    creditsByDate.set(item.date, (creditsByDate.get(item.date) ?? 0) + poolCreditsForItem(item));
  }

  const points: DailyBurnPoint[] = [];
  let cumulative = 0;
  for (let i = 0; i <= daysElapsed; i++) {
    const date = new Date(cycleStart.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    cumulative += creditsByDate.get(date) ?? 0;
    points.push({ date, cumulativePoolCredits: cumulative });
  }
  return points;
}

// Follows the Link `rel="next"` header rather than Octokit's paginate plugin:
// these enterprise billing routes aren't in Octokit's typed endpoint catalog
// (they're 2026-dated per the PRD), so paginate's route-based overloads don't
// apply — a plain request loop keeps this correct without fighting generics.
async function paginateAll<T>(
  octokit: Octokit,
  url: string,
  params: Record<string, string | number | undefined>,
  extract: (data: unknown) => T[],
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const perPage = 100;

  for (;;) {
    const response = await octokit.request(`GET ${url}`, { ...params, page, per_page: perPage });
    results.push(...extract(response.data));

    const link = response.headers.link;
    if (!link || !link.includes('rel="next"')) break;
    page += 1;
  }

  return results;
}

export function createGitHubApiClient(config: GitHubApiClientConfig): ApiClient {
  const octokit = new Octokit({ auth: config.auth, baseUrl: config.baseUrl });
  const enterprise = config.enterprise;

  async function fetchUsageItems(params: UsageSummaryParams = {}): Promise<UsageItem[]> {
    return paginateAll<UsageItem>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/usage',
      { enterprise, cost_center_id: params.costCenterId },
      (data) => (data as { usageItems: UsageItem[] }).usageItems,
    );
  }

  async function fetchCreditsUsedItems(): Promise<CreditsUsedItem[]> {
    return paginateAll<CreditsUsedItem>(
      octokit,
      '/enterprises/{enterprise}/copilot/metrics/reports/users-28-day',
      { enterprise },
      (data) => data as CreditsUsedItem[],
    );
  }

  async function fetchCostCentersRaw(): Promise<CostCenter[]> {
    const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', {
      enterprise,
    });
    return (response.data as { costCenters: CostCenter[] }).costCenters;
  }

  async function fetchCostCenterResources(costCenterId: string): Promise<CostCenterResource[]> {
    return paginateAll<CostCenterResource>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource',
      { enterprise, cost_center_id: costCenterId },
      (data) => (data as { resources: CostCenterResource[] }).resources,
    );
  }

  async function fetchSeats(): Promise<Seat[]> {
    return paginateAll<Seat>(
      octokit,
      '/enterprises/{enterprise}/copilot/billing/seats',
      { enterprise },
      (data) => (data as { seats: Seat[] }).seats,
    );
  }

  async function getUsageSummary(params: UsageSummaryParams = {}): Promise<UsageSummary> {
    const [items, seats] = await Promise.all([fetchUsageItems(params), fetchSeats()]);

    const asOfDate = items.reduce<string | null>(
      (latest, item) => (latest === null || item.date > latest ? item.date : latest),
      null,
    );

    const cycleAsOfDate = SIM_CURRENT_DATE;
    const bounds = cycleBounds(new Date(`${cycleAsOfDate}T00:00:00.000Z`));
    const dailyBurn = buildDailyBurn(items, bounds.cycleStart, bounds.daysElapsed);

    return {
      asOfDate,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      totalGrossAmountUsd: items.reduce((sum, item) => sum + item.gross_amount, 0),
      totalDiscountAmountUsd: items.reduce((sum, item) => sum + item.discount_amount, 0),
      totalNetAmountUsd: items.reduce((sum, item) => sum + item.net_amount, 0),
      licenseCount: seats.length,
      cycleAsOfDate,
      dailyBurn,
    };
  }

  async function listCostCenters(): Promise<CostCenterSummary[]> {
    const [costCenters, creditsUsedItems] = await Promise.all([fetchCostCentersRaw(), fetchCreditsUsedItems()]);

    // Per-member cycle-to-date burn: same cycle window as getUsageSummary
    // (anchored to the deterministic fixture date, never wall-clock), so a
    // member whose only credits rows fall outside the current cycle burns 0.
    const bounds = cycleBounds(new Date(`${SIM_CURRENT_DATE}T00:00:00.000Z`));
    const burnByLogin = new Map<string, number>();
    for (const item of creditsUsedItems) {
      const dayIndex = Math.floor((Date.parse(`${item.date}T00:00:00.000Z`) - bounds.cycleStart.getTime()) / DAY_MS);
      if (dayIndex < 0 || dayIndex > bounds.daysElapsed) continue;
      burnByLogin.set(item.user_login, (burnByLogin.get(item.user_login) ?? 0) + item.ai_credits_used);
    }

    return Promise.all(
      costCenters.map(async (cc) => {
        const resources = await fetchCostCenterResources(cc.id);
        const members: CostCenterMemberSummary[] = resources
          .filter((r) => r.type === 'User')
          .map((r) => ({
            login: r.name,
            mtdBurnCredits: burnByLogin.get(r.name) ?? 0,
            entTeam: r.via_ent_team ?? null,
          }));

        return {
          id: cc.id,
          name: cc.name,
          state: cc.state,
          memberCount: resources.length,
          dewrDivision: cc.dewr_division,
          dewrBranch: cc.dewr_branch,
          dewrProject: cc.dewr_project,
          mtdBurnCredits: cc.mtd_burn_credits,
          includedUsageCap: {
            enabled: cc.included_usage_cap.enabled,
            computedLimitCredits: cc.included_usage_cap.computed_limit_credits,
            overflow: cc.included_usage_cap.overflow,
          },
          excludedFromEnterpriseBudget: cc.excluded_from_enterprise_budget,
          members,
        };
      }),
    );
  }

  async function listHeavyUsers(): Promise<HeavyUser[]> {
    const items = await fetchCreditsUsedItems();

    const totals = new Map<string, HeavyUser>();
    for (const item of items) {
      const existing = totals.get(item.user_id);
      if (existing) {
        existing.creditsUsed += item.ai_credits_used;
      } else {
        totals.set(item.user_id, {
          userId: item.user_id,
          userLogin: item.user_login,
          creditsUsed: item.ai_credits_used,
        });
      }
    }

    return rankHeavyUsers([...totals.values()]);
  }

  async function listAlerts(): Promise<Alert[]> {
    return ALERTS;
  }

  async function getSyncStatus(): Promise<SyncStatus> {
    return readSyncStatus(config.db);
  }

  async function syncNow(): Promise<SyncStatus> {
    const [usageItems, creditsUsedItems, costCentersRaw, seats] = await Promise.all([
      fetchUsageItems(),
      fetchCreditsUsedItems(),
      fetchCostCentersRaw(),
      fetchSeats(),
    ]);

    const resourcesByCostCenter = await Promise.all(
      costCentersRaw.map(async (cc) => ({ costCenterId: cc.id, resources: await fetchCostCenterResources(cc.id) })),
    );

    const costCenterMembers: IngestCostCenterMember[] = resourcesByCostCenter.flatMap(({ costCenterId, resources }) =>
      resources.map((r) => ({ costCenterId, resourceType: RESOURCE_TYPE_MAP[r.type], resourceId: r.name })),
    );

    const loginToCostCenter = new Map<string, string>();
    for (const { costCenterId, resources } of resourcesByCostCenter) {
      for (const r of resources) {
        if (r.type === 'User') loginToCostCenter.set(r.name, costCenterId);
      }
    }

    const data: IngestData = {
      entity: enterprise,
      usageItems: usageItems.map((item) => ({
        date: item.date,
        costCenterId: item.cost_center_id,
        userLogin: item.user_login,
        sku: item.sku,
        quantity: item.quantity,
        netAmountUsd: item.net_amount,
      })),
      creditsUsedItems: creditsUsedItems.map((item) => ({
        date: item.date,
        userId: item.user_id,
        creditsUsed: item.ai_credits_used,
      })),
      costCenters: costCentersRaw.map((cc) => ({ id: cc.id, name: cc.name, state: cc.state })),
      costCenterMembers,
      // license.userId uses the numeric GitHub user id (matching credits_used_fact's
      // user_id key) -- seats and cost-center resources are two different GitHub APIs,
      // keyed by id vs. login respectively (PRD §2.3: no single API gives both), so
      // this is a best-effort join on login.
      licenses: seats.map((seat) => ({
        userId: String(seat.assignee.id),
        costCenterId: loginToCostCenter.get(seat.assignee.login) ?? null,
        assignedAt: new Date(seat.created_at),
      })),
    };

    ingestSnapshot(config.db, config.source, data);
    return readSyncStatus(config.db);
  }

  return { getUsageSummary, listCostCenters, listHeavyUsers, listAlerts, getSyncStatus, syncNow };
}
