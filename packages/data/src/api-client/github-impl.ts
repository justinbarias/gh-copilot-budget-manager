import { Octokit } from 'octokit';
import {
  computeModelMix,
  cycleBounds,
  fixedAllowanceLine,
  poolAllowanceLine,
  rankHeavyUsers,
  resolveEffectiveUlb,
  type AllowanceBasis,
  type ControlState,
  type ModelUsageRow,
  type Plan,
  type UlbCandidate,
} from '@copilot-budget/core';
import {
  assembleCostCenterSeries,
  assembleEnterpriseSeries,
  assembleUserSeries,
  computeScopeForecast,
  type AssembleCreditsUsedRow,
  type AssembleUsageRow,
} from '../forecast/compute.js';
import { ALERTS } from '../msw/fixtures/alerts.js';
import { API_VERSION, SIM_CURRENT_DATE } from '../msw/fixtures/constants.js';
import {
  getLastSyncedControls as readLastSyncedControls,
  getLatestForecast as readLatestForecast,
  getSyncStatus as readSyncStatus,
  syncNow as ingestSnapshot,
  type IngestCostCenterMember,
  type IngestData,
  type IngestForecastItem,
  type IngestResourceType,
} from '../sync/sync-now.js';
import { applyPlan as applyPlanEngine, dryRunPlan as dryRunPlanEngine } from '../write/engine.js';
import { fetchLiveControls } from '../write/live-state.js';
import { paginateAll } from './paginate.js';
import type { Db } from '../db/client.js';
import type {
  Alert,
  ApiClient,
  ApplyPlanInput,
  ApplyPlanResult,
  CostCenterMemberSummary,
  CostCenterSummary,
  DailyBurnPoint,
  DryRunResult,
  ForecastScope,
  HeavyUser,
  HeavyUserDailyPoint,
  LastSyncedControls,
  StoredForecast,
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
  model?: string; // simulation-only enrichment -- see msw/fixtures/usage.ts's CreditsUsedItem doc comment
}

interface Seat {
  assignee: { login: string; id: number; type: 'User' };
  created_at: string;
}

// Minimal projection of the budgets wire shape (PRD §2.3, §4.2): only the
// fields ULB-precedence resolution needs. `budget_amount` is USD (PRD §2.3's
// budget object doc) -- converted to credits the same way poolCreditsForItem
// converts discount_amount, below.
interface BudgetItem {
  budget_scope: 'universal' | 'individual' | 'multi_user_cost_center' | 'enterprise' | 'organization' | 'cost_center' | 'repository';
  budget_entity_name: string;
  budget_amount: number;
}

const ULB_BUDGET_SCOPES = new Set<BudgetItem['budget_scope']>(['individual', 'multi_user_cost_center', 'universal']);

