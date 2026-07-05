import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

// Task 4.15: syncNow now ingests budgets + cap state into an append-only
// `control_snapshot` row per generation (packages/data/src/sync/sync-now.ts,
// schema.ts), and the Controls screen renders a browse-time
// "⤺ drift — reconcile" marker (core's driftedControlIds, the SAME
// diffControls comparator applyPlan's §6.2 apply-time drift-abort and this
// screen's own "● staged change" marker both already use) wherever a fresh
// live read disagrees with that last-synced baseline. Distinct from the
// existing apply-time drift-abort (PlanRail's onReconcileDrift / §6.2 -- that
// fires only mid-Apply, when the write engine's OWN re-read moves under a
// staged plan): this one is purely browse-time, comparing two READS.
//
// MSW is deliberately STATELESS (CLAUDE.md §7) -- it resets to fixtures every
// run and can never actually drift on its own, so this spec arranges a
// believable out-of-band drift by mutating the PERSISTED last-synced
// snapshot directly (via e2e/support/mutate-last-synced-*.cjs), never by
// touching MSW or adding any production code path. This mirrors packages/
// data/src/audit/writer.test.ts's own "directly UPDATE a stored column,
// bypassing the writer" tamper-test precedent for the SAME append-only-table
// reason: control_snapshot has exactly one writer in every real code path
// (sync-now.ts), and the mutation happens strictly in the test's ARRANGE
// phase, on a scratch sqlite file this test alone owns, exactly like sync-
// now.test.ts's own DB-seeding precedent for data-layer integration tests.
//
// The mutate scripts are plain CJS and must run under Electron's OWN bundled
// Node (`ELECTRON_RUN_AS_NODE=1 <electron binary> <script>`), never plain
// system Node: apps/desktop's `e2e` script's `rebuild:electron` pre-step
// (root CLAUDE.md's better-sqlite3 ABI note) leaves the one shared
// better-sqlite3 native module compiled for Electron's ABI for the whole
// `pnpm e2e` run, so requiring it from plain Node would throw a
// NODE_MODULE_VERSION mismatch -- the exact reason sync-now.spec.ts's own
// header comment gives for verifying ingestion through the app's IPC surface
// rather than opening the sqlite file directly from the Playwright process.
// Resolving the electron binary's own path is done via a SEPARATE plain-node
// subprocess (electron's npm package is just a tiny path-resolution shim,
// not a native module, so plain Node is safe for that one step only).
//
// Fixture basis (matches controls-scale.spec.ts's header derivation): ULB tab
// page 1 (default, unsorted/unfiltered) includes declan-ryan (individual,
// 2,500 credits) and nina-popov (individual, 4,800 credits), both on page 1
// of 2. Included-usage caps: Cyber & Identity Services (enabled, overflow
// 'block' -- controls-caps.spec.ts's header derivation).

function resolveElectronBinaryPath(appDir: string): string {
  // Plain Node, not Electron: electron's npm package `main` is a small
  // platform-resolution shim (reads a bundled path.txt), no native code --
  // safe to resolve from whichever Node is running the test process.
  return execFileSync('node', ['-e', "process.stdout.write(require('electron'))"], { cwd: appDir }).toString();
}

