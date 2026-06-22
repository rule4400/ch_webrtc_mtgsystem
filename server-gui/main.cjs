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
const SYSTEM_SETTINGS_FILE = 'system-settings.json';
const DEFAULT_SYSTEM_SETTINGS = {
  channels: [
    { id: 'general', name: '一般' },
    { id: 'support', name: 'サポート' },
  ],
  latestVersions: {
    client: '0.2.12',
    viewer: '0.1.7',
    'screen-share': '0.1.6',
    server: '1.1.10',
    'server-gui': '1.0.11',
  },
  updatePackages: {},
  serverRuntime: {
    announcedIp: '',
    listenPort: '3000',
    rtcMinPort: '10000',
    rtcMaxPort: '10200',
    stunUrls: '',
    turnUrls: '',
    turnUser: '',
    turnPass: '',
    debugLogEnabled: true,
    debugLogDir: '',
    statsIntervalMs: '1000',
    vpnBandwidthMbps: '200',
  },
  mediaTransport: {
    forceTcp: false,
    videoProfile: 'vpn-balanced',
    cameraMaxBitrateKbps: '1400',
    cameraStartBitrateKbps: '900',
    screenMaxBitrateKbps: '1800',
  },
  updateFolder: '',
};

// ── アップデート配布フォルダ ──────────────────────────────
// ファイル名からアプリ種別とバージョンを自動判別する。
// 例: CHECKHOUSE-Meeting-Client-0.3.0-arm64.dmg → client / 0.3.0

const UPDATE_FILE_EXT = /\.(dmg|pkg|zip|exe|msi|appimage|deb|7z)$/i;
let updateFolderWatcher = null;
let updateFolderScanTimer = null;

function normalizeUpdatePlatform(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'macos' || raw === 'mac' || raw === 'darwin' || raw === 'osx') return 'darwin';
  if (raw === 'windows' || raw === 'win' || raw === 'win32' || raw === 'win64') return 'win32';
  if (raw === 'linux') return 'linux';
  return '';
}

function detectPlatformFromPath(relativeName) {
  const normalized = String(relativeName || '').replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    const platform = normalizeUpdatePlatform(part);
    if (platform) return platform;
  }
  if (/\.(dmg|pkg)$/i.test(normalized)) return 'darwin';
  if (/\.(exe|msi)$/i.test(normalized)) return 'win32';
  if (/\.(appimage|deb)$/i.test(normalized)) return 'linux';
  return '';
}

function walkUpdateFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const fullPath = path.join(dir, entry.name);
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkUpdateFiles(fullPath, relativeName));
      continue;
    }
    if (!entry.isFile() || !UPDATE_FILE_EXT.test(entry.name)) continue;
    const stat = fs.statSync(fullPath);
    files.push({ name: relativeName, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

function detectAppTypeFromFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (/screen[-_ ]?share/.test(lower)) return 'screen-share';
  if (lower.includes('viewer')) return 'viewer';
  if (lower.includes('client')) return 'client';
  if (/server[-_ ]?gui/.test(lower)) return 'server-gui';
  if (lower.includes('server')) return 'server';
  return null;
}

function detectVersionFromFilename(name) {
  const match = String(name || '').match(/(\d+\.\d+\.\d+)(?=[^0-9]|$)/);
  return match ? match[1] : '';
}

function scanUpdateFolder(dir) {
  const result = { folder: dir || '', files: [], packages: {} };
  if (!dir || !fs.existsSync(dir)) return result;

  let files = [];
  try {
    files = walkUpdateFiles(dir);
  } catch (err) {
    safeSend('server-log', `WARN: アップデートフォルダを読み取れません: ${err.message}`);
    return result;
  }

  for (const source of files) {
    const name = source.name;
    const appType = detectAppTypeFromFilename(name);
    const version = detectVersionFromFilename(name);
    const platform = detectPlatformFromPath(name);
    const file = { name, appType, version, platform, size: source.size, mtimeMs: source.mtimeMs };
    result.files.push(file);

    if (!appType || !version || !platform) continue;
    const currentAppPackage = result.packages[appType] || { version, platforms: {} };
    const existing = currentAppPackage.platforms[platform];
    // 同一アプリ/OSが複数ある場合は新しい mtime を採用
    if (!existing || source.mtimeMs > existing.mtimeMs) {
      currentAppPackage.version = version;
      currentAppPackage.platforms[platform] = {
        version,
        platform,
        url: `/updates/${encodeURIComponent(name)}`,
        notes: `自動検出: ${name}`,
        fileName: name,
        mtimeMs: source.mtimeMs,
      };
      result.packages[appType] = currentAppPackage;
    }
  }
  return result;
}

/** スキャン結果を system-settings に反映し、稼働中サーバーへも配信する */
function applyUpdateScan(dir, { announce = true } = {}) {
  const scan = scanUpdateFolder(dir);
  const settings = readSystemSettings();
  settings.updateFolder = dir || '';

  for (const [appType, pkg] of Object.entries(scan.packages)) {
    settings.latestVersions[appType] = pkg.version;
    settings.updatePackages[appType] = {
      ...(settings.updatePackages[appType] || {}),
      version: pkg.version,
      platforms: {
        ...(settings.updatePackages[appType]?.platforms || {}),
        ...(pkg.platforms || {}),
      },
      registeredAt: Date.now(),
    };
  }

  const saved = writeSystemSettings(settings);
  if (serverProcess) {
    sendToServer({ type: 'set-update-dir', dir: dir || '' });
    sendSystemSettingsToServer();
  }
  if (announce) {
    const detected = Object.entries(scan.packages)
      .map(([appType, pkg]) => `${appType}=${pkg.version}`)
      .join(', ');
    safeSend('server-log', `[Updates] フォルダスキャン完了: ${scan.files.length}ファイル ${detected ? `(${detected})` : '(配布対象なし)'}`);
  }
  safeSend('update-scan-result', { ...scan, settings: saved });
  return { ...scan, settings: saved };
}

function watchUpdateFolder(dir) {
  if (updateFolderWatcher) {
    try { updateFolderWatcher.close(); } catch { /* ignore */ }
    updateFolderWatcher = null;
  }
  if (!dir || !fs.existsSync(dir)) return;

  try {
    updateFolderWatcher = fs.watch(dir, () => {
      // 連続イベントをまとめて1.5秒後に自動再スキャン（自動取得）
      clearTimeout(updateFolderScanTimer);
      updateFolderScanTimer = setTimeout(() => applyUpdateScan(dir), 1500);
    });
  } catch (err) {
    safeSend('server-log', `WARN: アップデートフォルダの監視を開始できません: ${err.message}`);
  }
}

function clientRegistryPath() {
  return path.join(app.getPath('userData'), CLIENT_REGISTRY_FILE);
}

function systemSettingsPath() {
  return path.join(app.getPath('userData'), SYSTEM_SETTINGS_FILE);
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

function stableId(value, fallback = 'general') {
  const raw = shortText(value, 64).toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function sanitizeChannels(channels) {
  if (!Array.isArray(channels)) return DEFAULT_SYSTEM_SETTINGS.channels;
  const seen = new Set();
  const items = [];
  for (const entry of channels.slice(0, 32)) {
    const id = stableId(entry?.id || entry?.name, '');
    const name = shortText(entry?.name || id, 48);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name });
  }
  return items.length ? items : DEFAULT_SYSTEM_SETTINGS.channels;
}

function sanitizeSystemSettings(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const latestVersions = {
    ...DEFAULT_SYSTEM_SETTINGS.latestVersions,
    ...(raw.latestVersions && typeof raw.latestVersions === 'object' ? raw.latestVersions : {}),
  };
  const updatePackages = raw.updatePackages && typeof raw.updatePackages === 'object'
    ? raw.updatePackages
    : {};
  const rawMediaTransport = raw.mediaTransport && typeof raw.mediaTransport === 'object'
    ? raw.mediaTransport
    : {};
  const rawServerRuntime = raw.serverRuntime && typeof raw.serverRuntime === 'object'
    ? raw.serverRuntime
    : {};

  return {
    channels: sanitizeChannels(raw.channels),
    updateFolder: shortText(raw.updateFolder, 1024),
    latestVersions: Object.fromEntries(Object.entries(latestVersions).map(([key, value]) => [key, shortText(value, 48)])),
    mediaTransport: {
      forceTcp: !!rawMediaTransport.forceTcp,
      videoProfile: videoProfileText(rawMediaTransport.videoProfile, DEFAULT_SYSTEM_SETTINGS.mediaTransport.videoProfile),
      cameraMaxBitrateKbps: boundedNumberText(rawMediaTransport.cameraMaxBitrateKbps, 200, 6000, DEFAULT_SYSTEM_SETTINGS.mediaTransport.cameraMaxBitrateKbps),
      cameraStartBitrateKbps: boundedNumberText(rawMediaTransport.cameraStartBitrateKbps, 150, 4000, DEFAULT_SYSTEM_SETTINGS.mediaTransport.cameraStartBitrateKbps),
      screenMaxBitrateKbps: boundedNumberText(rawMediaTransport.screenMaxBitrateKbps, 300, 8000, DEFAULT_SYSTEM_SETTINGS.mediaTransport.screenMaxBitrateKbps),
    },
    serverRuntime: {
      announcedIp: shortText(rawServerRuntime.announcedIp, 128),
      listenPort: portText(rawServerRuntime.listenPort, DEFAULT_SYSTEM_SETTINGS.serverRuntime.listenPort),
      rtcMinPort: portText(rawServerRuntime.rtcMinPort, DEFAULT_SYSTEM_SETTINGS.serverRuntime.rtcMinPort),
      rtcMaxPort: portText(rawServerRuntime.rtcMaxPort, DEFAULT_SYSTEM_SETTINGS.serverRuntime.rtcMaxPort),
      stunUrls: csvText(rawServerRuntime.stunUrls, 2048),
      turnUrls: csvText(rawServerRuntime.turnUrls, 2048),
      turnUser: shortText(rawServerRuntime.turnUser, 256),
      turnPass: shortText(rawServerRuntime.turnPass, 512),
      debugLogEnabled: rawServerRuntime.debugLogEnabled !== false,
      debugLogDir: shortText(rawServerRuntime.debugLogDir, 1024),
      statsIntervalMs: boundedNumberText(rawServerRuntime.statsIntervalMs, 500, 60000, DEFAULT_SYSTEM_SETTINGS.serverRuntime.statsIntervalMs),
      vpnBandwidthMbps: boundedNumberText(rawServerRuntime.vpnBandwidthMbps, 1, 10000, DEFAULT_SYSTEM_SETTINGS.serverRuntime.vpnBandwidthMbps),
    },
    updatePackages: Object.fromEntries(Object.entries(updatePackages).map(([key, value]) => {
      const pkg = value && typeof value === 'object' ? value : {};
      const platforms = {};
      for (const [platform, platformPkg] of Object.entries(pkg.platforms && typeof pkg.platforms === 'object' ? pkg.platforms : {})) {
        const normalizedPlatform = normalizeUpdatePlatform(platform);
        if (!normalizedPlatform) continue;
        const item = platformPkg && typeof platformPkg === 'object' ? platformPkg : {};
        platforms[normalizedPlatform] = {
          version: shortText(item.version || pkg.version || latestVersions[key] || '', 48),
          platform: normalizedPlatform,
          url: shortText(item.url, 1024),
          notes: shortText(item.notes, 1000),
          sha256: shortText(item.sha256, 128),
          fileName: shortText(item.fileName, 512),
          required: !!item.required,
          registeredAt: Number.isFinite(item.registeredAt) ? item.registeredAt : Date.now(),
        };
      }
      return [key, {
        version: shortText(pkg.version || latestVersions[key] || '', 48),
        url: shortText(pkg.url, 1024),
        notes: shortText(pkg.notes, 1000),
        sha256: shortText(pkg.sha256, 128),
        required: !!pkg.required,
        platforms,
        registeredAt: Number.isFinite(pkg.registeredAt) ? pkg.registeredAt : Date.now(),
      }];
    })),
  };
}

function readSystemSettings() {
  try {
    return sanitizeSystemSettings(JSON.parse(fs.readFileSync(systemSettingsPath(), 'utf8')));
  } catch {
    return sanitizeSystemSettings(DEFAULT_SYSTEM_SETTINGS);
  }
}

function writeSystemSettings(settings) {
  const clean = sanitizeSystemSettings(settings);
  fs.mkdirSync(path.dirname(systemSettingsPath()), { recursive: true });
  fs.writeFileSync(systemSettingsPath(), JSON.stringify(clean, null, 2));
  return clean;
}

function shortText(value, max = 256) {
  return String(value ?? '').trim().slice(0, max);
}

function portText(value, fallback) {
  return boundedNumberText(value, 1, 65535, fallback);
}

function boundedNumberText(value, min, max, fallback) {
  const text = String(value ?? '').trim();
  const number = Number.parseInt(text, 10);
  if (!Number.isInteger(number) || number < min || number > max) return String(fallback);
  return String(number);
}

function csvText(value, max = 2048) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .join(',')
    .slice(0, max);
}

