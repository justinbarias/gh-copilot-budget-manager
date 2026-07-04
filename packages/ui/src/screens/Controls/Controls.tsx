import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  diffControls,
  type AlertingState,
  type BudgetControl,
  type ControlState,
  type SpendingLimitScope,
} from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { ComingSoon } from '../_stubs/ComingSoon';
import { ControlsTable, type SpendingLimitRowModel } from './ControlsTable';
import { PlanRail } from './PlanRail';
import './Controls.css';

// Controls screen (Task 4.9): family tabs + explainer, the Spending-limits
// family end to end, and the reusable plan/simulate/apply right rail. The
// ULB family (Task 4.10) and Included-usage caps (Task 4.12) tabs are
// consistent within-screen placeholders until their slices land.
//
// Staging model (design/README.md "State management"): `desired` is an edit
// overlay keyed by control identity; the full desired ControlState list is
// derived by overlaying it onto `live`, the Plan is derived via core's
// diffControls, and any change to the plan invalidates the last dry-run
// (stale dry-run => Apply disabled until re-run). Nothing writes until the
// rail's Apply (CLAUDE.md §6.1).

type FamilyId = 'userlevel' | 'spending' | 'included';

const FAMILY_TABS: ReadonlyArray<{ id: FamilyId; label: string }> = [
  { id: 'userlevel', label: 'User-level budgets' },
  { id: 'spending', label: 'Spending limits' },
  { id: 'included', label: 'Included-usage caps' },
];

// Family explainers -- copy verbatim from the design prototype (dc.html's
// controlFamilyNote map).
const FAMILY_NOTES: Record<FamilyId, string> = {
  userlevel:
    "Cap each person's total consumption across both phases. Always a hard stop — a $0 ULB blocks immediately. Most-specific wins: Individual → Cost-center (CCULB) → Universal.",
  spending:
    'Cap metered charges only, and only after the shared pool is exhausted. Hard-stop is OFF by default — turn it on or charges accrue past the cap.',
  included:
    "Carve the shared pool per cost center before it tips into metered, so one team can't drain credits another team's licenses funded. The limit is auto-computed from attributed licenses; choose block or overflow.",
};

const FAMILY_LABELS: Record<FamilyId, string> = {
  userlevel: 'User-level budgets',
  spending: 'Spending limits',
  included: 'Included-usage caps',
};

// No admin login/identity system exists yet (CLAUDE.md §9 open question) --
// same placeholder actor string the design prototype's audit events use.
const ACTOR = 'you (FinOps)';

// Design "Interactions & behavior": success toast ~3.8s.
const TOAST_MS = 3800;

interface StagedBudgetEdit {
  amountRaw?: string;
  preventFurtherUsage?: boolean;
  willAlert?: boolean;
  recipientsRaw?: string;
}

interface MeterData {
  enterpriseUsedCredits: number;
  usedCreditsByCostCenterName: Record<string, number>;
}

