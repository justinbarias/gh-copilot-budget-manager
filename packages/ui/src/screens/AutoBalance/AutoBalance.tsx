import { useEffect, useMemo, useState } from 'react';
import { runPoolRebalancer, type PoolRebalanceContext, type PoolRebalancePlan } from '@copilot-budget/core';
import type { RebalanceContextResult } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { ComingSoon } from '../_stubs/ComingSoon';
import { TriggerCard } from './TriggerCard';
import { EnvelopeBar } from './components/EnvelopeBar';
import { GrantsTable } from './GrantsTable';
import { SimulateRail } from './SimulateRail';
import { derivePool, fmt, hydratePoolContext, type PoolEdits } from './poolViewModel';
import './AutoBalance.css';

// ============================================================================
// Task 6.8 -- the Auto-balance screen, POOL mode, DRY-RUN ONLY (design §4).
//
// Data path: ONE bridge read (getRebalanceContext -- the same server-side
// assembly the engine-proof tests pin their literals against), then the PURE
// core engine runs in the renderer: runPoolRebalancer for the baseline plan,
// and derivePool (simulatePoolRebalance + computeFundingEnvelope) re-runs on
// every grant edit / cap toggle, so the envelope bar, footer, and simulate
// rail recompute live with no IPC.
//
// Checkpoint 6 invariant: NO mutation path exists from this screen. Neither
// this module nor anything under screens/AutoBalance/ imports dryRunPlan /
// applyPlan (or any other writing bridge method); the ⑤ apply button renders
// permanently disabled in its gated pre-apply state.
// ============================================================================

type AbMode = 'pool' | 'metered';

/** Parse a proposed-Δ input: digits only, empty -> 0 (matches the design's numeric field behaviour). */
function parseDelta(raw: string): number {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Math.min(Number.parseInt(digits, 10), 999_999_999);
}

