import type { PatStore } from './storage.js';

export type AppMode = 'simulation' | 'live';

export interface ModeResolverDeps {
  patStore: Pick<PatStore, 'get'>;
  /**
   * Task 9.3-lite: the persisted in-app mode SELECTION (app_settings
   * 'app_mode', Settings screen's mode card) -- this RETIRED the
   * COPILOT_BUDGET_FORCE_SIMULATION env-var seam (the Task 1.7 stale-seam
   * note is resolved). Injected (not read here) so the resolver stays pure
   * and the desktop main supplies the DB-backed value.
   */
  appModeSetting: () => Promise<AppMode> | AppMode;
}

// CLAUDE.md §7: "PAT present + simulation off -> live GitHub; simulation on
// (or no PAT) -> MSW." Resolution rule (Task 9.3-lite, maintainer-locked):
// the persisted selection must be 'live' AND a PAT must be stored -> live;
// everything else -> simulation. A 'live' selection with no PAT resolves
// simulation (never a broken live), and the Settings card explains why.
export async function resolveMode(deps: ModeResolverDeps): Promise<AppMode> {
  const setting = await deps.appModeSetting();
  if (setting !== 'live') return 'simulation';
  const pat = await deps.patStore.get();
  return pat !== null ? 'live' : 'simulation';
}

/**
 * The one-line boot diagnostic (item B, kept through 9.3-lite with the env
 * field swapped for the persisted setting): resolved mode, the RAW persisted
 * selection as read (quoted verbatim -- a fresh DB reads the literal
 * "simulation" default), and PAT presence (NEVER the token). Composed here
 * (not in the Electron main) so its exact shape is unit-testable.
 */
export function formatModeLogLine(mode: AppMode, appModeSetting: string, patPresent: boolean): string {
  return `[mode] resolved=${mode} app_mode_setting=${JSON.stringify(String(appModeSetting))} pat_present=${patPresent}`;
}
