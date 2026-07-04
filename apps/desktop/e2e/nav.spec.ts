import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';

// Task 2.5: the nav shell itself. Order + labels per design/README.md's
// "Global shell & navigation" (line ~49) and design/*.dc.html's navDefs.
// PLAN.md Task 2.5 / SPEC.md Success Criterion 10 say "9 items", but both
// documents' own enumerated lists (SPEC.md Assumption 5, PLAN.md's
// description) and the design IA all list exactly these 10 -- implementing
// the superset per CLAUDE.md's "if in conflict, flag it, don't silently
// pick" rule. See App.tsx's top comment for the full flag.
const NAV_ITEMS: Array<{ label: string; kind: 'functional' | 'stub' }> = [
  { label: 'Overview', kind: 'functional' },
  { label: 'Forecast', kind: 'stub' },
  { label: 'Controls', kind: 'stub' },
  { label: 'Auto-balance', kind: 'stub' },
  { label: 'Cost centers', kind: 'functional' },
  { label: 'Users', kind: 'functional' },
  { label: 'Chargeback', kind: 'stub' },
  { label: 'Audit', kind: 'stub' },
  { label: 'Settings', kind: 'functional' },
  { label: 'Help', kind: 'stub' },
];

// One cheap, known-content assertion per functional screen -- deeper coverage
// of each screen's own content already lives in its own spec (overview.spec.ts,
// cost-centers.spec.ts, users.spec.ts, settings.spec.ts); this sweep only
// proves the nav actually routes to the right screen.
async function assertFunctionalScreen(window: Page, label: string): Promise<void> {
  switch (label) {
    case 'Overview':
      await expect(window.getByText('Enterprise pool burn-down')).toBeVisible();
      break;
    case 'Cost centers':
      await expect(window.getByText(/cost centers · mapped to the DEWR financial structure/)).toBeVisible();
      break;
    case 'Users':
      await expect(window.locator('.users-table__row').first()).toBeVisible();
      break;
    case 'Settings':
      await expect(window.getByLabel(/personal access token/i)).toBeVisible();
      break;
    default:
      throw new Error(`No functional-screen assertion wired for "${label}"`);
  }
}

test('all 10 nav items route correctly, update active styling, and keep the sim banner visible', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-nav-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    const pageErrors: Error[] = [];
    window.on('pageerror', (error) => pageErrors.push(error));

    const nav = window.locator('.nav');
    await expect(nav).toBeVisible();

    // Topbar cycle label is real fixture-derived data (SIM_CURRENT_DATE
    // 2026-06-14 -> cycleBounds -> day 13 of June's 30), not decoration --
    // pin it exactly so a determinism regression (e.g. wall-clock leaking in)
    // fails loudly. The design's "· GitHub Enterprise · dewr" suffix is
    // deliberately omitted (no backing data source; CLAUDE.md §9 open).
    await expect(window.locator('.app-shell__cycle')).toHaveText('Cycle Jun 2026 · Day 13 of 30');

    // Sidebar footer reflects real bridge state (fresh profile: simulation
    // mode, no PAT stored).
    await expect(nav.locator('.nav__footer-detail')).toHaveText('Simulation · token not connected');

    for (const { label, kind } of NAV_ITEMS) {
      const navButton = nav.getByRole('button', { name: label, exact: true });
      await navButton.click();

      // Active-item styling (design/README.md: #151a22 fill, white text, 3px
      // green left bar) -- exactly one item carries it, and it's this one.
      await expect(navButton).toHaveClass(/nav__item--active/);
      await expect(nav.locator('.nav__item--active')).toHaveCount(1);
      await expect(nav.locator('.nav__item--active')).toHaveText(label);

      // Topbar title tracks the active screen.
      await expect(window.locator('.app-shell__title')).toHaveText(label);

      if (kind === 'functional') {
        await assertFunctionalScreen(window, label);
      } else {
        const stub = window.locator('.coming-soon');
        await expect(stub).toBeVisible();
        await expect(stub.locator('.coming-soon__title')).toHaveText(label);
        await expect(stub).toContainText(/coming soon/i);
      }

      // CLAUDE.md §6.8: unmistakable on every one of the 10 screens, not just some.
      await expect(window.getByText(/simulation mode/i)).toBeVisible();
    }

    // §6.8 regression guard: the page itself must never be the scroller --
    // only .app-shell__content scrolls. If the shell ever grows past the
    // viewport again (the min-height:100vh bug), the sim banner scrolls out
    // of view on tall screens, which Playwright's toBeVisible() alone does
    // not catch. Overview is the tallest screen, so assert there.
    await nav.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(window.getByText('Enterprise pool burn-down')).toBeVisible();
    const scroll = await window.evaluate(() => {
      window.scrollTo(0, 99999);
      const banner = document.querySelector('.sim-banner')!.getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
        bannerInViewport: banner.top >= 0 && banner.bottom <= window.innerHeight,
      };
    });
    expect(scroll.pageScrolls).toBe(false);
    expect(scroll.bannerInViewport).toBe(true);

    // Zero page errors across the full 10-screen sweep.
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
