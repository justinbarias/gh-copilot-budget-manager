import { ipcMain } from 'electron';
import { resolveMode, type AppMode } from '@copilot-budget/data/pat';
import { getPatStore } from './pat-bridge';

// No real PAT/tenant exists yet (CLAUDE.md §9), so MVP forces simulation
// unless this is explicitly disabled -- keeps the live branch wired but
// dormant until a persisted user-facing toggle (Task 1.7) replaces this.
function simulationForced(): boolean {
  return process.env.COPILOT_BUDGET_FORCE_SIMULATION !== '0';
}

export async function getMode(): Promise<AppMode> {
  return resolveMode({ patStore: getPatStore(), simulationForced });
}

export function registerModeIpcHandler(): void {
  ipcMain.handle('mode:get', async () => getMode());
}
