import type { ModelMix } from '@copilot-budget/core';
import './ModelMixBar.css';

export interface ModelMixBarProps {
  mix: ModelMix;
}

// Prototype-specific shades (design/*.dc.html's renderMixBar) for the two
// named models beyond the shared --blue token; not part of the global token
// set (design/README.md's tokens only list --blue for "GPT-5.4") since
// they're used nowhere else in the app.
const MODEL_COLOR: Record<string, string> = {
  'GPT-5.4': 'var(--blue)',
  'Sonnet 4.6': '#5a9fd4',
  'GPT-5 mini': '#3f5a6b',
};
const FALLBACK_MODEL_COLOR = '#6e7681';
// var(--hairline) in the design prototype's own renderMixBar (#484f58).
const UNATTRIBUTABLE_COLOR = 'var(--hairline)';

export function ModelMixBar({ mix }: ModelMixBarProps) {
  // No usage this cycle -- packages/data returns an empty mix for these users
  // (see HeavyUser.dailySeries' parallel "empty means no usage" convention).
  if (mix.segments.length === 0 && mix.unattributablePct === 0) {
    return (
      <span className="model-mix-bar model-mix-bar--empty" aria-label="No credit usage this cycle">
        —
      </span>
    );
  }

  const top = mix.segments[0];
  // Never color-only (design/README.md accessibility intent): the caption
  // spells out the leading model and the unattributable share in text,
  // mirroring the prototype's own caption exactly.
  const caption = top
    ? `${top.model} ${top.pct}% · ${mix.unattributablePct}% unattr`
    : `${mix.unattributablePct}% unattr`;
  const tooltip = mix.segments
    .map((s) => `${s.model} ${s.pct}%`)
    .concat(`unattributable ${mix.unattributablePct}%`)
    .join(' · ');

  return (
    <div className="model-mix-bar" title={tooltip}>
      <div className="model-mix-bar__track">
        {mix.segments.map((segment) => (
          <div
            key={segment.model}
            className="model-mix-bar__segment"
            style={{ width: `${segment.pct}%`, background: MODEL_COLOR[segment.model] ?? FALLBACK_MODEL_COLOR }}
            title={`${segment.model} · ${segment.pct}%`}
          />
        ))}
        {mix.unattributablePct > 0 && (
          <div
            className="model-mix-bar__segment"
            style={{ width: `${mix.unattributablePct}%`, background: UNATTRIBUTABLE_COLOR }}
            title={`unattributable · ${mix.unattributablePct}%`}
          />
        )}
      </div>
      <div className="model-mix-bar__caption mono">{caption}</div>
    </div>
  );
}
