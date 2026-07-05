import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 8.4/8.5: the Audit screen (immutable, filterable hash-chain stream)
// and its Task 8.5 export/verify surface, driven through the REAL UI, end to
// end against MSW -- reusing controls.spec.ts's exact stage -> dry-run ->
// apply scenario to seed one real, fixture-derived audit event rather than
// inventing new expected values:
//
//   - Workforce Australia Platform cost-center spending limit: 60,000 ->
//     65,000 credits (the same edit controls.spec.ts's first test makes).
//   - That edit is a 'change' on a `cost_center`-SCOPE budget -- NOT a ULB
//     scope -- so it lands in Audit's 'budget' family filter, not 'ulb' (see
//     Audit.tsx's `auditEventFamily` doc comment for the family split).
//   - Resulting audit event: action 'budget.update', entityRef
//     'budget:cost_center:Workforce Australia Platform', actor
//     'you (FinOps)' (Controls.tsx's placeholder ACTOR), prevHash == the
//     genesis sentinel 'AUDIT_CHAIN_GENESIS' (the very first event on a
//     fresh DB), before.amountCredits 60000 -> after.amountCredits 65000.
//
// Export downloads are asserted by polling a per-test, isolated downloads
// directory on disk -- NOT via Playwright's `page.waitForEvent('download')`.
// That API never fires for Electron windows (confirmed empirically while
// building this spec: the file completes on disk via main/index.ts's
// `will-download` handler, but Playwright's own download event never
// arrives for an Electron-hosted Page). Isolating the downloads directory
// per test (COPILOT_BUDGET_DOWNLOADS_PATH, mirroring COPILOT_BUDGET_DB_PATH)
// keeps this deterministic and side-effect-free on the real machine.

const AUDIT_CHAIN_GENESIS_PREV_HASH = 'AUDIT_CHAIN_GENESIS';

async function launchApp(dbLabel: string) {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), `copilot-budget-e2e-${dbLabel}-`));
  const downloadsDir = mkdtempSync(path.join(tmpdir(), `copilot-budget-e2e-${dbLabel}-downloads-`));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: {
      ...process.env,
      COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite'),
      COPILOT_BUDGET_DOWNLOADS_PATH: downloadsDir,
    },
  });
  return { app, dbDir, downloadsDir };
}

async function openControls(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Controls');
  await window.getByRole('tab', { name: 'Spending limits' }).click();
  await expect(window.getByText(/Cap metered charges only/)).toBeVisible();
}

async function openAudit(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Audit');
}

// Stages, dry-runs, and applies the exact Workforce cap raise (60,000 ->
// 65,000) controls.spec.ts's first test performs -- one real, audited change.
async function applyWorkforceCapRaise(window: Page): Promise<void> {
  await openControls(window);
  const table = window.locator('.controls-table');
  const workforceRow = table.locator('[data-control-id="budget:cost_center:Workforce Australia Platform"]');
  await workforceRow.getByLabel('Cap (credits) — CC: Workforce Australia Platform').fill('65000');

  const rail = window.locator('.plan-rail');
  await rail.getByRole('button', { name: 'Run dry-run simulation' }).click();
  await rail.getByLabel('Justification (required)').fill('e2e: raise Workforce metered cap for Q1 crunch');
  const applyButton = rail.getByRole('button', { name: /Apply changes/ });
  await expect(applyButton).toBeEnabled();
  await applyButton.click();
  await expect(rail.locator('.plan-rail__result--applied')).toBeVisible();
}

