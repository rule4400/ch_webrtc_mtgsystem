const { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL, URL } = require('url');
const { readWindowState, trackWindowState, applyWindowState } = require('./window-state.cjs');

let mainWindow;
let restartInProgress = false;
let productionIndexUrl = null;
let controlServer = null;
let pendingRemoteConfig = null;

const CONTROL_HOST = process.env.SFU_CLIENT_CONTROL_HOST || '0.0.0.0';
const CONTROL_PORT = Number.parseInt(process.env.SFU_CLIENT_CONTROL_PORT || '39210', 10);
const CONTROL_TOKEN = process.env.SFU_CLIENT_CONTROL_TOKEN || '';
const DEBUG_SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const DEBUG_MAX_FIELD_LENGTH = 16_000;
const DEBUG_MAX_ARRAY_LENGTH = 64;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function relaunchArgs() {
  return process.argv.slice(1).filter(arg => !arg.startsWith('--squirrel-'));
}

function debugDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function debugLogDir() {
  return process.env.CHECKHOUSE_CLIENT_DEBUG_LOG_DIR || path.join(app.getPath('userData'), 'debug-logs');
}

function debugLogFilePath() {
  return path.join(debugLogDir(), `client-debug-${debugDate()}.jsonl`);
}

function sanitizeDebugValue(value, depth = 0) {
  if (depth > 8) return '[max-depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > DEBUG_MAX_FIELD_LENGTH ? `${value.slice(0, DEBUG_MAX_FIELD_LENGTH)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, DEBUG_MAX_ARRAY_LENGTH).map(item => sanitizeDebugValue(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/fingerprint|credential|password|token|secret|authorization/i.test(key)) output[key] = '[redacted]';
      else output[key] = sanitizeDebugValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function writeDebugLog(event, details = {}, severity = 'info') {
  if (String(process.env.CHECKHOUSE_CLIENT_DEBUG_LOG_DISABLED || '').toLowerCase() === 'true') return null;
  const file = debugLogFilePath();
  const entry = {
    ts: new Date().toISOString(),
    sessionId: DEBUG_SESSION_ID,
    severity,
    event,
    pid: process.pid,
    platform: process.platform,
    version: app.getVersion(),
    packaged: app.isPackaged,
    hostname: os.hostname(),
    uptimeSec: Number(process.uptime().toFixed(3)),
    details: sanitizeDebugValue(details),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFile(file, `${JSON.stringify(entry)}\n`, err => {
      if (err) console.error(`[DebugLog] append failed: ${err.message}`);
    });
    return file;
  } catch (err) {
    console.error(`[DebugLog] write failed: ${err.message}`);
    return null;
  }
}

function debugLogInfo() {
  const file = debugLogFilePath();
  return {
    sessionId: DEBUG_SESSION_ID,
    dir: path.dirname(file),
    file,
    enabled: String(process.env.CHECKHOUSE_CLIENT_DEBUG_LOG_DISABLED || '').toLowerCase() !== 'true',
  };
}

async function honorRestartDelay() {
  const delayMs = Number.parseInt(process.env.SFU_RESTART_DELAY_MS || '0', 10);
  if (Number.isFinite(delayMs) && delayMs > 0) await delay(Math.min(delayMs, 5000));
}

async function ensureMacMediaAccess() {
  if (process.platform !== 'darwin') return;

  for (const mediaType of ['camera', 'microphone']) {
    const status = systemPreferences.getMediaAccessStatus(mediaType);
    writeDebugLog('permission.status', { mediaType, status });
    if (status === 'granted') {
      console.log(`[Permission] ${mediaType}=granted`);
      continue;
    }
    if (status === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess(mediaType);
      console.log(`[Permission] ${mediaType}=${granted ? 'granted' : 'denied'}`);
      writeDebugLog('permission.request-result', { mediaType, granted });
      continue;
    }
    console.warn(`[Permission] ${mediaType}=${status}. macOS System Settings must be changed manually.`);
    writeDebugLog('permission.needs-manual-change', { mediaType, status }, 'warn');
  }
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

function requestQuickRestart(source = 'main') {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  console.log(`[QuickRestart] forwarding to renderer source=${source}`);
  mainWindow.webContents.send('quick-restart-request', {
    source,
    requestedAt: Date.now(),
  });
  return true;
}

function loadProductionApp() {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  productionIndexUrl = pathToFileURL(indexPath).toString();
  return mainWindow.loadURL(productionIndexUrl);
}

function remoteConfigPath() {
  return path.join(app.getPath('userData'), 'remote-config.json');
}

function readRemoteConfig() {
  try {
    const raw = fs.readFileSync(remoteConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveRemoteConfig(config) {
  fs.mkdirSync(path.dirname(remoteConfigPath()), { recursive: true });
  fs.writeFileSync(remoteConfigPath(), JSON.stringify(config, null, 2));
}

function sanitizeClientConfig(input = {}) {
  const serverIp = String(input.serverIp || '').trim();
  const serverPort = String(input.serverPort || '3000').trim();
  const locationName = String(input.locationName || '遠隔クライアント').trim();
  if (!serverIp) throw new Error('serverIp is required');
  if (!/^\d{1,5}$/.test(serverPort) || Number(serverPort) < 1 || Number(serverPort) > 65535) {
    throw new Error('serverPort is invalid');
  }
  return {
    serverIp,
    serverPort,
    locationName: locationName.slice(0, 128) || '遠隔クライアント',
  };
}

async function applyClientConfig(config, { reload = false } = {}) {
  const clean = sanitizeClientConfig(config);
  saveRemoteConfig(clean);
  pendingRemoteConfig = clean;

  if (!mainWindow || mainWindow.isDestroyed()) return clean;

  const script = `
    (() => {
      const incoming = ${JSON.stringify(clean)};
      let current = {};
      try {
        current = JSON.parse(localStorage.getItem('sfu_config') || '{}') || {};
      } catch {
        current = {};
      }
      const config = { ...current, ...incoming };
      localStorage.setItem('sfu_config', JSON.stringify(config));
      location.hash = '#/main';
      window.dispatchEvent(new CustomEvent('sfu-remote-config-applied', { detail: config }));
      if (${reload ? 'true' : 'false'}) {
        location.reload();
      }
      return true;
    })()
  `;

  try {
    await mainWindow.webContents.executeJavaScript(script, true);
    pendingRemoteConfig = null;
  } catch (err) {
    console.error('[Control] apply config in renderer failed:', err.message);
  }
  return clean;
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(item => item && item.family === 'IPv4' && !item.internal)
    .map(item => item.address);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!CONTROL_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return req.headers['x-sfu-token'] === CONTROL_TOKEN || bearer === CONTROL_TOKEN;
}

function startControlServer() {
  if (!Number.isInteger(CONTROL_PORT) || CONTROL_PORT <= 0 || CONTROL_PORT > 65535) {
    console.warn(`[Control] disabled: invalid SFU_CLIENT_CONTROL_PORT=${process.env.SFU_CLIENT_CONTROL_PORT}`);
    return;
  }
  if (controlServer) return;

  controlServer = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          app: 'MeetingClient',
          version: app.getVersion(),
          pid: process.pid,
          packaged: app.isPackaged,
          configured: !!readRemoteConfig(),
          config: readRemoteConfig(),
          control: { host: CONTROL_HOST, port: CONTROL_PORT, tokenRequired: !!CONTROL_TOKEN },
          addresses: localAddresses(),
          debugLog: debugLogInfo(),
        });
      }

      if (req.method === 'POST' && url.pathname === '/configure') {
        const body = await readJsonBody(req);
        const config = await applyClientConfig(body, { reload: body.reload === true });
        return sendJson(res, 200, { ok: true, config });
      }

      if (req.method === 'POST' && url.pathname === '/reload') {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/restart') {
        const sent = requestQuickRestart('control-server');
        if (!sent && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
        sendJson(res, 202, { ok: true, quickRestarting: sent, rendererReloaded: !sent });
        return;
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  controlServer.on('error', err => {
    console.error(`[Control] server error: ${err.message}`);
  });
  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    console.log(`[Control] listening on ${CONTROL_HOST}:${CONTROL_PORT}${CONTROL_TOKEN ? ' token=required' : ' token=none'}`);
  });
}

function stopControlServer() {
  if (!controlServer) return;
  const server = controlServer;
  controlServer = null;
  server.close(err => {
    if (err) console.error(`[Control] close failed: ${err.message}`);
  });
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
      webSecurity: false,      // file:// からのローカルリソース読み込みを許可
      // ユーザー操作なしでも <video>/<audio> の自動再生を許可（カメラ映像が
      // muted/autoplay ポリシーでブロックされて黒画面になるのを防ぐ）
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // 終了時の状態（最大化・全画面・位置サイズ）を復元し、以後の変化を保存する。
  // 遠隔再起動・アップデート後も同じ見た目で立ち上がる。
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

  // 読み込み失敗時のログ
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Load] failed  code=${code}  url=${url}  ${desc}`);
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

  // レンダラーの console をメインプロセス stdout に転送（デバッグ用）
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR', 'INFO'][level] || 'LOG';
    console.log(`[Renderer:${tag}] ${message}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingRemoteConfig) applyClientConfig(pendingRemoteConfig).catch(err => console.error('[Control] pending config failed:', err));
  });
}

