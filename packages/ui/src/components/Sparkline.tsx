import './Sparkline.css';

export interface SparklinePoint {
  date: string;
  creditsUsed: number;
}

export interface SparklineProps {
  points: SparklinePoint[];
  color?: string;
}

// Hand-rolled inline SVG (design/README.md's Signature components: "small
// inline SVGs in the Users table" -- no charting lib for this one). Math
// mirrors the design prototype's renderSparkline: a 64x22 viewbox, min/max
// normalized, a single polyline plus an end-dot.
const WIDTH = 64;
const HEIGHT = 22;
const PADDING = 2;

export function Sparkline({ points, color }: SparklineProps) {
  // Empty means "no usage yet this cycle" (packages/data's dailySeries is
  // empty, not zero-filled, for those users) -- render the design's "—"
  // placeholder instead of a meaningless flat line.
  if (points.length === 0) {
    return (
      <span className="sparkline sparkline--empty" aria-label="No credit usage this cycle">
        —
      </span>
    );
  }

  const values = points.map((p) => p.creditsUsed);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stroke = color ?? 'var(--blue)';

  const coords = values.map((v, i) => {
    const x = points.length === 1 ? PADDING : PADDING + (i / (points.length - 1)) * (WIDTH - PADDING * 2);
    const y = HEIGHT - PADDING - ((v - min) / range) * (HEIGHT - PADDING * 2);
    return [x, y] as const;
  });

  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1]!;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={`Credit usage trend this cycle, ${values.at(-1)} credits on the most recent day`}
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2} fill={stroke} />
    </svg>
  );
}