const RESOURCE_TYPE_MAP: Record<CostCenterResource['type'], IngestResourceType> = {
  User: 'user',
  Org: 'org',
  Repo: 'repository',
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Task 5.4: the SAME allowance basis Overview.tsx hardcodes (ALLOWANCE_BASIS)
// -- duplicated here rather than imported (packages/ui must never be a
// dependency of packages/data, CLAUDE.md §2) -- until CLAUDE.md §9 Q1
// ("Enterprise or Business, github.com or GHE.com?") is answered and this
// becomes real ingested configuration instead of a pinned literal.
const ALLOWANCE_BASIS: AllowanceBasis = { edition: 'enterprise', existingCustomer: true };

// Task 5.4: whether pool exhaustion meters at $0.01/credit or hard-blocks
// (CLAUDE.md §9 Q2, still an open question generally). The DEWR fixture world
// itself demonstrates metered billing actually occurring at the enterprise
// level (the cap-bound CC's 2,300-credit overflow, the Aug31/Sep1 promo-cliff
// row) -- so `true` is the only value consistent with this simulation's own
// data, not an arbitrary default. Revisit once the real policy flag is
// ingested (Settings screen's "Policy state" per the design brief).
const ENTERPRISE_PAID_USAGE_ENABLED = true;

// A ULB is ALWAYS a hard stop in BOTH phases (CLAUDE.md §5) -- it never
// meters past its ceiling, unlike the enterprise/cost-center pool. Named
// (rather than an inline `false`) so every user-scope forecast call site
// documents *why* it's always false, not just that it is.
const USER_ULB_NEVER_METERS = false;

// discount_amount is the $ portion of a usage row covered by the shared pool
// (vs. net_amount, the metered portion) -- dividing by $0.01/credit converts
// it back to the pool-phase credit count the Overview burn-down needs, so a
// cost center that's tipped into metered (discount 0) doesn't inflate the
// enterprise-wide pool-consumed figure it never actually drew from.
function poolCreditsForItem(item: Pick<UsageItem, 'discount_amount'>): number {
  return Math.round(item.discount_amount * 100);
}

// budget_amount is USD (PRD §2.3); ULBs cap a person's *credit* consumption
// (CLAUDE.md §5), so the effective-ULB value the Users screen displays needs
// the same $0.01/credit conversion poolCreditsForItem applies above.
function usdToCredits(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

// Shared between listHeavyUsers and syncNow's Task 5.4 forecast computation
// (both need to resolve each user's effective ULB) -- factored out so there's
// exactly one place that turns raw budget rows into core's UlbCandidate[],
// rather than two independently-maintained projections of the same wire data.
function buildUlbCandidates(budgetsRaw: readonly BudgetItem[]): UlbCandidate[] {
  return budgetsRaw
    .filter((b) => ULB_BUDGET_SCOPES.has(b.budget_scope))
    .map((b) => ({
      scope: b.budget_scope as UlbCandidate['scope'],
      entityName: b.budget_entity_name,
      amountCredits: usdToCredits(b.budget_amount),
    }));
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

interface ComputeSyncForecastsParams {
  asOfDate: Date;
  historicalUsageItems: UsageItem[];
  historicalCreditsUsedItems: CreditsUsedItem[];
  costCentersRaw: CostCenter[];
  resourcesByCostCenter: Array<{ costCenterId: string; resources: CostCenterResource[] }>;
  seats: Seat[];
  budgetsRaw: BudgetItem[];
  loginToCostCenterName: Map<string, string>;
}

// Task 5.4: computes + shapes one forecast per (scope, entity) for syncNow to
// persist -- enterprise, every ACTIVE cost center, and every licensed user
// (the same roster listHeavyUsers seeds from, not just a "top N heavy"
// subset). Pure aside from its inputs already being fetched (no I/O of its
// own); kept in github-impl.ts rather than packages/data/src/forecast/
// compute.ts because it wires wire-shaped types (UsageItem/CostCenter/
// BudgetItem/Seat) and business rules (which allowance line, which
// paid-usage flag applies) that compute.ts deliberately stays agnostic of --
// compute.ts only folds rows into DailyBurn[] and glues forecast()/
// backtest() together, the same division of labour github-impl.ts already
// keeps for e.g. listHeavyUsers' ULB resolution.
function computeSyncForecasts(params: ComputeSyncForecastsParams): IngestForecastItem[] {
  const computedAt = SIM_CURRENT_DATE;
  const usageRows: AssembleUsageRow[] = params.historicalUsageItems.map((i) => ({
    date: i.date,
    costCenterId: i.cost_center_id,
    quantity: i.quantity,
  }));
  const creditRows: AssembleCreditsUsedRow[] = params.historicalCreditsUsedItems.map((i) => ({
    date: i.date,
    userId: i.user_id,
    creditsUsed: i.ai_credits_used,
  }));

  const forecasts: IngestForecastItem[] = [];

  // Enterprise scope: allowance is the pool line (steps at the 1 Sep 2026
  // cliff), sized off the full licensed seat count -- the SAME basis
  // Overview.tsx's burn-down uses (ALLOWANCE_BASIS, above).
  {
    const series = assembleEnterpriseSeries(usageRows, params.asOfDate);
    const { result, mape } = computeScopeForecast({
      history: series,
      asOfDate: params.asOfDate,
      allowance: poolAllowanceLine(params.seats.length, ALLOWANCE_BASIS),
      paidUsageEnabled: ENTERPRISE_PAID_USAGE_ENABLED,
    });
    forecasts.push({ scope: 'enterprise', entityId: null, computedAt, result, mape });
  }

  // Cost-center scope: every ACTIVE cost center. Cap-ON CCs forecast against
  // their license-derived cap (poolAllowanceLine sized off THIS cc's own
  // member count -- it steps at the cliff too; see forecast.ts's own doc
  // comment: "a cost-center's computed included-usage cap ... is licenses x
  // per-seat, so it steps too"); paidUsageEnabled mirrors the cap's OWN
  // overflow choice ('metered' bills past the cap, 'block' hard-stops --
  // CLAUDE.md §5), not the enterprise-wide paid-usage flag. Cap-OFF CCs get
  // a permanently-zero allowance line (fixedAllowanceLine(0)) --
  // forecast()'s exhaustion check requires `allowanceLine > 0`, so this
  // deterministically yields exhaustionDate: null / runwayDays: null /
  // projectedMeteredCredits: 0, i.e. "no CC-level exhaustion to report"
  // (there's no cap to exhaust against; the enterprise-scope forecast above
  // is where a cap-off CC's draw shows up). No CC in the DEWR fixture world
  // is cap-off, but every branch here is exercised directly by
  // compute.test.ts's synthetic scenarios.
  const resourcesById = new Map(params.resourcesByCostCenter.map((r) => [r.costCenterId, r.resources] as const));
  for (const cc of params.costCentersRaw.filter((c) => c.state === 'active')) {
    const memberCount = (resourcesById.get(cc.id) ?? []).filter((r) => r.type === 'User').length;
    const allowance = cc.included_usage_cap.enabled ? poolAllowanceLine(memberCount, ALLOWANCE_BASIS) : fixedAllowanceLine(0);
    const paidUsageEnabled = cc.included_usage_cap.enabled && cc.included_usage_cap.overflow === 'metered';
    const series = assembleCostCenterSeries(usageRows, cc.id, params.asOfDate);
    const { result, mape } = computeScopeForecast({ history: series, asOfDate: params.asOfDate, allowance, paidUsageEnabled });
    forecasts.push({ scope: 'cost_center', entityId: cc.id, computedAt, result, mape });
  }

  // User scope: every licensed seat. Allowance is the user's effective ULB
  // (most-specific wins, resolveEffectiveUlb); paidUsageEnabled is ALWAYS
  // false (USER_ULB_NEVER_METERS) since a ULB hard-stops in BOTH phases
  // (CLAUDE.md §5) -- exhaustionDate here is really a BLOCK date, not a
  // metered-spend trigger. A user with no ULB at any scope (null
  // effectiveUlb -- not reachable in the DEWR fixture world, which always has
  // a universal ULB as the floor, but handled generically) gets the same
  // permanently-zero allowance line as a cap-off cost center: no exhaustion
  // to report.
  const ulbCandidates = buildUlbCandidates(params.budgetsRaw);
  for (const seat of params.seats) {
    const userId = String(seat.assignee.id);
    const login = seat.assignee.login;
    const costCenterName = params.loginToCostCenterName.get(login) ?? null;
    const effectiveUlb = resolveEffectiveUlb(login, costCenterName, ulbCandidates);
    const allowance = effectiveUlb ? fixedAllowanceLine(effectiveUlb.amountCredits) : fixedAllowanceLine(0);
    const series = assembleUserSeries(creditRows, userId, params.asOfDate);
    const { result, mape } = computeScopeForecast({
      history: series,
      asOfDate: params.asOfDate,
      allowance,
      paidUsageEnabled: USER_ULB_NEVER_METERS,
    });
    forecasts.push({ scope: 'user', entityId: userId, computedAt, result, mape });
  }

  return forecasts;
}

export function createGitHubApiClient(config: GitHubApiClientConfig): ApiClient {
  const octokit = new Octokit({ auth: config.auth, baseUrl: config.baseUrl });
  const enterprise = config.enterprise;

  // CLAUDE.md §2's API-version pin (`X-GitHub-Api-Version: 2026-03-10`), set
  // ONCE at client construction so every request -- reads (already shipped)
  // and the Task 4.8 write engine's mutations alike -- carries it, with no
  // per-call site required to remember. `options.headers` is NOT read by
  // @octokit/core's constructor (confirmed by reading node_modules/@octokit/
  // core's source: it only lifts `userAgent`/`timeZone` into request
  // defaults), so a `new Octokit({ headers: {...} })` constructor option is
  // silently ignored -- this `hook.before('request', ...)` is the actual,
  // officially-supported mechanism (@octokit/request's with-defaults.js calls
  // `endpointOptions.request.hook(request, endpointOptions)`, i.e. every
  // request flows through the 'request' hook chain before being sent). This
  // is an Octokit-native API, not a hand-wrapped call, so CLAUDE.md §6.9's
  // API-surface validation gate doesn't apply here.
  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = API_VERSION;
  });

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

  // Task 5.4: `year` (real GitHub's documented enhanced-billing usage-report
  // query parameter -- docs/api-surface-validation.md's R5 row + its Task 5.1
  // note) fetches the WHOLE current year, which the MSW handler resolves as
  // USAGE_ITEMS (the open cycle) UNIONED with HISTORICAL_USAGE_ITEMS (the 3
  // prior closed cycles) -- i.e. this ALREADY IS the current-cycle + history
  // superset (github-impl's plain fetchUsageItems() above must NOT also be
  // concatenated with this -- it would double-count the current cycle's
  // rows). Derives the year from SIM_CURRENT_DATE rather than hardcoding
  // '2026' so this keeps working if the fixture's as-of date ever moves to a
  // different year.
  async function fetchHistoricalUsageItems(): Promise<UsageItem[]> {
    return paginateAll<UsageItem>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/usage',
      { enterprise, year: SIM_CURRENT_DATE.slice(0, 4) },
      (data) => (data as { usageItems: UsageItem[] }).usageItems,
    );
  }

  // Task 5.4: `since` (real GitHub's documented metrics-report query
  // parameter -- R6's Task 5.1 note) fetches from 3 calendar months before
  // the current cycle's start, which the MSW handler resolves as the SAME
  // current-cycle + history superset fetchHistoricalUsageItems() gets above
  // (CREDITS_USED_ITEMS unioned with HISTORICAL_CREDITS_USED_ITEMS) -- do not
  // additionally concatenate the plain fetchCreditsUsedItems() call for the
  // same reason. Computed from cycleBounds (not hardcoded to the fixture's
  // exact March date) so this keeps working if the fixture's as-of date ever
  // moves.
  async function fetchHistoricalCreditsUsedItems(): Promise<CreditsUsedItem[]> {
    const { cycleStart } = cycleBounds(new Date(`${SIM_CURRENT_DATE}T00:00:00.000Z`));
    const since = new Date(Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth() - 3, 1))
      .toISOString()
      .slice(0, 10);
    return paginateAll<CreditsUsedItem>(
      octokit,
      '/enterprises/{enterprise}/copilot/metrics/reports/users-28-day',
      { enterprise, since },
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

  // Hand-wrapped (not in Octokit's typed catalog -- same CLAUDE.md §6.9 note as
  // fetchCostCentersRaw/fetchCreditsUsedItems above): the enterprise budgets
  // endpoint is a 2026-dated route from the PRD's own API-inventory research
  // (§2.3, §4.2), not yet a real, published GitHub route to validate against.
  async function fetchBudgetsRaw(): Promise<BudgetItem[]> {
    return paginateAll<BudgetItem>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/budgets',
      { enterprise },
      (data) => (data as { budgets: BudgetItem[] }).budgets,
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
    const [creditsUsedItems, seats, costCentersRaw, budgetsRaw] = await Promise.all([
      fetchCreditsUsedItems(),
      fetchSeats(),
      fetchCostCentersRaw(),
      fetchBudgetsRaw(),
    ]);

    const resourcesByCostCenter = await Promise.all(
      costCentersRaw.map(async (cc) => ({ cc, resources: await fetchCostCenterResources(cc.id) })),
    );
    const costCenterNameByLogin = new Map<string, string>();
    for (const { cc, resources } of resourcesByCostCenter) {
      for (const r of resources) {
        if (r.type === 'User') costCenterNameByLogin.set(r.name, cc.name);
      }
    }

    const ulbCandidates = buildUlbCandidates(budgetsRaw);

    interface Accumulator {
      userId: string;
      userLogin: string;
      creditsUsed: number;
      dailyCredits: Map<string, number>;
      modelUsage: ModelUsageRow[];
    }

    // Seeded from the full licensed roster (not just users with a usage row) --
    // the Users screen's "No usage" status filter and its full-roster
    // pagination (Task 2.4) depend on every seat appearing, even at 0 credits.
    const accByLogin = new Map<string, Accumulator>();
    for (const seat of seats) {
      accByLogin.set(seat.assignee.login, {
        userId: String(seat.assignee.id),
        userLogin: seat.assignee.login,
        creditsUsed: 0,
        dailyCredits: new Map(),
        modelUsage: [],
      });
    }

    // Same cycle window as listCostCenters' member burn, above (cycleBounds
    // anchored to the deterministic fixture date, never wall-clock) -- a user
    // whose only credits rows fall outside the current cycle (e.g. user-05's
    // Aug/Sep cliff-edge rows) legitimately shows 0 MTD this cycle, not a
    // lifetime total.
    const bounds = cycleBounds(new Date(`${SIM_CURRENT_DATE}T00:00:00.000Z`));
    for (const item of creditsUsedItems) {
      const dayIndex = Math.floor((Date.parse(`${item.date}T00:00:00.000Z`) - bounds.cycleStart.getTime()) / DAY_MS);
      if (dayIndex < 0 || dayIndex > bounds.daysElapsed) continue;

      const acc = accByLogin.get(item.user_login);
      if (!acc) continue; // a credits row with no matching seat/license -- not expected in valid fixture data

      acc.creditsUsed += item.ai_credits_used;
      acc.dailyCredits.set(item.date, (acc.dailyCredits.get(item.date) ?? 0) + item.ai_credits_used);
      acc.modelUsage.push({ model: item.model ?? null, creditsUsed: item.ai_credits_used });
    }

    const users: HeavyUser[] = [...accByLogin.values()].map((acc) => {
      const costCenterName = costCenterNameByLogin.get(acc.userLogin) ?? null;

      // Empty (not zero-filled) when there's no cycle usage at all -- the Users
      // screen renders a "no usage yet this cycle" placeholder instead of a
      // flat-line chart for these (design/README.md's Users screen sublabel).
      const dailySeries: HeavyUserDailyPoint[] =
        acc.creditsUsed === 0
          ? []
          : Array.from({ length: bounds.daysElapsed + 1 }, (_, i) => {
              const date = new Date(bounds.cycleStart.getTime() + i * DAY_MS).toISOString().slice(0, 10);
              return { date, creditsUsed: acc.dailyCredits.get(date) ?? 0 };
            });

      return {
        userId: acc.userId,
        userLogin: acc.userLogin,
        creditsUsed: acc.creditsUsed,
        costCenterName,
        dailySeries,
        modelMix: computeModelMix(acc.modelUsage),
        effectiveUlb: resolveEffectiveUlb(acc.userLogin, costCenterName, ulbCandidates),
      };
    });

    return rankHeavyUsers(users);
  }

  async function listAlerts(): Promise<Alert[]> {
    return ALERTS;
  }

  async function getSyncStatus(): Promise<SyncStatus> {
    return readSyncStatus(config.db);
  }

  async function syncNow(): Promise<SyncStatus> {
    // Task 4.15: the controls phase reuses fetchLiveControls verbatim -- the
    // SAME live-control read getControls()/the write engine's re-read call --
    // rather than re-deriving BudgetControl/IncludedCapControl/
    // CostCenterControl by hand from costCentersRaw/resourcesByCostCenter
    // below (a second, independently-written projection of the same wire data
    // could drift from the first). This does re-fetch cost centers + their
    // resource rosters a second time (fetchLiveControls does its own
    // paginated reads); acceptable against MSW/a handful of live cost
    // centers, and keeps the controls-ingestion path structurally identical
    // to every other getControls() caller.
    // Task 5.4: the two historical fetches (year/since-parameterised) run
    // alongside the existing current-cycle-only reads -- see
    // fetchHistoricalUsageItems/fetchHistoricalCreditsUsedItems's doc
    // comments for why these are NOT concatenated with usageItems/
    // creditsUsedItems below (they're already supersets of them).
    const [usageItems, creditsUsedItems, costCentersRaw, seats, live, historicalUsageItems, historicalCreditsUsedItems, budgetsRaw] =
      await Promise.all([
        fetchUsageItems(),
        fetchCreditsUsedItems(),
        fetchCostCentersRaw(),
        fetchSeats(),
        fetchLiveControls(octokit, enterprise),
        fetchHistoricalUsageItems(),
        fetchHistoricalCreditsUsedItems(),
        fetchBudgetsRaw(),
      ]);

    const resourcesByCostCenter = await Promise.all(
      costCentersRaw.map(async (cc) => ({ costCenterId: cc.id, resources: await fetchCostCenterResources(cc.id) })),
    );

    const costCenterMembers: IngestCostCenterMember[] = resourcesByCostCenter.flatMap(({ costCenterId, resources }) =>
      resources.map((r) => ({ costCenterId, resourceType: RESOURCE_TYPE_MAP[r.type], resourceId: r.name })),
    );

    const loginToCostCenter = new Map<string, string>();
    const costCenterNameById = new Map(costCentersRaw.map((cc) => [cc.id, cc.name] as const));
    const loginToCostCenterName = new Map<string, string>();
    for (const { costCenterId, resources } of resourcesByCostCenter) {
      for (const r of resources) {
        if (r.type === 'User') {
          loginToCostCenter.set(r.name, costCenterId);
          const ccName = costCenterNameById.get(costCenterId);
          if (ccName) loginToCostCenterName.set(r.name, ccName);
        }
      }
    }

    const forecasts = computeSyncForecasts({
      asOfDate: new Date(`${SIM_CURRENT_DATE}T00:00:00.000Z`),
      historicalUsageItems,
      historicalCreditsUsedItems,
      costCentersRaw,
      resourcesByCostCenter,
      seats,
      budgetsRaw,
      loginToCostCenterName,
    });

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
      controls: live.controls,
      forecasts,
    };

    ingestSnapshot(config.db, config.source, data);
    return readSyncStatus(config.db);
  }

  // Task 4.15: the Controls screen's "last synced" baseline for browse-time
  // drift detection (core's driftedControlIds, fed (getLastSyncedControls(),
  // getControls())). A thin read-through to the sync package -- capturedAt is
  // surfaced as an ISO string (matching SyncStatus.lastSyncedAt's convention)
  // rather than the internal Date, since a preload/IPC/renderer caller has no
  // use for a raw Date across that boundary.
  async function getLastSyncedControls(): Promise<LastSyncedControls | null> {
    const result = readLastSyncedControls(config.db);
    return result ? { capturedAt: result.capturedAt.toISOString(), controls: result.controls } : null;
  }

  // Task 5.4: a thin read-through to the sync package's latest-forecast
  // lookup (packages/data/src/sync/sync-now.ts's getLatestForecast) -- the
  // Forecast screen's (and Overview/Users' forecast overlays') read surface.
  async function getForecast(scope: ForecastScope, entityId?: string): Promise<StoredForecast | null> {
    return readLatestForecast(config.db, scope, entityId);
  }

  // Task 4.8's write engine. getControls IS the write engine's own re-read
  // (write/live-state.ts's fetchLiveControls) -- not a second, independently
  // written projection -- so "did live move since the plan was staged"
  // (dryRunPlan/applyPlan's drift check) compares like with like.
  async function getControls(): Promise<ControlState[]> {
    const live = await fetchLiveControls(octokit, enterprise);
    return live.controls;
  }

  async function dryRunPlan(desiredControls: readonly ControlState[], justification?: string | null): Promise<DryRunResult> {
    return dryRunPlanEngine(desiredControls, {
      enterprise,
      octokit,
      asOfDate: new Date(`${SIM_CURRENT_DATE}T00:00:00.000Z`),
      justification,
    });
  }

  async function applyPlan(
    stagedPlan: Plan,
    desiredControls: readonly ControlState[],
    input: ApplyPlanInput,
  ): Promise<ApplyPlanResult> {
    return applyPlanEngine(stagedPlan, {
      enterprise,
      octokit,
      db: config.db,
      actor: input.actor,
      desiredControls,
      justification: input.justification,
      trigger: 'manual',
    });
  }

  return {
    getUsageSummary,
    listCostCenters,
    listHeavyUsers,
    listAlerts,
    getSyncStatus,
    syncNow,
    getControls,
    getLastSyncedControls,
    getForecast,
    dryRunPlan,
    applyPlan,
  };
}
