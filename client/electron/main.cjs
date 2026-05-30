const { app, BrowserWindow, ipcMain, session, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let mainWindow;
let restartInProgress = false;
let productionIndexUrl = null;
let controlServer = null;
let pendingRemoteConfig = null;

const CONTROL_HOST = process.env.SFU_CLIENT_CONTROL_HOST || '0.0.0.0';
const CONTROL_PORT = Number.parseInt(process.env.SFU_CLIENT_CONTROL_PORT || '39210', 10);
const CONTROL_TOKEN = process.env.SFU_CLIENT_CONTROL_TOKEN || '';

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

async function ensureMacMediaAccess() {
  if (process.platform !== 'darwin') return;

  for (const mediaType of ['camera', 'microphone']) {
    const status = systemPreferences.getMediaAccessStatus(mediaType);
    if (status === 'granted') {
      console.log(`[Permission] ${mediaType}=granted`);
      continue;
    }
    if (status === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess(mediaType);
      console.log(`[Permission] ${mediaType}=${granted ? 'granted' : 'denied'}`);
      continue;
    }
    console.warn(`[Permission] ${mediaType}=${status}. macOS System Settings must be changed manually.`);
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

async function applyClientConfig(config, { reload = true } = {}) {
  const clean = sanitizeClientConfig(config);
  saveRemoteConfig(clean);
  pendingRemoteConfig = clean;

  if (!mainWindow || mainWindow.isDestroyed()) return clean;

  const script = `
    (() => {
      const config = ${JSON.stringify(clean)};
      localStorage.setItem('sfu_config', JSON.stringify(config));
      window.dispatchEvent(new CustomEvent('sfu-remote-config-applied', { detail: config }));
      if (${reload ? 'true' : 'false'}) {
        location.hash = '#/main';
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
        });
      }

      if (req.method === 'POST' && url.pathname === '/configure') {
        const body = await readJsonBody(req);
        const config = await applyClientConfig(body, { reload: body.reload !== false });
        return sendJson(res, 200, { ok: true, config });
      }

      if (req.method === 'POST' && url.pathname === '/reload') {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/restart') {
        sendJson(res, 202, { ok: true, restarting: true });
        setTimeout(restartApp, 100);
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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
