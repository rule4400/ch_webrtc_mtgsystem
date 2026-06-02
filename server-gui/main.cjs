const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// パッケージ化されたElectronアプリ(macOS)でnodeが見つからないENOENTエラーを防ぐためのPATH補完
function fixMacPath() {
  if (process.platform !== 'darwin') return;
  const envPath = process.env.PATH || '';
  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];

  if (process.env.HOME) {
    const nvmDir = path.join(process.env.HOME, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        if (versions.length > 0) extraPaths.push(path.join(nvmDir, versions[0], 'bin'));
      } catch (e) {}
    }
  }

  process.env.PATH = Array.from(new Set([...envPath.split(':'), ...extraPaths])).filter(Boolean).join(':');
}
fixMacPath();

let mainWindow;
let serverProcess = null;
let lastServerDir = null;
let manualStop = false;
let restartTimer = null;
let restartAttempts = 0;
let stoppingServer = false;
let isQuitting = false;

const SERVER_RUNTIME_DIR = 'server-runtime';
const CLIENT_REGISTRY_FILE = 'registered-clients.json';

function clientRegistryPath() {
  return path.join(app.getPath('userData'), CLIENT_REGISTRY_FILE);
}

function readClientRegistry() {
  try {
    const items = JSON.parse(fs.readFileSync(clientRegistryPath(), 'utf8'));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function writeClientRegistry(items) {
  fs.mkdirSync(path.dirname(clientRegistryPath()), { recursive: true });
  fs.writeFileSync(clientRegistryPath(), JSON.stringify(items, null, 2));
}

function shortText(value, max = 256) {
  return String(value ?? '').trim().slice(0, max);
}

function sanitizeRegisteredClient(input = {}) {
  const id = shortText(input.id, 80) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const host = shortText(input.host, 180);
  const port = Number.parseInt(input.port || '39210', 10);
  if (!host) throw new Error('クライアントIP/ホストを入力してください');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('管理ポートが不正です');
  return {
    id,
    name: shortText(input.name, 128) || host,
    host,
    port,
    token: shortText(input.token, 512),
    locationName: shortText(input.locationName, 128) || shortText(input.name, 128) || host,
    serverIp: shortText(input.serverIp, 128),
    serverPort: shortText(input.serverPort, 12) || '3000',
    lastStatus: shortText(input.lastStatus, 32) || 'unknown',
    lastSeenAt: input.lastSeenAt || null,
    lastError: shortText(input.lastError, 512),
  };
}

function publicRegisteredClient(client) {
  return {
    ...client,
    token: client.token ? '********' : '',
    hasToken: !!client.token,
  };
}

function controlUrl(client, pathname) {
  return `http://${client.host}:${client.port}${pathname}`;
}

async function controlRequest(client, pathname, { method = 'GET', body = null, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (client.token) headers['X-SFU-Token'] = client.token;
    let requestBody;
    if (body) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }
    const response = await fetch(controlUrl(client, pathname), {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok || data.error) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** ウィンドウが生きている場合のみ IPC 送信（終了時クラッシュ防止） */
function safeSend(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function sendToServer(message) {
  if (!serverProcess || !serverProcess.connected || !serverProcess.send) {
    safeSend('server-log', 'WARN: サーバープロセスへ送信できません。サーバー状態を確認してください。');
    return false;
  }

  try {
    serverProcess.send(message);
    return true;
  } catch (err) {
    safeSend('server-log', `ERROR: サーバープロセスIPC送信失敗: ${err.message}`);
    return false;
  }
}

function killServerTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process may have already exited.
  }
}

function stopServerProcess({ manual = true } = {}) {
  if (manual) manualStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (stoppingServer) return;
  if (!serverProcess) return;

  const proc = serverProcess;
  stoppingServer = true;
  safeSend('server-log', manual ? '--- サーバーを手動停止します ---' : '--- サーバーを停止します ---');

  const forceTimer = setTimeout(() => {
    if (serverProcess === proc) {
      safeSend('server-log', 'WARN: サーバー停止に時間がかかっています。プロセスツリーを強制終了します。');
      killServerTree(proc.pid);
    }
  }, 5000);
  forceTimer.unref?.();

  proc.once('close', () => {
    clearTimeout(forceTimer);
    stoppingServer = false;
  });

  try {
    proc.kill('SIGTERM');
  } catch (err) {
    safeSend('server-log', `ERROR: サーバー停止信号の送信に失敗: ${err.message}`);
    killServerTree(proc.pid);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true
    }
  });
  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    safeSend('server-status', serverProcess ? 'Running' : 'Stopped');
    if (lastServerDir) {
      safeSend('server-log', `--- ダッシュボード接続: ${lastServerDir} ---`);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isQuitting) {
    stopServerProcess();
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServerProcess();
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'サーバー(server)フォルダを選択'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-server-info', () => {
  const bundled = getBundledServerRuntimeDir();
  return {
    bundledServerDir: bundled,
    defaultEnvPath: path.join(bundled, '.env'),
  };
});

ipcMain.handle('list-registered-clients', () => {
  return readClientRegistry().map(publicRegisteredClient);
});

ipcMain.handle('save-registered-client', (_event, rawClient) => {
  const existing = readClientRegistry();
  const matching = rawClient?.id
    ? existing.find(client => client.id === rawClient.id)
    : existing.find(client => client.host === shortText(rawClient?.host, 180) && String(client.port) === String(rawClient?.port || '39210'));
  const previous = matching;
  const merged = {
    ...rawClient,
    id: rawClient?.id || previous?.id,
    token: rawClient?.token === '********' ? previous?.token || '' : rawClient?.token,
    lastStatus: previous?.lastStatus,
    lastSeenAt: previous?.lastSeenAt,
    lastError: previous?.lastError,
  };
  const client = sanitizeRegisteredClient(merged);
  const next = existing.filter(item => item.id !== client.id);
  next.push(client);
  writeClientRegistry(next);
  return publicRegisteredClient(client);
});

ipcMain.handle('remove-registered-client', (_event, id) => {
  const existing = readClientRegistry();
  writeClientRegistry(existing.filter(client => client.id !== id));
  return true;
});

ipcMain.handle('probe-registered-client', async (_event, id) => {
  const clients = readClientRegistry();
  const client = clients.find(item => item.id === id);
  if (!client) throw new Error('登録クライアントが見つかりません');

  try {
    const response = await controlRequest(client, '/health');
    client.lastStatus = 'online';
    client.lastSeenAt = new Date().toISOString();
    client.lastError = '';
    writeClientRegistry(clients);
    return { client: publicRegisteredClient(client), response };
  } catch (err) {
    client.lastStatus = 'offline';
    client.lastError = err.name === 'AbortError' ? 'timeout' : err.message;
    writeClientRegistry(clients);
    return { client: publicRegisteredClient(client), error: client.lastError };
  }
});

ipcMain.handle('configure-registered-client', async (_event, id, config = {}) => {
  const clients = readClientRegistry();
  const client = clients.find(item => item.id === id);
  if (!client) throw new Error('登録クライアントが見つかりません');
  const payload = {
    serverIp: shortText(config.serverIp || client.serverIp, 128),
    serverPort: shortText(config.serverPort || client.serverPort || '3000', 12),
    locationName: shortText(config.locationName || client.locationName || client.name, 128),
  };
  const response = await controlRequest(client, '/configure', { method: 'POST', body: payload, timeoutMs: 6000 });
  client.serverIp = payload.serverIp;
  client.serverPort = payload.serverPort;
  client.locationName = payload.locationName;
  client.lastStatus = 'configured';
  client.lastSeenAt = new Date().toISOString();
  client.lastError = '';
  writeClientRegistry(clients);
  return { client: publicRegisteredClient(client), response };
});

ipcMain.handle('restart-registered-client', async (_event, id) => {
  const clients = readClientRegistry();
  const client = clients.find(item => item.id === id);
  if (!client) throw new Error('登録クライアントが見つかりません');
  const response = await controlRequest(client, '/restart', { method: 'POST', timeoutMs: 3000 });
  client.lastStatus = 'restart-sent';
  client.lastSeenAt = new Date().toISOString();
  client.lastError = '';
  writeClientRegistry(clients);
  return { client: publicRegisteredClient(client), response };
});

function copyFileIfChanged(src, dest) {
  const srcContent = fs.readFileSync(src);
  if (fs.existsSync(dest)) {
    const destContent = fs.readFileSync(dest);
    if (srcContent.equals(destContent)) return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, srcContent);
}

function getBundledServerSourceDir() {
  const packagedDir = path.join(process.resourcesPath, 'bundled-server');
  if (fs.existsSync(path.join(packagedDir, 'index.js'))) return packagedDir;
  return path.resolve(__dirname, '..', 'server');
}

function getBundledServerRuntimeDir() {
  return path.join(app.getPath('userData'), SERVER_RUNTIME_DIR);
}

function ensureBundledServerRuntime() {
  const sourceDir = getBundledServerSourceDir();
  const runtimeDir = getBundledServerRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const file of ['index.js', 'config.js', 'package.json', '.env.example']) {
    const src = path.join(sourceDir, file);
    if (fs.existsSync(src)) copyFileIfChanged(src, path.join(runtimeDir, file));
  }

  const envPath = path.join(runtimeDir, '.env');
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(runtimeDir, '.env.example');
    if (fs.existsSync(examplePath)) fs.copyFileSync(examplePath, envPath);
  }
  migrateGeneratedEnv(envPath);

  return runtimeDir;
}

function migrateGeneratedEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const env = fs.readFileSync(envPath, 'utf8');
  const looksGenerated =
    env.includes('# VPN内で全クライアントから到達できるSFUサーバーのIPを指定してください。') &&
    env.includes('ANNOUNCED_IP=10.0.0.10');

  if (!looksGenerated) return;

  fs.writeFileSync(envPath, env.replace('ANNOUNCED_IP=10.0.0.10', 'ANNOUNCED_IP='));
  safeSend('server-log', `WARN: 旧バージョンのサンプル ANNOUNCED_IP=10.0.0.10 を無効化しました。必要に応じて設定タブの .env を実際のVPN内IPに変更してください: ${envPath}`);
}

function getNodePathEnv() {
  const paths = [
    path.join(app.getAppPath(), 'node_modules'),
    path.resolve(__dirname, 'node_modules'),
    path.resolve(__dirname, '..', 'server', 'node_modules'),
  ];
  return paths.filter(p => fs.existsSync(p)).join(path.delimiter);
}

function getMediasoupWorkerBin() {
  const fileName = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker';
  const platformArch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(process.resourcesPath, 'mediasoup-workers', platformArch, fileName),
    path.join(__dirname, 'resources', 'mediasoup-workers', platformArch, fileName),
    path.resolve(__dirname, '..', 'server', 'node_modules', 'mediasoup', 'worker', 'out', 'Release', fileName),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function scheduleServerRestart(exitCode) {
  if (manualStop || !lastServerDir || restartTimer) return;
  const delay = Math.min(30000, 2000 * (2 ** restartAttempts));
  restartAttempts += 1;
  safeSend('server-log', `--- サーバーが予期せず停止しました (終了コード: ${exitCode})。${Math.round(delay / 1000)}秒後に自動再起動します ---`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startServerProcess(lastServerDir, { automatic: true });
  }, delay);
}