function parseCredits(raw: string): number {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number.parseInt(digits, 10);
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function applyEdit(control: BudgetControl, edit: StagedBudgetEdit): BudgetControl {
  const alerting: AlertingState =
    edit.willAlert !== undefined || edit.recipientsRaw !== undefined
      ? {
          willAlert: edit.willAlert ?? control.alerting.willAlert,
          alertRecipients:
            edit.recipientsRaw !== undefined ? parseRecipients(edit.recipientsRaw) : [...control.alerting.alertRecipients],
        }
      : control.alerting;

  return {
    ...control,
    amountCredits: edit.amountRaw !== undefined ? parseCredits(edit.amountRaw) : control.amountCredits,
    preventFurtherUsage: edit.preventFurtherUsage ?? control.preventFurtherUsage,
    alerting,
  };
}

// Same identity key as core's controlIdentity, inlined for budget controls
// (the only kind this slice stages).
function budgetIdentity(control: BudgetControl): string {
  return `budget:${control.scope}:${control.entityName}`;
}

const SPENDING_SCOPE_ORDER: Record<SpendingLimitScope, number> = { enterprise: 0, organization: 1, cost_center: 2 };

function isSpendingBudget(control: ControlState): control is BudgetControl & { scope: SpendingLimitScope } {
  return control.kind === 'budget' && (control.scope === 'enterprise' || control.scope === 'organization' || control.scope === 'cost_center');
}

function rowTitle(control: BudgetControl): string {
  if (control.scope === 'enterprise') return 'Enterprise metered budget';
  if (control.scope === 'organization') return `org: ${control.entityName}`;
  return `CC: ${control.entityName}`;
}

// "What it caps" copy verbatim from the design prototype's spending rows.
function rowCapsCopy(control: BudgetControl): string {
  if (control.scope === 'enterprise') return 'Total enterprise metered charges';
  if (control.scope === 'organization') return "This org's metered charges";
  return "A team's metered charges";
}

export interface ControlsProps {
  onNavigateToAutoBalance: () => void;
}

export function Controls({ onNavigateToAutoBalance }: ControlsProps) {
  const api = useApiClient();

  // Null-initial loading (screen pattern shared with CostCenters/Users):
  // null = not loaded; the screen renders only once live controls, meter
  // data, and the runtime mode have all resolved, so meters never flash a
  // wrong "no data" cue while loading.
  const [live, setLive] = useState<ControlState[] | null>(null);
  const [meters, setMeters] = useState<MeterData | null>(null);
  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);

  const [family, setFamily] = useState<FamilyId>('spending');
  const [desired, setDesired] = useState<Record<string, StagedBudgetEdit>>({});
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [dryRunPlanKey, setDryRunPlanKey] = useState<string | null>(null);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyPlanResult | null>(null);
  const [justification, setJustification] = useState('');
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [controls, runtimeMode, summary, costCenters] = await Promise.all([
        api.getControls(),
        api.getMode(),
        api.getUsageSummary(),
        api.listCostCenters(),
      ]);
      // Per-scope metered utilization is derived from real usage data only
      // (never faked): the enterprise row from the all-up usage summary's net
      // (metered) USD, cost-center rows from the per-cost-center filtered
      // summary. Org rows have no per-org attribution anywhere in the data
      // layer -- their meter renders honestly empty (see ControlsTable).
      const perCostCenter = await Promise.all(
        costCenters.map(async (cc) => ({ name: cc.name, summary: await api.getUsageSummary({ costCenterId: cc.id }) })),
      );
      if (cancelled) return;
      const usedCreditsByCostCenterName: Record<string, number> = {};
      for (const { name, summary: ccSummary } of perCostCenter) {
        usedCreditsByCostCenterName[name] = Math.round(ccSummary.totalNetAmountUsd * 100);
      }
      setLive(controls);
      setMode(runtimeMode);
      setMeters({
        enterpriseUsedCredits: Math.round(summary.totalNetAmountUsd * 100),
        usedCreditsByCostCenterName,
      });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  // Desired end-state: live with the staged overlay applied. Includes every
  // control (ULBs + caps pass through untouched), so diffControls never
  // fabricates deletes for controls this slice doesn't edit.
  const desiredControls = useMemo<ControlState[]>(() => {
    if (live === null) return [];
    return live.map((control) => {
      if (control.kind !== 'budget') return control;
      const edit = desired[budgetIdentity(control)];
      return edit ? applyEdit(control, edit) : control;
    });
  }, [live, desired]);

  const plan = useMemo(() => diffControls(live ?? [], desiredControls), [live, desiredControls]);
  const planKey = useMemo(() => JSON.stringify(plan.entries), [plan]);
  const dryRunStale = dryRun !== null && dryRunPlanKey !== planKey;

  // §6.3: does this plan turn a previously-on hard stop off?
  const requiresHardStopOverride = useMemo(
    () =>
      plan.entries.some(
        (entry) =>
          entry.controlKind === 'budget' &&
          entry.action === 'change' &&
          entry.changes.some((change) => change.field === 'preventFurtherUsage' && change.old === true && change.new === false),
      ),
    [plan],
  );

  const stageEdit = useCallback((id: string, patch: StagedBudgetEdit) => {
    setDesired((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }, []);

  const onAmountChange = useCallback((id: string, raw: string) => stageEdit(id, { amountRaw: raw }), [stageEdit]);
  const onWillAlertChange = useCallback((id: string, next: boolean) => stageEdit(id, { willAlert: next }), [stageEdit]);
  const onRecipientsChange = useCallback((id: string, raw: string) => stageEdit(id, { recipientsRaw: raw }), [stageEdit]);

  const onHardStopToggle = useCallback(
    (id: string) => {
      if (live === null) return;
      const control = live.find((c) => c.kind === 'budget' && budgetIdentity(c) === id);
      if (!control || control.kind !== 'budget') return;
      setDesired((current) => {
        const effective = current[id]?.preventFurtherUsage ?? control.preventFurtherUsage;
        return { ...current, [id]: { ...current[id], preventFurtherUsage: !effective } };
      });
      // Re-demand the explicit §6.3 acknowledgment whenever enforcement is
      // re-staged -- an earlier tick must not silently carry over.
      setOverrideAcknowledged(false);
    },
    [live],
  );

  const onDiscard = useCallback(() => {
    setDesired({});
    setDryRun(null);
    setDryRunPlanKey(null);
    setJustification('');
    setOverrideAcknowledged(false);
    setApplyResult(null);
  }, []);

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

  const refreshLive = useCallback(async () => {
    const fresh = await api.getControls();
    setLive(fresh);
  }, [api]);

  const onApply = useCallback(async () => {
    if (dryRun === null) return;
    setApplying(true);
    try {
      // stagedPlan = the server-computed plan the admin previewed (§6.1);
      // the engine re-reads live and re-diffs, aborting as drift if they
      // no longer match (§6.2).
      const result = await api.applyPlan(dryRun.plan, desiredControls, { actor: ACTOR, justification });
      setApplyResult(result);

      if (result.status === 'applied') {
        setDesired({});
        setDryRun(null);
        setDryRunPlanKey(null);
        setJustification('');
        setOverrideAcknowledged(false);
        showToast(
          mode === 'simulation'
            ? `◆ Simulated apply — ${result.appliedCount} change${result.appliedCount === 1 ? '' : 's'} recorded to the audit log. No real GitHub budget or cap was changed.`
            : `${result.appliedCount} change${result.appliedCount === 1 ? '' : 's'} applied and written to the audit trail.`,
        );
        await refreshLive();
      } else if (result.status === 'drift' || result.status === 'partial_failure') {
        // Both mean live moved (or partially moved) under us: the staged
        // edits are kept, but the last dry-run no longer previews reality.
        setDryRun(null);
        setDryRunPlanKey(null);
      }
      // 'blocked': keep everything staged; the panel renders the blockers.
    } finally {
      setApplying(false);
    }
  }, [api, desiredControls, dryRun, justification, mode, refreshLive, showToast]);

  const onReconcileDrift = useCallback(async () => {
    await refreshLive();
    setDryRun(null);
    setDryRunPlanKey(null);
    setApplyResult(null);
  }, [refreshLive]);

  if (live === null || meters === null || mode === null) {
    return (
      <section className="controls" aria-label="Controls">
        <p className="controls__loading">Loading…</p>
      </section>
    );
  }

  // Diff-driven staging markers: a row is "staged" exactly when the derived
  // plan carries an entry for it (matches the rail 1:1 -- typing a value and
  // reverting it back to the live value never leaves a phantom marker).
  const stagedIds = new Set(plan.entries.map((entry) => entry.id));

  const rows: SpendingLimitRowModel[] = live
    .filter(isSpendingBudget)
    .sort((a, b) => SPENDING_SCOPE_ORDER[a.scope] - SPENDING_SCOPE_ORDER[b.scope] || a.entityName.localeCompare(b.entityName))
    .map((control) => {
      const id = budgetIdentity(control);
      const edit = desired[id] ?? {};
      const effective = applyEdit(control, edit);
      const staged = stagedIds.has(id);

      const utilization =
        control.scope === 'enterprise'
          ? { usedCredits: meters.enterpriseUsedCredits, capCredits: effective.amountCredits }
          : control.scope === 'cost_center' && meters.usedCreditsByCostCenterName[control.entityName] !== undefined
            ? { usedCredits: meters.usedCreditsByCostCenterName[control.entityName]!, capCredits: effective.amountCredits }
            : null;

      return {
        id,
        title: rowTitle(control),
        capsCopy: rowCapsCopy(control),
        amountRaw: edit.amountRaw ?? String(control.amountCredits),
        hardStop: effective.preventFurtherUsage,
        willAlert: effective.alerting.willAlert,
        recipientsRaw: edit.recipientsRaw ?? control.alerting.alertRecipients.join(', '),
        staged,
        utilization,
      };
    });

  return (
    <section className="controls" aria-label="Controls">
      <div className="controls__toolbar">
        <div className="controls__tabs" role="tablist" aria-label="Control families">
          {FAMILY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={family === tab.id}
              className={`controls__tab ${family === tab.id ? 'controls__tab--active' : ''}`}
              onClick={() => setFamily(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="controls__toolbar-right">
          <span className="controls__stage-hint">API-first · edits stage, nothing writes until you apply</span>
          <button type="button" className="controls__ab-link" onClick={onNavigateToAutoBalance}>
            ⇄ Auto-balance headroom
          </button>
        </div>
      </div>

      <div className="controls__explainer">
        <span className="controls__explainer-glyph" aria-hidden="true">
          ⓘ
        </span>
        <p className="controls__explainer-text">
          <strong>{FAMILY_LABELS[family]}.</strong> {FAMILY_NOTES[family]}
        </p>
      </div>

      <div className="controls__body">
        <div className="controls__main">
          {family === 'spending' && (
            <ControlsTable
              rows={rows}
              onAmountChange={onAmountChange}
              onHardStopToggle={onHardStopToggle}
              onWillAlertChange={onWillAlertChange}
              onRecipientsChange={onRecipientsChange}
            />
          )}
          {family === 'userlevel' && (
            <ComingSoon
              screenName="User-level budgets"
              message="Coming soon — the ULB family (Universal · Individual · CCULB) arrives with Task 4.10."
            />
          )}
          {family === 'included' && (
            <ComingSoon
              screenName="Included-usage caps"
              message="Coming soon — per-cost-center included-usage cap cards arrive with Task 4.12."
            />
          )}
        </div>

        <PlanRail
          plan={plan}
          dryRun={dryRun}
          dryRunStale={dryRunStale}
          runningDryRun={runningDryRun}
          applying={applying}
          applyResult={applyResult}
          justification={justification}
          onJustificationChange={setJustification}
          requiresHardStopOverride={requiresHardStopOverride}
          overrideAcknowledged={overrideAcknowledged}
          onOverrideAcknowledgedChange={setOverrideAcknowledged}
          simulated={mode === 'simulation'}
          onRunDryRun={() => void onRunDryRun()}
          onApply={() => void onApply()}
          onDiscard={onDiscard}
          onReconcileDrift={() => void onReconcileDrift()}
        />
      </div>

      {toast && (
        <div className="controls-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}
