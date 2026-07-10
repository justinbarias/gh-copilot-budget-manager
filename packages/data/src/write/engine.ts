import { isDeepStrictEqual } from 'node:util';
import type { Octokit } from 'octokit';
import { desc, eq } from 'drizzle-orm';
import {
  applyPlanToControls,
  controlIdentity,
  creditsToUsd,
  diffControls,
  simulatePlan,
  validatePlan,
  type AlertOnlyOverrideInput,
  type BudgetFieldChange,
  type CapFieldChange,
  type ControlState,
  type CostCenterFieldChange,
  type Plan,
  type PlanEntry,
  type SimulationResult,
  type UserLicenseContext,
  type ValidationResult,
} from '@copilot-budget/core';
import { appendAuditEvent, type AppendAuditEventInput, type AuditEventRow } from '../audit/writer.js';
import { AI_CREDITS_BUDGET_SKU, internalBudgetIdentityToWire, type InternalBudgetScope } from '../api-client/budget-scope.js';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import { assembleUsageState, fetchLiveControls, type LiveControlsResult } from './live-state.js';
import { isWriteArmed } from './arming.js';

// CLAUDE.md §6.1/§6.2/§6.5 -- the "one write-path engine, two callers"
// pipeline (PLAN.md Architecture Decisions): manual writes (Phase 4, this
// task) and rebalancer applies (Phase 7) share applyPlan's
// re-read -> diff -> validate -> mutate -> audit sequence. dryRunPlan is the
// simulate-before-apply preview both callers run first.

// --- dryRunPlan --------------------------------------------------------------

export interface DryRunPlanOptions {
  enterprise: string;
  octokit: Octokit;
  asOfDate: Date;
  users?: readonly UserLicenseContext[];
  nearZeroUlbThresholdCredits?: number;
  /**
   * Same blanket-justification convention as ApplyPlanOptions.justification
   * (symmetric signatures -- dryRunPlan is apply's preview, not a
   * differently-shaped operation): a caller previewing "does supplying a
   * justification clear the alert-only warning" passes the same string
   * they'd pass to applyPlan.
   */
  justification?: string | null;
}

export interface DryRunResult {
  /** Freshly computed against a live re-read -- always current, never trusts a client-supplied plan. */
  plan: Plan;
  validation: ValidationResult;
  simulation: SimulationResult;
}

function buildAlertOnlyOverrides(plan: Plan, justification: string | null | undefined): AlertOnlyOverrideInput[] {
  if (justification == null || justification.trim().length === 0) return [];
  return plan.entries.map((entry) => ({ controlId: entry.id, justification }));
}

// Never takes a caller-supplied Plan as input -- only the caller's desired
// end-state (`desiredControls`). The plan itself (live vs. desired) is always
// computed fresh here, from a live re-read, exactly like applyPlan's own
// re-diff -- so a dry run can never go stale relative to what apply will
// actually compare against.
export async function dryRunPlan(desiredControls: readonly ControlState[], options: DryRunPlanOptions): Promise<DryRunResult> {
  const live = await fetchLiveControls(options.octokit, options.enterprise, options.asOfDate);
  const plan = diffControls(live.controls, desiredControls);

  const validation = validatePlan(plan, {
    live: live.controls,
    users: options.users,
    nearZeroUlbThresholdCredits: options.nearZeroUlbThresholdCredits,
    alertOnlyOverrides: buildAlertOnlyOverrides(plan, options.justification),
  });

  // Usage assembly is dryRunPlan-only (see live-state.ts's assembleUsageState
  // doc comment) -- applyPlan below never calls this, keeping the
  // money-critical apply path independent of usage-aggregation correctness.
  const usageState = await assembleUsageState(options.octokit, options.enterprise, live.costCenterIdByName, options.asOfDate);
  const simulation = simulatePlan(plan, usageState, live.controls, options.asOfDate);

  return { plan, validation, simulation };
}

// --- applyPlan ---------------------------------------------------------------

