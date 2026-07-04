import { useEffect, useState } from 'react';
import type { AlertingState, BudgetControl, UlbBudgetScope } from '@copilot-budget/core';
import type { CostCenterSummary, HeavyUser } from '@copilot-budget/data';
import './NewUlbModal.css';

// Same parsing convention as Controls.tsx's identically-named local helpers
// (raw-digits cap input, comma-separated recipients) -- duplicated rather
// than imported to avoid a Controls.tsx <-> NewUlbModal.tsx circular module
// reference (Controls.tsx already imports this component).
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

// Task 4.10's CREATE affordance. The design prototype (design/*.dc.html) ships
// no "+ New user-level budget" button or modal at all -- only a "+ New cost
// center" button exists there -- so this modal's layout is this build's own,
// modeled on the existing DrillModal.tsx pattern (backdrop, Escape-to-close,
// role=dialog) and the Controls screen's own staging conventions (raw-digits
// cap input, alerts checkbox + comma-separated recipients), not an invented
// visual language. Flagged per CLAUDE.md's "if design doesn't cover it, don't
// guess the visual language" -- this is a plain, on-brand utility modal, not a
// new design pattern.

export interface NewUlbModalProps {
  /** Full roster (from listHeavyUsers()) minus users who already have an individual ULB (live or already staged-new). */
  eligibleUsers: readonly HeavyUser[];
  /** Cost centers (from listCostCenters()) minus ones that already have a CCULB (live or already staged-new). */
  eligibleCostCenters: readonly CostCenterSummary[];
  /**
   * The enterprise entity name to use for a universal-ULB create, derived by
   * the caller from the live enterprise-scope spending-limit budget (the same
   * top-level entity a universal ULB's budget_entity_name targets) -- null
   * when that can't be resolved, in which case the universal option is
   * hidden entirely rather than guessing a slug.
   */
  universalEntityName: string | null;
  /** False when a universal budget already exists (live or staged-new) -- there is only ever one. */
  universalAvailable: boolean;
  onCreate: (control: BudgetControl) => void;
  onClose: () => void;
}

const SCOPE_LABEL: Record<UlbBudgetScope, string> = {
  individual: 'Individual — one named user',
  multi_user_cost_center: 'CCULB — every member of a cost center',
  universal: 'Universal — every licensed user',
};

function firstAvailableScope(hasIndividual: boolean, hasCculb: boolean, hasUniversal: boolean): UlbBudgetScope {
  if (hasIndividual) return 'individual';
  if (hasCculb) return 'multi_user_cost_center';
  return hasUniversal ? 'universal' : 'individual';
}

