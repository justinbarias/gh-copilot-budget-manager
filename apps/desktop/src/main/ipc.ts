import path from 'node:path';
import { app, ipcMain } from 'electron';
import { createGitHubApiClient } from '@copilot-budget/data/api-client';
import { createTenantConfigStore, resolveBaseUrl } from '@copilot-budget/data/tenant';
import type { ApiClient, ApplyPlanInput, ControlState, ForecastScope, Plan, TenantConfig, UsageSummaryParams } from '@copilot-budget/data';
import { getDb } from './db';
import { getPatStore } from './pat-bridge';

// Simulation-mode enterprise slug (the DEWR fixture world). In LIVE mode the
// slug + baseUrl come from the persisted tenant config instead (Task 9.1) --
// see the resolution in registerApiClientIpcHandlers below. Simulation is
// forced by default (main/mode.ts), so today this only ever talks to MSW.
const SIM_ENTERPRISE_SLUG = 'dewr';

// Non-secret tenant pointer, persisted as plain JSON under userData (NOT
// safeStorage -- it carries no secret; the PAT stays in pat.enc). Same
// per-file, lazily-constructed pattern as getPatStore.
export function getTenantConfigStore() {
  return createTenantConfigStore(path.join(app.getPath('userData'), 'tenant-config.json'));
}

export async function registerApiClientIpcHandlers(source: 'msw' | 'github'): Promise<void> {
  const tenantStore = getTenantConfigStore();
  const patStore = getPatStore();

  // Live mode derives enterprise + baseUrl from the configured tenant pointer
  // (spec §2's github.com vs api.SUBDOMAIN.ghe.com host swap). Simulation keeps
  // the fixture slug + default host (MSW intercepts api.github.com).
  let enterprise = SIM_ENTERPRISE_SLUG;
  let baseUrl: string | undefined;
  if (source === 'github') {
    const cfg = await tenantStore.get();
    if (cfg) {
      enterprise = cfg.enterpriseSlug;
      baseUrl = resolveBaseUrl(cfg);
    }
  }

  const client: ApiClient = createGitHubApiClient({
    enterprise,
    db: getDb(),
    source,
    baseUrl,
    tenantConfig: tenantStore,
    // main-process-only PAT read for validatePat -- the plaintext never leaves
    // the main process (§6.6); only the classification result crosses to the
    // renderer.
    getPat: () => patStore.get(),
  });

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
  ipcMain.handle('apiClient:getForecast', (_event, scope: ForecastScope, entityId?: string) =>
    client.getForecast(scope, entityId),
  );
  ipcMain.handle('apiClient:dryRunPlan', (_event, desiredControls: readonly ControlState[], justification?: string | null) =>
    client.dryRunPlan(desiredControls, justification),
  );
  ipcMain.handle(
    'apiClient:applyPlan',
    (_event, stagedPlan: Plan, desiredControls: readonly ControlState[], input: ApplyPlanInput) =>
      client.applyPlan(stagedPlan, desiredControls, input),
  );
  ipcMain.handle('apiClient:getAuditChain', () => client.getAuditChain());
  ipcMain.handle('apiClient:verifyAuditChain', () => client.verifyAuditChain());
  ipcMain.handle('apiClient:getTenantConfig', () => client.getTenantConfig());
  ipcMain.handle('apiClient:setTenantConfig', (_event, config: TenantConfig) => client.setTenantConfig(config));
  ipcMain.handle('apiClient:validatePat', () => client.validatePat());
  ipcMain.handle('apiClient:runLiveReadSmoke', () => client.runLiveReadSmoke());
}
