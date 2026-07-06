import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import './BurndownChart.css';

export interface BurndownPoint {
  day: number; // days elapsed since cycle start (0 = cycle start)
  credits: number; // cumulative pool-phase credits consumed as of this day
}

// Task 5.5: optional forecast layers, additive to the Task 2.1 MVP shape --
// every existing caller (Overview.tsx) passes no `forecast` prop, so its
// render is byte-for-byte unchanged (no new elements are mounted when it's
// undefined). `p50`/`p90` are expected to share the exact same `day`
// sequence index-for-index (packages/ui/src/lib/forecastDerive.ts's
// cycleForecastView constructs them that way, both prefixed with the same
// last-actual point) -- the P50-P90 band below zips them by index rather
// than re-matching by day value.
export interface BurndownForecastLayer {
  p50: BurndownPoint[];
  p90: BurndownPoint[];
  /** Day index (0 = cycle start) of the real persisted exhaustion marker; omit when no exhaustion falls within the charted cycle. */
  exhaustionDay?: number;
  /** Callout label for the exhaustion marker, e.g. "2026-06-29 · day 29". */
  exhaustionLabel?: string;
  /** Day index of the most-recent actual/settling day to hatch (design's "provisional" column); the hatched column spans [provisionalDay - 1, provisionalDay]. */
  provisionalDay?: number;
}

export interface BurndownChartProps {
  data: BurndownPoint[];
  daysInCycle: number;
  allowance: number;
  /** Task 5.5: P50 dashed line + P50-P90 band + exhaustion marker + provisional hatch. Omitted entirely for the Task 2.1 actual-only usages. */
  forecast?: BurndownForecastLayer;
}

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const RED = '#ff7b72';
const BLUE = '#8dd6ff';
const SUBTLE = '#a4aea6';
const INK = '#f0f6fc';

function formatK(value: number): string {
  return `${Math.round(value / 1000)}k`;
}

function xTicks(daysInCycle: number): number[] {
  const ticks: number[] = [];
  for (let d = 0; d <= daysInCycle; d += 5) ticks.push(d);
  return ticks;
}

// Recharts calls a Line's `label` render function once per rendered data
// point (component/LabelList.js: "called once for each individual label, so
// typically once for each data point") with `{viewBox: {x, y}, index, value}`
// already in pixel space -- rendering only on the LAST point gives the small
// tag at the line's terminus the design mock draws ('lp50'/'lp90' in
// design/Copilot Budget Manager v2.dc.html's renderBurndown). `totalPoints`
// is captured from the same array passed as the Line's own `data`, so no
// Recharts-internal point count needs to be inferred.
// `props` is typed `any` (matching Recharts' own `ImplicitLabelListType`
// function signature, which takes `any`) rather than a narrow object type --
// a narrower parameter type fails TS's contravariant function-parameter
// check against the wider `viewBox: ViewBox` (cartesian | polar) Recharts
// itself declares.
function makeTerminusLabel(testId: string, text: string, color: string, dy: number, totalPoints: number) {
  return (props: any) => {
    const viewBox = props?.viewBox as { x: number; y: number } | undefined;
    const index = props?.index as number | undefined;
    if (!viewBox || index !== totalPoints - 1) return null;
    return (
      <text
        data-testid={testId}
        x={viewBox.x}
        y={viewBox.y + dy}
        textAnchor="end"
        fill={color}
        fontSize={10}
        fontWeight={600}
        fontFamily={MONO_FONT}
      >
        {text}
      </text>
    );
  };
}

// ReferenceDot's `label` content function similarly receives
// `{viewBox: {x, y, width, height}}` -- the dot's own pixel bounding box
// (cartesian/ReferenceDot.js) -- centered here into a formatted-value tag per
// the maintainer's "dot markers show their point value" request. `dx`/`dy`/
// `anchor` let each dot pick an offset clear of the lines/bands that
// converge on it (see the build report for the placement reasoning).
function makeDotValueLabel(testId: string, value: number, dx: number, dy: number, anchor: 'start' | 'middle' | 'end') {
  return (props: any) => {
    const viewBox = props?.viewBox as { x: number; y: number; width: number; height: number } | undefined;
    if (!viewBox) return null;
    const cx = viewBox.x + viewBox.width / 2;
    const cy = viewBox.y + viewBox.height / 2;
    return (
      <text
        data-testid={testId}
        x={cx + dx}
        y={cy + dy}
        textAnchor={anchor}
        fill={INK}
        fontSize={10.5}
        fontWeight={600}
        fontFamily={MONO_FONT}
      >
        {formatK(value)}
      </text>
    );
  };
}