export function NewUlbModal({
  eligibleUsers,
  eligibleCostCenters,
  universalEntityName,
  universalAvailable,
  onCreate,
  onClose,
}: NewUlbModalProps) {
  const universalOfferable = universalAvailable && universalEntityName !== null;
  const [scope, setScope] = useState<UlbBudgetScope>(
    firstAvailableScope(eligibleUsers.length > 0, eligibleCostCenters.length > 0, universalOfferable),
  );
  const [entityName, setEntityName] = useState<string>(
    scope === 'individual' ? (eligibleUsers[0]?.userLogin ?? '') : scope === 'multi_user_cost_center' ? (eligibleCostCenters[0]?.name ?? '') : '',
  );
  const [amountRaw, setAmountRaw] = useState('');
  const [willAlert, setWillAlert] = useState(false);
  const [recipientsRaw, setRecipientsRaw] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function onScopeChange(next: UlbBudgetScope) {
    setScope(next);
    setEntityName(
      next === 'individual' ? (eligibleUsers[0]?.userLogin ?? '') : next === 'multi_user_cost_center' ? (eligibleCostCenters[0]?.name ?? '') : (universalEntityName ?? ''),
    );
  }

  const resolvedEntityName = scope === 'universal' ? (universalEntityName ?? '') : entityName;
  const canCreate = resolvedEntityName.trim() !== '' && amountRaw.trim() !== '';

  function onSubmit() {
    if (!canCreate) return;
    const alerting: AlertingState = { willAlert, alertRecipients: parseRecipients(recipientsRaw) };
    const control: BudgetControl = {
      kind: 'budget',
      scope,
      entityName: resolvedEntityName,
      amountCredits: parseCredits(amountRaw),
      // ULBs are ALWAYS a hard stop (CLAUDE.md §5) -- fixed, never a choice here.
      preventFurtherUsage: true,
      alerting,
    };
    onCreate(control);
  }

  return (
    <div className="new-ulb-modal__backdrop" onClick={onClose}>
      <div className="new-ulb-modal" role="dialog" aria-modal="true" aria-label="New user-level budget" onClick={(event) => event.stopPropagation()}>
        <header className="new-ulb-modal__header">
          <div className="new-ulb-modal__title">New user-level budget</div>
          <button type="button" className="new-ulb-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="new-ulb-modal__body">
          <label className="new-ulb-modal__label" htmlFor="new-ulb-scope">
            Scope — most specific wins: Individual → CCULB → Universal
          </label>
          <select
            id="new-ulb-scope"
            className="new-ulb-modal__select"
            value={scope}
            onChange={(event) => onScopeChange(event.target.value as UlbBudgetScope)}
          >
            <option value="individual" disabled={eligibleUsers.length === 0}>
              {SCOPE_LABEL.individual}
              {eligibleUsers.length === 0 ? ' (none eligible)' : ''}
            </option>
            <option value="multi_user_cost_center" disabled={eligibleCostCenters.length === 0}>
              {SCOPE_LABEL.multi_user_cost_center}
              {eligibleCostCenters.length === 0 ? ' (none eligible)' : ''}
            </option>
            {universalOfferable && <option value="universal">{SCOPE_LABEL.universal}</option>}
          </select>

          {scope === 'individual' && (
            <>
              <label className="new-ulb-modal__label" htmlFor="new-ulb-entity">
                User
              </label>
              <select
                id="new-ulb-entity"
                className="new-ulb-modal__select mono"
                value={entityName}
                onChange={(event) => setEntityName(event.target.value)}
              >
                {eligibleUsers.map((user) => (
                  <option key={user.userLogin} value={user.userLogin}>
                    {user.userLogin}
                    {user.costCenterName ? ` · ${user.costCenterName}` : ''}
                  </option>
                ))}
              </select>
            </>
          )}

          {scope === 'multi_user_cost_center' && (
            <>
              <label className="new-ulb-modal__label" htmlFor="new-ulb-entity">
                Cost center
              </label>
              <select
                id="new-ulb-entity"
                className="new-ulb-modal__select"
                value={entityName}
                onChange={(event) => setEntityName(event.target.value)}
              >
                {eligibleCostCenters.map((cc) => (
                  <option key={cc.name} value={cc.name}>
                    {cc.name}
                  </option>
                ))}
              </select>
            </>
          )}

          {scope === 'universal' && (
            <div className="new-ulb-modal__static-entity mono">{universalEntityName}</div>
          )}

          <label className="new-ulb-modal__label" htmlFor="new-ulb-amount">
            Cap (credits)
          </label>
          <input
            id="new-ulb-amount"
            className="new-ulb-modal__input"
            aria-label="Cap (credits) — new user-level budget"
            inputMode="numeric"
            placeholder="e.g. 3000"
            value={amountRaw}
            onChange={(event) => setAmountRaw(event.target.value)}
          />

          <div className="new-ulb-modal__enforcement">
            <span className="controls-ulb__locked-pill">Hard stop · always</span>
            <span className="new-ulb-modal__enforcement-note">ULBs always hard-stop — this can't be alert-only.</span>
          </div>

          <div className="new-ulb-modal__alerts">
            <label className="controls-table__alerts-toggle">
              <input
                type="checkbox"
                aria-label="Alerts on — new user-level budget"
                checked={willAlert}
                onChange={(event) => setWillAlert(event.target.checked)}
              />
              <span>alerts</span>
            </label>
            <input
              className="controls-table__alerts-input mono"
              aria-label="Alert recipients — new user-level budget"
              placeholder="finops@example.com"
              value={recipientsRaw}
              onChange={(event) => setRecipientsRaw(event.target.value)}
            />
          </div>

          <div className="new-ulb-modal__actions">
            <button type="button" className="new-ulb-modal__cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="new-ulb-modal__create" disabled={!canCreate} onClick={onSubmit}>
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
