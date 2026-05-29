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

  const serverDir = selectedPath;
  if (!serverDir || !fs.existsSync(serverDir)) {
    safeSend('server-log', `ERROR: 有効なサーバーディレクトリを選択してください。\n指定されたパス: ${serverDir}`);
    return;
  }

  lastServerDir = serverDir;
  manualStop = false;
  safeSend('server-log', automatic ? `--- サーバー自動再起動: ${serverDir} ---` : `--- サーバー起動開始: ${serverDir} ---`);
  
  // IPCチャネルを開いてNodeプロセスを起動
  serverProcess = spawn('node', ['index.js'], { 
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'] 
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

ipcMain.on('restart-all', () => {
  if (serverProcess && serverProcess.send) {
    serverProcess.send({ type: 'restart-all' });
  }
});
