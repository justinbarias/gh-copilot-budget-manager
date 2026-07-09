import path from 'node:path';
import { app, ipcMain } from 'electron';
import { createGitHubApiClient, setWriteArmed } from '@copilot-budget/data/api-client';
import { createTenantConfigStore, resolveBaseUrl } from '@copilot-budget/data/tenant';
import type { ApiClient, ApplyPlanInput, ControlState, CostCenterMappingInput, ForecastScope, Plan, ScenarioId, TenantConfig, UsageSummaryParams, WriteArmingRequest } from '@copilot-budget/data';
import type { TenantConfigStore } from '@copilot-budget/data/tenant';
import type { PatStore } from '@copilot-budget/data/pat';
import { getDb } from './db';
import { getPatStore } from './pat-bridge';

// Simulation-mode enterprise slug (the DEWR fixture world). In LIVE mode the
// slug + baseUrl come from the persisted tenant config instead (Task 9.1) --
// see the resolution in buildClient below. Simulation is forced by default
// (main/mode.ts), so today this only ever talks to MSW.
const SIM_ENTERPRISE_SLUG = 'dewr';

// Non-secret tenant pointer, persisted as plain JSON under userData (NOT
// safeStorage -- it carries no secret; the PAT stays in pat.enc). Same
// per-file, lazily-constructed pattern as getPatStore.
export function getTenantConfigStore() {
  return createTenantConfigStore(path.join(app.getPath('userData'), 'tenant-config.json'));
}

// Live-mode bug fix (2026-07-08 smoke, R1-R5): builds a FRESH ApiClient from
// whatever is CURRENTLY persisted -- the stored PAT (`auth`) and the tenant
// pointer (enterprise/baseUrl) -- rather than reading either once at app
// boot. Previously `auth` was never passed at all (the client was always
// unauthenticated in live mode; only validatePat's dedicated probe read the
// live PAT), and enterprise/baseUrl were resolved exactly once at
// registration, so a tenant config saved mid-session never took effect. Both
// are now re-derived on every (re)build. Simulation mode's world never needs
// a PAT or a tenant pointer -- MSW ignores `auth` and always answers the
// fixture enterprise -- so this is safe to call unconditionally.
async function buildClient(
  source: 'msw' | 'github',
  tenantStore: TenantConfigStore,
  patStore: PatStore,
): Promise<ApiClient> {
  let enterprise = SIM_ENTERPRISE_SLUG;
  let baseUrl: string | undefined;
  if (source === 'github') {
    const cfg = await tenantStore.get();
    if (cfg) {
      enterprise = cfg.enterpriseSlug;
      baseUrl = resolveBaseUrl(cfg);
    }
  }

  // The CURRENT stored PAT, read fresh on every (re)build -- construction-time
  // staleness was exactly the bug (validatePat's separate probe already read
  // the live PAT via `getPat`; the main request-issuing client did not).
  // Simulation never authenticates, matching prior byte-identical behavior.
  const auth = source === 'github' ? ((await patStore.get()) ?? undefined) : undefined;

  return createGitHubApiClient({
    enterprise,
    db: getDb(),
    source,
    baseUrl,
    auth,
    tenantConfig: tenantStore,
    // main-process-only PAT read for validatePat's probe -- the plaintext
    // never leaves the main process (§6.6); only the classification result
    // crosses to the renderer.
    getPat: () => patStore.get(),
  });
}

export interface ApiClientHandlerHandle {
  /**
   * Rebuilds the routed-to ApiClient from the currently persisted PAT +
   * tenant config. Call after any successful PAT or tenant-config mutation
   * (pat:set, pat:clear, apiClient:setTenantConfig) so live requests never
   * run against stale credentials or a stale enterprise/baseUrl. A no-op in
   * simulation mode (MSW never authenticates and always serves the fixture
   * enterprise, so there is nothing to re-derive).
   */
  rebuildClient: () => Promise<void>;
}

