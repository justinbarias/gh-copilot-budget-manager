import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 4.8's write engine, driven the same way api-client.spec.ts/sync-now.spec.ts
// drive their surfaces: through window.api (preload -> IPC -> main -> engine ->
// MSW -> back), never by importing @copilot-budget/data/core into the spec
// itself (Playwright's TS transform runs specs as CommonJS; @copilot-budget/data
// is ESM-only -- see sync-now.spec.ts's note). Deep engine behaviour (drift-vs-
// no-drift diffing, validation blockers, partial-failure semantics, the
// X-GitHub-Api-Version header) is already exhaustively covered by
// packages/data's vitest suite against the same MSW server -- this is the thin
// cross-boundary gate (CLAUDE.md §6.7): does a staged plan actually reach
// GitHub with the right shape, and does an audit event land, end to end.

interface ControlState {
  kind: 'budget' | 'included_cap';
  scope?: string;
  entityName?: string;
  costCenterName?: string;
  amountCredits?: number;
  preventFurtherUsage?: boolean;
  [key: string]: unknown;
}

interface PlanEntry {
  id: string;
  controlKind: string;
  action: string;
  [key: string]: unknown;
}

interface Plan {
  entries: PlanEntry[];
  isNoOp: boolean;
}

interface DryRunResult {
  plan: Plan;
  validation: { blockers: unknown[]; warnings: unknown[]; isBlocked: boolean };
  simulation: { summary: Record<string, number> };
}

interface MutationLogEntry {
  planEntryId: string;
  method: string;
  path: string;
  requestBody: unknown;
  responseStatus: number;
}

interface AppliedAuditEvent {
  id: number;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  before: unknown;
  after: unknown;
  justification: string | null;
}

type ApplyPlanResult =
  | { status: 'applied'; appliedCount: number; mutationLog: MutationLogEntry[]; auditEvents: AppliedAuditEvent[] }
  | { status: 'drift'; stagedPlan: Plan; currentPlan: Plan }
  | { status: 'blocked' }
  | { status: 'partial_failure' };

interface Api {
  getControls(): Promise<ControlState[]>;
  dryRunPlan(desired: readonly ControlState[]): Promise<DryRunResult>;
  applyPlan(plan: Plan, desired: readonly ControlState[], input: { actor: string; justification?: string | null }): Promise<ApplyPlanResult>;
}

async function launchApp(dbLabel: string) {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), `copilot-budget-e2e-${dbLabel}-`));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });
  return { app, dbDir };
}

// Raises the Platform cost-center spending limit ($600 -> $650) -- the same
// fixture and scenario packages/data's write/engine.test.ts uses: an
// unambiguous single 'change' entry, no validation warnings (cost_center
// scope, not a ULB).
function raisePlatformAmount(live: ControlState[]): ControlState[] {
  return live.map((c) =>
    c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === 'Platform' ? { ...c, amountCredits: 65_000 } : c,
  );
}

test('stage -> dryRun -> apply round-trips end to end: mutates the correct endpoint and records an audit event', async () => {
  const { app, dbDir } = await launchApp('write-engine-apply');
  try {
    const window = await app.firstWindow();

    const live = await window.evaluate(() => (window as unknown as { api: Api }).api.getControls());
    const desiredControls = raisePlatformAmount(live);

    const dryRun = await window.evaluate(
      (desired) => (window as unknown as { api: Api }).api.dryRunPlan(desired),
      desiredControls,
    );
    expect(dryRun.plan.entries).toHaveLength(1);
    expect(dryRun.plan.entries[0]).toMatchObject({ controlKind: 'budget', action: 'change', scope: 'cost_center', entityName: 'Platform' });
    expect(dryRun.validation.isBlocked).toBe(false);

    const applied = await window.evaluate(
      (args) => (window as unknown as { api: Api }).api.applyPlan(args.plan, args.desired, { actor: 'e2e-test@example.com' }),
      { plan: dryRun.plan, desired: desiredControls },
    );

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error(`expected 'applied', got ${applied.status}`);
    expect(applied.appliedCount).toBe(1);

    expect(applied.mutationLog).toHaveLength(1);
    expect(applied.mutationLog[0]!.method).toBe('PATCH');
    expect(applied.mutationLog[0]!.path).toContain('/settings/billing/budgets/');
    expect(applied.mutationLog[0]!.requestBody).toEqual({ budget_amount: 650 });
    expect(applied.mutationLog[0]!.responseStatus).toBe(200);

    expect(applied.auditEvents).toHaveLength(1);
    expect(applied.auditEvents[0]!.action).toBe('budget.update');
    expect(applied.auditEvents[0]!.entityRef).toBe('budget:cost_center:Platform');
    expect(applied.auditEvents[0]!.actor).toBe('e2e-test@example.com');
    expect(applied.auditEvents[0]!.trigger).toBe('manual');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('aborts as drift when the staged plan no longer matches a fresh live re-read: mutates and audits nothing', async () => {
  const { app, dbDir } = await launchApp('write-engine-drift');
  try {
    const window = await app.firstWindow();

    const live = await window.evaluate(() => (window as unknown as { api: Api }).api.getControls());
    const desiredControls = raisePlatformAmount(live);

    // Deliberately-stale staged plan: hand-built with the WRONG "old" value
    // (999,999 instead of the true fixture value, 60,000 credits / $600) --
    // simulating a plan staged earlier against state that has since moved,
    // without any test-only injection hook in the write engine. The engine's
    // own re-read + re-diff computes the TRUE current plan (old: 60,000) and
    // finds it doesn't match this staged plan, so it aborts as drift.
    const staleStagedPlan: Plan = {
      isNoOp: false,
      entries: [
        {
          id: 'budget:cost_center:Platform',
          controlKind: 'budget',
          action: 'change',
          scope: 'cost_center',
          entityName: 'Platform',
          changes: [{ field: 'amountCredits', old: 999_999, new: 65_000 }],
        },
      ],
    };

    const result = await window.evaluate(
      (args) => (window as unknown as { api: Api }).api.applyPlan(args.plan, args.desired, { actor: 'e2e-test@example.com' }),
      { plan: staleStagedPlan, desired: desiredControls },
    );

    expect(result.status).toBe('drift');
    if (result.status !== 'drift') throw new Error(`expected 'drift', got ${result.status}`);
    expect(result.currentPlan.entries[0]).toMatchObject({
      changes: [{ field: 'amountCredits', old: 60_000, new: 65_000 }],
    });
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
