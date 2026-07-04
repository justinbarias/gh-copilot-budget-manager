import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import './BurndownChart.css';

export interface BurndownPoint {
  day: number; // days elapsed since cycle start (0 = cycle start)
  credits: number; // cumulative pool-phase credits consumed as of this day
}

export interface BurndownChartProps {
  data: BurndownPoint[];
  daysInCycle: number;
  allowance: number;
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

// Actual cumulative burn line only -- no forecast P50/P10-P90 band and no
// exhaustion marker (those are Phase 4, SPEC.md Assumption 3). The dashed
// allowance line stays: it's the actual cycle's pool ceiling, not a forecast.
export function BurndownChart({ data, daysInCycle, allowance }: BurndownChartProps) {
  const lastPoint = data.at(-1);
  const maxCredits = lastPoint?.credits ?? 0;
  const maxY = Math.max(allowance, maxCredits) * 1.12;

  return (
    <div className="burndown-chart" data-testid="burndown-chart">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 12, right: 20, left: 4, bottom: 4 }}>
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
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