function videoProfileText(value, fallback = 'vpn-balanced') {
  const raw = String(value || '').trim();
  return ['stable', 'vpn-balanced', 'high', 'fhd'].includes(raw) ? raw : fallback;
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

function sendSystemSettingsToServer() {
  const state = readSystemSettings();
  return sendToServer({ type: 'set-system-state', state });
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
    systemSettingsPath: systemSettingsPath(),
  };
});

ipcMain.handle('get-system-settings', () => {
  return readSystemSettings();
});

ipcMain.handle('save-system-settings', (_event, rawSettings) => {
  const settings = writeSystemSettings(rawSettings);
  if (serverProcess) {
    sendSystemSettingsToServer();
    safeSend('server-log', 'WARN: サーバー起動設定を変更した場合は、停止→起動で ANNOUNCED_IP / ポート / TURN / デバッグ設定が反映されます。');
  }
  return settings;
});

ipcMain.handle('select-update-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'アップデートファイルの配布フォルダを選択',
  });
  if (result.canceled) return null;
  const dir = result.filePaths[0];
  const scan = applyUpdateScan(dir);
  watchUpdateFolder(dir);
  return scan;
});

ipcMain.handle('scan-update-folder', () => {
  const dir = readSystemSettings().updateFolder;
  if (!dir) return { folder: '', files: [], packages: {}, settings: readSystemSettings() };
  watchUpdateFolder(dir);
  return applyUpdateScan(dir);
});

