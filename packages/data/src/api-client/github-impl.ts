import { Octokit } from 'octokit';
import { eq } from 'drizzle-orm';
import {
  computeModelMix,
  cycleBounds,
  fixedAllowanceLine,
  poolAllowanceLine,
  rankHeavyUsers,
  resolveEffectiveUlb,
  type AllowanceBasis,
  type ControlState,
  type EntityRef,
  type ModelUsageRow,
  type Plan,
  type UlbCandidate,
} from '@copilot-budget/core';
import {
  assembleCostCenterSeries,
  assembleEnterpriseSeries,
  assembleUserSeries,
  computeScopeForecast,
  expandMonthlyAggregates,
  type AssembleCreditsUsedRow,
  type AssembleUsageRow,
} from '../forecast/compute.js';
import { readScopedAuditChain, verifyStoredChain } from '../audit/writer.js';
import { ALERTS } from '../msw/fixtures/alerts.js';
import { API_VERSION } from '../msw/fixtures/constants.js';
import {
  getLastSyncedControls as readLastSyncedControls,
  getLatestForecast as readLatestForecast,
  getSyncStatus as readSyncStatus,
  syncNow as ingestSnapshot,
  type IngestCostCenterMember,
  type IngestData,
  type IngestForecastItem,
  type IngestMonthlyCreditsRow,
  type IngestResourceType,
} from '../sync/sync-now.js';
import { applyPlan as applyPlanEngine, dryRunPlan as dryRunPlanEngine } from '../write/engine.js';
import { getAppModeSetting as readAppModeSetting, setAppModeSetting as writeAppModeSetting } from '../settings/app-settings.js';
import { isWriteArmed, setWriteArmed } from '../write/arming.js';
import { assembleUsageState, fetchLiveControls } from '../write/live-state.js';
import { METERED_SCENARIO_INPUTS, POOL_SCENARIO_INPUTS } from '../msw/fixtures/scenarios.js';
import { runReadSmoke, runR7 } from '../smoke/read-smoke.js';
import {
  formatLocalCreditsCoverage,
  formatWireR6Historical,
  summarizeWireR6Historical,
  WIRE_R6_SIM_SKIP_NOTE,
  type LocalCreditsCoverage,
  type MonthCoverage,
  type SnapshotCoverage,
} from '../smoke/diagnostics.js';
import { validateTenantConfig, type TenantConfig } from '../tenant/types.js';
import type { TenantConfigStore } from '../tenant/store.js';
import { paginateAll } from './paginate.js';
import {
  isAiCreditBudget,
  warnExcludedProductBudgets,
  warnSkippedBudgetScopes,
  wireBudgetToInternal,
  type InternalBudgetScope,
} from './budget-scope.js';
import { normalizeIncludedUsageCap } from './cost-center-cap.js';
import {
  aiCreditItems,
  fetchUsageFanout,
  fetchUsageForCostCenter,
  isMonthlyAggregateGrain,
  type AttributedUsageItem,
} from './usage-fetch.js';
import { fetchCycleUserCredits, fetchUserCreditsForDays, type CycleUserCreditsResult } from './users-report.js';
import { fetchAiCreditUsage, sumNetQuantity } from './ai-credit-usage.js';
import { resolveClockDate } from './clock.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import type {
  Alert,
  ApiClient,
  ApplyPlanInput,
  ApplyPlanResult,
  AuditChainEvent,
  AuditChainVerification,
  CostCenterMemberSummary,
  CostCenterMappingInput,
  CostCenterSummary,
  DailyBurnPoint,
  DryRunResult,
  ForecastScope,
  HeavyUser,
  HeavyUserDailyPoint,
  LastSyncedControls,
  ActiveScenarioResult,
  ListScenariosResult,
  PatValidation,
  ReadSmokeResult,
  RebalanceContextResult,
  SetScenarioResult,
  StoredForecast,
  SyncStatus,
  UsageDistributionUser,
  UsageDistributionWindow,
  UsageDistributionWindowInput,
  UserMonthObservation,
  UserMonthObservationsResult,
  UsageSummary,
  UsageSummaryParams,
  WriteArmingRequest,
  WriteArmingState,
} from './types.js';
import {
  getActiveScenarioSummary,
  isScenarioId,
  listScenarioSummaries,
  setActiveScenarioId,
  type ScenarioId,
} from '../msw/scenario-state.js';

export interface GitHubApiClientConfig {
  enterprise: string;
  db: Db;
  source: 'msw' | 'github';
  auth?: string;
  baseUrl?: string;
  /**
   * Task 9.1: the persisted tenant pointer store (getTenantConfig/
   * setTenantConfig read/write through it). Optional so existing test call
   * sites that don't exercise tenant config need no change; a null-store
   * client reports no tenant config and refuses to persist one.
   */
  tenantConfig?: TenantConfigStore;
  /**
   * Task 9.1: reads the CURRENT stored PAT for validatePat's probe. Injected
   * (not the construction-time `auth`) because the admin can enter/clear the
   * PAT after the client is built -- the closure lets validatePat classify the
   * live token, while the plaintext never crosses into the renderer (§6.6:
   * only the classification result does).
   */
  getPat?: () => Promise<string | null>;
  /**
   * Test-only override for the clock seam's as-of date (YYYY-MM-DD). Production
   * derives it from `source` via resolveClockDate; a test can pin the live
   * (wall-clock) branch deterministically without mocking Date.
   */
  nowDate?: string;
}

// R5: the usage item is now the camelCase wire shape (usage-fetch.ts's
// WireUsageItem), tagged with the cost center it was attributed to by the
// fan-out query (never a wire field). No `user_login` -- per-user attribution
// moved to R6's users reports (see fetchCycleCredits below).
type UsageItem = AttributedUsageItem;

// The NORMALIZED cost-center shape github-impl works with. The wire delivers
// two cap dialects -- the internal `included_usage_cap` (MSW/sim) vs real
// GHEC's flat `ai_credit_pool_enabled` + `ai_credit_pool_state` (the live
// TypeError of 2026-07-08) -- so fetchCostCentersRaw normalizes every row
// through the ONE shared mapper (cost-center-cap.ts) before anything else
// reads it; downstream code only ever sees `included_usage_cap`.
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
  // R3: cost-center members are EMBEDDED on the cost-center objects the list /
  // get-one endpoints return -- there is no GET .../resource endpoint (that
  // path only accepts POST/DELETE mutations). Disproven live 2026-07-08 (404).
  resources: CostCenterResource[];
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

