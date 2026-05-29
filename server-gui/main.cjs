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

const SERVER_RUNTIME_DIR = 'server-runtime';

/** ウィンドウが生きている場合のみ IPC 送信（終了時クラッシュ防止） */
function safeSend(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
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
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  manualStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  mainWindow = null; // safeSend がウィンドウ破棄後に送信しないようにする
  if (process.platform !== 'darwin') app.quit();
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
  safeSend('server-log', `WARN: 旧バージョンのサンプル ANNOUNCED_IP=10.0.0.10 を無効化しました。必要に応じて Settings の .env を実際のVPN内IPに変更してください: ${envPath}`);
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
  manualStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
    safeSend('server-status', 'Stopped');
    safeSend('server-log', '--- サーバーを手動停止しました ---');
  }
});

// Admin commands
ipcMain.on('kick-client', (event, socketId) => {
  if (serverProcess && serverProcess.send) {
    serverProcess.send({ type: 'kick', socketId });
  }
});

ipcMain.on('restart-client', (_event, socketId) => {
  if (serverProcess && serverProcess.send) {
    safeSend('server-log', `[Admin] クライアント個別再起動を送信: ${socketId}`);
    serverProcess.send({ type: 'restart-client', socketId });
  }
});

ipcMain.on('set-client-device', (_event, { socketId, kind, deviceId }) => {
  if (serverProcess && serverProcess.send) {
    safeSend('server-log', `[Admin] デバイス切替を送信: ${socketId} ${kind}`);
    serverProcess.send({ type: 'set-client-device', socketId, kind, deviceId });
  }
});

ipcMain.on('refresh-client-devices', (_event, socketId) => {
  if (serverProcess && serverProcess.send) {
    serverProcess.send({ type: 'refresh-client-devices', socketId });
  }
});

ipcMain.on('restart-all', () => {
  if (serverProcess && serverProcess.send) {
    safeSend('server-log', '[Admin] 全クライアントへ再起動信号を送信しました');
    serverProcess.send({ type: 'restart-all' });
  } else {
    safeSend('server-log', 'WARN: サーバー未起動のため、再起動信号を送信できません');
  }
});