function startServerProcess(selectedPath, { automatic = false } = {}) {
  if (serverProcess) return;
  stoppingServer = false;

  const serverDir = selectedPath && fs.existsSync(path.join(selectedPath, 'index.js'))
    ? selectedPath
    : ensureBundledServerRuntime();

  if (!serverDir || !fs.existsSync(serverDir)) {
    safeSend('server-log', `ERROR: 有効なサーバーディレクトリを選択してください。\n指定されたパス: ${serverDir}`);
    return;
  }

  lastServerDir = serverDir;
  manualStop = false;
  safeSend('server-log', automatic ? `--- サーバー自動再起動: ${serverDir} ---` : `--- サーバー起動開始: ${serverDir} ---`);

  const workerBin = getMediasoupWorkerBin();
  if (workerBin) {
    safeSend('server-log', `--- mediasoup worker: ${workerBin} ---`);
  } else {
    safeSend('server-log', 'WARN: 内蔵 mediasoup-worker が見つかりません。mediasoup 標準パスで起動を試みます。');
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: getNodePathEnv(),
  };
  if (workerBin) env.MEDIASOUP_WORKER_BIN = workerBin;
  
  // Electron 同梱の Node ランタイムで内蔵サーバーを起動する。
  serverProcess = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
    cwd: serverDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  serverProcess.stdout.on('data', (data) => {
    safeSend('server-log', data.toString());
  });

  serverProcess.stderr.on('data', (data) => {
    safeSend('server-log', `ERROR: ${data.toString()}`);
  });

  serverProcess.on('error', (err) => {
    safeSend('server-status', 'Stopped');
    safeSend('server-log', `FATAL ERROR: サーバープロセス起動失敗: ${err.message}`);
    serverProcess = null;
    scheduleServerRestart('spawn-error');
  });

  serverProcess.on('message', (msg) => {
    if (msg.type === 'stats') {
      safeSend('server-stats', msg.data);
    } else if (msg.type === 'admin-log') {
      safeSend('server-log', msg.data);
    }
  });

  serverProcess.on('close', (code) => {
    safeSend('server-status', 'Stopped');
    safeSend('server-log', `--- サーバー停止 (終了コード: ${code}) ---`);
    serverProcess = null;
    stoppingServer = false;
    if (code === 0) restartAttempts = 0;
    scheduleServerRestart(code);
  });

  safeSend('server-status', 'Running');
}

