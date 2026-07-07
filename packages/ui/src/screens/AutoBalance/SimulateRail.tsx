import type { PoolRebalanceSimulation } from '@copilot-budget/core';
import { fmt, pct1 } from './poolViewModel';

// ============================================================================
// ④ Simulate (sticky right rail, design §4 pool mode): Pool utilisation at
// reset (before → after), Metered-tip probability, Users unblocked -- all
// straight off core's PoolRebalanceSimulation -- plus the assurance note that
// flips red on the engine's over-allocated verdict.
//
// ⑤ is deliberately its GATED pre-apply state (Checkpoint 6): the apply
// button is permanently disabled and NO mutation path exists on this screen
// -- this module (and the whole AutoBalance folder) never imports or calls
// dryRunPlan/applyPlan. The real apply flow arrives with Task 7.4's
// guardrails.
// ============================================================================

interface SimulateRailProps {
  sim: PoolRebalanceSimulation;
}

export function SimulateRail({ sim }: SimulateRailProps) {
  const over = sim.verdict === 'over-allocated';
  const afterOverPool = sim.afterUtilization >= 1;

  return (
    <div className="ab-rail">
      <div className="ab-card ab-sim">
        <div className="ab-eyebrow">④ Simulate — dry-run before commit</div>
        <div className="ab-sim__cards">
          <div className="ab-sim__card">
            <div className="ab-sim__label">Pool utilisation at reset</div>
            <div
              className={afterOverPool ? 'ab-sim__value ab-sim__value--bad' : 'ab-sim__value ab-sim__value--good'}
              data-testid="ab-sim-util"
            >
              {pct1(sim.beforeUtilization)} → {pct1(sim.afterUtilization)}
            </div>
          </div>
          <div className="ab-sim__card">
            <div className="ab-sim__label">Metered-tip probability</div>
            <div
              className={afterOverPool ? 'ab-sim__value ab-sim__value--warn' : 'ab-sim__value ab-sim__value--good'}
              data-testid="ab-sim-tip"
            >
              {pct1(sim.tipProbability)}
            </div>
          </div>
          <div className="ab-sim__card">
            <div className="ab-sim__label">Users unblocked</div>
            <div className="ab-sim__value ab-sim__value--good" data-testid="ab-sim-unblocked">
              {sim.usersUnblockedCount}
            </div>
          </div>
        </div>
        <div className={over ? 'ab-note ab-note--over' : 'ab-note ab-note--ok'} data-testid="ab-assurance">
          <span className="ab-note__icon" aria-hidden="true">
            {over ? '⚠' : '✓'}
          </span>
          <span className="ab-note__text">
            {over
              ? `Allocation exceeds the envelope — ${fmt(sim.totalGrantedCredits)} granted against ${fmt(sim.envelopeCredits)} redistributable. Reduce grants to stay within the remaining pool.`
              : `Stays within the remaining pool — ${fmt(sim.totalGrantedCredits)} of the ${fmt(sim.envelopeCredits)} envelope used; unused pool credits are otherwise forfeited at reset.`}
          </span>
        </div>
      </div>

      <div className="ab-card ab-apply">
        <div className="ab-eyebrow">⑤ Approve &amp; apply → grant lifecycle</div>
        <p className="ab-apply__note">
          Each grant will be time-boxed — expiring at cycle reset with a revert / re-baseline policy — once the
          guardrailed apply path ships (Phase 7). Nothing on this screen can write to GitHub.
        </p>
        <button type="button" className="ab-apply__btn" disabled data-testid="ab-apply">
          Dry-run only — auto-apply arrives with guardrails
        </button>
      </div>
    </div>
  );
}
