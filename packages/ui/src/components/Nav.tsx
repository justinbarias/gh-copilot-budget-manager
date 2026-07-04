import { useEffect, useState } from 'react';
import { useApiClient } from '../lib/api-client-context';
import './Nav.css';

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
}

// Nav badges (red at-risk counts) and the top-bar demo-scenario switch
// (Healthy/At risk/Surplus) are prototype-only affordances: design/README.md
// ties both to a re-seeding demo mechanism, and there's no real data source
// for either yet (no auto-balance/at-risk engine ships until Phase 5+) --
// out of MVP scope entirely, not merely deferred-and-disabled.
export function Nav({ screen, onNavigate }: NavProps) {
  const api = useApiClient();
  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);
  const [hasPat, setHasPat] = useState<boolean | null>(null);

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
      </div>
    </aside>
  );
}
