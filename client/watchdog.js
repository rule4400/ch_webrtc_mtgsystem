const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let appProcess = null;

function startApp() {
  if (appProcess) {
    console.log('Killing existing app process...');
    try {
      process.kill(-appProcess.pid);
    } catch (e) {
      // ignore
    }
  }
  
  console.log('Starting Electron app...');
  // 開発モードの場合は npm run electron:start を実行
  // 本番環境（パッケージ化後）の場合は、ビルドされたバイナリを直接指定する
  appProcess = spawn('npm', ['run', 'electron:start'], {
    cwd: __dirname,
    detached: true,
    stdio: 'inherit'
  });
  
  appProcess.on('exit', (code) => {
    console.log(`Electron app exited with code ${code}.`);
    // 予期せぬ終了の場合は自動的に再起動
    if (code !== 0) {
      setTimeout(startApp, 3000);
    }
  });
}

function initWatchdog() {
  // サーバーのIPは引数や環境変数、もしくは設定ファイルから取得する想定。
  // 今回は開発用のデフォルトポートに接続
  const serverUrl = process.env.SFU_SERVER_URL || 'http://127.0.0.1:3000';
  const socket = io(serverUrl);

  socket.on('connect', () => {
    console.log('Watchdog connected to SFU server');
    // サーバーにウォッチドッグとして認識させる
    socket.emit('registerWatchdog', { clientId: 'client_1' });
  });

  // サーバーからの強制再起動コマンド
  socket.on('restartCommand', (_payload, ack) => {
    if (typeof ack === 'function') {
      ack({ ok: true, socketId: socket.id, receivedAt: Date.now(), watcher: true });
    }
    console.log('Received restartCommand from SFU server! Force restarting app...');
    startApp();
  });
  
  socket.on('disconnect', () => {
    console.log('Watchdog disconnected from server');
  });
}

console.log('--- SFU Watchdog Daemon Started ---');
startApp();
initWatchdog();
