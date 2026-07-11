import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Skeleton, SkeletonGroup } from '../../components/Skeleton';
import { DrillModal } from './DrillModal';
import { NewCostCenterModal } from './NewCostCenterModal';
import './CostCentersTable.css';

// Design "Interactions & behavior": success toast ~3.8s (same as Controls/Users).
const TOAST_MS = 3800;

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

// U+2212 minus, matching the design prototype's negative-headroom rendering.
export function formatSignedCredits(value: number): string {
  return value < 0 ? `−${formatCredits(Math.abs(value))}` : formatCredits(value);
}

// Honest empty state (2026-07-09 Cost Centers live-correctness round): live
// cost centers created outside the app carry NO mapping -- render "— not
// mapped", never the old "undefined → undefined → undefined". A partially
// mapped CC renders an em-dash for each missing segment.
export function formatDewrMapping(cc: CostCenterSummary): string {
  if (!cc.dewrDivision && !cc.dewrBranch && !cc.dewrProject) return '— not mapped';
  return `${cc.dewrDivision ?? '—'} → ${cc.dewrBranch ?? '—'} → ${cc.dewrProject ?? '—'}`;
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

// Honest cap-disabled status (2026-07-09): a CC with no included-usage cap is
// neither within nor over -- there is nothing to be within.
const NO_CAP_STATUS_META = { icon: '—', label: 'no cap', modifier: 'no-cap' } as const;

export function CostCentersTable() {
  const api = useApiClient();
  // Null-initial: null means "not loaded yet" -- an empty array is a real,
  // loaded result, so loading and empty states can never be conflated.
  const [costCenters, setCostCenters] = useState<CostCenterSummary[] | null>(null);
  const [drillId, setDrillId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.listCostCenters();
    setCostCenters(result);
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api.listCostCenters().then((result) => {
      if (!cancelled) setCostCenters(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const onLifecycleApplied = useCallback(
    (message: string) => {
      showToast(message);
      void refresh();
    },
    [showToast, refresh],
  );

  if (costCenters === null) {
    return (
      <section className="cost-centers" aria-label="Cost centers">
        <h2 className="cost-centers__title">Cost centers</h2>
        <SkeletonGroup>
          <Skeleton variant="line" width="28%" />
          <div className="cost-centers__card cost-centers__skeleton-rows">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} variant="line" />
            ))}
          </div>
        </SkeletonGroup>
      </section>
    );
  }

  const drillTarget = drillId === null ? null : (costCenters.find((cc) => cc.id === drillId) ?? null);

  return (
    <section className="cost-centers" aria-label="Cost centers">
      <div className="cost-centers__header">
        <h2 className="cost-centers__title">Cost centers</h2>
        {/* Task 4.13: lifecycle writes arrive on this screen -- create here,
            membership/exclude edits in the drill-in. All route through the
            staged -> dry-run -> apply plan (CLAUDE.md §6.1). */}
        <button type="button" className="cost-centers__create-btn" onClick={() => setCreating(true)}>
          + New cost center
        </button>
      </div>
      <div className="cost-centers__caption">
        {costCenters.length} cost centers · mapped to the DEWR financial structure
      </div>

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
              // Honest no-cap semantics (2026-07-09 live-correctness round):
              // a cap-disabled CC (ai_credit_pool_enabled=false -- the
              // maintainer's live world) has NO limit to have headroom
              // against; it is neither "within" nor "over cap". Headroom
              // renders "— no cap" and status a neutral "no cap" chip.
              // Exclusion still wins (it's an independent budget fact).
              const capOff = !cc.includedUsageCap.enabled;
              const headroom = includedCapHeadroom(cc.includedUsageCap.computedLimitCredits, cc.mtdBurnCredits);
              const tone = classifyHeadroom(headroom, LOW_HEADROOM_THRESHOLD_CREDITS);
              const statusMeta =
                capOff && !cc.excludedFromEnterpriseBudget
                  ? NO_CAP_STATUS_META
                  : STATUS_META[costCenterStatus(cc.excludedFromEnterpriseBudget, headroom)];

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
                  {/* The edit-mapping affordance lives in the drill modal (the
                      row's click target), keeping this cell's text exactly the
                      mapping -- committed pins assert it verbatim. */}
                  <td className="cc-table__mapping">{formatDewrMapping(cc)}</td>
                  <td className="cc-table__members">{formatCredits(cc.memberCount)}</td>
                  <td className="cc-table__mtd">{formatCredits(cc.mtdBurnCredits)}</td>
                  <td className={`cc-table__headroom${capOff ? '' : ` cc-table__headroom--${tone}`}`}>
                    {capOff ? <span className="cc-table__no-cap">— no cap</span> : <HeadroomValue headroom={headroom} tone={tone} />}
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

      {toast && (
        <div className="cost-centers-toast" role="status">
          {toast}
        </div>
      )}

      {drillTarget && (
        <DrillModal costCenter={drillTarget} onClose={() => setDrillId(null)} onApplied={onLifecycleApplied} />
      )}

      {creating && <NewCostCenterModal onClose={() => setCreating(false)} onApplied={onLifecycleApplied} />}
    </section>
  );
}
