import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Octokit } from 'octokit';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { diffControls, type ControlState } from '@copilot-budget/core';
import { readAuditChain, verifyStoredChain } from '../audit/writer.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { server } from '../msw/server.js';
import { BUDGET_IDS, ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/index.js';
import { applyPlan, dryRunPlan, type ApplyPlanOptions } from './engine.js';
import { fetchLiveControls } from './live-state.js';

// One mock, three consumers (CLAUDE.md §7): this test drives the same MSW
// server that simulation mode and Playwright e2e attach.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let tmpDir: string;
let db: Db;
let octokit: Octokit;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-write-engine-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
  octokit = new Octokit({ baseUrl: GITHUB_API_BASE });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Raises the Workforce Australia Platform cost-center spending limit
// ($600 -> $650, i.e. 60,000 -> 65,000 credits) -- a single, unambiguous
// 'change' plan entry with no validation warnings (cost_center scope, not a
// ULB) against the seeded fixture (msw/fixtures/budgets.ts's
// BUDGET_IDS.costCenterMetered).
const WORKFORCE_CC = 'Workforce Australia Platform';

async function stageWorkforceAmountChangePlan() {
  const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
  const desiredControls: ControlState[] = live.controls.map((c) =>
    c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC ? { ...c, amountCredits: 65_000 } : c,
  );
  const stagedPlan = diffControls(live.controls, desiredControls);
  return { stagedPlan, desiredControls };
}

function baseOptions(desiredControls: readonly ControlState[]): ApplyPlanOptions {
  return { enterprise: ENTERPRISE_SLUG, octokit, db, actor: 'admin@example.com', desiredControls };
}

describe('fetchLiveControls', () => {
  it('projects budgets and cost-center caps into ControlState, keyed by controlIdentity, excluding repository scope', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);

    const platformBudget = live.controls.find(
      (c): c is Extract<ControlState, { kind: 'budget' }> => c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC,
    );
    expect(platformBudget?.amountCredits).toBe(60_000);
    expect(platformBudget?.preventFurtherUsage).toBe(false);

    expect(live.budgetWireByIdentity.get(`budget:cost_center:${WORKFORCE_CC}`)).toEqual({
      id: BUDGET_IDS.costCenterMetered,
      budgetType: 'ProductPricing',
      budgetProductSku: 'ai_credits',
    });
    expect(live.costCenterIdByName.get(WORKFORCE_CC)).toBeDefined();

    expect(live.controls.some((c) => c.kind === 'budget' && (c.scope as string) === 'repository')).toBe(false);

    const cap = live.controls.find((c): c is Extract<ControlState, { kind: 'included_cap' }> => c.kind === 'included_cap' && c.costCenterName === WORKFORCE_CC);
    expect(cap).toEqual({ kind: 'included_cap', costCenterName: WORKFORCE_CC, enabled: true, overflow: 'block', computedLimitCredits: 168_000 });
  });
});