ipcMain.on('start-server', (event, selectedPath) => {
  restartAttempts = 0;
  startServerProcess(selectedPath);
});

ipcMain.on('stop-server', () => {
  if (stoppingServer) return;
  stopServerProcess();
});

// Admin commands
ipcMain.on('kick-client', (event, socketId) => {
  sendToServer({ type: 'kick', socketId });
});

ipcMain.on('restart-client', (_event, socketId) => {
  if (serverProcess) {
    safeSend('server-log', `[Admin] クライアント個別再起動を送信: ${socketId}`);
    sendToServer({ type: 'restart-client', socketId });
  }
});

ipcMain.on('set-client-device', (_event, payload = {}) => {
  const { socketId, kind, deviceId } = payload;
  if (serverProcess) {
    safeSend('server-log', `[Admin] デバイス切替を送信: ${socketId} ${kind}`);
    sendToServer({ type: 'set-client-device', socketId, kind, deviceId });
  }
});

ipcMain.on('set-client-media-state', (_event, payload = {}) => {
  const { socketId, kind, enabled } = payload;
  if (serverProcess) {
    const stateText = enabled ? 'ON' : 'OFF';
    safeSend('server-log', `[Admin] メディア状態変更を送信: ${socketId} ${kind}=${stateText}`);
    sendToServer({ type: 'set-client-media-state', socketId, kind, enabled: !!enabled });
  }
});

ipcMain.on('refresh-client-devices', (_event, socketId) => {
  sendToServer({ type: 'refresh-client-devices', socketId });
});

ipcMain.on('restart-all', () => {
  if (serverProcess) {
    safeSend('server-log', '[Admin] 全クライアントへ再起動信号を送信しました');
    sendToServer({ type: 'restart-all' });
  } else {
    safeSend('server-log', 'WARN: サーバー未起動のため、再起動信号を送信できません');
  }
});
