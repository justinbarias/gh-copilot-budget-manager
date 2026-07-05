import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { diffControls, type BudgetControl, type ControlState, type EffectiveUlb } from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult, HeavyUser } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { parseCredits } from '../../lib/creditsInput';
import { PlanRail } from '../Controls/PlanRail';
import './UlbPlanModal.css';

// Local, deliberately-duplicated formatCredits/formatUlb -- same convention
// already established across this codebase (Meter.tsx, PlanRail.tsx,
// CostCentersTable.tsx, and UsersTable.tsx each carry their own copy of
// formatCredits rather than sharing one) -- not imported from UsersTable.tsx,
// which would create a UsersTable -> SetUlbModal/BulkUlbModal ->
// UlbPlanModal -> UsersTable import cycle (UsersTable renders the modals).
function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

const ULB_SCOPE_LABEL: Record<EffectiveUlb['scope'], string> = {
  individual: 'individual',
  'cost-center': 'cost center',
  universal: 'universal',
};

function formatUlb(effectiveUlb: EffectiveUlb | null): string {
  if (effectiveUlb === null) return 'No ULB set';
  if (effectiveUlb.amountCredits <= 0) return '✕ $0 · blocked';
  return `${formatCredits(effectiveUlb.amountCredits)} · ${ULB_SCOPE_LABEL[effectiveUlb.scope]}`;
}

// Task 4.11's "a modal is just a scoped plan": SetUlbModal (1 user) and
// BulkUlbModal (N users) are both thin wrappers around this one component,
// which reuses PlanRail UNCHANGED for the diff/dry-run/validation/apply UI --
// exactly the same stage -> diff -> simulate -> validate -> apply -> audit
// pipeline the Controls screen drives (Task 4.9/4.10), scoped down to just
// the selected user(s)' individual ULB. That reuse is what makes "dry-run
// text reflects real simulation output" and "all four ApplyPlanResult arms +
// §6.8 visibly-simulated treatment" true for free -- PlanRail already
// implements all of it.
//
// No design-brief markup covers wiring a REAL dryRunPlan/applyPlan into the
// individual/bulk ULB modals -- the prototype's own ulbSimText/bulkSimText are
// a hardcoded client-side heuristic (`nv < cur ? 'blocked now' : ...`), not a
// real simulation call. This build intentionally does NOT replicate that
// heuristic (CLAUDE.md build brief: don't guess/fake domain math); it wires
// the same rail Task 4.9 built, which is a stronger, honest reuse of the
// design's OWN pattern ("Staged edits -> dry-run -> apply is the universal
// write pattern", design/README.md "Interactions & behavior").

const ACTOR = 'you (FinOps)';

// Neither the Set nor the Bulk ULB modal exposes alerting fields (design's
// own dc.html markup: just value, dry-run text, justification) -- a brand
// new individual override this modal creates always starts alerts-off; an
// edit of an EXISTING individual control preserves whatever alerting it
// already carries (only amountCredits is overridden below).
const DEFAULT_ALERTING = { willAlert: false, alertRecipients: [] as string[] };

function isIndividualBudget(control: ControlState): control is BudgetControl & { scope: 'individual' } {
  return control.kind === 'budget' && control.scope === 'individual';
}

function findIndividualControl(live: readonly ControlState[], login: string): (BudgetControl & { scope: 'individual' }) | null {
  return live.filter(isIndividualBudget).find((c) => c.entityName === login) ?? null;
}

// The modal's own default starting amount (before the admin types anything):
// an existing individual override's own amount, else the user's currently
// EFFECTIVE ULB amount (whatever scope resolves for them today) -- a
// concrete, fixture-honest starting point rather than an invented constant.
// Bulk (N heterogeneous users) has no single honest default, so it starts
// blank instead (see buildDesiredControls' hasValidAmount gate below).
function defaultAmountFor(user: HeavyUser, live: readonly ControlState[]): string {
  const existing = findIndividualControl(live, user.userLogin);
  if (existing) return String(existing.amountCredits);
  return user.effectiveUlb ? String(user.effectiveUlb.amountCredits) : '';
}

