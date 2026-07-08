import { ipcMain } from 'electron';
import { resolveMode, type AppMode } from '@copilot-budget/data/pat';
import { getPatStore } from './pat-bridge';

// No real PAT/tenant exists yet (CLAUDE.md §9), so MVP forces simulation
// unless this is explicitly disabled -- keeps the live branch wired but
// dormant until a persisted user-facing toggle (Task 1.7) replaces this.
function simulationForced(): boolean {
  return process.env.COPILOT_BUDGET_FORCE_SIMULATION !== '0';
}

// Item B (boot mode diagnostic, 2026-07-09): the maintainer's recurring
// "sim banner despite dev:live" complaint has no confirmed root cause yet --
// this ONE main-process log line IS the diagnostic: the resolved mode, the
// RAW env value exactly as this process saw it (quoted verbatim, including
// the literal "undefined" when unset -- distinguishing "env never reached the
// Electron process" from "env set to the wrong value"), and whether a PAT was
// present at resolution (NEVER the token). De-duplicated on content: repeated
// identical resolutions (the renderer polls mode:get) stay quiet; the line
// re-logs only if what it would say changes.
let lastModeLogLine: string | null = null;

export async function getMode(): Promise<AppMode> {
  const patPresent = (await getPatStore().get()) !== null;
  const mode = await resolveMode({ patStore: getPatStore(), simulationForced });
  const rawEnv = process.env.COPILOT_BUDGET_FORCE_SIMULATION;
  const line = `[mode] resolved=${mode} force_simulation_env=${JSON.stringify(String(rawEnv))} pat_present=${patPresent}`;
  if (line !== lastModeLogLine) {
    console.log(line);
    lastModeLogLine = line;
  }
  return mode;
}

export function registerModeIpcHandler(): void {
  ipcMain.handle('mode:get', async () => getMode());
}