// Minimal INTERNAL-shaped projection of a budget: only the fields
// ULB-precedence resolution needs, with scope/entity ALREADY translated from
// the real wire enum (multi_user_customer / user + user field -- OpenAPI-
// pinned, wire-contract-writes.md §1) by the shared budget-scope mapper at the
// fetchBudgetsRaw boundary. `budget_amount` is USD (machine-verified "in whole
// dollars") -- converted to credits the same way poolCreditsForItem converts
// discountAmount, below.
interface BudgetItem {
  budget_scope: InternalBudgetScope;
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

// discountAmount is the $ portion of a usage row covered by the shared pool
// (vs. netAmount, the metered portion) -- dividing by $0.01/credit converts
// it back to the pool-phase credit count the Overview burn-down needs, so a
// cost center that's tipped into metered (discount 0) doesn't inflate the
// enterprise-wide pool-consumed figure it never actually drew from. (R5:
// camelCase `discountAmount`, not the old snake_case that read as undefined.)
function poolCreditsForItem(item: Pick<UsageItem, 'discountAmount'>): number {
  return Math.round(item.discountAmount * 100);
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
//
// Grain-adaptive (item 23, live-pinned): `items` are the CYCLE-MONTH,
// AI-credit rows.
//   - PER-DAY grain (the fixture world; any per-day tenant --
//     `r6DailyTotals === null`): the original per-day fold, byte-identical.
//     R5's own daily rows are the best source here: they carry the true
//     pool-only (discountAmount) split per day.
//   - MONTHLY-AGGREGATE grain (the live tenant; `r6DailyTotals` supplied):
//     the aggregate rows give the LEVEL only (MTD pool total); the daily
//     SHAPE comes from R6's users-1-day per-user sums -- TOTAL credits,
//     pool+metered undifferentiated, acceptable for shape (documented design
//     choice) -- scaled so the cumulative line ends at exactly the R5 MTD
//     pool total (the money truth). If R6 carried no data for the cycle, the
//     fallback is a flat MTD/elapsed linear ramp.
function buildDailyBurn(
  items: UsageItem[],
  cycleStart: Date,
  daysElapsed: number,
  r6DailyTotals: ReadonlyMap<string, number> | null,
): DailyBurnPoint[] {
  const dayDate = (i: number): string => new Date(cycleStart.getTime() + i * DAY_MS).toISOString().slice(0, 10);

  if (r6DailyTotals !== null) {
    const mtdPoolCredits = items.reduce((sum, item) => sum + poolCreditsForItem(item), 0);

    // R6 cumulative shape over the elapsed cycle days.
    const cumulativeR6: number[] = [];
    let running = 0;
    for (let i = 0; i <= daysElapsed; i++) {
      running += r6DailyTotals.get(dayDate(i)) ?? 0;
      cumulativeR6.push(running);
    }
    const totalR6 = running;

    return Array.from({ length: daysElapsed + 1 }, (_, i) => ({
      date: dayDate(i),
      cumulativePoolCredits:
        totalR6 > 0
          ? Math.round((mtdPoolCredits * cumulativeR6[i]!) / totalR6)
          : daysElapsed === 0
            ? mtdPoolCredits
            : Math.round((mtdPoolCredits * i) / daysElapsed),
    }));
  }

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
    const date = dayDate(i);
    cumulative += creditsByDate.get(date) ?? 0;
    points.push({ date, cumulativePoolCredits: cumulative });
  }
  return points;
}

interface ComputeSyncForecastsParams {
  asOfDate: Date;
  /** The clock-seam "now" (api-client/clock.ts) recorded as each forecast's computedAt -- the fixture date in sim, wall clock in live. */
  computedAt: string;
  historicalUsageItems: UsageItem[];
  // R6 + maintainer decision (2026-07-08): the user-scope forecast's training
  // window is the 3 prior closed cycles + the current cycle -- the SAME window
  // the old `since`-based fetch targeted -- now assembled as
  // fetchHistoricalCreditsUsedItems (users-1-day daily backfill) concatenated
  // with the current-cycle fan-out. Run-rate + backtest MAPE genuinely consume
  // prior-cycle per-user history (the committed forecast e2e pins prove it).
  userCreditItems: CreditsUsedItem[];
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
  const computedAt = params.computedAt;
  // AI-credit sku filter (usage-fetch.ts's live pin): forecast training
  // series derive from "Copilot AI Credits" rows only -- a Copilot
  // Business/Premium Request row in the history would inflate every
  // enterprise/cost-center burn projection.
  // Monthly-aggregate expansion (item 23): live months arrive as one
  // aggregate row -- expandMonthlyAggregates spreads them into a flat daily
  // series (closed month: total/daysInMonth; current month: MTD/elapsed) so
  // core's trailing-7 run-rate never mistakes a month total for a daily rate
  // (the live P50 ~= total x 31 blow-up). Per-day fixture rows pass through
  // untouched -- simulation stays byte-identical.
  const usageRows: AssembleUsageRow[] = expandMonthlyAggregates(
    aiCreditItems(params.historicalUsageItems).map((i) => ({
      date: i.date,
      costCenterId: i.costCenterId,
      quantity: i.quantity,
    })),
    params.asOfDate,
  );
  const creditRows: AssembleCreditsUsedRow[] = params.userCreditItems.map((i) => ({
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

// Distribution: the SHARED base both distribution reads (getUsageDistribution
// and getUserMonthObservations) start from -- the source-scoped per-user fact
// rows plus the union/latest-wins winning-generation map and the covered date
// bounds. Defined in exactly one place so the coverage semantics never drift.
// Returns null for the SENTINEL case (no per-user history for this source at
// all -- fresh DB / never synced in this mode); every caller maps null to its
// own sentinel shape.
export interface DistributionFactBase {
  factRows: Array<{ date: string; userId: string; userLogin: string | null; creditsUsed: number; snapshotId: number }>;
  /**
   * Per date, that day's winning generation: the LATEST snapshot with >=1
   * NONZERO (creditsUsed > 0) row on that date; if no snapshot has a nonzero
   * row for the date, the latest snapshot with any row (zero-erosion fix, see
   * readDistributionFactBaseFor). Rows for a date come only from this snapshot.
   */
  winnerSnapshotByDate: Map<string, number>;
  /**
   * Min/max NONZERO winning date (YYYY-MM-DD) -- the coverage bounds derive
   * from winning rows with creditsUsed > 0 only (zero-filled-history fix, see
   * readDistributionFactBaseFor). BOTH are '' when the source has rows but the
   * whole covered timeline is zero-fill (no nonzero coverage to anchor); each
   * distribution reader treats that as its sentinel.
   */
  earliestDate: string;
  toDate: string;
}

// Module-scope (extracted from the client closure, 2026-07-10) so the live-read
// smoke's DB-coverage diagnostic can REUSE the exact union/latest-wins base the
// distribution reads consume -- rather than reimplement it. The closure method
// readDistributionFactBase() is a thin (config.db, config.source) shim over this.
export function readDistributionFactBaseFor(db: Db, source: string): DistributionFactBase | null {
  const sourceRows = db
    .select({
      date: schema.creditsUsedFact.date,
      userId: schema.creditsUsedFact.userId,
      userLogin: schema.creditsUsedFact.userLogin,
      creditsUsed: schema.creditsUsedFact.creditsUsed,
      snapshotId: schema.creditsUsedFact.snapshotId,
    })
    .from(schema.creditsUsedFact)
    .innerJoin(schema.snapshot, eq(schema.snapshot.id, schema.creditsUsedFact.snapshotId))
    .where(eq(schema.snapshot.source, source))
    .all();

  if (sourceRows.length === 0) return null;

  // SOURCE-SCOPED WINDOW SEMANTICS (scenario-contamination fix, 2026-07-10 --
  // maintainer-reported, screenshot-confirmed). The two client sources model
  // fundamentally different worlds, so their coverage bases diverge HERE:
  //
  //  - 'github' (LIVE): ONE real enterprise accumulating history across many
  //    real syncs. Union across ALL snapshots, latest-wins per date, is the
  //    correct, maintainer-approved accumulation (types.ts' UsageDistribution
  //    doc) -- a later sync legitimately extends/corrects the same timeline.
  //
  //  - 'msw' (SIMULATION): each scenario sync writes a snapshot from a
  //    DIFFERENT synthetic world with its OWN date range. Unioning across
  //    snapshots let a later-dated scenario (e.g. Metered, whose facts run
  //    past the 1 Sep 2026 cliff) permanently hijack toDate -- so after
  //    syncing Metered then switching to a June scenario, the "1 month"
  //    window still read "2 Aug - 1 Sep 2026" (the metered world's dates),
  //    the reported bug. Each sim sync persists the active scenario's FULL
  //    ~4-cycle world in a single snapshot, so scoping to the LATEST msw
  //    snapshot alone (same latest-snapshot pattern getLastSyncedControls /
  //    write/engine.ts use) makes every scenario self-contained and
  //    switch-safe. Union/latest-wins below is then a no-op (one snapshot).
  //
  // Both getUsageDistribution and getUserMonthObservations inherit this via
  // the shared helper -- there is no other copy of the union logic.
  const factRows =
    source === 'msw'
      ? (() => {
          const latestSnapshotId = sourceRows.reduce((max, r) => (r.snapshotId > max ? r.snapshotId : max), 0);
          return sourceRows.filter((r) => r.snapshotId === latestSnapshotId);
        })()
      : sourceRows;

  // Union/latest-wins with a ZERO-FILL-RESISTANT winner rule (zero-erosion
  // fix, 2026-07-11). Per date, the winning generation is the LATEST snapshot
  // that has >=1 row with creditsUsed > 0 on that date; if NO snapshot has a
  // nonzero row for that date, fall back to the latest snapshot with any row
  // (preserves genuinely-idle days + old all-zero persistence). Its rows are
  // that day's truth -- rows for a date still come only from the winning
  // snapshot (unchanged principle).
  //
  // WHY (live-observed, maintainer 2026-07-11): GitHub's users-1-day report
  // returns REAL per-user values only within a trailing wire-retention window
  // and ZERO-FILLS older dates. A naive "latest snapshot wins" let each daily
  // sync's zero-filled older rows SUPERSEDE the real values an earlier snapshot
  // had recorded for the same date -- eroding one day of real history per sync,
  // so the app could never accumulate history past the wire's retention. Keying
  // the winner off the latest NONZERO snapshot makes zero-fill never overwrite
  // real data: the older real snapshot keeps winning that date. Self-healing --
  // already-eroded dates reappear with NO data migration (the real rows still
  // live in the older, append-only snapshots). Half 2 (sync-now.ts) stops
  // persisting new zero rows at all; this read-time rule additionally repairs
  // the zeros pre-fix DBs already hold.
  //
  // Semantics this yields:
  //   - Whole-date zero-fill (retention aging) is IGNORED in favor of the older
  //     real snapshot for that date.
  //   - A genuine settling correction that zeroes ONE user while OTHERS stay
  //     nonzero on that date still wins (its snapshot HAS nonzero rows -> it is
  //     eligible), so that user's real zero is honored -- within the wire's
  //     real-data window the newest report is the truth, including a genuine 0.
  //   - A date all-zero in EVERY snapshot falls back to the latest snapshot (no
  //     real data anywhere to prefer); it adds nothing to any sum and is
  //     excluded from the coverage bounds below.
  // Correct under EVERY retention-window hypothesis (the "~8-day window" is
  // itself unverified) and also robust to a transient wire zero-fill glitch --
  // the rule depends only on "nonzero beats zero for the same date", not on any
  // particular window size. Built over ALL rows so the winning-row SUMS the
  // readers compute AND the raw truth computeLocalCreditsCoverage shows are
  // untouched -- only which generation wins a zero-eroded date changes.
  const latestNonzeroByDate = new Map<string, number>();
  const latestAnyByDate = new Map<string, number>();
  for (const row of factRows) {
    const anyWinner = latestAnyByDate.get(row.date);
    if (anyWinner === undefined || row.snapshotId > anyWinner) latestAnyByDate.set(row.date, row.snapshotId);
    if (row.creditsUsed > 0) {
      const nonzeroWinner = latestNonzeroByDate.get(row.date);
      if (nonzeroWinner === undefined || row.snapshotId > nonzeroWinner) latestNonzeroByDate.set(row.date, row.snapshotId);
    }
  }
  const winnerSnapshotByDate = new Map<string, number>();
  for (const [date, anyWinner] of latestAnyByDate) {
    winnerSnapshotByDate.set(date, latestNonzeroByDate.get(date) ?? anyWinner);
  }

  // COVERAGE BOUNDS FROM NONZERO WINNING ROWS ONLY (zero-filled-history fix,
  // 2026-07-10; live-verified in the maintainer's tenant). GitHub's users-1-day
  // per-user metrics report ZERO-FILLS history beyond its retention (~the
  // current cycle): earlier months (e.g. Apr/May/Jun) come back as a full
  // roster with real logins but every ai_credits_used = 0 -- even though R5
  // SKU-level billing shows those months DID consume AI credits. Those persisted
  // zero rows are real DB rows, so deriving earliest/toDate from ALL winning
  // dates made a zero-filled month count as "covered" and anchored the window /
  // completeness to truthful-but-useless zeros (the reported "100 zero
  // observations for a complete June" symptom). The bounds therefore key off
  // winning rows with creditsUsed > 0 only:
  //   earliest = min date over nonzero winning rows
  //   toDate   = max date over nonzero winning rows
  // Winning-row SELECTION and the SUMS the readers fold are DELIBERATELY
  // untouched -- zero rows still flow into factRows / winnerSnapshotByDate (they
  // add nothing to any sum), so computeLocalCreditsCoverage keeps surfacing the
  // raw persisted truth for its diagnostics. Only the edge bounds move.
  //   - Trailing zero-fill (real months then a zero-filled newest month, which
  //     can occur transiently mid-cycle): toDate anchors at the last NONZERO
  //     date, not the zero-filled newest one.
  //   - A genuinely-zero INTERIOR month (nonzero months on both sides): it still
  //     sits inside [earliest, toDate] and counts as complete, yielding all-zero
  //     observations -- accepted and documented; the bounds are edge-based, not
  //     a per-month filter.
  //   - No nonzero winning row AT ALL: both bounds stay '' (the source has rows
  //     but its whole timeline is zero-fill). The per-user history still exists,
  //     so computeLocalCreditsCoverage reports hasData/raw rows; but there is no
  //     useful window to anchor, so both distribution readers return their
  //     existing sentinel (guarding on the empty toDate).
  let toDate = '';
  let earliestDate = '';
  for (const row of factRows) {
    if (row.creditsUsed <= 0) continue;
    if (row.snapshotId !== winnerSnapshotByDate.get(row.date)) continue; // superseded generation for this date
    if (toDate === '' || row.date > toDate) toDate = row.date;
    if (earliestDate === '' || row.date < earliestDate) earliestDate = row.date;
  }

  return { factRows, winnerSnapshotByDate, earliestDate, toDate };
}

// ===========================================================================
// Monthly per-user AI-credit backfill (billing ai_credit/usage report; migration
// 0007 credits_used_monthly_fact). github-source only -- MSW has no
// ai_credit/usage handler, so the sim path never fans out and this table stays
// empty (simulation behavior + pins byte-identical).
// ===========================================================================

// 'YYYY-MM' one calendar month earlier (Date.UTC normalizes the January wrap).
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1)); // m-2: m is 1-based, and we want the prior month's 0-based index
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The unattributed-remainder epsilon (brief-pinned): a remainder is persisted
// only when it exceeds this many credits. Guards against float noise in
// monthAggregate − Σ attributed reading as a spurious departed-user remainder.
const REMAINDER_EPSILON = 0.005;

// Same bounded-concurrency ceiling as the per-day cycle fan-out
// (users-report.ts's USERS_REPORT_CONCURRENCY): 10 per-seat calls in flight per
// month, to stay under secondary rate limits on a wide roster.
const MONTHLY_BACKFILL_CONCURRENCY = 10;

// The accessibility window GitHub documents for the billing usage report ("only
// data from the past 24 months"): the backward candidate scan never looks
// further than this many months before the current month.
const MONTHLY_BACKFILL_MAX_SCAN = 24;

// Bounded-concurrency ordered map (mirrors fetchUserCreditsForDays' chunked
// waves): at most `limit` promises in flight; results follow input order.
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const settled = await Promise.all(chunk.map((item) => fn(item)));
    settled.forEach((r, j) => {
      results[i + j] = r;
    });
  }
  return results;
}

// The months already banked in credits_used_monthly_fact for this source (any
// snapshot -- append-once). The candidate scan skips these so a banked month is
// never refetched.
function readBankedMonthsFor(db: Db, source: string): Set<string> {
  const rows = db
    .select({ month: schema.creditsUsedMonthlyFact.month })
    .from(schema.creditsUsedMonthlyFact)
    .innerJoin(schema.snapshot, eq(schema.snapshot.id, schema.creditsUsedMonthlyFact.snapshotId))
    .where(eq(schema.snapshot.source, source))
    .all();
  return new Set(rows.map((r) => r.month));
}

// The monthly facts for a source, keyed by month: per-month attributed sums (by
// userId, with the row's login) + the unattributed remainder. Defensively takes
// the LATEST snapshot per month (append-once makes this a single snapshot in
// practice, but a month that was somehow rewritten across snapshots resolves to
// its newest generation). Excludes the remainder row from `attributed`.
export interface MonthlyCreditsFacts {
  attributed: Map<string, { login: string | null; credits: number }>;
  remainder: number;
}
export function readMonthlyCreditsFactsFor(db: Db, source: string): Map<string, MonthlyCreditsFacts> {
  const rows = db
    .select({
      month: schema.creditsUsedMonthlyFact.month,
      userId: schema.creditsUsedMonthlyFact.userId,
      userLogin: schema.creditsUsedMonthlyFact.userLogin,
      creditsUsed: schema.creditsUsedMonthlyFact.creditsUsed,
      snapshotId: schema.creditsUsedMonthlyFact.snapshotId,
    })
    .from(schema.creditsUsedMonthlyFact)
    .innerJoin(schema.snapshot, eq(schema.snapshot.id, schema.creditsUsedMonthlyFact.snapshotId))
    .where(eq(schema.snapshot.source, source))
    .all();

  const latestSnapByMonth = new Map<string, number>();
  for (const row of rows) {
    const cur = latestSnapByMonth.get(row.month);
    if (cur === undefined || row.snapshotId > cur) latestSnapByMonth.set(row.month, row.snapshotId);
  }

  const byMonth = new Map<string, MonthlyCreditsFacts>();
  for (const row of rows) {
    if (row.snapshotId !== latestSnapByMonth.get(row.month)) continue; // superseded generation
    let facts = byMonth.get(row.month);
    if (!facts) {
      facts = { attributed: new Map(), remainder: 0 };
      byMonth.set(row.month, facts);
    }
    if (row.userId === null) {
      facts.remainder += row.creditsUsed; // the NULL-user remainder row (append-once -> exactly one)
    } else {
      facts.attributed.set(row.userId, { login: row.userLogin, credits: row.creditsUsed });
    }
  }
  return byMonth;
}

export interface MonthlyBackfillSeat {
  id: string;
  login: string;
}

export interface MonthlyBackfillResult {
  rows: IngestMonthlyCreditsRow[];
  /** Months whose fan-out succeeded and produced >=1 persisted row (attributed and/or remainder). */
  monthsPersisted: string[];
  /** Months whose unfiltered aggregate returned items but Σ attributed left no positive remainder and no attributed rows (rare: all seats zero, aggregate ~0). */
  monthsEmptyAfterFanout: string[];
  /** The month whose unfiltered aggregate returned ZERO items -- the era floor that stopped the scan (null if the scan hit the 24-month cap or a bank/failure chain instead). */
  eraFloorMonth: string | null;
  /** Months skipped because already banked. */
  monthsSkippedBanked: string[];
  /** Months whose fan-out threw -- persisted nothing, retried next sync. */
  monthsFailed: string[];
  /** Months where Σ attributed EXCEEDED the aggregate (negative remainder) -- surfaced, but no remainder row persisted. */
  monthsNegativeRemainder: string[];
}

// The candidate fan-out. From (currentMonth − 1) backward, at most 24 months:
// skip banked months; for each candidate, one unfiltered aggregate call (empty
// items => era floor, stop the scan), then a bounded per-seat fan-out summing
// netQuantity (skip seats with sum <= 0, the same roster-zero rule the daily
// path applies at read time), then the remainder = aggregate − Σ attributed
// (persist a NULL-user row only when > epsilon). Each month is error-isolated:
// a throw aborts THAT month (no rows) and the scan proceeds to older months.
export async function backfillMonthlyCredits(
  octokit: Octokit,
  enterprise: string,
  opts: { currentMonth: string; seats: readonly MonthlyBackfillSeat[]; bankedMonths: ReadonlySet<string> },
): Promise<MonthlyBackfillResult> {
  const result: MonthlyBackfillResult = {
    rows: [],
    monthsPersisted: [],
    monthsEmptyAfterFanout: [],
    eraFloorMonth: null,
    monthsSkippedBanked: [],
    monthsFailed: [],
    monthsNegativeRemainder: [],
  };

  let month = previousMonth(opts.currentMonth);
  for (let scanned = 0; scanned < MONTHLY_BACKFILL_MAX_SCAN; scanned++, month = previousMonth(month)) {
    if (opts.bankedMonths.has(month)) {
      result.monthsSkippedBanked.push(month);
      continue;
    }
    const [year, mon] = month.split('-').map(Number) as [number, number];
    try {
      const aggregate = await fetchAiCreditUsage(octokit, enterprise, { year, month: mon });
      if (aggregate.usageItems.length === 0) {
        // Era floor: no usage in this month at all -> nothing older either.
        // No persistence (cheap 1-call retry next sync if history later appears).
        result.eraFloorMonth = month;
        break;
      }
      const monthAggregate = sumNetQuantity(aggregate);

      const perSeat = await mapWithConcurrency(opts.seats, MONTHLY_BACKFILL_CONCURRENCY, async (seat) => {
        const report = await fetchAiCreditUsage(octokit, enterprise, { year, month: mon, user: seat.login });
        return { userId: seat.id, login: seat.login, sum: sumNetQuantity(report) };
      });

      const monthRows: IngestMonthlyCreditsRow[] = [];
      let attributedTotal = 0;
      for (const s of perSeat) {
        if (s.sum <= 0) continue; // roster/idle zero -- reconstructed at read time from the license join
        attributedTotal += s.sum;
        monthRows.push({ month, userId: s.userId, userLogin: s.login, creditsUsed: s.sum });
      }

      const remainder = monthAggregate - attributedTotal;
      if (remainder > REMAINDER_EPSILON) {
        monthRows.push({ month, userId: null, userLogin: null, creditsUsed: remainder });
      } else if (remainder < -REMAINDER_EPSILON) {
        result.monthsNegativeRemainder.push(month); // surface, persist no remainder row
      }

      if (monthRows.length > 0) {
        result.rows.push(...monthRows);
        result.monthsPersisted.push(month);
      } else {
        result.monthsEmptyAfterFanout.push(month);
      }
    } catch {
      // Month-level error isolation: this month persists nothing; older months
      // proceed. §6.6: the error is NOT logged (it can embed a login/URL); the
      // month string alone is recorded for the summary.
      result.monthsFailed.push(month);
    }
  }
  return result;
}

// Live per-month all-zero diagnostic (2026-07-10): what got PERSISTED for a
// source. Per-snapshot raw stats (credits_used_fact row count, distinct user
// ids, date min..max, null user_login count) PLUS a per-month rollup over the
// SAME union/latest-wins winning rows getUserMonthObservations reads -- so the
// diagnostic shows exactly what that read sees. Source-scoped (§6.8). Pure
// local-SQLite read; no GitHub HTTP (§6.9-exempt by construction). See
// smoke/diagnostics.ts for the hypotheses this discriminates.
export function computeLocalCreditsCoverage(db: Db, source: string): LocalCreditsCoverage {
  const rows = db
    .select({
      snapshotId: schema.creditsUsedFact.snapshotId,
      capturedAt: schema.snapshot.capturedAt,
      date: schema.creditsUsedFact.date,
      userId: schema.creditsUsedFact.userId,
      userLogin: schema.creditsUsedFact.userLogin,
    })
    .from(schema.creditsUsedFact)
    .innerJoin(schema.snapshot, eq(schema.snapshot.id, schema.creditsUsedFact.snapshotId))
    .where(eq(schema.snapshot.source, source))
    .all();

  interface SnapAcc {
    capturedAt: Date;
    rowCount: number;
    userIds: Set<string>;
    minDate: string | null;
    maxDate: string | null;
    nullLoginCount: number;
  }
  const bySnap = new Map<number, SnapAcc>();
  for (const r of rows) {
    let acc = bySnap.get(r.snapshotId);
    if (!acc) {
      acc = { capturedAt: r.capturedAt, rowCount: 0, userIds: new Set(), minDate: null, maxDate: null, nullLoginCount: 0 };
      bySnap.set(r.snapshotId, acc);
    }
    acc.rowCount += 1;
    acc.userIds.add(r.userId);
    if (acc.minDate === null || r.date < acc.minDate) acc.minDate = r.date;
    if (acc.maxDate === null || r.date > acc.maxDate) acc.maxDate = r.date;
    if (r.userLogin === null) acc.nullLoginCount += 1;
  }
  const snapshots: SnapshotCoverage[] = [...bySnap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, a]) => ({
      snapshotId: id,
      capturedAt: a.capturedAt instanceof Date ? a.capturedAt.toISOString() : String(a.capturedAt),
      rowCount: a.rowCount,
      distinctUserIds: a.userIds.size,
      minDate: a.minDate,
      maxDate: a.maxDate,
      nullLoginCount: a.nullLoginCount,
    }));

  // Per-month rollup over the UNION view (winning rows only) -- reusing the
  // distribution's own base, never a second copy of the union logic.
  const base = readDistributionFactBaseFor(db, source);
  const months: MonthCoverage[] = [];
  if (base) {
    const byMonthUser = new Map<string, Map<string, number>>();
    const byMonthTotal = new Map<string, number>();
    for (const row of base.factRows) {
      if (row.snapshotId !== base.winnerSnapshotByDate.get(row.date)) continue; // superseded generation
      const month = row.date.slice(0, 7);
      byMonthTotal.set(month, (byMonthTotal.get(month) ?? 0) + row.creditsUsed);
      let um = byMonthUser.get(month);
      if (!um) {
        um = new Map();
        byMonthUser.set(month, um);
      }
      um.set(row.userId, (um.get(row.userId) ?? 0) + row.creditsUsed);
    }
    for (const month of [...byMonthUser.keys()].sort()) {
      const um = byMonthUser.get(month)!;
      const usersWithNonzero = [...um.values()].filter((v) => v > 0).length;
      months.push({ month, totalCredits: byMonthTotal.get(month) ?? 0, distinctUsers: um.size, usersWithNonzero });
    }
  }

  return { source, hasData: base !== null, snapshots, months };
}

