const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { pathToFileURL, URL } = require('url');
const { readWindowState, trackWindowState, applyWindowState } = require('./window-state.cjs');

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
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
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

ipcMain.handle('open-external', async (_event, url) => {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('invalid update url');
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

ipcMain.on('quick-restart-result', (_event, result) => {
  console.log(`[QuickRestart] renderer result ${JSON.stringify(result || {})}`);
});
