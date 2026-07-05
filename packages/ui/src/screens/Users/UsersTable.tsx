import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isUserAtRiskOfUlbBlock, type EffectiveUlb } from '@copilot-budget/core';
import type { CostCenterSummary, HeavyUser } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { ModelMixBar } from '../../components/ModelMixBar';
import { Sparkline } from '../../components/Sparkline';
import { BulkUlbModal } from './BulkUlbModal';
import { ReassignCostCenterModal } from './ReassignCostCenterModal';
import { SetUlbModal } from './SetUlbModal';
import './UsersTable.css';

// Design "Interactions & behavior": success toast ~3.8s -- same convention
// Controls.tsx's rail already established for a staged->simulate->apply
// flow's confirmation.
const TOAST_MS = 3800;

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

const ULB_SCOPE_LABEL: Record<EffectiveUlb['scope'], string> = {
  individual: 'individual',
  'cost-center': 'cost center',
  universal: 'universal',
};

// $0 always hard-stops both phases (CLAUDE.md §5) -- surfaced as a distinct
// "blocked" rendering, never just a bare "0" that could read as "no ULB set".
export function formatUlb(effectiveUlb: EffectiveUlb | null): string {
  if (effectiveUlb === null) return 'No ULB set';
  if (effectiveUlb.amountCredits <= 0) return '✕ $0 · blocked';
  return `${formatCredits(effectiveUlb.amountCredits)} · ${ULB_SCOPE_LABEL[effectiveUlb.scope]}`;
}

function loginSublabel(user: HeavyUser): string | null {
  if (user.effectiveUlb !== null && user.effectiveUlb.amountCredits <= 0) return '✕ blocked · $0 ULB';
  if (user.creditsUsed === 0) return 'no usage yet this cycle';
  return null;
}

type StatusFilter = 'all' | 'active' | 'at-risk' | 'no-usage';

// Simplification vs. the design prototype, flagged in Task 2.4's build report:
// the prototype's status buckets don't derive from any real forecast (Phase 4
// isn't built yet). This classification is purely factual, from data already
// on HeavyUser: "at risk" is core's ULB-utilization proxy (>= 90% of the
// effective ULB, or an immediate $0 block); "no usage" is 0 cycle-to-date
// credits; everything else is "active".
function classifyStatus(user: HeavyUser): Exclude<StatusFilter, 'all'> {
  if (isUserAtRiskOfUlbBlock(user.creditsUsed, user.effectiveUlb)) return 'at-risk';
  if (user.creditsUsed === 0) return 'no-usage';
  return 'active';
}

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'at-risk', label: 'At risk' },
  { id: 'no-usage', label: 'No usage' },
];

const PAGE_SIZE = 10;

