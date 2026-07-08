import path from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import { createPatStore, type PatStore } from '@copilot-budget/data/pat';

let patStore: PatStore | undefined;

// Lazily constructed, and never called before app.whenReady(): safeStorage's
// backing (e.g. the OS keyring on Linux) isn't guaranteed resolved until then,
// even though isEncryptionAvailable() can appear to succeed early on macOS.
export function getPatStore(): PatStore {
  if (!patStore) {
    const filePath = path.join(app.getPath('userData'), 'pat.enc');
    patStore = createPatStore(filePath, {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plainText) => safeStorage.encryptString(plainText),
      decrypt: (encrypted) => safeStorage.decryptString(encrypted),
    });
  }
  return patStore;
}

// The PAT itself never crosses this bridge -- only set/clear/hasPat are
// exposed to the renderer, never a getter that returns the plaintext value
// (CLAUDE.md §6.6).
//
// `onCredentialsChanged` (2026-07-08 live-mode fix): the routed-to ApiClient
// is built once from whatever PAT is stored at construction time (ipc.ts's
// buildClient). Without this hook, saving/clearing a PAT after the app has
// already started never reached the client that issues live requests --
// only validatePat's dedicated probe re-read the PAT live. Invoked (and
// awaited) AFTER the store mutation commits, so a caller awaiting
// pat:set/pat:clear can rely on the very next apiClient:* call already
// seeing the new credentials.
export function registerPatIpcHandlers(onCredentialsChanged?: () => Promise<void>): void {
  const store = getPatStore();

  ipcMain.handle('pat:set', async (_event, pat: string) => {
    await store.set(pat);
    await onCredentialsChanged?.();
  });

  ipcMain.handle('pat:clear', async () => {
    await store.clear();
    await onCredentialsChanged?.();
  });

  ipcMain.handle('pat:hasPat', async () => {
    return (await store.get()) !== null;
  });
}