// Polls `downloadsDir` for a file matching `pattern` -- the workaround for
// Playwright's `page.waitForEvent('download')` not firing for Electron
// windows (see this file's top comment).
async function waitForDownloadedFile(downloadsDir: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = readdirSync(downloadsDir).find((name) => pattern.test(name));
    if (match) return path.join(downloadsDir, match);
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for a file matching ${pattern} in ${downloadsDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('pre-apply, fresh DB: the Audit screen renders an honest empty state', async () => {
  const { app, dbDir, downloadsDir } = await launchApp('audit-empty');
  try {
    const window = await app.firstWindow();
    await openAudit(window);

    await expect(window.getByTestId('audit-empty')).toHaveText('No audit events yet.');
    await expect(window.getByTestId('audit-event')).toHaveCount(0);

    // Filter chips are still all present and clickable on an empty chain --
    // switching to Auto-balance (permanently empty until Phase 6/7) shows
    // ITS OWN honest empty copy, not a generic/broken one.
    await window.getByTestId('audit-filter-autobalance').click();
    await expect(window.getByTestId('audit-empty')).toContainText('Phase 6/7');

    // Verify chain on a genuinely empty chain trivially passes (0 events).
    await window.getByTestId('audit-verify-button').click();
    await expect(window.getByTestId('audit-verify-result')).toHaveText('✓ 0 events, chain intact');

    // Nothing to export yet.
    await expect(window.getByTestId('audit-export-json')).toBeDisabled();
    await expect(window.getByTestId('audit-export-csv')).toBeDisabled();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test('seeded event: renders newest-first, correct family filtering, before->after expansion, verify pass, and JSON+CSV export downloads', async () => {
  const { app, dbDir, downloadsDir } = await launchApp('audit-seeded');
  try {
    const window = await app.firstWindow();

    await applyWorkforceCapRaise(window);
    await openAudit(window);

    // Exactly one event; visible under 'All'.
    const rows = window.getByTestId('audit-event');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toContainText('budget.update');
    await expect(row).toContainText('budget:cost_center:Workforce Australia Platform');
    await expect(row).toContainText('you (FinOps)');

    // Family filtering: a cost_center-SCOPE budget edit is 'budget' family,
    // not 'ulb' (see Audit.tsx's auditEventFamily doc comment).
    await window.getByTestId('audit-filter-ulb').click();
    await expect(window.getByTestId('audit-event')).toHaveCount(0);
    await expect(window.getByTestId('audit-empty')).toHaveText('No user-level-budget events yet.');

    await window.getByTestId('audit-filter-budget').click();
    await expect(window.getByTestId('audit-event')).toHaveCount(1);

    await window.getByTestId('audit-filter-autobalance').click();
    await expect(window.getByTestId('audit-event')).toHaveCount(0);

    await window.getByTestId('audit-filter-all').click();
    await expect(window.getByTestId('audit-event')).toHaveCount(1);

    // Expansion: before/after literals, mono, red/green -- the exact
    // fixture-derived 60,000 -> 65,000 credit change.
    await row.getByTestId('audit-event-toggle').click();
    const expansion = window.getByTestId('audit-event-expansion');
    await expect(expansion).toBeVisible();
    await expect(expansion.locator('.audit-event__diff-value--before')).toContainText('"amountCredits": 60000');
    await expect(expansion.locator('.audit-event__diff-value--after')).toContainText('"amountCredits": 65000');
    await expect(expansion).toContainText('e2e: raise Workforce metered cap for Q1 crunch');
    // No envelope/binding-constraint block for a manual (non-rebalancer) apply.
    await expect(window.getByTestId('audit-event-envelope')).toHaveCount(0);

    // Per-row chain-intact indicator, driven by the auto-run verification on mount.
    await expect(row.locator('.audit-event__chain--intact')).toBeVisible();

    // Task 8.5: explicit "Verify chain" action -- green pass state with the
    // correct event count.
    await window.getByTestId('audit-verify-button').click();
    await expect(window.getByTestId('audit-verify-result')).toHaveText('✓ 1 event, chain intact');

    // Task 8.5: JSON export -- a real download (see this file's top comment
    // for why this polls disk instead of a Playwright download event),
    // parseable, containing the hash-chain fields and the exact seeded event.
    await window.getByTestId('audit-export-json').click();
    const jsonPath = await waitForDownloadedFile(downloadsDir, /^audit-chain-export-.*\.json$/);
    const exported = JSON.parse(readFileSync(jsonPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      id: 1,
      action: 'budget.update',
      entityRef: 'budget:cost_center:Workforce Australia Platform',
      actor: 'you (FinOps)',
      trigger: 'manual',
      justification: 'e2e: raise Workforce metered cap for Q1 crunch',
      prevHash: AUDIT_CHAIN_GENESIS_PREV_HASH,
    });
    expect(exported[0]!.hash).toEqual(expect.any(String));
    expect(String(exported[0]!.before)).toContain('"amountCredits":60000');
    expect(String(exported[0]!.after)).toContain('"amountCredits":65000');

    // Task 8.5: CSV export -- header + exactly one data row, every column.
    await window.getByTestId('audit-export-csv').click();
    const csvPath = await waitForDownloadedFile(downloadsDir, /^audit-chain-export-.*\.csv$/);
    const csvLines = readFileSync(csvPath, 'utf8').split('\r\n');
    expect(csvLines[0]).toBe(
      'id,ts,actor,action,entity_ref,trigger,envelope_snapshot,before,after,justification,data_snapshot_id,prev_hash,hash',
    );
    expect(csvLines).toHaveLength(2);
    expect(csvLines[1]).toContain('budget.update');
    expect(csvLines[1]).toContain(AUDIT_CHAIN_GENESIS_PREV_HASH);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(downloadsDir, { recursive: true, force: true });
  }
});
