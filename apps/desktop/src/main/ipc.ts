import { ipcMain } from 'electron';
import { createGitHubApiClient } from '@copilot-budget/data/api-client';
import type { ApiClient, ApplyPlanInput, ControlState, Plan, UsageSummaryParams } from '@copilot-budget/data';
import { getDb } from './db';

// TODO: enterprise slug + baseUrl (the GHE.com host swap) should come from real
// org configuration once CLAUDE.md §9's open questions are answered (Task 1.7
// Settings screen). Hardcoded to match the MSW fixture enterprise until then —
// simulation is forced by default (see main/mode.ts), so today this client only
// ever talks to MSW, never real GitHub.
const ENTERPRISE_SLUG = 'dewr';

let apiClient: ApiClient | undefined;

function getApiClient(source: 'msw' | 'github'): ApiClient {
  if (!apiClient) {
    apiClient = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db: getDb(), source });
  }
  return apiClient;
}

export function registerApiClientIpcHandlers(source: 'msw' | 'github'): void {
  const client = getApiClient(source);

  ipcMain.handle('apiClient:getUsageSummary', (_event, params?: UsageSummaryParams) =>
    client.getUsageSummary(params),
  );
  ipcMain.handle('apiClient:listCostCenters', () => client.listCostCenters());
  ipcMain.handle('apiClient:listHeavyUsers', () => client.listHeavyUsers());
  ipcMain.handle('apiClient:listAlerts', () => client.listAlerts());
  ipcMain.handle('apiClient:getSyncStatus', () => client.getSyncStatus());
  ipcMain.handle('apiClient:syncNow', () => client.syncNow());
  ipcMain.handle('apiClient:getControls', () => client.getControls());
  ipcMain.handle('apiClient:getLastSyncedControls', () => client.getLastSyncedControls());
  ipcMain.handle('apiClient:dryRunPlan', (_event, desiredControls: readonly ControlState[], justification?: string | null) =>
    client.dryRunPlan(desiredControls, justification),
  );
  ipcMain.handle(
    'apiClient:applyPlan',
    (_event, stagedPlan: Plan, desiredControls: readonly ControlState[], input: ApplyPlanInput) =>
      client.applyPlan(stagedPlan, desiredControls, input),
  );
}
