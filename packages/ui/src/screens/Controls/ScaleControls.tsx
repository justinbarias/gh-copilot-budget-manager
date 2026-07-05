import { ariaSortFor, type ScaleSortField, type ScaleSortState } from './tableScale';

// "Controls scale features": tiny shared presentational pieces for the ULB
// and Spending-limits family tables' sortable headers + pager -- extracted
// so both tables render the exact same aria-sort / Prev-Next-Page-X-of-Y
// markup (UsersTable.tsx's own pager convention) instead of forking it twice.

export function SortHeaderCell({
  label,
  field,
  sort,
  onSortToggle,
}: {
  label: string;
  field: ScaleSortField;
  sort: ScaleSortState;
  onSortToggle: (field: ScaleSortField) => void;
}) {
  const ariaSort = ariaSortFor(field, sort);
  const arrow = ariaSort === 'ascending' ? ' ▲' : ariaSort === 'descending' ? ' ▼' : '';
  return (
    <span role="columnheader" aria-sort={ariaSort} className="controls-table__head-cell">
      <button type="button" className="controls-table__sort-btn" onClick={() => onSortToggle(field)}>
        {label}
        {arrow}
      </button>
    </span>
  );
}

export function ScalePager({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="controls-table__pagination">
      <div className="controls-table__pager">
        <button type="button" disabled={page === 0} aria-disabled={page === 0} onClick={() => onPageChange(Math.max(0, page - 1))}>
          ‹ Prev
        </button>
        <span className="controls-table__page-label">
          Page {page + 1} / {pageCount}
        </span>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          aria-disabled={page >= pageCount - 1}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
