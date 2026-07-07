import type { MeteredSimulation } from '@copilot-budget/core';
import { fmtUsd } from './meteredViewModel';

// ============================================================================
// ④ Simulate, metered mode (design §4 Mode B): "who stays unblocked,
// projected total metered $, remaining enterprise headroom, and the BILL
// DELTA ($) -- the number FinOps signs off on." The bill delta is rendered as
// the HERO figure (design's abModel: `{label:'Bill delta — FinOps signs
// off', ..., hero:true}` is the first/prominent card) -- straight off core's
// MeteredSimulation, zero re-derivation.
//
// ⑤ is the same permanently gated pre-apply state as pool mode (Checkpoint
// 6): disabled apply button, no mutation import anywhere in this module or
// the AutoBalance folder.
// ============================================================================

interface MeteredSimulateRailProps {
  sim: MeteredSimulation;
  overAllocated: boolean;
  allocatableUsd: number;
}

export function MeteredSimulateRail({ sim, overAllocated, allocatableUsd }: MeteredSimulateRailProps) {
  return (
    <div className="ab-rail">
      <div className="ab-card ab-sim">
        <div className="ab-eyebrow">④ Simulate — dry-run before commit</div>
        <div className="ab-sim__cards">
          <div className="ab-sim__card ab-sim__card--hero">
            <div className="ab-sim__label">Bill delta — FinOps signs off</div>
            <div
              className={
                overAllocated ? 'ab-sim__value ab-sim__value--hero ab-sim__value--bad' : 'ab-sim__value ab-sim__value--hero ab-sim__value--warn'
              }
              data-testid="ab-sim-bill-delta"
            >
              +{fmtUsd(sim.billDeltaUsd)}
            </div>
          </div>
          <div className="ab-sim__card">
            <div className="ab-sim__label">Projected total metered</div>
            <div className="ab-sim__value ab-sim__value--good" data-testid="ab-sim-projected">
              {fmtUsd(sim.projectedTotalMeteredUsd)}
            </div>
          </div>
          <div className="ab-sim__card">
            <div className="ab-sim__label">Remaining enterprise headroom</div>
            <div
              className={overAllocated ? 'ab-sim__value ab-sim__value--bad' : 'ab-sim__value ab-sim__value--good'}
              data-testid="ab-sim-headroom"
            >
              {fmtUsd(sim.remainingEnterpriseHeadroomUsd)}
            </div>
          </div>
          <div className="ab-sim__card">
            <div className="ab-sim__label">Entities unblocked</div>
            <div className="ab-sim__value ab-sim__value--good" data-testid="ab-sim-unblocked">
              {sim.unblockedCount}
            </div>
          </div>
        </div>
        <div className={overAllocated ? 'ab-note ab-note--over' : 'ab-note ab-note--ok'} data-testid="ab-assurance">
          <span className="ab-note__icon" aria-hidden="true">
            {overAllocated ? '⚠' : '✓'}
          </span>
          <span className="ab-note__text">
            {overAllocated
              ? `Allocation exceeds enterprise headroom — reduce grants to stay within the ${fmtUsd(allocatableUsd)} envelope.`
              : `Stays within enterprise headroom — the bill delta above is what this redistribution actually adds to the invoice.`}
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