app.whenReady().then(async () => {
  await honorRestartDelay();
  await ensureMacMediaAccess();
  const info = debugLogInfo();
  console.log(`[DebugLog] writing client JSONL logs to ${info.file}`);
  writeDebugLog('app.started', {
    debugLog: info,
    addresses: localAddresses(),
    control: { host: CONTROL_HOST, port: CONTROL_PORT, tokenRequired: !!CONTROL_TOKEN },
  });

  // カメラ・マイク権限を許可
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'display-capture'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'mediaKeySystem', 'fullscreen', 'display-capture'].includes(permission);
  });

  createWindow();
  startControlServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopControlServer();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopControlServer();
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
  writeDebugLog('quick-restart.result', result || {});
});

ipcMain.handle('write-debug-log', async (_event, payload = {}) => {
  const event = String(payload.event || 'renderer.event').slice(0, 128);
  const severity = ['debug', 'info', 'warn', 'error'].includes(payload.severity) ? payload.severity : 'info';
  const file = writeDebugLog(event, payload.details || {}, severity);
  return { ok: !!file, file, sessionId: DEBUG_SESSION_ID };
});

ipcMain.handle('get-debug-log-info', async () => debugLogInfo());

// ── 画面共有（Client内蔵）────────────────────────────────
// screen-share 専用アプリと同じ仕組み: desktopCapturer で一覧を取得し、
// レンダラーは chromeMediaSourceId 指定の getUserMedia でキャプチャする。

function getScreenCaptureStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function normalizeDesktopSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('window:') ? 'window' : 'screen',
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    displayId: source.display_id || null,
  };
}

ipcMain.handle('get-screen-capture-status', async () => ({
  platform: process.platform,
  permissionStatus: getScreenCaptureStatus(),
}));

ipcMain.handle('list-desktop-sources', async (_event, options = {}) => {
  const mode = options.mode === 'window' ? 'window' : 'screen';
  try {
    const sources = await desktopCapturer.getSources({
      types: [mode],
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
  }
});

// macOSの画面収録権限: 繰り返しダイアログを出さず、設定画面への案内で対応する
ipcMain.handle('open-screen-capture-settings', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  }
  return false;
});