export function createGitHubApiClient(config: GitHubApiClientConfig): ApiClient {
  const octokit = new Octokit({ auth: config.auth, baseUrl: config.baseUrl });
  const enterprise = config.enterprise;

  // Clock seam (api-client/clock.ts): the ONE place SIM_CURRENT_DATE vs the
  // real wall clock is chosen, keyed off the data source. Every cycle-relative
  // derivation below reads `currentDate()` instead of SIM_CURRENT_DATE
  // directly, so simulation stays byte-identical (source 'msw' -> the fixture
  // date) while live mode anchors to today. Computed per-call (not once at
  // construction) so a long-lived live client doesn't freeze "now" at boot.
  const currentDate = (): string => config.nowDate ?? resolveClockDate(config.source);
  const currentDateObj = (): Date => new Date(`${currentDate()}T00:00:00.000Z`);

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

  async function fetchCostCentersRaw(): Promise<CostCenter[]> {
    const response = await octokit.request('GET /enterprises/{enterprise}/settings/billing/cost-centers', {
      enterprise,
    });
    // R3: `resources` is embedded on each cost-center object; default it to []
    // defensively so a cost center with no members never yields undefined.
    // Cap normalization: the shared mapper (cost-center-cap.ts) folds BOTH cap
    // dialects -- internal `included_usage_cap` (MSW) and real GHEC's flat
    // `ai_credit_pool_*` fields -- into the internal shape here, at the fetch
    // boundary, so no downstream read can ever hit the live TypeError again.
    return (response.data as { costCenters: CostCenter[] }).costCenters.map((cc) => ({
      ...cc,
      resources: cc.resources ?? [],
      included_usage_cap: normalizeIncludedUsageCap(cc),
    }));
  }

  // R5: enterprise usage is a fan-out (default/unassociated + one call per
  // cost center -- usage-fetch.ts). A single `cost_center_id` filter is the
  // one-call path; the unfiltered read must enumerate cost centers first, since
  // the default call returns ONLY cost-center-unassociated usage.
  async function fetchUsageItems(params: UsageSummaryParams = {}): Promise<UsageItem[]> {
    if (params.costCenterId) {
      // The shared usage-fetch helper (not a local paginateAll) so the item-23
      // date normalization applies on this path too.
      return fetchUsageForCostCenter(octokit, enterprise, params.costCenterId);
    }
    const costCenters = await fetchCostCentersRaw();
    return fetchUsageFanout(octokit, enterprise, costCenters.map((cc) => cc.id));
  }

  // Task 5.4 / R5: `year` (real, documented enhanced-billing query param)
  // fetches the whole current year, which the MSW handler resolves as the open
  // cycle UNIONED with the 3 prior closed cycles -- the current-cycle + history
  // superset the enterprise/cost-center forecasts train on (do NOT additionally
  // concatenate the plain current-cycle fetch -- it would double-count). Now a
  // fan-out too (the default call still excludes cost-center usage), so it takes
  // the already-fetched cost-center ids to avoid re-listing them.
  //
  // Item 23 redundancy ruling (FLAGGED, kept deliberately): live, the
  // UNPARAMETERIZED call already returns year-to-date months (pinned fact 3),
  // making this `year` call redundant against a real tenant -- but the mock's
  // default deliberately returns only the current cycle (every committed
  // current-cycle pin is computed from a no-param fetch), so collapsing the
  // two reads would break the sim history superset. Collapse only if/when the
  // mock's default is switched to YTD emission -- a mock-side decision, not
  // this round's.
  async function fetchHistoricalUsageItems(costCenterIds: readonly string[]): Promise<UsageItem[]> {
    return fetchUsageFanout(octokit, enterprise, costCenterIds, { year: currentDate().slice(0, 4) });
  }

  // Trailing-gap surface (users-report.ts's tolerance + types.ts's
  // SyncStatus.perUserDataThroughDay): the coverage day of the most recent
  // Sync THIS process ran. Process-lifetime closure state, deliberately not
  // persisted (no schema change sanctioned) -- absent before the first sync /
  // after a restart, which the field's doc comment declares as "unknown".
  let lastPerUserDataThroughDay: string | undefined;

  function withPerUserCoverage(status: SyncStatus): SyncStatus {
    return lastPerUserDataThroughDay === undefined ? status : { ...status, perUserDataThroughDay: lastPerUserDataThroughDay };
  }

  // R6: cycle-accurate per-user credits via the users-1-day fan-out over the
  // elapsed cycle days (users-report.ts). Replaces the old bare users-28-day
  // array read; the fan-out is inherently cycle-scoped, so downstream cycle
  // filters remain correct (and redundant) rather than needing a trailing-28d
  // window trimmed by hand. Tolerates a <=2-day trailing report-not-yet-
  // available gap (live only; the mock always serves the as-of day) -- the
  // full result (records + coverage) is returned so syncNow can surface the
  // gap; read-path callers use .records.
  async function fetchCycleCredits(): Promise<CycleUserCreditsResult> {
    const { cycleStart, daysElapsed } = cycleBounds(currentDateObj());
    return fetchCycleUserCredits(octokit, enterprise, cycleStart, daysElapsed);
  }

  // R6 + maintainer decision (2026-07-08): per-user PRIOR-CYCLE history for
  // the user-scope forecast (run-rate training + backtest MAPE), restored as a
  // users-1-day daily backfill over the 3 prior closed cycles -- the SAME
  // window the old (fictional, `since`-parameterised) fetch targeted: from the
  // 1st of the month 3 calendar months before the current cycle's start,
  // through the day before cycleStart. Dates come from the cycleBounds/clock
  // seam (2026-06-14 anchor -> 2026-03-01..2026-05-31, 92 days), never
  // wall-clock in sim. ~92 users-1-day calls (envelope + file each), chunked
  // by fetchUserCreditsForDays; Sync-only, per the maintainer's cost ruling.
  // Returns HISTORY ONLY (strictly pre-cycle) -- callers concatenate it with
  // fetchCycleCredits' current-cycle rows to reconstruct the full training
  // window without double-counting.
  async function fetchHistoricalCreditsUsedItems(): Promise<CreditsUsedItem[]> {
    const { cycleStart } = cycleBounds(currentDateObj());
    const windowStart = new Date(Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth() - 3, 1));
    const days: string[] = [];
    for (let t = windowStart.getTime(); t < cycleStart.getTime(); t += DAY_MS) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return fetchUserCreditsForDays(octokit, enterprise, days);
  }

  // Scope translation at the boundary (wire-contract-writes.md §1, OpenAPI-
  // pinned): the wire's seven-value budget_scope enum (multi_user_customer =
  // universal ULB; user + `user` login field = individual ULB) is mapped to
  // the internal spellings HERE, so every downstream consumer
  // (buildUlbCandidates' ULB-precedence filter, forecast wiring) keeps working
  // against the frozen internal model. Rows with no internal home
  // (repository / unknown) are skipped, mirroring fetchLiveControls.
  async function fetchBudgetsRaw(): Promise<BudgetItem[]> {
    interface WireBudgetRow {
      budget_scope: string;
      budget_entity_name?: string | null;
      user?: string | null;
      budget_product_sku?: string | null;
      budget_amount: number;
    }
    const raw = await paginateAll<WireBudgetRow>(
      octokit,
      '/enterprises/{enterprise}/settings/billing/budgets',
      { enterprise },
      (data) => (data as { budgets: WireBudgetRow[] }).budgets,
    );
    // Budget PRODUCT filter (open item 20, budget-scope.ts's isAiCreditBudget
    // doc): only AI-credit budgets feed ULB-precedence resolution + the
    // per-user forecast allowances -- an actions/storage budget's dollar cap
    // is not an AI-credit ceiling. Excluded rows are traced, never silent.
    const aiCreditRows = raw.filter(isAiCreditBudget);
    warnExcludedProductBudgets(
      raw.filter((row) => !isAiCreditBudget(row)),
      'fetchBudgetsRaw',
    );
    const items: BudgetItem[] = [];
    const skipped: WireBudgetRow[] = [];
    for (const row of aiCreditRows) {
      const identity = wireBudgetToInternal(row);
      if (!identity) {
        skipped.push(row);
        continue;
      }
      items.push({ budget_scope: identity.scope, budget_entity_name: identity.entityName, budget_amount: row.budget_amount });
    }
    // Never silent: unsupported scopes (repository / a future enum widening)
    // are excluded from Controls but traced (see budget-scope.ts's helper).
    warnSkippedBudgetScopes(skipped, 'fetchBudgetsRaw');
    return items;
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
    const [rawItems, seats] = await Promise.all([fetchUsageItems(params), fetchSeats()]);
    // AI-credit sku filter (usage-fetch.ts's live pin): the Overview money
    // tiles + burn-down derive from "Copilot AI Credits" rows ONLY -- Copilot
    // Business/Premium Request (and every other enhanced-billing product a
    // real tenant returns) must never pollute pool/metered sums. This was the
    // maintainer's 0-pool / $64k-phantom-metered dashboard bug.
    const items = aiCreditItems(rawItems);

    const asOfDate = items.reduce<string | null>(
      (latest, item) => (latest === null || item.date > latest ? item.date : latest),
      null,
    );

    const cycleAsOfDate = currentDate();
    const bounds = cycleBounds(currentDateObj());

    // Grain-agnostic cycle scoping (item 23): the burn-down derives from rows
    // whose MONTH equals the cycle month -- identical to the old day-window
    // for per-day rows (a cycle IS a calendar month), and correct for live
    // monthly aggregates (one first-of-month row per bucket, month-to-date
    // cumulative). Live's unparameterized read returns YEAR-TO-DATE months,
    // so this filter is what keeps January..June out of July's line.
    const cycleMonth = cycleAsOfDate.slice(0, 7);
    const monthItems = items.filter((item) => item.date.slice(0, 7) === cycleMonth);

    // Aggregate grain -> fetch the R6 daily sums for the burn-down's SHAPE
    // (see buildDailyBurn's doc). Lazy: per-day worlds (simulation) never pay
    // the users-1-day fan-out here, and stay byte-identical.
    let r6DailyTotals: Map<string, number> | null = null;
    if (isMonthlyAggregateGrain(monthItems)) {
      const { records } = await fetchCycleCredits();
      r6DailyTotals = new Map<string, number>();
      for (const record of records) {
        r6DailyTotals.set(record.date, (r6DailyTotals.get(record.date) ?? 0) + record.ai_credits_used);
      }
    }
    const dailyBurn = buildDailyBurn(monthItems, bounds.cycleStart, bounds.daysElapsed, r6DailyTotals);

    return {
      asOfDate,
      // ALL FOUR headline totals are CYCLE-SCOPED (maintainer decisions,
      // 2026-07-09: the three USD fields in the item-24 addendum; quantity
      // aligned by the follow-up decision resolving the flagged asymmetry):
      // they sum the CYCLE-MONTH, AI-credit rows only -- the same
      // month-bucket the burn-down uses. Live's unparameterized read returns
      // YEAR-TO-DATE months, and a "spend"/"usage" tile fed a YTD sum against
      // a monthly cap is exactly the maintainer's 1115%-used pathology.
      // Fixture consequence: the out-of-cycle Aug-31/Sep-1 cliff rows no
      // longer count anywhere (qty 193,036 -> 192,100; net 25.34 -> 23.00).
      totalQuantity: monthItems.reduce((sum, item) => sum + item.quantity, 0),
      totalGrossAmountUsd: monthItems.reduce((sum, item) => sum + item.grossAmount, 0),
      totalDiscountAmountUsd: monthItems.reduce((sum, item) => sum + item.discountAmount, 0),
      totalNetAmountUsd: monthItems.reduce((sum, item) => sum + item.netAmount, 0),
      licenseCount: seats.length,
      cycleAsOfDate,
      dailyBurn,
    };
  }

  async function listCostCenters(): Promise<CostCenterSummary[]> {
    const costCenters = await fetchCostCentersRaw();
    const [{ records: creditsUsedItems }, usageItems] = await Promise.all([
      fetchCycleCredits(),
      // Per-CC MTD burn source (2026-07-09 Cost Centers live-correctness
      // round): the R5 per-CC fan-out -- attribution by query, AI-credit
      // filtered, month-bucketed, grain-agnostic (a live monthly-aggregate
      // row's quantity IS the MTD cumulative; per-day fixture rows sum to the
      // IDENTICAL totals the old fixture-only mtd_burn_credits enrichment
      // carried, e.g. Workforce 30,200 / cap-bound 58,300). Live CCs have no
      // enrichment at all -- deriving is the only honest source, and a CC
      // with no usage rows derives 0, never NaN.
      fetchUsageFanout(octokit, enterprise, costCenters.map((cc) => cc.id)),
    ]);
    // App-local DEWR mapping (maintainer decision: an app-local construct,
    // editable via updateCostCenterMapping): local DB columns win over the
    // simulation fixtures' wire enrichment; absent everywhere -> null.
    const mappingRows = config.db.select().from(schema.costCenter).all();
    const mappingById = new Map(mappingRows.map((row) => [row.id, row] as const));

    // Per-member cycle-to-date burn: same cycle window as getUsageSummary
    // (anchored to the deterministic fixture date, never wall-clock), so a
    // member whose only credits rows fall outside the current cycle burns 0.
    const bounds = cycleBounds(currentDateObj());
    const burnByLogin = new Map<string, number>();
    for (const item of creditsUsedItems) {
      const dayIndex = Math.floor((Date.parse(`${item.date}T00:00:00.000Z`) - bounds.cycleStart.getTime()) / DAY_MS);
      if (dayIndex < 0 || dayIndex > bounds.daysElapsed) continue;
      burnByLogin.set(item.user_login, (burnByLogin.get(item.user_login) ?? 0) + item.ai_credits_used);
    }

    // Cycle-month, AI-credit-filtered per-CC quantity totals (pool + metered
    // -- `quantity` is the credit count either way). Rounded once at the end:
    // live quantities are fractional (486,084.5584155...).
    const cycleMonth = currentDate().slice(0, 7);
    const mtdByCostCenterId = new Map<string, number>();
    for (const item of aiCreditItems(usageItems)) {
      if (item.costCenterId === null) continue;
      if (item.date.slice(0, 7) !== cycleMonth) continue;
      mtdByCostCenterId.set(item.costCenterId, (mtdByCostCenterId.get(item.costCenterId) ?? 0) + item.quantity);
    }

    return costCenters.map((cc) => {
        // R3: members read off the embedded `resources`, not a GET /resource call.
        const resources = cc.resources;
        const members: CostCenterMemberSummary[] = resources
          .filter((r) => r.type === 'User')
          .map((r) => ({
            login: r.name,
            mtdBurnCredits: burnByLogin.get(r.name) ?? 0,
            entTeam: r.via_ent_team ?? null,
          }));

        const localMapping = mappingById.get(cc.id);
        return {
          id: cc.id,
          name: cc.name,
          state: cc.state,
          memberCount: resources.length,
          dewrDivision: localMapping?.dewrDivision ?? cc.dewr_division ?? null,
          dewrBranch: localMapping?.dewrBranch ?? cc.dewr_branch ?? null,
          dewrProject: localMapping?.dewrProject ?? cc.dewr_project ?? null,
          mtdBurnCredits: Math.round(mtdByCostCenterId.get(cc.id) ?? 0),
          includedUsageCap: {
            enabled: cc.included_usage_cap.enabled,
            computedLimitCredits: cc.included_usage_cap.computed_limit_credits,
            overflow: cc.included_usage_cap.overflow,
          },
          excludedFromEnterpriseBudget: cc.excluded_from_enterprise_budget,
          members,
        };
      });
  }

  // Maintainer-sanctioned method (2026-07-09): app-local DEWR mapping edit.
  // LOCAL DB ONLY -- no GitHub request is ever issued (asserted by test);
  // works identically in both modes. Upsert so a mapping saved before the
  // first Sync survives: the insert's name placeholder (the id) is corrected
  // by the next sync's upsert, which only sets name/state and therefore never
  // clobbers these columns.
  async function updateCostCenterMapping(costCenterId: string, mapping: CostCenterMappingInput): Promise<void> {
    config.db
      .insert(schema.costCenter)
      .values({
        id: costCenterId,
        name: costCenterId,
        state: 'active',
        dewrDivision: mapping.dewrDivision,
        dewrBranch: mapping.dewrBranch,
        dewrProject: mapping.dewrProject,
      })
      .onConflictDoUpdate({
        target: schema.costCenter.id,
        set: { dewrDivision: mapping.dewrDivision, dewrBranch: mapping.dewrBranch, dewrProject: mapping.dewrProject },
      })
      .run();
  }

  // Task 9.3-lite: the PERSISTED mode selection (app_settings 'app_mode') --
  // the in-app toggle that retired the COPILOT_BUDGET_FORCE_SIMULATION env
  // seam. These are app-local DB reads/writes, safe in BOTH modes (it's the
  // stored SELECTION, not a live mutation). Setting it does NOT re-resolve the
  // running process's mode -- resolveMode reads it at boot; the Settings card
  // says "restart to apply".
  async function getAppModeSetting(): Promise<'simulation' | 'live'> {
    return readAppModeSetting(config.db);
  }
  async function setAppModeSetting(mode: 'simulation' | 'live'): Promise<void> {
    writeAppModeSetting(config.db, mode);
  }

  // Task 9.3-lite: live-write arming (write/arming.ts's process-memory
  // singleton). In simulation (source 'msw') arming is INERT -- always
  // { armed: false, enterpriseSlug: null } -- because sim never issues real
  // writes (§6.8), so there is nothing to arm. In live mode the confirmation
  // must equal the enterprise slug EXACTLY; a mismatch throws and does not arm
  // (the slug is not a secret, so it is fine in the error message). Disarming
  // never needs confirmation.
  async function getWriteArmingState(): Promise<WriteArmingState> {
    if (config.source === 'msw') {
      return { armed: false, enterpriseSlug: null, mode: 'simulation' };
    }
    return { armed: isWriteArmed(), enterpriseSlug: enterprise, mode: 'live' };
  }
  async function setWriteArming(request: WriteArmingRequest): Promise<WriteArmingState> {
    if (config.source === 'msw') {
      // Inert in simulation: ignore the request (arming a no-op) and report
      // the disarmed sim state -- §6.8, nothing to arm.
      return { armed: false, enterpriseSlug: null, mode: 'simulation' };
    }
    if (request.action === 'disarm') {
      setWriteArmed(false);
      return { armed: false, enterpriseSlug: enterprise, mode: 'live' };
    }
    // action === 'arm': require the typed confirmation to equal the enterprise
    // slug EXACTLY. On a mismatch, throw and leave the flag untouched.
    if (request.confirmation !== enterprise) {
      throw new Error('Confirmation does not match the enterprise slug.');
    }
    setWriteArmed(true);
    return { armed: true, enterpriseSlug: enterprise, mode: 'live' };
  }

  async function listHeavyUsers(): Promise<HeavyUser[]> {
    const [{ records: creditsUsedItems }, seats, costCentersRaw, budgetsRaw] = await Promise.all([
      fetchCycleCredits(),
      fetchSeats(),
      fetchCostCentersRaw(),
      fetchBudgetsRaw(),
    ]);

    // R3: login -> cost-center name from the embedded resources, not a per-CC
    // GET /resource fan-out.
    const costCenterNameByLogin = new Map<string, string>();
    for (const cc of costCentersRaw) {
      for (const r of cc.resources) {
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
    const bounds = cycleBounds(currentDateObj());
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

  // Distribution D2: per-user credit totals over a rolling 1/3/9-month
  // window, read ENTIRELY from the local SQLite mirror -- NO GitHub request
  // on this path (both sources run the identical query; §6.9 exempt by
  // construction). Coverage is the maintainer-approved union/latest-wins
  // (types.ts's UsageDistributionWindow doc): dates union across ALL of this
  // source's snapshots; per date, the latest snapshot containing it wins.
  // Source-scoped (CLAUDE.md §6.8) via the same snapshot join
  // getLastSyncedControls/getLatestForecast use, so a sim session never
  // aggregates live-synced facts as its own (and vice versa).
  //
  // NOTE (deliberate divergence from the D2 brief's wording, maintainer-
  // ratified 2026-07-10): the brief said to follow listHeavyUsers' snapshot
  // scoping and cost-center join -- but listHeavyUsers is a LIVE read (R6
  // fan-out + seats + embedded CC resources), not a SQLite read, and its
  // login-space CC join has no DB equivalent. The DB-native join is simpler:
  // license.costCenterId -> cost_center.name (null when unassigned or when a
  // fact-only user has no license row).
  // Distribution: the SHARED base both distribution reads (getUsageDistribution
  // and getUserMonthObservations) start from -- the source-scoped per-user fact
  // rows plus the union/latest-wins winning-generation map and the covered date
  // bounds. Extracted (rather than duplicated per read) so the coverage
  // semantics are defined in exactly one place. Returns null for the SENTINEL
  // case (no per-user history for this source at all -- fresh DB / never synced
  // in this mode); every caller maps null to its own sentinel shape.
  function readDistributionFactBase(): DistributionFactBase | null {
    return readDistributionFactBaseFor(config.db, config.source);
  }

  // Distribution: the SHARED roster/name lookups both reads apply after
  // bucketing -- the licensed roster (ROSTER RULE), the userId->license map
  // (login fallback + cost-center id), and the cost-center id->name map.
  interface DistributionRosterLookups {
    licenseRows: Array<typeof schema.license.$inferSelect>;
    costCenterNameById: Map<string, string>;
    licenseByUserId: Map<string, typeof schema.license.$inferSelect>;
  }
  function readDistributionRosterLookups(): DistributionRosterLookups {
    const licenseRows = config.db.select().from(schema.license).all();
    const costCenterNameById = new Map(
      config.db
        .select({ id: schema.costCenter.id, name: schema.costCenter.name })
        .from(schema.costCenter)
        .all()
        .map((cc) => [cc.id, cc.name] as const),
    );
    const licenseByUserId = new Map(licenseRows.map((lic) => [lic.userId, lic] as const));
    return { licenseRows, costCenterNameById, licenseByUserId };
  }

  // Distribution "Totals" lens: per-user credit sums over a CALENDAR-ANCHORED
  // window -- the current calendar month (of toDate) to date + the (months-1)
  // prior calendar months, aligned to billing cycles. Pure local-SQLite read
  // over the shared union/latest-wins base + the monthly-fact backfill;
  // §6.9-exempt (no GitHub HTTP), source-scoped (§6.8). See types.ts's
  // UsageDistributionWindow for the full semantics.
  //
  // Calendar-anchored windows (maintainer-approved 2026-07-10): the CURRENT
  // month sums daily facts up to toDate (unchanged winner rule + nonzero
  // bounds); each PRIOR month uses its MONTHLY fact when one exists (billing
  // wins over daily, same rule + rationale as the per-month lens), else daily
  // sums when the month has nonzero daily coverage, else contributes nothing.
  // A requested month with no data simply drops out, driving truncation.
  //
  // Zero-filled-history fix (2026-07-10): toDate is the latest NONZERO covered
  // day, so a zero-filled newest month never anchors the current month. A fully
  // zero-filled source (base.toDate === '') hits the sentinel guard below.
  async function getUsageDistribution(input: UsageDistributionWindowInput): Promise<UsageDistributionWindow> {
    const months = input.months;
    // Runtime guard: the preload/IPC boundary is untyped at runtime, so the
    // 1|3|9 literal type alone protects nothing (same rationale as
    // setScenario's isScenarioId check; thrown rather than refused-shaped
    // because an out-of-range months is a caller bug, not a mode condition).
    if (months !== 1 && months !== 3 && months !== 9) {
      throw new Error(`getUsageDistribution: months must be 1, 3, or 9 (got ${String(months)}).`);
    }

    const base = readDistributionFactBase();
    // SENTINEL (types.ts): no per-user history for this source at all (fresh DB
    // / never synced in this mode), OR the whole covered timeline is zero-fill
    // (base.toDate === '' -- zero-filled-history fix: earlier months GitHub
    // zero-filled carry no nonzero coverage bound). Either way there is no
    // current month to anchor.
    if (base === null || base.toDate === '') {
      return { fromDate: '', toDate: '', truncated: false, users: [] };
    }
    const { factRows, winnerSnapshotByDate, toDate } = base;

    // MONTHLY facts (per-user-per-MONTH billing backfill; migration 0007).
    // github-source only -- empty in sim, so the sim path is pure daily-sum.
    const monthlyFacts = readMonthlyCreditsFactsFor(config.db, config.source);

    // Winning daily rows only, bucketed by calendar month (YYYY-MM). Zero rows
    // are retained (they add nothing to any sum) but never make a prior month
    // "contribute" -- the nonzero-coverage rule from readDistributionFactBaseFor.
    const dailyByMonth = new Map<string, DistributionFactBase['factRows']>();
    for (const row of factRows) {
      if (row.snapshotId !== winnerSnapshotByDate.get(row.date)) continue; // superseded generation for this date
      const m = row.date.slice(0, 7);
      let arr = dailyByMonth.get(m);
      if (!arr) {
        arr = [];
        dailyByMonth.set(m, arr);
      }
      arr.push(row);
    }
    const monthHasNonzeroDaily = (m: string): boolean => (dailyByMonth.get(m) ?? []).some((r) => r.creditsUsed > 0);

    // Per-user window sums; the login candidate is the latest-dated non-null
    // user_login among the user's contributing rows (rung 1 of the ladder).
    interface DistAccumulator {
      sum: number;
      loginDate: string;
      login: string | null;
    }
    const accByUserId = new Map<string, DistAccumulator>();
    const getAcc = (userId: string): DistAccumulator => {
      let acc = accByUserId.get(userId);
      if (!acc) {
        acc = { sum: 0, loginDate: '', login: null };
        accByUserId.set(userId, acc);
      }
      return acc;
    };
    const noteLogin = (acc: DistAccumulator, login: string | null, dateKey: string): void => {
      if (login !== null && dateKey >= acc.loginDate) {
        acc.loginDate = dateKey;
        acc.login = login;
      }
    };

    // Walk the requested calendar months newest-first: current month + (N-1)
    // prior. Track which ones actually contribute (for truncation + fromDate)
    // and accumulate the window-total unattributed remainder.
    const currentMonth = toDate.slice(0, 7);
    const contributingMonths: string[] = []; // newest-first; [current, ...]
    let unattributedTotal = 0;

    let month = currentMonth;
    for (let i = 0; i < months; i++, month = previousMonth(month)) {
      if (month === currentMonth) {
        // CURRENT month: per-user DAILY sums up to toDate. Always contributes --
        // toDate is a nonzero day inside it (guaranteed by base.toDate !== '').
        for (const row of dailyByMonth.get(month) ?? []) {
          if (row.date > toDate) continue; // "to date" end = the landed nonzero toDate
          const acc = getAcc(row.userId);
          acc.sum += row.creditsUsed;
          noteLogin(acc, row.userLogin, row.date);
        }
        contributingMonths.push(month);
      } else if (monthlyFacts.has(month)) {
        // PRIOR month with a monthly fact: MONTHLY WINS over daily. Attributed
        // rows are the per-user whole-month sums; the NULL-user remainder is
        // EXCLUDED from per-user totals and surfaced as unattributedCredits.
        // Pseudo-date `${month}-31` for the login priority so a later real daily
        // login can still supersede it (parity with the per-month lens).
        const facts = monthlyFacts.get(month)!;
        for (const [userId, rec] of facts.attributed) {
          const acc = getAcc(userId);
          acc.sum += rec.credits;
          noteLogin(acc, rec.login, `${month}-31`);
        }
        unattributedTotal += facts.remainder;
        contributingMonths.push(month);
      } else if (monthHasNonzeroDaily(month)) {
        // PRIOR month, no monthly fact but nonzero daily coverage: daily sums.
        for (const row of dailyByMonth.get(month)!) {
          const acc = getAcc(row.userId);
          acc.sum += row.creditsUsed;
          noteLogin(acc, row.userLogin, row.date);
        }
        contributingMonths.push(month);
      }
      // else: month contributes nothing (no monthly fact, no daily coverage).
    }

    const monthsIncluded = contributingMonths.length;
    const truncated = monthsIncluded < months;
    // fromDate = first day of the OLDEST contributing month (last in the
    // newest-first list -- current month is always element 0 and never oldest
    // unless it's the only one); toDate = the landed nonzero daily toDate.
    const oldestMonth = contributingMonths[contributingMonths.length - 1] ?? currentMonth;
    const fromDate = `${oldestMonth}-01`;

    // ROSTER RULE: every licensed user appears, zero-usage included; users
    // with facts but no license row (shouldn't exist; defensive) follow.
    const { licenseRows, costCenterNameById, licenseByUserId } = readDistributionRosterLookups();

    // Login fallback ladder (types.ts's UsageDistributionUser doc): winning
    // fact login -> license login (migration 0005; the seats listing always
    // carries assignee.login) -> String(userId), the honest last resort for
    // pre-migration rows never re-synced. (userId is already TEXT, so the
    // final rung is the raw column value.)
    const toUser = (userId: string): UsageDistributionUser => {
      const acc = accByUserId.get(userId);
      const lic = licenseByUserId.get(userId);
      const ccId = lic?.costCenterId ?? null;
      return {
        userLogin: acc?.login ?? lic?.userLogin ?? userId,
        costCenterName: ccId === null ? null : (costCenterNameById.get(ccId) ?? null),
        // Rounded ONCE at the end (facts are REAL) -- never per-row.
        creditsUsed: Math.round(acc?.sum ?? 0),
      };
    };

    const users: UsageDistributionUser[] = [];
    const seenUserIds = new Set<string>();
    for (const lic of licenseRows) {
      if (seenUserIds.has(lic.userId)) continue;
      seenUserIds.add(lic.userId);
      users.push(toUser(lic.userId));
    }
    for (const userId of accByUserId.keys()) {
      if (seenUserIds.has(userId)) continue;
      seenUserIds.add(userId);
      users.push(toUser(userId));
    }

    // Deterministic order (types.ts): creditsUsed desc, then login asc.
    users.sort((a, b) => b.creditsUsed - a.creditsUsed || a.userLogin.localeCompare(b.userLogin));

    const result: UsageDistributionWindow = { fromDate, toDate, truncated, users, monthsIncluded };
    // ADDITIVE: the window-total departed-user remainder, rounded once, positive
    // -only. Absent (not 0) when there is none, so the daily-only / sim path
    // keeps the original 4-key shape.
    const roundedUnattributed = Math.round(unattributedTotal);
    if (roundedUnattributed > 0) result.unattributedCredits = roundedUnattributed;
    return result;
  }

  // Distribution "Per month" lens: per (user, complete-calendar-month) credit
  // observations over the last N complete months of SYNCED history. Same pure
  // local-SQLite read + union/latest-wins coverage base as getUsageDistribution
  // (readDistributionFactBase / readDistributionRosterLookups), re-bucketed by
  // whole calendar month. A "complete calendar month" is one whose monthStart
  // >= the earliest covered day AND monthEnd <= toDate; the in-progress partial
  // month (monthEnd > toDate) is ALWAYS excluded. See types.ts's
  // UserMonthObservationsResult for the full semantics. §6.9-exempt (no GitHub
  // HTTP), source-scoped (§6.8).
  //
  // Zero-filled-history fix (2026-07-10): `earliestDate`/`toDate` are the NONZERO
  // coverage bounds (readDistributionFactBaseFor) -- GitHub zero-fills per-user
  // history beyond retention, so anchoring completeness on zero-filled months
  // would report a "complete" month of 100 all-zero observations. With the
  // nonzero bounds, the live repro (zero-filled Apr-Jun + real July 1-8) has
  // toDate 07-08, so July's month-end 07-31 > toDate -> NO complete month ->
  // sentinel. A genuinely-zero INTERIOR month (nonzero months on both sides)
  // still counts as complete and yields all-zero observations (edge-based
  // bounds, not a per-month filter). A fully zero-filled source (base.toDate
  // === '') hits the sentinel guard below.
  async function getUserMonthObservations(input: UsageDistributionWindowInput): Promise<UserMonthObservationsResult> {
    const months = input.months;
    // Same untyped-boundary guard as getUsageDistribution.
    if (months !== 1 && months !== 3 && months !== 9) {
      throw new Error(`getUserMonthObservations: months must be 1, 3, or 9 (got ${String(months)}).`);
    }

    // The daily coverage base (per-user-per-DAY, from the metrics users-1-day
    // report). May be null (never synced this source) or fully zero-filled
    // (toDate === ''); either way it contributes NO daily complete months, but
    // the MONTHLY backfill can still carry history the daily report zero-filled.
    const base = readDistributionFactBase();
    const factRows = base?.factRows ?? [];
    const winnerSnapshotByDate = base?.winnerSnapshotByDate ?? new Map<string, number>();

    // MONTHLY facts (per-user-per-MONTH, from the billing ai_credit/usage
    // backfill; migration 0007). github-source only -- empty in sim, so the sim
    // path is byte-identical to the daily-only original below. Each key is a
    // CLOSED billing month (the current partial month is never backfilled), so
    // every monthly-fact month is inherently a "complete" month.
    const monthlyFacts = readMonthlyCreditsFactsFor(config.db, config.source);

    // Daily-derived complete months (unchanged rule): enumerate calendar months
    // from the earliest nonzero covered day through toDate, keeping those fully
    // inside [earliestDate, toDate]. Only when the daily base has nonzero
    // coverage (base.toDate !== '').
    const dailyCompleteMonths: string[] = [];
    if (base !== null && base.toDate !== '') {
      const { earliestDate, toDate } = base;
      const startY = Number(earliestDate.slice(0, 4));
      const startM = Number(earliestDate.slice(5, 7));
      const endY = Number(toDate.slice(0, 4));
      const endM = Number(toDate.slice(5, 7));
      for (let y = startY, m = startM; y < endY || (y === endY && m <= endM); ) {
        const mm = String(m).padStart(2, '0');
        const monthStart = `${y}-${mm}-01`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this month
        const monthEnd = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`;
        if (monthStart >= earliestDate && monthEnd <= toDate) dailyCompleteMonths.push(`${y}-${mm}`);
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }

    // MERGE: completeMonths = daily-derived ∪ monthly-fact months, ascending.
    // For a month present in BOTH, the MONTHLY FACT wins at OBSERVATION time
    // (below) -- billing (ai_credit/usage) is the money source of truth; the
    // metrics daily report is an approximation that zero-fills past retention.
    // The month SET is the same union either way; only which data feeds a
    // conflicting month's observations differs.
    const monthlyFactMonths = new Set(monthlyFacts.keys());
    const completeMonths = [...new Set([...dailyCompleteMonths, ...monthlyFactMonths])].sort();

    // No complete calendar month at all (neither daily nor monthly) -> sentinel
    // (types.ts): the UI renders "sync again after month end". EXACT 3-key shape
    // preserved -- sim never has monthly facts, so this stays byte-identical.
    if (completeMonths.length === 0) {
      return { months: [], truncated: false, observations: [] };
    }

    // "Last N complete months ending at the most recent complete month";
    // truncated when fewer than N complete months exist.
    const truncated = completeMonths.length < months;
    const includedMonths = completeMonths.slice(-months);

    // Per (userId, month) sums; the login candidate is the latest-dated non-null
    // login among the user's contributing rows (rung 1 of the D2 ladder), shared
    // across all of that user's month observations.
    interface UmAccumulator {
      byMonth: Map<string, number>;
      loginDate: string;
      login: string | null;
    }
    const accByUserId = new Map<string, UmAccumulator>();
    const getAcc = (userId: string): UmAccumulator => {
      let acc = accByUserId.get(userId);
      if (!acc) {
        acc = { byMonth: new Map(), loginDate: '', login: null };
        accByUserId.set(userId, acc);
      }
      return acc;
    };
    const noteLogin = (acc: UmAccumulator, login: string | null, dateKey: string): void => {
      if (login !== null && dateKey >= acc.loginDate) {
        acc.loginDate = dateKey;
        acc.login = login;
      }
    };

    for (const month of includedMonths) {
      if (monthlyFactMonths.has(month)) {
        // MONTHLY-FACT month wins: attributed rows are the per-user whole-month
        // sums; the NULL-user remainder is EXCLUDED here (surfaced separately as
        // unattributedCredits below). Pseudo-date `${month}-31` for the login
        // priority so a later real daily login can still supersede it.
        const facts = monthlyFacts.get(month)!;
        for (const [userId, rec] of facts.attributed) {
          const acc = getAcc(userId);
          acc.byMonth.set(month, (acc.byMonth.get(month) ?? 0) + rec.credits);
          noteLogin(acc, rec.login, `${month}-31`);
        }
      } else {
        // DAILY-only month: sum the winning per-day rows (unchanged rule).
        for (const row of factRows) {
          if (row.date.slice(0, 7) !== month) continue;
          if (row.snapshotId !== winnerSnapshotByDate.get(row.date)) continue; // superseded generation for this date
          const acc = getAcc(row.userId);
          acc.byMonth.set(month, (acc.byMonth.get(month) ?? 0) + row.creditsUsed);
          noteLogin(acc, row.userLogin, row.date);
        }
      }
    }

    const { licenseRows, costCenterNameById, licenseByUserId } = readDistributionRosterLookups();

    // ROSTER RULE: every licensed user contributes ONE observation per included
    // month (0 when idle that month); fact-only users (no license row;
    // defensive) follow. Login fallback ladder identical to getUsageDistribution
    // (winning fact login -> license login -> String(userId)).
    const observations: UserMonthObservation[] = [];
    const emit = (userId: string): void => {
      const acc = accByUserId.get(userId);
      const lic = licenseByUserId.get(userId);
      const ccId = lic?.costCenterId ?? null;
      const userLogin = acc?.login ?? lic?.userLogin ?? userId;
      const costCenterName = ccId === null ? null : (costCenterNameById.get(ccId) ?? null);
      for (const month of includedMonths) {
        observations.push({
          userLogin,
          costCenterName,
          month,
          // Rounded ONCE at the end per whole-month sum (facts are REAL).
          creditsUsed: Math.round(acc?.byMonth.get(month) ?? 0),
        });
      }
    };
    const seenUserIds = new Set<string>();
    for (const lic of licenseRows) {
      if (seenUserIds.has(lic.userId)) continue;
      seenUserIds.add(lic.userId);
      emit(lic.userId);
    }
    for (const userId of accByUserId.keys()) {
      if (seenUserIds.has(userId)) continue;
      seenUserIds.add(userId);
      emit(userId);
    }

    // Deterministic order (userLogin asc, then month asc) -- the histogram math
    // is order-invariant, but a stable order keeps the surface testable.
    observations.sort((a, b) => a.userLogin.localeCompare(b.userLogin) || a.month.localeCompare(b.month));

    // Unattributed remainder (departed users): the NULL-user monthly-fact row,
    // EXCLUDED from observations (it has no user to bucket) but surfaced so the
    // UI can caption it. Only included months with a positive rounded remainder
    // appear. ADDITIVE + optional: omitted entirely when empty, so sim (no
    // monthly facts) and every daily-only month return the exact original
    // 3-key shape (byte-identical -- the existing suites are the oracle).
    const unattributedCredits: Record<string, number> = {};
    for (const month of includedMonths) {
      const facts = monthlyFacts.get(month);
      if (!facts) continue;
      const rounded = Math.round(facts.remainder);
      if (rounded > 0) unattributedCredits[month] = rounded;
    }

    const result: UserMonthObservationsResult = { months: includedMonths, truncated, observations };
    if (Object.keys(unattributedCredits).length > 0) result.unattributedCredits = unattributedCredits;
    return result;
  }

  async function listAlerts(): Promise<Alert[]> {
    // Live-mode alert derivation is a Phase 6 capability (PRD FR17 custom
    // alerting). Until then, LIVE returns an EMPTY list rather than leaking the
    // MSW demo fixtures (ext-dmorrow, the DEWR cap/cliff alerts, ...) into a
    // real tenant's Overview -- a maintainer-reported live-mode bug (2026-07-10:
    // fixture alerts surfaced against the live tenant). Simulation keeps its
    // pre-baked fixture alerts (scenario semantics untouched).
    return config.source === 'msw' ? ALERTS : [];
  }

  // Mode-isolation (item 24 / CLAUDE.md §6.8): scoped to THIS client's source
  // -- a sim session never reports a live sync's timestamp as its own "Last
  // synced" (and vice versa), the same scoping getLastSyncedControls/
  // getForecast already apply.
  async function getSyncStatus(): Promise<SyncStatus> {
    return withPerUserCoverage(readSyncStatus(config.db, config.source));
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
    // R3/R5/R6: cost centers are fetched first (they carry embedded resources
    // AND supply the ids the usage fan-out queries per cost center); the usage
    // reads (current-cycle + `year` history superset) and the users-1-day cycle
    // fan-out then run together. The `year` historical read is NOT concatenated
    // with the current-cycle usage read -- it is already a superset of it.
    const [costCentersRaw, seats, live, budgetsRaw] = await Promise.all([
      fetchCostCentersRaw(),
      fetchSeats(),
      fetchLiveControls(octokit, enterprise, currentDateObj()),
      fetchBudgetsRaw(),
    ]);
    const costCenterIds = costCentersRaw.map((cc) => cc.id);
    const [usageItems, historicalUsageItems, cycleCredits, historicalCredits] = await Promise.all([
      fetchUsageFanout(octokit, enterprise, costCenterIds),
      fetchHistoricalUsageItems(costCenterIds),
      fetchCycleCredits(),
      fetchHistoricalCreditsUsedItems(),
    ]);

    // R3: resource rosters come off the embedded cost-center objects, not a
    // per-CC GET /resource fan-out.
    const resourcesByCostCenter = costCentersRaw.map((cc) => ({ costCenterId: cc.id, resources: cc.resources }));

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
      asOfDate: currentDateObj(),
      computedAt: currentDate(),
      historicalUsageItems,
      // Prior-cycle backfill + current cycle -- the full user-scope training
      // window (disjoint by construction: the backfill ends the day before
      // cycleStart, so this concatenation never double-counts a day).
      userCreditItems: [...historicalCredits, ...cycleCredits.records],
      costCentersRaw,
      resourcesByCostCenter,
      seats,
      budgetsRaw,
      loginToCostCenterName,
    });

    // Monthly per-user AI-credit backfill (migration 0007) -- github-source
    // ONLY. MSW has no ai_credit/usage handler and sim pins must stay
    // byte-identical, so the sim path skips the fan-out entirely and persists no
    // monthly facts. From (currentMonth − 1) backward, banked months are never
    // refetched (append-once); each candidate month is error-isolated. The
    // resulting rows persist inside ingestSnapshot's transaction below.
    let monthlyBackfill: IngestMonthlyCreditsRow[] = [];
    if (config.source === 'github') {
      const backfill = await backfillMonthlyCredits(octokit, enterprise, {
        currentMonth: currentDate().slice(0, 7),
        seats: seats.map((s) => ({ id: String(s.assignee.id), login: s.assignee.login })),
        bankedMonths: readBankedMonthsFor(config.db, config.source),
      });
      monthlyBackfill = backfill.rows;
      // §6.6-safe summary (months + counts only, never a login). eslint-safe
      // console use matches the warn* tracing helpers elsewhere in this module.
      console.info(
        `[monthly-backfill] persisted ${backfill.monthsPersisted.length} month(s) / ${backfill.rows.length} row(s); ` +
          `banked-skipped ${backfill.monthsSkippedBanked.length}; failed ${backfill.monthsFailed.length}; ` +
          `negative-remainder ${backfill.monthsNegativeRemainder.length}; ` +
          `era-floor ${backfill.eraFloorMonth ?? 'none'}`,
      );
    }

    const data: IngestData = {
      entity: enterprise,
      // Persist-vs-drop ruling (2026-07-09 sku-filter round, FLAGGED for the
      // validator): snapshots keep the RAW, unfiltered item set -- every
      // product/sku, exactly as the wire returned it (the `sku` column makes
      // each row's identity recoverable). The AI-credit filter is applied at
      // the DERIVATION boundaries only (getUsageSummary, computeSyncForecasts,
      // assembleUsageState), so pool/metered money math is clean while future
      // chargeback/audit phases still have the full billing picture on disk.
      usageItems: usageItems.map((item) => ({
        date: item.date,
        costCenterId: item.costCenterId,
        // R5: usage items no longer carry user_login on the wire -- per-user
        // usage attribution is genuinely unavailable from this endpoint (moved
        // to the R6 users reports, which carry no cost-center/metered split).
        // Persisted null rather than a fabricated attribution. (FLAGGED.)
        userLogin: null,
        sku: item.sku,
        quantity: item.quantity,
        netAmountUsd: item.netAmount,
      })),
      // Distribution D2 (maintainer-approved sync change, 2026-07-10): persist
      // the prior-cycle backfill TOO (the same already-fetched
      // historicalCredits the forecast trains on), not just the current cycle
      // -- getUsageDistribution's 1/3/9-month windows would otherwise only
      // ever see ~one cycle of synced data. Disjoint by construction (the
      // backfill ends the day before cycleStart), so this never double-writes
      // a day. Each row now carries the report's user_login (migration 0005).
      // FORECAST-INDEPENDENT: computeSyncForecasts above consumes the SAME
      // in-memory arrays directly (userCreditItems) and never reads
      // credits_used_fact back, so persisting more rows changes no forecast.
      creditsUsedItems: [...historicalCredits, ...cycleCredits.records].map((item) => ({
        date: item.date,
        userId: item.user_id,
        userLogin: item.user_login,
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
        // Distribution D2 (migration 0005): the seat source DOES carry the
        // login (assignee.login) -- persisted so zero-usage licensed users
        // (no fact rows) still resolve a login for the roster rule.
        userLogin: seat.assignee.login,
        costCenterId: loginToCostCenter.get(seat.assignee.login) ?? null,
        assignedAt: new Date(seat.created_at),
      })),
      controls: live.controls,
      forecasts,
      monthlyBackfill,
    };

    ingestSnapshot(config.db, config.source, data);
    // Record this Sync's per-user coverage AFTER the ingest committed, so the
    // surfaced day can never describe a Sync that failed to persist. null
    // coverage (possible only for a <=2-day-old cycle whose every day was
    // skipped) leaves the previous value in place rather than fabricating one.
    if (cycleCredits.coveredThroughDay !== null) {
      lastPerUserDataThroughDay = cycleCredits.coveredThroughDay;
    }
    return withPerUserCoverage(readSyncStatus(config.db, config.source));
  }

  // Task 4.15: the Controls screen's "last synced" baseline for browse-time
  // drift detection (core's driftedControlIds, fed (getLastSyncedControls(),
  // getControls())). A thin read-through to the sync package -- capturedAt is
  // surfaced as an ISO string (matching SyncStatus.lastSyncedAt's convention)
  // rather than the internal Date, since a preload/IPC/renderer caller has no
  // use for a raw Date across that boundary.
  async function getLastSyncedControls(): Promise<LastSyncedControls | null> {
    // Mode-isolation fix (CLAUDE.md §6.8): scoped to THIS client's source so a
    // live client never surfaces an MSW-derived drift baseline (or vice
    // versa) -- the same config.source the clock seam already keys off.
    const result = readLastSyncedControls(config.db, config.source);
    return result ? { capturedAt: result.capturedAt.toISOString(), controls: result.controls } : null;
  }

  // Task 5.4: a thin read-through to the sync package's latest-forecast
  // lookup (packages/data/src/sync/sync-now.ts's getLatestForecast) -- the
  // Forecast screen's (and Overview/Users' forecast overlays') read surface.
  // Mode-isolation fix (CLAUDE.md §6.8): scoped to THIS client's source so a
  // live client never surfaces an MSW-derived forecast as if it were live.
  async function getForecast(scope: ForecastScope, entityId?: string): Promise<StoredForecast | null> {
    return readLatestForecast(config.db, config.source, scope, entityId);
  }

  // Task 4.8's write engine. getControls IS the write engine's own re-read
  // (write/live-state.ts's fetchLiveControls) -- not a second, independently
  // written projection -- so "did live move since the plan was staged"
  // (dryRunPlan/applyPlan's drift check) compares like with like.
  async function getControls(): Promise<ControlState[]> {
    const live = await fetchLiveControls(octokit, enterprise, currentDateObj());
    return live.controls;
  }

  async function dryRunPlan(desiredControls: readonly ControlState[], justification?: string | null): Promise<DryRunResult> {
    return dryRunPlanEngine(desiredControls, {
      enterprise,
      octokit,
      asOfDate: currentDateObj(),
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
      asOfDate: currentDateObj(),
      source: config.source,
    });
  }

  // Task 8.4 / migration 0006: a thin read-through to the audit package's
  // read-only surface, SCOPED to this client's own source
  // (readScopedAuditChain returns the legacy rows + this mode's rows) so the
  // Audit screen shows only the current mode's chain. `ts` is projected to an
  // ISO string (the same boundary convention every other timestamp on this
  // interface already uses), but source/envelopeSnapshot/before/after/prevHash/
  // hash are passed through completely unchanged (see AuditChainEvent's doc
  // comment in types.ts for why re-serializing the JSON fields here would be
  // unsafe).
  async function getAuditChain(): Promise<AuditChainEvent[]> {
    return readScopedAuditChain(config.db, config.source).map((row) => ({
      id: row.id,
      ts: row.ts.toISOString(),
      actor: row.actor,
      action: row.action,
      entityRef: row.entityRef,
      trigger: row.trigger,
      envelopeSnapshot: row.envelopeSnapshot,
      before: row.before,
      after: row.after,
      justification: row.justification,
      dataSnapshotId: row.dataSnapshotId,
      source: row.source,
      prevHash: row.prevHash,
      hash: row.hash,
    }));
  }

  // Task 8.5 / migration 0006: verification runs entirely in this (main)
  // process against the raw SQLite rows -- never over a renderer-supplied
  // chain, which would let a compromised/renderer-side actor "verify" a chain
  // it hadn't actually read from disk. verifyStoredChain checks EVERY segment
  // (legacy + each source) for compliance and maps any failure onto this
  // mode's scoped index space (config.source) so the Audit screen's per-row
  // indicators stay aligned with getAuditChain()'s scoped rows.
  async function verifyAuditChain(): Promise<AuditChainVerification> {
    return verifyStoredChain(config.db, config.source);
  }

  // Task 9.1: the non-secret tenant pointer, read/written through the injected
  // store (plain JSON via the main process; NOT safeStorage -- it carries no
  // secret). A client built without a store (older test call sites) reports no
  // config and cannot persist one.
  async function getTenantConfig(): Promise<TenantConfig | null> {
    return config.tenantConfig ? config.tenantConfig.get() : null;
  }

  async function setTenantConfig(tenant: TenantConfig): Promise<void> {
    const error = validateTenantConfig(tenant);
    if (error) throw new Error(error);
    if (!config.tenantConfig) {
      throw new Error('Tenant configuration persistence is not available in this context.');
    }
    await config.tenantConfig.set(tenant);
  }

  // Task 9.1: classify the CURRENT stored PAT against GitHub's documented auth
  // surface. GET /rate_limit is the probe (it does not consume rate-limit
  // budget and, per GitHub's docs, returns the `X-OAuth-Scopes` response
  // header for OAuth/classic tokens; fine-grained `github_pat_` tokens do NOT
  // carry it -- that presence/absence is the documented classic-vs-fine-grained
  // discriminator). §6.9: this is hand-wrapped interpretation of a response
  // header, recorded in docs/api-surface-validation.md (row A1) for live
  // confirmation at 9.2. Runs in BOTH modes -- the probe hits MSW in
  // simulation (so an admin can sanity-check a token before going live), which
  // is also how the e2e drives every classification branch.
  async function validatePat(): Promise<PatValidation> {
    const pat = config.getPat ? await config.getPat() : (config.auth ?? null);
    if (!pat) {
      return { ok: false, tokenKind: 'invalid', scopes: [], hasManageBillingEnterprise: false, message: 'No token is stored.' };
    }

    // A dedicated probe client authenticated with the CURRENT token (not the
    // construction-time `auth`), pinned to the same API version + baseUrl.
    const probe = new Octokit({ auth: pat, baseUrl: config.baseUrl });
    probe.hook.before('request', (options) => {
      options.headers['x-github-api-version'] = API_VERSION;
    });

    try {
      const response = await probe.request('GET /rate_limit');
      const scopesHeader = response.headers['x-oauth-scopes'];
      if (scopesHeader === undefined || scopesHeader === null) {
        // No X-OAuth-Scopes header -> fine-grained token. It cannot reach the
        // enterprise billing endpoints regardless of its own permissions
        // (CLAUDE.md §4: enterprise endpoints require a CLASSIC PAT).
        return {
          ok: false,
          tokenKind: 'fine_grained',
          scopes: [],
          hasManageBillingEnterprise: false,
          message: 'Fine-grained token: enterprise billing endpoints require a classic PAT with manage_billing:enterprise.',
        };
      }
      const scopes = String(scopesHeader)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const hasScope = scopes.includes('manage_billing:enterprise');
      return {
        ok: hasScope,
        tokenKind: 'classic',
        scopes,
        hasManageBillingEnterprise: hasScope,
        message: hasScope
          ? 'Classic PAT with manage_billing:enterprise — ready for live enterprise reads.'
          : 'Classic PAT is missing the manage_billing:enterprise scope required for enterprise billing endpoints.',
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        return { ok: false, tokenKind: 'invalid', scopes: [], hasManageBillingEnterprise: false, message: 'Token was rejected by GitHub (401 Bad credentials).' };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, tokenKind: 'invalid', scopes: [], hasManageBillingEnterprise: false, message: `Token validation failed: ${message}` };
    }
  }

  // Task 9.2-prep: the live read-surface smoke. The refusal-in-sim-mode gate
  // lives HERE, on the bridge (CLAUDE.md §6.8/§8: a money-adjacent action must
  // be unmistakably refused in simulation and NEVER contact real GitHub). The
  // runner itself (runReadSmoke) is mode-agnostic and unit-tested against MSW;
  // this method never invokes it in sim.
  async function runLiveReadSmoke(): Promise<ReadSmokeResult> {
    if (config.source === 'msw') {
      return { refused: true, reason: 'simulation mode' };
    }
    // R6's variant probes need a day whose report is expected to EXIST and be
    // complete: the day BEFORE the clock seam's as-of date (live: yesterday --
    // today's report may not be generated yet, and the tenant rejects future
    // days). Derived from the clock seam, never bare wall-clock.
    const probeDay = new Date(currentDateObj().getTime() - DAY_MS).toISOString().slice(0, 10);
    const results = await runReadSmoke(octokit, enterprise, probeDay);

    // R7: the filterable ai_credit/premium_request usage report -- a GITHUB-ONLY
    // live exploration (no MSW twin; runReadSmoke, which is MSW-tested, omits
    // it). Appended here in the live branch so it renders as a per-endpoint row
    // in the same smoke card + copy text as R1-R6. `currentMonth` comes from the
    // clock seam (never wall-clock). §6.9-validated against ghec.2026-03-10.json
    // (see runR7's doc comment + api-surface-validation.md's R7 entry).
    const nowObj = currentDateObj();
    results.push(await runR7(octokit, enterprise, { year: nowObj.getUTCFullYear(), month: nowObj.getUTCMonth() + 1 }));

    // Live per-month all-zero diagnostics (2026-07-10). Section 1: what got
    // PERSISTED (source-scoped DB coverage). Section 2: what the R6 historical
    // backfill RETURNS, WITHOUT persisting -- reusing fetchHistoricalCreditsUsed-
    // Items verbatim (the SAME already-§6.9-validated users-1-day fetch syncNow
    // runs; no new endpoint / request shape, so this stays §6.9-exempt).
    const localCoverageText = formatLocalCreditsCoverage(computeLocalCreditsCoverage(config.db, config.source));
    let wireR6Text: string;
    if (config.source === 'github') {
      const items = await fetchHistoricalCreditsUsedItems();
      wireR6Text = formatWireR6Historical(summarizeWireR6Historical(items));
    } else {
      wireR6Text = WIRE_R6_SIM_SKIP_NOTE;
    }

    return { refused: false, ranAt: new Date().toISOString(), results, localCoverageText, wireR6Text };
  }

  // Task 6.7: scenario selector bridge. The mirror-image of runLiveReadSmoke's
  // gate -- scenarios drive the MSW fixture world, so they REFUSE in LIVE mode
  // (`config.source === 'github'`) rather than in sim. In sim they mutate the
  // in-memory active-scenario pointer, which re-seeds MSW (getActiveFixtures)
  // and re-anchors the clock (resolveClockDate) for every subsequent read.
  async function listScenarios(): Promise<ListScenariosResult> {
    if (config.source === 'github') return { refused: true, reason: 'live mode' };
    return { refused: false, scenarios: [...listScenarioSummaries()], activeId: getActiveScenarioSummary().id };
  }
  async function getActiveScenario(): Promise<ActiveScenarioResult> {
    if (config.source === 'github') return { refused: true, reason: 'live mode' };
    return { refused: false, scenario: getActiveScenarioSummary() };
  }
  async function setScenario(id: ScenarioId): Promise<SetScenarioResult> {
    if (config.source === 'github') return { refused: true, reason: 'live mode' };
    if (!isScenarioId(id)) return { refused: true, reason: `unknown scenario: ${String(id)}` };
    const scenario = setActiveScenarioId(id);
    // Defect 2(b) fix (Checkpoint-6 maintainer review): persisted snapshots/
    // forecasts/controls are source-scoped ('msw') but scenario-BLIND, so
    // getLatestForecast/getLastSyncedControls would keep serving the PREVIOUS
    // world's rows after a switch (stale cross-scenario data shown as current).
    // Re-run the SAME ingestion syncNow already runs -- now that the active
    // scenario (and its clock as-of date) point at the new world, this rewrites
    // every 'msw'-sourced snapshot/forecast/control, so the latest-sync-wins
    // reads always match the active scenario. Fast (~sub-200ms against MSW) and
    // reuses the existing sync path -- NO new bridge surface. The audit-
    // provenance path (an apply stamps the latest 'msw' snapshot) stays
    // sensible: an apply after a switch references the NEW world's snapshot.
    await syncNow();
    return { refused: false, scenario };
  }

  // Task 6.8 (maintainer-ratified 2026-07-07): the Auto-balance screen's ONE
  // bridge addition. Runs the SAME assembly the engine-proof test
  // (msw/fixtures/scenarios.engine.test.ts) pins the 17 / 55,850-segment /
  // 12,800 / 532,800 literals against: fetchLiveControls + assembleUsageState
  // over the ACTIVE scenario's MSW world, plus that scenario's exported
  // projection + scalars (POOL/METERED_SCENARIO_INPUTS). The read surface's
  // existing shapes are provably lossy for this (see types.ts's DTO doc
  // comment), so this is assembled server-side; the renderer runs the pure
  // core engine over the returned context. SIM-ONLY -- refuses in live mode
  // before any fetch (same guard direction as the scenario methods above).
  // READ-ONLY: reads controls/usage; never mutates.
  // Live pool context (Auto-balance live-wiring round, 2026-07-09;
  // maintainer decision: BOTH modes' dry-run runs from live data, STRICTLY
  // SIMULATE-ONLY -- this path performs GETs + local-DB reads exclusively;
  // the screen's apply lever stays the Phase-7-gated disabled stub). Sources:
  //   controls        -> fetchLiveControls (live-proven)
  //   currentUsage    -> assembleUsageState (live-shaped, item-23 machinery)
  //   pool scalars    -> the persisted, MODE-SCOPED enterprise forecast
  //                      (item 24): allowanceLine at the as-of day =
  //                      poolTotalCredits; p50/p90Cumulative at cycle end =
  //                      the projections. Honest gates when the forecast is
  //                      absent (never synced) or stale (series doesn't cover
  //                      today) -- never fabricated numbers.
  //   poolConsumed    -> MTD pool credits from the R5 fan-out (cycle-month,
  //                      AI-credit rows, per-item cent rounding -- the exact
  //                      burn-down rule).
  //   projectedUsage  -> mirrors currentUsage (no live per-entity growth
  //                      projection exists yet -- the documented "no growth"
  //                      contract sim's healthy scenario also uses; FLAGGED).
  async function buildLivePoolContext(): Promise<RebalanceContextResult> {
    const forecast = readLatestForecast(config.db, 'github', 'enterprise');
    if (!forecast) {
      return {
        available: false,
        reason: 'no synced live data yet — run Sync now first, then the pool dry-run runs from your real forecast',
      };
    }
    const asOfDate = currentDate();
    const asOfPoint = forecast.result.dailySeries.find((p) => p.date === asOfDate);
    if (!asOfPoint) {
      return {
        available: false,
        reason: `the last synced forecast (computed ${forecast.computedAt}) does not cover today — run Sync now to refresh it`,
      };
    }

    const live = await fetchLiveControls(octokit, enterprise, currentDateObj());
    const currentUsage = await assembleUsageState(octokit, enterprise, live.costCenterIdByName, currentDateObj());

    const usageItems = await fetchUsageFanout(octokit, enterprise, [...live.costCenterIdByName.values()]);
    const cycleMonth = asOfDate.slice(0, 7);
    let poolConsumedCredits = 0;
    for (const item of aiCreditItems(usageItems)) {
      if (item.date.slice(0, 7) !== cycleMonth) continue;
      poolConsumedCredits += poolCreditsForItem(item);
    }

    // Cycle end = the last day of the as-of calendar month (a cycle IS a
    // calendar month); projections read from the stored series at that day
    // (the 90-day horizon always covers it; the last point is the defensive
    // fallback).
    const asOf = currentDateObj();
    const cycleEndDate = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const endPoint = forecast.result.dailySeries.find((p) => p.date === cycleEndDate) ?? forecast.result.dailySeries.at(-1);

    return {
      available: true,
      mode: 'pool',
      context: {
        controls: live.controls,
        currentUsage,
        projectedUsage: currentUsage,
        poolTotalCredits: asOfPoint.allowanceLine,
        poolConsumedCredits,
        projectedPoolConsumedCredits: Math.round(endPoint?.p50Cumulative ?? poolConsumedCredits),
        projectedPoolConsumedP90Credits: Math.round(endPoint?.p90Cumulative ?? poolConsumedCredits),
        asOfDate,
        cycleEndDate,
      },
    };
  }

  // Live metered context: needs NO persisted forecast (controls + usage are
  // direct live reads), so it carries no Sync gate. The at-risk candidate
  // set -- sim scenarios curate it by hand -- is derived from the live
  // control estate: every cost center holding a cost_center spending limit,
  // plus every user holding an individual ULB (the two entity kinds the
  // metered engine can actually move headroom between). meteredPhaseActive =
  // any in-cycle enterprise metered spend (the maintainer's world: ~103% of
  // the $1,000 enterprise budget).
  //
  // reserveCredits = 0 -- VALIDATOR RULING (2026-07-09): CLAUDE.md §9 Q5 WAS
  // answered 2026-07-07 (approval-gated per run / 5% reserve /
  // revert-at-reset), and the POOL path already honors that 5%: core's
  // runPoolRebalancer defaults reservePct to 0.05 of poolTotalCredits when no
  // params are supplied (buildLivePoolContext supplies none). The METERED
  // engine, however, takes only an ABSOLUTE reserveCredits (core defines no
  // percent semantics for it -- DEFAULT_RESERVE_CREDITS = 0), so "5% of
  // WHAT" -- the enterprise budget amount? its remaining headroom? -- is
  // genuinely ambiguous, and guessing would silently mis-size grant capacity.
  // 0 stays until Task 7.2's policy store defines the metered reserve
  // explicitly, with the recorded 5% as its named default candidate.
  async function buildLiveMeteredContext(): Promise<RebalanceContextResult> {
    const live = await fetchLiveControls(octokit, enterprise, currentDateObj());
    const currentUsage = await assembleUsageState(octokit, enterprise, live.costCenterIdByName, currentDateObj());

    const entities: EntityRef[] = [];
    const seenCostCenters = new Set<string>();
    for (const control of live.controls) {
      if (control.kind !== 'budget') continue;
      if (control.scope === 'cost_center' && !seenCostCenters.has(control.entityName)) {
        seenCostCenters.add(control.entityName);
        entities.push({ kind: 'cost_center', costCenterName: control.entityName });
      } else if (control.scope === 'individual') {
        const user = currentUsage.users.find((u) => u.userLogin === control.entityName);
        entities.push({ kind: 'user', userLogin: control.entityName, costCenterName: user?.costCenterName ?? null });
      }
    }

    return {
      available: true,
      mode: 'metered',
      context: {
        controls: live.controls,
        currentUsage,
        projectedUsage: currentUsage,
        entities,
        meteredPhaseActive: currentUsage.enterprise.meteredCreditsUsed > 0,
        reserveCredits: 0,
      },
    };
  }

  async function getRebalanceContext(mode: 'pool' | 'metered'): Promise<RebalanceContextResult> {
    if (config.source === 'github') {
      return mode === 'pool' ? buildLivePoolContext() : buildLiveMeteredContext();
    }
    const scenarioId = getActiveScenarioSummary().id;

    if (mode === 'pool') {
      const inputs = POOL_SCENARIO_INPUTS[scenarioId];
      if (!inputs) {
        return { available: false, reason: `the active scenario ("${scenarioId}") carries no pool-rebalancer inputs` };
      }
      const live = await fetchLiveControls(octokit, enterprise, currentDateObj());
      const currentUsage = await assembleUsageState(octokit, enterprise, live.costCenterIdByName, currentDateObj());
      return {
        available: true,
        mode: 'pool',
        context: {
          controls: live.controls,
          currentUsage,
          // null = the scenario projects no growth -> mirror the assembled
          // current state (PoolScenarioInputs's documented contract).
          projectedUsage: inputs.projectedUsage ?? currentUsage,
          poolTotalCredits: inputs.poolTotalCredits,
          poolConsumedCredits: inputs.poolConsumedCredits,
          projectedPoolConsumedCredits: inputs.projectedPoolConsumedCredits,
          projectedPoolConsumedP90Credits: inputs.projectedPoolConsumedP90Credits,
          asOfDate: currentDate(),
          cycleEndDate: inputs.cycleEndDate,
        },
      };
    }

    const inputs = METERED_SCENARIO_INPUTS[scenarioId];
    if (!inputs) {
      return { available: false, reason: `the active scenario ("${scenarioId}") carries no metered-rebalancer inputs` };
    }
    const live = await fetchLiveControls(octokit, enterprise, currentDateObj());
    const currentUsage = await assembleUsageState(octokit, enterprise, live.costCenterIdByName, currentDateObj());
    return {
      available: true,
      mode: 'metered',
      context: {
        controls: live.controls,
        currentUsage,
        projectedUsage: inputs.projectedUsage,
        entities: [...inputs.entities],
        meteredPhaseActive: inputs.meteredPhaseActive,
        reserveCredits: inputs.reserveCredits,
      },
    };
  }

  return {
    getUsageSummary,
    listCostCenters,
    updateCostCenterMapping,
    getAppModeSetting,
    setAppModeSetting,
    getWriteArmingState,
    setWriteArming,
    listHeavyUsers,
    getUsageDistribution,
    getUserMonthObservations,
    listAlerts,
    getSyncStatus,
    syncNow,
    getControls,
    getLastSyncedControls,
    getForecast,
    dryRunPlan,
    applyPlan,
    getAuditChain,
    verifyAuditChain,
    getTenantConfig,
    setTenantConfig,
    validatePat,
    runLiveReadSmoke,
    listScenarios,
    getActiveScenario,
    setScenario,
    getRebalanceContext,
  };
}
