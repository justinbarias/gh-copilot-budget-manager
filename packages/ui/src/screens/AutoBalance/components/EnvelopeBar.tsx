// ============================================================================
// ② The signature funding-envelope bar (design/README.md "Signature
// components"): a horizontal segmented bar sized to a REMAINING total --
// Reserve (hatched neutral) · Held/on-track (faint) · → grants (blue tint,
// grows live with allocation) · slack (green tint, the unallocated
// remainder) -- with the two-part brace ("not touchable" | "envelope =
// redistributable slack") and end captions. Segment widths are proportional
// to the ENGINE's own segment numbers (render, don't recompute; the caller's
// engine invariant guarantees reserve+held+grants+slack === total). A
// NEGATIVE slack (over-allocation) is clamped to zero width for layout only;
// the numeric caption and the rail's red warning carry the truth.
//
// Task 6.9: genericized from a pool-specific `FundingEnvelope` prop to plain
// numeric segments + a `formatValue`/caption contract, so the SAME component
// renders both the pool bar (credits) and the metered bar (USD) -- unit
// formatting and caption wording are the caller's concern (AutoBalance.tsx),
// this component only lays out proportional segments. No money math lives
// here in either mode; it never did.
// ============================================================================

interface EnvelopeBarProps {
  /** The bar's total width basis; segments should sum to this (the caller's engine invariant). */
  total: number;
  reserve: number;
  held: number;
  grants: number;
  slack: number;
  /** Value formatter -- `fmt` (integer credits) for pool, `fmtUsd` ($-prefixed) for metered. */
  formatValue: (v: number) => string;
  /** aria-label prefix, e.g. "Remaining pool" or "Remaining enterprise budget". */
  totalLabel: string;
  captionLeft: string;
  captionRight: string;
}

export function EnvelopeBar({ total, reserve, held, grants, slack, formatValue, totalLabel, captionLeft, captionRight }: EnvelopeBarProps) {
  const braceLeft = reserve + held;
  const braceRight = Math.max(0, total - braceLeft);

  return (
    <div className="ab-env">
      <div
        className="ab-env__bar"
        role="img"
        aria-label={`${totalLabel} ${formatValue(total)}: reserve ${formatValue(reserve)}, held ${formatValue(held)}, grants ${formatValue(grants)}, slack ${formatValue(slack)}`}
      >
        <div className="ab-env__seg ab-env__seg--reserve" style={{ flexGrow: Math.max(reserve, 0) }}>
          <div className="ab-env__seg-name">Reserve</div>
          <div className="ab-env__seg-value mono" data-testid="ab-env-reserve">{formatValue(reserve)}</div>
        </div>
        {held > 0 && (
          <div className="ab-env__seg ab-env__seg--held" style={{ flexGrow: held }}>
            <div className="ab-env__seg-name">Held</div>
            <div className="ab-env__seg-sub">on-track use</div>
            <div className="ab-env__seg-value mono" data-testid="ab-env-held">{formatValue(held)}</div>
          </div>
        )}
        {grants > 0 && (
          <div className="ab-env__seg ab-env__seg--grants" style={{ flexGrow: grants }}>
            <div className="ab-env__seg-name">→ grants</div>
            <div className="ab-env__seg-value mono" data-testid="ab-env-grants">{formatValue(grants)}</div>
          </div>
        )}
        {slack > 0 && (
          <div className="ab-env__seg ab-env__seg--slack" style={{ flexGrow: slack }}>
            <div className="ab-env__seg-name">slack</div>
            <div className="ab-env__seg-value mono" data-testid="ab-env-slack">{formatValue(slack)}</div>
          </div>
        )}
      </div>
      <div className="ab-env__brace mono" aria-hidden="true">
        <div className="ab-env__brace-left" style={{ flexGrow: Math.max(braceLeft, 1) }}>
          not touchable
        </div>
        <div className="ab-env__brace-right" style={{ flexGrow: Math.max(braceRight, 1) }}>
          envelope = redistributable slack
        </div>
      </div>
      <div className="ab-env__caps mono">
        <span>{captionLeft}</span>
        <span>{captionRight}</span>
      </div>
    </div>
  );
}
