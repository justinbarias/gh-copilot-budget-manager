import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  controlIdentity,
  diffControls,
  isUlbScope,
  DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS,
  type AlertingState,
  type BudgetControl,
  type CapOverflow,
  type ControlState,
  type IncludedCapControl,
  type SpendingLimitScope,
  type UlbBudgetScope,
} from '@copilot-budget/core';
import type { ApplyPlanResult, CostCenterSummary, DryRunResult, HeavyUser } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { parseCredits, parseRecipients } from '../../lib/creditsInput';
import { ControlsTable, type RowUtilization, type SpendingLimitRowModel } from './ControlsTable';
import { IncludedCapsGrid, type IncludedCapRowModel } from './IncludedCapsGrid';
import { NewUlbModal } from './NewUlbModal';
import { PlanRail } from './PlanRail';
import { UlbTable, type UlbRowModel } from './UlbTable';
import './Controls.css';

// Controls screen (Task 4.9 spending limits, Task 4.10 user-level budgets,
// Task 4.12 included-usage caps): family tabs + explainer, all three families
// end to end, and the reusable plan/simulate/apply right rail.
//
// Staging model (design/README.md "State management"): `desired` is an edit
// overlay keyed by control identity; the full desired ControlState list is
// derived by overlaying it onto `live` (plus Task 4.10's stagedNewUlbs
// additions and stagedDeletes omissions), the Plan is derived via core's
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

// Included-usage cap edit overlay (Task 4.12): deliberately only `enabled`/
// `overflow` -- CapDiffField in core/controls.ts has no `computedLimitCredits`
// counterpart, so there is structurally no field name this overlay could ever
// carry to stage an amount edit (CLAUDE.md §5: the cap is never dial-able).
interface StagedCapEdit {
  enabled?: boolean;
  overflow?: CapOverflow;
}

