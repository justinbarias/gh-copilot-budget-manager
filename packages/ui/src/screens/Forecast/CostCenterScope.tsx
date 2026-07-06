import { creditsToUsd, type BudgetControl } from '@copilot-budget/core';
import type { ControlState, CostCenterSummary, StoredForecast } from '@copilot-budget/data';
import { BurndownChart, type BurndownForecastLayer, type BurndownPoint } from '../../components/BurndownChart';
import { MeteredBudgetBar } from '../../components/MeteredBudgetBar';
import { cycleForecastView, formatCredits, formatUsd, isoForCycleDay } from '../../lib/forecastDerive';
import './CostCenterScope.css';

// Task 5.6: the Forecast screen's cost-center scope -- design/*.dc.html's v2
// behavior (`isCcCap`/`ccCapOff`/`poolExhaustLabel` in the prototype's
// `render()`): a cap-ON cost center gets its OWN burn-down against its
// license-derived included-usage cap (never the enterprise pool), labeled
// per its overflow choice; a cap-OFF cost center gets an explainer + a
// working cross-link into Controls' caps family instead of a fabricated
// burn-down (CLAUDE.md §5: the cap is the only thing that can be "off" here
// -- there is no cost-center-level pool exhaustion to forecast without one).
// The metered-phase card renders for BOTH variants (a cost center's metered
// spending-limit control is independent of whether its pool-phase cap is on).

function findCostCenterBudget(controls: readonly ControlState[], costCenterName: string): BudgetControl | null {
  return (
    controls.find(
      (c): c is BudgetControl => c.kind === 'budget' && c.scope === 'cost_center' && c.entityName === costCenterName,
    ) ?? null
  );
}

export interface CostCenterScopeProps {
  costCenter: CostCenterSummary;
  controls: readonly ControlState[];
  /** Guaranteed non-null by Forecast.tsx (it renders the shared "No forecast yet" empty state itself when this is null). */
  forecast: StoredForecast;
  onNavigateToControlsCaps: () => void;
}

