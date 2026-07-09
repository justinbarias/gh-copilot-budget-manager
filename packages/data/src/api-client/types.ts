import type { AuditChainVerification, ControlState, EffectiveUlb, EntityRef, ForecastResult, ModelMix, Plan, UsageState } from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult } from '../write/engine.js';
import type { ForecastScope, StoredForecast } from '../sync/sync-now.js';
import type { TenantConfig } from '../tenant/types.js';
import type { ReadSmokeEndpointResult } from '../smoke/read-smoke.js';

// Re-exported so a consumer that only depends on '@copilot-budget/data' (per
// CLAUDE.md's portability boundary -- apps/desktop's package.json depends on
// data, not core directly) can name these types without an extra dependency.
// All type-only (isolatedModules erases these imports at compile time), so
// this adds no runtime footprint to the pure barrel despite write/engine.ts
// itself importing Octokit/drizzle/node:util.
export type { ApplyPlanResult, AuditChainVerification, ControlState, DryRunResult, ForecastResult, ForecastScope, Plan, StoredForecast };
// Task 9.1: the tenant pointer type crosses the ApiClient boundary
// (getTenantConfig/setTenantConfig), so re-export it here the same way the
// forecast/plan types above are -- a UI consumer depending only on
// '@copilot-budget/data' can then name it without importing the './tenant'
// subpath (which pulls node:fs) directly.
export type { TenantConfig };
export type { ReadSmokeEndpointResult, ReadSmokeStatus } from '../smoke/read-smoke.js';

// Task 6.7: the sim-mode scenario selector's cross-boundary types. Re-exported
// so a UI consumer depending only on '@copilot-budget/data' can name them
// without importing the msw subpath. Type-only (erased at compile time).
export type { ScenarioId, ScenarioSummary } from '../msw/scenario-state.js';
import type { ScenarioId, ScenarioSummary } from '../msw/scenario-state.js';

/**
 * Task 6.7: scenarios are a SIMULATION-ONLY affordance (they drive the MSW
 * fixture world). All three scenario methods REFUSE in live mode -- mirroring
 * runLiveReadSmoke's `{ refused, reason }` shape but with the guard inverted
 * (`'live mode'` instead of `'simulation mode'`), since a scenario has no
 * meaning against a real tenant.
 */
export type ListScenariosResult =
  | { refused: true; reason: string }
  | { refused: false; scenarios: ScenarioSummary[]; activeId: ScenarioId };
export type ActiveScenarioResult =
  | { refused: true; reason: string }
  | { refused: false; scenario: ScenarioSummary };
export type SetScenarioResult =
  | { refused: true; reason: string }
  | { refused: false; scenario: ScenarioSummary };

/**
 * Task 6.8 (maintainer-ratified 2026-07-07): the Auto-balance screen's ONE
 * bridge addition. The renderer cannot faithfully assemble a rebalancer
 * context itself -- the read surface's shapes are lossy for this purpose
 * (listHeavyUsers carries only a TOTAL per user, no pool/metered split;
 * listCostCenters folds pool+metered into one mtdBurnCredits; and the
 * scenario's projection + pool scalars are packages/data fixture internals
 * with no bridge surface at all). getRebalanceContext therefore runs the
 * SAME server-side assembly the engine-proof test (scenarios.engine.test.ts)
 * proves the literals against -- fetchLiveControls + assembleUsageState +
 * the active scenario's exported POOL/METERED_SCENARIO_INPUTS -- and hands
 * the renderer a serializable context. The renderer then runs the PURE core
 * engine (runPoolRebalancer / computeFundingEnvelope / simulatePoolRebalance)
 * locally, so grant edits recompute live without an IPC round-trip.
 *
 * SIM-ONLY: refuses in live mode (`{ available: false, reason: 'live mode' }`,
 * the mirror image of runLiveReadSmoke's guard, same as the scenario methods)
 * -- in live mode the projection must come from a real forecast run, which is
 * later work. Dates cross the boundary as ISO YYYY-MM-DD strings (the same
 * convention as UsageSummary.cycleAsOfDate); the renderer rehydrates them
 * with `new Date(`${s}T00:00:00.000Z`)` before calling core.
 */