export interface ApplyPlanOptions {
  enterprise: string;
  octokit: Octokit;
  db: Db;
  /**
   * Who to attribute this apply to in the audit log (CLAUDE.md §6.5:
   * "every ... applied change records actor"). No login/identity system
   * exists yet (CLAUDE.md §9 is still open) -- callers pass a plain string;
   * the renderer's Settings-configured admin name, or a placeholder, until
   * that's answered.
   */
  actor: string;
  /** The caller's full desired end-state -- re-diffed against a fresh live read (see driftCheck below). */
  desiredControls: readonly ControlState[];
  /**
   * Single blanket justification applied to every plan entry's
   * alert-only-without-hard-stop override, matching the Controls rail's
   * single confirm-dialog textarea (design brief) -- CLAUDE.md §6.3's
   * "explicit, logged override" is satisfied per-apply, not per-control.
   */
  justification?: string | null;
  /** 'manual' for every Phase-4 apply (this task); Phase 6/7 rebalancer applies pass their own trigger. */
  trigger?: string;
  /**
   * The clock-seam as-of date (api-client/clock.ts): the deterministic fixture
   * "now" in simulation, the real wall clock in live mode. Threaded through for
   * signature symmetry with DryRunPlanOptions (apply is dry-run's counterpart)
   * and forward-compat -- applyPlan's live re-read (fetchLiveControls) is a
   * point-in-time control read, not cycle-windowed, so it does not consume this
   * today (unlike dryRunPlan, whose usage assembly + simulation genuinely
   * anchor to it).
   */
  asOfDate: Date;
  users?: readonly UserLicenseContext[];
  nearZeroUlbThresholdCredits?: number;
  /**
   * The SAME 'msw' | 'github' flag github-impl.ts's clock seam
   * (resolveClockDate) and the source-scoped reads (getLastSyncedControls,
   * getLatestForecast) already key off -- not a second mode flag. Required
   * (not optional/defaulted) so no caller can silently fall back to the old
   * mode-blind behaviour: latestSnapshotId below filters to snapshots of
   * THIS source, so an applied change's audit `dataSnapshotId` (CLAUDE.md
   * §6.5's "the data snapshot it was based on") always names a snapshot that
   * genuinely came from the same source as this apply, never a same-DB
   * snapshot from the other mode (the DB is mixed-mode in steady state --
   * no purge exists by design, see docs/pending/todo.md's deferred-items
   * note).
   */
  source: 'msw' | 'github';
}

export interface MutationLogEntry {
  planEntryId: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  /** The fully-resolved request URL (Octokit response.url), for the caller/e2e to assert the correct endpoint was hit. */
  path: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
}

// Audit rows projected for the ApiClient boundary: `ts` becomes an ISO
// string (JSON-boundary convention this package already uses for
// SyncStatus/Alert timestamps) instead of writer.ts's internal `Date`;
// before/after/envelopeSnapshot are parsed back to plain values instead of
// pre-serialized JSON strings, since a preload/IPC/renderer caller has no
// use for (and shouldn't need to JSON.parse) the storage encoding.
export interface AppliedAuditEvent {
  id: number;
  ts: string;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  envelopeSnapshot: unknown;
  before: unknown;
  after: unknown;
  justification: string | null;
  dataSnapshotId: number | null;
}

export type ApplyPlanResult =
  // CLAUDE.md §6.2: live moved since the plan was staged. Nothing is
  // mutated, nothing is audited -- the caller re-stages against `currentPlan`
  // (the design rail's "⤺ drift -- reconcile" surface).
  | { status: 'drift'; stagedPlan: Plan; currentPlan: Plan }
  // CLAUDE.md §6.4: a hard blocker (e.g. enterprise-cap-below-cost-center-sum)
  // fired against the post-plan state. Nothing is mutated, nothing is audited.
  | { status: 'blocked'; validation: ValidationResult }
  | {
      status: 'applied';
      appliedCount: number;
      mutationLog: readonly MutationLogEntry[];
      auditEvents: readonly AppliedAuditEvent[];
      validation: ValidationResult;
    }
  // A mutation request itself failed partway through the plan (e.g. a 5xx or
  // an unexpected 4xx from GitHub). Entries before the failure ARE applied
  // and ARE audited (their mutation requests genuinely succeeded against
  // live GitHub) -- there is no rollback, since undoing an already-accepted
  // GitHub mutation is itself a further write this engine has no special
  // authority to make unilaterally. The caller sees exactly how far it got
  // and can re-run (the pipeline's re-read -> re-diff will then only replay
  // whatever's left).
  | {
      status: 'partial_failure';
      appliedCount: number;
      mutationLog: readonly MutationLogEntry[];
      auditEvents: readonly AppliedAuditEvent[];
      failedPlanEntryId: string;
      errorMessage: string;
    }
  // Live writes are DISARMED (Task 9.3-lite §6.8 safety gate): nothing was
  // read, mutated, or audited. The caller must arm live writes (Settings)
  // before applying. NEVER returned in simulation (source 'msw' is never gated).
  | { status: 'not_armed'; enterpriseSlug: string };

