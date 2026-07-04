import { useEffect, useState } from 'react';
import {
  classifyHeadroom,
  costCenterStatus,
  includedCapHeadroom,
  LOW_HEADROOM_THRESHOLD_CREDITS,
  type CostCenterStatus,
  type HeadroomTone,
} from '@copilot-budget/core';
import type { CostCenterSummary } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { DrillModal } from './DrillModal';
import './CostCentersTable.css';

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

// U+2212 minus, matching the design prototype's negative-headroom rendering.
export function formatSignedCredits(value: number): string {
  return value < 0 ? `−${formatCredits(Math.abs(value))}` : formatCredits(value);
}

export function formatDewrMapping(cc: CostCenterSummary): string {
  return `${cc.dewrDivision} → ${cc.dewrBranch} → ${cc.dewrProject}`;
}

// Never color-only (design/README.md): amber/red headroom pairs the ⚠ glyph
// plus a text cue with the color; 'ok' renders the bare number.
const HEADROOM_CUE: Record<HeadroomTone, string | null> = {
  ok: null,
  low: 'low',
  negative: 'overrun',
};

export function HeadroomValue({ headroom, tone }: { headroom: number; tone: HeadroomTone }) {
  const cue = HEADROOM_CUE[tone];
  if (!cue) return <>{formatSignedCredits(headroom)}</>;
  return (
    <>
      <span aria-hidden="true">⚠ </span>
      {formatSignedCredits(headroom)} <span className="cc-headroom-cue">{cue}</span>
    </>
  );
}

const STATUS_META: Record<CostCenterStatus, { icon: string; label: string; modifier: string }> = {
  within: { icon: '✓', label: 'within', modifier: 'within' },
  'over-cap': { icon: '✕', label: 'over cap', modifier: 'over-cap' },
  excluded: { icon: '○', label: 'excluded', modifier: 'excluded' },
};

export function CostCentersTable() {
  const api = useApiClient();
  // Null-initial: null means "not loaded yet" -- an empty array is a real,
  // loaded result, so loading and empty states can never be conflated.
  const [costCenters, setCostCenters] = useState<CostCenterSummary[] | null>(null);
  const [drillId, setDrillId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listCostCenters().then((result) => {
      if (!cancelled) setCostCenters(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (costCenters === null) {
    return (
      <section className="cost-centers" aria-label="Cost centers">
        <h2 className="cost-centers__title">Cost centers</h2>
        <p className="cost-centers__loading">Loading…</p>
      </section>
    );
  }

  const drillTarget = drillId === null ? null : (costCenters.find((cc) => cc.id === drillId) ?? null);

  return (
    <section className="cost-centers" aria-label="Cost centers">
      <h2 className="cost-centers__title">Cost centers</h2>
      <div className="cost-centers__caption">
        {costCenters.length} cost centers · mapped to the DEWR financial structure
      </div>

      {/* Read-only in MVP (SPEC.md Assumption 4): no create/reassign affordances anywhere on this screen. */}
      <div className="cost-centers__card">
        <table className="cc-table">
          <thead>
            <tr className="cc-table__head-row">
              <th scope="col">Cost center</th>
              <th scope="col">DEWR mapping</th>
              <th scope="col">Members</th>
              <th scope="col">
                <span title="Month-to-date: credits burned so far this billing cycle." className="cc-table__mtd-help">
                  MTD burn
                </span>
              </th>
              <th scope="col">Headroom</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {costCenters.map((cc) => {
              const headroom = includedCapHeadroom(cc.includedUsageCap.computedLimitCredits, cc.mtdBurnCredits);
              const tone = classifyHeadroom(headroom, LOW_HEADROOM_THRESHOLD_CREDITS);
              const status = costCenterStatus(cc.excludedFromEnterpriseBudget, headroom);
              const statusMeta = STATUS_META[status];

              return (
                <tr
                  key={cc.id}
                  className="cc-table__row"
                  tabIndex={0}
                  onClick={() => setDrillId(cc.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setDrillId(cc.id);
                    }
                  }}
                >
                  <td className="cc-table__name">{cc.name}</td>
                  <td className="cc-table__mapping">{formatDewrMapping(cc)}</td>
                  <td className="cc-table__members">{formatCredits(cc.memberCount)}</td>
                  <td className="cc-table__mtd">{formatCredits(cc.mtdBurnCredits)}</td>
                  <td className={`cc-table__headroom cc-table__headroom--${tone}`}>
                    <HeadroomValue headroom={headroom} tone={tone} />
                  </td>
                  <td>
                    <span className={`cc-table__status cc-table__status--${statusMeta.modifier}`}>
                      <span aria-hidden="true">{statusMeta.icon}</span> {statusMeta.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cost-centers__hint">Click a cost center to drill into membership and per-member burn.</div>

      {drillTarget && <DrillModal costCenter={drillTarget} onClose={() => setDrillId(null)} />}
    </section>
  );
}