export function CostCenterScope({ costCenter, controls, forecast, onNavigateToControlsCaps }: CostCenterScopeProps) {
  const cap = costCenter.includedUsageCap;
  const budgetControl = findCostCenterBudget(controls, costCenter.name);
  const budgetUsd = budgetControl ? creditsToUsd(budgetControl.amountCredits) : null;
  const budgetHardStop = budgetControl?.preventFurtherUsage ?? false;
  const meteredActive = forecast.result.projectedMeteredCredits > 0;

  const meteredCard = (
    <div className="forecast__card" data-testid="forecast-cc-metered-card">
      <div className="forecast__eyebrow">{costCenter.name} · metered-phase spend</div>
      {meteredActive ? (
        <>
          <div
            className={`forecast__metered-headline ${
              budgetHardStop && budgetUsd !== null && forecast.result.projectedMeteredDollars > budgetUsd
                ? 'forecast__metered-headline--red'
                : 'forecast__metered-headline--amber'
            }`}
            data-testid="forecast-cc-metered-headline"
          >
            {formatUsd(forecast.result.projectedMeteredDollars)}
          </div>
          <p className="forecast__caption">
            Projected metered charges summed across the <strong>full multi-cycle forecast horizon</strong> — every
            cycle through the 1 Sep allowance cliff, once this cost center's included-usage cap is exhausted —{' '}
            <strong>not just the single cycle charted above</strong>. Measured against this cost center's metered
            budget; the dashed line is the budget / hard-stop threshold.
          </p>
          <MeteredBudgetBar p50={forecast.result.projectedMeteredDollars} budget={budgetUsd} hardStop={budgetHardStop} />
          {budgetUsd === null && (
            <p className="forecast__gap-note">
              No cost-center spending-limit control found for {costCenter.name} — the budget/hard-stop line is
              omitted.
            </p>
          )}
          <p className="forecast__gap-note">
            P90 isn't shown here: the persisted forecast computes one P50-equivalent metered total across the whole
            horizon, with no P90 counterpart.
          </p>
        </>
      ) : (
        <div className="forecast__metered-inactive-card forecast__metered-inactive-card--nested">
          <div className="forecast__metered-inactive-title">No metered phase projected at this scope</div>
          <p className="forecast__metered-inactive-body">
            {cap.enabled
              ? "The included-usage cap is projected to cover all of this cost center's usage — no metered charges are expected."
              : "The shared enterprise pool is projected to cover this cost center's usage — no metered charges are expected."}
          </p>
        </div>
      )}
    </div>
  );

  if (!cap.enabled) {
    return (
      <>
        <div className="forecast__card" data-testid="forecast-cc-cap-off-card">
          <div className="cc-scope__off-row">
            <span className="cc-scope__off-dot" aria-hidden="true" />
            <div className="cc-scope__off-body">
              <div className="cc-scope__off-title">No included-usage cap on {costCenter.name}</div>
              <p className="cc-scope__off-copy">
                Without a cap, this cost center draws from the shared enterprise pool with no per-team ceiling — so
                there is no cost-center pool exhaustion to forecast. Its metered budget is still capped (below). Turn
                on the included-usage cap to give this team its own carve of the pool and a per-team runway.
              </p>
              <p className="forecast__gap-note">
                This cycle: {formatCredits(costCenter.mtdBurnCredits)} credits drawn (pool + metered) — no cap to
                compare against.
              </p>
              <button
                type="button"
                className="cc-scope__cta"
                data-testid="forecast-cc-enable-cap-cta"
                onClick={onNavigateToControlsCaps}
              >
                Enable included-usage cap in Controls →
              </button>
            </div>
          </div>
        </div>
        {meteredCard}
      </>
    );
  }

  const view = cycleForecastView(forecast.result);
  if (view === null) {
    // Unreachable through the UI's own entity picker against real synced
    // data (every active cost center's forecast has a non-empty dailySeries)
    // -- kept honest rather than throwing, same convention forecastDerive.ts
    // documents for cycleForecastView's own null case.
    return (
      <>
        <div className="forecast__card">
          <p className="forecast__caption">No burn-down data available for this cost center yet.</p>
        </div>
        {meteredCard}
      </>
    );
  }

  const runwayDays = forecast.result.runwayDays;
  const headline =
    runwayDays !== null ? `runway ~${runwayDays} day${runwayDays === 1 ? '' : 's'}` : 'within cap all cycle';

  const exhaustionLabel = cap.overflow === 'metered' ? 'Overflow-to-metered date' : 'Cap block date';
  const cycleStartIso = forecast.result.dailySeries[0]?.date ?? null;
  const exhaustionDateLabel = view.exhaustionDay !== null && cycleStartIso ? isoForCycleDay(cycleStartIso, view.exhaustionDay) : null;

  const forecastLayer: BurndownForecastLayer = {
    p50: view.p50,
    p90: view.p90,
    exhaustionDay: view.exhaustionDay ?? undefined,
    exhaustionLabel: exhaustionDateLabel ? `${exhaustionDateLabel} · day ${view.exhaustionDay! + 1}` : undefined,
    provisionalDay: view.provisionalDay ?? undefined,
  };

  const actualData: BurndownPoint[] = view.actual;

  return (
    <>
      <div className="forecast__card">
        <div className="cc-scope__chip-row">
          <span className="cc-scope__apionly-pill" title="No native GitHub UI for this control — API-first only.">
            API-ONLY
          </span>
          <span className="cc-scope__cap-state">
            Included-usage cap · {cap.overflow === 'metered' ? 'Overflow → metered' : 'Block'}
          </span>
        </div>
        <div className="forecast__card-header">
          <div className="forecast__card-header-left">
            <div className="forecast__eyebrow">{costCenter.name} · included-usage cap</div>
            <div className="forecast__headline" data-testid="forecast-cc-runway">
              {headline}
            </div>
          </div>
          <div className="forecast__block-col">
            <div className="forecast__block-label">{exhaustionLabel}</div>
            <div
              className={`forecast__block-date ${exhaustionDateLabel ? 'forecast__block-date--red' : ''}`}
              data-testid="forecast-cc-exhaustion-date"
            >
              {exhaustionDateLabel ?? 'none'}
            </div>
          </div>
        </div>
        <p className="forecast__caption">
          Forecasts when this cost center exhausts its included-usage cap — its carve of the shared pool. At the cap,
          usage {cap.overflow === 'block' ? 'is blocked.' : 'overflows to metered.'}
        </p>
        <BurndownChart data={actualData} daysInCycle={view.daysInCycle} allowance={view.allowance} forecast={forecastLayer} />
      </div>
      {meteredCard}
    </>
  );
}
