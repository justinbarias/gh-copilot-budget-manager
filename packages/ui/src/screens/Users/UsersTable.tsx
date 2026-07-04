import { useEffect, useMemo, useState } from 'react';
import { isUserAtRiskOfUlbBlock, type EffectiveUlb } from '@copilot-budget/core';
import type { HeavyUser } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { ModelMixBar } from '../../components/ModelMixBar';
import { Sparkline } from '../../components/Sparkline';
import './UsersTable.css';

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

  useEffect(() => {
    let cancelled = false;
    api.listHeavyUsers().then((result) => {
      if (!cancelled) setUsers(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

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

      {/* Read-only in MVP (SPEC.md Assumption 4): no checkbox column, no "Set
          ULB" action, no cost-center reassignment <select> -- write
          affordances are hidden entirely, not just disabled. */}
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

      <div className="users__card">
        <table className="users-table">
          <thead>
            <tr className="users-table__head-row">
              <th scope="col">Login</th>
              <th scope="col">Cost center</th>
              <th scope="col">Credits MTD ↓</th>
              <th scope="col">Trend</th>
              <th scope="col">Model mix (best-effort)</th>
              <th scope="col">ULB</th>
            </tr>
          </thead>
          <tbody>
            {pageUsers.map((user) => (
              <tr key={user.userId} className="users-table__row">
                <td>
                  <div className="users-table__login-cell">
                    <span className="mono users-table__login">{user.userLogin}</span>
                    {loginSublabel(user) && <span className="users-table__sublabel">{loginSublabel(user)}</span>}
                  </div>
                </td>
                <td className="users-table__cc">{user.costCenterName ?? '—'}</td>
                <td className="users-table__mtd">{formatCredits(user.creditsUsed)}</td>
                <td>
                  <Sparkline points={user.dailySeries} />
                </td>
                <td>
                  <ModelMixBar mix={user.modelMix} />
                </td>
                <td className="users-table__ulb">{formatUlb(user.effectiveUlb)}</td>
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
    </section>
  );
}