export interface PoolRebalanceContextDto {
  controls: ControlState[];
  /** Cycle-to-date usage, assembled server-side (assembleUsageState's two-report reconciliation). */
  currentUsage: UsageState;
  /** Forecast end-of-cycle usage per entity (the scenario's authored projection; mirrors currentUsage when the scenario projects no growth). */
  projectedUsage: UsageState;
  poolTotalCredits: number;
  poolConsumedCredits: number;
  projectedPoolConsumedCredits: number;
  projectedPoolConsumedP90Credits: number;
  /** YYYY-MM-DD -- the sim clock's active as-of date. */
  asOfDate: string;
  /** YYYY-MM-DD -- the pool trigger's near-cycle-end reference. */
  cycleEndDate: string;
}

/**
 * Task 6.8 (shape decided now; Task 6.9 consumes it): the metered-mode
 * counterpart, mirroring core's MeteredRebalanceInput minus nothing -- the
 * metered engine takes no Dates, so this DTO is already fully serializable.
 */
export interface MeteredRebalanceContextDto {
  controls: ControlState[];
  currentUsage: UsageState;
  projectedUsage: UsageState;
  /** The curated at-risk candidate entities (see METERED_SCENARIO_INPUTS's curation hazard note). */
  entities: EntityRef[];
  meteredPhaseActive: boolean;
  reserveCredits: number;
}

export type RebalanceContextResult =
  | { available: false; reason: string }
  | { available: true; mode: 'pool'; context: PoolRebalanceContextDto }
  | { available: true; mode: 'metered'; context: MeteredRebalanceContextDto };

/**
 * Task 9.1: the result of classifying the stored PAT against GitHub's
 * documented auth surface (validatePat). Classic PATs return an
 * `X-OAuth-Scopes` response header listing granted scopes; fine-grained tokens
 * (`github_pat_` prefix) do not carry it. `hasManageBillingEnterprise` gates
 * every enterprise billing endpoint (CLAUDE.md §4/§5 -- classic PAT with
 * `manage_billing:enterprise` is required; App/fine-grained tokens can't reach
 * them). `ok` is true only for a classic token that carries the scope.
 */
export interface PatValidation {
  ok: boolean;
  tokenKind: 'classic' | 'fine_grained' | 'invalid';
  scopes: string[];
  hasManageBillingEnterprise: boolean;
  message: string;
}

/**
 * Task 9.2-prep: the live read-surface smoke report. In simulation mode the
 * bridge REFUSES (never contacts GitHub) -> `{ refused: true, reason }`; in
 * live mode it runs and returns the per-endpoint reconciliation `results`
 * (docs/api-surface-validation.md rows R1-R6). `ranAt` is an ISO timestamp.
 */
export type ReadSmokeResult =
  | { refused: true; reason: string }
  | { refused: false; ranAt: string; results: ReadSmokeEndpointResult[] };

/**
 * Task 9.3-lite: the live-write arming state the Settings arming card + the
 * app-level banner read. `armed` is process-memory-only (write/arming.ts) and
 * is ALWAYS false in simulation mode -- arming is inert there (§6.8: sim never
 * issues real writes, so there is nothing to arm). `mode` tells the UI whether
 * the gate applies at all; `enterpriseSlug` is the confirmation phrase the
 * admin must type verbatim to arm (a slug is not a secret, so it can be shown
 * as a hint) -- null in simulation mode.
 */
export interface WriteArmingState {
  /** True only when live writes are currently permitted this process-session.
   *  ALWAYS false in simulation mode (arming is inert there). */
  armed: boolean;
  /** The enterprise slug the admin must type verbatim to arm (the confirmation
   *  phrase) -- so the UI can show the hint. null in simulation mode. */
  enterpriseSlug: string | null;
  /** Resolved mode context, so the UI knows the gate/arming applies only live. */
  mode: 'simulation' | 'live';
}

