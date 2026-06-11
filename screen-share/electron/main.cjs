const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
} = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let mainWindow;
let productionIndexUrl = null;
let sharingPowerBlockerId = null;
let selectedDisplaySource = null;
const sourceRequestCache = new Map();

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function loadProductionApp() {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  productionIndexUrl = pathToFileURL(indexPath).toString();
  return mainWindow.loadURL(productionIndexUrl);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    loadProductionApp();
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[Load] failed code=${code} url=${url} ${desc}`);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (isDev) mainWindow.reload();
      else loadProductionApp();
    }, 3000);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    console.log(`[Renderer:${level}] ${message}`);
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev || !productionIndexUrl) return;
    if (url === productionIndexUrl || url.startsWith(`${productionIndexUrl}#`)) return;
    event.preventDefault();
    loadProductionApp();
  });
}

function setSharingActive(active) {
  if (active) {
    if (sharingPowerBlockerId === null || !powerSaveBlocker.isStarted(sharingPowerBlockerId)) {
      sharingPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log(`[PowerSaveBlocker] started id=${sharingPowerBlockerId}`);
    }
    return true;
  }

  if (sharingPowerBlockerId !== null && powerSaveBlocker.isStarted(sharingPowerBlockerId)) {
    powerSaveBlocker.stop(sharingPowerBlockerId);
    console.log(`[PowerSaveBlocker] stopped id=${sharingPowerBlockerId}`);
  }
  sharingPowerBlockerId = null;
  return false;
}

function getScreenCaptureStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    if (typeof systemPreferences.getMediaAccessStatus === 'function') {
      return systemPreferences.getMediaAccessStatus('screen');
    }
  } catch (err) {
    console.warn('[ScreenCaptureStatus]', err.message);
  }
  return 'unknown';
}

function getDesktopSourceTypes(mode) {
  return mode === 'window' ? ['window'] : ['screen'];
}

function normalizeDesktopSource(source) {
  const id = source.id || '';
  const kind = id.startsWith('window:') ? 'window' : 'screen';
  return {
    id,
    kind,
    name: source.name || (kind === 'window' ? 'アプリ' : '画面全体'),
    displayId: source.display_id || '',
    thumbnail: source.thumbnail?.toDataURL?.() || '',
    appIcon: source.appIcon?.toDataURL?.() || '',
  };
}

function sanitizeSelectedDisplaySource(input) {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id || '').trim();
  if (!id) return null;
  const kind = id.startsWith('window:') ? 'window' : 'screen';
  return {
    id,
    kind,
    name: String(input.name || '').trim(),
    includeAudio: !!input.includeAudio,
  };
}

async function findDisplayMediaSource(selection) {
  const mode = selection?.kind === 'window' ? 'window' : 'screen';
  const sources = await desktopCapturer.getSources({
    types: getDesktopSourceTypes(mode),
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.find(source => source.id === selection?.id) || sources[0] || null;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'display-capture', 'fullscreen'].includes(permission);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const selection = selectedDisplaySource;
      const source = await findDisplayMediaSource(selection);
      if (!source) {
        callback({});
        return;
      }

      const response = { video: source };
      if (process.platform === 'win32' && request.audioRequested && selection?.includeAudio) {
        response.audio = 'loopback';
      }
      callback(response);
    } catch (err) {
      console.error('[DisplayMediaRequest]', err);
      callback({});
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  setSharingActive(false);
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  setSharingActive(false);
});

ipcMain.handle('get-screen-capture-status', async () => ({
  platform: process.platform,
  permissionStatus: getScreenCaptureStatus(),
}));

ipcMain.handle('list-desktop-sources', async (_event, options = {}) => {
  const mode = options.mode === 'window' ? 'window' : 'screen';

  const existing = sourceRequestCache.get(mode);
  if (existing) return existing;

  const request = (async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: getDesktopSourceTypes(mode),
        thumbnailSize: { width: 420, height: 260 },
        fetchWindowIcons: true,
      });
      return {
        ok: true,
        mode,
        permissionStatus: getScreenCaptureStatus(),
        sources: sources.map(normalizeDesktopSource),
      };
    } catch (err) {
      console.error('[DesktopSources]', err);
      return {
        ok: false,
        mode,
        permissionStatus: getScreenCaptureStatus(),
        error: err.message || 'desktopCapturer failed',
        sources: [],
      };
    } finally {
      sourceRequestCache.delete(mode);
    }
  })();

  sourceRequestCache.set(mode, request);
  return request;
});

ipcMain.handle('restart-app', async () => {
  try {
    setSharingActive(false);
    app.relaunch();
    app.exit(0);
    return true;
  } catch (err) {
    console.error('[RestartApp]', err);
    return false;
  }
});

ipcMain.handle('select-display-source', async (_event, source) => {
  selectedDisplaySource = sanitizeSelectedDisplaySource(source);
  return { ok: !!selectedDisplaySource };
});

ipcMain.handle('set-sharing-active', async (_event, active) => setSharingActive(!!active));

ipcMain.handle('open-external', async (_event, url) => {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('invalid url');
  await shell.openExternal(target);
  return true;
});

ipcMain.handle('open-screen-capture-settings', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  }
  return false;
});