export async function registerApiClientIpcHandlers(source: 'msw' | 'github'): Promise<ApiClientHandlerHandle> {
  const tenantStore = getTenantConfigStore();
  const patStore = getPatStore();

  // Mutable reference every handler below routes through by closing over
  // this binding (not a copy of it) -- reassigning `client` is a single,
  // synchronous statement, and Node's single-threaded event loop means no
  // handler can observe a "half-built" client: either the previous client is
  // still current, or `client` already points at the fully-constructed new
  // one. rebuildClient is awaited to completion before any mutation handler
  // (pat:set/pat:clear/setTenantConfig) resolves, so from the renderer's
  // perspective "save token" / "save tenant" atomically includes "the next
  // read uses it."
  let client: ApiClient = await buildClient(source, tenantStore, patStore);

  async function rebuildClient(): Promise<void> {
    // Item B (boot mode diagnostic): both branches log what the rebuild did
    // AND state the known papercut explicitly -- MODE DOES NOT RE-RESOLVE
    // mid-session. `source` was fixed when this process resolved its mode at
    // boot; saving/clearing a PAT rebuilds the client's credentials, never
    // the mode. Task 9.3's charter, not this log's.
    if (source === 'msw') {
      console.log(
        '[mode] credentials/tenant changed: ApiClient rebuild SKIPPED (simulation source) — mode does NOT re-resolve until relaunch, so a newly saved PAT only takes effect as live after restarting the app.',
      );
      return; // sim mode: no auth/tenant to re-derive.
    }
    client = await buildClient(source, tenantStore, patStore);
    // Task 9.3-lite §6.8 (defense in depth): a PAT or tenant change must force
    // re-arming -- the newly credentialed client points at potentially
    // different real budgets/caps, so any prior arming is void. Live writes
    // stay disarmed until the admin explicitly re-arms in Settings.
    setWriteArmed(false);
    console.log(
      '[mode] credentials/tenant changed: live ApiClient REBUILT with the currently persisted PAT + tenant config — live writes disarmed — re-arm required — mode itself does NOT re-resolve until relaunch.',
    );
  }

  ipcMain.handle('apiClient:getUsageSummary', (_event, params?: UsageSummaryParams) =>
    client.getUsageSummary(params),
  );
  ipcMain.handle('apiClient:listCostCenters', () => client.listCostCenters());
  // App-local DEWR mapping edit (maintainer-sanctioned, 2026-07-09): a local
  // DB metadata write -- never a GitHub request (safe pre-9.3, both modes).
  ipcMain.handle('apiClient:updateCostCenterMapping', (_event, costCenterId: string, mapping: CostCenterMappingInput) =>
    client.updateCostCenterMapping(costCenterId, mapping),
  );
  // Task 9.3-lite: the persisted mode selection + live-write arming. Same
  // per-method channel pattern as every other bridged method.
  ipcMain.handle('apiClient:getAppModeSetting', () => client.getAppModeSetting());
  ipcMain.handle('apiClient:setAppModeSetting', (_event, mode: 'simulation' | 'live') =>
    client.setAppModeSetting(mode),
  );
  ipcMain.handle('apiClient:getWriteArmingState', () => client.getWriteArmingState());
  ipcMain.handle('apiClient:setWriteArming', (_event, request: WriteArmingRequest) =>
    client.setWriteArming(request),
  );
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
  // Tenant pointer changes affect enterprise/baseUrl -- rebuild so a
  // mid-session save takes effect on the very next request, not just at the
  // next app launch (this was the second half of the live-mode bug: a saved
  // tenant config never took effect because the client was built once at
  // registration).
  ipcMain.handle('apiClient:setTenantConfig', async (_event, config: TenantConfig) => {
    await client.setTenantConfig(config);
    await rebuildClient();
  });
  ipcMain.handle('apiClient:validatePat', () => client.validatePat());
  ipcMain.handle('apiClient:runLiveReadSmoke', () => client.runLiveReadSmoke());
  ipcMain.handle('apiClient:listScenarios', () => client.listScenarios());
  ipcMain.handle('apiClient:getActiveScenario', () => client.getActiveScenario());
  ipcMain.handle('apiClient:setScenario', (_event, id: ScenarioId) => client.setScenario(id));
  // Task 6.8: the Auto-balance screen's read-only context assembly (sim-only;
  // the client refuses in live mode). Same per-method channel pattern as above.
  ipcMain.handle('apiClient:getRebalanceContext', (_event, mode: 'pool' | 'metered') =>
    client.getRebalanceContext(mode),
  );

  return { rebuildClient };
}