// Mode-scoped (CLAUDE.md §6.5 / §6.8, following the same fix
// getLastSyncedControls/getLatestForecast already applied to the read side,
// docs/pending/todo.md's "Audit provenance mode-scoping" deferred item):
// filters to snapshots of THIS source only. Without the filter this picked
// the max-id snapshot across BOTH 'msw' and 'github' generations, so a live
// apply in the (by-design, unpurged) mixed-mode DB could stamp an MSW
// snapshot id as its audit event's compliance-log data basis whenever the
// newest snapshot happened to be a simulation sync. Returns null (rather
// than falling back to a wrong-source id) when no snapshot of `source`
// exists yet -- a null data basis is honest; a same-DB-but-wrong-mode one is
// not (see applyPlan's zero-github-snapshots case).
function latestSnapshotId(db: Db, source: 'msw' | 'github'): number | null {
  const latest = db
    .select({ id: schema.snapshot.id })
    .from(schema.snapshot)
    .where(eq(schema.snapshot.source, source))
    .orderBy(desc(schema.snapshot.id))
    .limit(1)
    .all()[0];
  return latest ? latest.id : null;
}

function budgetPatchBody(changes: readonly BudgetFieldChange[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const change of changes) {
    if (change.field === 'amountCredits') body.budget_amount = creditsToUsd(change.new);
    else if (change.field === 'preventFurtherUsage') body.prevent_further_usage = change.new;
    else body.budget_alerting = { will_alert: change.new.willAlert, alert_recipients: [...change.new.alertRecipients] };
  }
  return body;
}

interface ExecutedMutation {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
}

