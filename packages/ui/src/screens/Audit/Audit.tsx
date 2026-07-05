import { useEffect, useMemo, useState } from 'react';
import type { AuditChainEvent, AuditChainVerification } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { auditChainToCsv, auditChainToJson, downloadTextFile } from '../../lib/auditExport';
import { AuditEventRow, type ChainStatus } from './AuditEvent';
import './Audit.css';

// Task 8.4 (CLAUDE.md §6.5's audit deliverable): an immutable, filterable
// stream over the ENTIRE hash-chained audit log. Read-only by construction --
// this screen imports no write-path bridge call (getControls/dryRunPlan/
// applyPlan/etc.), only getAuditChain()/verifyAuditChain(); the §6.5-mandated
// validator greps this file (and AuditEvent.tsx) for exactly that.

export type AuditFamily = 'all' | 'budget' | 'ulb' | 'autobalance';

const ULB_SCOPES = new Set(['universal', 'individual', 'multi_user_cost_center']);

/**
 * Derives which of the design's four filter chips (All / Budget / ULB /
 * Auto-balance) an event belongs to. This is a genuine judgment call --
 * neither PLAN.md's Task 8.4 description nor the design brief define these
 * four categories against the REAL action-string vocabulary the write engine
 * actually emits (packages/data/src/write/engine.ts: budget.create/update/
 * delete, included_cap.update, cost_center.create/update/delete/membership);
 * the design prototype's own mock seeds exactly one literal action string
 * per chip and calls it done. The rule adopted here, checked against every
 * action class that exists today (full list + rationale in the Task 8.4/8.5
 * build report):
 *
 *   - 'autobalance': `trigger !== 'manual'` -- ANY rebalancer-driven grant/
 *     revert, regardless of which underlying control it touches. Nothing
 *     produces this yet (Phase 6/7's auto-balance engine isn't built), so
 *     this filter is an honest, permanently-empty tab until then -- not a
 *     broken one.
 *   - 'ulb': a `budget.*` event whose control scope is one of the three
 *     User-level-budget scopes (universal/individual/multi_user_cost_center)
 *     -- entityRef's `budget:{scope}:{entityName}` shape (core's
 *     `controlIdentity`) makes the scope directly readable without a second
 *     lookup.
 *   - 'budget': everything else -- spending-limit budgets (enterprise/
 *     organization/cost_center scope), included-usage-cap edits, and
 *     cost-center lifecycle/membership. The general control-administration
 *     bucket -- matches how the design's own mock used 'budget.update' (a
 *     cost-center SPENDING LIMIT raise, not a ULB) for exactly this chip.
 */
export function auditEventFamily(
  event: Pick<AuditChainEvent, 'action' | 'entityRef' | 'trigger'>,
): Exclude<AuditFamily, 'all'> {
  if (event.trigger !== 'manual') return 'autobalance';
  if (event.action.startsWith('budget.')) {
    const scope = event.entityRef.split(':')[1];
    if (scope && ULB_SCOPES.has(scope)) return 'ulb';
  }
  return 'budget';
}

const FILTER_CHIPS: ReadonlyArray<{ id: AuditFamily; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'budget', label: 'Budget' },
  { id: 'ulb', label: 'ULB' },
  { id: 'autobalance', label: 'Auto-balance' },
];

const FILTER_EMPTY_COPY: Record<AuditFamily, string> = {
  all: 'No audit events yet.',
  budget: 'No budget or cap events yet.',
  ulb: 'No user-level-budget events yet.',
  autobalance:
    'No auto-balance events yet — the pool and metered rebalancers ship in Phase 6/7. This tab will populate once a rebalancer grant is applied; it is empty by design, not broken.',
};

// Derives each row's "chain intact" indicator from a SINGLE verifyAuditChain
// result, rather than recomputing hashes per row (the renderer has no sync
// SHA-256 primitive to do that safely -- see the Task 8.5 build report).
// `index` is the event's position in the chain's real append (ascending-by-
// id) order, which is exactly what `failedAtIndex` indexes into: everything
// before the first break is intact; the break itself is 'broken'; anything
// after it is 'unverified' (its own hash/link was never actually checked,
// since verification stops at the first failure).
function chainStatusFor(index: number, verification: AuditChainVerification | null): ChainStatus {
  if (!verification) return 'unknown';
  if (verification.ok) return 'intact';
  if (index < verification.failedAtIndex) return 'intact';
  if (index === verification.failedAtIndex) return 'broken';
  return 'unverified';
}

function exportFilenameStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function Audit() {
  const api = useApiClient();
  const [events, setEvents] = useState<AuditChainEvent[] | null>(null);
  const [verification, setVerification] = useState<AuditChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [filter, setFilter] = useState<AuditFamily>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // The renderer's export is a silent Blob + <a download> save to the OS
  // downloads folder (main/index.ts's will-download handler) -- no browser
  // download shelf, no native save dialog (the ratified ask-first decision).
  // Without an in-app note the file lands invisibly, so surface where it went.
  const [lastExport, setLastExport] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Fetch the chain AND run a first verification together on mount, so the
    // per-row chain-intact indicators are meaningful from the moment the
    // screen renders, not just after an explicit "Verify chain" click.
    Promise.all([api.getAuditChain(), api.verifyAuditChain()]).then(([chain, verify]) => {
      if (cancelled) return;
      setEvents(chain);
      setVerification(verify);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleVerify() {
    setVerifying(true);
    try {
      setVerification(await api.verifyAuditChain());
    } finally {
      setVerifying(false);
    }
  }

  function handleExportJson() {
    if (!events) return;
    const filename = `audit-chain-export-${exportFilenameStamp()}.json`;
    downloadTextFile(filename, auditChainToJson(events), 'application/json');
    setLastExport(filename);
  }

  function handleExportCsv() {
    if (!events) return;
    const filename = `audit-chain-export-${exportFilenameStamp()}.csv`;
    downloadTextFile(filename, auditChainToCsv(events), 'text/csv');
    setLastExport(filename);
  }

  // Ascending (append) order is what verification's `failedAtIndex` indexes
  // into -- computed once here so both the filtered/newest-first render below
  // and the chain-status lookup agree on the same index space.
  const ascendingIndexById = useMemo(() => {
    const map = new Map<number, number>();
    (events ?? []).forEach((e, i) => map.set(e.id, i));
    return map;
  }, [events]);

  const displayed = useMemo(() => {
    if (!events) return [];
    const filtered = filter === 'all' ? events : events.filter((e) => auditEventFamily(e) === filter);
    // Newest first (design §8) -- ascending-by-id IS the chain's real append
    // order, so reversing it is exactly "newest first".
    return [...filtered].reverse();
  }, [events, filter]);

  if (events === null) {
    return (
      <section className="audit">
        <p className="audit__loading">Loading…</p>
      </section>
    );
  }

  return (
    <section className="audit">
      <div className="audit__toolbar">
        <div className="audit__filters" role="tablist" aria-label="Audit event filter">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={filter === chip.id}
              className={filter === chip.id ? 'audit__filter audit__filter--active' : 'audit__filter'}
              data-testid={`audit-filter-${chip.id}`}
              onClick={() => setFilter(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <span className="audit__immutable-label">Immutable · read-only</span>
      </div>

      <div className="audit__verify-panel">
        <button
          type="button"
          className="audit__verify-button"
          onClick={handleVerify}
          disabled={verifying}
          data-testid="audit-verify-button"
        >
          {verifying ? 'Verifying…' : 'Verify chain'}
        </button>
        {verification && (
          <span
            className={
              verification.ok
                ? 'audit__verify-result audit__verify-result--pass'
                : 'audit__verify-result audit__verify-result--fail'
            }
            data-testid="audit-verify-result"
          >
            {verification.ok
              ? `✓ ${events.length} event${events.length === 1 ? '' : 's'}, chain intact`
              : `✗ Chain broken at event #${verification.failedAtIndex} (${events[verification.failedAtIndex]?.action ?? 'unknown'}): ${verification.reason}`}
          </span>
        )}
        <div className="audit__export-actions">
          <button
            type="button"
            className="audit__export-button"
            onClick={handleExportJson}
            disabled={events.length === 0}
            data-testid="audit-export-json"
          >
            Export JSON
          </button>
          <button
            type="button"
            className="audit__export-button"
            onClick={handleExportCsv}
            disabled={events.length === 0}
            data-testid="audit-export-csv"
          >
            Export CSV
          </button>
        </div>
      </div>

      {lastExport && (
        <p className="audit__export-note" role="status" data-testid="audit-export-note">
          Saved <span className="mono">{lastExport}</span> to your downloads folder.
        </p>
      )}

      {displayed.length === 0 ? (
        <p className="audit__empty" data-testid="audit-empty">
          {FILTER_EMPTY_COPY[filter]}
        </p>
      ) : (
        <div className="audit__list">
          {displayed.map((event) => (
            <AuditEventRow
              key={event.id}
              event={event}
              chainStatus={chainStatusFor(ascendingIndexById.get(event.id)!, verification)}
              expanded={expandedId === event.id}
              onToggle={() => setExpandedId((current) => (current === event.id ? null : event.id))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
