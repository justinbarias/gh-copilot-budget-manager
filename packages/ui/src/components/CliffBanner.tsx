import './CliffBanner.css';

export interface CliffBannerProps {
  /** ISO 'YYYY-MM-DD' cliff date, e.g. '2026-09-01' (poolAllowance.ts's promo-window end). */
  cliffDate: string;
  /** Whole days between the cycle's asOfDate and cliffDate -- the design's "N days out" badge. */
  daysOut: number;
  /** Real enterprise pool allowance, promo basis (packages/core/src/poolAllowance.ts). */
  promoAllowance: number;
  /** Real enterprise pool allowance, standard basis -- what the SAME license count computes to post-cliff. */
  standardAllowance: number;
  onNavigateToForecast: () => void;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

// Task 5.7: design/README.md's Overview section calls for a persistent,
// red-left-bordered cliff banner reading "pool falls ~37%" -- but that figure
// is the spec's own rounding error (packages/data/src/msw/fixtures/README.md's
// "Corrections/known gaps" note): the REAL fixture constants are promo 7,000 ->
// standard 3,900 credits/seat, a 44.3% drop, not ~37% (7,000 -> ~4,410 would be
// 37%). This component always renders the truthful, computed-from-real-
// constants percentage -- never the spec's rounded prose -- and calls out the
// discrepancy inline rather than silently disagreeing with other docs.
export function CliffBanner({ cliffDate, daysOut, promoAllowance, standardAllowance, onNavigateToForecast }: CliffBannerProps) {
  const dropPct = promoAllowance > 0 ? ((promoAllowance - standardAllowance) / promoAllowance) * 100 : 0;
  const dropPctLabel = `${dropPct.toFixed(1)}%`;

  return (
    <div className="cliff-banner" data-testid="cliff-banner">
      <span className="cliff-banner__glyph" aria-hidden="true">
        ▲
      </span>
      <div className="cliff-banner__body">
        <div className="cliff-banner__headline">
          Included allowance drops on {cliffDate} — pool falls {dropPctLabel}
        </div>
        <div className="cliff-banner__detail">
          Promo → standard transition: enterprise pool {formatNumber(promoAllowance)} → {formatNumber(standardAllowance)} credits
          (a {dropPctLabel} drop -- not the ~37% some documents estimate; see the fixtures README for the reconciliation).
          Re-forecast has been applied to all downstream projections.{' '}
          <button type="button" className="cliff-banner__link" onClick={onNavigateToForecast}>
            Visualise the cliff →
          </button>
        </div>
      </div>
      <span className="cliff-banner__days-out">{daysOut} days out</span>
    </div>
  );
}
