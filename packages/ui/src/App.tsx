import { useEffect, useState } from 'react';
import { cycleBounds } from '@copilot-budget/core';
import { ApiClientProvider, useApiClient } from './lib/api-client-context';
import { SimBanner } from './components/SimBanner';
import { Nav, type ScreenId } from './components/Nav';
import { Controls } from './screens/Controls/Controls';
import { CostCentersTable } from './screens/CostCenters/CostCentersTable';
import { Overview } from './screens/Overview/Overview';
import { TokenHealth } from './screens/Settings/TokenHealth';
import { UsersTable } from './screens/Users/UsersTable';
import { ComingSoon } from './screens/_stubs/ComingSoon';
import './App.css';

// Item-count conflict (flagged per CLAUDE.md's "if in conflict, flag it, do
// not silently pick" rule): PLAN.md Task 2.5 and SPEC.md Success Criterion
// 10 both say "9 items" in prose, but SPEC.md's own Assumption 5 enumeration
// and design/README.md's "Global shell & navigation" (line ~49) both list
// exactly 10 -- Overview, Forecast, Controls, Auto-balance, Cost centers,
// Users, Chargeback, Audit, Settings, Help. That's 4 functional + 6 stubs =
// 10. Implementing the superset (all 10) since both source-of-truth
// enumerations agree and only the summary prose undercounts.
const SCREEN_TITLES: Record<ScreenId, string> = {
  overview: 'Overview',
  forecast: 'Forecast',
  controls: 'Controls',
  autobalance: 'Auto-balance',
  costcenters: 'Cost centers',
  users: 'Users',
  chargeback: 'Chargeback',
  audit: 'Audit',
  settings: 'Settings',
  help: 'Help',
};

function renderScreen(screen: ScreenId, navigate: (screen: ScreenId) => void) {
  switch (screen) {
    case 'overview':
      return <Overview />;
    case 'controls':
      // Real since Task 4.9 (Spending-limits family + the plan/simulate/apply
      // rail); its "⇄ Auto-balance headroom" cross-link targets the (still
      // stubbed) Auto-balance screen per the design's navigation cross-links.
      return <Controls onNavigateToAutoBalance={() => navigate('autobalance')} />;
    case 'costcenters':
      return <CostCentersTable />;
    case 'users':
      return <UsersTable />;
    case 'settings':
      return <TokenHealth />;
    default:
      return <ComingSoon screenName={SCREEN_TITLES[screen]} />;
  }
}

// Two-column shell per design/README.md "Global shell & navigation": fixed
// Nav sidebar + fluid main column (sticky topbar, scrollable content). State
// switching mirrors the design prototype's single `screen` state field --
// no router dependency added (no new deps allowed for this task).
function AppShell() {
  const api = useApiClient();
  const [screen, setScreen] = useState<ScreenId>('overview');
  const [cycleLabel, setCycleLabel] = useState<string | null>(null);

  // The topbar's cycle label is real, fixture-derived data -- the same
  // getUsageSummary()/cycleBounds() math Overview.tsx already uses to render
  // "13 of 30" -- fetched once here since the topbar needs it on every
  // screen, not only Overview's. The design's other cycle-label fields
  // ("GitHub Enterprise · dewr") aren't backed by any ApiClient data (the
  // org-shape questions in CLAUDE.md §9 are still open per SPEC.md
  // Assumption 1), so they're omitted rather than hardcoded; the label stays
  // null (omitted entirely) until the fetch resolves.
  useEffect(() => {
    let cancelled = false;
    api.getUsageSummary().then((summary) => {
      if (cancelled || !summary.cycleAsOfDate) return;
      const asOf = new Date(`${summary.cycleAsOfDate}T00:00:00.000Z`);
      const bounds = cycleBounds(asOf);
      const month = asOf.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      setCycleLabel(`Cycle ${month} · Day ${bounds.daysElapsed} of ${bounds.daysInCycle}`);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <div className="app-shell">
      {/* Global and unmistakable on every screen (CLAUDE.md §6.8): rendered
          above the two-column body, full-bleed across sidebar + main, so no
          screen can ever mount without it in view. */}
      <SimBanner />
      <div className="app-shell__body">
        <Nav screen={screen} onNavigate={setScreen} />
        <main className="app-shell__main">
          <header className="app-shell__topbar">
            <h1 className="app-shell__title">{SCREEN_TITLES[screen]}</h1>
            {cycleLabel && <span className="app-shell__cycle">{cycleLabel}</span>}
          </header>
          <div className="app-shell__content">{renderScreen(screen, setScreen)}</div>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ApiClientProvider>
      <AppShell />
    </ApiClientProvider>
  );
}