interface MeterData {
  enterpriseUsedCredits: number;
  usedCreditsByCostCenterName: Record<string, number>;
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

// Task 4.12's included_cap edits use core's controlIdentity directly (rather
// than a second inlined helper like budgetIdentity above) -- included_cap's
// identity is a single-field key (`included_cap:${costCenterName}`) with no
// analogous "only this slice stages it" history to preserve.
function applyCapEdit(control: IncludedCapControl, edit: StagedCapEdit): IncludedCapControl {
  return {
    ...control,
    enabled: edit.enabled ?? control.enabled,
    overflow: edit.overflow ?? control.overflow,
  };
}

function isCapControl(control: ControlState): control is IncludedCapControl {
  return control.kind === 'included_cap';
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

// --- User-level budgets (Task 4.10) ---------------------------------------

// Design's own seed-data order (design/*.dc.html: universal row, then CCULB
// rows, then individual-override rows) -- matched here rather than inventing
// a different sort (e.g. precedence order), since CLAUDE.md says implement
// against the design, don't invent visual language.
const ULB_SCOPE_ORDER: Record<UlbBudgetScope, number> = { universal: 0, multi_user_cost_center: 1, individual: 2 };

function isUlbBudget(control: ControlState): control is BudgetControl & { scope: UlbBudgetScope } {
  return control.kind === 'budget' && isUlbScope(control.scope);
}

// Row titles/caps copy verbatim from the design prototype's userlevel seed
// rows ("Universal ULB" / "CCULB · <name>" / "Individual · <login>", and
// their exact `caps` strings).
function ulbRowTitle(control: BudgetControl): string {
  if (control.scope === 'universal') return 'Universal ULB';
  if (control.scope === 'multi_user_cost_center') return `CCULB · ${control.entityName}`;
  return `Individual · ${control.entityName}`;
}

function ulbRowCapsCopy(control: BudgetControl): string {
  if (control.scope === 'universal') return "Every licensed user's total · both phases";
  if (control.scope === 'multi_user_cost_center') return 'Per-user cap · every CC member';
  return "One named user's total";
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
  // Task 4.10: the ULB family's entity pickers (NewUlbModal) and utilization
  // meters need the same listHeavyUsers()/listCostCenters() data the Users/
  // CostCenters screens already fetch -- stored here rather than re-derived,
  // since Controls.tsx already fetches listCostCenters() for the spending
  // table's per-CC meters (previously a local, unstored `const`).
  const [heavyUsers, setHeavyUsers] = useState<HeavyUser[] | null>(null);
  const [costCentersList, setCostCentersList] = useState<CostCenterSummary[] | null>(null);

  // Design's ULB-first tab order (design/*.dc.html's FAMILY_TABS order) --
  // 'spending' was a Task 4.9 stopgap default until this slice existed.
  const [family, setFamily] = useState<FamilyId>('userlevel');
  const [desired, setDesired] = useState<Record<string, StagedBudgetEdit>>({});
  // Task 4.12's included_cap edit overlay -- keyed by controlIdentity, the
  // same "desired overlays live" pattern `desired` already uses for budgets.
  const [desiredCaps, setDesiredCaps] = useState<Record<string, StagedCapEdit>>({});
  // Task 4.10's CREATE/DELETE staging, additive to the `desired` edit overlay
  // above: stagedNewUlbs are appended to desiredControls (diffControls then
  // sees them as 'add' entries against a live state that doesn't have them);
  // stagedDeletes names identities to OMIT from desiredControls (diffControls
  // then sees them as 'delete' entries). Neither forks diffControls/PlanRail
  // -- both are just different ways of shaping desiredControls before it's
  // diffed, the same pattern `desired` already uses for edits.
  const [stagedNewUlbs, setStagedNewUlbs] = useState<BudgetControl[]>([]);
  const [stagedDeletes, setStagedDeletes] = useState<ReadonlySet<string>>(new Set());
  const [creatingUlb, setCreatingUlb] = useState(false);
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
      const [controls, runtimeMode, summary, costCenters, users] = await Promise.all([
        api.getControls(),
        api.getMode(),
        api.getUsageSummary(),
        api.listCostCenters(),
        api.listHeavyUsers(),
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
      setCostCentersList(costCenters);
      setHeavyUsers(users);
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

  // Desired end-state: live with the staged overlay applied, Task 4.10's
  // stagedDeletes omitted, and stagedNewUlbs appended. Every untouched
  // control (ULBs + caps this slice doesn't edit) passes straight through, so
  // diffControls never fabricates deletes/changes for controls nothing here
  // stages -- stagedDeletes is the ONLY thing that removes a control from the
  // desired list, and it does so explicitly. Task 4.12 adds the included_cap
  // branch alongside the budget one -- same "overlay keyed by identity" shape,
  // a different overlay map (desiredCaps) and apply function (applyCapEdit).
  const desiredControls = useMemo<ControlState[]>(() => {
    if (live === null) return [];
    const edited = live
      .filter((control) => !(control.kind === 'budget' && stagedDeletes.has(budgetIdentity(control))))
      .map((control) => {
        if (control.kind === 'budget') {
          const edit = desired[budgetIdentity(control)];
          return edit ? applyEdit(control, edit) : control;
        }
        const capEdit = desiredCaps[controlIdentity(control)];
        return capEdit ? applyCapEdit(control, capEdit) : control;
      });
    return [...edited, ...stagedNewUlbs];
  }, [live, desired, desiredCaps, stagedDeletes, stagedNewUlbs]);

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

  // Task 4.12: toggle the effective `enabled` (staged ?? live), same
  // read-effective-then-flip shape as onHardStopToggle above.
  const onCapToggle = useCallback(
    (id: string) => {
      if (live === null) return;
      const control = live.find((c) => c.kind === 'included_cap' && controlIdentity(c) === id);
      if (!control || control.kind !== 'included_cap') return;
      setDesiredCaps((current) => {
        const effective = current[id]?.enabled ?? control.enabled;
        return { ...current, [id]: { ...current[id], enabled: !effective } };
      });
    },
    [live],
  );

  const onCapOverflowChange = useCallback((id: string, overflow: CapOverflow) => {
    setDesiredCaps((current) => ({ ...current, [id]: { ...current[id], overflow } }));
  }, []);

  const onDiscard = useCallback(() => {
    setDesired({});
    setDesiredCaps({});
    setStagedNewUlbs([]);
    setStagedDeletes(new Set());
    setDryRun(null);
    setDryRunPlanKey(null);
    setJustification('');
    setOverrideAcknowledged(false);
    setApplyResult(null);
  }, []);

  // Task 4.10 CREATE/DELETE staging callbacks -- siblings of stageEdit/
  // onAmountChange etc. above, same "local-only, nothing writes until Apply"
  // contract.
  const onDeleteToggle = useCallback((id: string) => {
    setStagedDeletes((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onDiscardNewUlb = useCallback((id: string) => {
    setStagedNewUlbs((current) => current.filter((control) => budgetIdentity(control) !== id));
  }, []);

  const onCreateUlb = useCallback((control: BudgetControl) => {
    setStagedNewUlbs((current) => [...current, control]);
    setCreatingUlb(false);
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
        setDesiredCaps({});
        setStagedNewUlbs([]);
        setStagedDeletes(new Set());
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

  if (live === null || meters === null || mode === null || heavyUsers === null || costCentersList === null) {
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

  // Task 4.10: ULB family rows. Utilization is derived honestly from
  // listHeavyUsers() (the same precomputed, precedence-resolved
  // `effectiveUlb` the Users screen reads) -- never faked:
  //   - individual rows: that one user's own cycle-to-date credits.
  //   - universal/CCULB rows: the MAX-consuming member currently resolved to
  //     this exact scope+entity by ULB precedence -- an honest "who's
  //     closest to this shared ceiling" reading. A staged-new control isn't
  //     in effect yet (no live member is actually bound by it), so it
  //     renders an honest empty meter rather than guessing who'd move to it.
  function deriveUlbUtilization(scope: UlbBudgetScope, entityName: string, capCredits: number): RowUtilization | null {
    const heavyUsersList: HeavyUser[] = heavyUsers ?? [];
    if (scope === 'individual') {
      const user = heavyUsersList.find((u) => u.userLogin === entityName);
      return user ? { usedCredits: user.creditsUsed, capCredits } : null;
    }
    const matches = heavyUsersList.filter((u) =>
      scope === 'universal'
        ? u.effectiveUlb?.scope === 'universal'
        : u.effectiveUlb?.scope === 'cost-center' && u.costCenterName === entityName,
    );
    if (matches.length === 0) return null;
    const maxUser = matches.reduce((a, b) => (b.creditsUsed > a.creditsUsed ? b : a));
    return { usedCredits: maxUser.creditsUsed, capCredits };
  }

  const liveUlbControls = live.filter(isUlbBudget);

  const ulbRows: UlbRowModel[] = [
    ...liveUlbControls.map((control) => {
      const id = budgetIdentity(control);
      const markedForDelete = stagedDeletes.has(id);
      const edit = desired[id] ?? {};
      const effective = markedForDelete ? control : applyEdit(control, edit);
      return {
        id,
        scope: control.scope,
        entityName: control.entityName,
        title: ulbRowTitle(control),
        capsCopy: ulbRowCapsCopy(control),
        apiOnly: control.scope === 'multi_user_cost_center',
        amountRaw: markedForDelete ? String(control.amountCredits) : (edit.amountRaw ?? String(control.amountCredits)),
        hardStop: effective.preventFurtherUsage,
        willAlert: effective.alerting.willAlert,
        recipientsRaw: markedForDelete ? control.alerting.alertRecipients.join(', ') : (edit.recipientsRaw ?? control.alerting.alertRecipients.join(', ')),
        staged: stagedIds.has(id),
        isNew: false,
        markedForDelete,
        zeroWarning: effective.amountCredits <= DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS,
        utilization: deriveUlbUtilization(control.scope, control.entityName, effective.amountCredits),
      };
    }),
    ...stagedNewUlbs.map((control) => ({
      id: budgetIdentity(control),
      // Safe: stagedNewUlbs only ever receives controls NewUlbModal built,
      // and NewUlbModal's own `scope` state is typed UlbBudgetScope.
      scope: control.scope as UlbBudgetScope,
      entityName: control.entityName,
      title: ulbRowTitle(control),
      capsCopy: ulbRowCapsCopy(control),
      apiOnly: control.scope === 'multi_user_cost_center',
      amountRaw: String(control.amountCredits),
      hardStop: control.preventFurtherUsage,
      willAlert: control.alerting.willAlert,
      recipientsRaw: control.alerting.alertRecipients.join(', '),
      staged: true,
      isNew: true,
      markedForDelete: false,
      zeroWarning: control.amountCredits <= DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS,
      utilization: null,
    })),
  ].sort((a, b) => ULB_SCOPE_ORDER[a.scope] - ULB_SCOPE_ORDER[b.scope] || a.entityName.localeCompare(b.entityName));

  // Task 4.12: included-usage cap family rows. Natural order (the order
  // getControls() returns included_cap entries in, which mirrors the fixture
  // declaration order in msw/fixtures/costCenters.ts) -- no re-sort, since
  // unlike the ULB table this is a single homogeneous list with no
  // scope-then-name grouping to reproduce.
  //
  // memberCount/mtdBurnCredits aren't on ControlState (core's IncludedCapControl
  // only carries enabled/overflow/computedLimitCredits, CLAUDE.md §5's "never
  // dial-able" surface) -- joined here from costCentersList, the SAME
  // listCostCenters() fetch Controls.tsx already loads for the spending
  // table's per-CC meters, by cost-center name (no new IPC call). "Drawn"
  // deliberately reads mtdBurnCredits (not a separately-derived pool-only
  // figure): it's the exact field + headroom convention the Cost Centers
  // screen already established (CostCentersTable.tsx's
  // includedCapHeadroom(computedLimitCredits, mtdBurnCredits)) for these same
  // fixtures, so a cost center can't read "within cap" here and "over cap"
  // there.
  const costCenterSummaryByName = new Map(costCentersList.map((cc) => [cc.name, cc]));
  const capRows: IncludedCapRowModel[] = live.filter(isCapControl).map((control) => {
    const id = controlIdentity(control);
    const edit = desiredCaps[id] ?? {};
    const effective = applyCapEdit(control, edit);
    const summary = costCenterSummaryByName.get(control.costCenterName);
    return {
      id,
      costCenterName: control.costCenterName,
      enabled: effective.enabled,
      overflow: effective.overflow,
      computedLimitCredits: control.computedLimitCredits,
      memberCount: summary?.memberCount ?? 0,
      drawnCredits: summary?.mtdBurnCredits ?? 0,
      staged: stagedIds.has(id),
    };
  });

  // NewUlbModal's entity pickers, narrowed to genuinely-new targets (CLAUDE.md
  // build brief: "filtered to exclude existing overrides") -- a scope/entity
  // already covered (live and not staged for delete, or already staged-new)
  // is edited via the table row instead of created again.
  const existingIndividualLogins = new Set([
    ...liveUlbControls.filter((c) => c.scope === 'individual' && !stagedDeletes.has(budgetIdentity(c))).map((c) => c.entityName),
    ...stagedNewUlbs.filter((c) => c.scope === 'individual').map((c) => c.entityName),
  ]);
  const existingCculbCostCenterNames = new Set([
    ...liveUlbControls.filter((c) => c.scope === 'multi_user_cost_center' && !stagedDeletes.has(budgetIdentity(c))).map((c) => c.entityName),
    ...stagedNewUlbs.filter((c) => c.scope === 'multi_user_cost_center').map((c) => c.entityName),
  ]);
  const universalCovered =
    liveUlbControls.some((c) => c.scope === 'universal' && !stagedDeletes.has(budgetIdentity(c))) ||
    stagedNewUlbs.some((c) => c.scope === 'universal');
  // A universal ULB's budget_entity_name is the enterprise slug -- the same
  // top-level entity the enterprise-scope SPENDING LIMIT already carries as
  // its own entityName (both key on the enterprise itself, PRD §2.1), so it's
  // reused here rather than the UI inventing/hardcoding the slug. Null (and
  // the create modal hides the "Universal" option entirely) only if neither a
  // live enterprise spending limit nor an existing universal ULB can supply it.
  const universalEntityName =
    live.find((c): c is BudgetControl & { scope: 'enterprise' } => c.kind === 'budget' && c.scope === 'enterprise')?.entityName ??
    liveUlbControls.find((c) => c.scope === 'universal')?.entityName ??
    null;
  const eligibleUsers = heavyUsers.filter((u) => !existingIndividualLogins.has(u.userLogin));
  const eligibleCostCenters = costCentersList.filter((cc) => !existingCculbCostCenterNames.has(cc.name));

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
            <>
              <div className="controls__create-row">
                <button type="button" className="controls__create-btn" onClick={() => setCreatingUlb(true)}>
                  + New user-level budget
                </button>
              </div>
              <UlbTable
                rows={ulbRows}
                onAmountChange={onAmountChange}
                onWillAlertChange={onWillAlertChange}
                onRecipientsChange={onRecipientsChange}
                onDeleteToggle={onDeleteToggle}
                onDiscardNew={onDiscardNewUlb}
              />
            </>
          )}
          {family === 'included' && <IncludedCapsGrid rows={capRows} onToggle={onCapToggle} onOverflowChange={onCapOverflowChange} />}
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

      {creatingUlb && (
        <NewUlbModal
          eligibleUsers={eligibleUsers}
          eligibleCostCenters={eligibleCostCenters}
          universalEntityName={universalEntityName}
          universalAvailable={!universalCovered}
          onCreate={onCreateUlb}
          onClose={() => setCreatingUlb(false)}
        />
      )}
    </section>
  );
}
