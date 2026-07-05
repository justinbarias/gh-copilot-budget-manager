import { useEffect, useState } from 'react';
import {
  creditsToUsd,
  cycleBounds,
  poolAllowanceCredits,
  poolConsumedPct,
  type AllowanceBasis,
  type BudgetControl,
  type ControlState,
} from '@copilot-budget/core';
import type { Alert, StoredForecast, UsageSummary } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { BurndownChart, type BurndownForecastLayer, type BurndownPoint } from '../../components/BurndownChart';
import { RunwayTile } from '../../components/RunwayTile';
import { MeteredBudgetBar } from '../../components/MeteredBudgetBar';
import { CliffBanner } from '../../components/CliffBanner';
import { cycleForecastView } from '../../lib/forecastDerive';
import { AlertsList } from './AlertsList';
import './Overview.css';

// SPEC.md Assumption 1 (superset case: GitHub Enterprise) + Open Questions
// ("existing customer" promo-eligibility assumed true for MVP fixtures) --
// CLAUDE.md §9's gating questions are still open, so this is the one
// hardcoded org-shape assumption Task 2.1 needs to resolve the allowance.
const ALLOWANCE_BASIS: AllowanceBasis = { edition: 'enterprise', existingCustomer: true };

// packages/core/src/poolAllowance.ts's promo-window end (not itself exported --
// it's a private module constant) -- probe dates safely inside each window,
// same recipe Forecast.tsx's basis toggle already uses, so the cliff date
// rendered here can never drift from the one poolAllowanceCredits actually acts on.
const CLIFF_DATE = '2026-09-01';
const PROMO_PROBE_DATE = new Date('2026-07-01T00:00:00.000Z');
const STANDARD_PROBE_DATE = new Date('2026-09-01T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatUsdWhole(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

// The Overview runway tile's "Projected metered spend" literal needs
// cents-precision (design honesty over the Forecast screen's rounded
// formatUsd()) -- it's the multi-cycle horizon total, a headline figure on
// its own tile rather than a chart annotation, so the extra precision is
// worth the two decimals.
function formatUsdCents(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function findEnterpriseBudget(controls: readonly ControlState[]): BudgetControl | null {
  return controls.find((c): c is BudgetControl => c.kind === 'budget' && c.scope === 'enterprise') ?? null;
}

// Days (whole) between `asOf` and the 1 Sep 2026 cliff -- null once the cliff
// is behind us (the banner never renders negative/past-tense "days out").
function daysUntilCliff(asOf: Date): number | null {
  const cliffMs = new Date(`${CLIFF_DATE}T00:00:00.000Z`).getTime();
  const diff = Math.round((cliffMs - asOf.getTime()) / MS_PER_DAY);
  return diff > 0 ? diff : null;
}

export interface OverviewProps {
  /** Task 5.7: the cliff banner's "Visualise the cliff ->" link, same cross-link mechanism App.tsx already wires for Controls' Auto-balance link. */
  onNavigateToForecast?: () => void;
  /** Task 8.4: the Alerts panel's "View in audit ->" cross-link -- a disabled Task 2.5 stub until the Audit screen existed. */
  onNavigateToAudit?: () => void;
}

type ForecastLens = 'pool' | 'metered';

export function Overview({ onNavigateToForecast, onNavigateToAudit }: OverviewProps) {
  const api = useApiClient();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  // Task 5.7: the enterprise-scope forecast + live controls (for the metered
  // lens' budget/hard-stop line) -- null exactly when no Sync Now has ever
  // run, same "loading vs genuinely null" distinction Forecast.tsx uses, so
  // the pre-sync state never flashes an empty overlay while still in flight.
  const [forecast, setForecast] = useState<StoredForecast | null>(null);
  const [controls, setControls] = useState<ControlState[] | null>(null);
  const [forecastLoaded, setForecastLoaded] = useState(false);
  const [lens, setLens] = useState<ForecastLens>('pool');

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

  // Task 5.7: forecast + controls fetched together (both feed the metered
  // lens' budget/hard-stop line; the pool lens' overlay only needs forecast).
  // Independent of summary/alerts for the same reason those two are
  // independent of each other -- no single slow fetch can gate another.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getForecast('enterprise'), api.getControls()]).then(([forecastResult, controlsResult]) => {
      if (cancelled) return;
      setForecast(forecastResult);
      setControls(controlsResult);
      setForecastLoaded(true);
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

  // Task 5.7: the pool burn-down's forecast overlay -- P50 dashed + P50-P90
  // band + exhaustion marker, additive to the Task 2.1 actual-only chart via
  // BurndownChart's existing (Task 5.5) `forecast` prop. Undefined (no
  // overlay) whenever forecast hasn't been computed yet -- pre-sync, this
  // renders BYTE-FOR-BYTE the same actual-only chart the MVP shipped.
  const view = forecast ? cycleForecastView(forecast.result) : null;
  const forecastLayer: BurndownForecastLayer | undefined =
    view && view.exhaustionDay !== null
      ? {
          p50: view.p50,
          p90: view.p90,
          exhaustionDay: view.exhaustionDay,
          exhaustionLabel: forecast?.result.exhaustionDate
            ? `${forecast.result.exhaustionDate} · day ${view.exhaustionDay + 1}`
            : undefined,
          provisionalDay: view.provisionalDay ?? undefined,
        }
      : view
        ? { p50: view.p50, p90: view.p90, provisionalDay: view.provisionalDay ?? undefined }
        : undefined;

  // Task 5.7 runway tiles: "Days elapsed" and "Pool % consumed" stay the
  // MVP's factual, cycle-to-date tiles (design/README.md's Overview section
  // + PLAN.md Task 5.7 both retain these); "Credits consumed" and
  // "Allowance" upgrade to real projections once a forecast exists --
  // "Pool runway"/"Projected metered spend" -- reverting to the exact MVP
  // tiles pre-sync (forecast === null) so the screen never shows a
  // half-upgraded grid.
  const poolRunwayDays = forecast?.result.runwayDays ?? null;
  const projectedMeteredDollars = forecast?.result.projectedMeteredDollars ?? null;

  // Cliff banner: real fixture constants, promo vs standard basis, for
  // THIS org's actual license count (not the design's illustrative 500k/315k).
  const promoAllowance = poolAllowanceCredits(summary.licenseCount, PROMO_PROBE_DATE, ALLOWANCE_BASIS);
  const standardAllowance = poolAllowanceCredits(summary.licenseCount, STANDARD_PROBE_DATE, ALLOWANCE_BASIS);
  const cliffDaysOut = daysUntilCliff(asOf);

  // Metered lens data (controls arrive alongside forecast -- see the effect above).
  const enterpriseBudget = controls ? findEnterpriseBudget(controls) : null;
  const enterpriseBudgetUsd = enterpriseBudget ? creditsToUsd(enterpriseBudget.amountCredits) : null;
  const enterpriseBudgetHardStop = enterpriseBudget?.preventFurtherUsage ?? false;
  const meteredActive = forecast !== null && forecast.result.projectedMeteredCredits > 0;
  const meteredOverBudget = enterpriseBudgetHardStop && enterpriseBudgetUsd !== null && (projectedMeteredDollars ?? 0) > enterpriseBudgetUsd;

  return (
    <section className="overview" aria-label="Overview">
      {cliffDaysOut !== null && (
        <CliffBanner
          cliffDate={CLIFF_DATE}
          daysOut={cliffDaysOut}
          promoAllowance={promoAllowance}
          standardAllowance={standardAllowance}
          onNavigateToForecast={() => onNavigateToForecast?.()}
        />
      )}

      <div className="overview__lens-row">
        <span className="overview__lens-label">Forecast lens</span>
        <div className="overview__lens-toggle">
          <button
            type="button"
            className={`overview__lens-btn ${lens === 'pool' ? 'overview__lens-btn--active' : ''}`}
            onClick={() => setLens('pool')}
          >
            Pool phase
          </button>
          <button
            type="button"
            className={`overview__lens-btn ${lens === 'metered' ? 'overview__lens-btn--active' : ''}`}
            onClick={() => setLens('metered')}
          >
            Metered phase
          </button>
        </div>
      </div>

      {lens === 'pool' && (
        <>
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
                {forecastLayer && (
                  <>
                    <span className="overview__legend-item">
                      <span className="overview__legend-swatch overview__legend-swatch--p50" aria-hidden="true" />
                      Forecast P50
                    </span>
                    <span className="overview__legend-item">
                      <span className="overview__legend-swatch overview__legend-swatch--band" aria-hidden="true" />
                      P50–P90 band
                    </span>
                  </>
                )}
                <span className="overview__legend-item">
                  <span className="overview__legend-swatch overview__legend-swatch--allowance" aria-hidden="true" />
                  Allowance
                </span>
              </div>
            </div>
            <BurndownChart data={chartData} daysInCycle={bounds.daysInCycle} allowance={allowance} forecast={forecastLayer} />
            {forecastLayer?.provisionalDay !== undefined && (
              <div className="overview__provisional-caption">
                <span className="overview__provisional-swatch" aria-hidden="true" />
                Most recent day is provisional — settling window still open, don't react to it.
              </div>
            )}
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
            {forecast === null ? (
              <>
                <RunwayTile label="Credits consumed" value={formatNumber(consumed)} sub="cycle-to-date, pool phase" />
                <RunwayTile label="Allowance" value={formatNumber(allowance)} sub={`${summary.licenseCount} licenses`} />
              </>
            ) : (
              <>
                <RunwayTile
                  label="Pool runway"
                  value={poolRunwayDays !== null ? `${poolRunwayDays} day${poolRunwayDays === 1 ? '' : 's'}` : 'Full cycle'}
                  sub={
                    forecast.result.exhaustionDate
                      ? `Projected exhaustion ${forecast.result.exhaustionDate}`
                      : 'No exhaustion projected this cycle'
                  }
                  tone={poolRunwayDays !== null ? 'red' : 'green'}
                />
                <RunwayTile
                  label="Projected metered spend"
                  value={formatUsdCents(projectedMeteredDollars ?? 0)}
                  sub="full multi-cycle forecast horizon through the Sep cliff -- not just this cycle"
                  tone={(projectedMeteredDollars ?? 0) > 0 ? (meteredOverBudget ? 'red' : 'amber') : 'green'}
                />
              </>
            )}
          </div>
        </>
      )}

      {/* forecastLoaded gates this the same way Forecast.tsx gates its own
          empty-state (`scope !== 'cost_center' && forecastLoaded && forecast
          === null`) -- so switching to the Metered lens before the parallel
          getForecast()/getControls() fetch resolves never flashes the
          "No forecast yet" card for a fetch that's merely still in flight. */}
      {lens === 'metered' && forecastLoaded &&
        (forecast === null ? (
          <div className="overview__empty-card" data-testid="overview-metered-empty-state">
            <div className="overview__empty-title">No forecast yet</div>
            <p className="overview__empty-body">
              Forecasts are computed during Sync Now. Head to Settings and run Sync Now to compute the enterprise's projected
              metered-phase spend.
            </p>
          </div>
        ) : meteredActive ? (
          <>
            <div className="overview__metered-card">
              <div className="overview__chart-eyebrow">Metered-phase spend forecast</div>
              <div
                className={`overview__metered-headline ${meteredOverBudget ? 'overview__metered-headline--red' : 'overview__metered-headline--amber'}`}
                data-testid="overview-metered-headline"
              >
                projected {formatUsdCents(projectedMeteredDollars ?? 0)}
                {enterpriseBudgetUsd !== null ? ` of ${formatUsdWhole(enterpriseBudgetUsd)} metered budget` : ' -- no metered budget set'}
                {' · '}
                {enterpriseBudgetHardStop ? 'hard-stop projected' : 'hard-stop not projected'}
              </div>
              <p className="overview__metered-caption">
                Metered charges begin only once the shared pool is exhausted. This projects spend across the{' '}
                <strong>full multi-cycle forecast horizon</strong> — every cycle through the 1 Sep allowance cliff, not just
                this cycle — against the enterprise's metered budget;{' '}
                {enterpriseBudgetHardStop ? 'usage is blocked at the budget line.' : 'this control is alert-only, so usage continues past the line.'}
              </p>
              <MeteredBudgetBar p50={projectedMeteredDollars ?? 0} budget={enterpriseBudgetUsd} hardStop={enterpriseBudgetHardStop} />
              {enterpriseBudgetUsd === null && (
                <p className="overview__gap-note">No enterprise spending-limit control found — the budget/hard-stop line is omitted.</p>
              )}
              <p className="overview__gap-note">
                P90 isn't shown here: the persisted forecast computes one P50-equivalent metered total across the whole
                horizon, with no P90 counterpart (design gap — see the Task 5.5 build report).
              </p>
            </div>

            <div className="overview__metered-tiles">
              <RunwayTile
                label="Metered budget"
                value={enterpriseBudgetUsd !== null ? formatUsdWhole(enterpriseBudgetUsd) : 'none set'}
                sub={enterpriseBudgetUsd !== null ? `enterprise · ${enterpriseBudgetHardStop ? 'hard-stop on' : 'alert-only'}` : 'no enterprise spending-limit control'}
              />
              <RunwayTile
                label="Projected metered (P50)"
                value={formatUsdCents(projectedMeteredDollars ?? 0)}
                sub="full multi-cycle horizon, not just this cycle"
                tone="amber"
              />
              <RunwayTile
                label="Metered phase starts"
                value={forecast.result.exhaustionDate ?? 'not projected'}
                sub="when the pool hits $0"
              />
            </div>
          </>
        ) : (
          <div className="overview__metered-inactive-card">
            <div className="overview__metered-inactive-title">No metered phase projected this cycle</div>
            <p className="overview__metered-inactive-body">
              The shared pool is projected to cover all usage — no metered charges are expected this cycle.
            </p>
          </div>
        ))}

      <AlertsList alerts={alerts} onNavigateToAudit={onNavigateToAudit} />
    </section>
  );
}
