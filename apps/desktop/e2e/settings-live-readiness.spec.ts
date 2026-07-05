import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

// Task 9.1/9.2-prep: the live-read-test-readiness surface on the Settings
// screen (tenant config, PAT validation, live read smoke), driven through the
// REAL rendered UI end to end against MSW -- everything here is sim-mode
// drivable (no live GitHub, no real PAT).

interface Launched {
  app: ElectronApplication;
  window: Page;
  cleanup: () => void;
}

async function launch(): Promise<Launched> {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-live-ready-'));
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-live-ready-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });
  const window = await app.firstWindow();
  await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();
  return {
    app,
    window,
    cleanup: () => {
      rmSync(dbDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function validatePatViaUi(window: Page): Promise<void> {
  await window.getByRole('button', { name: /validate token/i }).click();
  await expect(window.getByTestId('pat-validation')).toBeVisible();
}

test('Tenant config round-trips through the Settings UI', async () => {
  const { app, window, cleanup } = await launch();
  try {
    // Switch to a GHE.com tenant, fill the subdomain + slug, and save.
    await window.locator('#host-kind').selectOption('ghe.com');
    await window.locator('#ghe-subdomain').fill('acme');
    await window.locator('#enterprise-slug').fill('acme-enterprise');
    await window.getByRole('button', { name: /save tenant/i }).click();
    await expect(window.getByTestId('tenant-message')).toHaveText(/saved/i);

    // Prove persistence crossed preload -> main -> JSON store -> back.
    const stored = await window.evaluate(() =>
      (window as unknown as { api: { getTenantConfig(): Promise<unknown> } }).api.getTenantConfig(),
    );
    expect(stored).toEqual({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'acme-enterprise' });
  } finally {
    await app.close();
    cleanup();
  }
});

test('validatePat classifies classic-with-scope, fine-grained, and invalid tokens vs MSW', async () => {
  const { app, window, cleanup } = await launch();
  try {
    // Classic PAT carrying manage_billing:enterprise -> classic, present, ok.
    await window.getByLabel(/personal access token/i).fill('ghp_classicWithScope');
    await window.getByRole('button', { name: /save token/i }).click();
    await expect(window.getByText(/pat stored/i)).toBeVisible();
    await validatePatViaUi(window);
    await expect(window.getByTestId('pat-validation')).toContainText('classic');
    await expect(window.getByTestId('pat-validation')).toContainText('present');

    // Fine-grained token (github_pat_ prefix) -> no X-OAuth-Scopes header.
    await window.getByRole('button', { name: /clear token/i }).click();
    await window.getByLabel(/personal access token/i).fill('github_pat_fineGrained11');
    await window.getByRole('button', { name: /save token/i }).click();
    await validatePatViaUi(window);
    await expect(window.getByTestId('pat-validation')).toContainText('fine_grained');
    await expect(window.getByTestId('pat-validation')).toContainText('absent');

    // Rejected token -> 401 -> invalid.
    await window.getByRole('button', { name: /clear token/i }).click();
    await window.getByLabel(/personal access token/i).fill('ghp_invalidToken');
    await window.getByRole('button', { name: /save token/i }).click();
    await validatePatViaUi(window);
    await expect(window.getByTestId('pat-validation')).toContainText('invalid');
  } finally {
    await app.close();
    cleanup();
  }
});

test('Live read smoke is refused and disabled in simulation mode', async () => {
  const { app, window, cleanup } = await launch();
  try {
    // The explanatory note is visible and the run button is disabled -- the
    // action must never look live in simulation (CLAUDE.md §6.8).
    await expect(window.getByTestId('smoke-sim-note')).toBeVisible();
    await expect(window.getByRole('button', { name: /run live read smoke/i })).toBeDisabled();

    // The bridge itself refuses without contacting GitHub (the ratified gate).
    const result = await window.evaluate(() =>
      (window as unknown as { api: { runLiveReadSmoke(): Promise<unknown> } }).api.runLiveReadSmoke(),
    );
    expect(result).toEqual({ refused: true, reason: 'simulation mode' });
  } finally {
    await app.close();
    cleanup();
  }
});
