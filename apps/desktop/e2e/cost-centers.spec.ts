import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 2.3: Cost Centers screen -- read-only table + drill modal. Every
// asserted value is fixture-derived (packages/data/src/msw/fixtures/
// costCenters.ts + usage.ts), never wall-clock:
//   - 3 cost centers (platform, dataAnalytics, cap-bound) with 15/10/10
//     user members (COST_CENTER_RESOURCES).
//   - MTD burn is the fixture's GitHub-reported per-CC cycle total:
//     420 / 310 / 70,500 credits.
//   - Included-usage cap computed limits are license-derived read-only
//     values (promo enterprise 7,000/seat): 15*7000=105,000 / 10*7000=70,000
//     / 10*7000=70,000.
//   - headroom = computedLimit - mtdBurn (packages/core costCenter.ts):
//     104,580 / 69,690 / -500. The cap-bound row is the only negative one
//     -> red + "overrun" cue + "over cap" status; the others are 'ok'
//     (>= 8,000 low-headroom threshold from the design prototype) -> no cue.
//   - Drill member burn joins the credits-used fixture within the June 2026
//     cycle (SIM_CURRENT_DATE anchor): user-26 -> 500.
test('Cost Centers table renders fixture rows with fixture-derived headroom and status', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-cost-centers-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // Navigate to the Cost centers screen via the Task 2.5 nav shell.
    await window.locator('.nav').getByRole('button', { name: 'Cost centers' }).click();
    const screen = window.locator('.cost-centers');
    await expect(screen).toBeVisible();
    await expect(screen.getByText('3 cost centers · mapped to the DEWR financial structure')).toBeVisible();

    const rows = screen.locator('.cc-table__row');
    await expect(rows).toHaveCount(3);

    // Row 1: Platform -- within cap, plenty of headroom (no low/overrun cue).
    const platform = rows.nth(0);
    await expect(platform.locator('.cc-table__name')).toHaveText('Platform');
    await expect(platform.locator('.cc-table__mapping')).toHaveText(
      'Digital Services → Platform Engineering → PLAT-CORE',
    );
    await expect(platform.locator('.cc-table__members')).toHaveText('15');
    await expect(platform.locator('.cc-table__mtd')).toHaveText('420');
    await expect(platform.locator('.cc-table__headroom')).toHaveText('104,580');
    await expect(platform.locator('.cc-table__status')).toHaveText('✓ within');

    // Row 2: Data & Analytics -- also within.
    const data = rows.nth(1);
    await expect(data.locator('.cc-table__name')).toHaveText('Data & Analytics');
    await expect(data.locator('.cc-table__mapping')).toHaveText('Data Group → Insights → DATA-INS');
    await expect(data.locator('.cc-table__members')).toHaveText('10');
    await expect(data.locator('.cc-table__mtd')).toHaveText('310');
    await expect(data.locator('.cc-table__headroom')).toHaveText('69,690');
    await expect(data.locator('.cc-table__status')).toHaveText('✓ within');

    // Row 3: the cap-bound edge fixture -- negative headroom, over cap.
    // Never color-only: the red headroom pairs an icon + "overrun" text cue,
    // and the status pill pairs the ✕ glyph with its label.
    const capBound = rows.nth(2);
    await expect(capBound.locator('.cc-table__name')).toHaveText('Marketing (Cap-Bound)');
    await expect(capBound.locator('.cc-table__mapping')).toHaveText(
      'Corporate Services → Marketing & Communications → MKT-GROWTH',
    );
    await expect(capBound.locator('.cc-table__members')).toHaveText('10');
    await expect(capBound.locator('.cc-table__mtd')).toHaveText('70,500');
    await expect(capBound.locator('.cc-table__headroom')).toHaveText('⚠ −500 overrun');
    await expect(capBound.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--negative/);
    await expect(capBound.locator('.cc-table__status')).toHaveText('✕ over cap');
    await expect(capBound.locator('.cc-table__status')).toHaveClass(/cc-table__status--over-cap/);

    // The healthy rows carry the 'ok' tone class, not low/negative.
    await expect(platform.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--ok/);
    await expect(data.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--ok/);

    // Read-only screen (SPEC.md Assumption 4): zero write affordances -- the
    // prototype's "+ New cost center" button is absent entirely, not disabled.
    await expect(window.getByText('+ New cost center')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('clicking the cap-bound row opens the drill modal with membership; Esc, ✕ and backdrop all close it', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-cost-centers-drill-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    await window.locator('.nav').getByRole('button', { name: 'Cost centers' }).click();
    const rows = window.locator('.cc-table__row');
    await expect(rows).toHaveCount(3);
    await rows.nth(2).click();

    const modal = window.getByRole('dialog', { name: 'Marketing (Cap-Bound)' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Corporate Services → Marketing & Communications → MKT-GROWTH')).toBeVisible();

    // Stat tiles: MTD burn, headroom (red, icon+text cue), excluded.
    const tiles = modal.locator('.runway-tile');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.filter({ hasText: 'MTD burn' }).locator('.runway-tile__value')).toHaveText('70,500');
    const headroomTile = tiles.filter({ hasText: 'Headroom' });
    await expect(headroomTile.locator('.runway-tile__value')).toHaveText('⚠ −500 overrun');
    // The read-only, license-derived cap surfaces here -- display only, no input.
    await expect(headroomTile.locator('.runway-tile__sub')).toHaveText('vs cap 70,000 · license-derived');
    await expect(tiles.filter({ hasText: 'Excluded from ent. budget' }).locator('.runway-tile__value')).toHaveText(
      'No',
    );

    // Membership: all 10 fixture members, with per-member cycle burn and
    // ent-team provenance badges where the fixture provides them.
    const members = modal.locator('.drill-modal__member');
    await expect(members).toHaveCount(10);
    const user26 = members.filter({ hasText: 'user-26' });
    await expect(user26.locator('.drill-modal__member-burn')).toHaveText('500');
    await expect(user26.locator('.drill-modal__member-badge')).toHaveText('ent-team: mkt-growth');
    // A member the credits-used fixture has no cycle rows for burns 0.
    const user28 = members.filter({ hasText: 'user-28' });
    await expect(user28.locator('.drill-modal__member-burn')).toHaveText('0');
    await expect(user28.locator('.drill-modal__member-badge')).toHaveCount(0);

    // Close via the ✕ button.
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).not.toBeVisible();

    // Reopen, close via Escape.
    await rows.nth(2).click();
    await expect(modal).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();

    // Reopen, close via backdrop click.
    await rows.nth(2).click();
    await expect(modal).toBeVisible();
    await window.locator('.drill-modal__backdrop').click({ position: { x: 8, y: 8 } });
    await expect(modal).not.toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