// All requests use Octokit's `{placeholder}` URL-template mechanism (matching
// api-client/github-impl.ts's existing convention), never manual string
// interpolation into the route -- passing `enterprise`/`budget_id` etc. as
// top-level request params lets Octokit's own endpoint parser consume them
// as URL substitutions (and correctly omit them from the request body); manually
// pre-interpolating the URL would instead leak those values into the PATCH/POST
// body as extra unwanted keys (@octokit/endpoint's own `omittedParameters` logic).
async function executeBudgetMutation(
  octokit: Octokit,
  enterprise: string,
  entry: Extract<PlanEntry, { controlKind: 'budget' }>,
  live: LiveControlsResult,
): Promise<ExecutedMutation> {
  if (entry.action === 'delete') {
    const wire = live.budgetWireByIdentity.get(entry.id);
    if (!wire) {
      throw new Error(`applyPlan: no live budget found for "${entry.id}" (delete) -- the drift check should have caught this`);
    }
    const response = await octokit.request('DELETE /enterprises/{enterprise}/settings/billing/budgets/{budget_id}', {
      enterprise,
      budget_id: wire.id,
    });
    return { method: 'DELETE', path: response.url, requestBody: undefined, responseStatus: response.status, responseBody: response.data };
  }

  if (entry.action === 'add') {
    // budget_type is LIVE-PINNED (open item 22, maintainer's 2026-07-09 R4
    // sampler over their 10 real budgets): every real ai_credits budget is
    // BundlePricing at EVERY scope -- including cost_center spending limits
    // -- while ProductPricing pairs only with product skus. Verbatim from the
    // live inventory:
    //   BundlePricing/ai_credits/cost_center/TEST-CC ... /enterprise/
    //   departmentofemploymentandworkplacerelations ... /cost_center/
    //   DSD-Premium|DES-NoFunds|TSD-Premium|TSD-Admins|ETD-NoFunds;
    //   ProductPricing/codespaces|packages|actions/enterprise only.
    // The old Task-4.8 fixture-observed inference (isUlbScope ?
    // 'BundlePricing' : 'ProductPricing') would have sent the nonexistent
    // ProductPricing+ai_credits pairing on a live Family-B create. Every
    // budget this tool creates is an AI-credit budget (AI_CREDITS_BUDGET_SKU
    // below), so the type is a constant, not a branch.
    const budgetType = 'BundlePricing';
    const budgetAlerting = {
      will_alert: entry.desired.alerting.willAlert,
      alert_recipients: [...entry.desired.alerting.alertRecipients],
    };
    // Scope serialization to the REAL wire enum (wire-contract-writes.md §1,
    // shared budget-scope mapper): internal `universal` ->
    // `multi_user_customer`; internal `individual` -> scope `user` + the
    // `user` login field. The internal spellings never reach the wire.
    const wireIdentity = internalBudgetIdentityToWire(entry.scope as InternalBudgetScope, entry.entityName);
    const requestBody = {
      budget_type: budgetType,
      // Single-sourced with the read boundary's product filter (open item 20):
      // every budget this tool creates covers the AI-credit product.
      budget_product_sku: AI_CREDITS_BUDGET_SKU,
      ...wireIdentity,
      budget_amount: creditsToUsd(entry.desired.amountCredits),
      prevent_further_usage: entry.desired.preventFurtherUsage,
      budget_alerting: budgetAlerting,
    };
    const response = await octokit.request('POST /enterprises/{enterprise}/settings/billing/budgets', {
      enterprise,
      ...requestBody,
    });
    return { method: 'POST', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data };
  }

  // action === 'change'
  const wire = live.budgetWireByIdentity.get(entry.id);
  if (!wire) {
    throw new Error(`applyPlan: no live budget found for "${entry.id}" (change) -- the drift check should have caught this`);
  }
  const requestBody = budgetPatchBody(entry.changes);
  const response = await octokit.request('PATCH /enterprises/{enterprise}/settings/billing/budgets/{budget_id}', {
    enterprise,
    budget_id: wire.id,
    ...requestBody,
  });
  return { method: 'PATCH', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data };
}

// An 'add'/'delete' included_cap plan entry is unreachable by construction and
// stays a guarded throw. Task 4.13 subsumes cost-center lifecycle into the
// cost_center control (below): a NEW cost center's cap arrives inside the POST
// /cost-centers create payload (executeCostCenterMutation's 'add'), and a
// deleted cost center's cap is removed by DELETE /cost-centers -- never as a
// standalone included_cap add/delete. The Controls caps grid (Task 4.12) only
// ever maps enabled/overflow onto the existing live cap set, so it too never
// produces an included_cap add/delete. Thrown, not silently skipped, so any
// future caller that tries this gets a clear signal.
async function executeCapMutation(
  octokit: Octokit,
  enterprise: string,
  entry: Extract<PlanEntry, { controlKind: 'included_cap' }>,
  live: LiveControlsResult,
): Promise<ExecutedMutation[]> {
  if (entry.action === 'add' || entry.action === 'delete') {
    throw new Error(
      `applyPlan: included_cap "${entry.action}" for "${entry.costCenterName}" is not supported -- cost-center lifecycle is Task 4.13's scope, not Task 4.8's.`,
    );
  }

  const costCenterId = live.costCenterIdByName.get(entry.costCenterName);
  if (!costCenterId) {
    throw new Error(`applyPlan: no live cost center found named "${entry.costCenterName}" -- the drift check should have caught this`);
  }

  // A2 RESOLVED (2026-07-08 third live run + the OpenAPI schema, both): NO
  // per-CC overflow wire field exists anywhere -- block-vs-metered at cap
  // exhaustion is governed by the ENTERPRISE "AI credit paid usage" policy,
  // not per cost center. Maintainer decisions: the cap write sends ONLY the
  // machine-verified flat `ai_credit_pool_enabled` field; the internal
  // `overflow` knob is a SIM-ONLY what-if lever (live-disabled in the UI) and
  // is NEVER serialized to the wire. An overflow-ONLY change entry therefore
  // issues NO wire mutation at all -- its audit event (appended by applyPlan's
  // per-entry loop regardless of how many requests the entry issued, same as
  // a zero-removal membership change) is the record of the internal what-if.
  const enabledChange = entry.changes.find((c): c is Extract<CapFieldChange, { field: 'enabled' }> => c.field === 'enabled');
  if (!enabledChange) return [];

  const requestBody = { ai_credit_pool_enabled: enabledChange.new };
  const response = await octokit.request('PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}', {
    enterprise,
    cost_center_id: costCenterId,
    ...requestBody,
  });
  return [{ method: 'PATCH', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data }];
}

