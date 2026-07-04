import { useEffect, useState } from 'react';
import { cycleBounds, poolAllowanceCredits, poolConsumedPct, type AllowanceBasis } from '@copilot-budget/core';
import type { Alert, UsageSummary } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { BurndownChart, type BurndownPoint } from '../../components/BurndownChart';
import { RunwayTile } from '../../components/RunwayTile';
import { AlertsList } from './AlertsList';
import './Overview.css';

// SPEC.md Assumption 1 (superset case: GitHub Enterprise) + Open Questions
// ("existing customer" promo-eligibility assumed true for MVP fixtures) --
// CLAUDE.md §9's gating questions are still open, so this is the one
// hardcoded org-shape assumption Task 2.1 needs to resolve the allowance.
const ALLOWANCE_BASIS: AllowanceBasis = { edition: 'enterprise', existingCustomer: true };

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function Overview() {
  const api = useApiClient();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.getUsageSummary().then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Fetched independently of the chart/tiles' summary: alerts are pre-baked
  // fixture data via ApiClient.listAlerts() (PLAN.md's Architecture
  // Decisions), not derived from getUsageSummary(), so a slow/empty alerts
  // load can never gate or regress the chart/tiles render (Task 2.1).
  useEffect(() => {
    let cancelled = false;
    api.listAlerts().then((result) => {
      if (!cancelled) setAlerts(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!summary) {
    return (
      <section className="overview" aria-label="Overview">
        <p className="overview__loading">Loading…</p>
      </section>
    );
  }

  // Deterministic by construction (CLAUDE.md §2): cycleAsOfDate is a fixture
  // anchor from the ApiClient, never wall-clock, so this is stable across runs.
  const asOf = new Date(`${summary.cycleAsOfDate}T00:00:00.000Z`);
  const bounds = cycleBounds(asOf);
  const consumed = summary.dailyBurn.at(-1)?.cumulativePoolCredits ?? 0;
  const allowance = poolAllowanceCredits(summary.licenseCount, asOf, ALLOWANCE_BASIS);
  const consumedPct = poolConsumedPct(consumed, allowance);

  const chartData: BurndownPoint[] = summary.dailyBurn.map((point, index) => ({
    day: index,
    credits: point.cumulativePoolCredits,
  }));

  return (
    <section className="overview" aria-label="Overview">
      <div className="overview__lens-row">
        <span className="overview__lens-label">Forecast lens</span>
        <div
          className="overview__lens-toggle"
          title="Forecast lens unlocks once Phase 4 (Forecasting) ships"
        >
          <button type="button" className="overview__lens-btn overview__lens-btn--active" disabled aria-disabled="true">
            Pool phase
          </button>
          <button type="button" className="overview__lens-btn" disabled aria-disabled="true">
            Metered phase
          </button>
        </div>
        {/* Never color-only (design/README.md's accessibility intent): icon + text pair with the disabled/dimmed styling. */}
        <span className="overview__lens-cue">
          <span aria-hidden="true">🔒</span> Coming in Phase 4 (Forecasting)
        </span>
      </div>

      <div className="overview__chart-card">
        <div className="overview__chart-header">
          <div>
            <div className="overview__chart-eyebrow">Enterprise pool burn-down</div>
            <div className="overview__chart-headline">
              <span className="overview__chart-headline-burned">{formatNumber(consumed)}</span>
              <span className="overview__chart-headline-of"> of {formatNumber(allowance)} burned</span>
            </div>
          </div>
          <div className="overview__chart-legend">
            <span className="overview__legend-item">
              <span className="overview__legend-swatch overview__legend-swatch--actual" aria-hidden="true" />
              Actual burn
            </span>
            <span className="overview__legend-item">
              <span className="overview__legend-swatch overview__legend-swatch--allowance" aria-hidden="true" />
              Allowance
            </span>
          </div>
        </div>
        <BurndownChart data={chartData} daysInCycle={bounds.daysInCycle} allowance={allowance} />
      </div>

      <div className="overview__tiles">
        <RunwayTile
          label="Days elapsed in cycle"
          value={`${bounds.daysElapsed} of ${bounds.daysInCycle}`}
          sub="days into the current billing cycle"
        />
        <RunwayTile
          label="Pool % consumed"
          value={formatPercent(consumedPct)}
          sub={`${formatNumber(consumed)} of ${formatNumber(allowance)} credits`}
        />
        <RunwayTile label="Credits consumed" value={formatNumber(consumed)} sub="cycle-to-date, pool phase" />
        <RunwayTile label="Allowance" value={formatNumber(allowance)} sub={`${summary.licenseCount} licenses`} />
      </div>

      <AlertsList alerts={alerts} />
    </section>
  );
}
