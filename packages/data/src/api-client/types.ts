import type { AuditChainVerification, ControlState, EffectiveUlb, ForecastResult, ModelMix, Plan } from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult } from '../write/engine.js';
import type { ForecastScope, StoredForecast } from '../sync/sync-now.js';

// Re-exported so a consumer that only depends on '@copilot-budget/data' (per
// CLAUDE.md's portability boundary -- apps/desktop's package.json depends on
// data, not core directly) can name these types without an extra dependency.
// All type-only (isolatedModules erases these imports at compile time), so
// this adds no runtime footprint to the pure barrel despite write/engine.ts
// itself importing Octokit/drizzle/node:util.
export type { ApplyPlanResult, AuditChainVerification, ControlState, DryRunResult, ForecastResult, ForecastScope, Plan, StoredForecast };

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
  dewrDivision: string; // DEWR mapping is columns on the cost-center row (PLAN.md Architecture Decisions)
  dewrBranch: string;
  dewrProject: string;
  mtdBurnCredits: number; // per-CC cycle-to-date credit total (pool + metered)
  includedUsageCap: IncludedUsageCap;
  excludedFromEnterpriseBudget: boolean;
  members: CostCenterMemberSummary[];
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
}
