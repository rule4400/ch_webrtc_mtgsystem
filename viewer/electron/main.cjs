const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const { readWindowState, trackWindowState, applyWindowState } = require('./window-state.cjs');

let mainWindow;
let restartInProgress = false;
let productionIndexUrl = null;
let rendererRecoveryTimer = null;
let rendererRecoveryReason = '';
let rendererRecoveryAttempts = 0;
let rendererStableTimer = null;
let isQuitting = false;

// 無人常設ビューアーでも、最小化・背面化によるタイマー間引きで
// signaling/ICE復旧ループが停止しないようにする。
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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

function isTrustedRendererUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  try {
    const target = new URL(value);
    if (process.env.NODE_ENV === 'development') {
      return target.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '::1'].includes(target.hostname) &&
        target.port === '5173';
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

function scheduleRendererRecovery(reason) {
  if (isQuitting || restartInProgress || rendererRecoveryTimer || !mainWindow || mainWindow.isDestroyed()) return;
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererStableTimer = null;
  const delayMs = Math.min(15_000, 1_000 * (2 ** Math.min(rendererRecoveryAttempts, 4)));
  rendererRecoveryAttempts += 1;
  rendererRecoveryReason = reason;
  console.error(`[Renderer] ${reason}; recovery scheduled in ${delayMs}ms (attempt=${rendererRecoveryAttempts})`);
  rendererRecoveryTimer = setTimeout(async () => {
    rendererRecoveryTimer = null;
    rendererRecoveryReason = '';
    if (isQuitting || restartInProgress || !mainWindow || mainWindow.isDestroyed()) return;
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
  const windowState = readWindowState({ width: 1280, height: 800 });
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(Number.isFinite(windowState.x) && Number.isFinite(windowState.y)
      ? { x: windowState.x, y: windowState.y }
      : {}),
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

  // 終了時の状態（最大化・全画面・位置サイズ）を復元し、以後の変化を保存する
  applyWindowState(mainWindow, windowState);
  trackWindowState(mainWindow);

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    loadProductionApp();
  }

  mainWindow.on('closed', () => {
    clearRendererRecoveryTimer();
    if (rendererStableTimer) clearTimeout(rendererStableTimer);
    rendererRecoveryTimer = null;
    rendererStableTimer = null;
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Load] failed code=${code} url=${url} ${desc}`);
    scheduleRendererRecovery(`load-failed:${code}`);
  });

  const guardNavigation = (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    console.warn(`[Navigation] blocked unexpected top-level navigation: ${url}`);
    if (!isDev) loadProductionApp();
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    scheduleRendererRecovery(`process-gone:${details.reason}`);
  });

  mainWindow.on('unresponsive', () => {
    scheduleRendererRecovery('window-unresponsive');
  });

  mainWindow.on('responsive', () => {
    if (rendererRecoveryTimer && rendererRecoveryReason === 'window-unresponsive') {
      console.log('[Renderer] responsiveness restored before reload');
      markRendererHealthy();
    }
  });

  mainWindow.webContents.on('did-finish-load', markRendererHealthy);

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = ['LOG', 'WARN', 'ERROR', 'INFO'][level] || 'LOG';
    console.log(`[Renderer:${tag}] ${message}`);
  });
}

app.whenReady().then(async () => {
  await honorRestartDelay();

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = ['media', 'fullscreen'];
    callback(allowed.includes(permission) &&
      isTrustedPermissionContext(webContents, details?.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return ['media', 'fullscreen'].includes(permission) &&
      isTrustedPermissionContext(webContents, details?.requestingUrl || requestingOrigin);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  clearRendererRecoveryTimer();
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererRecoveryTimer = null;
  rendererStableTimer = null;
});

ipcMain.on('restart-app', event => {
  try {
    requireTrustedIpcSender(event);
  } catch (err) {
    console.warn(`[IPC] restart-app rejected: ${err.message}`);
    return;
  }
  restartApp();
});

ipcMain.handle('open-external', async (event, url) => {
  requireTrustedIpcSender(event);
  const target = parseExternalHttpUrl(url);
  await shell.openExternal(target);
  return true;
});

ipcMain.on('quick-restart-result', (event, result) => {
  try {
    requireTrustedIpcSender(event);
  } catch (err) {
    console.warn(`[IPC] quick-restart-result rejected: ${err.message}`);
    return;
  }
  console.log(`[QuickRestart] renderer result ${JSON.stringify(result || {})}`);
});
