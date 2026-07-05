import './MeteredBudgetBar.css';

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export interface MeteredBudgetBarProps {
  /** Projected P50 metered spend, USD. */
  p50: number;
  /**
   * Projected P90 (pessimistic) metered spend, USD -- optional. Task 5.4's
   * ForecastResult only persists a single `projectedMeteredDollars` total (a
   * P50 run-rate figure, summed across every cycle the forecast horizon
   * covers); no P90 counterpart is computed/persisted for it. Forecast.tsx
   * omits this prop rather than fabricate one (design gap -- see the Task
   * 5.5 build report); the band/P90 tick simply don't render.
   */
  p90?: number;
  /** The scope's metered spending-limit control amount, USD; null when no spending-limit control exists for this scope (e.g. no per-org attribution). */
  budget: number | null;
  hardStop: boolean;
}

// Recreates design/*.dc.html's renderMeteredBar as plain SVG (a bespoke
// composite shape -- track + band + P50 fill + budget line + P50/P90 ticks --
// that Recharts' chart primitives aren't a natural fit for), viewBox-scaled
// the same way BurndownChart's <ResponsiveContainer> makes its own chart
// responsive.
export function MeteredBudgetBar({ p50, p90, budget, hardStop }: MeteredBudgetBarProps) {
  const w = 1040;
  const h = budget !== null ? 120 : 96;
  const padL = 16;
  const padR = 16;
  const padT = budget !== null ? 30 : 14;
  const barY = padT + 8;
  const bh = 18;
  const iw = w - padL - padR;
  const maxX = Math.max(budget ?? 0, p90 ?? 0, p50, 1) * 1.22;
  const x = (v: number) => padL + (v / maxX) * iw;
  const lineColor = hardStop ? '#ff7b72' : '#7c8980';

  return (
    <div className="metered-budget-bar" data-testid="metered-budget-bar">
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <rect x={padL} y={barY} width={iw} height={bh} rx={9} fill="#0d1117" stroke="#30363d" />

        {p90 !== undefined && p90 > p50 && (
          <rect x={x(p50)} y={barY} width={Math.max(0, x(p90) - x(p50))} height={bh} fill="rgba(141,214,255,.16)" />
        )}

        <rect x={padL} y={barY} width={Math.max(0, x(p50) - padL)} height={bh} rx={9} fill="#8dd6ff" fillOpacity={0.55} />

        {budget !== null && (
          <>
            <line x1={x(budget)} y1={barY - 8} x2={x(budget)} y2={barY + bh + 8} stroke={lineColor} strokeWidth={2} strokeDasharray="4 3" />
            <text x={x(budget)} y={barY - 12} textAnchor="middle" fill={lineColor} fontSize={11} fontWeight={600} fontFamily={MONO_FONT}>
              {usd(budget)} budget {hardStop ? '· hard-stop' : '· alert-only'}
            </text>
          </>
        )}

        <circle cx={x(p50)} cy={barY + bh / 2} r={4} fill="#8dd6ff" />
        <text x={x(p50)} y={barY + bh + 18} textAnchor="middle" fill="#f0f6fc" fontSize={11} fontFamily={MONO_FONT}>
          P50 {usd(p50)}
        </text>

        {p90 !== undefined && (
          <>
            <line x1={x(p90)} y1={barY - 2} x2={x(p90)} y2={barY + bh + 2} stroke="#e3b341" strokeWidth={2} />
            <text x={x(p90)} y={barY + bh + 32} textAnchor="middle" fill="#e3b341" fontSize={11} fontFamily={MONO_FONT}>
              P90 {usd(p90)}
            </text>
          </>
        )}

        <text x={padL} y={barY + bh + 18} textAnchor="start" fill="#7c8980" fontSize={11} fontFamily={MONO_FONT}>
          $0
        </text>
      </svg>
    </div>
  );
}
