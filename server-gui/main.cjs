const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

// 二重起動防止: GUIを2つ起動すると内蔵サーバーも2つ起動しようとして
// ポート競合や設定ファイルの取り合いになる。2つ目は既存ウィンドウを前面へ。
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

const SERVER_RUNTIME_DIR = 'server-runtime';
const CLIENT_REGISTRY_FILE = 'registered-clients.json';
const SYSTEM_SETTINGS_FILE = 'system-settings.json';
const PRIVATE_CHANNEL_PREFIX = 'private-';
const DEFAULT_SYSTEM_SETTINGS = {
  channels: [
    { id: 'general', name: '一般' },
    { id: 'support', name: 'サポート' },
  ],
  latestVersions: {
    client: '0.6.0',
    viewer: '0.1.0',
    'screen-share': '0.2.1',
    server: '1.4.0',
    'server-gui': '1.4.0',
  },
  updatePackages: {},
  updateFolder: '',
  // メディア接続ポート設定(UTM/FW対策)。サーバープロセス起動時に環境変数として
  // 渡される。rtcPort: 固定ポート(空=従来のポート範囲)、extraTcpPorts: 443等の
  // 追加TCP待受(カンマ区切り)、announcedIp: ICE候補として広告するIP
  // (空=自動: サーバー自身の非内部IPv4を広告)。STUN/TURN は直結できない
  // 拠点向けの代替ICE経路としてクライアントへ配布する。
  network: {
    rtcPort: '',
    extraTcpPorts: '',
    announcedIp: '',
    stunUrls: '',
    turnUrls: '',
    turnUser: '',
    turnPass: '',
  },
  // ルーティン再起動(HH:MM、複数可)。serverRestartTimes はサーバープロセスの
  // 計画再起動(GUI監視下で自動復帰)、clientRestartTimes は全拠点クライアントへ
  // systemState 経由で同期され、各拠点が指定時刻にアプリを再起動する。
  maintenance: { serverRestartTimes: [], clientRestartTimes: [] },
  // サーバー録画設定。稼働中サーバーへは IPC(set-recording-settings) で即時適用され、
  // サーバー側でも recording-settings.json (userData配下) に永続化される。
  recording: {
    enabled: false,
    recordingsDir: '',        // 空 = userData/recordings。NASのマウント先も指定可
    dbDir: '',                // 空 = 保存先内の recording-db
    retentionDays: 14,
    segmentSeconds: 300,
    compressionMode: 'standard', // strong / standard / light / none
    recordScreen: false,
    recordAudio: true,        // 音声(マイク/画面共有音声)も録音。OFF=映像のみ
    timestampOverlay: true,   // 映像右下に日時を焼き込む
    ffmpegPath: '',           // 空 = 自動検出(同梱ffmpeg → システム)
    compressionConcurrency: 0, // 圧縮の並列数。0 = 自動(CPUコア数から2〜4)
    minFreeGb: 10,            // 保存先に常に確保する最低空き容量(GB)
  },
};

// ── アップデート配布フォルダ ──────────────────────────────
// ファイル名からアプリ種別とバージョンを自動判別する。
// 例: CHECKHOUSE-Meeting-Client-0.3.0-arm64.dmg → client / 0.3.0

const UPDATE_FILE_EXT = /\.(dmg|pkg|zip|exe|msi|appimage|deb|7z)$/i;
let updateFolderWatcher = null;
let updateFolderScanTimer = null;

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
  const match = String(name || '').match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/);
  return match ? match[1] : '';
}