// Task 4.13 cost-center lifecycle executor. Unlike budgets/caps (exactly one
// request per plan entry), a membership 'change' can issue up to three
// requests -- so it returns an ORDERED list: removals (DELETE) first, then the
// DEWR/exclude PATCH, then additions (POST). Removals-before-additions means a
// drill-modal edit that swaps a member never briefly double-attributes a
// resource; the cross-entry case (a 1:1 reassignment = remove-from-A entry +
// add-to-B entry) is ordered by orderEntriesForApply below.
async function executeCostCenterMutation(
  octokit: Octokit,
  enterprise: string,
  entry: Extract<PlanEntry, { controlKind: 'cost_center' }>,
  live: LiveControlsResult,
): Promise<ExecutedMutation[]> {
  if (entry.action === 'add') {
    const desired = entry.desired;
    // The cap arrives IN the create payload (§6.9 M5 / Task 4.2 handler): a
    // new cost center's included-usage cap is not a separate mutation. Only
    // enabled/overflow travel -- the limit is GitHub-computed from the
    // attributed resources (never client-supplied).
    const requestBody = {
      name: desired.name,
      dewr_division: desired.dewrDivision,
      dewr_branch: desired.dewrBranch,
      dewr_project: desired.dewrProject,
      excluded_from_enterprise_budget: desired.excludedFromEnterpriseBudget,
      included_usage_cap: { enabled: desired.includedUsageCap.enabled, overflow: desired.includedUsageCap.overflow },
      resources: desired.members.map((m) => ({ type: m.type, name: m.name })),
    };
    const response = await octokit.request('POST /enterprises/{enterprise}/settings/billing/cost-centers', {
      enterprise,
      ...requestBody,
    });
    return [{ method: 'POST', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data }];
  }

  const costCenterId = live.costCenterIdByName.get(entry.name);
  if (!costCenterId) {
    throw new Error(`applyPlan: no live cost center found named "${entry.name}" -- the drift check should have caught this`);
  }

  if (entry.action === 'delete') {
    const response = await octokit.request('DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}', {
      enterprise,
      cost_center_id: costCenterId,
    });
    return [{ method: 'DELETE', path: response.url, requestBody: undefined, responseStatus: response.status, responseBody: response.data }];
  }

  // action === 'change': removals -> DEWR/exclude PATCH -> additions.
  //
  // Wire shapes OpenAPI-pinned (wire-contract-writes.md §3): POST (add) and
  // DELETE (remove) both take the FOUR-ARRAY body ({users, organizations,
  // repositories, enterprise_teams}, minProperties 1 -- resourceArraysBody
  // below emits only the non-empty arrays), replacing the invented
  // {resources:[{type,name}]}. Responses: add -> 200 {message,
  // reassigned_resources|null} (each reassigned resource names its
  // previous_cost_center -- i.e. live GitHub reattributes server-side in the
  // SINGLE add call); remove -> 200 {message} only. Both envelopes ride
  // responseBody into the mutationLog verbatim, so reassigned_resources is
  // already observable to callers/audit evidence without a shape change. The
  // two-op cross-CC move (DELETE from source entry + POST to target entry,
  // ordered by orderEntriesForApply) is KEPT: collapsing to a single
  // reassigning POST would change drift/audit semantics -- flagged for a
  // maintainer ruling, not changed unilaterally here.
  const mutations: ExecutedMutation[] = [];
  const membership = entry.changes.find(
    (c): c is Extract<CostCenterFieldChange, { field: 'membership' }> => c.field === 'membership',
  );
  const scalarChanges = entry.changes.filter(
    (c): c is Exclude<CostCenterFieldChange, { field: 'membership' }> => c.field !== 'membership',
  );

  if (membership && membership.removed.length > 0) {
    const requestBody = resourceArraysBody(membership.removed);
    const response = await octokit.request('DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource', {
      enterprise,
      cost_center_id: costCenterId,
      ...requestBody,
    });
    mutations.push({ method: 'DELETE', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data });
  }

  if (scalarChanges.length > 0) {
    const requestBody = costCenterPatchBody(scalarChanges);
    const response = await octokit.request('PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}', {
      enterprise,
      cost_center_id: costCenterId,
      ...requestBody,
    });
    mutations.push({ method: 'PATCH', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data });
  }

  if (membership && membership.added.length > 0) {
    const requestBody = resourceArraysBody(membership.added);
    const response = await octokit.request('POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource', {
      enterprise,
      cost_center_id: costCenterId,
      ...requestBody,
    });
    mutations.push({ method: 'POST', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data });
  }

  return mutations;
}