function buildDesiredControls(live: readonly ControlState[], users: readonly HeavyUser[], amountCredits: number): ControlState[] {
  const targets = new Set(users.map((u) => u.userLogin));
  const overriddenLogins = new Set<string>();
  const overridden = live.map((control) => {
    if (!isIndividualBudget(control) || !targets.has(control.entityName)) return control;
    overriddenLogins.add(control.entityName);
    return { ...control, amountCredits };
  });
  const created: BudgetControl[] = users
    .filter((u) => !overriddenLogins.has(u.userLogin))
    .map((u) => ({
      kind: 'budget',
      scope: 'individual',
      entityName: u.userLogin,
      amountCredits,
      preventFurtherUsage: true, // ULBs always hard-stop (CLAUDE.md §5) -- never a choice in this modal.
      alerting: DEFAULT_ALERTING,
    }));
  return [...overridden, ...created];
}

export interface UlbPlanModalProps {
  /** 1 user for the individual modal, N for the bulk modal -- the only difference in the plan this derives. */
  users: readonly HeavyUser[];
  /** Visual header (may embed a mono login span); ariaLabel is the plain-text equivalent for the dialog's accessible name. */
  title: ReactNode;
  ariaLabel: string;
  amountLabel: string;
  onClose: () => void;
  /** Called once, right after a successful apply (parent may refresh the roster / clear a bulk selection). */
  onApplied: (message: string) => void;
}

