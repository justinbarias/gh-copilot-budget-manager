import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 5.6: the Forecast screen's cost-center scope -- design/*.dc.html's v2
// behavior (`isCcCap`/`ccCapOff`/`poolExhaustLabel` in the prototype's
// render()): a cap-ON cost center gets its own burn-down against its
// license-derived included-usage cap, labeled per its overflow choice; a
// cap-OFF cost center gets an explainer + a working cross-link into
// Controls' caps family. Both variants get a metered-phase card below.
//
// Expected values below were independently recomputed (this build's report
// has the full derivation + a probe script run against the real
// createGitHubApiClient + DEWR MSW fixtures, not observed screen output):
//
//   All 6 DEWR cost centers are cap-ON in packages/data/src/msw/fixtures/
//   costCenters.ts today -- there is NO cap-off cost center in the current
//   fixture world (a design/fixture gap flagged in the build report, not an
//   implementation shortcut; see the test.skip below).
//
//   - Workforce Australia Platform (the entity select's default -- fixture
//     declaration order, same order cost-centers.spec.ts pins): cap ON,
//     overflow 'block', computed limit 168,000, mtd burn 30,200 -- well
//     under cap, exhaustionDate null, runwayDays null -> "within cap all
//     cycle" headline, "Cap block date" label with no date. Metered phase
//     inactive (overflow='block' -> paidUsageEnabled=false for this CC ->
//     projectedMeteredCredits 0).
//   - Payments Integrity Engineering: cap ON, overflow 'metered', computed
//     limit 56,000, mtd burn 58,300 (56,000 pool + 2,300 metered overflow,
//     per costCenters.ts's own comment) -- already over cap.
//     exhaustionDate 2026-06-12, runwayDays 0 -> "runway ~0 days" headline,
//     "Overflow-to-metered date" label = 2026-06-12. Metered phase ACTIVE:
//     projectedMeteredDollars ~$4,003.45 ("$4,003" per this screen's usd()
//     convention) -- summed across the full multi-cycle horizon, not just
//     the June cycle. No cost-center spending-limit budget control exists
//     for this CC in budgets.ts, so the metered card's budget/hard-stop line
//     is honestly omitted (gap note).
//   - Data & Evaluation Platform: cap ON, overflow 'block', computed limit
//     63,000, mtd burn 57,400 -- close to cap. exhaustionDate 2026-06-15,
//     runwayDays 1 -> "runway ~1 day" headline, "Cap block date" label =
//     2026-06-15. Metered phase INACTIVE (overflow='block' ->
//     paidUsageEnabled=false -> projectedMeteredCredits 0) despite this CC
//     having a REAL $250 (25,000-credit) cost-center spending-limit budget
//     with hard-stop ON in budgets.ts -- that control simply never gets
//     exercised because this cost center's own cap absorbs all its draw.
test('Forecast screen cost-center scope: cap-ON burn-down (both label variants) + metered card, pre- and post-sync', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-forecast-cc-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    // --- Pre-sync: cost centers themselves are real (listCostCenters is
    // independent of any sync), but no forecast has ever been computed. ---
    await window.locator('.nav').getByRole('button', { name: 'Forecast' }).click();
    const screen = window.locator('.forecast');
    await expect(screen).toBeVisible();
    await screen.getByRole('tab', { name: 'Cost centers' }).click();
    await expect(screen.getByTestId('forecast-cc-select')).toBeVisible();
    await expect(screen.getByTestId('forecast-empty-state')).toBeVisible();
    await expect(screen.getByTestId('forecast-cc-runway')).toHaveCount(0);

    // --- Sync Now (direct bridge call, same convention
    // users-forecast-sublabels.spec.ts uses): computes + persists a forecast
    // for every scope, including all 6 active cost centers. ---
    interface WindowWithApi {
      api: { syncNow(): Promise<{ lastSyncedAt: string | null }> };
    }
    const status = await window.evaluate(() => (window as unknown as WindowWithApi).api.syncNow());
    expect(status.lastSyncedAt).not.toBeNull();

    // Re-navigate so the screen's own effects re-fetch against the
    // now-synced forecast rows.
    await window.locator('.nav').getByRole('button', { name: 'Overview' }).click();
    await window.locator('.nav').getByRole('button', { name: 'Forecast' }).click();
    await expect(screen).toBeVisible();
    await screen.getByRole('tab', { name: 'Cost centers' }).click();
    await expect(screen.getByTestId('forecast-empty-state')).toHaveCount(0);

    const ccSelect = screen.getByTestId('forecast-cc-select');
    const chart = screen.getByTestId('burndown-chart');

    // --- Default selection: Workforce Australia Platform (fixture order's
    // first cost center) -- cap-ON, healthy, no exhaustion in this cycle. ---
    await expect(ccSelect).toBeVisible();
    // Content below (168,000 cap, no exhaustion) is itself proof the default
    // selection is Workforce Australia Platform -- no other DEWR cost center
    // shares that computed limit (avoids a brittle option:checked locator).
    await expect(screen.getByTestId('forecast-cc-runway')).toHaveText('within cap all cycle');
    await expect(screen.locator('.forecast__block-label')).toHaveText('Cap block date');
    await expect(screen.getByTestId('forecast-cc-exhaustion-date')).toHaveText('none');
    await expect(chart.getByText('allowance 168,000')).toBeVisible();

    // Task 5.9 design-fidelity pass: NO exhaustion zone/callout when there's
    // no exhaustion in this cycle (Workforce stays healthy all cycle) --
    // BurndownChart's `forecast?.exhaustionDay !== undefined` gate covers
    // both, so this is the negative case the enterprise/user scopes' presence
    // assertions pair with.
    await expect(chart.getByTestId('burndown-exhaustion-zone')).toHaveCount(0);
    await expect(chart.getByTestId('burndown-exhaustion-callout')).toHaveCount(0);
    await expect(screen.getByTestId('forecast-cc-metered-card')).toBeVisible();
    await expect(screen.getByTestId('forecast-cc-metered-headline')).toHaveCount(0);
    await expect(
      screen.getByText(
        "The included-usage cap is projected to cover all of this cost center's usage — no metered charges are expected.",
      ),
    ).toBeVisible();

    // --- Payments Integrity Engineering: cap-ON, overflow='metered' ->
    // "Overflow-to-metered date" label, a real (already-past) date, and an
    // ACTIVE metered card with no cost-center budget control to compare
    // against. ---
    await ccSelect.selectOption({ label: 'Payments Integrity Engineering' });
    await expect(screen.getByTestId('forecast-cc-runway')).toHaveText('runway ~0 days');
    await expect(screen.locator('.forecast__block-label')).toHaveText('Overflow-to-metered date');
    await expect(screen.getByTestId('forecast-cc-exhaustion-date')).toHaveText('2026-06-12');
    await expect(chart.getByText('allowance 56,000')).toBeVisible();

    // Task 5.9: this CC's own exhaustion zone + callout (day 11 of 30 -- a
    // near-left, well-clear-of-the-edge case, unlike the enterprise scope's
    // day 28 of 30).
    await expect(chart.getByTestId('burndown-exhaustion-zone')).toBeVisible();
    const paymentsCallout = chart.getByTestId('burndown-exhaustion-callout');
    await expect(paymentsCallout).toBeVisible();
    await expect(paymentsCallout.getByText('2026-06-12 · day 12')).toBeVisible();

    await expect(screen.getByText('Included-usage cap · Overflow → metered')).toBeVisible();
    await expect(screen.locator('.cc-scope__apionly-pill')).toHaveText('API-ONLY');

    await expect(screen.getByTestId('forecast-cc-metered-headline')).toHaveText('$4,003');
    await expect(
      screen.getByText(
        'No cost-center spending-limit control found for Payments Integrity Engineering — the budget/hard-stop line is omitted.',
      ),
    ).toBeVisible();

    // --- Data & Evaluation Platform: cap-ON, overflow='block' -> "Cap block
    // date" label, a real date one day out, and an INACTIVE metered card
    // (this CC's own $250 cost-center budget control never gets exercised --
    // the included-usage cap absorbs all of its draw first). ---
    await ccSelect.selectOption({ label: 'Data & Evaluation Platform' });
    await expect(screen.getByTestId('forecast-cc-runway')).toHaveText('runway ~1 day');
    await expect(screen.locator('.forecast__block-label')).toHaveText('Cap block date');
    await expect(screen.getByTestId('forecast-cc-exhaustion-date')).toHaveText('2026-06-15');
    await expect(chart.getByText('allowance 63,000')).toBeVisible();

    await expect(chart.getByTestId('burndown-exhaustion-zone')).toBeVisible();
    const dataEvalCallout = chart.getByTestId('burndown-exhaustion-callout');
    await expect(dataEvalCallout).toBeVisible();
    await expect(dataEvalCallout.getByText('2026-06-15 · day 15')).toBeVisible();

    await expect(screen.getByText('Included-usage cap · Block')).toBeVisible();
    await expect(screen.getByTestId('forecast-cc-metered-headline')).toHaveCount(0);
    await expect(
      screen.getByText(
        "The included-usage cap is projected to cover all of this cost center's usage — no metered charges are expected.",
      ),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// Task 5.6's build brief asks for a cap-OFF cost center's explainer + CTA
// (navigating into Controls' Included-usage caps family) to be e2e-verified
// alongside the cap-ON coverage above. CostCenterScope.tsx's cap-off branch
// IS implemented (the `!cap.enabled` early return: "No included-usage cap on
// <name>" explainer, the cumulative-burn gap note, and the
// "Enable included-usage cap in Controls →" CTA wired to
// App.tsx's `navigate('controls', { controlsFamily: 'included' })`, landing
// on IncludedCapsGrid's `data-testid="controls-caps-family"`) -- but it is
// UNREACHABLE via any real synced data today: every one of the 6 DEWR cost
// centers in packages/data/src/msw/fixtures/costCenters.ts has
// `included_usage_cap.enabled: true` (confirmed by a probe script run
// against the real ApiClient this build's report includes). Flipping an
// existing CC (each is asserted against by name/computed-limit/overflow in
// controls-caps.spec.ts, controls-scale.spec.ts, cost-centers.spec.ts, and
// several packages/data unit tests) or adding a 7th CC is a fixture change
// with a blast radius well outside this task's owned files
// (packages/ui/src/screens/Forecast/) -- flagged here as a design/fixture
// gap for an ask-first decision, per CLAUDE.md's "flag conflicts, don't
// silently pick" rule, rather than guessed at unilaterally.
test.skip(
  'a cap-OFF cost center renders the explainer + CTA, which navigates to Controls’ caps family (BLOCKED: no cap-off cost center exists in the current DEWR fixtures -- see this file’s comment above)',
  async () => {},
);