ipcMain.handle('clear-update-folder', () => {
  watchUpdateFolder(null);
  return applyUpdateScan('');
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

  for (const file of ['index.js', 'config.js', 'debug-log.js', 'package.json', '.env.example']) {
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

function serverRuntimeEnvFromSettings(settings = readSystemSettings()) {
  const clean = sanitizeSystemSettings(settings);
  const runtime = clean.serverRuntime;
  const env = {
    PORT: runtime.listenPort,
    RTC_MIN_PORT: runtime.rtcMinPort,
    RTC_MAX_PORT: runtime.rtcMaxPort,
    FORCE_TCP_MEDIA: clean.mediaTransport.forceTcp ? 'true' : 'false',
    STUN_URLS: runtime.stunUrls,
    TURN_URLS: runtime.turnUrls,
    TURN_USER: runtime.turnUser,
    TURN_PASS: runtime.turnPass,
    DEBUG_LOG_DISABLED: runtime.debugLogEnabled ? 'false' : 'true',
    STATS_INTERVAL_MS: runtime.statsIntervalMs,
    VPN_BANDWIDTH_MBPS: runtime.vpnBandwidthMbps,
  };

  if (runtime.announcedIp) env.ANNOUNCED_IP = runtime.announcedIp;
  else env.ANNOUNCED_IP = '';
  if (runtime.debugLogDir) env.DEBUG_LOG_DIR = runtime.debugLogDir;

  return env;
}

function writeManagedEnvFile(serverDir, settings = readSystemSettings()) {
  const envPath = path.join(serverDir, '.env');
  const env = serverRuntimeEnvFromSettings(settings);
  const keys = [
    'ANNOUNCED_IP',
    'PORT',
    'RTC_MIN_PORT',
    'RTC_MAX_PORT',
    'FORCE_TCP_MEDIA',
    'STUN_URLS',
    'TURN_URLS',
    'TURN_USER',
    'TURN_PASS',
    'DEBUG_LOG_DISABLED',
    'DEBUG_LOG_DIR',
    'STATS_INTERVAL_MS',
    'VPN_BANDWIDTH_MBPS',
  ];
  const body = [
    '# CHECKHOUSE Server GUI managed settings',
    '# このブロックはサーバーGUIの設定タブから自動生成されます。',
    ...keys.map(key => `${key}=${envValue(env[key] || '')}`),
    '',
  ].join('\n');

  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(envPath, body);
  return envPath;
}

function envValue(value) {
  const text = String(value ?? '');
  if (!/[#\s"']/u.test(text)) return text;
  return JSON.stringify(text);
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

  const systemSettings = readSystemSettings();
  const runtimeEnv = serverRuntimeEnvFromSettings(systemSettings);
  let envPath = path.join(serverDir, '.env');
  try {
    envPath = writeManagedEnvFile(serverDir, systemSettings);
  } catch (err) {
    safeSend('server-log', `WARN: .envを書き込めませんでした。起動時の環境変数にはGUI設定を反映します: ${err.message}`);
  }
  if (runtimeEnv.ANNOUNCED_IP) {
    safeSend('server-log', `--- ANNOUNCED_IP: ${runtimeEnv.ANNOUNCED_IP} ---`);
  } else {
    safeSend('server-log', 'WARN: ANNOUNCED_IP が未設定です。L3/VPN拠点では設定タブで到達可能なサーバーIPを指定してください。');
  }
  safeSend('server-log', `--- サーバー設定: ${envPath} ---`);

  const env = {
    ...process.env,
    ...runtimeEnv,
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
  setTimeout(() => {
    if (!serverProcess) return;
    sendSystemSettingsToServer();
    const updateFolder = readSystemSettings().updateFolder;
    if (updateFolder) {
      sendToServer({ type: 'set-update-dir', dir: updateFolder });
      watchUpdateFolder(updateFolder);
    }
  }, 500);
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

ipcMain.on('call-client', (_event, socketId) => {
  if (serverProcess) {
    safeSend('server-log', `[Admin] 呼び出しを送信: ${socketId}`);
    sendToServer({ type: 'call-client', socketId });
  }
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

ipcMain.on('set-client-channel', (_event, payload = {}) => {
  const { socketId, channelId } = payload;
  if (serverProcess) {
    safeSend('server-log', `[Admin] チャンネル変更を送信: ${socketId} -> ${channelId}`);
    sendToServer({ type: 'set-client-channel', socketId, channelId });
  }
});

ipcMain.on('force-update', (_event, payload = {}) => {
  const appType = shortText(payload.appType || 'all', 24);
  if (serverProcess) {
    safeSend('server-log', `[Admin] 強制アップデート指示を送信: ${appType}`);
    sendToServer({ type: 'force-update', appType });
  } else {
    safeSend('server-log', 'WARN: サーバー未起動のため、強制アップデート指示を送信できません');
  }
});

ipcMain.on('restart-all', () => {
  if (serverProcess) {
    safeSend('server-log', '[Admin] 全クライアントへ再起動信号を送信しました');
    sendToServer({ type: 'restart-all' });
  } else {
    safeSend('server-log', 'WARN: サーバー未起動のため、再起動信号を送信できません');
  }
});
