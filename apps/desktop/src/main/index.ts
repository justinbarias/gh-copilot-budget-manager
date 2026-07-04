import path from 'node:path';
import { app, BrowserWindow } from 'electron';

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

app.whenReady().then(createWindow);

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
