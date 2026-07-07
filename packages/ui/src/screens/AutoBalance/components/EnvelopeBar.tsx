import type { FundingEnvelope } from '@copilot-budget/core';
import { fmt } from '../poolViewModel';

// ============================================================================
// ② The signature funding-envelope bar (design/README.md "Signature
// components"): a horizontal segmented bar sized to the REMAINING pool --
// Reserve (hatched neutral) · Held/on-track (faint) · → grants (blue tint,
// grows live with allocation) · slack (green tint, the unallocated
// remainder) -- with the two-part brace ("not touchable" | "envelope =
// redistributable slack") and end captions. Segment widths are proportional
// to the ENGINE's own EnvelopeSegments (render, don't recompute; the engine
// invariant guarantees reserve+held+grants+slack === remaining pool). A
// NEGATIVE slack (over-allocation) is clamped to zero width for layout only;
// the numeric caption and the rail's red warning carry the truth.
// ============================================================================

interface EnvelopeBarProps {
  envelope: FundingEnvelope;
}

export function EnvelopeBar({ envelope }: EnvelopeBarProps) {
  const { reserve, held, grants, slack } = envelope.segments;
  const braceLeft = reserve + held;
  const braceRight = Math.max(0, envelope.remainingPoolCredits - braceLeft);

  return (
    <div className="ab-env">
      <div className="ab-env__bar" role="img" aria-label={`Remaining pool ${fmt(envelope.remainingPoolCredits)} credits: reserve ${fmt(reserve)}, held ${fmt(held)}, grants ${fmt(grants)}, slack ${fmt(slack)}`}>
        <div className="ab-env__seg ab-env__seg--reserve" style={{ flexGrow: reserve }}>
          <div className="ab-env__seg-name">Reserve</div>
          <div className="ab-env__seg-value mono" data-testid="ab-env-reserve">{fmt(reserve)}</div>
        </div>
        {held > 0 && (
          <div className="ab-env__seg ab-env__seg--held" style={{ flexGrow: held }}>
            <div className="ab-env__seg-name">Held</div>
            <div className="ab-env__seg-sub">on-track use</div>
            <div className="ab-env__seg-value mono" data-testid="ab-env-held">{fmt(held)}</div>
          </div>
        )}
        {grants > 0 && (
          <div className="ab-env__seg ab-env__seg--grants" style={{ flexGrow: grants }}>
            <div className="ab-env__seg-name">→ grants</div>
            <div className="ab-env__seg-value mono" data-testid="ab-env-grants">{fmt(grants)}</div>
          </div>
        )}
        {slack > 0 && (
          <div className="ab-env__seg ab-env__seg--slack" style={{ flexGrow: slack }}>
            <div className="ab-env__seg-name">slack</div>
            <div className="ab-env__seg-value mono" data-testid="ab-env-slack">{fmt(slack)}</div>
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
        <span>remaining shared pool · unconsumed {fmt(envelope.remainingPoolCredits)}</span>
        <span>0 → tip into metered</span>
      </div>
    </div>
  );
}
