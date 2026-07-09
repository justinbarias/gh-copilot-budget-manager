import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// 2026-07-09 Cost Centers live-correctness round, the edit-mapping flow
// (maintainer decision: the DEWR mapping is an APP-LOCAL construct -- live
// cost centers created outside the app carry none, so existing CCs need an
// edit affordance). Saving writes ONLY the local DB columns via the
// maintainer-sanctioned updateCostCenterMapping bridge method -- it never
// issues a GitHub request, which is why (unlike every other mutation on this
// screen) there is no dry-run/apply pipeline here. The saved mapping WINS
// over the simulation fixtures' wire enrichment, so this test's edit is
// observable against the fixture world.
test('drill-in "edit mapping" saves an app-local DEWR mapping and the table re-renders it', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-cc-mapping-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();
    await window.locator('.nav').getByRole('button', { name: 'Cost centers' }).click();
    const screen = window.locator('.cost-centers');
    await expect(screen).toBeVisible();

    // Cyber & Identity Services renders its fixture-enrichment mapping first.
    const rows = screen.locator('.cc-table__row');
    const cyber = rows.nth(4);
    await expect(cyber.locator('.cc-table__name')).toHaveText('Cyber & Identity Services');
    const originalMapping = await cyber.locator('.cc-table__mapping').innerText();
    expect(originalMapping).toContain('→');

    // Drill in and open the mapping editor from the header affordance.
    await cyber.click();
    const drill = window.locator('.drill-modal');
    await expect(drill).toBeVisible();
    await drill.getByRole('button', { name: 'Edit DEWR mapping — Cyber & Identity Services' }).click();

    const editor = window.getByRole('dialog', { name: 'Edit DEWR mapping — Cyber & Identity Services' });
    await expect(editor).toBeVisible();
    // The modal states the write's nature explicitly (§6.8-adjacent honesty).
    await expect(editor.getByText('App-local metadata only — saving never contacts GitHub.')).toBeVisible();

    await editor.getByLabel('DEWR division').fill('Corporate & Enabling Group');
    await editor.getByLabel('DEWR branch').fill('Cyber Security Branch');
    await editor.getByLabel('DEWR project').fill('CYB-EDIT');
    await editor.getByRole('button', { name: 'Save mapping' }).click();

    // Editor closes; the toast states the app-local nature; the drill header
    // and (after closing the drill) the table row both re-render the edit.
    await expect(editor).toHaveCount(0);
    await expect(window.locator('.cost-centers-toast')).toContainText('DEWR mapping saved (app-local — no GitHub change).');
    await expect(drill.locator('.drill-modal__mapping')).toContainText(
      'Corporate & Enabling Group → Cyber Security Branch → CYB-EDIT',
    );

    await drill.getByRole('button', { name: 'Close' }).click();
    await expect(cyber.locator('.cc-table__mapping')).toHaveText('Corporate & Enabling Group → Cyber Security Branch → CYB-EDIT');
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
