import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  classifyHeadroom,
  includedCapHeadroom,
  LOW_HEADROOM_THRESHOLD_CREDITS,
  type ControlState,
  type CostCenterControl,
  type CostCenterResourceRef,
  type HeadroomTone,
} from '@copilot-budget/core';
import type { CostCenterSummary, HeavyUser } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { RunwayTile, type RunwayTileTone } from '../../components/RunwayTile';
import { CostCenterPlanRail } from './CostCenterPlanRail';
import { removeUserFromOtherCostCenters } from './costCenterMembership';
import { useCostCenterPlanRail } from './useCostCenterPlanRail';
import { formatCredits, formatDewrMapping, formatSignedCredits } from './CostCentersTable';
import './DrillModal.css';
import './CostCenterLifecycleModal.css';

export interface DrillModalProps {
  costCenter: CostCenterSummary;
  onClose: () => void;
  /** Fired after a successful membership apply so the parent can toast + refresh the CC table. */
  onApplied: (message: string) => void;
}

const TILE_TONE: Record<HeadroomTone, RunwayTileTone> = {
  ok: 'default',
  low: 'amber',
  negative: 'red',
};

function headroomTileValue(headroom: number, tone: HeadroomTone): string {
  const value = formatSignedCredits(headroom);
  if (tone === 'low') return `⚠ ${value} low`;
  if (tone === 'negative') return `⚠ ${value} overrun`;
  return value;
}

function resourceKey(resource: CostCenterResourceRef): string {
  return `${resource.type}:${resource.name}`;
}

function findCostCenterControl(live: readonly ControlState[], name: string): CostCenterControl | null {
  return live.find((c): c is CostCenterControl => c.kind === 'cost_center' && c.name === name) ?? null;
}

