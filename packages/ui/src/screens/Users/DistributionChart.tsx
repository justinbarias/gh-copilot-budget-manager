import { useState } from 'react';
import type { UsageDistribution } from '@copilot-budget/core';

// Distribution D3: the per-user credit-consumption histogram + smoothed density
// curve + percentile/mean/ULB markers. A faithful React port of the design
// reference's <script> buildChart (design/usage-distribution-mockup.html): same
// geometry, the same Gaussian-kernel smoothing + Catmull-Rom render, and the
// WIDTH-AWARE marker lane-assignment (the version specifically fixed for pill
// overlap). The histogram math itself is core's (computeUsageDistribution) --
// this file only draws it, it never recomputes percentiles/bins.

// ---- formatters (ported verbatim from the mockup) ----
export function fmtCredits(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
export function fmtDollars(v: number): string {
  const d = v / 100;
  if (d < 100) return '$' + d.toFixed(2);
  return '$' + Math.round(d).toLocaleString('en-US');
}
function fmtK(v: number): string {
  if (v >= 1000) {
    const k = v / 1000;
    return (Number.isInteger(k) ? k.toString() : k.toFixed(1)) + 'k';
  }
  return Math.round(v).toString();
}

function niceStep(range: number, targetTicks: number): number {
  if (range <= 0) return 1;
  const roughStep = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / mag;
  let niceNorm: number;
  if (norm < 1.5) niceNorm = 1;
  else if (norm < 3) niceNorm = 2;
  else if (norm < 7) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * mag;
}

// Gaussian kernel over the bin counts (radius 3, sigma 1.4), then a Catmull-Rom
// spline through the smoothed bin-centre points -- the mockup's density curve.
function gaussianSmooth(arr: readonly number[], radius: number, sigma: number): number[] {
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  const norm = kernel.map((w) => w / sum);
  return arr.map((_, i) => {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      const v = j >= 0 && j < arr.length ? (arr[j] as number) : 0;
      acc += v * (norm[k + radius] as number);
    }
    return acc;
  });
}

