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
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { pathToFileURL, URL } = require('url');

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

function updateCacheDir() {
  return path.join(app.getPath('userData'), 'update-cache');
}

function safeUpdateFileName(url, fallback = 'update-package') {
  try {
    const parsed = new URL(url);
    const base = path.basename(decodeURIComponent(parsed.pathname || '')) || fallback;
    return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || fallback;
  } catch {
    return fallback;
  }
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const redirect = new URL(response.headers.location, parsed).toString();
        downloadFile(redirect, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`download failed: HTTP ${response.statusCode}`));
        return;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function downloadUpdatePackage(packageInfo = {}) {
  const url = String(packageInfo.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('invalid update url');
  const fileName = safeUpdateFileName(url, packageInfo.fileName || 'update-package');
  const destination = path.join(updateCacheDir(), fileName);
  await downloadFile(url, destination);
  const stat = fs.statSync(destination);
  return { ok: true, fileName, path: destination, size: stat.size, downloadedAt: Date.now() };
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeTempScript(name, content, extension = process.platform === 'win32' ? 'cmd' : 'sh') {
  const scriptPath = path.join(app.getPath('temp'), `${name}-${Date.now()}.${extension}`);
  fs.writeFileSync(scriptPath, content);
  if (extension === 'sh') fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function installUpdatePackage(payload = {}) {
  const installerPath = String(payload.path || payload.filePath || '').trim();
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('update package not found');
  const ext = path.extname(installerPath).toLowerCase();
  setSharingActive(false);

  if (process.platform === 'win32') {
    const installerCmd = ext === '.msi'
      ? `msiexec /i "${installerPath}" /qn`
      : `"${installerPath}" /S`;
    const script = writeTempScript('checkhouse-update', [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      installerCmd,
      'timeout /t 1 /nobreak >nul',
      `start "" "${process.execPath}"`,
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.exit(0);
    return { ok: true, installing: true };
  }

  if (process.platform === 'darwin') {
    const mountDir = path.join(app.getPath('temp'), `checkhouse-update-mount-${Date.now()}`);
    const scriptLines = [
      '#!/bin/sh',
      'set -e',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
      `mkdir -p ${quoteShell(mountDir)}`,
    ];
    if (ext === '.dmg') {
      scriptLines.push(
        `hdiutil attach ${quoteShell(installerPath)} -mountpoint ${quoteShell(mountDir)} -nobrowse -quiet`,
        `APP_PATH=$(find ${quoteShell(mountDir)} -maxdepth 2 -name "*.app" -type d | head -n 1)`,
        'if [ -z "$APP_PATH" ]; then hdiutil detach ' + quoteShell(mountDir) + ' -quiet || true; exit 1; fi',
        'DEST="/Applications/$(basename "$APP_PATH")"',
        'rm -rf "$DEST"',
        'ditto "$APP_PATH" "$DEST"',
        `hdiutil detach ${quoteShell(mountDir)} -quiet || true`,
        'open "$DEST"',
      );
    } else if (ext === '.pkg') {
      scriptLines.push(
        `installer -pkg ${quoteShell(installerPath)} -target /`,
        `open ${quoteShell(process.execPath)}`,
      );
    } else {
      throw new Error(`unsupported macOS update package: ${ext}`);
    }
    const script = writeTempScript('checkhouse-update', scriptLines.join('\n'), 'sh');
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
    app.exit(0);
    return { ok: true, installing: true };
  }

  throw new Error(`unsupported update platform: ${process.platform}`);
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

ipcMain.handle('download-update-package', async (_event, packageInfo) => {
  return downloadUpdatePackage(packageInfo || {});
});

ipcMain.handle('open-downloaded-update', async (_event, filePath) => {
  const target = String(filePath || '');
  const root = updateCacheDir();
  if (!target || !path.resolve(target).startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) {
    throw new Error('downloaded update not found');
  }
  await shell.openPath(target);
  return true;
});

ipcMain.handle('install-update-package', async (_event, payload) => {
  return installUpdatePackage(payload || {});
});

ipcMain.handle('open-screen-capture-settings', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  }
  return false;
});
