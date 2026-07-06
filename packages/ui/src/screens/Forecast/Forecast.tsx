import { useEffect, useMemo, useState } from 'react';
import { creditsToUsd, poolAllowanceCredits, rankHeavyUsers, type AllowanceBasis, type BudgetControl } from '@copilot-budget/core';
import type { ControlState, CostCenterSummary, HeavyUser, StoredForecast, UsageSummary } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { BurndownChart, type BurndownForecastLayer, type BurndownPoint } from '../../components/BurndownChart';
import { MeteredBudgetBar } from '../../components/MeteredBudgetBar';
import { BacktestChart } from '../../components/BacktestChart';
import { CostCenterScope } from './CostCenterScope';
import { crossingDay, cycleForecastView, formatCredits, formatUsd, isoForCycleDay } from '../../lib/forecastDerive';
import './Forecast.css';

type Scope = 'enterprise' | 'cost_center' | 'user';
type Basis = 'promo' | 'standard';

const SCOPE_TABS: ReadonlyArray<{ id: Scope; label: string }> = [
  { id: 'enterprise', label: 'Enterprise' },
  { id: 'cost_center', label: 'Cost centers' },
  { id: 'user', label: 'Users' },
];

// Same hardcoded org-shape assumption Overview.tsx already makes (CLAUDE.md
// §9's gating questions are still open) -- reused here rather than
// re-deriving a second one, so the enterprise allowance this screen shows
// never disagrees with Overview's.
const ALLOWANCE_BASIS: AllowanceBasis = { edition: 'enterprise', existingCustomer: true };

// Forced probe dates used ONLY to read poolAllowanceCredits' flat promo/
// standard per-seat rate for the basis toggle below -- poolAllowanceCredits
// itself decides promo-vs-standard purely from the date argument
// (packages/core/src/poolAllowance.ts's promo window is 1 Jun-1 Sep 2026), so
// picking one date safely inside each window is how the toggle asks for "the
// promo rate" / "the standard rate" as a flat, always-on hypothetical --
// without a second core export or a new bridge call.
const PROMO_PROBE_DATE = new Date('2026-07-01T00:00:00.000Z');
const STANDARD_PROBE_DATE = new Date('2026-09-01T00:00:00.000Z');

function findEnterpriseBudget(controls: readonly ControlState[]): BudgetControl | null {
  return controls.find((c): c is BudgetControl => c.kind === 'budget' && c.scope === 'enterprise') ?? null;
}

export interface ForecastProps {
  /** Task 5.6: the cost-center scope's cap-off explainer CTA -- deep-links into Controls' Included-usage caps family (App.tsx wires this to a real family-tab switch, not a dead link). */
  onNavigateToControlsCaps: () => void;
}