export function UlbPlanModal({ users, title, ariaLabel, amountLabel, onClose, onApplied }: UlbPlanModalProps) {
  const api = useApiClient();
  const isBulk = users.length > 1;

  const [live, setLive] = useState<ControlState[] | null>(null);
  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);
  const [amountRaw, setAmountRaw] = useState('');
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [dryRunPlanKey, setDryRunPlanKey] = useState<string | null>(null);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyPlanResult | null>(null);
  const [justification, setJustification] = useState('');
  // ULBs never turn a hard stop off in this modal (preventFurtherUsage is
  // always true, created or edited) -- §6.3's override is structurally
  // unreachable here, so this stays permanently false/unused; PlanRail still
  // needs the prop wired.
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);

  const loadLive = useCallback(async () => {
    const [controls, runtimeMode] = await Promise.all([api.getControls(), api.getMode()]);
    setLive(controls);
    setMode(runtimeMode);
    return controls;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    loadLive().then((controls) => {
      if (cancelled) return;
      // Single-user modal only: prefill from the live starting point. Bulk
      // stays blank (see defaultAmountFor's doc comment).
      if (!isBulk && users[0]) setAmountRaw(defaultAmountFor(users[0], controls));
    });
    return () => {
      cancelled = true;
    };
    // `users` is deliberately NOT a dependency: this is a mount-time load (the
    // modal is given a fixed row/selection snapshot for its lifetime), and
    // `loadLive`'s own identity only changes if `api` does (stable, from the
    // window.api bridge) -- adding `users` here would re-run on every parent
    // re-render that passes a fresh array literal (e.g. BulkUlbModal's
    // `users` prop), clobbering whatever the admin has already typed.
  }, [loadLive]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const hasValidAmount = amountRaw.trim() !== '';

  const desiredControls = useMemo<ControlState[]>(() => {
    if (live === null) return [];
    if (!hasValidAmount) return live;
    return buildDesiredControls(live, users, parseCredits(amountRaw));
  }, [live, hasValidAmount, amountRaw, users]);

  const plan = useMemo(() => diffControls(live ?? [], desiredControls), [live, desiredControls]);
  const planKey = useMemo(() => JSON.stringify(plan.entries), [plan]);
  const dryRunStale = dryRun !== null && dryRunPlanKey !== planKey;

  const onRunDryRun = useCallback(async () => {
    setRunningDryRun(true);
    setApplyResult(null);
    try {
      const result = await api.dryRunPlan(desiredControls, justification.trim() === '' ? null : justification);
      setDryRun(result);
      setDryRunPlanKey(planKey);
    } finally {
      setRunningDryRun(false);
    }
  }, [api, desiredControls, justification, planKey]);

  const resetAfterApply = useCallback(async () => {
    const fresh = await loadLive();
    if (!isBulk && users[0]) setAmountRaw(defaultAmountFor(users[0], fresh));
    else setAmountRaw('');
    setDryRun(null);
    setDryRunPlanKey(null);
    setJustification('');
    setOverrideAcknowledged(false);
  }, [loadLive, isBulk, users]);

  const onApply = useCallback(async () => {
    if (dryRun === null) return;
    setApplying(true);
    try {
      const result = await api.applyPlan(dryRun.plan, desiredControls, { actor: ACTOR, justification });
      setApplyResult(result);
      if (result.status === 'applied') {
        await resetAfterApply();
        const who = isBulk ? `${users.length} users` : (users[0]?.userLogin ?? 'user');
        onApplied(
          mode === 'simulation'
            ? `◆ Simulated apply — ULB updated for ${who}. No real GitHub budget was changed.`
            : `ULB updated for ${who} and written to the audit trail.`,
        );
      } else if (result.status === 'drift' || result.status === 'partial_failure') {
        setDryRun(null);
        setDryRunPlanKey(null);
      }
      // 'blocked': keep everything staged; PlanRail renders the blockers.
    } finally {
      setApplying(false);
    }
  }, [api, desiredControls, dryRun, justification, mode, resetAfterApply, isBulk, users, onApplied]);

  const onReconcileDrift = useCallback(async () => {
    await loadLive();
    setDryRun(null);
    setDryRunPlanKey(null);
    setApplyResult(null);
  }, [loadLive]);

  const onDiscard = useCallback(() => {
    if (!isBulk && live && users[0]) setAmountRaw(defaultAmountFor(users[0], live));
    else setAmountRaw('');
    setDryRun(null);
    setDryRunPlanKey(null);
    setJustification('');
    setOverrideAcknowledged(false);
    setApplyResult(null);
  }, [isBulk, live, users]);

  const loading = live === null || mode === null;

  return (
    <div className="ulb-plan-modal__backdrop" onClick={onClose}>
      <div
        className="ulb-plan-modal"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ulb-plan-modal__header">
          <div className="ulb-plan-modal__title">{title}</div>
          <button type="button" className="ulb-plan-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="ulb-plan-modal__body">
          {loading ? (
            <p className="ulb-plan-modal__loading">Loading…</p>
          ) : (
            <>
              <div className="ulb-plan-modal__current">
                {isBulk
                  ? users.map((u) => (
                      <div key={u.userLogin} className="ulb-plan-modal__current-row">
                        <span className="mono">{u.userLogin}</span>
                        <span>{formatUlb(u.effectiveUlb)}</span>
                      </div>
                    ))
                  : users[0] && (
                      <div className="ulb-plan-modal__current-row">
                        <span>Current effective ULB</span>
                        <span>{formatUlb(users[0].effectiveUlb)}</span>
                      </div>
                    )}
              </div>

              <label className="ulb-plan-modal__label" htmlFor="ulb-plan-amount">
                {amountLabel}
              </label>
              <input
                id="ulb-plan-amount"
                className="ulb-plan-modal__input mono"
                aria-label={amountLabel}
                inputMode="numeric"
                placeholder="e.g. 3000"
                value={amountRaw}
                onChange={(event) => setAmountRaw(event.target.value.replace(/[^0-9]/g, ''))}
              />

              <div className="ulb-plan-modal__rail">
                <PlanRail
                  plan={plan}
                  dryRun={dryRun}
                  dryRunStale={dryRunStale}
                  runningDryRun={runningDryRun}
                  applying={applying}
                  applyResult={applyResult}
                  justification={justification}
                  onJustificationChange={setJustification}
                  requiresHardStopOverride={false}
                  overrideAcknowledged={overrideAcknowledged}
                  onOverrideAcknowledgedChange={setOverrideAcknowledged}
                  simulated={mode === 'simulation'}
                  onRunDryRun={() => void onRunDryRun()}
                  onApply={() => void onApply()}
                  onDiscard={onDiscard}
                  onReconcileDrift={() => void onReconcileDrift()}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
