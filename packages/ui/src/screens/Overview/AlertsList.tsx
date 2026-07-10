import type { Alert } from '@copilot-budget/data';
import './AlertsList.css';

export interface AlertsListProps {
  alerts: Alert[];
  /** Task 8.4: the Audit screen now exists to navigate to -- replaces the disabled Task 2.5 stub button below. */
  onNavigateToAudit?: () => void;
}

// Pre-baked, not computed: severity/tag/title/meta/timestamp are pre-baked
// MSW fixture data surfaced verbatim via ApiClient.listAlerts() (see
// PLAN.md's Architecture Decisions) -- no anomaly-detection/sorting logic
// lives here.
const SEVERITY_META: Record<Alert['severity'], { icon: string; label: string }> = {
  critical: { icon: '⛔', label: 'Critical' },
  warning: { icon: '⚠', label: 'Warning' },
  info: { icon: 'ℹ', label: 'Info' },
};

// Rendered absolute and locale/timezone-fixed (never wall-clock-relative
// "Xm ago") so both the UI and any e2e assertion of it stay deterministic
// regardless of the machine's locale/timezone (CLAUDE.md's "no wall-clock in
// anything asserted on" -- fixture timestamps anchor to SIM_CURRENT_DATE-era,
// see packages/data/src/msw/fixtures/constants.ts).
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatAlertTimestamp(timestamp: string): string {
  return `${TIMESTAMP_FORMATTER.format(new Date(timestamp))} UTC`;
}

export function AlertsList({ alerts, onNavigateToAudit }: AlertsListProps) {
  return (
    <div className="alerts-list">
      <div className="alerts-list__header">
        <h2 className="alerts-list__title">Alerts &amp; anomalies</h2>
        {/* Real since Task 8.4 -- the Audit screen exists to land on. */}
        <button type="button" className="alerts-list__audit-link" onClick={() => onNavigateToAudit?.()}>
          View in audit →
        </button>
      </div>

      {alerts.length === 0 ? (
        // Data-driven empty state (live-only in practice: sim always ships
        // fixture alerts, live returns [] until Phase 6 alert derivation --
        // see ApiClient.listAlerts). Header + "View in audit ->" stay above.
        <p className="alerts-list__empty" data-testid="alerts-empty">
          No alerts. Live alert derivation lands with Phase 6 custom alerting.
        </p>
      ) : (
        <ul className="alerts-list__items">
          {alerts.map((alert) => {
            const severity = SEVERITY_META[alert.severity];
            return (
              <li key={alert.id} className="alerts-list__item">
                <span
                  className={`alerts-list__severity alerts-list__severity--${alert.severity}`}
                  title={severity.label}
                >
                  <span aria-hidden="true">{severity.icon}</span>
                  <span className="alerts-list__severity-label">{severity.label}</span>
                </span>
                <span className="mono alerts-list__tag">{alert.tag}</span>
                <div className="alerts-list__body">
                  <div className="alerts-list__item-title">{alert.title}</div>
                  <div className="alerts-list__item-meta">{alert.meta}</div>
                </div>
                <span className="alerts-list__timestamp">{formatAlertTimestamp(alert.timestamp)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
