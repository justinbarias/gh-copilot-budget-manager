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
  { label: 'Forecast', kind: 'functional' }, // real since Task 5.5 (scope tabs, burn-down forecast layers, metered spend, backtest)
  { label: 'Controls', kind: 'functional' }, // real since Task 4.9 (Spending-limits family + plan/simulate/apply rail)
  { label: 'Auto-balance', kind: 'stub' },
  { label: 'Cost centers', kind: 'functional' },
  { label: 'Users', kind: 'functional' },
  { label: 'Chargeback', kind: 'stub' },
  { label: 'Audit', kind: 'functional' }, // real since Task 8.4 (filterable, read-only hash-chain stream + Task 8.5's verify/export)
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
    case 'Controls':
      // Family tabs are the screen's stable spine (controls.spec.ts covers the rest).
      await expect(window.getByRole('tab', { name: 'Included-usage caps' })).toBeVisible();
      break;
    case 'Forecast':
      // Scope tabs are the screen's stable spine, present whether or not a
      // sync has ever run (forecast-screen.spec.ts covers the real content).
      await expect(window.locator('.forecast__tab--active')).toHaveText('Enterprise');
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
    case 'Audit':
      // Stable spine regardless of whether any audit events exist yet on a
      // fresh DB (audit.spec.ts covers seeded-event content + export/verify).
      await expect(window.getByTestId('audit-filter-all')).toBeVisible();
      await expect(window.getByTestId('audit-verify-button')).toBeVisible();
      break;
    default:
      throw new Error(`No functional-screen assertion wired for "${label}"`);
  }
}

test('all 10 nav items route correctly, update active styling, and keep the sim banner visible', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-nav-'));
  // Isolate Electron's userData dir, not just the sqlite path: the
  // `.nav__footer-detail` assertion below ('token not connected') is derived
  // from hasPat() (Nav.tsx), which resolves the PAT file against the real
  // app.getPath('userData') with no env override (pat-bridge.ts). Without
  // this, a leftover pat.enc from any manual run would flip the footer to
  // 'token connected' and fail this spec by accident of machine history --
  // the same fragility boot-mode.spec.ts / settings.spec.ts isolate against.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-nav-userdata-'));
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
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
      // `window` here lexically resolves to the outer Playwright `Page`
      // variable at the TS level (this callback body is serialized and
      // re-run inside the real browser context, where `window` is the DOM
      // global -- see PLAN.md Task 3.1) -- cast once so the assertions below
      // type-check honestly instead of relying on that runtime-only escape.
      const browserWindow = window as unknown as Window;
      browserWindow.scrollTo(0, 99999);
      const banner = document.querySelector('.sim-banner')!.getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > browserWindow.innerHeight + 1,
        bannerInViewport: banner.top >= 0 && banner.bottom <= browserWindow.innerHeight,
      };
    });
    expect(scroll.pageScrolls).toBe(false);
    expect(scroll.bannerInViewport).toBe(true);

    // Zero page errors across the full 10-screen sweep.
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
