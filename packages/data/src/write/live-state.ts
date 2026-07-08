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
import { warnSkippedBudgetScopes, wireBudgetToInternal, type InternalBudgetIdentity } from '../api-client/budget-scope.js';
import { normalizeIncludedUsageCap } from '../api-client/cost-center-cap.js';
import { paginateAll } from '../api-client/paginate.js';
import { fetchUsageFanout } from '../api-client/usage-fetch.js';
import { fetchCycleUserCredits } from '../api-client/users-report.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Task 4.8's write engine needs a strictly richer live-read than the existing
// read-path fetchers in api-client/github-impl.ts (getUsageSummary/
// listCostCenters/listHeavyUsers): those project budgets down to
// {scope, entityName, amount} for ULB-precedence display, discarding the
// wire `id`/`budget_type`/`budget_product_sku` a PATCH/DELETE/POST mutation
// needs. This module is that richer read, reusing the SAME paginateAll
// helper (imported, not forked) so the two live-reads can never structurally
// drift from one another.

// Fuller projection of the budgets wire shape (OpenAPI-pinned,
// wire-contract-writes.md §1) than api-client/github-impl.ts's BudgetItem --
// adds the fields a mutation needs to target an existing row (id) or
// reconstruct a POST body (budget_type, budget_product_sku), on top of every
// field ControlState carries. budget_scope is the REAL seven-value wire enum
// (multi_user_customer / user / ...) -- translated to the internal model by
// the shared budget-scope mapper (api-client/budget-scope.ts), never read raw
// past this module.
interface WireBudget {
  id: string;
  budget_type: 'ProductPricing' | 'SkuPricing' | 'BundlePricing';
  budget_product_sku: string;
  budget_scope: string;
  budget_entity_name: string;
  /** The login, present when budget_scope is 'user' (the individual ULB). */
  user?: string | null;
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
  // R3 (disproven live 2026-07-08, 404 on GET .../resource): members are
  // EMBEDDED on the cost-center object returned by the list/get-one endpoints.
  resources: WireCostCenterResource[];
}

// The embedded cost-center resource row shape. `via_ent_team` is a
// simulation-only provenance enrichment (msw/fixtures/costCenters.ts); the
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