// The OpenAPI-pinned resource-mutation body: four typed name arrays, only the
// non-empty ones emitted (the schema's minProperties: 1 -- an all-empty body
// is unreachable here since callers only invoke this with a non-empty ref
// list). Internal member types map 1:1 onto the four arrays.
function resourceArraysBody(refs: readonly { type: 'User' | 'Org' | 'Repo' | 'EnterpriseTeam'; name: string }[]): Record<string, string[]> {
  const arrayKeyByType = { User: 'users', Org: 'organizations', Repo: 'repositories', EnterpriseTeam: 'enterprise_teams' } as const;
  const body: Record<string, string[]> = {};
  for (const ref of refs) {
    const key = arrayKeyByType[ref.type];
    (body[key] ??= []).push(ref.name);
  }
  return body;
}

function costCenterPatchBody(changes: readonly Exclude<CostCenterFieldChange, { field: 'membership' }>[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const change of changes) {
    if (change.field === 'dewrDivision') body.dewr_division = change.new;
    else if (change.field === 'dewrBranch') body.dewr_branch = change.new;
    else if (change.field === 'dewrProject') body.dewr_project = change.new;
    else body.excluded_from_enterprise_budget = change.new;
  }
  return body;
}

async function executeMutation(
  octokit: Octokit,
  enterprise: string,
  entry: PlanEntry,
  live: LiveControlsResult,
): Promise<ExecutedMutation[]> {
  if (entry.controlKind === 'budget') return [await executeBudgetMutation(octokit, enterprise, entry, live)];
  if (entry.controlKind === 'included_cap') return executeCapMutation(octokit, enterprise, entry, live);
  return executeCostCenterMutation(octokit, enterprise, entry, live);
}

