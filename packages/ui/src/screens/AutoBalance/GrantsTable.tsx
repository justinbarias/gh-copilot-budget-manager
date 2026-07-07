import { entityKey, type CapRelaxRecommendation, type PoolGrant, type UlbScope } from '@copilot-budget/core';
import { entityLabel, fmt, pct1 } from './poolViewModel';

// ============================================================================
// ③ At-risk entities · proposed grants (design §4). Two DISTINCT action
// shapes, matching the engine's binding-type split (CLAUDE.md §5):
//   - ULB-bound rows -> an EDITABLE proposed-Δ number input on the
//     most-specific lever (Individual ULB), with a "converts from …"
//     sub-label whenever the user is currently bound by a shared scope.
//   - Cap-bound rows -> a TOGGLE ("lift → +N" / "keep cap"), NEVER a number
//     input: the included-usage cap has no settable amount (the core's
//     CapRelaxRecommendation carries no delta field, structurally).
// Per-row funded/partial/unfunded status; footer with "N of M funded",
// reset-to-suggested, and allocated/unallocated (red when over-allocated).
// ============================================================================

const CONVERTS_FROM: Record<UlbScope, string | null> = {
  universal: 'converts from Universal ULB',
  'cost-center': 'converts from CCULB',
  individual: null, // already individual -- nothing to convert
};

const STATUS_LABEL = { funded: 'funded', partial: 'partial', unfunded: 'unfunded' } as const;

interface GrantsTableProps {
  grants: readonly PoolGrant[];
  capRelax: readonly CapRelaxRecommendation[];
  /** Current input text per ULB row (userLogin) -- raw so typing stays natural. */
  grantValues: Readonly<Record<string, string>>;
  liftedCaps: Readonly<Record<string, boolean>>;
  onEditGrant: (userLogin: string, raw: string) => void;
  onToggleCap: (capKey: string) => void;
  onReset: () => void;
  fundedCount: number;
  allocatedCredits: number;
  /** envelope − allocated; negative = over-allocated (rendered red). */
  unallocatedCredits: number;
  capUnlockTotal: number;
}

export function GrantsTable({
  grants,
  capRelax,
  grantValues,
  liftedCaps,
  onEditGrant,
  onToggleCap,
  onReset,
  fundedCount,
  allocatedCredits,
  unallocatedCredits,
  capUnlockTotal,
}: GrantsTableProps) {
  const over = unallocatedCredits < 0;

  return (
    <div className="ab-card ab-table">
      <div className="ab-table__head">
        <div className="ab-eyebrow">③ At-risk entities · proposed grants</div>
        <div className="ab-table__note">
          ULB-bound users get an editable individual-override Δ (surgical, precedence-winning); a cap-bound team gets a
          lift-cap toggle — the included-usage cap is auto-computed from licenses and has no settable amount.
        </div>
      </div>

      <div className="ab-table__cols ab-table__cols--header">
        <span>Entity</span>
        <span>Grant lever</span>
        <span>% limit</span>
        <span>Remaining demand</span>
        <span>Proposed Δ</span>
      </div>

      {grants.map((g) => {
        const convertsFrom = CONVERTS_FROM[g.convertsFrom];
        return (
          <div key={g.userLogin} className="ab-table__cols ab-row" data-testid={`ab-row-${g.userLogin}`}>
            <div className="ab-row__entity mono">{entityLabel(g.entity)}</div>
            <div>
              <span className="ab-lever ab-lever--ulb mono">Individual ULB</span>
              {convertsFrom && <div className="ab-row__sub">{convertsFrom}</div>}
              <div className="ab-row__sub mono">{fmt(g.currentLimitCredits)} ULB now</div>
            </div>
            <div className={g.utilization >= 1 ? 'ab-row__pct ab-row__pct--blocked' : 'ab-row__pct'}>
              {pct1(g.utilization)}
            </div>
            <div className="ab-row__demand">~{fmt(g.grantCredits)} remaining demand</div>
            <div>
              <div className="ab-row__delta">
                <span className="ab-row__delta-prefix">+</span>
                <input
                  className="ab-row__input mono"
                  inputMode="numeric"
                  value={grantValues[g.userLogin] ?? String(g.fundedCredits)}
                  onChange={(e) => onEditGrant(g.userLogin, e.target.value)}
                  aria-label={`Proposed grant delta for ${g.userLogin}`}
                  data-testid={`ab-delta-${g.userLogin}`}
                />
              </div>
              <div className={`ab-row__status ab-row__status--${g.status}`} data-testid={`ab-status-${g.userLogin}`}>
                {g.status === 'funded' ? '✓ ' : g.status === 'partial' ? '◐ ' : '✕ '}
                {STATUS_LABEL[g.status]}
              </div>
            </div>
          </div>
        );
      })}

      {capRelax.map((r) => {
        const key = entityKey(r.entity);
        const on = liftedCaps[key] === true;
        return (
          <div key={key} className="ab-table__cols ab-row ab-row--cap" data-testid={`ab-cap-row-${key}`}>
            <div className="ab-row__entity mono">{entityLabel(r.entity)}</div>
            <div>
              <span className="ab-lever ab-lever--cap mono">Lift usage cap</span>
              <div className="ab-row__sub mono">
                cap {fmt(r.computedLimitCredits)} · auto-computed — not settable
              </div>
            </div>
            <div
              className={
                r.computedLimitCredits > 0 && r.projectedDemandCredits >= r.computedLimitCredits
                  ? 'ab-row__pct ab-row__pct--blocked'
                  : 'ab-row__pct'
              }
            >
              {r.computedLimitCredits > 0 ? pct1(r.projectedDemandCredits / r.computedLimitCredits) : '—'}
            </div>
            <div className="ab-row__demand">~{fmt(r.unlockContributionCredits)} blocked demand</div>
            <div>
              <button
                type="button"
                className="ab-cap-toggle"
                role="switch"
                aria-checked={on}
                aria-label={`Lift included-usage cap for ${entityLabel(r.entity)}`}
                title="An included-usage cap is auto-computed from license count and can't be edited — lifting it lets the team draw from the shared pool instead."
                onClick={() => onToggleCap(key)}
                data-testid={`ab-cap-toggle-${key}`}
              >
                <span className={on ? 'ab-toggle ab-toggle--on' : 'ab-toggle'} aria-hidden="true">
                  <span className="ab-toggle__knob" />
                </span>
                <span className={on ? 'ab-cap-toggle__label ab-cap-toggle__label--on' : 'ab-cap-toggle__label'}>
                  {on ? `lift → +${fmt(r.unlockContributionCredits)}` : 'keep cap'}
                </span>
              </button>
            </div>
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
        <span className={over ? 'ab-table__footer-right ab-table__footer-right--over' : 'ab-table__footer-right'} data-testid="ab-footer-alloc">
          allocated {fmt(allocatedCredits)} ·{' '}
          {over ? `over the envelope by ${fmt(-unallocatedCredits)}` : `unallocated ${fmt(unallocatedCredits)}`}
          {capUnlockTotal > 0 && (
            <span className="ab-table__footer-cap" data-testid="ab-footer-cap">
              {' '}
              · cap unlock +{fmt(capUnlockTotal)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
