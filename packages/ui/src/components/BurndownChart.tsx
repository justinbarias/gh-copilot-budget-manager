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

function formatK(value: number): string {
  return `${Math.round(value / 1000)}k`;
}

function xTicks(daysInCycle: number): number[] {
  const ticks: number[] = [];
  for (let d = 0; d <= daysInCycle; d += 5) ticks.push(d);
  return ticks;
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
            <ReferenceDot x={lastPoint.day} y={lastPoint.credits} r={4} fill="#f0f6fc" stroke="#0d1117" strokeWidth={2} />
          ) : null}

          {forecast?.exhaustionDay !== undefined && (
            <>
              <ReferenceLine x={forecast.exhaustionDay} stroke="#ff7b72" strokeWidth={1.5} strokeDasharray="3 3" />
              <ReferenceDot
                x={forecast.exhaustionDay}
                y={allowance}
                r={5}
                fill="#ff7b72"
                stroke="#0d1117"
                strokeWidth={2}
                label={
                  forecast.exhaustionLabel
                    ? {
                        value: forecast.exhaustionLabel,
                        position: 'top',
                        fill: '#ff7b72',
                        fontSize: 11,
                        fontFamily: MONO_FONT,
                      }
                    : undefined
                }
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
