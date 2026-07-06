import { useCallback, useEffect, useState } from 'react';
import type { CapOverflow, ControlState, CostCenterControl } from '@copilot-budget/core';
import { CostCenterPlanRail } from './CostCenterPlanRail';
import { useCostCenterPlanRail } from './useCostCenterPlanRail';
import '../Controls/NewUlbModal.css';
import './CostCenterLifecycleModal.css';

// Task 4.13's "+ New cost center" CREATE flow. The design prototype
// (design/*.dc.html) ships a "+ New cost center" BUTTON on the Cost Centers
// screen but no modal markup behind it, so this modal's layout is this build's
// own -- modeled on the existing NewUlbModal (form fields) + DrillModal
// (backdrop/dialog shell) conventions, not an invented visual language
// (flagged per CLAUDE.md's "if design doesn't cover it, don't guess"). The
// create itself rides the same staged -> dry-run -> apply plan pipeline every
// other write uses (CostCenterPlanRail + useCostCenterPlanRail): a create is
// just a desiredControls list with one extra cost_center entry.

export interface NewCostCenterModalProps {
  onClose: () => void;
  /** Fired after a successful apply so the parent can toast + refresh the CC table. */
  onApplied: (message: string) => void;
}

const OVERFLOW_LABEL: Record<CapOverflow, string> = {
  block: 'block — hard-stop the team at the cap',
  metered: 'metered — overflow tips into metered spend',
};

export function NewCostCenterModal({ onClose, onApplied }: NewCostCenterModalProps) {
  const [name, setName] = useState('');
  const [dewrDivision, setDewrDivision] = useState('');
  const [dewrBranch, setDewrBranch] = useState('');
  const [dewrProject, setDewrProject] = useState('');
  const [excluded, setExcluded] = useState(false);
  const [capEnabled, setCapEnabled] = useState(true);
  const [capOverflow, setCapOverflow] = useState<CapOverflow>('block');

  const resetForm = useCallback(() => {
    setName('');
    setDewrDivision('');
    setDewrBranch('');
    setDewrProject('');
    setExcluded(false);
    setCapEnabled(true);
    setCapOverflow('block');
  }, []);

  const buildAppliedMessage = useCallback(
    (simulated: boolean) =>
      simulated
        ? '◆ Simulated apply — new cost center created. No real GitHub cost center was changed.'
        : 'New cost center created and written to the audit trail.',
    [],
  );

  const nameTrimmed = name.trim();

  const buildDesired = useCallback(
    (live: readonly ControlState[]): ControlState[] => {
      // An empty or duplicate name can't stage a create (the identity key IS
      // the name -- a duplicate would collide with the live cost center in the
      // diff), so it collapses to a no-op plan.
      const taken = live.some((c) => c.kind === 'cost_center' && c.name === nameTrimmed);
      if (nameTrimmed === '' || taken) return [...live];
      const newControl: CostCenterControl = {
        kind: 'cost_center',
        name: nameTrimmed,
        dewrDivision: dewrDivision.trim(),
        dewrBranch: dewrBranch.trim(),
        dewrProject: dewrProject.trim(),
        excludedFromEnterpriseBudget: excluded,
        // Members are added afterwards via the drill-in membership editor --
        // the create modal only sets identity, DEWR mapping, exclude, cap prefs.
        members: [],
        includedUsageCap: { enabled: capEnabled, overflow: capOverflow },
      };
      return [...live, newControl];
    },
    [nameTrimmed, dewrDivision, dewrBranch, dewrProject, excluded, capEnabled, capOverflow],
  );

  const rail = useCostCenterPlanRail({ buildDesired, buildAppliedMessage, onApplied, resetForm });

  const nameTaken = rail.live !== null && rail.live.some((c) => c.kind === 'cost_center' && c.name === nameTrimmed);

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
        aria-label="New cost center"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-ulb-modal__header">
          <div className="new-ulb-modal__title">New cost center</div>
          <button type="button" className="new-ulb-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="new-ulb-modal__body">
          {rail.loading ? (
            <p className="cc-lifecycle-modal__loading">Loading…</p>
          ) : (
            <>
              <label className="new-ulb-modal__label" htmlFor="new-cc-name">
                Name
              </label>
              <input
                id="new-cc-name"
                className="new-ulb-modal__input"
                aria-label="Cost center name"
                placeholder="e.g. Data & Analytics Branch"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {nameTaken && (
                <div className="cc-lifecycle-modal__hint cc-lifecycle-modal__hint--warn">
                  A cost center named “{nameTrimmed}” already exists — pick a unique name.
                </div>
              )}

              <div className="cc-lifecycle-modal__dewr-grid">
                <div>
                  <label className="new-ulb-modal__label" htmlFor="new-cc-division">
                    DEWR division
                  </label>
                  <input
                    id="new-cc-division"
                    className="new-ulb-modal__input"
                    aria-label="DEWR division"
                    value={dewrDivision}
                    onChange={(event) => setDewrDivision(event.target.value)}
                  />
                </div>
                <div>
                  <label className="new-ulb-modal__label" htmlFor="new-cc-branch">
                    DEWR branch
                  </label>
                  <input
                    id="new-cc-branch"
                    className="new-ulb-modal__input"
                    aria-label="DEWR branch"
                    value={dewrBranch}
                    onChange={(event) => setDewrBranch(event.target.value)}
                  />
                </div>
                <div>
                  <label className="new-ulb-modal__label" htmlFor="new-cc-project">
                    DEWR project
                  </label>
                  <input
                    id="new-cc-project"
                    className="new-ulb-modal__input"
                    aria-label="DEWR project"
                    value={dewrProject}
                    onChange={(event) => setDewrProject(event.target.value)}
                  />
                </div>
              </div>

              <label className="cc-lifecycle-modal__check">
                <input
                  type="checkbox"
                  aria-label="Exclude from enterprise budget"
                  checked={excluded}
                  onChange={(event) => setExcluded(event.target.checked)}
                />
                <span>
                  Exclude from enterprise budget
                  <span className="cc-lifecycle-modal__check-note">
                    Its spending limit won’t count against the enterprise cap-below-sum guard.
                  </span>
                </span>
              </label>

              <label className="cc-lifecycle-modal__check">
                <input
                  type="checkbox"
                  aria-label="Enable included-usage cap"
                  checked={capEnabled}
                  onChange={(event) => setCapEnabled(event.target.checked)}
                />
                <span>
                  Enable included-usage cap
                  <span className="cc-lifecycle-modal__check-note">
                    The limit is GitHub-computed from attributed licenses — not settable here.
                  </span>
                </span>
              </label>

              {capEnabled && (
                <>
                  <label className="new-ulb-modal__label" htmlFor="new-cc-overflow">
                    Overflow when the cap is reached
                  </label>
                  <select
                    id="new-cc-overflow"
                    className="new-ulb-modal__select"
                    aria-label="Included-usage cap overflow"
                    value={capOverflow}
                    onChange={(event) => setCapOverflow(event.target.value as CapOverflow)}
                  >
                    <option value="block">{OVERFLOW_LABEL.block}</option>
                    <option value="metered">{OVERFLOW_LABEL.metered}</option>
                  </select>
                </>
              )}

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