export function DrillModal({ costCenter, onClose, onApplied }: DrillModalProps) {
  const api = useApiClient();

  // The full roster feeds the "add member" picker (existing listHeavyUsers()
  // call -- no new ApiClient surface). Null = not loaded yet.
  const [roster, setRoster] = useState<HeavyUser[] | null>(null);
  // Absolute desired member list (CostCenterResourceRef[]) -- null until the
  // live cost center's members seed it, so buildDesired stays a no-op while
  // loading. After a successful apply it's reset to null and re-seeds from the
  // freshly reloaded live members (which then already include the change).
  const [stagedMembers, setStagedMembers] = useState<readonly CostCenterResourceRef[] | null>(null);
  // Maintainer UX addition (Task 4.13): the add-member picker is a searchable
  // combobox, not a plain <select> -- 81 seats makes an unfiltered dropdown
  // unusable. `addFilter` is the type-to-filter query; `addOpen` toggles the
  // listbox (open on focus/typing, closed on pick/Esc/blur).
  const [addFilter, setAddFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.listHeavyUsers().then((users) => {
      if (!cancelled) setRoster(users);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const resetForm = useCallback(() => {
    setStagedMembers(null);
    setAddFilter('');
    setAddOpen(false);
  }, []);

  const buildAppliedMessage = useCallback(
    (simulated: boolean) =>
      simulated
        ? `◆ Simulated apply — membership updated for “${costCenter.name}”. No real GitHub cost center was changed.`
        : `Membership updated for “${costCenter.name}” and written to the audit trail.`,
    [costCenter.name],
  );

  const buildDesired = useCallback(
    (live: readonly ControlState[]): ControlState[] => {
      if (stagedMembers === null) return [...live];
      const drilled = live.find(
        (c): c is CostCenterControl => c.kind === 'cost_center' && c.name === costCenter.name,
      );
      const originalUserNames = new Set(
        drilled ? drilled.members.filter((m) => m.type === 'User').map((m) => m.name) : [],
      );
      // Set the drilled CC's members absolutely (captures in-place adds+removes).
      let desired: ControlState[] = live.map((control) =>
        control.kind === 'cost_center' && control.name === costCenter.name
          ? { ...control, members: stagedMembers }
          : control,
      );
      // Every user NEWLY added here is a MOVE (the DEWR world has no unassigned
      // seats): strip them from any other cost center so their seat is never
      // double-counted across two included-usage caps. removeUserFromOther-
      // CostCenters is the SAME primitive the Users-row reassignment uses.
      const addedLogins = stagedMembers.filter((m) => m.type === 'User' && !originalUserNames.has(m.name));
      for (const resource of addedLogins) {
        desired = removeUserFromOtherCostCenters(desired, resource.name, costCenter.name);
      }
      return desired;
    },
    [stagedMembers, costCenter.name],
  );

  const rail = useCostCenterPlanRail({ buildDesired, buildAppliedMessage, onApplied, resetForm });

  const liveControl = rail.live === null ? null : findCostCenterControl(rail.live, costCenter.name);

  // Seed staged membership from live once, and whenever a fresh live arrives
  // after an apply (resetForm nulls it, this re-seeds it from the new live).
  useEffect(() => {
    if (stagedMembers === null && liveControl !== null) {
      setStagedMembers(liveControl.members);
    }
  }, [stagedMembers, liveControl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const headroom = includedCapHeadroom(costCenter.includedUsageCap.computedLimitCredits, costCenter.mtdBurnCredits);
  const tone = classifyHeadroom(headroom, LOW_HEADROOM_THRESHOLD_CREDITS);

  // Per-login burn + ent-team provenance joined from the summary's burn view
  // (CostCenterControl.members is the raw resource list -- type+name only, no
  // via_ent_team -- so the informative "ent-team:" badge is recovered here).
  const burnByLogin = useMemo(() => {
    const map = new Map<string, number>();
    for (const member of costCenter.members) map.set(member.login, member.mtdBurnCredits);
    return map;
  }, [costCenter.members]);

  const entTeamByLogin = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of costCenter.members) if (member.entTeam !== null) map.set(member.login, member.entTeam);
    return map;
  }, [costCenter.members]);

  // Source cost center of every roster user -- drives the "moves from <CC>"
  // copy on a newly-added member (an add of an already-assigned user is a move).
  const sourceCcByLogin = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of roster ?? []) if (user.costCenterName !== null) map.set(user.userLogin, user.costCenterName);
    return map;
  }, [roster]);

  const original = liveControl?.members ?? [];
  const staged = stagedMembers ?? original;
  const stagedKeys = useMemo(() => new Set(staged.map(resourceKey)), [staged]);
  const originalKeys = useMemo(() => new Set(original.map(resourceKey)), [original]);

  // Rows to render: every staged resource (retained or newly added), plus every
  // original resource that's been removed (shown struck-through with Undo).
  const removedOriginals = original.filter((r) => !stagedKeys.has(resourceKey(r)));

  // Add-picker options: roster users who aren't already a (User) resource here.
  const addableUsers = useMemo(() => {
    if (roster === null) return [];
    return roster.filter((u) => !stagedKeys.has(`User:${u.userLogin}`));
  }, [roster, stagedKeys]);

  // Combobox filter: case-insensitive login substring; empty query shows the
  // full addable list (the listbox itself is height-capped + scrollable).
  const filteredAddable = useMemo(() => {
    const q = addFilter.trim().toLowerCase();
    return q === '' ? addableUsers : addableUsers.filter((u) => u.userLogin.toLowerCase().includes(q));
  }, [addableUsers, addFilter]);

  const onRemove = useCallback((resource: CostCenterResourceRef) => {
    setStagedMembers((current) => (current ?? []).filter((r) => resourceKey(r) !== resourceKey(resource)));
  }, []);

  const onUndoRemove = useCallback(
    (resource: CostCenterResourceRef) => {
      setStagedMembers((current) => {
        const base = current ?? [];
        if (base.some((r) => resourceKey(r) === resourceKey(resource))) return base;
        return [...base, resource];
      });
    },
    [],
  );

  // Selecting a candidate stages the add/move exactly as before (via the shared
  // primitive in buildDesired): an already-assigned user becomes a MOVE. Clears
  // the filter + closes the listbox so the picker is ready for the next add.
  const onPick = useCallback((login: string) => {
    setStagedMembers((current) => {
      const base = current ?? [];
      if (base.some((r) => r.type === 'User' && r.name === login)) return base;
      return [...base, { type: 'User', name: login }];
    });
    setAddFilter('');
    setAddOpen(false);
  }, []);

  const onAddKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // Esc closes the listbox first (and is swallowed so the modal's own Esc
      // handler doesn't also fire); a second Esc, with the listbox closed,
      // bubbles up and closes the modal.
      if (event.key === 'Escape' && addOpen) {
        setAddOpen(false);
        event.stopPropagation();
        return;
      }
      // Enter picks the first filtered match (nice-to-have per the maintainer).
      if (event.key === 'Enter') {
        event.preventDefault();
        const first = filteredAddable[0];
        if (first) onPick(first.userLogin);
      }
    },
    [addOpen, filteredAddable, onPick],
  );

  return (
    <div className="drill-modal__backdrop" onClick={onClose}>
      <div
        className="drill-modal cc-lifecycle-modal"
        role="dialog"
        aria-modal="true"
        aria-label={costCenter.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drill-modal__header">
          <div>
            <div className="drill-modal__name">{costCenter.name}</div>
            <div className="drill-modal__mapping">{formatDewrMapping(costCenter)}</div>
          </div>
          <button type="button" className="drill-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="drill-modal__body">
          <div className="drill-modal__tiles">
            <RunwayTile label="MTD burn" value={formatCredits(costCenter.mtdBurnCredits)} sub="credits this cycle" />
            {/* The cap amount is GitHub-computed from attributed licenses --
                surfaced read-only here, never as an editable field (CLAUDE.md §5). */}
            <RunwayTile
              label="Headroom"
              value={headroomTileValue(headroom, tone)}
              sub={`vs cap ${formatCredits(costCenter.includedUsageCap.computedLimitCredits)} · license-derived`}
              tone={TILE_TONE[tone]}
            />
            <RunwayTile
              label="Excluded from ent. budget"
              value={costCenter.excludedFromEnterpriseBudget ? 'Yes' : 'No'}
              sub="enterprise budget rollup"
            />
          </div>

          <div className="drill-modal__section-title">Membership</div>

          {rail.loading ? (
            <p className="cc-lifecycle-modal__loading">Loading membership…</p>
          ) : (
            <>
              <ul className="cc-members-editor__list">
                {staged.map((resource) => {
                  const isUser = resource.type === 'User';
                  const isNew = !originalKeys.has(resourceKey(resource));
                  const burn = isUser ? burnByLogin.get(resource.name) : undefined;
                  const entTeam = isUser ? entTeamByLogin.get(resource.name) : undefined;
                  // A newly-added user who already belongs elsewhere is a MOVE.
                  const movedFrom = isUser && isNew ? sourceCcByLogin.get(resource.name) : undefined;
                  return (
                    <li key={resourceKey(resource)} className="cc-members-editor__row">
                      <span className="cc-members-editor__name-cell">
                        <span className="mono cc-members-editor__name">{resource.name}</span>
                        {!isUser && <span className="cc-members-editor__type-badge">{resource.type}</span>}
                        {entTeam !== undefined && (
                          <span className="cc-members-editor__type-badge">ent-team: {entTeam}</span>
                        )}
                        {isNew &&
                          (movedFrom !== undefined && movedFrom !== costCenter.name ? (
                            <span className="cc-members-editor__type-badge">moves from {movedFrom}</span>
                          ) : (
                            <span className="cc-members-editor__type-badge">+ new</span>
                          ))}
                      </span>
                      <span className="cc-members-editor__right">
                        <span className="cc-members-editor__burn">{burn !== undefined ? formatCredits(burn) : '—'}</span>
                        <button
                          type="button"
                          className="cc-members-editor__remove"
                          aria-label={`Remove ${resource.name}`}
                          onClick={() => onRemove(resource)}
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  );
                })}
                {removedOriginals.map((resource) => (
                  <li
                    key={`removed:${resourceKey(resource)}`}
                    className="cc-members-editor__row cc-members-editor__row--removed"
                  >
                    <span className="cc-members-editor__name-cell">
                      <span className="mono cc-members-editor__name">{resource.name}</span>
                      {resource.type !== 'User' && (
                        <span className="cc-members-editor__type-badge">{resource.type}</span>
                      )}
                    </span>
                    <span className="cc-members-editor__right">
                      <button
                        type="button"
                        className="cc-members-editor__undo"
                        aria-label={`Undo removing ${resource.name}`}
                        onClick={() => onUndoRemove(resource)}
                      >
                        Undo
                      </button>
                    </span>
                  </li>
                ))}
              </ul>

              <div className="cc-members-editor__add">
                <div className="cc-combobox">
                  <input
                    className="cc-combobox__input"
                    type="text"
                    role="combobox"
                    aria-label="Add member"
                    aria-expanded={addOpen}
                    aria-controls="cc-add-listbox"
                    aria-autocomplete="list"
                    autoComplete="off"
                    placeholder="Add a user… (type to filter)"
                    value={addFilter}
                    onFocus={() => setAddOpen(true)}
                    onChange={(event) => {
                      setAddFilter(event.target.value);
                      setAddOpen(true);
                    }}
                    // Blur closes the listbox; onMouseDown-preventDefault on the
                    // options keeps a pick from blurring the input before it fires.
                    onBlur={() => setAddOpen(false)}
                    onKeyDown={onAddKeyDown}
                  />
                  {addOpen && (
                    <ul className="cc-combobox__list" id="cc-add-listbox" role="listbox" aria-label="Matching users">
                      {filteredAddable.length === 0 ? (
                        <li className="cc-combobox__empty" aria-disabled="true">
                          No matching users
                        </li>
                      ) : (
                        filteredAddable.map((user) => (
                          <li
                            key={user.userLogin}
                            role="option"
                            aria-selected="false"
                            className="cc-combobox__option"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onPick(user.userLogin)}
                          >
                            <span className="mono cc-combobox__option-login">{user.userLogin}</span>
                            {user.costCenterName && (
                              <span className="cc-combobox__option-cc">· currently {user.costCenterName}</span>
                            )}
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
              </div>
              <p className="cc-lifecycle-modal__hint">
                Adding a user who already belongs to another cost center moves them — they’re removed there and their
                seat’s cap credits shift with them.
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
