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

const { app, BrowserWindow, ipcMain, dialog, protocol, net, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  openVerifiedMediaFile,
  recordingFileResponse,
  serverMediaFetchOptions,
  validateServerMediaPath,
} = require('./media-file.cjs');
const { readPrivateFileSync, writePrivateFileAtomicSync } = require('./private-file.cjs');

let mainWindow;
let cachedConfig = null;
const UI_FILE = path.join(__dirname, 'ui', 'recordings.html');
const UI_URL = pathToFileURL(UI_FILE).href;

// recmedia:// はストリーミング(Range)と fetch を許可した特権スキームとして登録する
protocol.registerSchemesAsPrivileged([
  { scheme: 'recmedia', privileges: { stream: true, supportFetchAPI: true } },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// ── 設定(データソース)の永続化 ────────────────────────────

function configPath() {
  return path.join(app.getPath('userData'), 'viewer-settings.json');
}

const DEFAULT_CONFIG = {
  mode: 'server',
  serverUrl: '',
  accessToken: '',
  folder: '',
  dbFolder: '',
  configured: false,
};

function normalizeServerUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 2048) throw new Error('サーバーURLが長すぎます');
  let url;
  try { url = new URL(raw); } catch { throw new Error('サーバーURLが不正です'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('サーバーURLは認証情報を含まない http/https に限ります');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('サーバーURLにパス、query、fragmentは指定できません');
  }
  return url.origin;
}

function decryptAccessToken(raw) {
  const encoded = String(raw.accessTokenEncrypted || '');
  if (encoded && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); } catch { /* invalid/old data */ }
  }
  return String(raw.accessToken || '');
}

function persistedConfig(config) {
  const output = { ...config };
  const token = String(output.accessToken || '');
  delete output.accessToken;
  delete output.hasAccessToken;
  if (token && safeStorage.isEncryptionAvailable()) {
    output.accessTokenEncrypted = safeStorage.encryptString(token).toString('base64');
  } else if (token) {
    // safeStorageが利用できないOSでも、0600の設定ファイルに限定する。
    output.accessToken = token;
    delete output.accessTokenEncrypted;
  } else {
    delete output.accessTokenEncrypted;
  }
  return output;
}

function publicConfig(config) {
  const exposed = { ...config };
  // renderer は秘密値そのものだけでなく、OS keychain で暗号化した blob も不要。
  // 設定画面には有無とマスクだけを返す。
  delete exposed.accessTokenEncrypted;
  return {
    ...exposed,
    accessToken: config.accessToken ? '********' : '',
    hasAccessToken: !!config.accessToken,
  };
}

function readConfig() {
  if (cachedConfig) return { ...cachedConfig };
  let serialized;
  try {
    serialized = readPrivateFileSync(configPath(), 'utf8', {
      warn: message => console.warn(message),
    });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  try {
    const raw = JSON.parse(serialized);
    if (raw && typeof raw === 'object') {
      cachedConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        serverUrl: normalizeServerUrl(raw.serverUrl),
        accessToken: decryptAccessToken(raw).trim().slice(0, 2048),
      };
      return { ...cachedConfig };
    }
  } catch { /* 初回起動 */ }
  cachedConfig = { ...DEFAULT_CONFIG };
  return { ...cachedConfig };
}

