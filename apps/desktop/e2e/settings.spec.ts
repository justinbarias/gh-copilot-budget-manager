import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// This is the first spec that drives actual rendered UI (Task 1.7), rather
// than calling window.api directly -- the sim banner and Settings screen are
// real DOM, so Playwright locators exercise them the way a human would.
test('Sim banner is always visible and Settings drives PAT + Sync Now', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-settings-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // CLAUDE.md §6.8: unmistakable, persistent -- always on for MVP.
    await expect(window.getByText(/simulation mode/i)).toBeVisible();

    // Navigate to the Settings screen via the Task 2.5 nav shell.
    await window.locator('.nav').getByRole('button', { name: 'Settings' }).click();

    // No PAT stored yet.
    await expect(window.getByText(/no pat stored/i)).toBeVisible();

    await window.getByLabel(/personal access token/i).fill('ghp_e2eSentinelToken123');
    await window.getByRole('button', { name: /save token/i }).click();
    await expect(window.getByText(/pat stored/i)).toBeVisible();

    await window.getByRole('button', { name: /clear token/i }).click();
    await expect(window.getByText(/no pat stored/i)).toBeVisible();

    // Sync Now: human-operable trigger wired to Task 1.6's syncNow/getSyncStatus.
    await expect(window.getByText(/never synced/i)).toBeVisible();
    await window.getByRole('button', { name: /sync now/i }).click();
    await expect(window.getByText(/last synced:/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
