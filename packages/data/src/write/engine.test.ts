import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Octokit } from 'octokit';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { diffControls, type ControlState } from '@copilot-budget/core';
import { readAuditChain, verifyStoredChain } from '../audit/writer.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { snapshot } from '../db/schema.js';
import { server } from '../msw/server.js';
import { BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/index.js';
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
  const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
  const desiredControls: ControlState[] = live.controls.map((c) =>
    c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === WORKFORCE_CC ? { ...c, amountCredits: 65_000 } : c,
  );
  const stagedPlan = diffControls(live.controls, desiredControls);
  return { stagedPlan, desiredControls };
}

function baseOptions(desiredControls: readonly ControlState[]): ApplyPlanOptions {
  return {
    enterprise: ENTERPRISE_SLUG,
    octokit,
    db,
    actor: 'admin@example.com',
    desiredControls,
    asOfDate: new Date('2026-06-14T00:00:00.000Z'),
    source: 'msw',
  };
}

describe('fetchLiveControls', () => {
  it('projects budgets and cost-center caps into ControlState, keyed by controlIdentity, excluding repository scope', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));

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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const trueLive = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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

    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
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

// --- Task 4.13: cost-center lifecycle writes -------------------------------
// Every request payload / sequence below is fixture-derived (msw/fixtures/
// costCenters.ts): the six seeded cost centers, Workforce with 24 User
// resources, promo enterprise 7,000 credits/seat.
describe('applyPlan -- cost-center lifecycle (Task 4.13)', () => {
  const CYBER_CC = 'Cyber & Identity Services';
  const WORKFORCE_ID = COST_CENTER_IDS.workforce;
  const CYBER_ID = COST_CENTER_IDS.cyber;

  it('fetchLiveControls now exposes cost centers with DEWR, exclude flag, and full membership', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const workforce = live.controls.find(
      (c): c is Extract<ControlState, { kind: 'cost_center' }> => c.kind === 'cost_center' && c.name === WORKFORCE_CC,
    );
    expect(workforce).toBeDefined();
    expect(workforce).toMatchObject({
      dewrDivision: 'Employment Systems Group',
      dewrBranch: 'Digital Delivery Branch',
      dewrProject: 'WFA-DIGITAL',
      excludedFromEnterpriseBudget: false,
    });
    expect(workforce!.members).toHaveLength(24);
    expect(workforce!.members).toContainEqual({ type: 'User', name: 'rpatel2' });
    expect(live.costCenterIdByName.get(WORKFORCE_CC)).toBe(WORKFORCE_ID);
  });

  it('create: POST /cost-centers with the exact create payload (name, DEWR, excluded, cap prefs, resources) + audit', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const newCC: ControlState = {
      kind: 'cost_center',
      name: 'New Delivery Team',
      dewrDivision: 'Digital & Technology Group',
      dewrBranch: 'Platform Enablement Branch',
      dewrProject: 'NEW-DELIVERY',
      excludedFromEnterpriseBudget: true,
      members: [{ type: 'User', name: 'sam-kelly' }],
      includedUsageCap: { enabled: true, overflow: 'metered' },
    };
    const desiredControls = [...live.controls, newCC];
    const stagedPlan = diffControls(live.controls, desiredControls);
    expect(stagedPlan.entries).toEqual([
      { id: 'cost_center:New Delivery Team', controlKind: 'cost_center', action: 'add', name: 'New Delivery Team', desired: newCC },
    ]);

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');

    expect(result.mutationLog).toHaveLength(1);
    const mutation = result.mutationLog[0]!;
    expect(mutation.method).toBe('POST');
    expect(mutation.path).toMatch(/\/enterprises\/dewr\/settings\/billing\/cost-centers$/);
    expect(mutation.requestBody).toEqual({
      name: 'New Delivery Team',
      dewr_division: 'Digital & Technology Group',
      dewr_branch: 'Platform Enablement Branch',
      dewr_project: 'NEW-DELIVERY',
      excluded_from_enterprise_budget: true,
      included_usage_cap: { enabled: true, overflow: 'metered' },
      resources: [{ type: 'User', name: 'sam-kelly' }],
    });
    // MSW create echoes the computed cap limit (1 seat x 7,000).
    expect((mutation.responseBody as { included_usage_cap: { computed_limit_credits: number } }).included_usage_cap.computed_limit_credits).toBe(7_000);

    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]!.action).toBe('cost_center.create');
    expect(result.auditEvents[0]!.entityRef).toBe('cost_center:New Delivery Team');
    expect(result.auditEvents[0]!.before).toBeNull();
    expect(result.auditEvents[0]!.after).toMatchObject({ name: 'New Delivery Team', excludedFromEnterpriseBudget: true });
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  it('membership: a single-CC add+remove issues DELETE then POST /resource (removal first) with recomputed limit in evidence + one membership audit', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const desiredControls = live.controls.map((c) => {
      if (c.kind === 'cost_center' && c.name === WORKFORCE_CC) {
        const members = c.members.filter((m) => m.name !== 'rpatel2').concat([{ type: 'User' as const, name: 'new-hire' }]);
        return { ...c, members };
      }
      return c;
    });
    const stagedPlan = diffControls(live.controls, desiredControls);
    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');

    // Removal (DELETE) precedes addition (POST).
    expect(result.mutationLog).toHaveLength(2);
    const [remove, add] = result.mutationLog;
    expect(remove!.method).toBe('DELETE');
    expect(remove!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));
    expect(remove!.requestBody).toEqual({ resources: [{ type: 'User', name: 'rpatel2' }] });
    expect(add!.method).toBe('POST');
    expect(add!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));
    expect(add!.requestBody).toEqual({ resources: [{ type: 'User', name: 'new-hire' }] });

    // The recomputed cap limit is observable in the mutation response (24 + 1
    // seats x 7,000 = 175,000 on add; 24 - 1 = 161,000 on remove).
    expect((add!.responseBody as { included_usage_cap: { computed_limit_credits: number } }).included_usage_cap.computed_limit_credits).toBe(175_000);
    expect((remove!.responseBody as { included_usage_cap: { computed_limit_credits: number } }).included_usage_cap.computed_limit_credits).toBe(161_000);

    // One audit event for the entry (net before -> after membership).
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]!.action).toBe('cost_center.membership');
    expect(result.auditEvents[0]!.entityRef).toBe(`cost_center:${WORKFORCE_CC}`);
  });

  it('reassign: a 1:1 move across cost centers issues DELETE(old)/resource then POST(new)/resource in that sequence + two membership audits', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const desiredControls = live.controls.map((c) => {
      if (c.kind === 'cost_center' && c.name === WORKFORCE_CC) return { ...c, members: c.members.filter((m) => m.name !== 'rpatel2') };
      if (c.kind === 'cost_center' && c.name === CYBER_CC) return { ...c, members: [...c.members, { type: 'User' as const, name: 'rpatel2' }] };
      return c;
    });
    const stagedPlan = diffControls(live.controls, desiredControls);
    // diff order is id-sorted (Cyber before Workforce); the executor reorders
    // to removal-first.
    expect(stagedPlan.entries.map((e) => e.id)).toEqual([`cost_center:${CYBER_CC}`, `cost_center:${WORKFORCE_CC}`]);

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');

    expect(result.mutationLog).toHaveLength(2);
    const [remove, add] = result.mutationLog;
    // Remove from the OLD cost center first.
    expect(remove!.method).toBe('DELETE');
    expect(remove!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));
    expect(remove!.requestBody).toEqual({ resources: [{ type: 'User', name: 'rpatel2' }] });
    // Then add to the NEW cost center.
    expect(add!.method).toBe('POST');
    expect(add!.path).toMatch(new RegExp(`/cost-centers/${CYBER_ID}/resource$`));
    expect(add!.requestBody).toEqual({ resources: [{ type: 'User', name: 'rpatel2' }] });

    // Two audit events, in apply (removal-first) order.
    expect(result.auditEvents.map((e) => e.entityRef)).toEqual([`cost_center:${WORKFORCE_CC}`, `cost_center:${CYBER_CC}`]);
    expect(result.auditEvents.every((e) => e.action === 'cost_center.membership')).toBe(true);
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  it('exclude-from-enterprise-budget toggle issues a PATCH with only that field + a cost_center.update audit', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const desiredControls = live.controls.map((c) =>
      c.kind === 'cost_center' && c.name === WORKFORCE_CC ? { ...c, excludedFromEnterpriseBudget: true } : c,
    );
    const stagedPlan = diffControls(live.controls, desiredControls);
    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');

    expect(result.mutationLog).toHaveLength(1);
    expect(result.mutationLog[0]!.method).toBe('PATCH');
    expect(result.mutationLog[0]!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}$`));
    expect(result.mutationLog[0]!.requestBody).toEqual({ excluded_from_enterprise_budget: true });
    expect(result.auditEvents[0]!.action).toBe('cost_center.update');
  });

  it('archive/delete issues DELETE /cost-centers/:id + a cost_center.delete audit', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    // Remove only the Cyber cost-center entity (its cap stays, producing no cap diff).
    const desiredControls = live.controls.filter((c) => !(c.kind === 'cost_center' && c.name === CYBER_CC));
    const stagedPlan = diffControls(live.controls, desiredControls);
    expect(stagedPlan.entries).toHaveLength(1);
    expect(stagedPlan.entries[0]).toMatchObject({ controlKind: 'cost_center', action: 'delete', name: CYBER_CC });

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');
    expect(result.mutationLog[0]!.method).toBe('DELETE');
    expect(result.mutationLog[0]!.path).toMatch(new RegExp(`/cost-centers/${CYBER_ID}$`));
    expect(result.auditEvents[0]!.action).toBe('cost_center.delete');
    expect(result.auditEvents[0]!.before).toMatchObject({ name: CYBER_CC });
    expect(result.auditEvents[0]!.after).toBeNull();
  });

  // Validator (Task 4.13 §11): orderEntriesForApply must stay coherent when a
  // move (remove-from-A entry + add-to-B entry) rides alongside an UNRELATED
  // create in the same plan. The only invariant is removal-before-its-target-
  // addition, and since ALL membership removals rank ahead of every other
  // entry, that holds regardless of where a create's POST lands. Proves the
  // create is never hoisted ahead of the move's removal and never wedged
  // between a removal and its paired addition in a way that double-attributes.
  it('a move + an unrelated create in one plan still issues the removal first, create not misordered', async () => {
    const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, new Date('2026-06-14T00:00:00.000Z'));
    const newCC: ControlState = {
      kind: 'cost_center',
      name: 'New Delivery Team',
      dewrDivision: 'Digital & Technology Group',
      dewrBranch: 'Platform Enablement Branch',
      dewrProject: 'NEW-DELIVERY',
      excludedFromEnterpriseBudget: false,
      members: [{ type: 'User', name: 'sam-kelly' }],
      includedUsageCap: { enabled: true, overflow: 'block' },
    };
    // rpatel2 moves Workforce -> Cyber (remove entry on Workforce + add entry
    // on Cyber), AND a brand-new cost center is created, all in one plan.
    const desiredControls = [
      ...live.controls.map((c) => {
        if (c.kind === 'cost_center' && c.name === WORKFORCE_CC) return { ...c, members: c.members.filter((m) => m.name !== 'rpatel2') };
        if (c.kind === 'cost_center' && c.name === CYBER_CC) return { ...c, members: [...c.members, { type: 'User' as const, name: 'rpatel2' }] };
        return c;
      }),
      newCC,
    ];
    const stagedPlan = diffControls(live.controls, desiredControls);
    // Three cost_center entries: Cyber add, New Delivery create, Workforce remove.
    expect(stagedPlan.entries).toHaveLength(3);

    const result = await applyPlan(stagedPlan, baseOptions(desiredControls));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');

    expect(result.mutationLog).toHaveLength(3);
    // The removal (DELETE Workforce/resource) is issued FIRST, ahead of both
    // the paired addition and the unrelated create.
    expect(result.mutationLog[0]!.method).toBe('DELETE');
    expect(result.mutationLog[0]!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));

    const removeIdx = result.mutationLog.findIndex((m) => m.method === 'DELETE' && /\/resource$/.test(m.path));
    const addIdx = result.mutationLog.findIndex((m) => m.method === 'POST' && new RegExp(`/cost-centers/${CYBER_ID}/resource$`).test(m.path));
    const createIdx = result.mutationLog.findIndex((m) => m.method === 'POST' && /\/cost-centers$/.test(m.path));
    // The paired addition follows the removal; the create is present and never
    // ahead of the removal (its exact slot among the rank-1 group is irrelevant).
    expect(removeIdx).toBe(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(createIdx).toBeGreaterThan(removeIdx);

    // Each entry still gets exactly one audit event (create + two membership).
    expect(result.auditEvents).toHaveLength(3);
    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });
});

// docs/pending/todo.md's "Audit provenance mode-scoping" deferred item:
// latestSnapshotId (engine.ts) used to pick the max-id snapshot ACROSS BOTH
// 'msw' and 'github' generations, so a live apply in the (by-design,
// unpurged) mixed-mode DB could stamp an MSW snapshot id as its audit
// event's CLAUDE.md §6.5 "data snapshot it was based on" whenever the newest
// snapshot happened to be a simulation sync. These tests seed the snapshot
// table directly (bypassing syncNow, matching audit/writer.test.ts's
// upgrade-path convention) to control exactly which source is newest.
describe('applyPlan -- audit dataSnapshotId is scoped to the apply\'s own source', () => {
  it('stamps the newest GITHUB snapshot, not the newest snapshot overall, when the apply\'s source is "github"', async () => {
    const mswGen1 = db.insert(snapshot).values({ capturedAt: new Date('2026-06-01T00:00:00.000Z'), source: 'msw' }).returning().get();
    const githubGen = db.insert(snapshot).values({ capturedAt: new Date('2026-06-05T00:00:00.000Z'), source: 'github' }).returning().get();
    const mswGen2 = db.insert(snapshot).values({ capturedAt: new Date('2026-06-10T00:00:00.000Z'), source: 'msw' }).returning().get();
    // mswGen2 is the highest-id / newest snapshot overall -- the bug this
    // guards against would stamp ITS id even though this apply's source is
    // 'github'. githubGen (the middle generation) is the one a source-scoped
    // lookup must return.
    expect(mswGen2.id).toBeGreaterThan(githubGen.id);
    expect(githubGen.id).toBeGreaterThan(mswGen1.id);

    const { stagedPlan, desiredControls } = await stageWorkforceAmountChangePlan();
    const result = await applyPlan(stagedPlan, { ...baseOptions(desiredControls), source: 'github' });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]!.dataSnapshotId).toBe(githubGen.id);
    expect(result.auditEvents[0]!.dataSnapshotId).not.toBe(mswGen2.id);
    expect(result.auditEvents[0]!.dataSnapshotId).not.toBe(mswGen1.id);
  });

  // Decision (CLAUDE.md §6.5 lens, recorded per the brief): when NO snapshot
  // of the apply's own source exists yet, dataSnapshotId is null -- not a
  // fallback to the newest snapshot of the OTHER source. A null data basis
  // honestly says "this github-sourced apply has no github-sourced snapshot
  // to point to yet"; silently substituting the newest msw snapshot would
  // stamp a WRONG data basis into an immutable, hash-chained compliance log,
  // which is worse than admitting there isn't one. This also matches the
  // existing no-snapshot-of-this-source convention already established on
  // the read side (getLastSyncedControls/getLatestForecast in sync-now.ts
  // both return null, never a cross-source fallback, when nothing of the
  // requested source exists) and the column itself (data_snapshot_id is a
  // nullable FK -- schema.ts's audit_event.dataSnapshotId).
  it('records a null dataSnapshotId (not a wrong-source id) when zero snapshots of the apply\'s source exist', async () => {
    db.insert(snapshot).values({ capturedAt: new Date('2026-06-01T00:00:00.000Z'), source: 'msw' }).run();
    db.insert(snapshot).values({ capturedAt: new Date('2026-06-05T00:00:00.000Z'), source: 'msw' }).run();

    const { stagedPlan, desiredControls } = await stageWorkforceAmountChangePlan();
    const result = await applyPlan(stagedPlan, { ...baseOptions(desiredControls), source: 'github' });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]!.dataSnapshotId).toBeNull();
  });
});