// Boxed exhaustion callout (design mock's 'exbg'/'ext1'/'ext2' kids): a small
// bordered card reading "Exhaustion" (red title) + the existing
// `exhaustionLabel` ("<date> · day <N>", mono) beneath, anchored to the
// exhaustion ReferenceLine. ReferenceLine's `label` content function
// receives `{viewBox: {x, y, height}}` of the LINE's own pixel geometry
// (cartesian/ReferenceLine.js) -- x is the line's pixel x, y/height are the
// plot area's top/height; there is no total-chart-width in this viewBox, so
// the design mock's own pixel clamp (`Math.min(ex+8, w-padR-140)`) isn't
// reproducible here. `flipLeft` is the geometry-free equivalent: when the
// exhaustion day falls in the last ~20% of the cycle (the DEWR enterprise
// case is day 28 of 30) the box is sided to the LEFT of the line instead of
// clamped, so it never runs past the chart's right edge.
function makeExhaustionCallout(label: string, flipLeft: boolean) {
  const boxWidth = 136;
  const boxHeight = 34;
  const gap = 8;
  return (props: any) => {
    const viewBox = props?.viewBox as { x: number; y: number; height: number } | undefined;
    if (!viewBox) return null;
    const boxX = flipLeft ? viewBox.x - gap - boxWidth : viewBox.x + gap;
    const boxY = viewBox.y + 6;
    return (
      <g data-testid="burndown-exhaustion-callout">
        <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx={6} fill="#0d1117" stroke="rgba(255,123,114,.5)" />
        <text x={boxX + 10} y={boxY + 15} fill={RED} fontSize={11} fontWeight={600}>
          Exhaustion
        </text>
        <text x={boxX + 10} y={boxY + 28} fill={SUBTLE} fontSize={11} fontFamily={MONO_FONT}>
          {label}
        </text>
      </g>
    );
  };
}

