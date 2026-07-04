import { useEffect } from 'react';
import {
  classifyHeadroom,
  includedCapHeadroom,
  LOW_HEADROOM_THRESHOLD_CREDITS,
  type HeadroomTone,
} from '@copilot-budget/core';
import type { CostCenterSummary } from '@copilot-budget/data';
import { RunwayTile, type RunwayTileTone } from '../../components/RunwayTile';
import { formatCredits, formatDewrMapping, formatSignedCredits, HeadroomValue } from './CostCentersTable';
import './DrillModal.css';

export interface DrillModalProps {
  costCenter: CostCenterSummary;
  onClose: () => void;
}

const TILE_TONE: Record<HeadroomTone, RunwayTileTone> = {
  ok: 'default',
  low: 'amber',
  negative: 'red',
};

function headroomTileValue(headroom: number, tone: HeadroomTone): string {
  const value = formatSignedCredits(headroom);
  if (tone === 'low') return `⚠ ${value} low`;
  if (tone === 'negative') return `⚠ ${value} overrun`;
  return value;
}

export function DrillModal({ costCenter, onClose }: DrillModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const headroom = includedCapHeadroom(costCenter.includedUsageCap.computedLimitCredits, costCenter.mtdBurnCredits);
  const tone = classifyHeadroom(headroom, LOW_HEADROOM_THRESHOLD_CREDITS);

  return (
    <div className="drill-modal__backdrop" onClick={onClose}>
      <div
        className="drill-modal"
        role="dialog"
        aria-modal="true"
        aria-label={costCenter.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drill-modal__header">
          <div>
            <div className="drill-modal__name">{costCenter.name}</div>
            <div className="drill-modal__mapping">{formatDewrMapping(costCenter)}</div>
          </div>
          <button type="button" className="drill-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="drill-modal__body">
          <div className="drill-modal__tiles">
            <RunwayTile label="MTD burn" value={formatCredits(costCenter.mtdBurnCredits)} sub="credits this cycle" />
            {/* The cap amount is GitHub-computed from attributed licenses --
                surfaced read-only here, never as an editable field (CLAUDE.md §5). */}
            <RunwayTile
              label="Headroom"
              value={headroomTileValue(headroom, tone)}
              sub={`vs cap ${formatCredits(costCenter.includedUsageCap.computedLimitCredits)} · license-derived`}
              tone={TILE_TONE[tone]}
            />
            <RunwayTile
              label="Excluded from ent. budget"
              value={costCenter.excludedFromEnterpriseBudget ? 'Yes' : 'No'}
              sub="enterprise budget rollup"
            />
          </div>

          <div className="drill-modal__section-title">Membership</div>
          <ul className="drill-modal__members">
            {costCenter.members.map((member) => (
              <li key={member.login} className="drill-modal__member">
                <span className="drill-modal__member-id">
                  <span className="mono drill-modal__member-login">{member.login}</span>
                  {member.entTeam !== null && (
                    <span className="drill-modal__member-badge">ent-team: {member.entTeam}</span>
                  )}
                </span>
                <span className="drill-modal__member-burn">{formatCredits(member.mtdBurnCredits)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
