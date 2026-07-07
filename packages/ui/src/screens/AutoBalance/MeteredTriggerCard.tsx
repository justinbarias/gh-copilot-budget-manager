import type { MeteredTrigger } from '@copilot-budget/core';
import { fmtUsd } from './meteredViewModel';

// ============================================================================
// Task 6.9 -- ① Trigger status, metered mode. The pool TriggerCard is NOT
// reused here: PoolTriggerResult carries day/cycle fields (cycleBounds,
// daysRemaining, blockedCount, approachingCount, projectedUtilization/
// ForfeitPct) that MeteredTrigger structurally has none of -- the metered
// engine is date-free (meteredRebalancer.ts's own doc comment: "no I/O, no
// wall-clock"). DESIGN GAP (documented, not silently dropped): the design
// brief's example sentence ("...4 days left...") implies a countdown this
// engine doesn't produce -- METERED_SCENARIO_INPUTS carries no cycle-end
// date, so no honest "N days left" figure exists to render. This card omits
// it rather than fabricate one; a real day-based figure can land if/when the
// metered context DTO grows a cycle-end field.
// ============================================================================

interface MeteredTriggerCardProps {
  trigger: MeteredTrigger;
  /** The enterprise budget's TOTAL amount (read-only lookup, meteredViewModel's enterpriseBudgetTotalUsd). */
  enterpriseTotalUsd: number;
  /** envelope.baseRemainingUsd -- the "$X unused" figure (fixed; independent of edits). */
  baseRemainingUsd: number;
}

export function MeteredTriggerCard({ trigger, enterpriseTotalUsd, baseRemainingUsd }: MeteredTriggerCardProps) {
  const base = `Metered phase · enterprise budget ${fmtUsd(enterpriseTotalUsd)}, ${fmtUsd(baseRemainingUsd)} unused`;
  const sentence = trigger.fired
    ? `${base} · ${trigger.atRiskCount} entit${trigger.atRiskCount === 1 ? 'y' : 'ies'} at or above a hard-stop metered cap.`
    : `${base} · trigger conditions not met — no redistribution proposed.`;

  return (
    <div className="ab-card ab-trigger">
      <div className="ab-trigger__top">
        <div className="ab-trigger__lead">
          <span
            className={trigger.fired ? 'ab-trigger__dot ab-trigger__dot--fired' : 'ab-trigger__dot'}
            aria-hidden="true"
          />
          <div>
            <div className="ab-eyebrow">
              ① Trigger status · {trigger.fired ? 'fired — metered redistribution proposed' : 'monitoring — not fired'}
            </div>
            <div className="ab-trigger__sentence" data-testid="ab-trigger-sentence">
              {sentence}
            </div>
          </div>
        </div>
      </div>
      <div className="ab-trigger__chips">
        {trigger.conditions.map((c) => (
          <div key={c.label} className="ab-chip" data-met={c.met}>
            <span className={c.met ? 'ab-chip__mark ab-chip__mark--met' : 'ab-chip__mark'} aria-hidden="true">
              {c.met ? '✓' : '○'}
            </span>
            <div>
              <div className="ab-chip__label">
                {c.label}
                <span className="ab-chip__state"> · {c.met ? 'met' : 'not met'}</span>
              </div>
              <div className="ab-chip__detail">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
