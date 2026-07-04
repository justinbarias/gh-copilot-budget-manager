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

  registerApiClientIpcHandlers();
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
