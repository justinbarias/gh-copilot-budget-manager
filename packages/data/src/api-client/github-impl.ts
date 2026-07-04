import { Octokit } from 'octokit';
import { rankHeavyUsers } from '@copilot-budget/core';
import { ALERTS } from '../msw/fixtures/alerts.js';
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
  CostCenterSummary,
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
}

interface CostCenterResource {
  type: 'User' | 'Org' | 'Repo';
  name: string;
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
    const items = await fetchUsageItems(params);

    const asOfDate = items.reduce<string | null>(
      (latest, item) => (latest === null || item.date > latest ? item.date : latest),
      null,
    );

    return {
      asOfDate,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      totalGrossAmountUsd: items.reduce((sum, item) => sum + item.gross_amount, 0),
      totalDiscountAmountUsd: items.reduce((sum, item) => sum + item.discount_amount, 0),
      totalNetAmountUsd: items.reduce((sum, item) => sum + item.net_amount, 0),
    };
  }

  async function listCostCenters(): Promise<CostCenterSummary[]> {
    const costCenters = await fetchCostCentersRaw();

    return Promise.all(
      costCenters.map(async (cc) => {
        const resources = await fetchCostCenterResources(cc.id);
        return { id: cc.id, name: cc.name, state: cc.state, memberCount: resources.length };
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