interface Pt {
  x: number;
  y: number;
}
function catmullRomPath(pts: readonly Pt[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0]!.x},${pts[0]!.y} L ${pts[1]!.x},${pts[1]!.y}`;
  let d = `M ${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

// ---- geometry (mockup buildChart) ----
const W = 1100;
const H = 360;
const MARGIN = { top: 96, right: 24, bottom: 56, left: 54 };
const plotLeft = MARGIN.left;
const plotRight = W - MARGIN.right;
const plotTop = MARGIN.top;
const plotBottom = H - MARGIN.bottom;
const plotWidth = plotRight - plotLeft;
const plotHeight = plotBottom - plotTop;

const COLOR = {
  p30: '#8dd6ff',
  p50: '#5fed83',
  p95: '#e3b341',
  ulb: '#ff7b72',
  mean: '#9198a1',
  grid: '#21262d',
  tick: '#484f58',
  axisText: '#7c8980',
  barFill: 'rgba(141,214,255,.28)',
  barFillHover: 'rgba(141,214,255,.55)',
  barStroke: 'rgba(141,214,255,.4)',
  baseline: '#30363d',
  pillBg: '#0d1117',
} as const;

interface Marker {
  value: number;
  x: number;
  color: string;
  dashed: boolean;
  label: string;
  sublabel?: string;
  isMean?: boolean;
  isUlb?: boolean;
  lane: number;
  textW: number;
  pillX: number;
  subW?: number;
  subX?: number;
}

export interface DistributionChartProps {
  distribution: UsageDistribution;
  /** Universal ULB amount already multiplied by the window's month count (monthly cap × months); null when no universal ULB is set. */
  ulbValue: number | null;
  /** core's countAbove(users, ulbValue) over the RAW observation list -- the exact number of observations strictly above the ULB. null iff ulbValue is null. */
  ulbUsersAbove: number | null;
  /** x-axis title; the per-month lens overrides it ("credits per user-month …"). Defaults to the window-totals wording. */
  xAxisTitle?: string;
  /** The noun the ULB "N above" sub-pill counts: "user" (window totals) or "user-month" (per-month lens). */
  aboveNoun?: string;
}

export function DistributionChart({
  distribution,
  ulbValue,
  ulbUsersAbove,
  xAxisTitle = 'total credits per user (1 cr = $0.01)',
  aboveNoun = 'user',
}: DistributionChartProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hoverBin, setHoverBin] = useState<number | null>(null);

  const { bins, xMax, p30, p50, p95, mean } = distribution;
  const counts = bins.map((b) => b.count);
  const binWidth = xMax / bins.length;

  const smoothed = gaussianSmooth(counts, 3, 1.4);
  const peak = Math.max(...counts, ...smoothed);
  const yMax = Math.max(4, peak * 1.25);

  const xScale = (v: number): number => plotLeft + (v / xMax) * plotWidth;
  const yScale = (count: number): number => plotBottom - (count / yMax) * plotHeight;

  const yStep = niceStep(yMax, 4);
  const yGrid: number[] = [];
  for (let v = 0; v <= yMax; v += yStep) yGrid.push(v);

  const xStep = niceStep(xMax, 6);
  const xTicks: number[] = [];
  for (let v = 0; v <= xMax; v += xStep) xTicks.push(v);

  const curvePts: Pt[] = smoothed.map((v, i) => ({ x: xScale((i + 0.5) * binWidth), y: yScale(v) }));
  const curveD = catmullRomPath(curvePts);

  // ---- markers ----
  const ulbClamped = ulbValue !== null && ulbValue > xMax;
  const markers: Marker[] = [
    { value: p30, x: xScale(p30), color: COLOR.p30, dashed: true, label: `P30 · ${fmtCredits(p30)} cr · ${fmtDollars(p30)}`, lane: 0, textW: 0, pillX: 0 },
    { value: p50, x: xScale(p50), color: COLOR.p50, dashed: true, label: `P50 · ${fmtCredits(p50)} cr · ${fmtDollars(p50)}`, lane: 0, textW: 0, pillX: 0 },
    { value: p95, x: xScale(p95), color: COLOR.p95, dashed: true, label: `P95 · ${fmtCredits(p95)} cr · ${fmtDollars(p95)}`, lane: 0, textW: 0, pillX: 0 },
  ];
  if (ulbValue !== null) {
    const usersAboveUlb = ulbClamped ? 0 : (ulbUsersAbove ?? 0);
    markers.push({
      value: ulbValue,
      x: ulbClamped ? plotRight : xScale(ulbValue),
      color: COLOR.ulb,
      dashed: true,
      label: ulbClamped ? `Universal ULB · ${fmtCredits(ulbValue)} cr →` : `Universal ULB · ${fmtCredits(ulbValue)} cr · ${fmtDollars(ulbValue)}`,
      sublabel: ulbClamped ? `0 ${aboveNoun}s above` : `${usersAboveUlb} ${aboveNoun}${usersAboveUlb === 1 ? '' : 's'} above`,
      isUlb: true,
      lane: 0,
      textW: 0,
      pillX: 0,
    });
  }
  markers.push({ value: mean, x: xScale(mean), color: COLOR.mean, dashed: false, label: `mean · ${fmtCredits(mean)} cr`, isMean: true, lane: 0, textW: 0, pillX: 0 });

  // Pre-compute each pill's rendered geometry (width from label length, x
  // clamped to the plot bounds) BEFORE lane assignment, so the collision check
  // reflects real pill extents (the mockup's width-aware fix for pill overlap).
  // This now covers BOTH the main pill and (when present) the sub-pill --
  // reusing the exact same width/clamp formula the render code uses below, so
  // collision detection and rendering can never drift from one another.
  for (const m of markers) {
    m.textW = m.label.length * 6.1 + 14;
    m.pillX = Math.min(Math.max(m.x - m.textW / 2, plotLeft), plotRight - m.textW);
    if (m.sublabel) {
      m.subW = m.sublabel.length * 6 + 12;
      m.subX = Math.min(Math.max(m.x - m.subW / 2, plotLeft), plotRight - m.subW);
    }
  }
  // Greedy lane assignment, sorted by x. Every pill -- main AND, when present,
  // sub -- is modeled as a reserved rectangle occupying its own lane: a
  // marker's main pill goes in lane L, and if it has a sublabel, the sub-pill
  // goes in lane L+1. L is the LOWEST lane where BOTH reservations are clear.
  // This is what extends the width-aware fix (previously main-pills only) to
  // sub-pills: a marker's sub-pill can no longer land on top of a different
  // marker's main pill occupying the lane directly below it.
  const laneGap = 6;
  const laneLastRight: number[] = [];
  const laneClear = (lane: number, x: number): boolean => {
    const right = laneLastRight[lane];
    return right === undefined || x >= right + laneGap;
  };
  for (const m of [...markers].sort((a, b) => a.x - b.x)) {
    let lane = 0;
    while (!(laneClear(lane, m.pillX) && (!m.sublabel || laneClear(lane + 1, m.subX as number)))) {
      lane++;
    }
    laneLastRight[lane] = m.pillX + m.textW;
    if (m.sublabel) {
      laneLastRight[lane + 1] = (m.subX as number) + (m.subW as number);
    }
    m.lane = lane;
  }

  return (
    <div className="distribution__chart-wrap" data-testid="distribution-chart-wrap">
      <svg className="distribution__svg" viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Per-user credit consumption histogram">
        {/* y gridlines */}
        <g>
          {yGrid.map((v) => {
            const y = yScale(v);
            return (
              <g key={`yg-${v}`}>
                <line x1={plotLeft} x2={plotRight} y1={y} y2={y} stroke={COLOR.grid} strokeWidth={1} />
                <text x={plotLeft - 8} y={y + 3.5} textAnchor="end" fontSize={10.5} fill={COLOR.axisText} className="mono">
                  {fmtK(v)}
                </text>
              </g>
            );
          })}
          <text x={plotLeft - 40} y={plotTop - 12} fontSize={10} fill={COLOR.axisText} className="mono">
            {aboveNoun}s
          </text>
        </g>

        {/* bars */}
        <g>
          {bins.map((bin, i) => {
            const x1 = xScale(bin.start);
            const x2 = xScale(bin.end);
            const barX = x1 + 1;
            const barW = Math.max(0, x2 - x1 - 2);
            const barY = yScale(bin.count);
            const barH = Math.max(0, plotBottom - barY);
            const label = `${fmtCredits(bin.start)}–${fmtCredits(bin.end)} credits: ${bin.count} ${aboveNoun}s`;
            return (
              <rect
                key={`bar-${i}`}
                x={barX}
                y={barY}
                width={barW}
                height={barH}
                fill={hoverBin === i ? COLOR.barFillHover : COLOR.barFill}
                stroke={COLOR.barStroke}
                strokeWidth={1}
                rx={1.5}
                role="img"
                aria-label={label}
                data-testid="distribution-bar"
                style={{ cursor: 'default' }}
                onMouseEnter={() => {
                  setHoverBin(i);
                  setTooltip((t) => ({ x: t?.x ?? barX, y: t?.y ?? barY, text: `${fmtCredits(bin.start)}–${fmtCredits(bin.end)} cr · ${bin.count} ${aboveNoun}s` }));
                }}
                onMouseMove={(ev) => {
                  const wrap = (ev.currentTarget.ownerSVGElement?.parentElement as HTMLElement | null)?.getBoundingClientRect();
                  if (!wrap) return;
                  setTooltip({ x: ev.clientX - wrap.left, y: ev.clientY - wrap.top, text: `${fmtCredits(bin.start)}–${fmtCredits(bin.end)} cr · ${bin.count} ${aboveNoun}s` });
                }}
                onMouseLeave={() => {
                  setHoverBin(null);
                  setTooltip(null);
                }}
              />
            );
          })}
        </g>

        {/* smoothed density curve */}
        <path d={curveD} fill="none" stroke={COLOR.p30} strokeWidth={2} strokeLinejoin="round" />

        {/* x ticks */}
        <g>
          {xTicks.map((v) => {
            const x = xScale(v);
            return (
              <g key={`xt-${v}`}>
                <line x1={x} x2={x} y1={plotBottom} y2={plotBottom + 4} stroke={COLOR.tick} strokeWidth={1} />
                <text x={x} y={plotBottom + 17} textAnchor="middle" fontSize={10.5} fill={COLOR.axisText} className="mono">
                  {fmtK(v)}
                </text>
              </g>
            );
          })}
          <text x={(plotLeft + plotRight) / 2} y={plotBottom + 40} textAnchor="middle" fontSize={10.5} fill={COLOR.axisText}>
            {xAxisTitle}
          </text>
        </g>

        {/* baseline */}
        <line x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke={COLOR.baseline} strokeWidth={1} />

        {/* markers */}
        <g>
          {markers.map((m, i) => {
            const labelY = 16 + m.lane * 20;
            return (
              <g key={`marker-${i}`} data-testid={m.isUlb ? 'distribution-ulb-marker' : m.isMean ? 'distribution-mean-marker' : undefined}>
                <line
                  x1={m.x}
                  x2={m.x}
                  y1={m.isMean ? plotTop : 10}
                  y2={plotBottom}
                  stroke={m.color}
                  strokeWidth={1.5}
                  strokeDasharray={m.dashed ? '4,4' : 'none'}
                  opacity={m.isMean ? 0.85 : 0.9}
                />
                <rect
                  x={m.pillX}
                  y={labelY - 12}
                  width={m.textW}
                  height={17}
                  rx={4}
                  fill={COLOR.pillBg}
                  stroke={m.color}
                  strokeWidth={1}
                  opacity={0.95}
                  className="distribution__pill"
                  data-testid="distribution-marker-pill"
                />
                <text
                  x={m.pillX + m.textW / 2}
                  y={labelY + 1}
                  textAnchor="middle"
                  fontSize={11}
                  fill={m.color}
                  fontWeight={600}
                  className="mono"
                  data-testid="distribution-marker-label"
                >
                  {m.label}
                </text>
                {m.sublabel && (() => {
                  const subY = 16 + (m.lane + 1) * 20;
                  const subW = m.subW as number;
                  const subX = m.subX as number;
                  return (
                    <g>
                      <rect
                        x={subX}
                        y={subY - 10}
                        width={subW}
                        height={14}
                        rx={3}
                        fill={COLOR.pillBg}
                        stroke={m.color}
                        strokeWidth={1}
                        opacity={0.85}
                        className="distribution__pill"
                        data-testid="distribution-sub-pill"
                      />
                      <text x={subX + subW / 2} y={subY + 1} textAnchor="middle" fontSize={9.5} fill={m.color} className="mono" data-testid="distribution-ulb-sublabel">
                        {m.sublabel}
                      </text>
                    </g>
                  );
                })()}
              </g>
            );
          })}
        </g>
      </svg>

      {tooltip && (
        <div className="distribution__tooltip mono" style={{ left: tooltip.x, top: tooltip.y }} role="status">
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
