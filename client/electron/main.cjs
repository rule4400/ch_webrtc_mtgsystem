const { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { readWindowState, trackWindowState, applyWindowState } = require('./window-state.cjs');

let mainWindow;
let restartInProgress = false;
let productionIndexUrl = null;
let controlServer = null;
let pendingRemoteConfig = null;

// 二重起動防止: 同じ端末で2つ目のアプリが起動すると、同一 instanceId のセッションが
// サーバー上で衝突し、その拠点が全拠点から「頻繁に再接続する不安定な拠点」に見える。
// 2つ目の起動は既存ウィンドウを前面に出して即終了する。
// ロック取得は whenReady 内（再起動ディレイ後）に行う: Windows の自己再起動は
// 「新プロセスを spawn → 旧プロセスが exit」の順のため、起動直後に取得すると
// 旧プロセスのロック解放とレースして正当な再起動まで拒否してしまう。
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

const CONTROL_HOST = process.env.SFU_CLIENT_CONTROL_HOST || '0.0.0.0';
const CONTROL_PORT = Number.parseInt(process.env.SFU_CLIENT_CONTROL_PORT || '39210', 10);
const CONTROL_TOKEN = process.env.SFU_CLIENT_CONTROL_TOKEN || '';

// 常時接続アプリのため、ウィンドウが最小化・背面でもタイマーやレンダリングを
// 間引かせない。間引かれるとテレメトリ(1秒周期)が数十秒〜1分間隔まで落ち、
// サーバーが「応答なし」と誤検知して再起動指示を送る→復帰→また間引かれる、
// という再接続ループの原因になる。
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

/**
 * メモリ肥大の自己回復。常時接続で数日稼働すると、GPUプロセスやレンダラーの
 * ネイティブリソース肥大がスワップ→OSフリーズ（遠隔復旧不可）に到達しうる。
 * レンダラーの reload では GPU プロセスは回収できないため、全プロセス合算と
 * GPUプロセス単体をしきい値監視し、超過が2回連続したらアプリごと再起動する。
 * 再起動は restartApp()（自動再接続あり・約10秒）で、OSフリーズより遥かに軽い。
 *   SFU_CLIENT_MEM_RESTART_MB=3200 / SFU_CLIENT_GPU_MEM_RESTART_MB=1800 (0で無効)
 */
const MEM_RESTART_MB = Number(process.env.SFU_CLIENT_MEM_RESTART_MB ?? 3200);
const GPU_MEM_RESTART_MB = Number(process.env.SFU_CLIENT_GPU_MEM_RESTART_MB ?? 1800);
let memoryBreachCount = 0;

function checkMemoryPressure() {
  if (restartInProgress) return;
  let totalMb = 0;
  let gpuMb = 0;
  try {
    for (const metric of app.getAppMetrics()) {
      const mb = (metric.memory?.workingSetSize || 0) / 1024; // workingSetSize はKB
      totalMb += mb;
      if (metric.type === 'GPU') gpuMb = Math.max(gpuMb, mb);
    }
  } catch {
    return;
  }

  const overTotal = MEM_RESTART_MB > 0 && totalMb >= MEM_RESTART_MB;
  const overGpu = GPU_MEM_RESTART_MB > 0 && gpuMb >= GPU_MEM_RESTART_MB;
  if (!overTotal && !overGpu) {
    memoryBreachCount = 0;
    return;
  }

  memoryBreachCount += 1;
  console.warn(`[Memory] pressure detected total=${Math.round(totalMb)}MB gpu=${Math.round(gpuMb)}MB strike=${memoryBreachCount}`);
  // 一時的なスパイクでの誤再起動を避けるため、2回連続(約10分継続)で発動する
  if (memoryBreachCount >= 2) {
    console.error(`[Memory] restarting app to reclaim resources (total=${Math.round(totalMb)}MB, gpu=${Math.round(gpuMb)}MB)`);
    restartApp();
  }
}

const memoryWatchTimer = setInterval(checkMemoryPressure, 5 * 60 * 1000);
memoryWatchTimer.unref?.();

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
      // 最小化・背面でも接続維持処理(テレメトリ/同期/復旧)を間引かせない
      backgroundThrottling: false,
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

  if (!(await acquireSingleInstanceLock())) {
    console.warn('[Startup] 既にこのアプリが起動しているため終了します（二重起動防止）');
    app.exit(0);
    return;
  }

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

ipcMain.handle('open-external', async (_event, url) => {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('invalid update url');
  await shell.openExternal(target);
  return true;
});

ipcMain.on('quick-restart-result', (_event, result) => {
  console.log(`[QuickRestart] renderer result ${JSON.stringify(result || {})}`);
});

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