// Actual cumulative burn line always renders; the forecast P50/P90 band,
// exhaustion marker, and provisional hatch render only when `forecast` is
// supplied (Task 5.5, Forecast screen). The dashed allowance line stays for
// every caller: it's the cycle's pool ceiling (real, for MVP; possibly a
// hypothetical basis-toggle override, for Forecast), never a forecast itself.
export function BurndownChart({ data, daysInCycle, allowance, forecast }: BurndownChartProps) {
  const lastPoint = data.at(-1);
  const forecastMax = forecast ? Math.max(0, ...forecast.p90.map((p) => p.credits)) : 0;
  const maxCredits = Math.max(lastPoint?.credits ?? 0, forecastMax);
  const maxY = Math.max(allowance, maxCredits) * 1.12;

  // Exhaustion callout box side: see makeExhaustionCallout's doc comment --
  // no total-chart-pixel-width is available inside a ReferenceLine label
  // render function, so the box flips to the LEFT of the line (rather than
  // clamping) once the exhaustion day is past ~80% of the cycle, keeping it
  // on-chart for late-cycle exhaustions (e.g. the DEWR enterprise case, day
  // 28 of 30) without needing that pixel geometry.
  const exhaustionFlipLeft = forecast?.exhaustionDay !== undefined && forecast.exhaustionDay / daysInCycle > 0.8;

  // Stacked-area band recipe: an invisible base Area up to p50, then a
  // visible Area for (p90 - p50) stacked on top of it -- the standard
  // Recharts "band between two lines" construction.
  const bandData = forecast
    ? forecast.p50.map((p, i) => ({
        day: p.day,
        bandBase: p.credits,
        bandHeight: Math.max(0, (forecast.p90[i]?.credits ?? p.credits) - p.credits),
      }))
    : [];

  return (
    <div className="burndown-chart" data-testid="burndown-chart">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 12, right: 20, left: 4, bottom: 4 }}>
          {forecast && (
            <defs>
              <pattern id="burndown-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={6} height={6} fill="transparent" />
                <line x1={0} y1={0} x2={0} y2={6} stroke="#484f58" strokeWidth={1.4} />
              </pattern>
            </defs>
          )}
          <CartesianGrid stroke="#21262d" vertical={false} />
          <XAxis
            dataKey="day"
            type="number"
            domain={[0, daysInCycle]}
            ticks={xTicks(daysInCycle)}
            tick={{ fill: '#7c8980', fontSize: 10.5, fontFamily: MONO_FONT }}
            axisLine={{ stroke: '#21262d' }}
            tickLine={false}
          />
          <YAxis
            domain={[0, Math.ceil(maxY)]}
            tickFormatter={formatK}
            tick={{ fill: '#7c8980', fontSize: 10.5, fontFamily: MONO_FONT }}
            axisLine={false}
            tickLine={false}
            width={48}
          />

          {forecast?.exhaustionDay !== undefined && (
            <ReferenceArea
              x1={forecast.exhaustionDay}
              x2={daysInCycle}
              y1={0}
              y2={maxY}
              fill={RED}
              fillOpacity={0.09}
              stroke="none"
              ifOverflow="hidden"
              data-testid="burndown-exhaustion-zone"
            />
          )}

          {forecast?.provisionalDay !== undefined && (
            <ReferenceArea
              x1={Math.max(0, forecast.provisionalDay - 1)}
              x2={forecast.provisionalDay}
              y1={0}
              y2={maxY}
              fill="url(#burndown-hatch)"
              fillOpacity={0.5}
              stroke="none"
              ifOverflow="hidden"
            />
          )}

          <ReferenceLine
            y={allowance}
            stroke="#7c8980"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            label={{
              value: `allowance ${Math.round(allowance).toLocaleString('en-US')}`,
              position: 'insideTopLeft',
              fill: '#a4aea6',
              fontSize: 11,
              fontFamily: MONO_FONT,
            }}
          />

          {forecast && (
            <>
              <Area
                data={bandData}
                type="linear"
                dataKey="bandBase"
                stackId="band"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
              />
              <Area
                data={bandData}
                type="linear"
                dataKey="bandHeight"
                stackId="band"
                stroke="none"
                fill="#8dd6ff"
                fillOpacity={0.16}
                isAnimationActive={false}
                legendType="none"
                data-testid="burndown-band"
              />
              <Line
                data={forecast.p50}
                type="linear"
                dataKey="credits"
                name="Forecast P50"
                stroke="#8dd6ff"
                strokeWidth={2}
                strokeDasharray="6 5"
                dot={false}
                isAnimationActive={false}
                label={makeTerminusLabel('burndown-p50-label', 'P50', BLUE, -5, forecast.p50.length)}
              />
              {/* Invisible carrier line: reuses the p50 line's terminus-label
                  mechanism to tag the P90 band's upper edge, without drawing
                  a visible P90 stroke (the mock only fills the band, per
                  BurndownChart's own band recipe above). */}
              <Line
                data={forecast.p90}
                type="linear"
                dataKey="credits"
                name="Forecast P90"
                stroke="none"
                dot={false}
                isAnimationActive={false}
                legendType="none"
                label={makeTerminusLabel('burndown-p90-label', 'P90', SUBTLE, 14, forecast.p90.length)}
              />
            </>
          )}

          <Line
            type="linear"
            dataKey="credits"
            name="Actual burn"
            stroke="#f0f6fc"
            strokeWidth={2.6}
            dot={false}
            isAnimationActive={false}
          />

          {lastPoint ? (
            <ReferenceDot
              x={lastPoint.day}
              y={lastPoint.credits}
              r={4}
              fill="#f0f6fc"
              stroke="#0d1117"
              strokeWidth={2}
              // Value tag above-LEFT of the dot (dx -8, dy -8, anchor 'end'):
              // the actual line approaches from below-left and, when a
              // forecast is present, the dashed P50 line + band both start
              // fanning out to the upper-RIGHT from this exact point -- the
              // upper-left quadrant is the one quadrant clear of both.
              label={makeDotValueLabel('burndown-actual-dot-value', lastPoint.credits, -8, -8, 'end')}
            />
          ) : null}

          {forecast?.exhaustionDay !== undefined && (
            <>
              <ReferenceLine
                x={forecast.exhaustionDay}
                stroke={RED}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                // The old plain-text top label moves into the boxed callout
                // below (design mock's 'exbg'/'ext1'/'ext2'); the dot itself
                // gets its own value tag instead (next element).
                label={forecast.exhaustionLabel ? makeExhaustionCallout(forecast.exhaustionLabel, exhaustionFlipLeft) : undefined}
              />
              <ReferenceDot
                x={forecast.exhaustionDay}
                y={allowance}
                r={5}
                fill={RED}
                stroke="#0d1117"
                strokeWidth={2}
                data-testid="burndown-exhaustion-marker"
                // Value tag BELOW the dot (dy +14, anchor 'middle'): the
                // callout box sits near the plot's top edge, well clear of
                // this dot's y (always somewhat below the top given maxY's
                // 12% headroom over `allowance`), so placing below keeps it
                // clear of the box, the allowance line's own text (top-left),
                // and the red zone's left edge (the dot sits ON that edge).
                label={makeDotValueLabel('burndown-exhaustion-dot-value', allowance, 0, 14, 'middle')}
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
