// ============================================================================
// Task 6.7 -- simulation-mode SCENARIO STATE (the mechanism, no fixture data).
//
// A scenario is one of the design's demo states (Healthy / At risk / Surplus /
// Metered). Selecting one re-seeds the MSW mock (getActiveFixtures, in
// fixtures/scenarios.ts) AND re-anchors the simulation clock to that scenario's
// own `asOfDate` (resolveClockDate reads getActiveAsOfDate below). This module
// holds ONLY the id + metadata + the mutable active-id pointer -- deliberately
// NO fixture arrays -- so the clock seam (api-client/clock.ts) can import the
// active date without pulling the whole DEWR dataset into the api-client bundle.
//
// STATE OWNERSHIP & RESET SEMANTICS (ratified 2026-07-07):
//   - The active scenario is a single module-level mutable id, IN-MEMORY only.
//     There is NO persistence and NO migration: a relaunch (fresh Electron /
//     fresh vitest worker) re-initialises to DEFAULT_SCENARIO_ID = 'healthy'.
//   - 'healthy' is BYTE-IDENTICAL to the pre-6.7 DEWR world: its fixtures are
//     the exact committed arrays and its asOfDate === SIM_CURRENT_DATE, so every
//     existing e2e/data test (none of which ever calls setScenario) boots on it
//     and sees the historical behaviour unchanged.
//   - Tests that DO switch scenarios must call resetActiveScenario() in an
//     afterEach so state never leaks across tests (mirrors MSW's own
//     server.resetHandlers() convention).
// ============================================================================

/** The four demo states (design handoff §4). 'healthy' is the boot default. */
export type ScenarioId = 'healthy' | 'at-risk' | 'surplus' | 'metered';

export const DEFAULT_SCENARIO_ID: ScenarioId = 'healthy';

/**
 * The renderer-facing scenario descriptor (crosses the ApiClient bridge). All
 * fields are derived, deterministic, and fixture-anchored -- never wall-clock.
 */
export interface ScenarioSummary {
  readonly id: ScenarioId;
  readonly label: string;
  readonly description: string;
  /** The scenario's simulation "now" (YYYY-MM-DD) -- drives resolveClockDate('msw'). */
  readonly asOfDate: string;
  /** Which rebalancer this scenario exercises (governs the Auto-balance mode). */
  readonly phase: 'pool' | 'metered';
  /** Whether that rebalancer's trigger fires on this scenario (engine-proven). */
  readonly triggerFired: boolean;
  /**
   * The nav Auto-balance badge count = the firing trigger's at-risk entity
   * count, or 0 when the trigger does NOT fire (nothing for auto-balance to do).
   * Engine-verified in scenarios.engine.test.ts against the actual core engine's
   * `trigger.atRiskCount`, so this metadata can never silently drift from it.
   */
  readonly atRiskCount: number;
}

// Ordered for the segmented selector (design's left-to-right demo progression:
// calm -> crisis -> waste -> metered). asOfDates: 'healthy' keeps the historical
// SIM_CURRENT_DATE (2026-06-14, day 13/30 -- too early for the near-cycle-end
// trigger, so nothing fires); the three alternates jump to day 26/30
// (2026-06-27) where the pool trigger's near-cycle-end window is open.
export const SCENARIO_SUMMARIES: readonly ScenarioSummary[] = [
  {
    id: 'healthy',
    label: 'Healthy',
    description: 'On-pace mid-cycle (day 13/30). No auto-balance trigger fires.',
    asOfDate: '2026-06-14',
    phase: 'pool',
    triggerFired: false,
    atRiskCount: 0,
  },
  {
    id: 'at-risk',
    label: 'At risk',
    description: 'Day 26/30, pool under-consumed with a blocked cohort + a cap-bound team — the pool rebalancer fires.',
    asOfDate: '2026-06-27',
    phase: 'pool',
    triggerFired: true,
    atRiskCount: 17,
  },
  {
    id: 'surplus',
    label: 'Surplus',
    description: 'Day 26/30, drastic under-consumption with a tiny throttled cohort — the pool rebalancer fires and funds them in full with enormous slack left over.',
    asOfDate: '2026-06-27',
    phase: 'pool',
    triggerFired: true,
    atRiskCount: 4,
  },
  {
    id: 'metered',
    label: 'Metered',
    description: 'Metered phase active: a hard-stop cost-center budget at its cap with enterprise headroom — the metered rebalancer fires.',
    asOfDate: '2026-06-27',
    phase: 'metered',
    triggerFired: true,
    atRiskCount: 2,
  },
];

const SUMMARY_BY_ID = new Map<ScenarioId, ScenarioSummary>(SCENARIO_SUMMARIES.map((s) => [s.id, s]));

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && SUMMARY_BY_ID.has(value as ScenarioId);
}

// ---------------------------------------------------------------------------
// The one mutable pointer (in-memory; reset on relaunch).
// ---------------------------------------------------------------------------
let activeScenarioId: ScenarioId = DEFAULT_SCENARIO_ID;

export function getActiveScenarioId(): ScenarioId {
  return activeScenarioId;
}

/** Set the active scenario. Throws on an unknown id (callers validate first). */
export function setActiveScenarioId(id: ScenarioId): ScenarioSummary {
  if (!isScenarioId(id)) throw new Error(`unknown scenario id: ${String(id)}`);
  activeScenarioId = id;
  return SUMMARY_BY_ID.get(id)!;
}

/** Restore the boot default. Tests call this in afterEach so state never leaks. */
export function resetActiveScenario(): void {
  activeScenarioId = DEFAULT_SCENARIO_ID;
}

export function getActiveScenarioSummary(): ScenarioSummary {
  return SUMMARY_BY_ID.get(activeScenarioId)!;
}

export function listScenarioSummaries(): readonly ScenarioSummary[] {
  return SCENARIO_SUMMARIES;
}

/** The active scenario's simulation "now" (YYYY-MM-DD) -- the clock seam reads this. */
export function getActiveAsOfDate(): string {
  return SUMMARY_BY_ID.get(activeScenarioId)!.asOfDate;
}