// Removals-before-additions across plan entries: a 1:1 reassignment stages a
// remove-from-A entry and an add-to-B entry; this stable sort hoists any
// cost_center change that removes members ahead of the rest, so the mover
// leaves its old cost center before joining the new one (never briefly in
// two). Stable within each group (preserves diffControls' id-sorted order),
// and only reorders when a membership removal is present -- every existing
// budget/cap-only plan is untouched.
function orderEntriesForApply(entries: readonly PlanEntry[]): PlanEntry[] {
  const removalRank = (entry: PlanEntry): number =>
    entry.controlKind === 'cost_center' &&
    entry.action === 'change' &&
    entry.changes.some((c) => c.field === 'membership' && c.removed.length > 0)
      ? 0
      : 1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => removalRank(a.entry) - removalRank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

function budgetActionName(action: PlanEntry['action']): string {
  return action === 'add' ? 'budget.create' : action === 'delete' ? 'budget.delete' : 'budget.update';
}

function capActionName(action: PlanEntry['action']): string {
  return action === 'add' ? 'included_cap.create' : action === 'delete' ? 'included_cap.delete' : 'included_cap.update';
}

// Audit action for a cost-center entry: a membership 'change' is
// 'cost_center.membership'; a DEWR/exclude-only 'change' is
// 'cost_center.update' (CLAUDE.md §6.5's actor/before/after are captured
// per-entry regardless of how many HTTP requests the entry issued).
function costCenterActionName(entry: Extract<PlanEntry, { controlKind: 'cost_center' }>): string {
  if (entry.action === 'add') return 'cost_center.create';
  if (entry.action === 'delete') return 'cost_center.delete';
  return entry.changes.some((c) => c.field === 'membership') ? 'cost_center.membership' : 'cost_center.update';
}

function buildAuditInput(
  entry: PlanEntry,
  liveById: Map<string, ControlState>,
  postById: Map<string, ControlState>,
  options: ApplyPlanOptions,
  dataSnapshotId: number | null,
): AppendAuditEventInput {
  const action =
    entry.controlKind === 'budget'
      ? budgetActionName(entry.action)
      : entry.controlKind === 'included_cap'
        ? capActionName(entry.action)
        : costCenterActionName(entry);
  return {
    ts: new Date(),
    actor: options.actor,
    action,
    entityRef: entry.id,
    // Per-source audit chains (migration 0006): stamp the client's mode so this
    // event joins THIS mode's chain -- 'msw' (simulation) or 'github' (live).
    // Threaded straight from ApplyPlanOptions.source (the same flag that gates
    // arming and scopes dataSnapshotId above), so a simulated apply is logged
    // to the sim chain and never renders in live's Audit view.
    source: options.source,
    // Phase-4 manual applies carry no rebalancer envelope (auditChain.ts's
    // binding_constraint doc comment: "a manual Phase-4 apply has no binding
    // constraint at all") -- null here, populated by Phase 6/7.
    envelopeSnapshot: null,
    before: entry.action === 'add' ? null : (liveById.get(entry.id) ?? null),
    after: entry.action === 'delete' ? null : (postById.get(entry.id) ?? null),
    justification: options.justification ?? null,
    trigger: options.trigger ?? 'manual',
    dataSnapshotId,
  };
}

function toAppliedAuditEvent(row: AuditEventRow): AppliedAuditEvent {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    actor: row.actor,
    action: row.action,
    entityRef: row.entityRef,
    trigger: row.trigger,
    envelopeSnapshot: row.envelopeSnapshot ? JSON.parse(row.envelopeSnapshot) : null,
    before: row.before ? JSON.parse(row.before) : null,
    after: row.after ? JSON.parse(row.after) : null,
    justification: row.justification,
    dataSnapshotId: row.dataSnapshotId,
  };
}