export interface WriteArmingRequest {
  action: 'arm' | 'disarm';
  /** Required for 'arm': must equal the enterprise slug EXACTLY. Ignored for 'disarm'. */
  confirmation?: string;
}

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
  /**
   * DEWR mapping -- an APP-LOCAL construct (maintainer decision, 2026-07-09
   * Cost Centers live-correctness round): live cost centers created outside
   * this app carry no mapping, so these are honestly nullable (the old
   * `string` annotation lied -- live rows rendered "undefined → undefined →
   * undefined"). Source precedence: the local DB columns (editable via
   * updateCostCenterMapping) win over the simulation fixtures' wire
   * enrichment; absent everywhere -> null -> the UI renders "— not mapped".
   */
  dewrDivision: string | null;
  dewrBranch: string | null;
  dewrProject: string | null;
  /** Per-CC cycle-to-date credit total (pool + metered) -- DERIVED from the R5 per-CC usage fan-out (cycle-month, AI-credit rows), never a wire enrichment; 0 when the CC has no usage rows (never NaN). */
  mtdBurnCredits: number;
  includedUsageCap: IncludedUsageCap;
  excludedFromEnterpriseBudget: boolean;
  members: CostCenterMemberSummary[];
}

/** updateCostCenterMapping's payload -- the three app-local DEWR columns; null clears a field. */
export interface CostCenterMappingInput {
  dewrDivision: string | null;
  dewrBranch: string | null;
  dewrProject: string | null;
}

export interface HeavyUserDailyPoint {
  date: string; // YYYY-MM-DD, one entry per day of the current cycle up to cycleAsOfDate
  creditsUsed: number; // that day's credits (not cumulative) -- feeds the Users screen sparkline
}

export interface HeavyUser {
  userId: string;
  userLogin: string;
  creditsUsed: number; // cycle-to-date, cycle-filtered the same way listCostCenters' member burn is
  // Display-only join to the user's cost-center membership (SPEC.md Assumption 4:
  // the Users screen never offers reassignment) -- null if unassigned to any cost center.
  costCenterName: string | null;
  // Cycle-to-date daily series, one point per day -- empty when creditsUsed is 0
  // (the Users screen renders a "no usage yet this cycle" placeholder instead of a chart).
  dailySeries: HeavyUserDailyPoint[];
  modelMix: ModelMix; // best-effort per-model attribution, always includes the explicit unattributable remainder
  // Precedence-resolved per CLAUDE.md §5 (individual > cost-center CCULB > universal);
  // null only if no ULB exists at any scope for this user.
  effectiveUlb: EffectiveUlb | null;
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
  /**
   * Trailing-gap surface (maintainer-approved optional extension, 2026-07-08):
   * the last cycle day whose per-user report (users-1-day) actually existed in
   * the most recent Sync THIS process performed. Live, a Sync run before
   * GitHub generates today's report legitimately skips up to the last 2 cycle
   * days (see users-report.ts's trailing-gap tolerance) -- this field is how
   * that coverage edge is surfaced honestly instead of implying the per-user
   * totals run through the as-of day. ABSENT (not null) when no Sync has run
   * in this process yet: the value is process-lifetime state, not persisted
   * (no schema change was sanctioned), so a restart honestly reports
   * "unknown" rather than a guessed coverage day. In simulation the mock
   * serves the as-of day, so this always equals the clock seam's as-of date
   * after a sync.
   */
  perUserDataThroughDay?: string;
}

/**
 * Task 4.15: the Controls screen's "last synced" baseline for browse-time
 * drift detection -- the control state as of the last explicit Sync Now,
 * persisted append-only (schema.ts's control_snapshot). Null exactly when no
 * sync has ever run (nothing to compare against yet); `capturedAt` is an ISO
 * string, matching SyncStatus.lastSyncedAt's convention across this boundary.
 */
export interface LastSyncedControls {
  capturedAt: string;
  controls: ControlState[];
}

