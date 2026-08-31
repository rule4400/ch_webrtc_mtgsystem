/**
 * CHECKHOUSE Recording Viewer
 *
 * サーバーで録画された各拠点の映像を確認する専用アプリケーション。
 * 2つのデータソースモードを持つ:
 *
 *   server: 稼働中の会議サーバー(http://IP:3000)の /recordings/api/* を叩く。
 *           映像は <video src="http://..."> で直接ストリーミング再生。
 *   folder: 録画データのフォルダ(NASのマウント先やローカルパス)を直接読む。
 *           サーバーが停止していても、NAS上のインデックス(recording-db)と
 *           セグメントファイルだけで再生できる。映像は recmedia:// カスタム
 *           プロトコル(Range対応)で配信する。
 *
 * UI は server/public/recordings.html と同一の ui/recordings.html。
 * preload の window.recviewer ブリッジ経由でデータを取得する。
 */

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

let mainWindow;

// recmedia:// はストリーミング(Range)と fetch を許可した特権スキームとして登録する
protocol.registerSchemesAsPrivileged([
  { scheme: 'recmedia', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

// ── 設定(データソース)の永続化 ────────────────────────────

function configPath() {
  return path.join(app.getPath('userData'), 'viewer-settings.json');
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (raw && typeof raw === 'object') return { mode: 'server', serverUrl: '', folder: '', dbFolder: '', configured: false, ...raw };
  } catch { /* 初回起動 */ }
  return { mode: 'server', serverUrl: '', folder: '', dbFolder: '', configured: false };
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch, configured: true };
  next.serverUrl = String(next.serverUrl || '').trim().replace(/\/+$/, '');
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

// ── フォルダ直読みモード(NAS/ローカル) ────────────────────
// server/recording.js が書き出す JSON インデックスをそのまま読む。
//   <dbDir>/locations.json
//   <dbDir>/segments/<locKey>__<source>/<YYYY-MM-DD>.json

function recordingsDirOf(config) {
  return config.folder || '';
}

function dbDirOf(config) {
  return config.dbFolder || (config.folder ? path.join(config.folder, 'recording-db') : '');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function folderLocations(config) {
  const dbDir = dbDirOf(config);
  const locations = readJson(path.join(dbDir, 'locations.json'), {}) || {};
  return Object.entries(locations)
    .map(([key, value]) => {
      const item = value && typeof value === 'object' ? value : {};
      return {
        key,
        locKey: item.locKey || '',
        source: item.source || 'camera',
        locationName: String(item.locationName || item.locKey || key),
        lastSegmentAt: Number(item.lastSegmentAt) || 0,
        recording: false, // 直読みモードでは録画中かは判定できない
      };
    })
    .filter(item => item.locKey)
    .sort((a, b) => a.locationName.localeCompare(b.locationName, 'ja'));
}

function folderSegments(config, { keys, from, to }) {
  const dbDir = dbDirOf(config);
  const wanted = Array.isArray(keys) && keys.length
    ? keys
    : folderLocations(config).map(l => l.key);
  const results = [];
  for (const key of wanted.slice(0, 64)) {
    const sep = String(key).lastIndexOf('__');
    if (sep <= 0) continue;
    const locKey = key.slice(0, sep);
    const source = key.slice(sep + 2);
    for (let dayMs = from - 86400e3; dayMs < to + 86400e3; dayMs += 86400e3) {
      const dayFile = path.join(dbDir, 'segments', `${locKey}__${source}`, `${fmtDate(dayMs)}.json`);
      const data = readJson(dayFile, null);
      if (!data || !Array.isArray(data.segments)) continue;
      for (const seg of data.segments) {
        const segEnd = seg.startMs + (seg.durationMs || 0);
        if (segEnd <= from || seg.startMs >= to) continue;
        results.push({
          ...seg,
          key,
          locKey,
          source,
          mediaUrl: `recmedia://media/${encodeURIComponent(seg.id)}`,
        });
      }
    }
  }
  results.sort((a, b) => a.startMs - b.startMs);
  return results.slice(0, 5000);
}

/** セグメントID → 実ファイルパス(recmedia:// 配信用) */
function folderResolveMedia(config, id) {
  const parts = String(id || '').split('~');
  if (parts.length !== 5) return null;
  const [locKey, source, dateStr] = parts;
  const dayFile = path.join(dbDirOf(config), 'segments', `${locKey}__${source}`, `${dateStr}.json`);
  const data = readJson(dayFile, null);
  if (!data || !Array.isArray(data.segments)) return null;
  const seg = data.segments.find(s => s.id === id);
  if (!seg || !seg.file) return null;
  const root = path.resolve(recordingsDirOf(config));
  const abs = path.resolve(root, seg.file);
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

// ── サーバー接続モード ────────────────────────────────────

async function serverApi(config, apiPath) {
  if (!config.serverUrl) throw new Error('サーバーURLが設定されていません(⚙ データソースから設定)');
  const response = await net.fetch(`${config.serverUrl}${apiPath}`);
  if (!response.ok) throw new Error(`サーバー応答エラー: ${response.status}`);
  return response.json();
}

// ── Range対応のファイル配信(フォルダ直読みモードの映像再生) ──

function mimeOf(filePath) {
  if (filePath.endsWith('.mp4')) return 'video/mp4';
  if (filePath.endsWith('.webm')) return 'video/webm';
  return 'video/x-matroska';
}

function fileResponse(filePath, rangeHeader) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response('not found', { status: 404 });
  }
  const total = stat.size;
  const mime = mimeOf(filePath);
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (match && (match[1] || match[2])) {
    let start = match[1] ? parseInt(match[1], 10) : total - parseInt(match[2], 10);
    let end = match[1] && match[2] ? parseInt(match[2], 10) : total - 1;
    start = Math.max(0, start);
    end = Math.min(end, total - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total),
    },
  });
}

