import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  evaluateMeteredRebalance,
  isUlbScope,
  runPoolRebalancer,
  type MeteredRebalanceInput,
  type MeteredRebalancePlan,
  type PoolRebalanceContext,
  type PoolRebalancePlan,
} from '@copilot-budget/core';
import type { RebalanceContextResult } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { Skeleton, SkeletonGroup } from '../../components/Skeleton';
import { TriggerCard } from './TriggerCard';
import { EnvelopeBar } from './components/EnvelopeBar';
import { GrantsTable } from './GrantsTable';
import { SimulateRail } from './SimulateRail';
import { MeteredTriggerCard } from './MeteredTriggerCard';
import { MeteredGrantsTable } from './MeteredGrantsTable';
import { MeteredSimulateRail } from './MeteredSimulateRail';
import { derivePool, fmt, hydratePoolContext, type PoolEdits } from './poolViewModel';
import { deriveMetered, enterpriseBudgetTotalUsd, fmtUsd, hydrateMeteredContext, type MeteredEdits } from './meteredViewModel';
import './AutoBalance.css';

// ============================================================================
// Task 6.8/6.9 -- the Auto-balance screen, both rebalancer modes, DRY-RUN
// ONLY (design §4).
//
// Data path (both modes): ONE bridge read each (getRebalanceContext('pool' /
// 'metered') -- the same server-side assembly the engine-proof tests pin
// their literals against), then the PURE core engine runs in the renderer:
// runPoolRebalancer / evaluateMeteredRebalance for the baseline plan, and
// derivePool / deriveMetered (which re-invoke simulatePoolRebalance+
// computeFundingEnvelope / simulateMeteredGrants) re-run on every grant edit
// / cap toggle, so the envelope bar, footer, and simulate rail recompute live
// with no IPC.
//
// PER-MODE EDIT RETENTION (design state note, Task 6.9's acceptance
// criterion): `abAlloc` is a SINGLE map lifted to THIS component (not owned
// by either mode's loaded subtree), keyed `${mode}:${entityId}` -- so
// switching Pool -> Metered -> Pool does not unmount-and-lose either mode's
// edits (each mode's subtree only ever reads/writes its own `${mode}:`-
// prefixed slice). `liftedCaps` stays a SEPARATE boolean map, pool-only: the
// included-usage cap structurally carries no settable delta (CLAUDE.md §5),
// so it is never folded into the numeric abAlloc map the way the raw design
// prototype's HTML mock does (see poolViewModel.ts's PoolEdits doc comment).
//
// Checkpoint 6 invariant: NO mutation path exists from this screen, in
// EITHER mode. Neither this module nor anything under screens/AutoBalance/
// imports dryRunPlan / applyPlan (or any other writing bridge method); the
// ⑤ apply button renders permanently disabled in its gated pre-apply state.
// ============================================================================

type AbMode = 'pool' | 'metered';

/** Parse a proposed-Δ CREDITS input: digits only, empty -> 0 (matches the design's numeric field behaviour). Pool mode's rows are credit-denominated. */
function parseDelta(raw: string): number {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Math.min(Number.parseInt(digits, 10), 999_999_999);
}

/** Parse a proposed-Δ DOLLAR input (metered mode is $-denominated, design §4 Mode B): digits only, whole dollars, converted to credits ($1 = 100 credits, CLAUDE.md §5). */
function parseDeltaUsd(raw: string): number {
  const digits = raw.replace(/[^0-9]/g, '');
  const dollars = digits === '' ? 0 : Math.min(Number.parseInt(digits, 10), 999_999_999);
  return dollars * 100;
}

