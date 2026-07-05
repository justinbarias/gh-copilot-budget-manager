import { useCallback, useEffect } from 'react';
import type { ControlState } from '@copilot-budget/core';
import type { HeavyUser } from '@copilot-budget/data';
import { CostCenterPlanRail } from '../CostCenters/CostCenterPlanRail';
import { moveUserToCostCenter } from '../CostCenters/costCenterMembership';
import { useCostCenterPlanRail } from '../CostCenters/useCostCenterPlanRail';
import '../Controls/NewUlbModal.css';
import '../CostCenters/CostCenterLifecycleModal.css';

// Task 4.13's Users-row cost-center reassignment: a 1:1 move of one user
// between cost centers, modeled (per CLAUDE.md's brief) as remove-resource +
// add-resource -- exactly two cost_center membership deltas in one plan, which
// the engine's removals-first apply order issues as DELETE(old) then POST(new)
// so the user is never briefly double-attributed. It rides the same staged ->
// dry-run -> apply pipeline as every other write (CostCenterPlanRail +
// useCostCenterPlanRail); the target move is fixed by props, so there's no
// form to reset -- after apply the reloaded live already reflects the move and
// the plan collapses to a no-op beside the applied-result panel.

export interface ReassignCostCenterModalProps {
  user: HeavyUser;
  /** The destination cost center the row's <select> chose. */
  toCostCenterName: string;
  onClose: () => void;
  onApplied: (message: string) => void;
}

export function ReassignCostCenterModal({ user, toCostCenterName, onClose, onApplied }: ReassignCostCenterModalProps) {
  const fromLabel = user.costCenterName ?? 'unassigned';

  const buildDesired = useCallback(
    // The one shared move primitive (drill-in "add member" uses it too): add to
    // the target, strip from wherever the user currently lives. Scanning live
    // members -- rather than trusting the row's costCenterName join -- makes the
    // source side authoritative for the diff (CLAUDE.md §6.2).
    (live: readonly ControlState[]): ControlState[] => moveUserToCostCenter(live, user.userLogin, toCostCenterName),
    [user.userLogin, toCostCenterName],
  );

  const buildAppliedMessage = useCallback(
    (simulated: boolean) =>
      simulated
        ? `◆ Simulated apply — ${user.userLogin} moved to “${toCostCenterName}”. No real GitHub cost center was changed.`
        : `${user.userLogin} moved to “${toCostCenterName}” and written to the audit trail.`,
    [user.userLogin, toCostCenterName],
  );

  // The reassignment target is fixed by props -- nothing local to reset.
  const resetForm = useCallback(() => {}, []);

  const rail = useCostCenterPlanRail({ buildDesired, buildAppliedMessage, onApplied, resetForm });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="new-ulb-modal__backdrop" onClick={onClose}>
      <div
        className="new-ulb-modal cc-lifecycle-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Reassign ${user.userLogin}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-ulb-modal__header">
          <div className="new-ulb-modal__title">Reassign cost center</div>
          <button type="button" className="new-ulb-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="new-ulb-modal__body">
          {rail.loading ? (
            <p className="cc-lifecycle-modal__loading">Loading…</p>
          ) : (
            <>
              <p className="cc-lifecycle-modal__hint">
                Move <span className="mono">{user.userLogin}</span> from <strong>{fromLabel}</strong> to{' '}
                <strong>{toCostCenterName}</strong>. This removes their resource from the current cost center and adds
                it to the new one.
              </p>

              <CostCenterPlanRail
                plan={rail.plan}
                dryRun={rail.dryRun}
                dryRunStale={rail.dryRunStale}
                runningDryRun={rail.runningDryRun}
                applying={rail.applying}
                applyResult={rail.applyResult}
                justification={rail.justification}
                onJustificationChange={rail.setJustification}
                simulated={rail.simulated}
                onRunDryRun={rail.runDryRun}
                onApply={rail.apply}
                onDiscard={rail.discard}
                onReconcileDrift={rail.reconcileDrift}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
