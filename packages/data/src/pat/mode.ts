import type { PatStore } from './storage.js';

export type AppMode = 'simulation' | 'live';

export interface ModeResolverDeps {
  patStore: Pick<PatStore, 'get'>;
  simulationForced: () => boolean;
}

// CLAUDE.md §7: "PAT present + simulation off -> live GitHub; simulation on
// (or no PAT) -> MSW." No real PAT/tenant exists yet (CLAUDE.md §9), so the
// live branch stays wired but dormant until simulationForced's real source
// (a persisted user setting, added in Task 1.7) can actually be turned off.
export async function resolveMode(deps: ModeResolverDeps): Promise<AppMode> {
  if (deps.simulationForced()) return 'simulation';
  const pat = await deps.patStore.get();
  return pat !== null ? 'live' : 'simulation';
}