// The write engine's core pipeline (CLAUDE.md §6.1/§6.2, PLAN.md's "one
// write-path engine, two callers"):
//
//   1. RE-READ live state via fetchLiveControls -- the identical function
//      getControls() (the read path) calls, so "did live move since the plan
//      was staged" is a true apples-to-apples comparison.
//   2. RE-DIFF desired-vs-live with core's diffControls. If the freshly
//      computed plan doesn't deepEqual the plan the caller staged, live moved
//      -> ABORT as drift. Nothing is mutated, nothing is audited. Note this
//      is intentionally *plan-shaped* drift, not "did anything anywhere
//      change": a live edit to a control this plan doesn't touch produces the
//      same currentPlan and is NOT flagged here -- but step 3's validatePlan
//      re-runs against the fresh live read regardless, so a cross-control
//      hazard (e.g. someone lowered the enterprise cap while this plan only
//      raises cost-center budgets) is still caught, as a blocker, before
//      anything is written.
//   3. VALIDATE via core's validatePlan. A blocker (e.g.
//      enterprise-cap-below-cost-center-sum) aborts with nothing mutated,
//      nothing audited.
//   4. EXECUTE one idempotent mutation per plan entry (POST/PATCH/DELETE,
//      §6.9-documented paths, the API-version header set once at client
//      construction).
//   5. APPEND ONE audit event per applied change via 4.7's appendAuditEvent,
//      immediately after that entry's mutation succeeds (not batched at the
//      end) -- so a later entry's failure never leaves an earlier, genuinely
//      applied change unaudited.
//
// Partial-failure semantics (deliberate, not a rollback): if entry k's
// mutation throws, entries [1..k-1] are already applied AND audited (their
// GitHub calls truly succeeded) -- the loop stops and returns
// 'partial_failure' with exactly that progress, rather than attempting to
// undo already-accepted upstream mutations.
export async function applyPlan(stagedPlan: Plan, options: ApplyPlanOptions): Promise<ApplyPlanResult> {
  // Task 9.3-lite §6.8 defense-in-depth: gate EVERY live apply caller (manual
  // Phase-4 applies + future auto-apply) behind explicit arming, as the very
  // first statement -- before the live re-read or any octokit call. When live
  // writes are disarmed, nothing is read, mutated, or audited. Simulation
  // (source 'msw') is never gated: sim applies stay fully functional and
  // visibly simulated. dryRunPlan is deliberately NOT gated -- a dry run never
  // mutates, and simulate-before-apply must always work unarmed.
  if (options.source === 'github' && !isWriteArmed()) {
    return { status: 'not_armed', enterpriseSlug: options.enterprise };
  }

  const live = await fetchLiveControls(options.octokit, options.enterprise, options.asOfDate);
  const currentPlan = diffControls(live.controls, options.desiredControls);

  if (!isDeepStrictEqual(stagedPlan.entries, currentPlan.entries)) {
    return { status: 'drift', stagedPlan, currentPlan };
  }

  const emptyValidation: ValidationResult = { blockers: [], warnings: [], isBlocked: false };
  if (currentPlan.isNoOp) {
    return { status: 'applied', appliedCount: 0, mutationLog: [], auditEvents: [], validation: emptyValidation };
  }

  const validation = validatePlan(currentPlan, {
    live: live.controls,
    users: options.users,
    nearZeroUlbThresholdCredits: options.nearZeroUlbThresholdCredits,
    alertOnlyOverrides: buildAlertOnlyOverrides(currentPlan, options.justification),
  });

  if (validation.isBlocked) {
    return { status: 'blocked', validation };
  }

  const postPlanControls = applyPlanToControls(live.controls, currentPlan);
  const liveById = new Map(live.controls.map((c) => [controlIdentity(c), c]));
  const postById = new Map(postPlanControls.map((c) => [controlIdentity(c), c]));
  const dataSnapshotId = latestSnapshotId(options.db, options.source);

  const mutationLog: MutationLogEntry[] = [];
  const auditEvents: AppliedAuditEvent[] = [];

  // Removals-first apply order (see orderEntriesForApply) -- the drift check
  // above already passed against the diff's canonical (id-sorted) order, so
  // reordering here only affects the sequence requests are issued in, never
  // what is applied.
  for (const entry of orderEntriesForApply(currentPlan.entries)) {
    try {
      // A cost_center membership entry can issue multiple requests (removals,
      // PATCH, additions) in order; budgets/caps issue exactly one. Each
      // request is logged (in issue order) under the same plan-entry id; a
      // single audit event captures the entry's net before -> after.
      const executed = await executeMutation(options.octokit, options.enterprise, entry, live);
      for (const mutation of executed) {
        mutationLog.push({ planEntryId: entry.id, ...mutation });
      }

      const auditInput = buildAuditInput(entry, liveById, postById, options, dataSnapshotId);
      const row = appendAuditEvent(options.db, auditInput);
      auditEvents.push(toAppliedAuditEvent(row));
    } catch (err) {
      return {
        status: 'partial_failure',
        appliedCount: auditEvents.length,
        mutationLog,
        auditEvents,
        failedPlanEntryId: entry.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { status: 'applied', appliedCount: auditEvents.length, mutationLog, auditEvents, validation };
}