/**
 * Task 8.4/8.5: one row of the append-only, hash-chained audit log
 * (packages/core/src/auditChain.ts's chain math; packages/data/src/audit/writer.ts's
 * storage), projected for the Audit screen + its export/verify surface.
 * Ascending-by-id is the chain's real append order (readAuditChain's own
 * contract) -- `getAuditChain()` always returns the FULL chain in that order;
 * the Audit screen re-sorts newest-first for display and derives per-row
 * "chain intact" indicators from a single `verifyAuditChain()` call's
 * failedAtIndex against this same ascending order (see the Task 8.4/8.5
 * build report for the full rationale).
 *
 * `envelopeSnapshot`/`before`/`after` are deliberately carried as the EXACT
 * strings `appendAuditEvent` originally stored -- NOT `JSON.parse`d back into
 * objects the way `AppliedAuditEvent` above does for renderer convenience.
 * `canonicalizeAuditPayload` hashes those exact stored bytes; re-serializing
 * a parsed object could reorder keys or change whitespace and silently stop
 * matching the recorded hash. The Audit screen parses these ONLY for
 * display; the JSON/CSV export helpers re-emit them verbatim, which is what
 * makes an export independently re-verifiable offline (Task 8.5).
 */
export interface AuditChainEvent {
  id: number;
  /** ISO 8601. `Date.parse(ts)` recovers the exact epoch-ms value that was hashed (see AuditEventFields's `ts` doc comment) -- unlike before/after, this round-trip is lossless. */
  ts: string;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  envelopeSnapshot: string | null;
  before: string | null;
  after: string | null;
  justification: string | null;
  dataSnapshotId: number | null;
  prevHash: string;
  hash: string;
}

export interface ApplyPlanInput {
  /**
   * Attributed actor for the audit log (CLAUDE.md §6.5). No admin
   * login/identity system exists yet (CLAUDE.md §9 is still open) -- the
   * renderer supplies whatever it currently has (a Settings-configured name,
   * or a placeholder) until that's answered.
   */
  actor: string;
  /**
   * Required, logged justification (CLAUDE.md §6.3) when the plan turns off
   * a hard stop (validatePlan's alert_only_without_hard_stop warning) --
   * applied as a single blanket justification across every entry in the
   * plan, matching the Controls rail's one-textarea confirm dialog. Omit/null
   * when no such warning applies; the write engine never requires it.
   */
  justification?: string | null;
}

