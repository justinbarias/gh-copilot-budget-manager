import type { RowUtilization } from './Meter';

// "Controls scale features": shared, pure (no I/O) search/sort/pagination
// helpers for the ULB and Spending-limits family tables -- individual ULBs
// are unbounded (one per user), so both tables need the same free-text
// search, sortable columns, and 10/page pagination UsersTable already
// established (packages/ui/src/screens/Users/UsersTable.tsx). Colocated here
// rather than duplicated in each table component, and rather than lifted
// into packages/core -- this is pure DISPLAY concern (search/sort/page over
// already-computed row models), not domain/money math, so it stays out of
// core per CLAUDE.md's "core is pure ... forecasting/rebalancer/diffing"
// scope.

export type ScaleSortDir = 'asc' | 'desc';
export type ScaleSortField = 'name' | 'cap' | 'utilization';

/** The subset of a row model every sortable family table shares. */
export interface ScaleSortableRow {
  id: string;
  title: string;
  /** Raw cap value as currently displayed (staged edit or live), parsed numerically for the cap sort. */
  amountRaw: string;
  utilization: RowUtilization | null;
}

export interface ScaleSortState {
  field: ScaleSortField | null;
  dir: ScaleSortDir;
}

export const DEFAULT_SCALE_SORT: ScaleSortState = { field: null, dir: 'asc' };

/** 10/page -- the exact convention UsersTable.tsx already ships. */
export const SCALE_PAGE_SIZE = 10;

/** Free-text search: case-insensitive substring match against the row's title (which already embeds the control/entity name -- "CC: <name>", "Individual · <login>", etc). */
export function matchesScaleSearch(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return title.toLowerCase().includes(q);
}

function utilizationRatio(utilization: RowUtilization | null): number {
  if (utilization === null || utilization.capCredits <= 0) return -1;
  return utilization.usedCredits / utilization.capCredits;
}

// Clicking a header toggles asc/desc on the SAME field; clicking a different
// field starts that field fresh at asc. Matches conventional sortable-table
// UX and keeps the toggle a single, predictable rule.
export function toggleScaleSort(current: ScaleSortState, field: ScaleSortField): ScaleSortState {
  if (current.field !== field) return { field, dir: 'asc' };
  return { field, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

// Unsorted (field === null) preserves whatever order the caller already
// built the rows in (Controls.tsx's own scope-then-name fixture order) --
// "Default order = current fixture order" per the build brief. Once a field
// IS selected, ties break deterministically on controlIdentity (`id`),
// ALWAYS ascending regardless of the primary direction (the conventional
// "ORDER BY x DESC, id ASC" pattern) -- every fixture ULB/spending-limit cap
// is authored distinct, so this tie-break never actually fires today, but it
// keeps future ties deterministic rather than depending on Array.sort's
// engine-specific stability.
export function sortScaleRows<T extends ScaleSortableRow>(rows: readonly T[], field: ScaleSortField | null, dir: ScaleSortDir): T[] {
  if (field === null) return [...rows];
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (field === 'name') cmp = a.title.localeCompare(b.title);
    else if (field === 'cap') cmp = (Number(a.amountRaw) || 0) - (Number(b.amountRaw) || 0);
    else cmp = utilizationRatio(a.utilization) - utilizationRatio(b.utilization);
    if (cmp !== 0) return cmp * sign;
    return a.id.localeCompare(b.id);
  });
}

export interface ScalePage<T> {
  pageRows: T[];
  pageCount: number;
  /** page clamped into [0, pageCount - 1] -- callers should feed this back rather than the raw requested page. */
  clampedPage: number;
}

export function paginateScaleRows<T>(rows: readonly T[], page: number, pageSize: number = SCALE_PAGE_SIZE): ScalePage<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const clampedPage = Math.min(Math.max(0, page), pageCount - 1);
  return { pageRows: rows.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize), pageCount, clampedPage };
}

export function ariaSortFor(field: ScaleSortField, state: ScaleSortState): 'ascending' | 'descending' | 'none' {
  if (state.field !== field) return 'none';
  return state.dir === 'asc' ? 'ascending' : 'descending';
}