function mutateLastSyncedBudget(
  electronBinaryPath: string,
  dbPath: string,
  scope: string,
  entityName: string,
  newAmountCredits: number,
): void {
  const script = path.join(__dirname, 'support', 'mutate-last-synced-budget.cjs');
  execFileSync(electronBinaryPath, [script, dbPath, scope, entityName, String(newAmountCredits)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function mutateLastSyncedCap(electronBinaryPath: string, dbPath: string, costCenterName: string, newEnabled: boolean): void {
  const script = path.join(__dirname, 'support', 'mutate-last-synced-cap.cjs');
  execFileSync(electronBinaryPath, [script, dbPath, costCenterName, String(newEnabled)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

async function launchAppAtDbPath(dbPath: string): Promise<ElectronApplication> {
  const appDir = path.join(__dirname, '..');
  return electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: dbPath },
  });
}

async function openControlsUlb(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Controls');
  await expect(window.getByText('Always a hard stop — a $0 ULB blocks immediately.')).toBeVisible();
}

async function openControlsCaps(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(window.locator('.app-shell__title')).toHaveText('Controls');
  await window.getByRole('tab', { name: 'Included-usage caps' }).click();
  await expect(window.getByText(/auto-computed from attributed licenses; choose block or overflow\./)).toBeVisible();
}

// Sync via the Settings screen (Task 1.6/1.7's human-operable Sync Now),
// exactly as the task brief calls for -- not window.api.syncNow() directly --
// so the drift baseline this spec arranges is captured through the same path
// a real admin would use.
async function syncViaSettings(window: Page): Promise<void> {
  await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();
  await window.getByRole('button', { name: /sync now/i }).click();
  await expect(window.getByText(/last synced:/i)).toBeVisible();
}

test('sync via Settings, then neither the ULB, Spending, nor Caps tabs show any drift marker (synced == live)', async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-drift-none-'));
  const dbPath = path.join(dbDir, 'test.sqlite');
  const app = await launchAppAtDbPath(dbPath);
  try {
    const window = await app.firstWindow();
    await syncViaSettings(window);

    await openControlsUlb(window);
    await expect(window.locator('.controls-table__drift')).toHaveCount(0);
    await expect(window.locator('.controls-table__drift-collision')).toHaveCount(0);
    await expect(window.locator('.controls__hidden-drifted-note')).toHaveCount(0);

    await window.getByRole('tab', { name: 'Spending limits' }).click();
    await expect(window.locator('.controls-table__drift')).toHaveCount(0);

    await window.getByRole('tab', { name: 'Included-usage caps' }).click();
    await expect(window.locator('.controls-table__drift')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('a data-layer-arranged drift shows the marker + full-set honesty after relaunch; reconcile clears it; a staged edit on a DIFFERENT row survives', async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-drift-arrange-'));
  const dbPath = path.join(dbDir, 'test.sqlite');
  const appDir = path.join(__dirname, '..');
  const electronBinaryPath = resolveElectronBinaryPath(appDir);

  const firstApp = await launchAppAtDbPath(dbPath);
  try {
    const firstWindow = await firstApp.firstWindow();
    await syncViaSettings(firstWindow);
  } finally {
    // Close BEFORE mutating the file out of process, so there's no lock
    // contention between this test's own connection and the mutate script's.
    await firstApp.close();
  }

  // ARRANGE the drift: declan-ryan's persisted last-synced cap (2,500) now
  // disagrees with the live MSW fixture value (unchanged, still 2,500) --
  // the honest analogue of "someone changed this live, out of band, since
  // the last Sync Now" against a mock that can never actually do that itself.
  mutateLastSyncedBudget(electronBinaryPath, dbPath, 'individual', 'declan-ryan', 9999);

  const app = await launchAppAtDbPath(dbPath);
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const declanRow = table.locator('[data-control-id="budget:individual:declan-ryan"]');
    const ninaRow = table.locator('[data-control-id="budget:individual:nina-popov"]');

    // The drifted row shows the marker; an unrelated row does not.
    await expect(declanRow.locator('.controls-table__drift')).toHaveText('⤺ drift — reconcile');
    await expect(ninaRow.locator('.controls-table__drift')).toHaveCount(0);
    await expect(window.locator('.controls__hidden-drifted-note')).toHaveCount(0);

    // Full-set honesty: a scope filter that hides declan-ryan's (individual)
    // row must still report the drift via the hidden-drifted note -- counted
    // from the FULL set, never silently dropped because the current
    // filter/page doesn't happen to show it (mirrors hiddenStagedCount).
    await window.getByLabel('Filter by scope').selectOption('universal');
    await expect(declanRow).toHaveCount(0);
    await expect(window.locator('.controls__hidden-drifted-note')).toContainText(
      '1 drifted row not shown by the current search/filter/page',
    );

    // Clear the filter -- the row and its marker return.
    await window.getByLabel('Filter by scope').selectOption('all');
    await expect(declanRow.locator('.controls-table__drift')).toBeVisible();
    await expect(window.locator('.controls__hidden-drifted-note')).toHaveCount(0);

    // Stage an edit on a DIFFERENT row before reconciling the drifted one.
    await ninaRow.getByLabel('Cap (credits) — Individual · nina-popov').fill('5000');
    await expect(ninaRow.getByText('● staged change')).toBeVisible();

    // Reconcile the drifted row: declan-ryan has no staged edit of his own,
    // so this proceeds immediately (no collision prompt) -- refreshes live
    // state and suppresses the marker for this session.
    await declanRow.locator('.controls-table__drift').click();
    await expect(declanRow.locator('.controls-table__drift')).toHaveCount(0);
    await expect(declanRow.locator('.controls-table__drift-collision')).toHaveCount(0);

    // The unrelated staged edit survives untouched -- reconcile never
    // discards a staged edit, on this row or any other.
    await expect(ninaRow.getByText('● staged change')).toBeVisible();
    await expect(ninaRow.getByLabel('Cap (credits) — Individual · nina-popov')).toHaveValue('5000');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('a row that is BOTH staged and drifted requires a second confirmation, and "Cancel" leaves both markers intact', async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-drift-collision-'));
  const dbPath = path.join(dbDir, 'test.sqlite');
  const appDir = path.join(__dirname, '..');
  const electronBinaryPath = resolveElectronBinaryPath(appDir);

  const firstApp = await launchAppAtDbPath(dbPath);
  try {
    const firstWindow = await firstApp.firstWindow();
    await syncViaSettings(firstWindow);
  } finally {
    await firstApp.close();
  }

  mutateLastSyncedBudget(electronBinaryPath, dbPath, 'individual', 'declan-ryan', 9999);

  const app = await launchAppAtDbPath(dbPath);
  try {
    const window = await app.firstWindow();
    await openControlsUlb(window);

    const table = window.locator('.controls-table');
    const declanRow = table.locator('[data-control-id="budget:individual:declan-ryan"]');

    // Stage declan-ryan's OWN row first -- both markers now apply to it.
    await declanRow.getByLabel('Cap (credits) — Individual · declan-ryan').fill('3000');
    await expect(declanRow.getByText('● staged change')).toBeVisible();
    await expect(declanRow.locator('.controls-table__drift')).toHaveText('⤺ drift — reconcile');
    await expect(declanRow.locator('.controls-table__drift-collision')).toHaveCount(0);

    // First click never silently reconciles a staged+drifted row -- it only
    // raises the collision prompt.
    await declanRow.locator('.controls-table__drift').click();
    await expect(declanRow.locator('.controls-table__drift')).toHaveCount(0);
    const collision = declanRow.locator('.controls-table__drift-collision');
    await expect(collision).toBeVisible();
    await expect(collision).toContainText('This row also has a staged edit made before this drift was detected');

    // Cancel: nothing is reconciled -- the compact marker returns, the
    // staged edit is still there, untouched.
    await collision.getByRole('button', { name: 'Cancel' }).click();
    await expect(declanRow.locator('.controls-table__drift-collision')).toHaveCount(0);
    await expect(declanRow.locator('.controls-table__drift')).toHaveText('⤺ drift — reconcile');
    await expect(declanRow.getByText('● staged change')).toBeVisible();
    await expect(declanRow.getByLabel('Cap (credits) — Individual · declan-ryan')).toHaveValue('3000');

    // Re-open the prompt, then confirm via "Reconcile anyway": the drift
    // marker clears, but the staged edit survives -- reconciling drift never
    // discards a staged edit, even on the SAME row.
    await declanRow.locator('.controls-table__drift').click();
    await expect(declanRow.locator('.controls-table__drift-collision')).toBeVisible();
    await declanRow.getByRole('button', { name: '⤺ Reconcile anyway' }).click();

    await expect(declanRow.locator('.controls-table__drift')).toHaveCount(0);
    await expect(declanRow.locator('.controls-table__drift-collision')).toHaveCount(0);
    await expect(declanRow.getByText('● staged change')).toBeVisible();
    await expect(declanRow.getByLabel('Cap (credits) — Individual · declan-ryan')).toHaveValue('3000');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('the drift marker also renders on the Included-usage caps grid (cap-family control, not just budgets)', async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-drift-caps-'));
  const dbPath = path.join(dbDir, 'test.sqlite');
  const appDir = path.join(__dirname, '..');
  const electronBinaryPath = resolveElectronBinaryPath(appDir);

  const firstApp = await launchAppAtDbPath(dbPath);
  try {
    const firstWindow = await firstApp.firstWindow();
    await syncViaSettings(firstWindow);
  } finally {
    await firstApp.close();
  }

  // Cyber & Identity Services is enabled live (controls-caps.spec.ts's header
  // derivation) -- flip the PERSISTED last-synced copy to disabled so a fresh
  // live read disagrees with it.
  mutateLastSyncedCap(electronBinaryPath, dbPath, 'Cyber & Identity Services', false);

  const app = await launchAppAtDbPath(dbPath);
  try {
    const window = await app.firstWindow();
    await openControlsCaps(window);

    const grid = window.locator('.included-caps__grid');
    const cyberCard = grid.locator('[data-control-id="included_cap:Cyber & Identity Services"]');
    await expect(cyberCard.locator('.controls-table__drift')).toHaveText('⤺ drift — reconcile');

    // No staged edit on this card -- reconcile proceeds immediately.
    await cyberCard.locator('.controls-table__drift').click();
    await expect(cyberCard.locator('.controls-table__drift')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