function toBudgetControl(wire: WireBudget, identity: InternalBudgetIdentity): BudgetControl {
  return {
    kind: 'budget',
    scope: identity.scope as BudgetScope,
    entityName: identity.entityName,
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
      // Cap normalization at the fetch boundary: the SAME shared mapper
      // github-impl.ts's fetchCostCentersRaw uses (cost-center-cap.ts) folds
      // the internal `included_usage_cap` (MSW) and real GHEC's flat
      // `ai_credit_pool_*` dialects into the internal shape -- the live
      // `.included_usage_cap.enabled` TypeError (2026-07-08) is impossible
      // past this line, whatever the tenant sends.
      return (response.data as { costCenters: WireCostCenter[] }).costCenters.map((cc) => ({
        ...cc,
        included_usage_cap: normalizeIncludedUsageCap(cc),
      }));
    })(),
  ]);

  // Task 4.13 / R3: the write engine diffs/executes cost-center membership, so
  // the re-read needs each cost center's resource roster. R3 (disproven live
  // 2026-07-08): that roster is EMBEDDED on the cost-center object -- no GET
  // .../resource endpoint exists -- so this is a map off the already-fetched
  // list, not a per-cost-center fan-out.
  const resourcesByCostCenterId = new Map<string, WireCostCenterResource[]>(
    rawCostCenters.map((cc) => [cc.id, cc.resources ?? []] as const),
  );

  // Scope translation at the boundary (wire-contract-writes.md §1): each wire
  // budget is mapped to its internal identity (multi_user_customer ->
  // universal; user + user field -> individual). A null mapping means "no
  // internal home" -- `repository` (deliberately un-administered, packages/
  // core's BudgetScope) plus any unknown future enum value -- and the row is
  // skipped, never guessed into an internal scope.
  const allMapped = rawBudgetsAll.map((wire) => ({ wire, identity: wireBudgetToInternal(wire) }));
  const mappedBudgets = allMapped.filter(
    (m): m is { wire: WireBudget; identity: InternalBudgetIdentity } => m.identity !== null,
  );
  // Never silent: unsupported scopes are excluded from the controls state but
  // traced (see budget-scope.ts's warnSkippedBudgetScopes doc).
  warnSkippedBudgetScopes(
    allMapped.filter((m) => m.identity === null).map((m) => m.wire),
    'fetchLiveControls',
  );

  const budgetControls: BudgetControl[] = mappedBudgets.map(({ wire, identity }) => toBudgetControl(wire, identity));
  const capControls: IncludedCapControl[] = rawCostCenters.map(toCapControl);
  const costCenterControls: CostCenterControl[] = rawCostCenters.map((cc) =>
    toCostCenterControl(cc, resourcesByCostCenterId.get(cc.id) ?? []),
  );

  const budgetWireByIdentity = new Map<string, BudgetWireRef>(
    mappedBudgets.map(({ wire }, i) => [
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
// Task 4.11b (CLAUDE.md §6.1 preview-fidelity fix): usageState.users is seeded
// from the full licensed seat roster and each user's cross-phase TOTAL is the
// per-user metrics report figure (the meter a ULB, which caps total
// consumption, must be compared against), so simulatePlan evaluates every
// licensed seat -- not just the handful a single report happens to itemise.
//
// R5/R6 reconciliation (wire-contract-r3-r5-r6.md, 2026-07-08 live smoke) --
// the per-user pool-vs-metered SPLIT is no longer derivable from the real wire:
//   - The enterprise billing usage report (R5) carries NO user_login, so a
//     metered charge can no longer be attributed to a specific user. It still
//     gives us the ENTERPRISE-wide and PER-COST-CENTER pool/metered totals
//     (attribution by the fan-out query), which stay exact.
//   - The per-user metrics report (R6) carries only ai_credits_used (a single
//     cross-phase total per user), with no pool/metered breakdown.
// So UserUsage.meteredCreditsUsed is set to 0 for every user (the honest
// "unattributable" value), and poolCreditsUsed carries the whole per-user
// total. TOTAL (pool + metered) is preserved and correct; only the per-user
// SPLIT is lost. **FLAGGED**: simulatePlan.resolveUserBlockStatus keys
// spending-limit applicability off `meteredCreditsUsed > 0` ("already tipped
// into metered") -- with no per-user metered signal, that per-user branch now
// reads as "not yet metered" for everyone. Recovering it needs the documented
// `GET .../settings/billing/ai_credit/usage` endpoint's `user` filter
// (contract's "recorded, not adopted" note), deferred to Phase 4+. ULB binding
// (on the per-user TOTAL) is unaffected -- that is what the pool rebalancer and
// the $0-ULB block preview actually depend on.
export async function assembleUsageState(
  octokit: Octokit,
  enterprise: string,
  costCenterIdByName: ReadonlyMap<string, string>,
  asOfDate: Date,
): Promise<UsageState> {
  interface WireSeat {
    assignee: { login: string };
  }
  interface WireCostCenter {
    id: string;
    name: string;
    resources?: Array<{ type: 'User' | 'Org' | 'Repo' | 'EnterpriseTeam'; name: string }>;
  }

  const costCenterNameById = new Map([...costCenterIdByName.entries()].map(([name, id]) => [id, name]));
  const costCenterIds = [...costCenterIdByName.values()];
  const bounds = cycleBounds(asOfDate);

  const [usageItems, { records: creditRecords }, seats, costCenterList] = await Promise.all([
    // R5: enterprise usage via the default + per-cost-center fan-out (the only
    // correct enterprise-wide read now the default call excludes CC usage).
    fetchUsageFanout(octokit, enterprise, costCenterIds),
    // R6: cycle-accurate per-user totals via the users-1-day fan-out over the
    // elapsed cycle days -- the SAME source github-impl's read paths now use.
    // The <=2-day trailing-gap tolerance applies here too (a live dry-run
    // preview shouldn't hard-fail on today's not-yet-generated report); the
    // coverage day is only SURFACED via syncNow (SyncStatus), not previews.
    fetchCycleUserCredits(octokit, enterprise, bounds.cycleStart, bounds.daysElapsed),
    // Full licensed roster, so the fold seeds every seat (below).
    paginateAll<WireSeat>(
      octokit,
      '/enterprises/{enterprise}/copilot/billing/seats',
      { enterprise },
      (data) => (data as { seats: WireSeat[] }).seats,
    ),
    // R3: cost-center members are embedded on the list response -- one call,
    // no per-CC GET /resource fan-out.
    (async () => {
      const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', { enterprise });
      return (response.data as { costCenters: WireCostCenter[] }).costCenters;
    })(),
  ]);

  const costCenterNameByLogin = new Map<string, string>();
  for (const cc of costCenterList) {
    for (const r of cc.resources ?? []) {
      if (r.type === 'User') costCenterNameByLogin.set(r.name, cc.name);
    }
  }

  const toCredits = (amountUsd: number): number => Math.round(amountUsd * 100);

  // Same cycle window as listHeavyUsers/listCostCenters -- anchored to the
  // caller-supplied `asOfDate` clock seam (never wall-clock in sim). The
  // per-user report (R6) is already cycle-scoped by the fan-out; the usage
  // report (R5) is not, so its rows are cycle-filtered here (e.g. noah-tanaka's
  // Aug 31/Sep 1 allowance-cliff rows fall outside the June cycle).
  const inCycle = (date: string): boolean => {
    const dayIndex = Math.floor((Date.parse(`${date}T00:00:00.000Z`) - bounds.cycleStart.getTime()) / DAY_MS);
    return dayIndex >= 0 && dayIndex <= bounds.daysElapsed;
  };

  const costCenterTotals = new Map<string, { poolCreditsUsed: number; meteredCreditsUsed: number }>();
  let enterpriseMeteredCreditsUsed = 0;

  for (const item of usageItems) {
    if (!inCycle(item.date)) continue;
    const pool = toCredits(item.discountAmount);
    const metered = toCredits(item.netAmount);
    enterpriseMeteredCreditsUsed += metered;

    const ccName = item.costCenterId ? costCenterNameById.get(item.costCenterId) : undefined;
    if (ccName) {
      const t = costCenterTotals.get(ccName) ?? { poolCreditsUsed: 0, meteredCreditsUsed: 0 };
      t.poolCreditsUsed += pool;
      t.meteredCreditsUsed += metered;
      costCenterTotals.set(ccName, t);
    }
  }

  const totalCreditsByLogin = new Map<string, number>();
  for (const record of creditRecords) {
    totalCreditsByLogin.set(record.user_login, (totalCreditsByLogin.get(record.user_login) ?? 0) + record.ai_credits_used);
  }

  // Seeded from the full licensed roster (mirrors listHeavyUsers' "every seat
  // appears, even at 0 credits" convention) -- a $0/near-zero ULB must
  // correctly preview as blocking a user with NO usage at all (0 used <= 0 cap
  // headroom IS a block, CLAUDE.md §5/§6.4). meteredCreditsUsed is 0 for every
  // user: no per-user metered signal survives the real wire (see doc comment),
  // so the whole per-user TOTAL is reported as pool.
  const users: UserUsage[] = seats.map((seat) => {
    const userLogin = seat.assignee.login;
    const totalCreditsUsed = totalCreditsByLogin.get(userLogin) ?? 0;
    return {
      userLogin,
      costCenterName: costCenterNameByLogin.get(userLogin) ?? null,
      poolCreditsUsed: totalCreditsUsed,
      meteredCreditsUsed: 0,
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
