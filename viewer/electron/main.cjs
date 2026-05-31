const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

let mainWindow;
let restartInProgress = false;
let productionIndexUrl = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function relaunchArgs() {
  return process.argv.slice(1).filter(arg => !arg.startsWith('--squirrel-'));
}

async function honorRestartDelay() {
  const delayMs = Number.parseInt(process.env.SFU_RESTART_DELAY_MS || '0', 10);
  if (Number.isFinite(delayMs) && delayMs > 0) await delay(Math.min(delayMs, 5000));
}

function restartApp() {
  if (restartInProgress) return;
  restartInProgress = true;

  const args = relaunchArgs();
  console.log(`[Restart] requested platform=${process.platform} packaged=${app.isPackaged}`);

  try {
    if (process.platform === 'win32') {
      const child = spawn(process.execPath, args, {
        cwd: app.isPackaged ? path.dirname(process.execPath) : process.cwd(),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: {
          ...process.env,
          SFU_RESTART_DELAY_MS: '1200',
        },
      });
      child.unref();
    } else {
      app.relaunch({ execPath: process.execPath, args });
    }
  } catch (err) {
    console.error('[Restart] relaunch failed:', err);
    app.relaunch({ execPath: process.execPath, args });
  }

  app.exit(0);
}

function loadProductionApp() {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  productionIndexUrl = pathToFileURL(indexPath).toString();
  return mainWindow.loadURL(productionIndexUrl);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    loadProductionApp();
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Load] failed code=${code} url=${url} ${desc}`);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (isDev) mainWindow.reload();
      else loadProductionApp();
    }, 3000);
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev || !productionIndexUrl) return;
    if (url === productionIndexUrl || url.startsWith(`${productionIndexUrl}#`)) return;
    event.preventDefault();
    console.warn(`[Navigation] blocked unexpected top-level navigation: ${url}`);
    loadProductionApp();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[Renderer] gone: ${details.reason}`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  mainWindow.on('unresponsive', () => {
    console.error('[Window] unresponsive, reloading renderer');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = ['LOG', 'WARN', 'ERROR', 'INFO'][level] || 'LOG';
    console.log(`[Renderer:${tag}] ${message}`);
  });
}

app.whenReady().then(async () => {
  await honorRestartDelay();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'fullscreen', 'display-capture'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'mediaKeySystem', 'fullscreen', 'display-capture'].includes(permission);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('restart-app', () => {
  restartApp();
});

ipcMain.on('quick-restart-result', (_event, result) => {
  console.log(`[QuickRestart] renderer result ${JSON.stringify(result || {})}`);
});
