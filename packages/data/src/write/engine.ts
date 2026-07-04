import { isDeepStrictEqual } from 'node:util';
import type { Octokit } from 'octokit';
import { desc } from 'drizzle-orm';
import {
  applyPlanToControls,
  controlIdentity,
  creditsToUsd,
  diffControls,
  isUlbScope,
  simulatePlan,
  validatePlan,
  type AlertOnlyOverrideInput,
  type BudgetFieldChange,
  type CapFieldChange,
  type ControlState,
  type Plan,
  type PlanEntry,
  type SimulationResult,
  type UserLicenseContext,
  type ValidationResult,
} from '@copilot-budget/core';
import { appendAuditEvent, type AppendAuditEventInput, type AuditEventRow } from '../audit/writer.js';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import { assembleUsageState, fetchLiveControls, type LiveControlsResult } from './live-state.js';

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
  const live = await fetchLiveControls(options.octokit, options.enterprise);
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
  const usageState = await assembleUsageState(options.octokit, options.enterprise, live.costCenterIdByName);
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
  users?: readonly UserLicenseContext[];
  nearZeroUlbThresholdCredits?: number;
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
    };

function latestSnapshotId(db: Db): number | null {
  const latest = db.select({ id: schema.snapshot.id }).from(schema.snapshot).orderBy(desc(schema.snapshot.id)).limit(1).all()[0];
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

function capPatchBody(changes: readonly CapFieldChange[]): { enabled?: boolean; overflow?: 'block' | 'metered' } {
  const body: { enabled?: boolean; overflow?: 'block' | 'metered' } = {};
  for (const change of changes) {
    if (change.field === 'enabled') body.enabled = change.new;
    else body.overflow = change.new;
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
    // Convention observed across every seeded budget fixture (msw/fixtures/budgets.ts):
    // ULB scopes (universal/individual/multi_user_cost_center) are always
    // 'BundlePricing'; spending-limit scopes (enterprise/organization/cost_center)
    // are always 'ProductPricing'. No fixture or spec passage documents a
    // third case, so this v1 infers budget_type from scope rather than
    // requiring the caller to supply it -- flagged in the Task 4.8 report as
    // an assumption to confirm.
    const budgetType = isUlbScope(entry.scope) ? 'BundlePricing' : 'ProductPricing';
    const budgetAlerting = {
      will_alert: entry.desired.alerting.willAlert,
      alert_recipients: [...entry.desired.alerting.alertRecipients],
    };
    const requestBody = {
      budget_type: budgetType,
      budget_product_sku: 'ai_credits',
      budget_scope: entry.scope,
      budget_entity_name: entry.entityName,
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

// Cost-center lifecycle (creating/removing a cost center) is Task 4.13's
// scope, not this task's -- an 'add'/'delete' included_cap plan entry would
// only arise from a desiredControls list that invents or omits a cost center
// entirely, which the Phase-4 Controls screen never does (it always maps
// enabled/overflow onto the existing live cost-center set). Thrown, not
// silently no-op'd, so a future caller that DOES try this gets a clear signal
// rather than a mysteriously-skipped entry.
async function executeCapMutation(
  octokit: Octokit,
  enterprise: string,
  entry: Extract<PlanEntry, { controlKind: 'included_cap' }>,
  live: LiveControlsResult,
): Promise<ExecutedMutation> {
  if (entry.action === 'add' || entry.action === 'delete') {
    throw new Error(
      `applyPlan: included_cap "${entry.action}" for "${entry.costCenterName}" is not supported -- cost-center lifecycle is Task 4.13's scope, not Task 4.8's.`,
    );
  }

  const costCenterId = live.costCenterIdByName.get(entry.costCenterName);
  if (!costCenterId) {
    throw new Error(`applyPlan: no live cost center found named "${entry.costCenterName}" -- the drift check should have caught this`);
  }

  const capBody = capPatchBody(entry.changes);
  const requestBody = { included_usage_cap: capBody };
  const response = await octokit.request('PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}', {
    enterprise,
    cost_center_id: costCenterId,
    included_usage_cap: capBody,
  });
  return { method: 'PATCH', path: response.url, requestBody, responseStatus: response.status, responseBody: response.data };
}

async function executeMutation(
  octokit: Octokit,
  enterprise: string,
  entry: PlanEntry,
  live: LiveControlsResult,
): Promise<ExecutedMutation> {
  return entry.controlKind === 'budget'
    ? executeBudgetMutation(octokit, enterprise, entry, live)
    : executeCapMutation(octokit, enterprise, entry, live);
}

function budgetActionName(action: PlanEntry['action']): string {
  return action === 'add' ? 'budget.create' : action === 'delete' ? 'budget.delete' : 'budget.update';
}

function capActionName(action: PlanEntry['action']): string {
  return action === 'add' ? 'included_cap.create' : action === 'delete' ? 'included_cap.delete' : 'included_cap.update';
}

function buildAuditInput(
  entry: PlanEntry,
  liveById: Map<string, ControlState>,
  postById: Map<string, ControlState>,
  options: ApplyPlanOptions,
  dataSnapshotId: number | null,
): AppendAuditEventInput {
  const action = entry.controlKind === 'budget' ? budgetActionName(entry.action) : capActionName(entry.action);
  return {
    ts: new Date(),
    actor: options.actor,
    action,
    entityRef: entry.id,
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
  const live = await fetchLiveControls(options.octokit, options.enterprise);
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
  const dataSnapshotId = latestSnapshotId(options.db);

  const mutationLog: MutationLogEntry[] = [];
  const auditEvents: AppliedAuditEvent[] = [];

  for (const entry of currentPlan.entries) {
    try {
      const executed = await executeMutation(options.octokit, options.enterprise, entry, live);
      mutationLog.push({ planEntryId: entry.id, ...executed });

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
