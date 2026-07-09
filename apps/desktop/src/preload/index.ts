import { contextBridge, ipcRenderer } from 'electron';
import type { ApiClient } from '@copilot-budget/data';

// Typing this object as ApiClient means the compiler enforces that every
// interface method is bridged, with the right signature, per-method channel
// (never a generic invoke(name, ...args) dispatcher that would hand the
// renderer arbitrary IPC access).
const apiClientBridge: ApiClient = {
  getUsageSummary: (params) => ipcRenderer.invoke('apiClient:getUsageSummary', params),
  listCostCenters: () => ipcRenderer.invoke('apiClient:listCostCenters'),
  updateCostCenterMapping: (costCenterId, mapping) =>
    ipcRenderer.invoke('apiClient:updateCostCenterMapping', costCenterId, mapping),
  listHeavyUsers: () => ipcRenderer.invoke('apiClient:listHeavyUsers'),
  listAlerts: () => ipcRenderer.invoke('apiClient:listAlerts'),
  getSyncStatus: () => ipcRenderer.invoke('apiClient:getSyncStatus'),
  syncNow: () => ipcRenderer.invoke('apiClient:syncNow'),
  getControls: () => ipcRenderer.invoke('apiClient:getControls'),
  getLastSyncedControls: () => ipcRenderer.invoke('apiClient:getLastSyncedControls'),
  getForecast: (scope, entityId) => ipcRenderer.invoke('apiClient:getForecast', scope, entityId),
  dryRunPlan: (desiredControls, justification) =>
    ipcRenderer.invoke('apiClient:dryRunPlan', desiredControls, justification),
  applyPlan: (stagedPlan, desiredControls, input) =>
    ipcRenderer.invoke('apiClient:applyPlan', stagedPlan, desiredControls, input),
  getAuditChain: () => ipcRenderer.invoke('apiClient:getAuditChain'),
  verifyAuditChain: () => ipcRenderer.invoke('apiClient:verifyAuditChain'),
  getTenantConfig: () => ipcRenderer.invoke('apiClient:getTenantConfig'),
  setTenantConfig: (config) => ipcRenderer.invoke('apiClient:setTenantConfig', config),
  validatePat: () => ipcRenderer.invoke('apiClient:validatePat'),
  runLiveReadSmoke: () => ipcRenderer.invoke('apiClient:runLiveReadSmoke'),
  listScenarios: () => ipcRenderer.invoke('apiClient:listScenarios'),
  getActiveScenario: () => ipcRenderer.invoke('apiClient:getActiveScenario'),
  setScenario: (id) => ipcRenderer.invoke('apiClient:setScenario', id),
  getRebalanceContext: (mode) => ipcRenderer.invoke('apiClient:getRebalanceContext', mode),
};

// The PAT itself never crosses this bridge: only set/clear/hasPat are exposed,
// never a getter that would hand the plaintext value to the renderer
// (CLAUDE.md §6.6).
contextBridge.exposeInMainWorld('api', {
  setPat: (pat: string): Promise<void> => ipcRenderer.invoke('pat:set', pat),
  clearPat: (): Promise<void> => ipcRenderer.invoke('pat:clear'),
  hasPat: (): Promise<boolean> => ipcRenderer.invoke('pat:hasPat'),
  getMode: (): Promise<'simulation' | 'live'> => ipcRenderer.invoke('mode:get'),
  ...apiClientBridge,
});
