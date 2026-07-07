import { cycleBounds, type PoolTriggerResult } from '@copilot-budget/core';
import { pct1 } from './poolViewModel';

// ============================================================================
// ① Trigger status (design §4): status dot (amber when fired, neutral when
// monitoring), the trigger sentence, a Day X/Y + days-left readout, and the
// three condition chips rendered TRUTHFULLY from PoolTriggerResult.conditions
// ({met,label,detail}) -- a non-fired state shows exactly which condition(s)
// hold and which don't (never color-only: ✓ for met, ○ for unmet).
// ============================================================================

interface TriggerCardProps {
  trigger: PoolTriggerResult;
  /** Cycle-to-date pool consumption fraction (context scalars, rendered not recomputed). */
  consumedFraction: number;
  asOfDate: Date;
}

export function TriggerCard({ trigger, consumedFraction, asOfDate }: TriggerCardProps) {
  const bounds = cycleBounds(asOfDate);
  const base = `Day ${bounds.daysElapsed}/${bounds.daysInCycle} · pool ${pct1(consumedFraction)} consumed · projected ${pct1(
    trigger.projectedUtilization,
  )} at reset → ~${pct1(trigger.projectedForfeitPct)} forfeit`;
  const sentence = trigger.fired
    ? `${base} · ${trigger.blockedCount} blocked, ${trigger.approachingCount} approaching.`
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
              ① Trigger status · {trigger.fired ? 'fired — pool rebalance proposed' : 'monitoring — not fired'}
            </div>
            <div className="ab-trigger__sentence" data-testid="ab-trigger-sentence">
              {sentence}
            </div>
          </div>
        </div>
        <div className="ab-trigger__day">
          <div className="ab-trigger__day-big" data-testid="ab-day">{`Day ${bounds.daysElapsed}/${bounds.daysInCycle}`}</div>
          <div className="ab-trigger__day-left">
            {trigger.daysRemaining} day{trigger.daysRemaining === 1 ? '' : 's'} left
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
