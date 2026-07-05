import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerPatIpcHandlers } from './pat-bridge';
import { getMode, registerModeIpcHandler } from './mode';
import { registerApiClientIpcHandlers } from './ipc';

const RENDERER_DEV_SERVER_URL = 'http://localhost:5173';

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Task 8.5's audit export is a plain browser-style Blob + <a download>
  // click in the renderer (CLAUDE.md §2 portability rule -- the ratified
  // ask-first decision was explicitly "no additional bridge method, no
  // Electron SAVE DIALOG, no fs in the renderer": no `dialog.showSaveDialog`
  // IPC round-trip). Without ANY `will-download` handling, Chromium's
  // default behaviour for such a click is its own native "Save As" prompt --
  // fine for an interactive user, but that dialog blocks indefinitely under
  // Playwright (no automation surface can drive a native OS dialog, and
  // Playwright's own `page.waitForEvent('download')` does not fire for
  // Electron windows regardless -- confirmed empirically against
  // apps/desktop/e2e/audit.spec.ts: the download completes to disk, but the
  // Playwright-level event never arrives). Silently saving to a known
  // downloads folder (no dialog at all) is the same default a real browser
  // gives you with "ask where to save" left off, so this isn't standing up a
  // bespoke Electron save-dialog flow -- it's making the browser-native
  // download actually complete, so audit.spec.ts can poll for the resulting
  // file on disk instead of a Playwright download event.
  //
  // Dev/test override mirrors db.ts's COPILOT_BUDGET_DB_PATH convention:
  // Playwright e2e must not write into the real per-OS Downloads folder,
  // or repeated runs would accumulate files across launches.
  const downloadsDir = process.env.COPILOT_BUDGET_DOWNLOADS_PATH ?? app.getPath('downloads');
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    item.setSavePath(path.join(downloadsDir, item.getFilename()));
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(RENDERER_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../../../packages/ui/dist/index.html'));
  }
}

async function bootstrap(): Promise<void> {
  registerPatIpcHandlers();
  registerModeIpcHandler();

  const mode = await getMode();
  if (mode === 'simulation') {
    // One mock, three consumers (CLAUDE.md §7): this is the runtime
    // simulation consumer. The ApiClient's Octokit-issued requests are
    // intercepted here once this listener is attached.
    const { server } = await import('@copilot-budget/data/msw');
    server.listen({ onUnhandledRequest: 'bypass' });
  }

  registerApiClientIpcHandlers(mode === 'simulation' ? 'msw' : 'github');
  createWindow();
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
