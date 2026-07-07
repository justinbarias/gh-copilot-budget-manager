import { useEffect, useState } from 'react';
import { cycleBounds } from '@copilot-budget/core';
import type { ScenarioId, ScenarioSummary } from '@copilot-budget/data';
import { ApiClientProvider, useApiClient } from './lib/api-client-context';
import { SimBanner } from './components/SimBanner';
import { ScenarioSelector } from './components/ScenarioSelector';
import { Nav, type ScreenId } from './components/Nav';
import { Audit } from './screens/Audit/Audit';
import { AutoBalance } from './screens/AutoBalance/AutoBalance';
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
    case 'autobalance':
      // Real since Task 6.8 (pool mode, dry-run only: trigger card, the
      // signature envelope bar, the at-risk grants table with live recompute,
      // and the simulate rail with the gated ⑤ apply). Metered mode is a
      // labelled Task 6.9 placeholder inside the screen itself.
      return <AutoBalance />;
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

  // Task 6.7: sim-mode scenario state. `scenarios` is null in live mode
  // (listScenarios refuses) or before the fetch resolves, so the selector is
  // absent unless we're genuinely in simulation. Switching a scenario re-seeds
  // MSW + re-anchors the sim clock in the main process; `scenarioVersion` is a
  // remount key on the content + a re-fetch trigger for the topbar/nav so every
  // screen re-reads the new fixture world.
  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId | null>(null);
  const [scenarioVersion, setScenarioVersion] = useState(0);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getMode(), api.listScenarios()]).then(([m, list]) => {
      if (cancelled) return;
      setMode(m);
      if (!list.refused) {
        setScenarios(list.scenarios);
        setActiveScenarioId(list.activeId);
      } else {
        setScenarios(null);
        setActiveScenarioId(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleSelectScenario(id: ScenarioId) {
    if (id === activeScenarioId || switching) return;
    setSwitching(true);
    try {
      const res = await api.setScenario(id);
      if (!res.refused) {
        setActiveScenarioId(res.scenario.id);
        setScenarioVersion((v) => v + 1); // remount screens + re-fetch topbar/nav
      }
    } finally {
      setSwitching(false);
    }
  }

  const activeScenario = scenarios?.find((s) => s.id === activeScenarioId) ?? null;

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
    // scenarioVersion: switching a scenario re-anchors the sim clock, so the
    // topbar cycle label (day X/Y) must re-read the new asOf date.
  }, [api, scenarioVersion]);

  return (
    <div className="app-shell">
      {/* Global and unmistakable on every screen (CLAUDE.md §6.8): rendered
          above the two-column body, full-bleed across sidebar + main, so no
          screen can ever mount without it in view. */}
      <SimBanner />
      <div className="app-shell__body">
        <Nav
          screen={screen}
          onNavigate={navigate}
          autoBalanceBadge={mode === 'simulation' ? (activeScenario?.atRiskCount ?? 0) : 0}
        />
        <main className="app-shell__main">
          <header className="app-shell__topbar">
            <h1 className="app-shell__title">{SCREEN_TITLES[screen]}</h1>
            {cycleLabel && <span className="app-shell__cycle">{cycleLabel}</span>}
            {mode === 'simulation' && scenarios && activeScenarioId && (
              <ScenarioSelector
                scenarios={scenarios}
                activeId={activeScenarioId}
                onSelect={handleSelectScenario}
                busy={switching}
              />
            )}
          </header>
          {/* scenarioVersion remounts every screen on a scenario switch, so
              each screen's data effects re-run against the new fixture world. */}
          <div className="app-shell__content" key={scenarioVersion}>
            {renderScreen(screen, navigate, controlsInitialFamily)}
          </div>
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