// ── アプリ本体 ────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'CHECKHOUSE Recording Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'recordings.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  protocol.handle('recmedia', (request) => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const filePath = folderResolveMedia(readConfig(), id);
      if (!filePath) return new Response('not found', { status: 404 });
      return fileResponse(filePath, request.headers.get('Range'));
    } catch (err) {
      return new Response(`error: ${err.message}`, { status: 500 });
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC(preload ブリッジ) ─────────────────────────────────

ipcMain.handle('rv-get-config', () => readConfig());

ipcMain.handle('rv-set-config', (_event, patch) => {
  const clean = patch && typeof patch === 'object' ? patch : {};
  return writeConfig({
    mode: clean.mode === 'folder' ? 'folder' : 'server',
    serverUrl: String(clean.serverUrl || ''),
    folder: String(clean.folder || ''),
    dbFolder: String(clean.dbFolder || ''),
  });
});

ipcMain.handle('rv-choose-folder', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: String(title || 'フォルダを選択'),
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('rv-status', async () => {
  const config = readConfig();
  if (config.mode === 'folder') {
    const dir = recordingsDirOf(config);
    const dbOk = dir && fs.existsSync(path.join(dbDirOf(config), 'locations.json'));
    return {
      folderMode: true,
      folder: dir || '(未設定)',
      dbOk,
      storageOk: !!dir && fs.existsSync(dir),
    };
  }
  return serverApi(config, '/recordings/api/status');
});

ipcMain.handle('rv-locations', async () => {
  const config = readConfig();
  if (config.mode === 'folder') return folderLocations(config);
  const data = await serverApi(config, '/recordings/api/locations');
  return data.locations || [];
});

// ライブ視聴セッション一覧。サーバー接続モードのみ(フォルダ直読みでは不可)。
// liveUrl はサーバーの追記追従ストリームURLへ変換し、<video> が直接受信する。
ipcMain.handle('rv-live', async () => {
  const config = readConfig();
  if (config.mode === 'folder') return [];
  try {
    const data = await serverApi(config, '/recordings/api/live');
    return (data.sessions || []).map(session => ({
      ...session,
      liveUrl: session.liveUrl && session.liveUrl.startsWith('/') ? `${config.serverUrl}${session.liveUrl}` : session.liveUrl,
    }));
  } catch {
    return [];
  }
});

ipcMain.handle('rv-segments', async (_event, query) => {
  const config = readConfig();
  const q = query && typeof query === 'object' ? query : {};
  const from = Number(q.from);
  const to = Number(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const keys = Array.isArray(q.keys) ? q.keys : null;

  if (config.mode === 'folder') return folderSegments(config, { keys, from, to });

  const params = new URLSearchParams({ from: String(from), to: String(to) });
  if (keys && keys.length) params.set('keys', keys.join(','));
  const data = await serverApi(config, `/recordings/api/segments?${params}`);
  // 相対 mediaUrl をサーバーURL基準の絶対URLへ変換(<video> が直接再生する)
  return (data.segments || []).map(seg => ({
    ...seg,
    mediaUrl: seg.mediaUrl && seg.mediaUrl.startsWith('/') ? `${config.serverUrl}${seg.mediaUrl}` : seg.mediaUrl,
  }));
});
