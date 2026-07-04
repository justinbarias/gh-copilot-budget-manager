import { Octokit } from 'octokit';
import { rankHeavyUsers } from '@copilot-budget/core';
import { ALERTS } from '../msw/fixtures/alerts.js';
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
  auth?: string;
  baseUrl?: string;
}

interface UsageItem {
  date: string;
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
  user_id: string;
  user_login: string;
  ai_credits_used: number;
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
  let syncStatus: SyncStatus = { lastSyncedAt: null, inProgress: false };

  async function getUsageSummary(params: UsageSummaryParams = {}): Promise<UsageSummary> {
    const items = await paginateAll<UsageItem>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/usage',
      { enterprise, cost_center_id: params.costCenterId },
      (data) => (data as { usageItems: UsageItem[] }).usageItems,
    );

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
    const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', {
      enterprise,
    });
    const costCenters = (response.data as { costCenters: CostCenter[] }).costCenters;

    return Promise.all(
      costCenters.map(async (cc) => {
        const resources = await paginateAll<CostCenterResource>(
          octokit,
          '/enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource',
          { enterprise, cost_center_id: cc.id },
          (data) => (data as { resources: CostCenterResource[] }).resources,
        );
        return { id: cc.id, name: cc.name, state: cc.state, memberCount: resources.length };
      }),
    );
  }

  async function listHeavyUsers(): Promise<HeavyUser[]> {
    const items = await paginateAll<CreditsUsedItem>(
      octokit,
      '/enterprises/{enterprise}/copilot/metrics/reports/users-28-day',
      { enterprise },
      (data) => data as CreditsUsedItem[],
    );

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
    return syncStatus;
  }

  async function syncNow(): Promise<SyncStatus> {
    syncStatus = { lastSyncedAt: new Date().toISOString(), inProgress: false };
    return syncStatus;
  }

  return { getUsageSummary, listCostCenters, listHeavyUsers, listAlerts, getSyncStatus, syncNow };
}
