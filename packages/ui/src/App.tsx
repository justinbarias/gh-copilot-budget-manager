import { useEffect, useState } from 'react';
import { cycleBounds } from '@copilot-budget/core';
import { ApiClientProvider, useApiClient } from './lib/api-client-context';
import { SimBanner } from './components/SimBanner';
import { Nav, type ScreenId } from './components/Nav';
import { Audit } from './screens/Audit/Audit';
import { Controls, type FamilyId } from './screens/Controls/Controls';
import { CostCentersTable } from './screens/CostCenters/CostCentersTable';
import { Forecast } from './screens/Forecast/Forecast';
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

// Task 5.6: `navigate`'s second, optional argument carries a deep-link
// target one level below the screen itself -- today, only Controls' family
// tab (the Forecast screen's cap-off explainer CTA needs to land the admin
// directly on "Included-usage caps", not merely the Controls screen's own
// default tab). Additive to the plain `(screen) => void` shape every other
// call site already uses (Overview's/Controls' own cross-links never pass a
// second argument), so this widens rather than breaks them.
interface NavigateOptions {
  controlsFamily?: FamilyId;
}

function renderScreen(
  screen: ScreenId,
  navigate: (screen: ScreenId, options?: NavigateOptions) => void,
  controlsInitialFamily: FamilyId | undefined,
) {
  switch (screen) {
    case 'overview':
      // Task 5.7: the cliff banner's "Visualise the cliff ->" link -- same
      // navigate-callback mechanism the Controls screen's Auto-balance
      // cross-link already uses below.
      // Task 8.4 wires the Alerts panel's "View in audit ->" cross-link
      // (Overview/AlertsList.tsx), which was a disabled Task 2.5 stub until
      // the Audit screen itself existed to navigate to.
      return <Overview onNavigateToForecast={() => navigate('forecast')} onNavigateToAudit={() => navigate('audit')} />;
    case 'forecast':
      // Real since Task 5.5 (scope tabs, the signature burn-down chart's
      // forecast layers, the metered-phase spend bar, the backtest/
      // percentile bottom grid) and Task 5.6 (cost-center scope: cap-on
      // burn-down-vs-cap, cap-off explainer + this CTA). The CTA deep-links
      // straight to Controls' Included-usage caps family tab (Task 4.12),
      // rather than landing on Controls' own default tab and making the
      // admin click again.
      return <Forecast onNavigateToControlsCaps={() => navigate('controls', { controlsFamily: 'included' })} />;
    case 'controls':
      // Real since Task 4.9 (Spending-limits family + the plan/simulate/apply
      // rail); its "⇄ Auto-balance headroom" cross-link targets the (still
      // stubbed) Auto-balance screen per the design's navigation cross-links.
      // `initialFamily` is undefined (Controls' own 'userlevel' default) on
      // every entry EXCEPT the Forecast cap-off CTA above.
      return <Controls onNavigateToAutoBalance={() => navigate('autobalance')} initialFamily={controlsInitialFamily} />;
    case 'costcenters':
      return <CostCentersTable />;
    case 'users':
      return <UsersTable />;
    case 'audit':
      return <Audit />;
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
  // Task 5.6: the pending Controls family deep-link, if the in-flight
  // navigation carried one (see NavigateOptions/navigate below) -- reset to
  // undefined on every navigation that DOESN'T explicitly request one, so a
  // stale deep-link never leaks into a later, ordinary Nav-sidebar click into
  // Controls.
  const [controlsInitialFamily, setControlsInitialFamily] = useState<FamilyId | undefined>(undefined);

  function navigate(next: ScreenId, options?: NavigateOptions) {
    setControlsInitialFamily(options?.controlsFamily);
    setScreen(next);
  }

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
        <Nav screen={screen} onNavigate={navigate} />
        <main className="app-shell__main">
          <header className="app-shell__topbar">
            <h1 className="app-shell__title">{SCREEN_TITLES[screen]}</h1>
            {cycleLabel && <span className="app-shell__cycle">{cycleLabel}</span>}
          </header>
          <div className="app-shell__content">{renderScreen(screen, navigate, controlsInitialFamily)}</div>
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