function writeConfig(patch) {
  const current = readConfig();
  const serverUrl = normalizeServerUrl(patch.serverUrl == null ? current.serverUrl : patch.serverUrl);
  const requestedToken = patch.accessToken;
  const maskedToken = requestedToken == null || requestedToken === '********';
  if (maskedToken && current.accessToken && serverUrl !== current.serverUrl) {
    throw new Error('サーバーURLを変更する場合は、録画閲覧トークンを再入力してください');
  }
  const accessToken = maskedToken ? current.accessToken : String(requestedToken).trim().slice(0, 2048);
  const next = { ...current, ...patch, serverUrl, accessToken, configured: true };
  const targetPath = configPath();
  writePrivateFileAtomicSync(targetPath, JSON.stringify(persistedConfig(next), null, 2), {
    warn: message => console.warn(message),
  });
  cachedConfig = { ...next };
  clearJsonFileCache();
  return publicConfig(next);
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

const JSON_FILE_MAX_BYTES = 2 * 1024 * 1024;
const JSON_CACHE_ITEM_MAX_BYTES = 1024 * 1024;
const JSON_CACHE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const jsonFileCache = new Map();
const jsonReadInFlight = new Map();
let jsonFileCacheBytes = 0;

function clearJsonFileCache() {
  jsonFileCache.clear();
  jsonFileCacheBytes = 0;
}

function hasStableFileIdentity(stat) {
  return Number(stat?.dev) !== 0 && Number(stat?.ino) !== 0;
}

function sameJsonFileVersion(cached, stat) {
  if (!cached || !stat || cached.mtimeMs !== stat.mtimeMs ||
      cached.ctimeMs !== stat.ctimeMs || cached.size !== stat.size) return false;
  if (!hasStableFileIdentity(cached) || !hasStableFileIdentity(stat)) return true;
  return cached.dev === stat.dev && cached.ino === stat.ino;
}

function deleteJsonCacheEntry(filePath) {
  const cached = jsonFileCache.get(filePath);
  if (!cached) return;
  jsonFileCache.delete(filePath);
  jsonFileCacheBytes = Math.max(0, jsonFileCacheBytes - (cached.cacheBytes ?? cached.size));
}

async function readJson(filePath, fallback = null, expectedPathStat = null) {
  const activeRead = jsonReadInFlight.get(filePath);
  if (activeRead) {
    try { return (await activeRead).value; } catch { return fallback; }
  }
  const readPromise = (async () => {
    // O_NOFOLLOW is not available on every packaged platform.  lstat plus the
    // opened descriptor's identity rejects both an existing final-component
    // symlink and a regular-file-to-symlink replacement during open.
    const pathStat = expectedPathStat || await fs.promises.lstat(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() ||
        !Number.isSafeInteger(pathStat.size) || pathStat.size < 0 ||
        pathStat.size > JSON_FILE_MAX_BYTES) {
      throw new Error('JSON file too large or invalid');
    }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 ||
          stat.size > JSON_FILE_MAX_BYTES ||
          (hasStableFileIdentity(pathStat) && hasStableFileIdentity(stat) &&
            (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino))) {
        throw new Error('JSON file changed while opening');
      }
      const cached = jsonFileCache.get(filePath);
      if (sameJsonFileVersion(cached, stat)) {
        return {
          value: cached.value,
          stat,
          bytesRead: cached.cacheBytes ?? cached.size,
          fromCache: true,
        };
      }
      // 最初のlstat後にファイルが成長しても、同じFDから上限+1 byteまでしか読まない。
      const buffer = Buffer.alloc(JSON_FILE_MAX_BYTES + 1);
      let total = 0;
      while (total < JSON_FILE_MAX_BYTES + 1) {
        const remaining = JSON_FILE_MAX_BYTES + 1 - total;
        const { bytesRead } = await handle.read(buffer, total, remaining, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > JSON_FILE_MAX_BYTES) throw new Error('JSON file too large');
      const finalStat = await handle.stat();
      // Atomic index writers leave an opened inode unchanged.  In-place growth,
      // truncation or rewrite can otherwise produce a torn parse and make the
      // pre-read size under-count cache usage, so retry on the next request.
      if (!sameJsonFileVersion(stat, finalStat) || total !== finalStat.size) {
        throw new Error('JSON file changed while reading');
      }
      return {
        value: JSON.parse(buffer.subarray(0, total).toString('utf8')),
        stat: finalStat,
        bytesRead: total,
        fromCache: false,
      };
    } finally {
      await handle.close().catch(() => {});
    }
  })();
  jsonReadInFlight.set(filePath, readPromise);
  try {
    const { value, stat, bytesRead, fromCache } = await readPromise;
    if (fromCache) return value;
    deleteJsonCacheEntry(filePath);
    if (bytesRead <= JSON_CACHE_ITEM_MAX_BYTES) {
      jsonFileCache.set(filePath, {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        cacheBytes: bytesRead,
        value,
      });
      jsonFileCacheBytes += bytesRead;
      while (jsonFileCacheBytes > JSON_CACHE_TOTAL_MAX_BYTES || jsonFileCache.size > 64) {
        const oldestKey = jsonFileCache.keys().next().value;
        const oldest = jsonFileCache.get(oldestKey);
        jsonFileCache.delete(oldestKey);
        jsonFileCacheBytes = Math.max(
          0,
          jsonFileCacheBytes - (oldest?.cacheBytes ?? oldest?.size ?? 0),
        );
      }
    }
    return value;
  } catch {
    // A removed, replaced, invalid or newly oversized file must not leave a
    // stale parsed object eligible for a later same-size/mtime cache hit.
    deleteJsonCacheEntry(filePath);
    return fallback;
  } finally {
    if (jsonReadInFlight.get(filePath) === readPromise) jsonReadInFlight.delete(filePath);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SEGMENT_QUERY_RANGE_MS = 31 * DAY_MS;
const MAX_SEGMENT_QUERY_DAYS = 33;
const MAX_DATE_MS = 8_640_000_000_000_000;
const RECORDING_KEY_RE = /^[a-z0-9_-]{1,48}__(camera|screen)$/;
const LOCATION_KEY_RE = /^[a-z0-9_-]{1,48}$/;
const RECORDING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLocationRecord(value) {
  const item = value && typeof value === 'object' ? value : {};
  const key = String(item.key || '').slice(0, 64);
  const locKey = String(item.locKey || '').slice(0, 48);
  const source = String(item.source || 'camera').slice(0, 16);
  if (!RECORDING_KEY_RE.test(key) || !LOCATION_KEY_RE.test(locKey) ||
      !['camera', 'screen'].includes(source) || key !== `${locKey}__${source}`) return null;
  return {
    key,
    locKey,
    source,
    locationName: String(item.locationName || locKey).slice(0, 160),
    lastSegmentAt: finiteNumber(item.lastSegmentAt),
    recording: !!item.recording,
  };
}

function normalizeSegmentRecord(value, overrides = {}) {
  const item = value && typeof value === 'object' ? value : {};
  const id = String(item.id || '').slice(0, 256);
  const key = String(overrides.key ?? item.key ?? '').slice(0, 64);
  const locKey = String(overrides.locKey ?? item.locKey ?? '').slice(0, 48);
  const source = String(overrides.source ?? item.source ?? 'camera').slice(0, 16);
  const startMs = Number(item.startMs);
  const durationMs = Number(item.durationMs);
  if (!id || !RECORDING_KEY_RE.test(key) || !LOCATION_KEY_RE.test(locKey) ||
      !['camera', 'screen'].includes(source) || key !== `${locKey}__${source}` ||
      !Number.isSafeInteger(startMs) || !Number.isFinite(durationMs) ||
      durationMs < 0 || durationMs > DAY_MS) return null;
  return {
    id,
    key,
    locKey,
    source,
    startMs,
    durationMs,
    size: Math.max(0, finiteNumber(item.size)),
    codec: String(item.codec || '').slice(0, 32),
    audio: !!item.audio,
    status: String(item.status || '').slice(0, 32),
    mediaUrl: String(overrides.mediaUrl ?? item.mediaUrl ?? '').slice(0, 1024),
  };
}

function normalizeLiveRecord(value) {
  const item = value && typeof value === 'object' ? value : {};
  const key = String(item.key || '').slice(0, 64);
  const locKey = String(item.locKey || '').slice(0, 48);
  const source = String(item.source || 'camera').slice(0, 16);
  const livePath = validateServerMediaPath(String(item.liveUrl || '').slice(0, 512), 'live');
  if (!RECORDING_KEY_RE.test(key) || !LOCATION_KEY_RE.test(locKey) ||
      !['camera', 'screen'].includes(source) || key !== `${locKey}__${source}` ||
      !livePath) return null;
  return {
    key,
    locKey,
    source,
    locationName: String(item.locationName || locKey).slice(0, 160),
    hasAudio: !!item.hasAudio,
    startedAt: finiteNumber(item.startedAt),
    liveUrl: `recmedia://server${livePath}`,
  };
}

function normalizeSegmentQueryWindow(fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) return null;
  if (from < -MAX_DATE_MS + DAY_MS || to > MAX_DATE_MS - DAY_MS) return null;
  if (to - from > MAX_SEGMENT_QUERY_RANGE_MS) return null;

  const firstDayMs = from - DAY_MS;
  const stopDayMs = to + DAY_MS;
  const dayCount = Math.ceil((stopDayMs - firstDayMs) / DAY_MS);
  if (!Number.isSafeInteger(dayCount) || dayCount < 1 || dayCount > MAX_SEGMENT_QUERY_DAYS) return null;
  return { from, to, firstDayMs, dayCount };
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function folderLocations(config) {
  const dbDir = dbDirOf(config);
  const rawLocations = await readJson(path.join(dbDir, 'locations.json'), {});
  if (!rawLocations || typeof rawLocations !== 'object' || Array.isArray(rawLocations)) return [];
  const prototype = Object.getPrototypeOf(rawLocations);
  if (prototype !== Object.prototype && prototype !== null) return [];
  const result = [];
  let scanned = 0;
  for (const key in rawLocations) {
    if (!Object.prototype.hasOwnProperty.call(rawLocations, key)) continue;
    scanned += 1;
    if (scanned > 1024 || result.length >= 256) break;
    const value = rawLocations[key];
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = normalizeLocationRecord({
      key: String(key).slice(0, 64),
      locKey: String(item.locKey || '').slice(0, 48),
      source: String(item.source || 'camera').slice(0, 16),
      locationName: String(item.locationName || item.locKey || key).slice(0, 160),
      lastSegmentAt: Number(item.lastSegmentAt) || 0,
      recording: false, // 直読みモードでは録画中かは判定できない
    });
    if (normalized) result.push(normalized);
  }
  return result.sort((a, b) => a.locationName.localeCompare(b.locationName, 'ja'));
}

async function folderSegments(config, { keys, from, to }) {
  const queryWindow = normalizeSegmentQueryWindow(from, to);
  if (!queryWindow) return [];
  ({ from, to } = queryWindow);
  const dbDir = dbDirOf(config);
  const knownKeys = new Set((await folderLocations(config)).map(item => item.key));
  const wantedRaw = Array.isArray(keys) && keys.length
    ? keys
    : [...knownKeys];
  const wanted = [...new Set(wantedRaw.map(key => String(key)))].filter(key => (
    RECORDING_KEY_RE.test(key) && knownKeys.has(key)
  ));
  const results = [];
  let filesRead = 0;
  let bytesRead = 0;
  let segmentsScanned = 0;
  let exhaustedBudget = false;
  for (const key of wanted.slice(0, 64)) {
    const sep = String(key).lastIndexOf('__');
    if (sep <= 0) continue;
    const locKey = key.slice(0, sep);
    const source = key.slice(sep + 2);
    for (let dayIndex = 0; dayIndex < queryWindow.dayCount; dayIndex += 1) {
      const dayMs = queryWindow.firstDayMs + dayIndex * DAY_MS;
      const dayFile = path.join(dbDir, 'segments', `${locKey}__${source}`, `${fmtDate(dayMs)}.json`);
      let stat;
      try { stat = await fs.promises.lstat(dayFile); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JSON_FILE_MAX_BYTES) continue;
      if (filesRead >= 256 || bytesRead + stat.size > 64 * 1024 * 1024) {
        exhaustedBudget = true;
        break;
      }
      filesRead += 1;
      bytesRead += stat.size;
      const data = await readJson(dayFile, null, stat);
      if (!data || !Array.isArray(data.segments)) continue;
      for (const seg of data.segments) {
        segmentsScanned += 1;
        if (segmentsScanned > 100_000 || results.length >= 10_000) {
          exhaustedBudget = true;
          break;
        }
        const normalized = normalizeSegmentRecord(seg, {
          key,
          locKey,
          source,
          mediaUrl: `recmedia://media/${encodeURIComponent(String(seg?.id || '').slice(0, 256))}`,
        });
        if (!normalized) continue;
        const segEnd = normalized.startMs + normalized.durationMs;
        if (segEnd <= from || normalized.startMs >= to) continue;
        results.push(normalized);
      }
      if (exhaustedBudget) break;
    }
    if (exhaustedBudget) break;
  }
  results.sort((a, b) => a.startMs - b.startMs);
  return results.slice(0, 5000);
}

/** セグメントID → 検証済みFileHandle(recmedia:// 配信用) */
async function folderOpenMedia(config, id) {
  const cleanId = String(id || '');
  if (cleanId.length > 256) return null;
  const parts = cleanId.split('~');
  if (parts.length !== 5) return null;
  const [locKey, source, dateStr] = parts;
  const key = `${locKey}__${source}`;
  if (!LOCATION_KEY_RE.test(locKey) || !['camera', 'screen'].includes(source) ||
      !RECORDING_DATE_RE.test(dateStr) || !(await folderLocations(config)).some(item => item.key === key)) return null;
  const dayFile = path.join(dbDirOf(config), 'segments', `${locKey}__${source}`, `${dateStr}.json`);
  const data = await readJson(dayFile, null);
  if (!data || !Array.isArray(data.segments)) return null;
  let seg = null;
  let segmentsScanned = 0;
  for (const candidate of data.segments) {
    segmentsScanned += 1;
    if (segmentsScanned > 100_000) break;
    if (candidate?.id === cleanId) {
      seg = candidate;
      break;
    }
  }
  if (!seg || typeof seg.file !== 'string' || !seg.file || seg.file.length > 4096) return null;
  const configuredRoot = recordingsDirOf(config);
  return openVerifiedMediaFile(configuredRoot, seg.file);
}

// ── サーバー接続モード ────────────────────────────────────

/** 動画stream用。header取得期限だけを掛け、bodyはResponseとしてChromiumへ渡す。 */
async function fetchStreamResponse(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const { signal: callerSignal = null, ...fetchOptions } = options;
  // The timeout is only a response-header deadline.  Once headers arrive the
  // caller's signal remains part of the Fetch signal, so cancelling a video or
  // closing the window still tears down an indefinite live upstream body.
  const fetchSignal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await net.fetch(url, {
      ...fetchOptions,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: fetchSignal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** JSON API用。body読了までdeadlineと累積byte上限を維持する。 */
async function fetchJsonResponse(url, options = {}, timeoutMs = 10_000, maxBytes = 10 * 1024 * 1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader = null;
  try {
    const response = await net.fetch(url, {
      ...options,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`サーバー応答エラー: ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('サーバー応答がJSONではありません');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error('サーバー応答が大きすぎます');
    }
    if (!response.body) throw new Error('サーバー応答本文がありません');
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response too large').catch(() => {});
        throw new Error('サーバー応答が大きすぎます');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (err) {
    if (controller.signal.aborted) throw new Error('サーバー応答がタイムアウトしました');
    throw err;
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) await reader?.cancel().catch(() => {});
  }
}

async function serverApi(config, apiPath) {
  if (!config.serverUrl) throw new Error('サーバーURLが設定されていません(⚙ データソースから設定)');
  const headers = config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {};
  return fetchJsonResponse(`${config.serverUrl}${apiPath}`, { headers });
}

async function clearLegacyRecordingCookie(serverUrl) {
  if (!serverUrl || !session.defaultSession) return;
  try {
    await session.defaultSession.cookies.remove(`${serverUrl}/recordings`, 'sfu_recording_session');
  } catch { /* 旧版が保存したcookieの掃除に失敗してもBearer-only通信は継続できる */ }
}

// ── アプリ本体 ────────────────────────────────────────────

function isTrustedRendererUrl(rawUrl) {
  const value = String(rawUrl || '');
  return value === UI_URL || value.startsWith(`${UI_URL}#`);
}

function requireTrustedIpcSender(event) {
  const senderFrame = event.senderFrame;
  const senderUrl = senderFrame?.url || '';
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      !senderFrame || senderFrame !== mainWindow.webContents.mainFrame ||
      !isTrustedRendererUrl(senderUrl)) throw new Error('untrusted IPC sender');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'CHECKHOUSE Recording Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.loadFile(UI_FILE);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('recmedia', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host === 'server' && !url.username && !url.password) {
        const config = readConfig();
        if (config.mode !== 'server' || !config.serverUrl) return new Response('server source unavailable', { status: 404 });
        const mediaPath = validateServerMediaPath(url.pathname);
        if (!mediaPath) {
          return new Response('invalid server media path', { status: 400 });
        }
        const fetchOptions = serverMediaFetchOptions(request, config.accessToken);
        if (!fetchOptions) {
          return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        const response = await fetchStreamResponse(`${config.serverUrl}${mediaPath}`, {
          ...fetchOptions,
          signal: request.signal,
        });
        // Preserve a valid byte-range rejection, including Content-Range:
        // bytes */size.  The upstream error body is still cancelled so a
        // renderer which does not consume 416 bodies cannot retain a stream.
        if (response.status === 416) {
          const headers = {};
          for (const name of ['Content-Range', 'Accept-Ranges', 'Cache-Control']) {
            const value = response.headers.get(name);
            if (value) headers[name] = value;
          }
          await response.body?.cancel().catch(() => {});
          return new Response(null, { status: 416, headers });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const status = response.status >= 400 && response.status <= 599
            ? response.status
            : 502;
          return new Response('server media unavailable', { status });
        }
        return response;
      }
      if (url.host !== 'media' || url.username || url.password) {
        return new Response('not found', { status: 404 });
      }
      const config = readConfig();
      if (config.mode !== 'folder') return new Response('folder source unavailable', { status: 404 });
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const opened = await folderOpenMedia(config, id);
      if (!opened) return new Response('not found', { status: 404 });
      return await recordingFileResponse(opened, {
        rangeHeader: request.headers.get('Range'),
        method: request.method,
        signal: request.signal,
      });
    } catch {
      return new Response('media request failed', { status: 500 });
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

ipcMain.handle('rv-get-config', event => {
  requireTrustedIpcSender(event);
  return publicConfig(readConfig());
});

ipcMain.handle('rv-set-config', async (event, patch) => {
  requireTrustedIpcSender(event);
  const clean = patch && typeof patch === 'object' ? patch : {};
  const previous = readConfig();
  const result = writeConfig({
    mode: clean.mode === 'folder' ? 'folder' : 'server',
    serverUrl: String(clean.serverUrl || ''),
    accessToken: clean.accessToken,
    folder: String(clean.folder || '').slice(0, 4096),
    dbFolder: String(clean.dbFolder || '').slice(0, 4096),
  });
  // Electron版はBearer-onlyにしたためsession cookieは不要。旧版が残した
  // cookieも設定変更時に旧・新originの双方から削除する。
  await Promise.all([
    clearLegacyRecordingCookie(previous.serverUrl),
    clearLegacyRecordingCookie(result.serverUrl),
  ]);
  return result;
});

ipcMain.handle('rv-choose-folder', async (event, title) => {
  requireTrustedIpcSender(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: String(title || 'フォルダを選択'),
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('rv-status', async event => {
  requireTrustedIpcSender(event);
  const config = readConfig();
  if (config.mode === 'folder') {
    const dir = recordingsDirOf(config);
    const pathExists = async filePath => {
      try { await fs.promises.access(filePath); return true; } catch { return false; }
    };
    const [dbOk, storageOk] = dir
      ? await Promise.all([
        pathExists(path.join(dbDirOf(config), 'locations.json')),
        pathExists(dir),
      ])
      : [false, false];
    return {
      folderMode: true,
      folder: dir || '(未設定)',
      dbOk,
      storageOk,
    };
  }
  return serverApi(config, '/recordings/api/status');
});

ipcMain.handle('rv-locations', async event => {
  requireTrustedIpcSender(event);
  const config = readConfig();
  if (config.mode === 'folder') return await folderLocations(config);
  const data = await serverApi(config, '/recordings/api/locations');
  return (Array.isArray(data?.locations) ? data.locations : [])
    .slice(0, 256)
    .map(normalizeLocationRecord)
    .filter(Boolean);
});

// ライブ視聴セッション一覧。サーバー接続モードのみ(フォルダ直読みでは不可)。
// liveUrl はサーバーの追記追従ストリームURLへ変換し、<video> が直接受信する。
ipcMain.handle('rv-live', async event => {
  requireTrustedIpcSender(event);
  const config = readConfig();
  if (config.mode === 'folder') return [];
  try {
    const data = await serverApi(config, '/recordings/api/live');
    return (Array.isArray(data?.sessions) ? data.sessions : [])
      .slice(0, 256)
      .map(normalizeLiveRecord)
      .filter(Boolean);
  } catch {
    return [];
  }
});

ipcMain.handle('rv-segments', async (event, query) => {
  requireTrustedIpcSender(event);
  const config = readConfig();
  const q = query && typeof query === 'object' ? query : {};
  const queryWindow = normalizeSegmentQueryWindow(q.from, q.to);
  if (!queryWindow) return [];
  const { from, to } = queryWindow;
  const keys = Array.isArray(q.keys)
    ? [...new Set(q.keys.map(key => String(key).slice(0, 128)))].slice(0, 64)
    : null;

  if (config.mode === 'folder') return await folderSegments(config, { keys, from, to });

  const params = new URLSearchParams({ from: String(from), to: String(to) });
  if (keys && keys.length) params.set('keys', keys.join(','));
  const data = await serverApi(config, `/recordings/api/segments?${params}`);
  // 相対 mediaUrl をサーバーURL基準の絶対URLへ変換(<video> が直接再生する)
  return (Array.isArray(data?.segments) ? data.segments : [])
    .slice(0, 5000)
    .map(seg => {
      const mediaPath = validateServerMediaPath(
        String(seg?.mediaUrl || '').slice(0, 512),
        'media',
      );
      if (!mediaPath) return null;
      return normalizeSegmentRecord(seg, { mediaUrl: `recmedia://server${mediaPath}` });
    })
    .filter(Boolean);
});
