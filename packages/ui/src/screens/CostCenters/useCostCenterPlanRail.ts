import { useCallback, useEffect, useMemo, useState } from 'react';
import { diffControls, type ControlState, type Plan } from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';

// Task 4.13: the shared plan -> dry-run -> apply state machine that every
// cost-center lifecycle surface (New-CC modal, Drill membership editor, Users
// reassignment modal) drives, factored out of the exact structure
// UlbPlanModal.tsx already established for the ULB modals. It owns live/mode
// loading, the derived Plan (core's diffControls against the caller's
// desiredControls), the stale-dry-run guard, and all four ApplyPlanResult arms
// -- so each surface only has to build its own `desiredControls` from a small
// form and render CostCenterPlanRail. Nothing writes until apply (CLAUDE.md
// §6.1); apply re-reads live server-side and aborts as drift (§6.2). This is
// pure reuse of the same dryRunPlan/applyPlan bridge methods -- no new
// ApiClient/preload surface (Task 4.13's hard constraint).

// No admin identity system exists yet (CLAUDE.md §9 open question) -- the same
// placeholder actor string the Controls rail and ULB modals already use.
const ACTOR = 'you (FinOps)';

export type RailMode = 'simulation' | 'live';

export interface UseCostCenterPlanRailOptions {
  /**
   * Builds the caller's full desired end-state control list from the freshly
   * loaded live list (the live list with the target cost center created /
   * edited). Passing the FULL list -- not just the touched cost center -- is
   * what lets the server re-diff exactly what the UI previewed (CLAUDE.md §6.2
   * drift baseline). Must be memoized by the caller (useCallback over its form
   * state) -- the hook derives `desiredControls` from it whenever live or the
   * form changes. Taking a builder (not a ready list) sidesteps the
   * circularity of "desired depends on live, but this hook is the loader of
   * live".
   */
  buildDesired: (live: readonly ControlState[]) => ControlState[];
  /** Builds the parent success toast copy; `simulated` drives the §6.8 wording. */
  buildAppliedMessage: (simulated: boolean, appliedCount: number) => string;
  /** Parent side effects after a successful apply (toast + refresh the CC/user list). Must be stable. */
  onApplied: (message: string) => void;
  /**
   * Clears the caller's own form so `desiredControls` collapses back to `live`
   * after a successful apply (the reloaded live now includes the change, so a
   * no-op plan + the applied-result panel is what remains on screen). Must be
   * stable.
   */
  resetForm: () => void;
}

export interface CostCenterPlanRailState {
  live: ControlState[] | null;
  mode: RailMode | null;
  loading: boolean;
  desiredControls: ControlState[];
  plan: Plan;
  dryRun: DryRunResult | null;
  dryRunStale: boolean;
  runningDryRun: boolean;
  applying: boolean;
  applyResult: ApplyPlanResult | null;
  justification: string;
  simulated: boolean;
  setJustification: (value: string) => void;
  runDryRun: () => void;
  apply: () => void;
  discard: () => void;
  reconcileDrift: () => void;
}

export function useCostCenterPlanRail({
  buildDesired,
  buildAppliedMessage,
  onApplied,
  resetForm,
}: UseCostCenterPlanRailOptions): CostCenterPlanRailState {
  const api = useApiClient();

  const [live, setLive] = useState<ControlState[] | null>(null);
  const [mode, setMode] = useState<RailMode | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [dryRunPlanKey, setDryRunPlanKey] = useState<string | null>(null);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyPlanResult | null>(null);
  const [justification, setJustification] = useState('');

  const desiredControls = useMemo<ControlState[]>(() => (live === null ? [] : buildDesired(live)), [live, buildDesired]);
  const plan = useMemo(() => diffControls(live ?? [], desiredControls), [live, desiredControls]);
  const planKey = useMemo(() => JSON.stringify(plan.entries), [plan]);
  const dryRunStale = dryRun !== null && dryRunPlanKey !== planKey;

  const loadLive = useCallback(async () => {
    const [controls, runtimeMode] = await Promise.all([api.getControls(), api.getMode()]);
    setLive(controls);
    setMode(runtimeMode);
    return controls;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void loadLive().then((controls) => {
      // setState-after-unmount is a benign no-op in React 18; the guard just
      // avoids the dev-mode warning if the modal closes mid-load.
      if (cancelled) return controls;
      return controls;
    });
    return () => {
      cancelled = true;
    };
  }, [loadLive]);

  const runDryRun = useCallback(async () => {
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

  const apply = useCallback(async () => {
    if (dryRun === null) return;
    setApplying(true);
    try {
      // stagedPlan = the dry-run the admin previewed (§6.1); the engine
      // re-reads live and re-diffs, aborting as drift if it moved (§6.2).
      const result = await api.applyPlan(dryRun.plan, desiredControls, { actor: ACTOR, justification });
      setApplyResult(result);
      if (result.status === 'applied') {
        await loadLive();
        setDryRun(null);
        setDryRunPlanKey(null);
        setJustification('');
        resetForm();
        onApplied(buildAppliedMessage(mode === 'simulation', result.appliedCount));
      } else if (result.status === 'drift' || result.status === 'partial_failure') {
        // Live moved (or partially moved) under us: keep the staged form, but
        // the last dry-run no longer previews reality.
        setDryRun(null);
        setDryRunPlanKey(null);
      }
      // 'blocked': keep everything staged; the rail renders the blockers.
    } finally {
      setApplying(false);
    }
  }, [api, desiredControls, dryRun, justification, mode, loadLive, resetForm, onApplied, buildAppliedMessage]);

  const reconcileDrift = useCallback(async () => {
    await loadLive();
    setDryRun(null);
    setDryRunPlanKey(null);
    setApplyResult(null);
  }, [loadLive]);

  const discard = useCallback(() => {
    resetForm();
    setDryRun(null);
    setDryRunPlanKey(null);
    setJustification('');
    setApplyResult(null);
  }, [resetForm]);

  return {
    live,
    mode,
    loading: live === null || mode === null,
    desiredControls,
    plan,
    dryRun,
    dryRunStale,
    runningDryRun,
    applying,
    applyResult,
    justification,
    simulated: mode === 'simulation',
    setJustification,
    runDryRun,
    apply,
    discard,
    reconcileDrift,
  };
}
