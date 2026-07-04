import './RunwayTile.css';

export type RunwayTileTone = 'default' | 'green' | 'amber' | 'red';

export interface RunwayTileProps {
  label: string;
  value: string;
  sub: string;
  tone?: RunwayTileTone;
}

const TONE_VAR: Record<RunwayTileTone, string> = {
  default: 'var(--ink)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
};

export function RunwayTile({ label, value, sub, tone = 'default' }: RunwayTileProps) {
  return (
    <div className="runway-tile">
      <div className="runway-tile__label">{label}</div>
      <div className="runway-tile__value" style={{ color: TONE_VAR[tone] }}>
        {value}
      </div>
      <div className="runway-tile__sub">{sub}</div>
    </div>
  );
}
