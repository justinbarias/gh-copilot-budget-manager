import type { Octokit } from 'octokit';
import {
  controlIdentity,
  type BudgetControl,
  type BudgetScope,
  type ControlState,
  type IncludedCapControl,
  type UsageState,
} from '@copilot-budget/core';
import { paginateAll } from '../api-client/paginate.js';

// Task 4.8's write engine needs a strictly richer live-read than the existing
// read-path fetchers in api-client/github-impl.ts (getUsageSummary/
// listCostCenters/listHeavyUsers): those project budgets down to
// {scope, entityName, amount} for ULB-precedence display, discarding the
// wire `id`/`budget_type`/`budget_product_sku` a PATCH/DELETE/POST mutation
// needs. This module is that richer read, reusing the SAME paginateAll
// helper (imported, not forked) so the two live-reads can never structurally
// drift from one another.

// Fuller projection of the budgets wire shape (PRD §2.3 / §4.2) than
// api-client/github-impl.ts's BudgetItem -- adds the fields a mutation needs
// to target an existing row (id) or reconstruct a POST body (budget_type,
// budget_product_sku), on top of every field ControlState carries.
interface WireBudget {
  id: string;
  budget_type: 'ProductPricing' | 'SkuPricing' | 'BundlePricing';
  budget_product_sku: string;
  budget_scope: BudgetScope | 'repository';
  budget_entity_name: string;
  budget_amount: number;
  prevent_further_usage: boolean;
  budget_alerting: { will_alert: boolean; alert_recipients: string[] };
}

interface WireCostCenter {
  id: string;
  name: string;
  included_usage_cap: { enabled: boolean; computed_limit_credits: number; overflow: 'block' | 'metered' };
}

// budget_amount is USD (PRD §2.3); ControlState.amountCredits is credits
// (CLAUDE.md §5: 1 credit = $0.01) -- local copy of api-client/github-impl.ts's
// private usdToCredits (not exported there, and too small to warrant a shared
// module of its own).
function usdToCredits(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

function toBudgetControl(wire: WireBudget): BudgetControl {
  return {
    kind: 'budget',
    scope: wire.budget_scope as BudgetScope,
    entityName: wire.budget_entity_name,
    amountCredits: usdToCredits(wire.budget_amount),
    preventFurtherUsage: wire.prevent_further_usage,
    alerting: { willAlert: wire.budget_alerting.will_alert, alertRecipients: wire.budget_alerting.alert_recipients },
  };
}

function toCapControl(wire: WireCostCenter): IncludedCapControl {
  return {
    kind: 'included_cap',
    costCenterName: wire.name,
    enabled: wire.included_usage_cap.enabled,
    overflow: wire.included_usage_cap.overflow,
    computedLimitCredits: wire.included_usage_cap.computed_limit_credits,
  };
}

/** Wire-level identity needed to target an existing budget with PATCH/DELETE. */
export interface BudgetWireRef {
  id: string;
  budgetType: WireBudget['budget_type'];
  budgetProductSku: string;
}

export interface LiveControlsResult {
  /** core-shaped controls -- feeds diffControls/validatePlan/simulatePlan/applyPlanToControls unchanged. */
  controls: ControlState[];
  /** controlIdentity(budgetControl) -> wire id/type/sku, for PATCH/DELETE/POST execution. */
  budgetWireByIdentity: Map<string, BudgetWireRef>;
  /** cost-center display name -> wire cost_center_id, for the cap PATCH's :cost_center_id path segment. */
  costCenterIdByName: Map<string, string>;
}

// The write engine's re-read (CLAUDE.md §6.2: "re-read live state before
// applying") AND the ApiClient.getControls() read method are the SAME
// function -- not two independently-written projections of the wire shape.
// This is deliberate: if getControls() (what the UI diffs its staged plan
// against) and the engine's re-read produced even slightly different
// ControlState shapes for identical live data, a legitimate no-drift apply
// would false-positive as drift.
export async function fetchLiveControls(octokit: Octokit, enterprise: string): Promise<LiveControlsResult> {
  const [rawBudgetsAll, rawCostCenters] = await Promise.all([
    paginateAll<WireBudget>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/budgets',
      { enterprise },
      (data) => (data as { budgets: WireBudget[] }).budgets,
    ),
    (async () => {
      const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', {
        enterprise,
      });
      return (response.data as { costCenters: WireCostCenter[] }).costCenters;
    })(),
  ]);

  // `repository`-scope budgets are excluded from ControlState's BudgetScope
  // union (packages/core/src/controls.ts: "not a scope this tool
  // administers per the Phase 4 task breakdown") -- filtered out here for
  // the same reason, defensively (no repository-scope fixture exists today).
  const rawBudgets = rawBudgetsAll.filter((b) => b.budget_scope !== 'repository');

  const budgetControls: BudgetControl[] = rawBudgets.map(toBudgetControl);
  const capControls: IncludedCapControl[] = rawCostCenters.map(toCapControl);

  const budgetWireByIdentity = new Map<string, BudgetWireRef>(
    rawBudgets.map((wire, i) => [
      controlIdentity(budgetControls[i]!),
      { id: wire.id, budgetType: wire.budget_type, budgetProductSku: wire.budget_product_sku },
    ]),
  );
  const costCenterIdByName = new Map(rawCostCenters.map((cc) => [cc.name, cc.id]));

  return {
    controls: [...budgetControls, ...capControls],
    budgetWireByIdentity,
    costCenterIdByName,
  };
}

