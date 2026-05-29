const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

let mainWindow;
let restartInProgress = false;

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
    // loadFile の代わりに file:// URL で明示的に読み込む
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadURL(`file://${indexPath}`);
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // 読み込み失敗時のログ
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Load] failed  code=${code}  url=${url}  ${desc}`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 3000);
  });

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
}

app.whenReady().then(async () => {
  await honorRestartDelay();

  // カメラ・マイク権限を許可
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'display-capture'];
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
