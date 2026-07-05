import type { Octokit } from 'octokit';
import {
  controlIdentity,
  cycleBounds,
  type BudgetControl,
  type BudgetScope,
  type ControlState,
  type CostCenterControl,
  type CostCenterResourceRef,
  type IncludedCapControl,
  type UsageState,
  type UserUsage,
} from '@copilot-budget/core';
import { paginateAll } from '../api-client/paginate.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Task 4.14: MSW-only simulation enrichment (NOT a real GitHub wire field --
   * docs/api-surface-validation.md's "ULB display-bug detection signal"
   * entry). Modelled on the budgets LIST response MSW already serves, set on
   * exactly one fixture (the `ulbDisplayBug` budget); carried onto
   * BudgetControl.simulatedUiHidden below so the pure ULB-repair detector can
   * see it via getControls(). Always undefined against real GitHub.
   */
  simulatedUiHidden?: boolean;
}

interface WireCostCenter {
  id: string;
  name: string;
  dewr_division: string;
  dewr_branch: string;
  dewr_project: string;
  excluded_from_enterprise_budget: boolean;
  included_usage_cap: { enabled: boolean; computed_limit_credits: number; overflow: 'block' | 'metered' };
}

// The cost-center resource endpoint's row shape (Task 4.2 handler). `via_ent_team`
// is a simulation-only provenance enrichment (msw/fixtures/costCenters.ts); the
// diff basis only uses type + name, so it is deliberately dropped here.
interface WireCostCenterResource {
  type: CostCenterResourceRef['type'];
  name: string;
  via_ent_team?: string;
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
    // Task 4.14: carry the display-bug enrichment through for the ULB-repair
    // detector (only present in simulation -- see WireBudget/BudgetControl).
    // Omit the key entirely when absent so a healthy control deepEquals one
    // built from a response without the field (drift-check / audit fidelity).
    ...(wire.simulatedUiHidden === undefined ? {} : { simulatedUiHidden: wire.simulatedUiHidden }),
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

// Task 4.13: the cost center itself as a diffable/executable control. Its
// membership roster is the diff basis for the add/remove resource mutations,
// and its DEWR + exclude-flag fields ride the PATCH. The cap prefs mirror the
// live cap for a faithful round-trip, but diffCostCenter never diffs them (the
// IncludedCapControl above owns cap edits, Task 4.12).
function toCostCenterControl(wire: WireCostCenter, resources: readonly WireCostCenterResource[]): CostCenterControl {
  return {
    kind: 'cost_center',
    name: wire.name,
    dewrDivision: wire.dewr_division,
    dewrBranch: wire.dewr_branch,
    dewrProject: wire.dewr_project,
    excludedFromEnterpriseBudget: wire.excluded_from_enterprise_budget,
    members: resources.map((r) => ({ type: r.type, name: r.name })),
    includedUsageCap: { enabled: wire.included_usage_cap.enabled, overflow: wire.included_usage_cap.overflow },
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
// `_asOfDate` is threaded for signature symmetry with assembleUsageState below
// (both are the write engine's live re-reads, called side by side) and as
// forward-compat for a future cycle-anchored live control read. It is
// deliberately UNUSED here today: the budgets / cost-centers / resource reads
// below are point-in-time (GitHub returns the current control set), not
// cycle-windowed, so there is no date-relative derivation for it to anchor --
// and, importantly, NO stale SIM_CURRENT_DATE read hides in this path either.
// Prefixed `_` to mark that "intentionally unused", not "forgotten to wire".
export async function fetchLiveControls(octokit: Octokit, enterprise: string, _asOfDate: Date): Promise<LiveControlsResult> {
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

  // Task 4.13: the write engine now diffs/executes cost-center membership too,
  // so the re-read fetches each cost center's resource roster (the SAME
  // paginated endpoint listCostCenters/assembleUsageState already read). One
  // request per cost center; the mock is stateless so this stays deterministic.
  const resourcesByCostCenterId = new Map<string, WireCostCenterResource[]>(
    await Promise.all(
      rawCostCenters.map(
        async (cc) =>
          [
            cc.id,
            await paginateAll<WireCostCenterResource>(
              octokit,
              '/enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource',
              { enterprise, cost_center_id: cc.id },
              (data) => (data as { resources: WireCostCenterResource[] }).resources,
            ),
          ] as const,
      ),
    ),
  );

  // `repository`-scope budgets are excluded from ControlState's BudgetScope
  // union (packages/core/src/controls.ts: "not a scope this tool
  // administers per the Phase 4 task breakdown") -- filtered out here for
  // the same reason, defensively (no repository-scope fixture exists today).
  const rawBudgets = rawBudgetsAll.filter((b) => b.budget_scope !== 'repository');

  const budgetControls: BudgetControl[] = rawBudgets.map(toBudgetControl);
  const capControls: IncludedCapControl[] = rawCostCenters.map(toCapControl);
  const costCenterControls: CostCenterControl[] = rawCostCenters.map((cc) =>
    toCostCenterControl(cc, resourcesByCostCenterId.get(cc.id) ?? []),
  );

  const budgetWireByIdentity = new Map<string, BudgetWireRef>(
    rawBudgets.map((wire, i) => [
      controlIdentity(budgetControls[i]!),
      { id: wire.id, budgetType: wire.budget_type, budgetProductSku: wire.budget_product_sku },
    ]),
  );
  const costCenterIdByName = new Map(rawCostCenters.map((cc) => [cc.name, cc.id]));

  return {
    controls: [...budgetControls, ...capControls, ...costCenterControls],
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
// Task 4.11b (CLAUDE.md §6.1 preview-fidelity fix; docs/pending/todo.md's
// REQUIRED pre-Checkpoint-4 line): v1 built usageState.users from the
// enterprise billing-usage report ALONE, which itemises per-user rows for
// exactly two logins in the whole fixture world (faisal-noor, noah-tanaka) --
// every other user's burn lives only in the per-user metrics/CREDITS_USED
// report, so a preview for any other user (e.g. a $0 ULB staged for a heavy
// user the billing report never names) honestly-but-misleadingly showed "0
// newly blocked". This version folds in that metrics report -- the SAME one
// api-client/github-impl.ts's listHeavyUsers/listCostCenters already read --
// using the SAME cycleBounds(SIM_CURRENT_DATE) window and the SAME
// full-seat-roster seeding those two read paths use, so simulatePlan now
// evaluates every licensed seat, not just the two billing-report standouts.
//
// Two-report reconciliation rule (msw/fixtures/README.md's coherence-equation
// §3: "Billing (USAGE_ITEMS) and per-user metrics (CREDITS_USED_ITEMS) are
// different GitHub APIs"; CLAUDE.md §5: "ULBs cap a person's TOTAL across
// both phases"): for a user attributed in BOTH reports (e.g. faisal-noor:
// 4,180-credit metrics-report total vs. a 2,300-credit billing-report metered
// row), the two are NEVER summed --
//   - TOTAL comes from the metrics report: the one per-user meter that
//     actually spans both phases, so it's what a ULB (which caps total
//     consumption) must be compared against.
//   - METERED comes from the billing report's per-user attribution where
//     present, else 0: this is specifically the metered-phase signal
//     simulatePlan's resolveUserBlockStatus keys spending-limit applicability
//     off of (`meteredCreditsUsed > 0` == "already tipped into metered").
//   - POOL is the remainder (total − metered), floored at 0 -- metered should
//     never legitimately exceed total, but a report-skew defensively clamps
//     to a non-negative pool credit count rather than surfacing a nonsensical
//     negative one.
// (Flagged judgment call, untestable against the current fixture set: a user
// the metrics report doesn't carry AT ALL but the billing report attributes
// as metered would fall back to the billing figure as their total rather than
// silently reading as zero usage -- no such user exists in this fixture
// world, so this branch is conservative-but-unexercised.)
export async function assembleUsageState(
  octokit: Octokit,
  enterprise: string,
  costCenterIdByName: ReadonlyMap<string, string>,
  asOfDate: Date,
): Promise<UsageState> {
  interface WireUsageItem {
    date: string;
    cost_center_id: string | null;
    user_login: string | null;
    discount_amount: number;
    net_amount: number;
  }
  interface WireCreditsUsedItem {
    date: string;
    user_login: string;
    ai_credits_used: number;
  }
  interface WireSeat {
    assignee: { login: string };
  }
  interface WireCostCenterResource {
    type: 'User' | 'Org' | 'Repo' | 'EnterpriseTeam';
    name: string;
  }

  const costCenterNameById = new Map([...costCenterIdByName.entries()].map(([name, id]) => [id, name]));

  const [usageItems, creditsUsedItems, seats, resourcesByCostCenter] = await Promise.all([
    paginateAll<WireUsageItem>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/usage',
      { enterprise },
      (data) => (data as { usageItems: WireUsageItem[] }).usageItems,
    ),
    // Same route api-client/github-impl.ts's fetchCreditsUsedItems reads for
    // listHeavyUsers/listCostCenters -- not a new endpoint this task adds.
    paginateAll<WireCreditsUsedItem>(
      octokit,
      '/enterprises/{enterprise}/copilot/metrics/reports/users-28-day',
      { enterprise },
      (data) => data as WireCreditsUsedItem[],
    ),
    // Full licensed roster, so the fold seeds every seat (below), not just
    // the users either report happens to carry a row for.
    paginateAll<WireSeat>(
      octokit,
      '/enterprises/{enterprise}/copilot/billing/seats',
      { enterprise },
      (data) => (data as { seats: WireSeat[] }).seats,
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

  const toCredits = (amountUsd: number): number => Math.round(amountUsd * 100);

  // Same cycle window as listHeavyUsers/listCostCenters (api-client/
  // github-impl.ts) -- anchored to the caller-supplied `asOfDate` clock seam
  // (the deterministic fixture "now" in simulation, the real wall clock in
  // live mode -- api-client/clock.ts). Applied uniformly to BOTH reports and every rollup below
  // (per-user, per-cost-center, enterprise): the latent bug this task fixes
  // is that v1 applied NO cycle filter at all, so noah-tanaka's Aug 31/Sep 1
  // allowance-cliff rows (both outside the June cycle, attributed to the
  // Workforce Australia Platform cost center) leaked into every sum that
  // touched them.
  const bounds = cycleBounds(asOfDate);
  const inCycle = (date: string): boolean => {
    const dayIndex = Math.floor((Date.parse(`${date}T00:00:00.000Z`) - bounds.cycleStart.getTime()) / DAY_MS);
    return dayIndex >= 0 && dayIndex <= bounds.daysElapsed;
  };

  const meteredCreditsByLogin = new Map<string, number>();
  const costCenterTotals = new Map<string, { poolCreditsUsed: number; meteredCreditsUsed: number }>();
  let enterpriseMeteredCreditsUsed = 0;

  for (const item of usageItems) {
    if (!inCycle(item.date)) continue;
    const pool = toCredits(item.discount_amount);
    const metered = toCredits(item.net_amount);
    enterpriseMeteredCreditsUsed += metered;

    if (item.user_login) {
      meteredCreditsByLogin.set(item.user_login, (meteredCreditsByLogin.get(item.user_login) ?? 0) + metered);
    }

    const ccName = item.cost_center_id ? costCenterNameById.get(item.cost_center_id) : undefined;
    if (ccName) {
      const t = costCenterTotals.get(ccName) ?? { poolCreditsUsed: 0, meteredCreditsUsed: 0 };
      t.poolCreditsUsed += pool;
      t.meteredCreditsUsed += metered;
      costCenterTotals.set(ccName, t);
    }
  }

  const totalCreditsByLogin = new Map<string, number>();
  for (const item of creditsUsedItems) {
    if (!inCycle(item.date)) continue;
    totalCreditsByLogin.set(item.user_login, (totalCreditsByLogin.get(item.user_login) ?? 0) + item.ai_credits_used);
  }

  // Seeded from the full licensed roster (mirrors listHeavyUsers' "every seat
  // appears, even at 0 credits" convention) -- a $0/near-zero ULB must
  // correctly preview as blocking a user with NO usage at all (0 used <= 0
  // cap headroom IS a block, CLAUDE.md §5/§6.4's near-zero-ULB validation),
  // which a usageState that only carries rows for users WITH usage could
  // never surface.
  const users: UserUsage[] = seats.map((seat) => {
    const userLogin = seat.assignee.login;
    const meteredCreditsUsed = meteredCreditsByLogin.get(userLogin) ?? 0;
    // See the function doc comment's reconciliation rule: total is the
    // metrics-report figure; the billing-report metered figure is only a
    // fallback total for a login the metrics report doesn't carry at all.
    const totalCreditsUsed = totalCreditsByLogin.get(userLogin) ?? meteredCreditsByLogin.get(userLogin) ?? 0;
    return {
      userLogin,
      costCenterName: costCenterNameByLogin.get(userLogin) ?? null,
      poolCreditsUsed: Math.max(0, totalCreditsUsed - meteredCreditsUsed),
      meteredCreditsUsed,
    };
  });

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
