import type { ScenarioId, ScenarioSummary } from '@copilot-budget/data';
import './ScenarioSelector.css';

// Task 6.7: the SIMULATION-ONLY demo-scenario switch (design handoff top-bar).
// Rendered ONLY in simulation mode (App gates on api.getMode() === 'simulation'
// + a non-refused listScenarios), so it is absent the moment a live PAT is
// configured. Deliberately styled in the sim banner's violet language and
// prefixed with a "◆ SIM" tag (CLAUDE.md §6.8 unmistakability): it must read as
// a simulation affordance, never a normal in-app control that moves real money.
interface ScenarioSelectorProps {
  scenarios: readonly ScenarioSummary[];
  activeId: ScenarioId;
  onSelect: (id: ScenarioId) => void;
  busy?: boolean;
}

export function ScenarioSelector({ scenarios, activeId, onSelect, busy }: ScenarioSelectorProps) {
  return (
    <div className="scenario-selector" role="group" aria-label="Simulation scenario">
      <span className="scenario-selector__tag" aria-hidden="true">
        <span className="scenario-selector__glyph">◆</span> SIM SCENARIO
      </span>
      <div className="scenario-selector__seg" data-testid="scenario-selector">
        {scenarios.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              type="button"
              className={active ? 'scenario-selector__opt scenario-selector__opt--active' : 'scenario-selector__opt'}
              aria-pressed={active}
              title={s.description}
              disabled={busy}
              onClick={() => onSelect(s.id)}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