describe('applyPlan', () => {
  it('applies a no-drift plan: PATCHes the correct budget, records one audit event, and the chain verifies', async () => {
    const { stagedPlan, desiredControls } = await stageWorkforceAmountChangePlan();
    expect(stagedPlan.entries).toHaveLength(1);
    expect(stagedPlan.entries[0]).toMatchObject({ controlKind: 'budget', action: 'change', scope: 'cost_center', entityName: WORKFORCE_CC });

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error(`expected 'applied', got ${result.status}`);
    expect(result.appliedCount).toBe(1);

    expect(result.mutationLog).toHaveLength(1);
    const mutation = result.mutationLog[0]!;
    expect(mutation.method).toBe('PATCH');
    expect(mutation.path).toContain(`/enterprises/${ENTERPRISE_SLUG}/settings/billing/budgets/${BUDGET_IDS.costCenterMetered}`);
    expect(mutation.requestBody).toEqual({ budget_amount: 650 });
    expect(mutation.responseStatus).toBe(200);
    expect((mutation.responseBody as { budget_amount: number }).budget_amount).toBe(650);

    expect(result.auditEvents).toHaveLength(1);
    const auditEvent = result.auditEvents[0]!;
    expect(auditEvent.action).toBe('budget.update');
    expect(auditEvent.entityRef).toBe(`budget:cost_center:${WORKFORCE_CC}`);
    expect(auditEvent.actor).toBe('admin@example.com');
    expect(auditEvent.trigger).toBe('manual');
    expect(auditEvent.envelopeSnapshot).toBeNull();
    expect(auditEvent.before).toMatchObject({ amountCredits: 60_000 });
    expect(auditEvent.after).toMatchObject({ amountCredits: 65_000 });

    expect(readAuditChain(db)).toHaveLength(1);
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  it('is a no-op (applies nothing, audits nothing) when desiredControls already matches live', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const stagedPlan = diffControls(live.controls, live.controls);
    expect(stagedPlan.isNoOp).toBe(true);

    const result = await applyPlan(stagedPlan, baseOptions(live.controls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error(`expected 'applied', got ${result.status}`);
    expect(result.appliedCount).toBe(0);
    expect(readAuditChain(db)).toHaveLength(0);
  });

  // CLAUDE.md §6.2: "re-read live state before applying to reconcile drift."
  // Deliberately built without any test-only injection hook in engine.ts --
  // the staged plan here is computed against a BASELINE the test fabricates
  // to be wrong (not the true live fixture value), so when applyPlan performs
  // its own real re-read + re-diff, the two plans structurally differ. This
  // is production-safe: the exact same code path fires for a genuine
  // between-stage-and-apply GitHub-side edit.
  it('aborts as drift when the staged plan no longer matches a fresh live re-read, mutating and auditing nothing', async () => {
    const trueLive = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const { desiredControls } = await stageWorkforceAmountChangePlan();

    const staleLiveBaseline: ControlState[] = trueLive.controls.map((c) =>
      c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC ? { ...c, amountCredits: 999_999 } : c,
    );
    const stagedPlanAgainstStaleBaseline = diffControls(staleLiveBaseline, desiredControls);

    const result = await applyPlan(stagedPlanAgainstStaleBaseline, baseOptions(desiredControls));

    expect(result.status).toBe('drift');
    if (result.status !== 'drift') throw new Error(`expected 'drift', got ${result.status}`);
    // The staged plan (diffed against the fabricated 999,999 baseline) computed a
    // different 'old' value than the fresh re-diff (against the true 60,000 live value).
    expect(result.stagedPlan.entries).not.toEqual(result.currentPlan.entries);

    expect(readAuditChain(db)).toHaveLength(0);
  });

  it('aborts as blocked when the post-plan state trips a validation blocker, mutating and auditing nothing', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    // A 900,000-credit ($9,000) Workforce cost-center spending limit + the
    // Data & Evaluation limit (25,000) sums to 925,000 > the enterprise's
    // 800,000 cap -> enterprise_cap_below_cost_center_sum.
    const desiredControls: ControlState[] = live.controls.map((c) =>
      c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC ? { ...c, amountCredits: 900_000 } : c,
    );
    const stagedPlan = diffControls(live.controls, desiredControls);

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error(`expected 'blocked', got ${result.status}`);
    expect(result.validation.blockers).toHaveLength(1);
    expect(result.validation.blockers[0]).toMatchObject({ kind: 'enterprise_cap_below_cost_center_sum' });

    expect(readAuditChain(db)).toHaveLength(0);
  });

  it('reports partial_failure and stops after a mutation request fails, auditing only the entries that truly succeeded', async () => {
    // Overrides ONLY the enterprise budget's PATCH for this one test (msw's
    // per-test server.use(), reset in afterEach) -- every other budget PATCH
    // (including Workforce's) falls through untouched to the real handler,
    // since returning undefined from a resolver lets MSW try the next match.
    // Status 422 (not 500): the `octokit` package bundles @octokit/plugin-retry,
    // which auto-retries most non-2xx responses with exponential backoff --
    // 422 is in its default doNotRetry list, so this fails immediately rather
    // than after ~14s of retries (3 attempts, backoff 1s/4s/9s).
    server.use(
      http.patch(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/budgets/:budgetId`, ({ params }) => {
        if (params.budgetId === BUDGET_IDS.enterpriseMetered) {
          return HttpResponse.json({ message: 'simulated upstream failure' }, { status: 422 });
        }
        return undefined;
      }),
    );

    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const desiredControls: ControlState[] = live.controls.map((c) => {
      if (c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC) return { ...c, amountCredits: 65_000 };
      if (c.kind === 'budget' && c.scope === 'enterprise') return { ...c, amountCredits: 850_000 };
      return c;
    });
    const stagedPlan = diffControls(live.controls, desiredControls);
    // Sorted by id: 'budget:cost_center:Workforce Australia Platform' < 'budget:enterprise:dewr'.
    expect(stagedPlan.entries).toHaveLength(2);
    expect(stagedPlan.entries[0]!.id).toBe(`budget:cost_center:${WORKFORCE_CC}`);
    expect(stagedPlan.entries[1]!.id).toBe(`budget:enterprise:${ENTERPRISE_SLUG}`);

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));

    expect(result.status).toBe('partial_failure');
    if (result.status !== 'partial_failure') throw new Error(`expected 'partial_failure', got ${result.status}`);
    expect(result.appliedCount).toBe(1);
    expect(result.mutationLog).toHaveLength(1);
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]!.entityRef).toBe(`budget:cost_center:${WORKFORCE_CC}`);
    expect(result.failedPlanEntryId).toBe(`budget:enterprise:${ENTERPRISE_SLUG}`);

    // The one entry that truly succeeded against GitHub is truly audited --
    // no rollback, and the chain is still internally consistent.
    expect(readAuditChain(db)).toHaveLength(1);
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  // --- Mutation-shape coverage: M1 (POST create), M4 (DELETE), M7 (cap PATCH) ---
  // The tests above all exercise M3 (PATCH budget change). These execute the
  // other three mutation shapes end-to-end against MSW so their request
  // body/path/status (docs/api-surface-validation.md M1/M4/M7), USD conversion,
  // and audit action are verified by execution rather than by reading engine.ts.

  it('creates a new individual ULB: POSTs the M1 body (USD budget_amount, scope-inferred BundlePricing) and audits budget.create', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const newUlb: ControlState = {
      kind: 'budget',
      scope: 'individual',
      entityName: 'user-99',
      amountCredits: 5_000, // $50
      preventFurtherUsage: true,
      alerting: { willAlert: false, alertRecipients: [] },
    };
    const desiredControls: ControlState[] = [...live.controls, newUlb];
    const stagedPlan = diffControls(live.controls, desiredControls);
    expect(stagedPlan.entries).toHaveLength(1);
    expect(stagedPlan.entries[0]).toMatchObject({ controlKind: 'budget', action: 'add', scope: 'individual', entityName: 'user-99' });

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error(`expected 'applied', got ${result.status}`);

    const mutation = result.mutationLog[0]!;
    expect(mutation.method).toBe('POST');
    expect(mutation.path).toContain(`/enterprises/${ENTERPRISE_SLUG}/settings/billing/budgets`);
    // §6.9 M1 body shape + USD conversion (5,000 credits -> $50, i.e. /100).
    expect(mutation.requestBody).toEqual({
      budget_type: 'BundlePricing',
      budget_product_sku: 'ai_credits',
      budget_scope: 'individual',
      budget_entity_name: 'user-99',
      budget_amount: 50,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] },
    });
    expect(mutation.responseStatus).toBe(201);

    expect(result.auditEvents[0]!.action).toBe('budget.create');
    expect(result.auditEvents[0]!.entityRef).toBe('budget:individual:user-99');
    expect(result.auditEvents[0]!.before).toBeNull();
    expect(result.auditEvents[0]!.after).toMatchObject({ amountCredits: 5_000 });
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  it('deletes a budget: issues DELETE on the correct wire id (M4, no body, 204) and audits budget.delete', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    // Full end-state minus the organization spending limit -> exactly one delete.
    const desiredControls: ControlState[] = live.controls.filter(
      (c) => !(c.kind === 'budget' && c.scope === 'organization' && c.entityName === 'dewr-digital'),
    );
    const stagedPlan = diffControls(live.controls, desiredControls);
    expect(stagedPlan.entries).toHaveLength(1);
    expect(stagedPlan.entries[0]).toMatchObject({ controlKind: 'budget', action: 'delete', scope: 'organization', entityName: 'dewr-digital' });

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error(`expected 'applied', got ${result.status}`);

    const mutation = result.mutationLog[0]!;
    expect(mutation.method).toBe('DELETE');
    expect(mutation.path).toContain(`/settings/billing/budgets/${BUDGET_IDS.organizationMetered}`);
    expect(mutation.requestBody).toBeUndefined();
    expect(mutation.responseStatus).toBe(204);

    expect(result.auditEvents[0]!.action).toBe('budget.delete');
    expect(result.auditEvents[0]!.entityRef).toBe('budget:organization:dewr-digital');
    expect(result.auditEvents[0]!.before).toMatchObject({ amountCredits: 320_000 }); // $3,200 -> 320,000 credits
    expect(result.auditEvents[0]!.after).toBeNull();
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  it('toggles an included-usage cap: PATCHes cost-centers/{id} with the nested included_usage_cap body (M7) and audits included_cap.update', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const desiredControls: ControlState[] = live.controls.map((c) =>
      c.kind === 'included_cap' && c.costCenterName === WORKFORCE_CC ? { ...c, overflow: 'metered' as const } : c,
    );
    const stagedPlan = diffControls(live.controls, desiredControls);
    expect(stagedPlan.entries).toHaveLength(1);
    expect(stagedPlan.entries[0]).toMatchObject({ controlKind: 'included_cap', action: 'change', costCenterName: WORKFORCE_CC });

    const platformId = live.costCenterIdByName.get(WORKFORCE_CC)!;
    expect(platformId).toBeDefined();

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error(`expected 'applied', got ${result.status}`);

    const mutation = result.mutationLog[0]!;
    expect(mutation.method).toBe('PATCH');
    expect(mutation.path).toContain(`/settings/billing/cost-centers/${platformId}`);
    // The engine sends the nested internal model; the 4.2 handler reads it here (block-vs-overflow
    // wire reconciliation is a Task 9.2 item -- see docs/api-surface-validation.md M7).
    expect(mutation.requestBody).toEqual({ included_usage_cap: { overflow: 'metered' } });
    expect(mutation.responseStatus).toBe(200);

    expect(result.auditEvents[0]!.action).toBe('included_cap.update');
    expect(result.auditEvents[0]!.entityRef).toBe(`included_cap:${WORKFORCE_CC}`);
    expect(result.auditEvents[0]!.before).toMatchObject({ overflow: 'block' });
    expect(result.auditEvents[0]!.after).toMatchObject({ overflow: 'metered' });
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  // The X-GitHub-Api-Version header is set once at Octokit client
  // construction (createGitHubApiClient, api-client/github-impl.ts's
  // `octokit.hook.before('request', ...)`), not by engine.ts -- engine.ts is
  // deliberately agnostic to how its injected `Octokit` instance was built
  // (that's what makes it unit-testable against a bare `new Octokit(...)`
  // here). The header-is-actually-sent proof therefore lives in
  // api-client/github-impl.test.ts, which drives requests through the real
  // factory -- see "sets X-GitHub-Api-Version on every request" there.
});

describe('dryRunPlan', () => {
  it('recomputes the plan fresh against live, validates, and simulates -- never mutates or audits', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const desiredControls: ControlState[] = live.controls.map((c) =>
      c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC ? { ...c, amountCredits: 65_000 } : c,
    );

    const result = await dryRunPlan(desiredControls, {
      enterprise: ENTERPRISE_SLUG,
      octokit,
      asOfDate: new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(result.plan.entries).toHaveLength(1);
    expect(result.validation.isBlocked).toBe(false);
    expect(result.simulation.summary.totalMeteredCapacityDeltaCredits).toBe(5_000);

    expect(readAuditChain(db)).toHaveLength(0);
  });

  it('surfaces the alert-only-without-hard-stop warning as required, then acknowledged once a justification is supplied', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    // Turns OFF the universal ULB's hard stop (true -> false) -- ULBs are
    // always-hard-stop by domain definition (CLAUDE.md §5), so this always
    // trips the warning regardless of amount.
    const desiredControls: ControlState[] = live.controls.map((c) =>
      c.kind === 'budget' && c.scope === 'universal' ? { ...c, preventFurtherUsage: false } : c,
    );

    const withoutJustification = await dryRunPlan(desiredControls, {
      enterprise: ENTERPRISE_SLUG,
      octokit,
      asOfDate: new Date('2026-06-14T00:00:00.000Z'),
    });
    const requiredWarning = withoutJustification.validation.warnings.find((w) => w.kind === 'alert_only_without_hard_stop');
    expect(requiredWarning).toBeDefined();
    if (requiredWarning?.kind === 'alert_only_without_hard_stop') expect(requiredWarning.override).toEqual({ status: 'required' });

    const withJustification = await dryRunPlan(desiredControls, {
      enterprise: ENTERPRISE_SLUG,
      octokit,
      asOfDate: new Date('2026-06-14T00:00:00.000Z'),
      justification: 'Approved by FinOps lead for Q3 promo period -- ticket FIN-482.',
    });
    const acknowledgedWarning = withJustification.validation.warnings.find((w) => w.kind === 'alert_only_without_hard_stop');
    expect(acknowledgedWarning).toBeDefined();
    if (acknowledgedWarning?.kind === 'alert_only_without_hard_stop') {
      expect(acknowledgedWarning.override).toEqual({
        status: 'acknowledged',
        justification: 'Approved by FinOps lead for Q3 promo period -- ticket FIN-482.',
      });
    }
  });

  // Task 4.11b (CLAUDE.md §6.1 preview-fidelity fix): before this task,
  // assembleUsageState built usageState.users from the billing-usage report
  // alone, which never itemises emily-zhao by login -- so staging a $0 ULB
  // for her (5,480 MTD credits this cycle, per CREDITS_USED_ITEMS) previewed
  // "0 newly blocked", a structurally misleading preview for a money-affecting
  // hard-block. Now that assembleUsageState folds in the per-user metrics
  // report (write/live-state.test.ts pins the fold itself), the SAME dry run
  // correctly shows her newly blocked: her effective ULB today is the Data &
  // Evaluation Platform CCULB (6,000 credits, 5,480 < 6,000 -> not blocked);
  // staging an individual $0 override outranks the CCULB (individual >
  // CCULB > universal, CLAUDE.md §5) and 0 - 5,480 <= 0 -> blocked.
  it('previews emily-zhao newly blocked when staging a $0 individual ULB -- the exact preview-fidelity gap this task fixes', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG);
    const desiredControls: ControlState[] = [
      ...live.controls,
      {
        kind: 'budget',
        scope: 'individual',
        entityName: 'emily-zhao',
        amountCredits: 0,
        preventFurtherUsage: true,
        alerting: { willAlert: false, alertRecipients: [] },
      },
    ];

    const result = await dryRunPlan(desiredControls, {
      enterprise: ENTERPRISE_SLUG,
      octokit,
      asOfDate: new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(result.plan.entries).toHaveLength(1);
    expect(result.plan.entries[0]).toMatchObject({ controlKind: 'budget', action: 'add', scope: 'individual', entityName: 'emily-zhao' });
    expect(result.simulation.newlyBlockedUserLogins).toEqual(['emily-zhao']);
    expect(result.simulation.summary.newlyBlockedCount).toBe(1);
    expect(result.simulation.summary.newlyUnblockedCount).toBe(0);

    const emilyStatus = result.simulation.userBlockStatus.find((u) => u.userLogin === 'emily-zhao');
    expect(emilyStatus).toEqual({
      userLogin: 'emily-zhao',
      blockedBefore: false,
      blockedAfter: true,
      bindingConstraintAfter: 'ulb',
    });
  });
});
