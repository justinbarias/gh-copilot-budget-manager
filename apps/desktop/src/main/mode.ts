import { ipcMain } from 'electron';
import { resolveMode, formatModeLogLine, type AppMode } from '@copilot-budget/data/pat';
import { getAppModeSetting } from '@copilot-budget/data/db';
import { getPatStore } from './pat-bridge';
import { getDb } from './db';

// Task 9.3-lite: the COPILOT_BUDGET_FORCE_SIMULATION env seam is RETIRED. Mode
// now resolves from the persisted in-app SELECTION (app_settings 'app_mode',
// set via Settings -> Mode, default 'simulation') AND PAT presence: live only
// when the selection is 'live' AND a PAT is stored (resolveMode). Changing the
// selection does NOT re-resolve the running process -- resolution happens at
// boot; the Settings card says "restart to apply".

// Boot mode diagnostic (item B, kept through 9.3-lite): one main-process log
// line -- the resolved mode, the RAW persisted selection as read (quoted
// verbatim; a fresh DB reads the literal "simulation" default), and whether a
// PAT was present at resolution (NEVER the token). De-duplicated on content:
// repeated identical resolutions (the renderer polls mode:get) stay quiet; the
// line re-logs only if what it would say changes.
let lastModeLogLine: string | null = null;

export async function getMode(): Promise<AppMode> {
  const patPresent = (await getPatStore().get()) !== null;
  // getDb() is the same lazily-constructed, migration-run DB every other
  // main-process consumer shares; getAppModeSetting reads the 'app_mode' KV
  // row (defaulting to 'simulation' when unset/unrecognized).
  const appModeSetting = () => getAppModeSetting(getDb());
  const mode = await resolveMode({ patStore: getPatStore(), appModeSetting });
  const line = formatModeLogLine(mode, getAppModeSetting(getDb()), patPresent);
  if (line !== lastModeLogLine) {
    console.log(line);
    lastModeLogLine = line;
  }
  return mode;
}

export function registerModeIpcHandler(): void {
  ipcMain.handle('mode:get', async () => getMode());
}
