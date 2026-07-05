import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 2.3: Cost Centers screen -- read-only table + drill modal. Every
// asserted value is fixture-derived (packages/data/src/msw/fixtures/
// costCenters.ts + usage.ts), never wall-clock, against the DEWR world
// (packages/data/src/msw/fixtures/README.md):
//   - 6 cost centers (workforce, employer, capBound, dataEval, cyber,
//     corporate), fixture order, with 24/16/8/9/11/13 members
//     (COST_CENTER_RESOURCES).
//   - MTD burn is the fixture's GitHub-reported per-CC cycle total:
//     30,200 / 18,900 / 58,300 / 57,400 / 15,000 / 12,300 credits.
//   - Included-usage cap computed limits are license-derived read-only
//     values (promo enterprise 7,000/seat): 168,000 / 112,000 / 56,000 /
//     63,000 / 77,000 / 91,000.
//   - headroom = computedLimit - mtdBurn (packages/core costCenter.ts):
//     137,800 / 93,100 / -2,300 / 5,600 / 62,000 / 78,700. capBound
//     (Payments Integrity Engineering) is the only negative one -> red +
//     "overrun" cue + "over cap" status. dataEval (Data & Evaluation
//     Platform) is positive but under the 8,000 low-headroom threshold ->
//     amber "low" cue, still 'within' status (only negative headroom flips
//     status to over-cap). The rest are comfortably 'ok'.
//   - Drill member burn joins the credits-used fixture within the June 2026
//     cycle (SIM_CURRENT_DATE anchor): faisal-noor (assurance ent-team) ->
//     4,180; dev-raman (no rows this cycle) -> 0.
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
    await expect(screen.getByText('6 cost centers · mapped to the DEWR financial structure')).toBeVisible();

    const rows = screen.locator('.cc-table__row');
    await expect(rows).toHaveCount(6);

    // Row 1: Workforce Australia Platform -- within cap, plenty of headroom.
    const workforce = rows.nth(0);
    await expect(workforce.locator('.cc-table__name')).toHaveText('Workforce Australia Platform');
    await expect(workforce.locator('.cc-table__mapping')).toHaveText(
      'Employment Systems Group → Digital Delivery Branch → WFA-DIGITAL',
    );
    await expect(workforce.locator('.cc-table__members')).toHaveText('24');
    await expect(workforce.locator('.cc-table__mtd')).toHaveText('30,200');
    await expect(workforce.locator('.cc-table__headroom')).toHaveText('137,800');
    await expect(workforce.locator('.cc-table__status')).toHaveText('✓ within');

    // Row 2: Employer & Provider Portals -- also within.
    const employer = rows.nth(1);
    await expect(employer.locator('.cc-table__name')).toHaveText('Employer & Provider Portals');
    await expect(employer.locator('.cc-table__mapping')).toHaveText(
      'Employment Systems Group → Employer Engagement Branch → PROVIDER-PORTAL',
    );
    await expect(employer.locator('.cc-table__members')).toHaveText('16');
    await expect(employer.locator('.cc-table__mtd')).toHaveText('18,900');
    await expect(employer.locator('.cc-table__headroom')).toHaveText('93,100');
    await expect(employer.locator('.cc-table__status')).toHaveText('✓ within');

    // Row 3: the cap-bound crisis fixture -- negative headroom, over cap.
    // Never color-only: the red headroom pairs an icon + "overrun" text cue,
    // and the status pill pairs the ✕ glyph with its label.
    const capBound = rows.nth(2);
    await expect(capBound.locator('.cc-table__name')).toHaveText('Payments Integrity Engineering');
    await expect(capBound.locator('.cc-table__mapping')).toHaveText(
      'Corporate & Enabling Services → Payments Technology Branch → PAYMENTS-ASSURANCE',
    );
    await expect(capBound.locator('.cc-table__members')).toHaveText('8');
    await expect(capBound.locator('.cc-table__mtd')).toHaveText('58,300');
    await expect(capBound.locator('.cc-table__headroom')).toHaveText('⚠ −2,300 overrun');
    await expect(capBound.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--negative/);
    await expect(capBound.locator('.cc-table__status')).toHaveText('✕ over cap');
    await expect(capBound.locator('.cc-table__status')).toHaveClass(/cc-table__status--over-cap/);

    // Row 4: Data & Evaluation Platform -- the amber warning fixture. Positive
    // headroom (5,600) under the 8,000 low-headroom threshold -> amber "low"
    // cue, but status stays 'within' (only negative headroom flips to over-cap).
    const dataEval = rows.nth(3);
    await expect(dataEval.locator('.cc-table__name')).toHaveText('Data & Evaluation Platform');
    await expect(dataEval.locator('.cc-table__mapping')).toHaveText(
      'Data, Analytics & Evaluation Group → Data Platforms Branch → EVAL-WAREHOUSE',
    );
    await expect(dataEval.locator('.cc-table__members')).toHaveText('9');
    await expect(dataEval.locator('.cc-table__mtd')).toHaveText('57,400');
    await expect(dataEval.locator('.cc-table__headroom')).toHaveText('⚠ 5,600 low');
    await expect(dataEval.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--low/);
    await expect(dataEval.locator('.cc-table__status')).toHaveText('✓ within');
    await expect(dataEval.locator('.cc-table__status')).toHaveClass(/cc-table__status--within/);

    // Row 5: Cyber & Identity Services -- within.
    const cyber = rows.nth(4);
    await expect(cyber.locator('.cc-table__name')).toHaveText('Cyber & Identity Services');
    await expect(cyber.locator('.cc-table__mapping')).toHaveText(
      'Digital & Technology Group → Cyber Security Branch → IDAM-UPLIFT',
    );
    await expect(cyber.locator('.cc-table__members')).toHaveText('11');
    await expect(cyber.locator('.cc-table__mtd')).toHaveText('15,000');
    await expect(cyber.locator('.cc-table__headroom')).toHaveText('62,000');
    await expect(cyber.locator('.cc-table__status')).toHaveText('✓ within');

    // Row 6: Corporate Systems -- within, lightest team.
    const corporate = rows.nth(5);
    await expect(corporate.locator('.cc-table__name')).toHaveText('Corporate Systems');
    await expect(corporate.locator('.cc-table__mapping')).toHaveText(
      'Corporate & Enabling Services → Enterprise Applications Branch → HR-FIN-SYSTEMS',
    );
    await expect(corporate.locator('.cc-table__members')).toHaveText('13');
    await expect(corporate.locator('.cc-table__mtd')).toHaveText('12,300');
    await expect(corporate.locator('.cc-table__headroom')).toHaveText('78,700');
    await expect(corporate.locator('.cc-table__status')).toHaveText('✓ within');

    // The healthy rows carry the 'ok' tone class, not low/negative.
    await expect(workforce.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--ok/);
    await expect(employer.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--ok/);
    await expect(cyber.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--ok/);
    await expect(corporate.locator('.cc-table__headroom')).toHaveClass(/cc-table__headroom--ok/);

    // Task 4.13 supersedes the "read-only screen" (SPEC.md Assumption 4 was
    // phase-scoped to the MVP): the "+ New cost center" lifecycle affordance is
    // now present -- create rides the staged -> dry-run -> apply plan, exercised
    // end-to-end in cost-centers-lifecycle.spec.ts.
    await expect(window.getByRole('button', { name: '+ New cost center' })).toBeVisible();
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
    await expect(rows).toHaveCount(6);
    await rows.nth(2).click();

    const modal = window.getByRole('dialog', { name: 'Payments Integrity Engineering' });
    await expect(modal).toBeVisible();
    await expect(
      modal.getByText('Corporate & Enabling Services → Payments Technology Branch → PAYMENTS-ASSURANCE'),
    ).toBeVisible();

    // Stat tiles: MTD burn, headroom (red, icon+text cue), excluded.
    const tiles = modal.locator('.runway-tile');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.filter({ hasText: 'MTD burn' }).locator('.runway-tile__value')).toHaveText('58,300');
    const headroomTile = tiles.filter({ hasText: 'Headroom' });
    await expect(headroomTile.locator('.runway-tile__value')).toHaveText('⚠ −2,300 overrun');
    // The read-only, license-derived cap surfaces here -- display only, no input.
    await expect(headroomTile.locator('.runway-tile__sub')).toHaveText('vs cap 56,000 · license-derived');
    await expect(tiles.filter({ hasText: 'Excluded from ent. budget' }).locator('.runway-tile__value')).toHaveText(
      'No',
    );

    // Task 4.13 membership EDITOR: the live cost center's 8 resources render as
    // editable rows (each with a Remove control) plus an "Add a user…" picker.
    // Per-member cycle burn + ent-team provenance join from the summary burn
    // view (CostCenterControl.members is type+name only).
    const members = modal.locator('.cc-members-editor__row');
    await expect(members).toHaveCount(8);
    const faisalNoor = members.filter({ hasText: 'faisal-noor' });
    await expect(faisalNoor.locator('.cc-members-editor__burn')).toHaveText('4,180');
    await expect(faisalNoor.locator('.cc-members-editor__type-badge')).toHaveText('ent-team: assurance');
    // A member the credits-used fixture has no cycle rows for burns 0.
    const devRaman = members.filter({ hasText: 'dev-raman' });
    await expect(devRaman.locator('.cc-members-editor__burn')).toHaveText('0');
    await expect(devRaman.locator('.cc-members-editor__type-badge')).toHaveCount(0);
    // The editing affordances exist: a Remove per member + the add picker.
    await expect(modal.getByRole('button', { name: 'Remove faisal-noor' })).toBeVisible();
    await expect(modal.getByLabel('Add member')).toBeVisible();

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
