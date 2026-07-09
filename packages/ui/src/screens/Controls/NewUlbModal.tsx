import { useEffect, useMemo, useState } from 'react';
import { useCombobox } from 'downshift';
import type { AlertingState, BudgetControl, UlbBudgetScope } from '@copilot-budget/core';
import type { CostCenterSummary, HeavyUser } from '@copilot-budget/data';
import { parseCredits, parseRecipients } from '../../lib/creditsInput';
import './NewUlbModal.css';

// Task (maintainer feedback): the Individual-scope "User" field used to be a
// plain <select> over the full eligible roster -- unusable against a real
// tenant's hundreds of users (no type-ahead/search). Replaced with a
// downshift `useCombobox` (headless, WAI-ARIA combobox pattern; CLAUDE.md
// §10 prefers an established lib over a bespoke one). Filtering is
// case-insensitive substring match on userLogin OR costCenterName, capped at
// 50 rendered matches with a "showing N of M" count line when truncated.
const USER_COMBOBOX_MATCH_LIMIT = 50;

function filterEligibleUsers(users: readonly HeavyUser[], query: string): HeavyUser[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...users];
  return users.filter(
    (user) =>
      user.userLogin.toLowerCase().includes(needle) ||
      (user.costCenterName ?? '').toLowerCase().includes(needle),
  );
}

function userOptionLabel(user: HeavyUser): string {
  return user.costCenterName ? `${user.userLogin} · ${user.costCenterName}` : user.userLogin;
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
  // Default individual-scope selection is NONE (not eligibleUsers[0]) --
  // maintainer-directed safety fix: pre-picking the first roster user on
  // open/scope-change caused accidental ULBs on the wrong user. An explicit
  // pick is required for this money-affecting control; Create stays disabled
  // until one is made (canCreate below).
  const [entityName, setEntityName] = useState<string>(
    scope === 'multi_user_cost_center' ? (eligibleCostCenters[0]?.name ?? '') : '',
  );
  const [amountRaw, setAmountRaw] = useState('');
  const [willAlert, setWillAlert] = useState(false);
  const [recipientsRaw, setRecipientsRaw] = useState('');

  // The user combobox's own menu handles Escape itself (close menu, revert
  // input text) via downshift's default reducer. This document-level
  // handler must NOT also close the modal while that menu is open -- it
  // relies on `comboboxIsOpen` being state (not a ref), so the closure this
  // effect captured on the LAST render (i.e. the state as it stood the
  // instant this Escape keydown started) is what gets checked: downshift's
  // synthetic onKeyDown runs on the bubble path to the React root container,
  // which sits strictly below `document` in the DOM, so its state update
  // (isOpen -> false) is scheduled but not yet committed/re-rendered by the
  // time this native document listener fires for the SAME event. First
  // Escape (menu open): this stale `comboboxIsOpen` reads true -> skip,
  // downshift's own handler closes the menu. Second Escape (menu already
  // closed): reads false -> closes the modal.
  const [comboboxIsOpen, setComboboxIsOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (comboboxIsOpen) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, comboboxIsOpen]);

  function onScopeChange(next: UlbBudgetScope) {
    setScope(next);
    setEntityName(
      next === 'multi_user_cost_center' ? (eligibleCostCenters[0]?.name ?? '') : next === 'universal' ? (universalEntityName ?? '') : '',
    );
    setUserQuery(''); // fresh, unfiltered combobox next time individual scope renders
  }

  // The current typed/filter text is independent of `entityName` (the
  // committed selection) -- see the combobox's onInputValueChange below for
  // why they diverge while the user is typing.
  const [userQuery, setUserQuery] = useState('');
  const selectedUser = useMemo(() => eligibleUsers.find((user) => user.userLogin === entityName) ?? null, [eligibleUsers, entityName]);
  const filteredUsers = useMemo(() => filterEligibleUsers(eligibleUsers, userQuery), [eligibleUsers, userQuery]);
  const visibleUsers = useMemo(() => filteredUsers.slice(0, USER_COMBOBOX_MATCH_LIMIT), [filteredUsers]);

  const {
    isOpen: userComboboxOpen,
    getInputProps,
    getMenuProps,
    getItemProps,
    getLabelProps,
    highlightedIndex,
  } = useCombobox<HeavyUser>({
    // Fixed id (not downshift's auto-generated one) so the label's htmlFor
    // stays correctly wired AND the existing `#new-ulb-entity` selector
    // (e2e specs, this modal's own aria wiring) keeps resolving to the input.
    inputId: 'new-ulb-entity',
    items: visibleUsers,
    itemToString: (item) => item?.userLogin ?? '',
    inputValue: userQuery,
    selectedItem: selectedUser,
    onIsOpenChange: ({ isOpen: nextOpen }) => setComboboxIsOpen(nextOpen ?? false),
    onInputValueChange: ({ inputValue, type }) => {
      setUserQuery(inputValue ?? '');
      // Only raw typing (not a selection/click/enter, and not downshift's
      // own revert-on-blur/-on-escape) invalidates the prior pick -- typed
      // free text that doesn't match a real roster entry must leave
      // entityName EMPTY (Create stays disabled) rather than silently
      // keeping the last committed selection.
      if (type === useCombobox.stateChangeTypes.InputChange) {
        setEntityName('');
      }
    },
    onSelectedItemChange: ({ selectedItem }) => {
      setEntityName(selectedItem?.userLogin ?? '');
      setUserQuery(selectedItem?.userLogin ?? '');
    },
  });

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
            <div className="new-ulb-modal__combobox">
              <label className="new-ulb-modal__label" {...getLabelProps()}>
                User
              </label>
              <div className="new-ulb-modal__combobox-control">
                <input
                  className="new-ulb-modal__input new-ulb-modal__combobox-input mono"
                  placeholder="Search users…"
                  {...getInputProps()}
                />
              </div>
              <ul className="new-ulb-modal__combobox-menu" {...getMenuProps()}>
                {userComboboxOpen && visibleUsers.length === 0 && (
                  <li className="new-ulb-modal__combobox-empty">No matching eligible users</li>
                )}
                {userComboboxOpen &&
                  visibleUsers.map((user, index) => (
                    <li
                      key={user.userLogin}
                      className={
                        'new-ulb-modal__combobox-item' +
                        (highlightedIndex === index ? ' new-ulb-modal__combobox-item--highlighted' : '')
                      }
                      {...getItemProps({ item: user, index, 'aria-label': userOptionLabel(user) })}
                    >
                      <span className="mono">{user.userLogin}</span>
                      {user.costCenterName && (
                        <span className="new-ulb-modal__combobox-item-cc"> · {user.costCenterName}</span>
                      )}
                    </li>
                  ))}
                {userComboboxOpen && filteredUsers.length > visibleUsers.length && (
                  <li className="new-ulb-modal__combobox-count">
                    showing {visibleUsers.length} of {filteredUsers.length}
                  </li>
                )}
              </ul>
            </div>
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