function scanUpdateFolder(dir) {
  const result = { folder: dir || '', files: [], packages: {} };
  if (!dir || !fs.existsSync(dir)) return result;

  let names = [];
  try {
    // macOS の AppleDouble(._*)や .DS_Store 等の隠しファイルは除外する。
    // ._foo.dmg は拡張子・アプリ種別・バージョンの判定に一致してしまい、
    // 本物より新しい mtime だと配布パッケージとして登録され、クライアントの
    // ダウンロードが 404 (dotfile 拒否) になる実障害があった。
    names = fs.readdirSync(dir).filter(name => !name.startsWith('.') && UPDATE_FILE_EXT.test(name));
  } catch (err) {
    safeSend('server-log', `WARN: アップデートフォルダを読み取れません: ${err.message}`);
    return result;
  }

  for (const name of names) {
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    const appType = detectAppTypeFromFilename(name);
    const version = detectVersionFromFilename(name);
    const file = { name, appType, version, size: stat.size, mtimeMs: stat.mtimeMs };
    result.files.push(file);

    if (!appType || !version) continue;
    const existing = result.packages[appType];
    // 同一アプリが複数ある場合は新しい mtime を採用
    if (!existing || stat.mtimeMs > existing.mtimeMs) {
      result.packages[appType] = {
        version,
        url: `/updates/${encodeURIComponent(name)}`,
        notes: `自動検出: ${name}`,
        fileName: name,
        mtimeMs: stat.mtimeMs,
      };
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
      url: pkg.url,
      notes: pkg.notes,
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

// GUI自体の稼働状態（前回サーバーを動かしていたか）。アプリ再起動・OS再起動後に
// サーバーを自動復帰させるために使う。遠隔管理が前提のため「GUIを起動したのに
// サーバーが止まったまま」を防ぐことが最優先。
function guiStatePath() {
  return path.join(app.getPath('userData'), 'gui-state.json');
}

function readGuiState() {
  try {
    const raw = JSON.parse(fs.readFileSync(guiStatePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeGuiState(patch) {
  try {
    const next = { ...readGuiState(), ...patch };
    fs.mkdirSync(path.dirname(guiStatePath()), { recursive: true });
    fs.writeFileSync(guiStatePath(), JSON.stringify(next, null, 2));
  } catch { /* 保存失敗でも動作は継続 */ }
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
    if (entry?.private || entry?.temporary || id.startsWith(PRIVATE_CHANNEL_PREFIX)) continue;
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name });
  }
  return items.length ? items : DEFAULT_SYSTEM_SETTINGS.channels;
}

function sanitizePortText(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? String(n) : '';
}

function sanitizeIpListText(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => /^\d{1,3}(\.\d{1,3}){3}$/.test(part))
    .join(',');
}

function sanitizeIceUrlListText(value, allowedSchemes) {
  const allowed = new Set(allowedSchemes.map(item => String(item).toLowerCase()));
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => {
      if (!part || part.length > 512 || /[\s\u0000-\u001f\u007f]/.test(part)) return false;
      const match = /^(stuns?|turns?):(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(part);
      if (!match || !allowed.has(match[1].toLowerCase())) return false;
      return !match[2] || Number(match[2]) <= 65535;
    })
    .slice(0, 16)
    .join(',');
}

function sanitizeNetwork(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const extraTcpPorts = String(raw.extraTcpPorts ?? '')
    .split(',')
    .map(part => sanitizePortText(part))
    .filter(Boolean)
    .join(',');
  return {
    rtcPort: sanitizePortText(raw.rtcPort),
    extraTcpPorts,
    // ANNOUNCED_IP。空 = 自動（サーバー自身の非内部IPv4を全て広告）。
    // カンマ区切りで複数指定可（server/config.js が分割して解釈する）。
    announcedIp: sanitizeIpListText(raw.announcedIp),
    stunUrls: sanitizeIceUrlListText(raw.stunUrls, ['stun', 'stuns']),
    turnUrls: sanitizeIceUrlListText(raw.turnUrls, ['turn', 'turns']),
    turnUser: shortText(raw.turnUser, 256),
    turnPass: shortText(raw.turnPass, 256),
  };
}

/** "HH:MM" 形式の時刻リストを検証・正規化する(ゼロ埋め・重複除去・昇順・最大12件) */
function sanitizeRestartTimes(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const seen = new Set();
  for (const item of list.slice(0, 32)) {
    const match = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(item ?? ''));
    if (!match) continue;
    seen.add(`${match[1].padStart(2, '0')}:${match[2]}`);
  }
  return Array.from(seen).sort().slice(0, 12);
}

function sanitizeMaintenance(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    serverRestartTimes: sanitizeRestartTimes(raw.serverRestartTimes),
    clientRestartTimes: sanitizeRestartTimes(raw.clientRestartTimes),
  };
}

function sanitizeRecording(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    enabled: !!raw.enabled,
    recordingsDir: shortText(raw.recordingsDir, 1024),
    dbDir: shortText(raw.dbDir, 1024),
    retentionDays: clampInt(raw.retentionDays, 1, 3650, 14),
    segmentSeconds: clampInt(raw.segmentSeconds, 60, 3600, 300),
    compressionMode: ['strong', 'standard', 'light', 'none'].includes(raw.compressionMode)
      ? raw.compressionMode : 'standard',
    recordScreen: !!raw.recordScreen,
    recordAudio: raw.recordAudio === undefined ? true : !!raw.recordAudio,
    timestampOverlay: raw.timestampOverlay === undefined ? true : !!raw.timestampOverlay,
    ffmpegPath: shortText(raw.ffmpegPath, 1024),
    compressionConcurrency: clampInt(raw.compressionConcurrency, 0, 8, 0),
    minFreeGb: clampInt(raw.minFreeGb, 1, 1000, 10),
  };
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

  return {
    channels: sanitizeChannels(raw.channels),
    network: sanitizeNetwork(raw.network),
    recording: sanitizeRecording(raw.recording),
    maintenance: sanitizeMaintenance(raw.maintenance),
    updateFolder: shortText(raw.updateFolder, 1024),
    latestVersions: Object.fromEntries(Object.entries(latestVersions).map(([key, value]) => [key, shortText(value, 48)])),
    updatePackages: Object.fromEntries(Object.entries(updatePackages).map(([key, value]) => {
      const pkg = value && typeof value === 'object' ? value : {};
      return [key, {
        version: shortText(pkg.version || latestVersions[key] || '', 48),
        url: shortText(pkg.url, 1024),
        notes: shortText(pkg.notes, 1000),
        sha256: shortText(pkg.sha256, 128),
        required: !!pkg.required,
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

function persistRuntimeSystemState(state, source = 'server') {
  const current = readSystemSettings();
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const saved = writeSystemSettings({
    ...current,
    channels: raw.channels || current.channels,
    latestVersions: raw.latestVersions || current.latestVersions,
    updatePackages: raw.updatePackages || current.updatePackages,
    maintenance: raw.maintenance || current.maintenance,
  });
  safeSend('server-log', `[Settings] サーバー設定を保存しました source=${shortText(source, 80)} channels=${saved.channels.length}`);
  safeSend('system-settings-updated', saved);
  return saved;
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

  // 前回サーバー稼働中にGUIが終了(OS再起動・クラッシュ等)していた場合は
  // 自動でサーバーを復帰させる。手動停止していた場合は復帰しない。
  const guiState = readGuiState();
  if (guiState.serverRunning) {
    setTimeout(() => {
      if (serverProcess) return;
      safeSend('server-log', '--- 前回稼働状態を検出: サーバーを自動起動します ---');
      restartAttempts = 0;
      startServerProcess(guiState.serverDir || '', { automatic: true });
    }, 800);
  }

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

/** サーバーを停止→完全終了を待って再起動する(メディアポート設定の適用用) */
function restartServerProcess(reason) {
  if (!serverProcess) return;
  const dir = lastServerDir;
  safeSend('server-log', `--- サーバーを再起動します: ${reason} ---`);
  stopServerProcess({ manual: true });
  const waitStart = Date.now();
  const timer = setInterval(() => {
    if (serverProcess) {
      if (Date.now() - waitStart > 15000) {
        clearInterval(timer);
        safeSend('server-log', 'WARN: サーバー再起動待ちがタイムアウトしました。手動で起動してください。');
      }
      return;
    }
    clearInterval(timer);
    restartAttempts = 0;
    startServerProcess(dir, { automatic: true });
  }, 300);
}

ipcMain.handle('save-system-settings', (_event, rawSettings) => {
  const previousNetwork = JSON.stringify(readSystemSettings().network || {});
  const settings = writeSystemSettings(rawSettings);
  if (serverProcess) sendSystemSettingsToServer();
  // メディアポート設定はサーバープロセスの起動時にしか適用できないため、
  // 変更されていて稼働中なら自動で再起動して反映する。
  if (serverProcess && JSON.stringify(settings.network || {}) !== previousNetwork) {
    restartServerProcess('メディア接続ポート設定の変更適用');
  }
  return settings;
});

// ── 録画設定 ─────────────────────────────────────────────

ipcMain.handle('save-recording-settings', (_event, rawRecording) => {
  const settings = writeSystemSettings({ ...readSystemSettings(), recording: rawRecording });
  if (serverProcess) {
    sendToServer({ type: 'set-recording-settings', settings: settings.recording });
    safeSend('server-log', `[Recording] 録画設定を保存して適用しました (有効=${settings.recording.enabled ? 'ON' : 'OFF'} 保持=${settings.recording.retentionDays}日)`);
  } else {
    safeSend('server-log', '[Recording] 録画設定を保存しました(次回サーバー起動時に適用されます)');
  }
  return settings.recording;
});

/** 録画保存先/DB保存先などの汎用フォルダ選択(NASのマウント先も選択可) */
ipcMain.handle('select-any-folder', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: shortText(title, 120) || 'フォルダを選択',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

/** 録画タイムライン(ブラウザUI)を開く */
ipcMain.handle('open-recordings-ui', (_event, port) => {
  const p = Number(port) || 3000;
  return shell.openExternal(`http://127.0.0.1:${p}/recordings`);
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

  for (const file of ['index.js', 'config.js', 'recording.js', 'package.json', '.env.example', path.join('public', 'recordings.html')]) {
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

/**
 * 同梱 ffmpeg/ffprobe のパス解決。優先順:
 *   1. パッケージ版リソース (resources/ffmpeg/<platform>-<arch>/)
 *   2. 開発時: server/node_modules の ffmpeg-static / ffprobe-static
 * 見つかったパスは FFMPEG_PATH / FFPROBE_PATH としてサーバープロセスへ渡す。
 */
function getBundledFfmpegPaths() {
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const platformArch = `${process.platform}-${process.arch}`;
  const resourceDirs = [
    path.join(process.resourcesPath, 'ffmpeg', platformArch),
    path.join(__dirname, 'resources', 'ffmpeg', platformArch),
  ];
  for (const dir of resourceDirs) {
    const ffmpeg = path.join(dir, `ffmpeg${exeSuffix}`);
    if (fs.existsSync(ffmpeg)) {
      const ffprobe = path.join(dir, `ffprobe${exeSuffix}`);
      return { ffmpeg, ffprobe: fs.existsSync(ffprobe) ? ffprobe : null };
    }
  }
  // 開発時: server/node_modules から
  try {
    const serverModules = path.resolve(__dirname, '..', 'server', 'node_modules');
    const ffmpeg = require(path.join(serverModules, 'ffmpeg-static'));
    const ffprobe = require(path.join(serverModules, 'ffprobe-static')).path;
    if (ffmpeg && fs.existsSync(ffmpeg)) {
      return { ffmpeg, ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null };
    }
  } catch { /* サーバー側の自動検出(recording.js)に任せる */ }
  return null;
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
  // 通知音フォルダは userData 配下に置き、サーバー本体(server-runtime)を
  // アップデートで入れ替えてもインポート済みの通知音が消えないようにする。
  if (!env.RINGTONES_DIR) {
    env.RINGTONES_DIR = path.join(app.getPath('userData'), 'ringtones');
    try { fs.mkdirSync(env.RINGTONES_DIR, { recursive: true }); } catch { /* 起動は継続 */ }
  }
  // サーバーの永続状態(TCPフォールバック記憶など)は userData 配下に置き、
  // サーバー本体の更新・再起動をまたいで引き継がれるようにする。
  if (!env.SERVER_STATE_FILE) {
    env.SERVER_STATE_FILE = path.join(app.getPath('userData'), 'sfu-state.json');
  }
  // 録画設定も userData 配下に永続化する(既定の録画保存先も userData/recordings になる)。
  if (!env.RECORDING_SETTINGS_FILE) {
    env.RECORDING_SETTINGS_FILE = path.join(app.getPath('userData'), 'recording-settings.json');
  }
  // 同梱 ffmpeg/ffprobe(録画用)。システムへの ffmpeg インストールは不要。
  const bundledFfmpeg = getBundledFfmpegPaths();
  if (bundledFfmpeg) {
    if (!env.FFMPEG_PATH) env.FFMPEG_PATH = bundledFfmpeg.ffmpeg;
    if (!env.FFPROBE_PATH && bundledFfmpeg.ffprobe) env.FFPROBE_PATH = bundledFfmpeg.ffprobe;
    safeSend('server-log', `--- 同梱 ffmpeg: ${env.FFMPEG_PATH} ---`);
  } else {
    safeSend('server-log', 'WARN: 同梱 ffmpeg が見つかりません。録画にはシステムの ffmpeg または設定でのパス指定が必要です。');
  }
  // メディア接続ポート設定(GUIの設定タブ)。設定されている場合のみ環境変数として
  // 渡す(dotenvは既存の環境変数を上書きしないため、GUI設定が .env より優先される)。
  const network = readSystemSettings().network || {};
  if (network.rtcPort) env.RTC_PORT = network.rtcPort;
  if (network.extraTcpPorts) env.RTC_EXTRA_TCP_PORTS = network.extraTcpPorts;
  if (network.announcedIp) env.ANNOUNCED_IP = network.announcedIp;
  if (network.stunUrls) env.STUN_URLS = network.stunUrls;
  if (network.turnUrls) env.TURN_URLS = network.turnUrls;
  if (network.turnUser) env.TURN_USER = network.turnUser;
  if (network.turnPass) env.TURN_PASS = network.turnPass;
  
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
    } else if (msg.type === 'system-state-changed') {
      persistRuntimeSystemState(msg.state, msg.source);
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
  // 前回稼働状態として記録し、GUI再起動・OS再起動後の自動復帰に使う
  writeGuiState({ serverRunning: true, serverDir: selectedPath || '' });
  setTimeout(() => {
    if (!serverProcess) return;
    sendSystemSettingsToServer();
    // 録画設定を反映(サーバー側 recording-settings.json と同期)
    sendToServer({ type: 'set-recording-settings', settings: readSystemSettings().recording });
    const updateFolder = readSystemSettings().updateFolder;
    if (updateFolder) {
      sendToServer({ type: 'set-update-dir', dir: updateFolder });
      watchUpdateFolder(updateFolder);
      // 起動時に再スキャンして配布登録を実ファイルと同期する。
      // 以前のバージョンで ._AppleDouble ファイル等が誤登録されたまま
      // system-settings.json に残っていても、ここで正しい実体に上書きされる。
      applyUpdateScan(updateFolder, { announce: false });
    }
  }, 500);
}

ipcMain.on('start-server', (event, selectedPath) => {
  restartAttempts = 0;
  startServerProcess(selectedPath);
});

ipcMain.on('stop-server', () => {
  if (stoppingServer) return;
  // 手動停止は明示の意思なので、次回GUI起動時の自動復帰も止める
  writeGuiState({ serverRunning: false });
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