// Phase 4 (implemented here): getControls/dryRunPlan/applyPlan --
// getControls is also the write engine's own re-read (CLAUDE.md §6.2), so
// the UI diffs its staged plan against the exact same live projection the
// engine re-diffs against at apply time. dryRunPlan/applyPlan never accept a
// caller-supplied live/current Plan for the *comparison* -- only the
// caller's desired end-state; the "did live move" comparison is always
// computed server-side, fresh, both in preview and at apply.
//
// Task 4.15 adds getLastSyncedControls -- the ONE bridge/ApiClient addition
// this task makes (see packages/data/src/sync/sync-now.ts's doc comments and
// the Task 4.15 build report's migration-review packet for the full
// rationale): there is no existing read surface that can hand the renderer
// the persisted "last synced" control snapshot getControls() itself never
// carries (it only ever reads LIVE). PLAN.md's own architecture note ("each
// phase... one ApiClient/bridge-extension task") anticipates exactly one
// such addition per phase; this is Phase 4's.
//
// Reserved (documented now, NOT implemented by this task -- naming ratified
// at Checkpoint 4a; see that review packet for the full Phase 4-8 proposal):
//   Phase 7: applyGrants(envelope): Promise<GrantResult>; revertGrant(grantId): Promise<void>;
//            listGrants(): Promise<Grant[]>; getRebalancerPolicy()/setRebalancerPolicy(policy)
export interface ApiClient {
  getUsageSummary(params?: UsageSummaryParams): Promise<UsageSummary>;
  listCostCenters(): Promise<CostCenterSummary[]>;
  /**
   * Maintainer-sanctioned addition (2026-07-09 Cost Centers live-correctness
   * round -- the ONE new method): edits a cost center's app-local DEWR
   * mapping. This is LOCAL DB METADATA ONLY -- it never issues a GitHub
   * request (safe pre-9.3, works identically in both modes), which a test
   * asserts. The row is upserted, so a mapping saved before the first Sync
   * survives it (syncNow's cost-center upsert only touches name/state).
   */
  updateCostCenterMapping(costCenterId: string, mapping: CostCenterMappingInput): Promise<void>;
  /**
   * Task 9.3-lite SANCTIONED ADDITIONS (2026-07-09, maintainer-locked
   * decisions: in-app mode toggle + live-write arming; RBAC-lite deferred
   * indefinitely; one PAT, no read/write token separation).
   *
   * getAppModeSetting/setAppModeSetting: the PERSISTED mode selection
   * (app_settings 'app_mode') -- the in-app toggle that retired the
   * COPILOT_BUDGET_FORCE_SIMULATION env seam. Setting it does NOT re-resolve
   * the running process's mode (relaunch-required mechanic; the Settings card
   * says "restart to apply"); resolution itself stays resolveMode's job
   * (selection === 'live' AND a stored PAT -> live).
   */
  getAppModeSetting(): Promise<'simulation' | 'live'>;
  setAppModeSetting(mode: 'simulation' | 'live'): Promise<void>;
  /**
   * Live-write arming (Task 9.3-lite). The armed flag lives in MAIN-PROCESS
   * MEMORY ONLY -- deliberately never persisted, so a relaunch disarms by
   * construction. Arming requires the typed confirmation to equal the
   * ENTERPRISE SLUG exactly (validated main-side against the client's own
   * enterprise -- the renderer only ever supplies what the admin typed);
   * a mismatch rejects and does not arm. In simulation mode arming is inert
   * (always resolves { armed: false }): the gate exists for real GitHub
   * writes, and sim applies stay fully functional + visibly simulated
   * (§6.8). Disarming never needs confirmation.
   */
  getWriteArmingState(): Promise<WriteArmingState>;
  setWriteArming(request: WriteArmingRequest): Promise<WriteArmingState>;
  listHeavyUsers(): Promise<HeavyUser[]>;
  listAlerts(): Promise<Alert[]>;
  getSyncStatus(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  /** The current live control state (ULBs + included-usage caps) -- the Controls screen's "live" side of the diff. */
  getControls(): Promise<ControlState[]>;
  /**
   * Task 4.15: the control state as of the last explicit Sync Now (persisted,
   * append-only) -- the Controls screen's "last synced" reference for
   * browse-time drift markers ("⤺ drift — reconcile"), fed alongside a fresh
   * getControls() into core's driftedControlIds. Null if no sync has ever run.
   */
  getLastSyncedControls(): Promise<LastSyncedControls | null>;
  /**
   * Task 5.4: the latest forecast persisted for this scope (+entity),
   * computed at the end of the most recent `syncNow` that produced one
   * (packages/data/src/forecast/compute.ts, wired into
   * packages/data/src/sync/sync-now.ts's append-only `forecast` table).
   * `entityId` is required for 'cost_center'/'user' (a cost-center id / user
   * id respectively) and omitted for 'enterprise' (the enterprise scope has
   * no entity). Null if no sync has ever run.
   */
  getForecast(scope: ForecastScope, entityId?: string): Promise<StoredForecast | null>;
  /** Simulate-before-apply preview (CLAUDE.md §6.1): re-reads live, diffs against `desiredControls`, validates, and simulates who newly blocks/unblocks. Never mutates. */
  dryRunPlan(desiredControls: readonly ControlState[], justification?: string | null): Promise<DryRunResult>;
  /**
   * Re-reads live, re-diffs against `desiredControls`, and aborts as drift if
   * that doesn't match `stagedPlan` (CLAUDE.md §6.2) -- otherwise validates,
   * mutates, and audits. `stagedPlan` is the Plan the caller already
   * confirmed via dryRunPlan (or hand-built the same way); it is NEVER
   * trusted as the source of truth for what to apply, only as the drift
   * baseline to compare a fresh server-side diff against.
   */
  applyPlan(stagedPlan: Plan, desiredControls: readonly ControlState[], input: ApplyPlanInput): Promise<ApplyPlanResult>;
  /**
   * Task 8.4: the Audit screen's sole read surface -- the FULL stored chain
   * (readAuditChain's ascending-by-id order), never paged. Chosen over
   * pagination because (a) `verifyAuditChain` below already has to walk the
   * entire chain to verify it, so a paged read would let the screen show a
   * "verified" indicator on rows it hasn't actually fetched; (b) Task 8.5's
   * export must be a complete dump regardless, so the read and export paths
   * would otherwise need two different fetch strategies; and (c) this is a
   * local, single-admin desktop tool's audit log, not a multi-tenant SaaS
   * table -- realistic chain sizes (dozens to low hundreds of events per
   * install) never justify the complexity. Revisit if a real deployment's
   * chain grows large enough to make a full fetch slow.
   */
  getAuditChain(): Promise<AuditChainEvent[]>;
  /**
   * Task 8.5: re-verifies the stored hash chain in the MAIN process, directly
   * against the raw SQLite rows (packages/data/src/audit/writer.ts's
   * `verifyStoredChain`, which reuses packages/core's `verifyAuditChain` +
   * the real SHA-256 primitive) -- never trusts a renderer-supplied chain.
   * `{ ok: true }`, or `{ ok: false, failedAtIndex, reason }` pinpointing the
   * first broken/tampered row (ascending-by-id index, matching
   * `getAuditChain()`'s order).
   */
  verifyAuditChain(): Promise<AuditChainVerification>;
  /**
   * Task 9.1: the persisted, non-secret tenant pointer (host + enterprise
   * slug) the GitHub client derives its baseUrl and enterprise paths from in
   * live mode. Null when never configured. Not a secret (unlike the PAT), so
   * it is stored as plain JSON via the main process, NOT safeStorage.
   */
  getTenantConfig(): Promise<TenantConfig | null>;
  /** Task 9.1: persist the tenant pointer (validated -- rejects an empty slug or a ghe.com host with no subdomain). */
  setTenantConfig(config: TenantConfig): Promise<void>;
  /**
   * Task 9.1: classify the stored PAT against GitHub's documented auth surface
   * (classic vs fine-grained, and whether `manage_billing:enterprise` is
   * granted) by reading the X-OAuth-Scopes header off a cheap probe. Runs in
   * BOTH modes (the probe hits MSW in simulation), so an admin can sanity-check
   * a token before switching to live.
   */
  validatePat(): Promise<PatValidation>;
  /**
   * Task 9.2-prep: run the live read-surface smoke (per-endpoint shape
   * reconciliation, §6.9 rows R1-R6). REFUSES in simulation mode
   * (`{ refused: true, reason: 'simulation mode' }`) -- it never contacts
   * GitHub there (CLAUDE.md §6.8/§8). In live mode it returns the report that
   * becomes the Task 9.2 work order.
   */
  runLiveReadSmoke(): Promise<ReadSmokeResult>;
  /**
   * Task 6.7: the simulation demo scenarios (Healthy / At risk / Surplus /
   * Metered) + which is active. REFUSES in live mode (`{ refused: true, reason:
   * 'live mode' }`). The top-bar scenario selector (sim-mode-only) renders this.
   */
  listScenarios(): Promise<ListScenariosResult>;
  /** Task 6.7: the currently active scenario's summary (nav badge source). REFUSES in live mode. */
  getActiveScenario(): Promise<ActiveScenarioResult>;
  /**
   * Task 6.7: switch the active scenario -- re-seeds MSW + re-anchors the sim
   * clock deterministically (in-memory; resets to 'healthy' on relaunch).
   * REFUSES in live mode. Returns the now-active scenario.
   */
  setScenario(id: ScenarioId): Promise<SetScenarioResult>;
  /**
   * Task 6.8 (maintainer-ratified 2026-07-07): assemble the Auto-balance
   * screen's rebalancer context server-side (the same assembly the
   * engine-proof test pins its literals against) and hand it to the renderer,
   * which runs the pure core engine locally. SIM-ONLY (refuses in live mode);
   * also unavailable when the active scenario carries no inputs for the
   * requested mode (e.g. `mode: 'pool'` on the metered scenario). READ-ONLY:
   * this method cannot mutate anything, and the dry-run-only Auto-balance
   * screen (Checkpoint 6) has no other bridge surface.
   */
  getRebalanceContext(mode: 'pool' | 'metered'): Promise<RebalanceContextResult>;
}