// dryRunPlan-only (CLAUDE.md's simulate-before-apply preview) -- deliberately
// NOT used by applyPlan, which validates against ControlState alone
// (validatePlan takes no UsageState). Keeping usage assembly out of the apply
// path keeps the money-critical re-read -> diff -> validate -> mutate -> audit
// pipeline lean and independent of usage-aggregation correctness.
//
// v1: a minimal, good-enough-for-simulatePlan projection, not a full
// dashboard aggregation (that's api-client/github-impl.ts's
// getUsageSummary/listHeavyUsers, which this deliberately does not
// duplicate). Per-user pool/metered split mirrors the same discount/net
// convention those read paths use.
export async function assembleUsageState(
  octokit: Octokit,
  enterprise: string,
  costCenterIdByName: ReadonlyMap<string, string>,
): Promise<UsageState> {
  interface WireUsageItem {
    cost_center_id: string | null;
    user_login: string | null;
    discount_amount: number;
    net_amount: number;
  }
  interface WireCostCenterResource {
    type: 'User' | 'Org' | 'Repo' | 'EnterpriseTeam';
    name: string;
  }

  const costCenterNameById = new Map([...costCenterIdByName.entries()].map(([name, id]) => [id, name]));

  const [usageItems, resourcesByCostCenter] = await Promise.all([
    paginateAll<WireUsageItem>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/usage',
      { enterprise },
      (data) => (data as { usageItems: WireUsageItem[] }).usageItems,
    ),
    Promise.all(
      [...costCenterIdByName.values()].map(async (costCenterId) => ({
        costCenterId,
        resources: await paginateAll<WireCostCenterResource>(
          octokit,
          '/enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource',
          { enterprise, cost_center_id: costCenterId },
          (data) => (data as { resources: WireCostCenterResource[] }).resources,
        ),
      })),
    ),
  ]);

  const costCenterNameByLogin = new Map<string, string>();
  for (const { costCenterId, resources } of resourcesByCostCenter) {
    const costCenterName = costCenterNameById.get(costCenterId);
    if (!costCenterName) continue;
    for (const r of resources) {
      if (r.type === 'User') costCenterNameByLogin.set(r.name, costCenterName);
    }
  }

  const poolCredits = (amountUsd: number): number => Math.round(amountUsd * 100);

  const userTotals = new Map<string, { poolCreditsUsed: number; meteredCreditsUsed: number }>();
  const costCenterTotals = new Map<string, { poolCreditsUsed: number; meteredCreditsUsed: number }>();
  let enterpriseMeteredCreditsUsed = 0;

  for (const item of usageItems) {
    const pool = poolCredits(item.discount_amount);
    const metered = poolCredits(item.net_amount);
    enterpriseMeteredCreditsUsed += metered;

    if (item.user_login) {
      const t = userTotals.get(item.user_login) ?? { poolCreditsUsed: 0, meteredCreditsUsed: 0 };
      t.poolCreditsUsed += pool;
      t.meteredCreditsUsed += metered;
      userTotals.set(item.user_login, t);
    }

    const ccName = item.cost_center_id ? costCenterNameById.get(item.cost_center_id) : undefined;
    if (ccName) {
      const t = costCenterTotals.get(ccName) ?? { poolCreditsUsed: 0, meteredCreditsUsed: 0 };
      t.poolCreditsUsed += pool;
      t.meteredCreditsUsed += metered;
      costCenterTotals.set(ccName, t);
    }
  }

  const users = [...userTotals.entries()].map(([userLogin, totals]) => ({
    userLogin,
    costCenterName: costCenterNameByLogin.get(userLogin) ?? null,
    ...totals,
  }));

  const costCenters = [...costCenterTotals.entries()].map(([costCenterName, totals]) => ({
    costCenterName,
    ...totals,
  }));

  return {
    enterprise: { entityName: enterprise, meteredCreditsUsed: enterpriseMeteredCreditsUsed },
    users,
    costCenters,
  };
}
