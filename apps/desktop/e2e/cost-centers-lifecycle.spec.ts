import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 4.13: cost-center lifecycle writes (create, membership add/remove,
// archive/delete, exclude toggle, 1:1 reassignment) end to end. Driven the
// same two ways the rest of Phase 4 is gated:
//   1. Through window.api (preload -> IPC -> main -> engine -> MSW) for the
//      byte-exact request SEQUENCE + audit assertions -- the deterministic
//      gate. This mirrors packages/data's engine.test.ts vitest coverage but
//      across the real preload boundary (CLAUDE.md §6.7). Specs can't import
//      @copilot-budget/data (ESM-only under Playwright's CJS transform -- see
//      write-engine.spec.ts), so the plan is shaped in Node from the live
//      getControls() projection, exactly as the UI modals do.
//   2. Through the actual UI (New-CC modal, Users reassignment select) for the
//      staged -> dry-run -> apply -> §6.8-simulated render.
//
// Every cost-center mutation rides the SAME dryRunPlan/applyPlan bridge methods
// as budgets/caps -- no new ApiClient surface. Fixture ids mirror
// packages/data/src/msw/fixtures/constants.ts (COST_CENTER_IDS); the mock
// resets to fixtures on each app launch, so one app per test is a known state.

const WORKFORCE_CC = 'Workforce Australia Platform';
const CYBER_CC = 'Cyber & Identity Services';
const WORKFORCE_ID = 'cc-workforce-australia';
const CYBER_ID = 'cc-cyber-identity';

interface CostCenterResourceRef {
  type: 'User' | 'Org' | 'Repo' | 'EnterpriseTeam';
  name: string;
}

interface ControlState {
  kind: 'budget' | 'included_cap' | 'cost_center';
  name?: string;
  members?: CostCenterResourceRef[];
  excludedFromEnterpriseBudget?: boolean;
  [key: string]: unknown;
}

interface Plan {
  entries: Array<{ id: string; controlKind: string; action: string; [key: string]: unknown }>;
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
  responseBody: unknown;
}

interface AppliedAuditEvent {
  id: number;
  action: string;
  entityRef: string;
  before: unknown;
  after: unknown;
}

type ApplyPlanResult =
  | { status: 'applied'; appliedCount: number; mutationLog: MutationLogEntry[]; auditEvents: AppliedAuditEvent[] }
  | { status: 'drift' }
  | { status: 'blocked' }
  | { status: 'partial_failure' };

interface Api {
  getControls(): Promise<ControlState[]>;
  dryRunPlan(desired: readonly ControlState[]): Promise<DryRunResult>;
  applyPlan(
    plan: Plan,
    desired: readonly ControlState[],
    input: { actor: string; justification?: string | null },
  ): Promise<ApplyPlanResult>;
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

function capLimit(mutation: MutationLogEntry): number {
  return (mutation.responseBody as { included_usage_cap: { computed_limit_credits: number } }).included_usage_cap
    .computed_limit_credits;
}

// Membership (resource) mutation responses are the OpenAPI-pinned envelopes
// (wire-contract-writes.md §3: add -> {message, reassigned_resources|null},
// remove -> {message}); the recomputed-limit observability (Task 4.2
// criterion) rides alongside under the sim-flagged
// `simulated_included_usage_cap` key.
function simCapLimit(mutation: MutationLogEntry): number {
  return (mutation.responseBody as { simulated_included_usage_cap: { computed_limit_credits: number } })
    .simulated_included_usage_cap.computed_limit_credits;
}

// --- window.api sequence gate ---------------------------------------------

test('create: a new cost center POSTs /cost-centers with the exact payload and audits cost_center.create', async () => {
  const { app, dbDir } = await launchApp('cc-create');
  try {
    const window = await app.firstWindow();
    const live = await window.evaluate(() => (window as unknown as { api: Api }).api.getControls());

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
    const desired = [...live, newCC];

    const dryRun = await window.evaluate((d) => (window as unknown as { api: Api }).api.dryRunPlan(d), desired);
    expect(dryRun.plan.entries).toHaveLength(1);
    expect(dryRun.plan.entries[0]).toMatchObject({
      controlKind: 'cost_center',
      action: 'add',
      name: 'New Delivery Team',
    });
    expect(dryRun.validation.isBlocked).toBe(false);

    const applied = await window.evaluate(
      (a) => (window as unknown as { api: Api }).api.applyPlan(a.plan, a.desired, { actor: 'e2e-test@example.com' }),
      { plan: dryRun.plan, desired },
    );
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`);

    expect(applied.mutationLog).toHaveLength(1);
    const mutation = applied.mutationLog[0]!;
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
    // The MSW create echoes the license-derived cap (1 seat x 7,000).
    expect(capLimit(mutation)).toBe(7_000);

    expect(applied.auditEvents).toHaveLength(1);
    expect(applied.auditEvents[0]!.action).toBe('cost_center.create');
    expect(applied.auditEvents[0]!.entityRef).toBe('cost_center:New Delivery Team');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('membership: a single-CC add+remove issues DELETE then POST /resource (removal first) with recomputed limits', async () => {
  const { app, dbDir } = await launchApp('cc-membership');
  try {
    const window = await app.firstWindow();
    const live = await window.evaluate(() => (window as unknown as { api: Api }).api.getControls());

    const desired = live.map((c) =>
      c.kind === 'cost_center' && c.name === WORKFORCE_CC
        ? { ...c, members: (c.members ?? []).filter((m) => m.name !== 'rpatel2').concat([{ type: 'User' as const, name: 'new-hire' }]) }
        : c,
    );

    const dryRun = await window.evaluate((d) => (window as unknown as { api: Api }).api.dryRunPlan(d), desired);
    const applied = await window.evaluate(
      (a) => (window as unknown as { api: Api }).api.applyPlan(a.plan, a.desired, { actor: 'e2e-test@example.com' }),
      { plan: dryRun.plan, desired },
    );
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`);

    // Removal (DELETE) precedes addition (POST) so a resource is never briefly
    // double-attributed.
    expect(applied.mutationLog).toHaveLength(2);
    const [remove, add] = applied.mutationLog;
    // OpenAPI-pinned four-array bodies (wire-contract-writes.md §3) -- the
    // invented {resources:[{type,name}]} shape is gone.
    expect(remove!.method).toBe('DELETE');
    expect(remove!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));
    expect(remove!.requestBody).toEqual({ users: ['rpatel2'] });
    expect(add!.method).toBe('POST');
    expect(add!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));
    expect(add!.requestBody).toEqual({ users: ['new-hire'] });

    // The recomputed, license-derived cap limit is observable in the mutation
    // responses (24 + 1 = 25 seats x 7,000 = 175,000 on add; 24 - 1 = 161,000
    // on remove) -- evidence the UI surfaces in its mutation log, riding the
    // real envelope under the sim-flagged key (see simCapLimit).
    expect(simCapLimit(add!)).toBe(175_000);
    expect(simCapLimit(remove!)).toBe(161_000);

    expect(applied.auditEvents).toHaveLength(1);
    expect(applied.auditEvents[0]!.action).toBe('cost_center.membership');
    expect(applied.auditEvents[0]!.entityRef).toBe(`cost_center:${WORKFORCE_CC}`);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('reassign: a 1:1 move issues DELETE(old)/resource then POST(new)/resource in that sequence + two membership audits', async () => {
  const { app, dbDir } = await launchApp('cc-reassign');
  try {
    const window = await app.firstWindow();
    const live = await window.evaluate(() => (window as unknown as { api: Api }).api.getControls());

    const desired = live.map((c) => {
      if (c.kind === 'cost_center' && c.name === WORKFORCE_CC) {
        return { ...c, members: (c.members ?? []).filter((m) => m.name !== 'rpatel2') };
      }
      if (c.kind === 'cost_center' && c.name === CYBER_CC) {
        return { ...c, members: [...(c.members ?? []), { type: 'User' as const, name: 'rpatel2' }] };
      }
      return c;
    });

    const dryRun = await window.evaluate((d) => (window as unknown as { api: Api }).api.dryRunPlan(d), desired);
    // Two cost_center change entries (id-sorted: Cyber before Workforce); the
    // executor reorders to removal-first at apply.
    expect(dryRun.plan.entries.map((e) => e.id)).toEqual([`cost_center:${CYBER_CC}`, `cost_center:${WORKFORCE_CC}`]);

    const applied = await window.evaluate(
      (a) => (window as unknown as { api: Api }).api.applyPlan(a.plan, a.desired, { actor: 'e2e-test@example.com' }),
      { plan: dryRun.plan, desired },
    );
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`);

    expect(applied.mutationLog).toHaveLength(2);
    const [remove, add] = applied.mutationLog;
    // Remove from the OLD cost center first, then add to the NEW one.
    expect(remove!.method).toBe('DELETE');
    expect(remove!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}/resource$`));
    expect(remove!.requestBody).toEqual({ users: ['rpatel2'] }); // four-array wire body (§3)
    expect(add!.method).toBe('POST');
    expect(add!.path).toMatch(new RegExp(`/cost-centers/${CYBER_ID}/resource$`));
    expect(add!.requestBody).toEqual({ users: ['rpatel2'] });

    // One audit per touched cost center, in apply (removal-first) order.
    expect(applied.auditEvents.map((e) => e.entityRef)).toEqual([
      `cost_center:${WORKFORCE_CC}`,
      `cost_center:${CYBER_CC}`,
    ]);
    expect(applied.auditEvents.every((e) => e.action === 'cost_center.membership')).toBe(true);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('exclude toggle: a PATCH carries only excluded_from_enterprise_budget and audits cost_center.update', async () => {
  const { app, dbDir } = await launchApp('cc-exclude');
  try {
    const window = await app.firstWindow();
    const live = await window.evaluate(() => (window as unknown as { api: Api }).api.getControls());

    const desired = live.map((c) =>
      c.kind === 'cost_center' && c.name === WORKFORCE_CC ? { ...c, excludedFromEnterpriseBudget: true } : c,
    );

    const dryRun = await window.evaluate((d) => (window as unknown as { api: Api }).api.dryRunPlan(d), desired);
    const applied = await window.evaluate(
      (a) => (window as unknown as { api: Api }).api.applyPlan(a.plan, a.desired, { actor: 'e2e-test@example.com' }),
      { plan: dryRun.plan, desired },
    );
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`);

    expect(applied.mutationLog).toHaveLength(1);
    expect(applied.mutationLog[0]!.method).toBe('PATCH');
    expect(applied.mutationLog[0]!.path).toMatch(new RegExp(`/cost-centers/${WORKFORCE_ID}$`));
    expect(applied.mutationLog[0]!.requestBody).toEqual({ excluded_from_enterprise_budget: true });
    expect(applied.auditEvents[0]!.action).toBe('cost_center.update');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// --- UI-driven flows -------------------------------------------------------

test('UI: "+ New cost center" modal stages a create, dry-runs, and applies (simulated) end to end', async () => {
  const { app, dbDir } = await launchApp('cc-create-ui');
  try {
    const window = await app.firstWindow();
    await window.locator('.nav').getByRole('button', { name: 'Cost centers' }).click();
    await expect(window.locator('.cost-centers')).toBeVisible();

    await window.getByRole('button', { name: '+ New cost center' }).click();
    const modal = window.getByRole('dialog', { name: 'New cost center' });
    await expect(modal).toBeVisible();

    await modal.getByLabel('Cost center name').fill('QA Sandbox Team');
    await modal.getByLabel('DEWR division').fill('Digital & Technology Group');
    await modal.getByLabel('DEWR branch').fill('Platform Enablement Branch');
    await modal.getByLabel('DEWR project').fill('QA-SANDBOX');

    // The staged create shows as a terraform-style add line before any write.
    const diff = modal.locator('.plan-rail__diff');
    await expect(diff).toContainText('cost_center["QA Sandbox Team"]');
    await expect(diff).toContainText('create');

    await modal.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await modal.locator('#cc-plan-rail-justification').fill('Stand up a QA sandbox cost center.');

    // §6.8: in simulation mode the apply affordance reads as simulated.
    const applyBtn = modal.getByRole('button', { name: 'Apply changes (simulated)' });
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    const applied = modal.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('Simulated apply');
    // The mutation log surfaces the real POST issued to the mock GitHub API.
    await expect(applied.locator('.plan-rail__mutation')).toContainText('POST');
    await expect(applied.locator('.plan-rail__mutation')).toContainText('/cost-centers');
    // And an audit event landed.
    await expect(applied.locator('.plan-rail__audit')).toContainText('cost_center.create');

    // Parent toast confirms + is §6.8-worded.
    await expect(window.locator('.cost-centers-toast')).toContainText('Simulated apply');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('UI: drilling into a CC and adding an already-assigned user MOVES them (DELETE old CC, then POST new CC)', async () => {
  const { app, dbDir } = await launchApp('cc-drill-move');
  try {
    const window = await app.firstWindow();
    await window.locator('.nav').getByRole('button', { name: 'Cost centers' }).click();
    await expect(window.locator('.cost-centers')).toBeVisible();

    // Drill into Workforce (row 0) and add ruby-carter, who currently belongs
    // to Cyber & Identity Services -- so this add must resolve as a MOVE.
    await window.locator('.cc-table__row').nth(0).click();
    const modal = window.getByRole('dialog', { name: WORKFORCE_CC });
    await expect(modal).toBeVisible();
    await expect(modal.locator('.cc-members-editor__row')).toHaveCount(24);

    // Maintainer UX addition: the add-member picker is a searchable combobox,
    // not a <select>. Type-to-filter narrows the 81-seat roster to ruby-carter,
    // whose option surfaces her current cost center; picking it stages the move.
    const addInput = modal.getByLabel('Add member');
    await addInput.fill('ruby');
    const rubyOption = modal.getByRole('option', { name: /ruby-carter/ });
    await expect(rubyOption).toBeVisible();
    await expect(rubyOption).toContainText(`currently ${CYBER_CC}`);
    // The filter genuinely narrows the list (a non-matching login is gone).
    await expect(modal.getByRole('option', { name: /sam-kelly/ })).toHaveCount(0);
    await rubyOption.click();

    // The staged row reads as a move, not a bare add.
    const rubyRow = modal.locator('.cc-members-editor__row').filter({ hasText: 'ruby-carter' });
    await expect(rubyRow.locator('.cc-members-editor__type-badge')).toContainText(`moves from ${CYBER_CC}`);

    // The diff represents BOTH sides + the -7,000 / +7,000 cap shift preview.
    const diff = modal.locator('.plan-rail__diff');
    await expect(diff).toContainText(`- cost_center["${CYBER_CC}"].member: ruby-carter`);
    await expect(diff).toContainText(`+ cost_center["${WORKFORCE_CC}"].member: ruby-carter`);
    await expect(diff).toContainText(`included_cap["${CYBER_CC}"]: −7,000 credits`);
    await expect(diff).toContainText(`included_cap["${WORKFORCE_CC}"]: +7,000 credits`);

    await modal.getByRole('button', { name: 'Run dry-run simulation' }).click();
    await modal.locator('#cc-plan-rail-justification').fill('Reorg: ruby-carter moves to Workforce.');
    await modal.getByRole('button', { name: 'Apply changes (simulated)' }).click();

    const applied = modal.locator('.plan-rail__result--applied');
    await expect(applied).toBeVisible();
    // The wire sequence: remove from the OLD cost center FIRST, then add to the
    // new one -- same two-op rigor as the Users-row reassignment (shared path).
    const mutations = applied.locator('.plan-rail__mutation');
    await expect(mutations).toHaveCount(2);
    await expect(mutations.nth(0)).toContainText('DELETE');
    await expect(mutations.nth(0)).toContainText(`/cost-centers/${CYBER_ID}/resource`);
    await expect(mutations.nth(1)).toContainText('POST');
    await expect(mutations.nth(1)).toContainText(`/cost-centers/${WORKFORCE_ID}/resource`);
    // One audit per touched cost center, both membership.
    await expect(applied.locator('.plan-rail__audit')).toHaveCount(2);
    await expect(applied.locator('.plan-rail__audit').nth(0)).toContainText('cost_center.membership');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('UI: the Users cost-center select opens the reassignment plan for that user', async () => {
  const { app, dbDir } = await launchApp('cc-reassign-ui');
  try {
    const window = await app.firstWindow();
    await window.locator('.nav').getByRole('button', { name: 'Users' }).click();
    await expect(window.locator('.users')).toBeVisible();

    // Isolate rpatel2 (Workforce) and move them to Cyber via the row select.
    await window.getByLabel('Search login').fill('rpatel2');
    const row = window.locator('.users-table__row');
    await expect(row).toHaveCount(1);
    await row.getByLabel('Cost center for rpatel2').selectOption('Cyber & Identity Services');

    const modal = window.getByRole('dialog', { name: 'Reassign rpatel2' });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Workforce Australia Platform');
    await expect(modal).toContainText('Cyber & Identity Services');

    await modal.getByRole('button', { name: 'Run dry-run simulation' }).click();
    // The move is exactly two membership deltas: - old.member, + new.member.
    const diff = modal.locator('.plan-rail__diff');
    await expect(diff.locator('.plan-rail__diff-line--delete')).toContainText('rpatel2');
    await expect(diff.locator('.plan-rail__diff-line--add')).toContainText('rpatel2');

    await modal.locator('#cc-plan-rail-justification').fill('Reorg: rpatel2 joins Cyber.');
    await modal.getByRole('button', { name: 'Apply changes (simulated)' }).click();
    await expect(modal.locator('.plan-rail__result--applied')).toBeVisible();
    await expect(window.locator('.users-toast')).toContainText('moved to');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