export function AutoBalance() {
  const api = useApiClient();
  const [mode, setMode] = useState<AbMode | null>(null); // null until the phase default resolves
  const [poolResult, setPoolResult] = useState<RebalanceContextResult | null>(null);
  const [meteredResult, setMeteredResult] = useState<RebalanceContextResult | null>(null);
  // 2026-07-09 live-wiring round: the app mode (simulation | live) decides the
  // UNAVAILABLE-card advice only -- the sim copy suggests switching scenarios,
  // which is a sim-only affordance and must never render as live advice (the
  // old copy was a dead end there). Same existing api.getMode() signal the
  // sim banner/Controls already read; null until resolved (treated as sim).
  const [appMode, setAppMode] = useState<'simulation' | 'live' | null>(null);

  // Per-mode edit retention (see module doc comment above).
  const [abAlloc, setAbAlloc] = useState<Record<string, string>>({});
  const [liftedCaps, setLiftedCaps] = useState<Record<string, boolean>>({});

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
    Promise.all([api.getRebalanceContext('pool'), api.getRebalanceContext('metered'), api.getMode()]).then(
      ([pool, metered, resolvedAppMode]) => {
        if (cancelled) return;
        setPoolResult(pool);
        setMeteredResult(metered);
        setAppMode(resolvedAppMode);
      },
    );
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
        <MeteredMode result={meteredResult} appMode={appMode} abAlloc={abAlloc} setAbAlloc={setAbAlloc} />
      ) : (
        <PoolMode
          appMode={appMode}
          result={poolResult}
          abAlloc={abAlloc}
          setAbAlloc={setAbAlloc}
          liftedCaps={liftedCaps}
          setLiftedCaps={setLiftedCaps}
        />
      )}
    </section>
  );
}

// Shared by both modes' "rebalance context still fetching" branch below --
// three card-shaped blocks echoing the loaded ①trigger/②envelope/③table
// rhythm, rather than either mode inventing its own shape.
function AbContextSkeleton() {
  return (
    <SkeletonGroup>
      <div className="ab-card">
        <Skeleton variant="block" height={90} />
      </div>
      <div className="ab-card">
        <Skeleton variant="block" height={140} />
      </div>
      <div className="ab-card">
        <Skeleton variant="block" height={220} />
      </div>
    </SkeletonGroup>
  );
}

// ---------------------------------------------------------------------------
// Pool mode -- ①→④ from real engine outputs.
// ---------------------------------------------------------------------------

interface PoolModeProps {
  result: RebalanceContextResult | null;
  appMode: 'simulation' | 'live' | null;
  abAlloc: Record<string, string>;
  setAbAlloc: Dispatch<SetStateAction<Record<string, string>>>;
  liftedCaps: Record<string, boolean>;
  setLiftedCaps: Dispatch<SetStateAction<Record<string, boolean>>>;
}

function PoolMode({ result, appMode, abAlloc, setAbAlloc, liftedCaps, setLiftedCaps }: PoolModeProps) {
  if (result === null) {
    return <AbContextSkeleton />;
  }
  if (!result.available) {
    return (
      <div className="ab-card ab-unavailable" data-testid="ab-unavailable">
        <div className="ab-eyebrow">Pool rebalancer</div>
        <p>
          The pool dry-run isn't available here: {result.reason}.
          {/* 2026-07-09 live-wiring round: live either runs the real dry-run
              (post-Sync) or gates with the honest Sync-first reason above --
              the old "later phase" copy is gone, and the sim scenario advice
              never renders as live advice. */}
          {appMode !== 'live' && ' Switch to a pool-phase scenario to see a proposal.'}
        </p>
      </div>
    );
  }
  if (result.mode !== 'pool') {
    // Unreachable by construction (we only ever request 'pool' here).
    return null;
  }
  return (
    <PoolModeLoaded
      ctx={hydratePoolContext(result.context)}
      abAlloc={abAlloc}
      setAbAlloc={setAbAlloc}
      liftedCaps={liftedCaps}
      setLiftedCaps={setLiftedCaps}
    />
  );
}