export function UsersTable() {
  const api = useApiClient();
  // Null-initial: null means "not loaded yet" (same convention as
  // CostCentersTable) -- an empty array is a real, loaded result.
  const [users, setUsers] = useState<HeavyUser[] | null>(null);
  const [search, setSearch] = useState('');
  const [ccFilter, setCcFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);

  // Task 4.11's write affordances: per-row "Set ULB" (individual-ULB modal)
  // and multi-select -> bulk-ULB modal. Both route through the SAME
  // staged->simulate->apply plan the Controls screen uses (a modal is just a
  // scoped plan) -- see UlbPlanModal.tsx. Cost-center reassignment stays OUT
  // (Task 4.13); no other write affordance exists on this table.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [settingUlbFor, setSettingUlbFor] = useState<HeavyUser | null>(null);
  // A snapshot of the selected users at the moment "Set ULB for selected" was
  // clicked -- deliberately NOT derived live from `selected` on every render.
  // A successful bulk apply clears `selected` (see onBulkUlbApplied below) so
  // the table's own bulk toolbar disappears immediately; if the modal's user
  // list were derived from that same `selected` set, the modal would unmount
  // itself the instant the apply succeeded, hiding the applied-result panel
  // (mutation log + audit events) the admin needs to see. Closing the modal
  // clears this snapshot explicitly.
  const [bulkUsers, setBulkUsers] = useState<HeavyUser[] | null>(null);
  // Task 4.13: 1:1 cost-center reassignment. The row's cost-center <select>
  // opens this modal (a scoped remove+add plan) rather than mutating on change
  // -- simulate-before-apply (CLAUDE.md §6.1) still gates the write.
  const [allCostCenters, setAllCostCenters] = useState<CostCenterSummary[] | null>(null);
  const [reassignTarget, setReassignTarget] = useState<{ user: HeavyUser; toCostCenterName: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshUsers = useCallback(async () => {
    const result = await api.listHeavyUsers();
    setUsers(result);
    return result;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [userResult, ccResult] = await Promise.all([api.listHeavyUsers(), api.listCostCenters()]);
      if (cancelled) return;
      setUsers(userResult);
      setAllCostCenters(ccResult);
    })();
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

  const onRowSelectToggle = useCallback((login: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(login)) next.delete(login);
      else next.add(login);
      return next;
    });
  }, []);

  const onSetUlbApplied = useCallback(
    (message: string) => {
      showToast(message);
      void refreshUsers();
    },
    [showToast, refreshUsers],
  );

  const onBulkUlbApplied = useCallback(
    (message: string) => {
      showToast(message);
      setSelected(new Set());
      void refreshUsers();
    },
    [showToast, refreshUsers],
  );

  const onReassignApplied = useCallback(
    (message: string) => {
      showToast(message);
      // Refresh both the roster (each user's costCenterName join) and the CC
      // list (member counts moved) so the reopened select reflects the move.
      void refreshUsers();
      void api.listCostCenters().then(setAllCostCenters);
    },
    [showToast, refreshUsers, api],
  );

  // Every cost center's name (not just ones with users) -- an empty, freshly
  // created CC is still a valid reassignment destination.
  const ccNames = useMemo(() => {
    if (!allCostCenters) return [];
    return allCostCenters.map((cc) => cc.name).sort((a, b) => a.localeCompare(b));
  }, [allCostCenters]);

  const ccOptions = useMemo(() => {
    if (!users) return [];
    const names = new Set<string>();
    for (const u of users) {
      if (u.costCenterName !== null) names.add(u.costCenterName);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [users]);

  // Displayed order is core's rankHeavyUsers output, already applied by the
  // data layer (packages/data's listHeavyUsers) -- filters/search/pagination
  // narrow that ordered list, they never re-sort it (Task 2.4's spec).
  const filtered = useMemo(() => {
    if (!users) return [];
    const query = search.trim().toLowerCase();
    return users.filter((u) => {
      if (query && !u.userLogin.toLowerCase().includes(query)) return false;
      if (ccFilter !== 'all' && u.costCenterName !== ccFilter) return false;
      if (statusFilter !== 'all' && classifyStatus(u) !== statusFilter) return false;
      return true;
    });
  }, [users, search, ccFilter, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageUsers = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  // Header checkbox is "select all ON THIS PAGE" (design/README.md §6) --
  // selection itself persists across pages (a top-level login set, only
  // cleared by "Clear selection" or a successful bulk apply), matching the
  // design prototype's own toggleAllUsers/selUsers split.
  const pageLogins = pageUsers.map((u) => u.userLogin);
  const allPageSelected = pageLogins.length > 0 && pageLogins.every((login) => selected.has(login));
  const selectedUsers = (users ?? []).filter((u) => selected.has(u.userLogin));

  const onToggleAllOnPage = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        for (const login of pageLogins) next.delete(login);
      } else {
        for (const login of pageLogins) next.add(login);
      }
      return next;
    });
  };

  if (users === null) {
    return (
      <section className="users" aria-label="Users">
        <h2 className="users__title">Users</h2>
        <p className="users__loading">Loading…</p>
      </section>
    );
  }

  const resultLabel = `${filtered.length} user${filtered.length === 1 ? '' : 's'}`;
  const showingLabel =
    filtered.length === 0
      ? '0 results'
      : `Showing ${clampedPage * PAGE_SIZE + 1}–${Math.min((clampedPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length}`;

  return (
    <section className="users" aria-label="Users">
      <h2 className="users__title">Users</h2>

      {/* Task 4.11: the table gained exactly two write affordances -- the
          checkbox column (+ per-row "Set ULB") and the bulk toolbar below --
          both routed through the staged->simulate->apply plan (see
          UlbPlanModal.tsx). Cost-center reassignment stays a read-only
          column (Task 4.13's scope, not this one's); no other cell is
          editable. */}
      <div className="users__controls">
        <input
          className="users__search"
          type="text"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          placeholder="Search login…"
          aria-label="Search login"
        />
        <select
          className="users__cc-filter"
          value={ccFilter}
          onChange={(event) => {
            setCcFilter(event.target.value);
            setPage(0);
          }}
          aria-label="Filter by cost center"
        >
          <option value="all">All cost centers</option>
          {ccOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <div className="users__status-filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`users__status-filter${statusFilter === f.id ? ' users__status-filter--active' : ''}`}
              onClick={() => {
                setStatusFilter(f.id);
                setPage(0);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="users__result-count">{resultLabel}</span>
      </div>

      {selected.size > 0 && (
        <div className="users__bulk-bar">
          <span className="users__bulk-label">{selected.size} selected</span>
          <button type="button" className="users__bulk-set-ulb" onClick={() => setBulkUsers(selectedUsers)}>
            Set ULB for selected
          </button>
          <button type="button" className="users__bulk-clear" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className="users__card">
        <table className="users-table">
          <thead>
            <tr className="users-table__head-row">
              <th scope="col">
                <input
                  type="checkbox"
                  aria-label="Select all on page"
                  checked={allPageSelected}
                  onChange={onToggleAllOnPage}
                />
              </th>
              <th scope="col">Login</th>
              <th scope="col">Cost center</th>
              <th scope="col">Credits MTD ↓</th>
              <th scope="col">Trend</th>
              <th scope="col">Model mix (best-effort)</th>
              <th scope="col">ULB</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {pageUsers.map((user) => (
              <tr key={user.userId} className="users-table__row">
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${user.userLogin}`}
                    checked={selected.has(user.userLogin)}
                    onChange={() => onRowSelectToggle(user.userLogin)}
                  />
                </td>
                <td>
                  <div className="users-table__login-cell">
                    <span className="mono users-table__login">{user.userLogin}</span>
                    {loginSublabel(user) && <span className="users-table__sublabel">{loginSublabel(user)}</span>}
                  </div>
                </td>
                <td className="users-table__cc">
                  <select
                    className="users-table__cc-select"
                    aria-label={`Cost center for ${user.userLogin}`}
                    value={user.costCenterName ?? ''}
                    onChange={(event) => {
                      const next = event.target.value;
                      // Never a no-op or a move-to-unassigned: only a change to
                      // a different, real cost center opens the reassign plan.
                      if (next !== '' && next !== user.costCenterName) {
                        setReassignTarget({ user, toCostCenterName: next });
                      }
                    }}
                  >
                    {user.costCenterName === null && <option value="">— unassigned —</option>}
                    {ccNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="users-table__mtd">{formatCredits(user.creditsUsed)}</td>
                <td>
                  <Sparkline points={user.dailySeries} />
                </td>
                <td>
                  <ModelMixBar mix={user.modelMix} />
                </td>
                <td className="users-table__ulb">{formatUlb(user.effectiveUlb)}</td>
                <td>
                  <button type="button" className="users-table__set-ulb" onClick={() => setSettingUlbFor(user)}>
                    Set ULB
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="users__empty">No users match these filters.</p>}
      </div>

      <div className="users__pagination">
        <span className="users__showing">{showingLabel}</span>
        <div className="users__pager">
          <button
            type="button"
            disabled={clampedPage === 0}
            aria-disabled={clampedPage === 0}
            onClick={() => setPage(Math.max(0, clampedPage - 1))}
          >
            ‹ Prev
          </button>
          <span className="users__page-label">
            Page {clampedPage + 1} / {pageCount}
          </span>
          <button
            type="button"
            disabled={clampedPage >= pageCount - 1}
            aria-disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(Math.min(pageCount - 1, clampedPage + 1))}
          >
            Next ›
          </button>
        </div>
      </div>

      <p className="users__hint">
        Model mix is best-effort attribution — the unattributable % is shown explicitly so we never imply false
        precision.
      </p>

      {toast && (
        <div className="users-toast" role="status">
          {toast}
        </div>
      )}

      {settingUlbFor && (
        <SetUlbModal user={settingUlbFor} onClose={() => setSettingUlbFor(null)} onApplied={onSetUlbApplied} />
      )}

      {bulkUsers && bulkUsers.length > 0 && (
        <BulkUlbModal users={bulkUsers} onClose={() => setBulkUsers(null)} onApplied={onBulkUlbApplied} />
      )}

      {reassignTarget && (
        <ReassignCostCenterModal
          user={reassignTarget.user}
          toCostCenterName={reassignTarget.toCostCenterName}
          onClose={() => setReassignTarget(null)}
          onApplied={onReassignApplied}
        />
      )}
    </section>
  );
}
