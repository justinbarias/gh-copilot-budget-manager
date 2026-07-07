import { entityKey, type FlaggedEnterpriseRaise, type MeteredGrant, type UlbScope } from '@copilot-budget/core';
import { entityLabel, pct1 } from './poolViewModel';
import { bindingUtilization, fmtUsd, meteredGrantStatus } from './meteredViewModel';

// ============================================================================
// ③ At-risk entities · proposed grants, metered mode (design §4 Mode B). The
// metered twin of GrantsTable.tsx, with the equivalent structural distinction
// (CLAUDE.md §5) between the two row shapes the metered engine can emit:
//   - GRANTABLE (MeteredGrant) -- an editable proposed-Δ (in $) on the
//     entity's ACTUAL binding budget: an individual-ULB override (near-ULB
//     user) or a cost-center-budget raise (near-cap team).
//   - FLAGGED (FlaggedEnterpriseRaise) -- the enterprise budget ITSELF is the
//     binding constraint; raising it is policy+approval-only (FR13), so it is
//     rendered as a distinct amber advisory row with NO editable delta and no
//     draw from the envelope -- never mistakable for an auto-grant. The
//     design brief's Mode B section doesn't cover this case (only "excluded
//     cost centers shown as self-funded" is mentioned) -- DESIGN GAP,
//     documented: this treatment follows the app's existing amber-advisory
//     convention (alerts/drift badges) rather than an un-specified pattern.
// ============================================================================

const CONVERTS_FROM: Record<UlbScope, string | null> = {
  universal: 'converts from Universal ULB',
  'cost-center': 'converts from CCULB',
  individual: null,
};

const LEVER_LABEL: Record<string, string> = {
  individual_override: 'Individual ULB',
  cculb_lift: 'CCULB',
  cost_center_budget_raise: 'Cost-center budget',
};

const STATUS_LABEL = { funded: 'funded', partial: 'partial', unfunded: 'unfunded' } as const;

interface MeteredGrantsTableProps {
  grants: readonly MeteredGrant[];
  flagged: readonly FlaggedEnterpriseRaise[];
  /** Current input text per row (entityKey) -- raw dollar digits so typing stays natural. */
  grantValues: Readonly<Record<string, string>>;
  onEditGrant: (key: string, raw: string) => void;
  onReset: () => void;
  fundedCount: number;
  allocatedUsd: number;
  /** envelope.slackUsd -- negative = over-allocated (rendered red). See meteredViewModel's doc comment: slack IS the envelope's own "unallocated remainder". */
  unallocatedUsd: number;
  overAllocated: boolean;
}

export function MeteredGrantsTable({
  grants,
  flagged,
  grantValues,
  onEditGrant,
  onReset,
  fundedCount,
  allocatedUsd,
  unallocatedUsd,
  overAllocated,
}: MeteredGrantsTableProps) {
  return (
    <div className="ab-card ab-table">
      <div className="ab-table__head">
        <div className="ab-eyebrow">③ At-risk entities · proposed grants</div>
        <div className="ab-table__note">
          Each row raises the entity's ACTUAL binding metered budget (lowest-remaining-headroom-wins): a cost-center
          budget raise for a near-cap team, or a surgical individual-ULB override for a near-ULB user — never a shared
          ULB/CCULB. Enterprise-bound entities are flagged for policy approval below, never auto-granted.
        </div>
      </div>

      <div className="ab-table__cols ab-table__cols--header">
        <span>Entity</span>
        <span>Binding budget</span>
        <span>% limit</span>
        <span>Remaining demand</span>
        <span>Proposed Δ</span>
      </div>

      {grants.map((g) => {
        const key = entityKey(g.entity);
        const convertsFrom = g.binding.type === 'ulb-bound' ? CONVERTS_FROM[g.binding.ulbScope] : null;
        const util = bindingUtilization(g.binding);
        const status = meteredGrantStatus(g.grantedDeltaCredits, g.neededDeltaCredits);
        return (
          <div key={key} className="ab-table__cols ab-row" data-testid={`ab-row-${key}`}>
            <div className="ab-row__entity mono">{entityLabel(g.entity)}</div>
            <div>
              <span
                className={
                  g.lever.kind === 'cost_center_budget_raise' ? 'ab-lever ab-lever--cc mono' : 'ab-lever ab-lever--ulb mono'
                }
              >
                {LEVER_LABEL[g.lever.kind]}
              </span>
              {convertsFrom && <div className="ab-row__sub">{convertsFrom}</div>}
              {g.fundingSource === 'own_budget' && (
                <div className="ab-row__sub mono">self-funded — excluded cost center</div>
              )}
            </div>
            <div className={util >= 1 ? 'ab-row__pct ab-row__pct--blocked' : 'ab-row__pct'}>
              {Number.isFinite(util) ? pct1(util) : '—'}
            </div>
            <div className="ab-row__demand">~{fmtUsd(g.neededDeltaUsd)} remaining demand</div>
            <div>
              <div className="ab-row__delta">
                <span className="ab-row__delta-prefix">+$</span>
                <input
                  className="ab-row__input mono"
                  inputMode="numeric"
                  value={grantValues[key] ?? String(Math.round(g.grantedDeltaUsd))}
                  onChange={(e) => onEditGrant(key, e.target.value)}
                  aria-label={`Proposed grant delta for ${entityLabel(g.entity)}`}
                  data-testid={`ab-delta-${key}`}
                />
              </div>
              <div className={`ab-row__status ab-row__status--${status}`} data-testid={`ab-status-${key}`}>
                {status === 'funded' ? '✓ ' : status === 'partial' ? '◐ ' : '✕ '}
                {STATUS_LABEL[status]}
              </div>
            </div>
          </div>
        );
      })}

      {flagged.map((f) => {
        const key = entityKey(f.entity);
        return (
          <div key={key} className="ab-table__cols ab-row ab-row--flagged" data-testid={`ab-flagged-${key}`}>
            <div className="ab-row__entity mono">{entityLabel(f.entity)}</div>
            <div>
              <span className="ab-lever ab-lever--flagged mono">Enterprise budget · flagged</span>
              <div className="ab-row__sub mono">policy + approval only — not auto-granted</div>
            </div>
            <div className="ab-row__pct ab-row__pct--blocked">—</div>
            <div className="ab-row__demand">~{fmtUsd(f.neededDeltaUsd)} shortfall</div>
            <div className="ab-row__flagged-note">{f.reason}</div>
          </div>
        );
      })}

      <div className="ab-table__footer">
        <span className="ab-table__footer-left" data-testid="ab-footer-funded">
          {fundedCount} of {grants.length} funded ·{' '}
          <button type="button" className="ab-table__reset" onClick={onReset}>
            reset to suggested
          </button>
        </span>
        <span
          className={overAllocated ? 'ab-table__footer-right ab-table__footer-right--over' : 'ab-table__footer-right'}
          data-testid="ab-footer-alloc"
        >
          allocated {fmtUsd(allocatedUsd)} ·{' '}
          {overAllocated ? `over the envelope by ${fmtUsd(-unallocatedUsd)}` : `unallocated ${fmtUsd(unallocatedUsd)}`}
        </span>
      </div>
    </div>
  );
}