export function Forecast({ onNavigateToControlsCaps }: ForecastProps) {
  const api = useApiClient();

  // Null-initial loading, same pattern as Controls/CostCenters/Users.
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [heavyUsers, setHeavyUsers] = useState<HeavyUser[] | null>(null);
  const [costCenters, setCostCenters] = useState<CostCenterSummary[] | null>(null);
  const [controls, setControls] = useState<ControlState[] | null>(null);

  const [scope, setScope] = useState<Scope>('enterprise');
  const [userEntityId, setUserEntityId] = useState<string | null>(null);
  // Task 5.6: the cost-center scope's own entity picker, same "null until the
  // admin picks one, defaulting to the first roster entry" shape as
  // userEntityId above (see effectiveCcId below).
  const [ccEntityId, setCcEntityId] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis>('promo');

  // forecastLoaded distinguishes "still fetching" from "fetched, and it's
  // genuinely null" (no Sync Now has ever run yet, or -- structurally
  // unreachable via the UI's own entity picker -- an unknown entity) so the
  // pre-sync empty state never flashes while a real forecast is still in flight.
  const [forecast, setForecast] = useState<StoredForecast | null>(null);
  const [forecastLoaded, setForecastLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getUsageSummary(), api.listHeavyUsers(), api.listCostCenters(), api.getControls()]).then(
      ([usageSummary, users, costCentersList, controlsList]) => {
        if (cancelled) return;
        setSummary(usageSummary);
        setHeavyUsers(users);
        setCostCenters(costCentersList);
        setControls(controlsList);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Same descending-MTD ranking the Users screen ranks its roster by (core's
  // rankHeavyUsers) -- so the entity picker's default (first row) is the
  // heaviest-burning user, a good "why am I looking at this scope" default,
  // and matches design/README.md's "Heavy user" scope framing.
  const rankedUsers = useMemo(() => (heavyUsers ? rankHeavyUsers(heavyUsers) : []), [heavyUsers]);
  const effectiveUserEntityId = userEntityId ?? rankedUsers[0]?.userId ?? null;
  const selectedUser = rankedUsers.find((u) => u.userId === effectiveUserEntityId) ?? null;

  // Task 5.6: cost-center scope's entity resolution -- same "explicit pick,
  // else the first roster entry" shape as the user scope above. No ranking
  // (listCostCenters' own natural order, matching Controls'/CostCenters'
  // entity-select conventions -- neither re-sorts its roster either).
  const effectiveCcId = ccEntityId ?? costCenters?.[0]?.id ?? null;
  const selectedCc = costCenters?.find((cc) => cc.id === effectiveCcId) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (scope === 'user' && effectiveUserEntityId === null) {
      setForecast(null);
      setForecastLoaded(true);
      return;
    }
    if (scope === 'cost_center' && effectiveCcId === null) {
      setForecast(null);
      setForecastLoaded(true);
      return;
    }
    setForecastLoaded(false);
    const request =
      scope === 'user'
        ? api.getForecast('user', effectiveUserEntityId ?? undefined)
        : scope === 'cost_center'
          ? api.getForecast('cost_center', effectiveCcId ?? undefined)
          : api.getForecast('enterprise');
    request.then((result) => {
      if (cancelled) return;
      setForecast(result);
      setForecastLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [api, scope, effectiveUserEntityId, effectiveCcId]);

  if (summary === null || heavyUsers === null || costCenters === null || controls === null) {
    return (
      <section className="forecast" aria-label="Forecast">
        <p className="forecast__loading">Loading…</p>
      </section>
    );
  }

  const promoAllowance = poolAllowanceCredits(summary.licenseCount, PROMO_PROBE_DATE, ALLOWANCE_BASIS);
  const standardAllowance = poolAllowanceCredits(summary.licenseCount, STANDARD_PROBE_DATE, ALLOWANCE_BASIS);

  const view = forecast ? cycleForecastView(forecast.result) : null;

  // Basis toggle (enterprise scope only -- design gap for the "Heavy user"
  // scope, see the Task 5.5 build report): re-derives a HYPOTHETICAL flat
  // allowance client-side from the SAME persisted P50 series, rather than
  // trusting the real (correctly cliff-stepped) allowanceLine the payload
  // already carries. 'promo' reproduces the real persisted numbers exactly
  // for any cycle inside the 1 Jun-1 Sep promo window (every DEWR-world
  // cycle through Aug 2026); 'standard' is a "what if this were already the
  // post-cliff rate" exploration -- never the live truth for THIS cycle.
  const isRealBasis = scope !== 'enterprise' || basis === 'promo';
  const toggledAllowance = basis === 'promo' ? promoAllowance : standardAllowance;
  const hypotheticalExhaustionDay = view && !isRealBasis ? crossingDay(view.p50, toggledAllowance) : null;

  const displayAllowance = view ? (isRealBasis ? view.allowance : toggledAllowance) : 0;
  const displayExhaustionDay = isRealBasis ? (view?.exhaustionDay ?? null) : hypotheticalExhaustionDay;

  const cycleStartIso = forecast?.result.dailySeries[0]?.date ?? null;
  const exhaustionDateLabel = displayExhaustionDay !== null && cycleStartIso ? isoForCycleDay(cycleStartIso, displayExhaustionDay) : null;
  const runwayDays = isRealBasis
    ? (forecast?.result.runwayDays ?? null)
    : view && displayExhaustionDay !== null
      ? Math.max(0, displayExhaustionDay - view.lastActualDay)
      : null;

  const forecastLayer: BurndownForecastLayer | undefined = view
    ? {
        p50: view.p50,
        p90: view.p90,
        exhaustionDay: displayExhaustionDay ?? undefined,
        exhaustionLabel: exhaustionDateLabel ? `${exhaustionDateLabel} · day ${displayExhaustionDay! + 1}` : undefined,
        provisionalDay: view.provisionalDay ?? undefined,
      }
    : undefined;

  const actualData: BurndownPoint[] = view ? view.actual : [];

  const enterpriseBudget = findEnterpriseBudget(controls);
  const enterpriseBudgetUsd = enterpriseBudget ? creditsToUsd(enterpriseBudget.amountCredits) : null;
  const enterpriseBudgetHardStop = enterpriseBudget?.preventFurtherUsage ?? false;
  const meteredActive = scope === 'enterprise' && forecast !== null && forecast.result.projectedMeteredCredits > 0;

  const poolEyebrow = scope === 'enterprise' ? 'Enterprise pool' : selectedUser ? selectedUser.userLogin : 'Heavy user';
  const poolCaption =
    scope === 'enterprise'
      ? 'Projected burn-down of the shared enterprise pool against the included allowance — P50–P90 band with the exhaustion marker.'
      : "Projected pool draw for this heavy user against their effective user-level budget — P50–P90 band with the projected block date.";

  const pctRows = view
    ? [
        { label: 'P50 (median)', value: formatCredits(view.p50.at(-1)?.credits ?? 0) },
        { label: 'P90 (pessimistic)', value: formatCredits(view.p90.at(-1)?.credits ?? 0) },
      ]
    : [];

  return (
    <section className="forecast" aria-label="Forecast">
      <div className="forecast__toolbar">
        <div className="forecast__tabs" role="tablist" aria-label="Forecast scope">
          {SCOPE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={scope === tab.id}
              className={`forecast__tab ${scope === tab.id ? 'forecast__tab--active' : ''}`}
              onClick={() => setScope(tab.id)}
            >
              {tab.label}
            </button>
          ))}

          {scope === 'user' && (
            <select
              className="forecast__entity-select"
              aria-label="Heavy user"
              data-testid="forecast-entity-select"
              value={effectiveUserEntityId ?? ''}
              onChange={(e) => setUserEntityId(e.target.value)}
            >
              {rankedUsers.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.userLogin} · {formatCredits(u.creditsUsed)} MTD
                </option>
              ))}
            </select>
          )}

          {scope === 'cost_center' && (
            <select
              className="forecast__entity-select"
              aria-label="Cost center"
              data-testid="forecast-cc-select"
              value={effectiveCcId ?? ''}
              onChange={(e) => setCcEntityId(e.target.value)}
            >
              {costCenters.map((cc) => (
                <option key={cc.id} value={cc.id}>
                  {cc.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {scope === 'enterprise' && (
          <div className="forecast__basis-toggle" data-testid="forecast-basis-toggle">
            <span className="forecast__basis-label">Allowance basis</span>
            <div className="forecast__basis-buttons">
              <button
                type="button"
                className={`forecast__basis-btn ${basis === 'promo' ? 'forecast__basis-btn--active' : ''}`}
                onClick={() => setBasis('promo')}
              >
                Promo ({formatCredits(promoAllowance)})
              </button>
              <button
                type="button"
                className={`forecast__basis-btn ${basis === 'standard' ? 'forecast__basis-btn--active' : ''}`}
                onClick={() => setBasis('standard')}
              >
                Standard ({formatCredits(standardAllowance)})
              </button>
            </div>
          </div>
        )}
      </div>

      {forecastLoaded && forecast === null && (
        <div className="forecast__empty-card" data-testid="forecast-empty-state">
          <div className="forecast__empty-title">No forecast yet</div>
          <p className="forecast__empty-body">
            Forecasts are computed during Sync Now. Head to Settings and run Sync Now to compute{' '}
            {scope === 'enterprise' ? 'the enterprise' : scope === 'cost_center' ? "this cost center's" : "this user's"}{' '}
            pool burn-down, projected{' '}
            {scope === 'enterprise' ? 'exhaustion date' : scope === 'cost_center' ? 'cap block/overflow date' : 'block date'}, and
            backtest accuracy.
          </p>
        </div>
      )}

      {scope === 'cost_center' && forecast && selectedCc && (
        <CostCenterScope
          costCenter={selectedCc}
          controls={controls}
          forecast={forecast}
          onNavigateToControlsCaps={onNavigateToControlsCaps}
        />
      )}

      {scope !== 'cost_center' && view && forecast && (
        <>
          <div className="forecast__card">
            <div className="forecast__card-header">
              <div className="forecast__card-header-left">
                <div className="forecast__eyebrow">{poolEyebrow} · runway</div>
                <div className="forecast__headline" data-testid="forecast-runway">
                  {runwayDays !== null ? `runway ~${runwayDays} day${runwayDays === 1 ? '' : 's'}` : 'within allowance all cycle'}
                </div>
              </div>
              <div className="forecast__block-col">
                <div className="forecast__block-label">{scope === 'user' ? 'Projected block date' : 'Projected exhaustion'}</div>
                <div
                  className={`forecast__block-date ${exhaustionDateLabel ? 'forecast__block-date--red' : ''}`}
                  data-testid="forecast-exhaustion-date"
                >
                  {exhaustionDateLabel ?? 'none'}
                </div>
              </div>
            </div>
            <p className="forecast__caption">{poolCaption}</p>
            <BurndownChart data={actualData} daysInCycle={view.daysInCycle} allowance={displayAllowance} forecast={forecastLayer} />
          </div>

          {scope === 'enterprise' &&
            (meteredActive ? (
              <div className="forecast__card">
                <div className="forecast__eyebrow">Enterprise · metered-phase spend</div>
                <div
                  className={`forecast__metered-headline ${
                    enterpriseBudgetHardStop && enterpriseBudgetUsd !== null && forecast.result.projectedMeteredDollars > enterpriseBudgetUsd
                      ? 'forecast__metered-headline--red'
                      : 'forecast__metered-headline--amber'
                  }`}
                  data-testid="forecast-metered-headline"
                >
                  {formatUsd(forecast.result.projectedMeteredDollars)}
                </div>
                <p className="forecast__caption">
                  Projected metered charges summed across the <strong>full multi-cycle forecast horizon</strong> — every
                  cycle through the 1 Sep allowance cliff, once the shared pool is exhausted — <strong>not just the
                  single cycle charted above</strong>. Measured against the enterprise's metered budget; the dashed line
                  is the budget / hard-stop threshold.
                </p>
                <MeteredBudgetBar
                  p50={forecast.result.projectedMeteredDollars}
                  budget={enterpriseBudgetUsd}
                  hardStop={enterpriseBudgetHardStop}
                />
                {enterpriseBudgetUsd === null && (
                  <p className="forecast__gap-note">
                    No enterprise spending-limit control found — the budget/hard-stop line is omitted.
                  </p>
                )}
                <p className="forecast__gap-note">
                  P90 isn't shown here: the persisted forecast computes one P50-equivalent metered total across the
                  whole horizon, with no P90 counterpart.
                </p>
              </div>
            ) : (
              <div className="forecast__metered-inactive-card">
                <div className="forecast__metered-inactive-title">No metered phase projected at this scope</div>
                <p className="forecast__metered-inactive-body">
                  The shared pool is projected to cover all usage — no metered charges are expected.
                </p>
              </div>
            ))}

          {scope === 'user' && (
            <div className="forecast__scope-note">
              <span className="forecast__scope-note-glyph" aria-hidden="true">
                ⧗
              </span>
              <p>
                A user-level budget hard-stops in both phases, so a bound user's projected block date
                above is a pool-phase event — there's no separate metered-phase forecast for an individual.
              </p>
            </div>
          )}

          <div className="forecast__bottom-grid">
            <BacktestChart mape={forecast.mape} />
            <div className="forecast__pct-card">
              <div className="forecast__pct-title">Percentile detail</div>
              {pctRows.map((row) => (
                <div key={row.label} className="forecast__pct-row">
                  <span className="forecast__pct-label">{row.label}</span>
                  <span className="forecast__pct-value">{row.value}</span>
                </div>
              ))}
              <p className="forecast__gap-note">
                P10 isn't modeled — only P50/P90 are available.
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