export function AutoBalance() {
  const api = useApiClient();
  const [mode, setMode] = useState<AbMode | null>(null); // null until the phase default resolves
  const [poolResult, setPoolResult] = useState<RebalanceContextResult | null>(null);

  // Default the mode switch to the current phase (design §4): the active
  // scenario carries which rebalancer it exercises; outside simulation (or
  // before the fetch resolves) fall back to pool.
  useEffect(() => {
    let cancelled = false;
    api.getActiveScenario().then((res) => {
      if (cancelled) return;
      setMode(!res.refused && res.scenario.phase === 'metered' ? 'metered' : 'pool');
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api.getRebalanceContext('pool').then((res) => {
      if (!cancelled) setPoolResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <section className="ab" aria-label="Auto-balance">
      <div className="ab-modebar">
        <div className="ab-modebar__left">
          <div className="ab-modeswitch" role="tablist" aria-label="Rebalancer mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode !== 'metered'}
              className={mode !== 'metered' ? 'ab-modeswitch__btn ab-modeswitch__btn--active' : 'ab-modeswitch__btn'}
              onClick={() => setMode('pool')}
              data-testid="ab-mode-pool"
            >
              Pool rebalancer
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'metered'}
              className={mode === 'metered' ? 'ab-modeswitch__btn ab-modeswitch__btn--active' : 'ab-modeswitch__btn'}
              onClick={() => setMode('metered')}
              data-testid="ab-mode-metered"
            >
              Metered redistributor
            </button>
          </div>
          <span className="ab-modebar__tag">
            {mode === 'metered' ? '“spending-headroom redistributor”' : '“use it or lose it”'}
          </span>
        </div>
        <span className="ab-modebar__hint">Redistribution over restriction — move unused headroom to whoever's blocked</span>
      </div>

      {mode === 'metered' ? (
        <ComingSoon
          screenName="Metered redistributor"
          message="Arrives with Task 6.9 — the same ①→④ dry-run flow with a $-denominated envelope, binding-budget grant rows, and the bill-delta hero."
        />
      ) : (
        <PoolMode result={poolResult} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pool mode -- ①→④ from real engine outputs.
// ---------------------------------------------------------------------------

function PoolMode({ result }: { result: RebalanceContextResult | null }) {
  if (result === null) {
    return <div className="ab-loading">Loading rebalancer context…</div>;
  }
  if (!result.available) {
    return (
      <div className="ab-card ab-unavailable" data-testid="ab-unavailable">
        <div className="ab-eyebrow">Pool rebalancer</div>
        <p>
          The pool dry-run isn't available here: {result.reason}. In live mode the context will come from a real
          forecast run (later phase).
        </p>
      </div>
    );
  }
  if (result.mode !== 'pool') {
    // Unreachable by construction (we only ever request 'pool' here).
    return null;
  }
  return <PoolModeLoaded ctx={hydratePoolContext(result.context)} />;
}

function PoolModeLoaded({ ctx }: { ctx: PoolRebalanceContext }) {
  // The whole dry-run, resolved once per context (the baseline "suggested" plan).
  const plan: PoolRebalancePlan = useMemo(() => runPoolRebalancer(ctx), [ctx]);

  // Staged edits (design's abAlloc, pool slice): raw input text per grant row
  // (so typing stays natural) + lifted-cap booleans. Reset restores suggested.
  const [grantValues, setGrantValues] = useState<Record<string, string>>({});
  const [liftedCaps, setLiftedCaps] = useState<Record<string, boolean>>({});

  const edits: PoolEdits = useMemo(
    () => ({
      grantEdits: Object.fromEntries(Object.entries(grantValues).map(([login, raw]) => [login, parseDelta(raw)])),
      liftedCaps,
    }),
    [grantValues, liftedCaps],
  );

  // Live recompute: pure core over the edited rows (cheap -- no IPC).
  const derived = useMemo(() => derivePool(plan, ctx, edits), [plan, ctx, edits]);

  const fired = plan.trigger.fired;
  const consumedFraction = ctx.poolTotalCredits > 0 ? ctx.poolConsumedCredits / ctx.poolTotalCredits : 0;

  return (
    <>
      <TriggerCard trigger={plan.trigger} consumedFraction={consumedFraction} asOfDate={ctx.asOfDate} />

      <div className="ab-columns">
        <div className="ab-columns__main">
          <div className="ab-card ab-envcard">
            <div className="ab-envcard__head">
              <div className="ab-eyebrow">② Funding envelope</div>
              <div className="ab-envcard__headline mono" data-testid="ab-env-redistributable">
                {fmt(derived.envelope.envelopeCredits)} redistributable
              </div>
            </div>
            <div className="ab-envcard__formula">
              <span className="mono">remaining pool − reserve − Σ projected(on-track)</span> — reserve{' '}
              {fmt(derived.envelope.reserveCredits)} carved out explicitly.
            </div>
            <EnvelopeBar envelope={derived.envelope} />
          </div>

          {fired ? (
            <GrantsTable
              grants={derived.grants}
              capRelax={plan.allocation.capRelax}
              grantValues={grantValues}
              liftedCaps={liftedCaps}
              onEditGrant={(login, raw) => setGrantValues((v) => ({ ...v, [login]: raw.replace(/[^0-9]/g, '') }))}
              onToggleCap={(key) => setLiftedCaps((c) => ({ ...c, [key]: !c[key] }))}
              onReset={() => {
                setGrantValues({});
                setLiftedCaps({});
              }}
              fundedCount={derived.fundedCount}
              allocatedCredits={derived.sim.totalGrantedCredits}
              unallocatedCredits={derived.envelope.envelopeCredits - derived.sim.totalGrantedCredits}
              capUnlockTotal={derived.capUnlockTotal}
            />
          ) : (
            <div className="ab-card ab-empty" data-testid="ab-empty">
              <div className="ab-eyebrow">③ At-risk entities · proposed grants</div>
              <p className="ab-empty__body">
                Trigger conditions not met — no redistribution proposed. This table populates with proposed ULB grants
                and cap-relax actions when the pool rebalancer fires (all three trigger conditions above hold).
              </p>
            </div>
          )}
        </div>

        <SimulateRail sim={derived.sim} />
      </div>
    </>
  );
}
