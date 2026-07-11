import { useEffect, useState } from 'react';
import type { SyncStatus } from '@copilot-budget/data';
import { useApiClient } from '../lib/api-client-context';
import { formatSyncStatus, useSync } from '../lib/sync-context';
import './Nav.css';

// Compact nav-footer last-synced line, e.g. "Synced 10 Jul" (day-month, en-GB
// order to match the design's "10 Jul" example). The FULL formatSyncStatus
// text -- including the per-user trailing-gap coverage -- rides along in the
// row's title attribute for the hover/screen-reader detail.
function compactSynced(status: SyncStatus): string {
  const when = new Date(status.lastSyncedAt as string);
  return `Synced ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

export type ScreenId =
  | 'overview'
  | 'forecast'
  | 'controls'
  | 'autobalance'
  | 'costcenters'
  | 'users'
  | 'chargeback'
  | 'audit'
  | 'settings'
  | 'help';

// Order + labels per design/README.md "Global shell & navigation" (line ~49)
// and design/*.dc.html's navDefs -- 10 items, not the "9" PLAN.md/SPEC.md's
// prose says (see App.tsx's top comment for the full flag on this conflict).
export const NAV_ITEMS: ReadonlyArray<{ id: ScreenId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'controls', label: 'Controls' },
  { id: 'autobalance', label: 'Auto-balance' },
  { id: 'costcenters', label: 'Cost centers' },
  { id: 'users', label: 'Users' },
  { id: 'chargeback', label: 'Chargeback' },
  { id: 'audit', label: 'Audit' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
];

interface NavProps {
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  /**
   * Task 6.7: the Auto-balance nav badge = the ACTIVE simulation scenario's
   * engine at-risk count (0 = no badge). Derived by App from the scenario's
   * ScenarioSummary.atRiskCount, which is trigger-gated (0 unless the
   * rebalancer fires) and engine-verified in scenarios.engine.test.ts. Always 0
   * outside simulation mode.
   */
  autoBalanceBadge?: number;
}

// Nav badges (red at-risk counts) + the top-bar demo-scenario switch are wired
// to the Task 6.7 scenario mechanism: the badge below reflects the active
// scenario's firing-trigger at-risk count; the switch itself lives in the App
// top bar (ScenarioSelector), sim-mode-only.
export function Nav({ screen, onNavigate, autoBalanceBadge = 0 }: NavProps) {
  const api = useApiClient();
  const { status: syncStatus, syncing, error: syncError, syncNow } = useSync();
  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);
  const [hasPat, setHasPat] = useState<boolean | null>(null);

  // The button is busy while THIS window is syncing OR any window's sync is in
  // progress (status.inProgress arrives via broadcast) -- never let a second
  // click fire while one runs. Sync works in BOTH modes (sim pulls from MSW),
  // so it is never gated on mode.
  const syncBusy = syncing || syncStatus?.inProgress === true;

  // Detail line: error > never-synced > compact last-synced. The full text is
  // always the title (formatSyncStatus), except on error where the title is
  // the failure message and the row is an alert.
  const syncIsError = syncError !== null && !syncBusy;
  const syncDetail = syncIsError
    ? 'Sync failed'
    : !syncStatus || !syncStatus.lastSyncedAt
      ? 'Never synced'
      : compactSynced(syncStatus);
  const syncTitle = syncIsError ? syncError : formatSyncStatus(syncStatus);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getMode(), api.hasPat()]).then(([m, pat]) => {
      if (cancelled) return;
      setMode(m);
      setHasPat(pat);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <aside className="nav" aria-label="Primary">
      <div className="nav__brand">
        <span className="nav__brand-ring" aria-hidden="true">
          <span className="nav__brand-dot" />
        </span>
        <div>
          <div className="nav__brand-name">Copilot Budget</div>
          <div className="nav__brand-sub">FinOps control plane</div>
        </div>
      </div>

      <nav className="nav__items">
        {NAV_ITEMS.map((item) => {
          const active = item.id === screen;
          const badge = item.id === 'autobalance' && autoBalanceBadge > 0 ? autoBalanceBadge : null;
          return (
            <button
              key={item.id}
              type="button"
              className={active ? 'nav__item nav__item--active' : 'nav__item'}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <span className="nav__item-bar" aria-hidden="true" />
              <span className="nav__item-label">{item.label}</span>
              {badge !== null && (
                <span className="nav__item-badge" data-testid="nav-badge-autobalance" aria-label={`${badge} at risk`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Real state where trivially available via ApiClient (mode + PAT
          presence); the design's other footer fields (scope name, relative
          "4m ago" sync time, read+write flag) have no backing data source in
          MVP, so they're omitted rather than invented (CLAUDE.md §0). */}
      <div className="nav__footer">
        <div className="nav__footer-row">
          <span
            className={hasPat ? 'nav__footer-dot nav__footer-dot--on' : 'nav__footer-dot nav__footer-dot--off'}
            aria-hidden="true"
          />
          <span className="nav__footer-label">Enterprise token</span>
        </div>
        <div className="nav__footer-detail">
          {/* Wording deliberately avoids "<mode> mode" and "<no >PAT stored"
              -- both phrases are already asserted by existing e2e specs
              (sim banner, Settings/TokenHealth) against the whole window,
              and this footer is mounted alongside them on every screen. */}
          {mode === null ? 'Loading…' : mode === 'simulation' ? 'Simulation' : 'Live'}
          {hasPat === null ? '' : hasPat ? ' · token connected' : ' · token not connected'}
        </div>

        {/* Global Sync affordance (moved here from Settings): background job
            surfaced app-wide via SyncProvider's main-process push events.
            Works in both modes -- not gated on mode. */}
        <div className="nav__footer-row nav__footer-sync" data-testid="nav-sync">
          <button
            type="button"
            className="nav__footer-sync-button"
            onClick={syncNow}
            disabled={syncBusy}
            data-testid="nav-sync-button"
          >
            {syncBusy ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <div
          className={syncIsError ? 'nav__sync-detail nav__sync-detail--error' : 'nav__sync-detail'}
          data-testid="nav-sync-detail"
          title={syncTitle}
          role={syncIsError ? 'alert' : undefined}
        >
          {syncDetail}
        </div>
      </div>
    </aside>
  );
}
