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
let rendererRecoveryTimer = null;
let rendererRecoveryReason = '';
let rendererRecoveryAttempts = 0;
let rendererStableTimer = null;
let isQuitting = false;
const sourceRequestCache = new Map();

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 二重起動防止: 同一端末からの重複セッションはサーバー上で衝突し、
// 「頻繁に再接続する不安定な拠点」に見える原因になる。
// relaunch直後は旧プロセスがロックを保持したまま終了処理中のことがあるため、
// 一度の失敗で即終了せず短い間隔で再試行する（失敗即終了だと「再起動したはずの
// アプリが起動していない」無人拠点の停止事故になる）。
async function acquireSingleInstanceLock(retries = 5, intervalMs = 600) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (app.requestSingleInstanceLock()) return true;
    await delay(intervalMs);
  }
  return false;
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function loadProductionApp() {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  productionIndexUrl = pathToFileURL(indexPath).toString();
  return mainWindow.loadURL(productionIndexUrl);
}

function isTrustedRendererUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  try {
    const target = new URL(value);
    if (process.env.NODE_ENV === 'development') {
      return target.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '::1'].includes(target.hostname) &&
        target.port === '5174';
    }
    if (!productionIndexUrl || target.protocol !== 'file:') return false;
    return target.pathname === new URL(productionIndexUrl).pathname;
  } catch {
    return false;
  }
}

function isTrustedWebContents(webContents) {
  return !!mainWindow &&
    !mainWindow.isDestroyed() &&
    webContents === mainWindow.webContents &&
    isTrustedRendererUrl(webContents.getURL());
}

function isTrustedPermissionContext(webContents, requestingUrl) {
  if (!isTrustedWebContents(webContents)) return false;
  const candidate = String(requestingUrl || '').trim();
  if (!candidate || candidate === 'null' || candidate === 'file://') return true;
  return isTrustedRendererUrl(candidate);
}

function requireTrustedIpcSender(event) {
  const senderFrame = event.senderFrame;
  const senderUrl = senderFrame?.url || '';
  if (!isTrustedWebContents(event.sender) || !senderFrame ||
      senderFrame !== mainWindow.webContents.mainFrame || !isTrustedRendererUrl(senderUrl)) {
    throw new Error('untrusted IPC sender');
  }
}

function parseExternalHttpUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value || value.length > 2048) throw new Error('invalid external url');
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error('invalid external url');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('invalid external url');
  }
  return target.toString();
}

function clearRendererRecoveryTimer() {
  if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = null;
  rendererRecoveryReason = '';
}

function markRendererHealthy() {
  clearRendererRecoveryTimer();
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererStableTimer = setTimeout(() => {
    rendererStableTimer = null;
    rendererRecoveryAttempts = 0;
  }, 30_000);
  rendererStableTimer.unref?.();
}

function scheduleRendererRecovery(reason, minimumDelayMs = 1_000) {
  if (isQuitting || rendererRecoveryTimer || !mainWindow || mainWindow.isDestroyed()) return;
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererStableTimer = null;
  const delayMs = Math.max(minimumDelayMs, Math.min(15_000, 1_000 * (2 ** Math.min(rendererRecoveryAttempts, 4))));
  rendererRecoveryAttempts += 1;
  rendererRecoveryReason = reason;
  console.error(`[Renderer] ${reason}; recovery scheduled in ${delayMs}ms (attempt=${rendererRecoveryAttempts})`);
  rendererRecoveryTimer = setTimeout(async () => {
    rendererRecoveryTimer = null;
    rendererRecoveryReason = '';
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (process.env.NODE_ENV === 'development') mainWindow.webContents.reloadIgnoringCache();
      else await loadProductionApp();
    } catch (err) {
      console.error(`[Renderer] recovery failed: ${err.message}`);
      scheduleRendererRecovery('recovery-load-failed');
    }
  }, delayMs);
  rendererRecoveryTimer.unref?.();
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
      sandbox: true,
      webSecurity: true,
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

  mainWindow.on('closed', () => {
    clearRendererRecoveryTimer();
    if (rendererStableTimer) clearTimeout(rendererStableTimer);
    rendererStableTimer = null;
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[Load] failed code=${code} url=${url} ${desc}`);
    scheduleRendererRecovery(`load-failed:${code}`, 3_000);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    console.log(`[Renderer:${level}] ${message}`);
  });
  const guardNavigation = (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    console.warn(`[Navigation] blocked unexpected top-level navigation: ${url}`);
    if (!isDev) loadProductionApp();
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  mainWindow.webContents.on('did-finish-load', markRendererHealthy);
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    selectedDisplaySource = null;
    sourceRequestCache.clear();
    setSharingActive(false);
    scheduleRendererRecovery(`process-gone:${details.reason}`);
  });
  mainWindow.on('unresponsive', () => {
    scheduleRendererRecovery('window-unresponsive', 3_000);
  });
  mainWindow.on('responsive', () => {
    if (rendererRecoveryTimer && rendererRecoveryReason === 'window-unresponsive') {
      console.log('[Renderer] responsiveness restored before reload');
      clearRendererRecoveryTimer();
      markRendererHealthy();
    }
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
  if (!selection?.id) return null;
  const mode = selection?.kind === 'window' ? 'window' : 'screen';
  const sources = await desktopCapturer.getSources({
    types: getDesktopSourceTypes(mode),
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.find(source => source.id === selection.id) || null;
}

app.whenReady().then(async () => {
  if (!(await acquireSingleInstanceLock())) {
    console.warn('[Startup] 既にこのアプリが起動しているため終了します（二重起動防止）');
    app.exit(0);
    return;
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(['media', 'display-capture', 'fullscreen'].includes(permission) &&
      isTrustedPermissionContext(webContents, details?.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return ['media', 'display-capture', 'fullscreen'].includes(permission) &&
      isTrustedPermissionContext(webContents, details?.requestingUrl || requestingOrigin);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const selection = selectedDisplaySource;
      const requestingUrl = request.frame?.url || request.securityOrigin || '';
      if (!isTrustedPermissionContext(mainWindow?.webContents, requestingUrl)) {
        callback({});
        return;
      }
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
    } finally {
      // 1回のユーザー選択を1回のキャプチャ許可に紐付ける。
      selectedDisplaySource = null;
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
  isQuitting = true;
  clearRendererRecoveryTimer();
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererStableTimer = null;
  setSharingActive(false);
});

ipcMain.handle('get-screen-capture-status', async event => {
  requireTrustedIpcSender(event);
  return {
    platform: process.platform,
    permissionStatus: getScreenCaptureStatus(),
  };
});

ipcMain.handle('list-desktop-sources', async (event, options = {}) => {
  requireTrustedIpcSender(event);
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

ipcMain.handle('restart-app', async event => {
  requireTrustedIpcSender(event);
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

ipcMain.handle('select-display-source', async (event, source) => {
  requireTrustedIpcSender(event);
  selectedDisplaySource = sanitizeSelectedDisplaySource(source);
  return { ok: !!selectedDisplaySource };
});

ipcMain.handle('set-sharing-active', async (event, active) => {
  requireTrustedIpcSender(event);
  return setSharingActive(!!active);
});

ipcMain.handle('open-external', async (event, url) => {
  requireTrustedIpcSender(event);
  const target = parseExternalHttpUrl(url);
  await shell.openExternal(target);
  return true;
});

ipcMain.handle('open-screen-capture-settings', async event => {
  requireTrustedIpcSender(event);
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  }
  return false;
});
