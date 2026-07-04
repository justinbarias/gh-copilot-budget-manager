import { contextBridge, ipcRenderer } from 'electron';

// The PAT itself never crosses this bridge: only set/clear/hasPat are exposed,
// never a getter that would hand the plaintext value to the renderer
// (CLAUDE.md §6.6).
contextBridge.exposeInMainWorld('api', {
  setPat: (pat: string): Promise<void> => ipcRenderer.invoke('pat:set', pat),
  clearPat: (): Promise<void> => ipcRenderer.invoke('pat:clear'),
  hasPat: (): Promise<boolean> => ipcRenderer.invoke('pat:hasPat'),
  getMode: (): Promise<'simulation' | 'live'> => ipcRenderer.invoke('mode:get'),
});
