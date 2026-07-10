import type { AuditChainEvent } from '@copilot-budget/data';
import './AuditEvent.css';

// Task 8.4: one audit row + its expansion. Read-only by construction -- this
// component imports no write-path bridge call (getControls/dryRunPlan/
// applyPlan/etc.) and holds no staged-edit state; it only ever renders data
// already fetched by Audit.tsx. The §6.5-mandated validator greps for this.

export type ChainStatus = 'intact' | 'broken' | 'unverified' | 'unknown';

export interface AuditEventRowProps {
  event: AuditChainEvent;
  chainStatus: ChainStatus;
  expanded: boolean;
  onToggle: () => void;
}

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Absolute + timezone-fixed (never wall-clock-relative "Xm ago"), matching
// Overview/AlertsList.tsx's formatAlertTimestamp convention -- both the UI
// and any e2e assertion of it stay deterministic regardless of the machine's
// locale/timezone.
export function formatAuditTimestamp(ts: string): string {
  return `${TIMESTAMP_FORMATTER.format(new Date(ts))} UTC`;
}

const CHAIN_STATUS_META: Record<ChainStatus, { icon: string; label: string }> = {
  intact: { icon: '✓', label: 'Chain intact' },
  broken: { icon: '✗', label: 'Chain broken here' },
  unverified: { icon: '?', label: 'Unverifiable (downstream of a break)' },
  unknown: { icon: '…', label: 'Not yet verified' },
};

// Pretty-printed JSON in mono font, red for `before` / green for `after` per
// design §8 -- `null` renders as a muted "(none)" rather than the literal
// string "null" (an 'add' has no before; a 'delete' has no after).
function renderPayload(json: string | null): string {
  if (json === null) return '(none)';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // Defensive only -- appendAuditEvent always stores valid JSON or null;
    // this never fires against real data, but a raw string is a safer
    // fallback than crashing the screen on a hypothetical malformed row.
    return json;
  }
}

// The envelope/binding-constraint blocks are data-driven, per the build
// brief: render them WHEN an event actually carries an envelopeSnapshot
// (Phase 6/7 rebalancer applies), never for today's manual Phase 4/5 writes,
// which always store `envelopeSnapshot: null` (auditChain.ts's own doc
// comment: "a manual Phase-4 apply has no binding constraint at all").
function parseEnvelope(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function AuditEventRow({ event, chainStatus, expanded, onToggle }: AuditEventRowProps) {
  const statusMeta = CHAIN_STATUS_META[chainStatus];
  const envelope = parseEnvelope(event.envelopeSnapshot);

  return (
    <div className="audit-event" data-testid="audit-event" data-audit-event-id={event.id}>
      <button
        type="button"
        className="audit-event__header"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="audit-event-toggle"
      >
        <span
          className={`audit-event__chain audit-event__chain--${chainStatus}`}
          title={statusMeta.label}
          aria-label={statusMeta.label}
        >
          <span aria-hidden="true">{statusMeta.icon}</span>
        </span>
        <span className="mono audit-event__action">{event.action}</span>
        {/* Per-source chains (migration 0006): legacy (source-null) rows predate
            the sim/live split and appear in BOTH modes, so they carry a badge
            distinguishing them from the current mode's own events. Current-mode
            rows need no badge -- the whole screen is that mode. */}
        {event.source === null && (
          <span className="audit-event__source-badge" title="Written before sim/live audit chains were separated" data-testid="audit-event-legacy-badge">
            legacy (pre-separation)
          </span>
        )}
        <div className="audit-event__body">
          <div className="audit-event__entity">{event.entityRef}</div>
          <div className="audit-event__meta">
            {event.actor} · {formatAuditTimestamp(event.ts)}
          </div>
        </div>
        <span className="audit-event__chevron" aria-hidden="true">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="audit-event__expansion" data-testid="audit-event-expansion">
          <div className="audit-event__diff">
            <div className="audit-event__diff-col">
              <div className="audit-event__diff-label">Before</div>
              <pre className="mono audit-event__diff-value audit-event__diff-value--before">
                {renderPayload(event.before)}
              </pre>
            </div>
            <div className="audit-event__diff-arrow" aria-hidden="true">
              →
            </div>
            <div className="audit-event__diff-col">
              <div className="audit-event__diff-label">After</div>
              <pre className="mono audit-event__diff-value audit-event__diff-value--after">
                {renderPayload(event.after)}
              </pre>
            </div>
          </div>

          {envelope && (
            <div className="audit-event__envelope" data-testid="audit-event-envelope">
              <div className="audit-event__envelope-label">Trigger &amp; binding constraint</div>
              <div className="audit-event__envelope-trigger">
                {event.trigger}
                {typeof envelope.bindingConstraint === 'string' ? ` — ${envelope.bindingConstraint}` : ''}
              </div>
              <div className="audit-event__envelope-label">Funding envelope</div>
              <pre className="mono audit-event__envelope-value">{JSON.stringify(envelope, null, 2)}</pre>
            </div>
          )}

          {event.justification && (
            <div className="audit-event__justification" data-testid="audit-event-justification">
              <div className="audit-event__justification-label">Justification</div>
              <div className="audit-event__justification-value">{event.justification}</div>
            </div>
          )}

          {event.dataSnapshotId !== null && (
            <div className="audit-event__snapshot mono" data-testid="audit-event-snapshot">
              ↪ data snapshot #{event.dataSnapshotId}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