function PoolModeLoaded({
  ctx,
  abAlloc,
  setAbAlloc,
  liftedCaps,
  setLiftedCaps,
}: {
  ctx: PoolRebalanceContext;
  abAlloc: Record<string, string>;
  setAbAlloc: Dispatch<SetStateAction<Record<string, string>>>;
  liftedCaps: Record<string, boolean>;
  setLiftedCaps: Dispatch<SetStateAction<Record<string, boolean>>>;
}) {
  // The whole dry-run, resolved once per context (the baseline "suggested" plan).
  const plan: PoolRebalancePlan = useMemo(() => runPoolRebalancer(ctx), [ctx]);

  // This mode's slice of the shared abAlloc map (keyed `pool:${userLogin}`),
  // unprefixed for GrantsTable's own userLogin-keyed lookup.
  const grantValues = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(abAlloc)
          .filter(([k]) => k.startsWith('pool:'))
          .map(([k, v]) => [k.slice('pool:'.length), v]),
      ),
    [abAlloc],
  );

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

  // Honest empty-levers state (2026-07-09 live-wiring round; the maintainer's
  // tenant has zero ULBs and caps disabled): the pool rebalancer's entire
  // toolkit is ULB headroom (CLAUDE.md §5 -- "ULBs are the entire pool-phase
  // redistribution toolkit"), so with no ULBs the dry-run legitimately finds
  // nothing at risk and nothing grantable. Say so, usefully, instead of
  // rendering an unexplained all-zero proposal. Data-driven (renders in any
  // ULB-less world, either mode); reuses the unavailable-card idiom.
  const hasUlbs = ctx.controls.some((c) => c.kind === 'budget' && isUlbScope(c.scope));

  return (
    <>
      <TriggerCard trigger={plan.trigger} consumedFraction={consumedFraction} asOfDate={ctx.asOfDate} />

      {!hasUlbs && (
        <div className="ab-card ab-unavailable" data-testid="ab-no-ulbs">
          <div className="ab-eyebrow">No user-level budgets</div>
          <p>
            No user-level budgets exist yet — the pool rebalancer redistributes ULB headroom between users, so it has
            no levers to move. Create ULBs on the Controls screen (User-level budgets) to enable pool rebalancing.
          </p>
        </div>
      )}

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
            <EnvelopeBar
              total={derived.envelope.remainingPoolCredits}
              reserve={derived.envelope.segments.reserve}
              held={derived.envelope.segments.held}
              grants={derived.envelope.segments.grants}
              slack={derived.envelope.segments.slack}
              formatValue={fmt}
              totalLabel="Remaining pool"
              captionLeft={`remaining shared pool · unconsumed ${fmt(derived.envelope.remainingPoolCredits)}`}
              captionRight="0 → tip into metered"
            />
          </div>

          {fired ? (
            <GrantsTable
              grants={derived.grants}
              capRelax={plan.allocation.capRelax}
              grantValues={grantValues}
              liftedCaps={liftedCaps}
              onEditGrant={(login, raw) =>
                setAbAlloc((v) => ({ ...v, [`pool:${login}`]: raw.replace(/[^0-9]/g, '') }))
              }
              onToggleCap={(key) => setLiftedCaps((c) => ({ ...c, [key]: !c[key] }))}
              onReset={() => {
                setAbAlloc((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('pool:'))));
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

// ---------------------------------------------------------------------------
// Metered mode -- ①→④ from real engine outputs (Task 6.9).
// ---------------------------------------------------------------------------

interface MeteredModeProps {
  result: RebalanceContextResult | null;
  appMode: 'simulation' | 'live' | null;
  abAlloc: Record<string, string>;
  setAbAlloc: Dispatch<SetStateAction<Record<string, string>>>;
}

function MeteredMode({ result, appMode, abAlloc, setAbAlloc }: MeteredModeProps) {
  if (result === null) {
    return <AbContextSkeleton />;
  }
  if (!result.available) {
    return (
      <div className="ab-card ab-unavailable" data-testid="ab-unavailable">
        <div className="ab-eyebrow">Metered redistributor</div>
        <p>
          The metered dry-run isn't available here: {result.reason}.
          {/* Sim-only advice: the scenario selector doesn't exist in live, so
              the old copy was a dead end there (2026-07-09 live-wiring round;
              live metered now always assembles a real context, so this
              unavailable card is sim-only in practice). */}
          {appMode !== 'live' &&
            ' This scenario has no metered-phase story to redistribute — switch to a metered scenario (or the Pool rebalancer mode) to see a proposal.'}
        </p>
      </div>
    );
  }
  if (result.mode !== 'metered') {
    // Unreachable by construction (we only ever request 'metered' here).
    return null;
  }
  return <MeteredModeLoaded ctx={hydrateMeteredContext(result.context)} abAlloc={abAlloc} setAbAlloc={setAbAlloc} />;
}

function MeteredModeLoaded({
  ctx,
  abAlloc,
  setAbAlloc,
}: {
  ctx: MeteredRebalanceInput;
  abAlloc: Record<string, string>;
  setAbAlloc: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const plan: MeteredRebalancePlan = useMemo(() => evaluateMeteredRebalance(ctx), [ctx]);

  // This mode's slice of the shared abAlloc map (keyed `metered:${entityKey}`).
  const grantValues = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(abAlloc)
          .filter(([k]) => k.startsWith('metered:'))
          .map(([k, v]) => [k.slice('metered:'.length), v]),
      ),
    [abAlloc],
  );

  const edits: MeteredEdits = useMemo(
    () => ({ grantEdits: Object.fromEntries(Object.entries(grantValues).map(([key, raw]) => [key, parseDeltaUsd(raw)])) }),
    [grantValues],
  );

  const derived = useMemo(() => deriveMetered(plan, ctx, edits), [plan, ctx, edits]);
  const enterpriseTotalUsd = useMemo(() => enterpriseBudgetTotalUsd(ctx), [ctx]);

  const fired = plan.trigger.fired;

  return (
    <>
      <MeteredTriggerCard trigger={plan.trigger} enterpriseTotalUsd={enterpriseTotalUsd} baseRemainingUsd={plan.envelope.baseRemainingUsd} />

      <div className="ab-columns">
        <div className="ab-columns__main">
          <div className="ab-card ab-envcard">
            <div className="ab-envcard__head">
              <div className="ab-eyebrow">② Funding envelope</div>
              <div className="ab-envcard__headline mono" data-testid="ab-env-allocatable">
                {fmtUsd(derived.envelope.allocatableUsd)} allocatable
              </div>
            </div>
            <div className="ab-envcard__formula">
              <span className="mono">remaining enterprise budget − reserve − Σ projected metered(on-track)</span> — reserve{' '}
              {fmtUsd(derived.envelope.reserveUsd)} carved out explicitly.
            </div>
            <EnvelopeBar
              total={derived.envelope.baseRemainingUsd}
              reserve={derived.envelope.reserveUsd}
              held={derived.envelope.heldUsd}
              grants={derived.envelope.grantedUsd}
              slack={derived.envelope.slackUsd}
              formatValue={fmtUsd}
              totalLabel="Remaining enterprise budget"
              captionLeft={`remaining enterprise budget · unused ${fmtUsd(derived.envelope.baseRemainingUsd)}`}
              captionRight="0 → over enterprise budget"
            />
          </div>

          {fired ? (
            <MeteredGrantsTable
              grants={derived.grants}
              flagged={plan.flaggedEnterpriseRaises}
              grantValues={grantValues}
              onEditGrant={(key, raw) =>
                setAbAlloc((v) => ({ ...v, [`metered:${key}`]: raw.replace(/[^0-9]/g, '') }))
              }
              onReset={() => setAbAlloc((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('metered:'))))}
              fundedCount={derived.fundedCount}
              allocatedUsd={derived.envelope.grantedUsd}
              unallocatedUsd={derived.envelope.slackUsd}
              overAllocated={derived.overAllocated}
            />
          ) : (
            <div className="ab-card ab-empty" data-testid="ab-empty">
              <div className="ab-eyebrow">③ At-risk entities · proposed grants</div>
              <p className="ab-empty__body">
                Trigger conditions not met — no redistribution proposed. This table populates with proposed budget
                raises when the metered rebalancer fires (all three trigger conditions above hold).
              </p>
            </div>
          )}
        </div>

        <MeteredSimulateRail sim={derived.sim} overAllocated={derived.overAllocated} allocatableUsd={derived.envelope.allocatableUsd} />
      </div>
    </>
  );
}
