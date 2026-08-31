/**
 * サーバー録画マネージャ
 *
 * 各拠点のカメラ映像+マイク音声(producer)を mediasoup PlainTransport → ffmpeg で
 * 受信し、セグメント(既定5分)単位で保存する。
 *
 *   受信(RTP, stream copy, WebMまたはMatroska)
 *     │  └─ ライブ視聴: 書き込み中セグメントを追記追従で配信(openLiveFile)
 *     → ローカル確定処理(既定は再エンコードなし、必要時のみH.264/AAC化・日時焼き込み)
 *     → NAS/最終保存先へ非同期転送
 *     → JSONインデックス(データベース)へ登録
 *     → 保持期間を過ぎたセグメントは毎時の掃除で自動削除
 *     → 空き容量が最低確保量(既定10GB)を下回ったら古い録画から自動削除
 *
 * 設計方針:
 *  - クライアントのカメラがOFF(論理pause)でも RTP は届き続けるため録画は継続する
 *  - マイクミュート=音声producerのpause=RTP停止。その区間は音声が記録されない
 *  - 取り込みは拠点ごとに独立したffmpegプロセス。確定処理はqueue化し、
 *    既定1本の低優先度ffmpeg子プロセスで会議処理を優先する
 *  - 保存先/DB保存先は設定で変更可能。NAS(SMB/NFSマウント)を想定し、
 *    到達不能になっても録画機能全体は落とさず、復旧したら自動再開する
 *    (reconcile ループが candidate → session を常時突き合わせる)
 *  - インデックスは「拠点×ソース×日」単位の小さなJSONファイル。NAS上でも
 *    ロック不要で読め、専用ビューアアプリがサーバー無しで直接読める
 *  - JSON indexと確定済み出力はtmp+renameでcommitする。取込み中rawだけは
 *    ffmpegがローカルstagingへ直接追記する
 *
 * 外部依存: ffmpeg / ffprobe (同梱の ffmpeg-static / ffprobe-static を自動検出。
 * server-gui パッケージ版は同梱バイナリのパスが FFMPEG_PATH で渡される)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RECONCILE_INTERVAL_MS = 10_000;   // candidate/session 突き合わせ周期
const STORAGE_CHECK_INTERVAL_MS = 60_000; // 保存先(NAS)ヘルスチェック周期
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 保持期間掃除の周期
const SEGMENT_FINALIZE_IDLE_MS = 20_000; // 書き込みが止まってから「完了」とみなすまで
const SESSION_RETRY_BACKOFF_MS = 15_000; // セッション起動失敗時の再試行間隔
const AUDIO_WAIT_GRACE_MS = 2_500;       // 映像producer登録後、音声producerの到着を待つ猶予
const FFMPEG_DETECT_TIMEOUT_MS = 2_000;  // -version 1候補の非同期確認上限
const FFMPEG_DETECT_KILL_GRACE_MS = 250; // SIGKILL後のclose回収待ち上限
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SEGMENT_QUERY_RANGE_MS = 31 * DAY_MS;
// 前日開始のセグメントと終了側の日を拾うため、検索期間に最大2日を加える。
const MAX_SEGMENT_QUERY_DAYS = 33;
// ECMAScript Date が表現できる範囲。日付列挙の前後1日分も確保する。
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_SEGMENT_QUERY_RESULTS = 5000;
const MAX_INDEX_FILE_BYTES = 10 * 1024 * 1024;
const SEGMENT_QUERY_KEY_RE = /^[a-z0-9_-]{1,48}__(camera|screen)$/;
const LOCATION_KEY_RE = /^[a-z0-9_-]{1,48}$/;
const SEGMENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 生セグメント。VP8/Opus は webm、H.264等は mkv に copy 記録する
const RAW_FILE_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_([a-z0-9]{6})\.(webm|mkv)$/;
const MAX_ACTIVE_RECORDING_SESSIONS = envInt('RECORDING_MAX_ACTIVE_SESSIONS', 12, 1, 128);
const MAX_COMPRESSION_QUEUE = envInt('RECORDING_MAX_COMPRESSION_QUEUE', 256, 8, 10000);
const COMPRESSION_RESUME_QUEUE = Math.max(1, Math.floor(MAX_COMPRESSION_QUEUE / 2));
const MIN_STAGING_FREE_GB = envInt('RECORDING_MIN_STAGING_FREE_GB', 2, 1, 1000);
const RECORDING_SPATIAL_LAYER = envInt('RECORDING_SPATIAL_LAYER', 1, 0, 2);
const RECORDING_SETTINGS_SCHEMA_VERSION = 1;
// 連続録画中にも保守処理を行うが、1回のNAS操作量を制限して会議を優先する。
const MAINTENANCE_MAX_KEY_DIRS = 512;
const MAINTENANCE_MAX_DAY_FILES = 4096;
const MAINTENANCE_MAX_DELETES = 512;

/** 圧縮モード → ffmpeg パラメータ。strong ほど容量が小さい */
const COMPRESSION_PRESETS = {
  strong:   { crf: 34, maxHeight: 480 },
  standard: { crf: 29, maxHeight: 720 },
  light:    { crf: 24, maxHeight: 1080 },
  // none: 再エンコードせずコンテナ詰め替えのみ
};

const DEFAULT_SETTINGS = {
  schemaVersion: RECORDING_SETTINGS_SCHEMA_VERSION,
  enabled: false,
  recordingsDir: '',       // 空 = 設定ファイルと同じ場所の recordings/
  dbDir: '',               // 空 = recordingsDir/recording-db
  stagingDir: '',          // 空 = 設定ファイル側のローカル recording-staging/
  retentionDays: 14,       // 保持期間(日)。経過したセグメントは自動削除
  segmentSeconds: 300,     // セグメント長(秒)
  compressionMode: 'none', // strong / standard / light / none（安定性優先で既定は再エンコードなし）
  recordScreen: false,     // 画面共有(screen-share)映像も録画するか
  recordAudio: true,       // 音声(マイク/画面共有音声)も録音するか。OFF=映像のみ
  timestampOverlay: false, // ONは全セグメントの再エンコードが必要
  ffmpegPath: '',          // 空 = 自動検出(同梱 ffmpeg-static → システム)
  // バックグラウンド圧縮の並列数。0 = 自動（会議優先で1）。
  // 取り込み(RTP受信)は拠点ごとに独立した ffmpeg プロセスで元々並列動作する。
  compressionConcurrency: 1,
  // 保存先に常に確保しておく最低空き容量(GB)。下回ったら保持期間内でも
  // 古い録画から順に削除して確保する。
  minFreeGb: 10,
};

/** 自動時は1ジョブに限定し、mediasoupと取込ffmpegのCPU/I/Oを優先する。 */
function autoCompressionConcurrency() {
  return 1;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function shortString(value, max = 256) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function envInt(name, fallback, min, max) {
  return clampInt(process.env[name], min, max, fallback);
}

/** 拠点名 → ファイルシステム/IDに安全なキー(server/index.js の stableId と同等) */
function locationKeyOf(name) {
  const raw = shortString(name, 64).trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9぀-ヿ一-鿿_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // 日本語拠点名はハッシュ併用で衝突・文字化けを避ける(表示名は別途保持)
  if (/[^a-z0-9_-]/.test(normalized) || !normalized) {
    const digest = crypto.createHash('sha1').update(shortString(name, 128)).digest('hex').slice(0, 10);
    const ascii = normalized.replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    return `${ascii || 'loc'}-${digest}`;
  }
  return normalized;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * querySegments で列挙する日付範囲を検証する。
 * 終了値に依存した加算ループを避け、必ず固定上限回数で終了できる値だけを返す。
 */
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

function segmentHeapComesFirst(left, right) {
  return left.startMs < right.startMs ||
    (left.startMs === right.startMs && left.sequence < right.sequence);
}

function segmentHeapPush(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!segmentHeapComesFirst(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function segmentHeapPop(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < heap.length && segmentHeapComesFirst(heap[left], heap[next])) next = left;
      if (right < heap.length && segmentHeapComesFirst(heap[right], heap[next])) next = right;
      if (next === index) break;
      [heap[index], heap[next]] = [heap[next], heap[index]];
      index = next;
    }
  }
  return first;
}

function fmtTimeCompact(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function randTag(len = 6) {
  return crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, len).toLowerCase() || 'x0x0x0';
}

/** tmp+rename のアトミック書き込み(NAS上の読み手が中途半端なJSONを見ないように) */
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${randTag(4)}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function hasStableFileIdentity(stat) {
  return Number(stat?.dev) !== 0 && Number(stat?.ino) !== 0;
}

function sameFileIdentity(left, right) {
  if (!left?.isFile?.() || !right?.isFile?.()) return false;
  if (!hasStableFileIdentity(left) || !hasStableFileIdentity(right)) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left, right) {
  return sameFileIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryIdentity(left, right) {
  if (!left?.isDirectory?.() || !right?.isDirectory?.()) return false;
  if (Number(left.dev) === 0 || Number(left.ino) === 0 ||
      Number(right.dev) === 0 || Number(right.ino) === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

async function readJsonAsync(filePath, fallback = null) {
  let handle = null;
  try {
    const pathStat = await fs.promises.lstat(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() ||
        !Number.isSafeInteger(pathStat.size) || pathStat.size < 0 ||
        pathStat.size > MAX_INDEX_FILE_BYTES) return fallback;

    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const openedStat = await handle.stat();
    if (!sameFileIdentity(pathStat, openedStat) ||
        !Number.isSafeInteger(openedStat.size) || openedStat.size < 0 ||
        openedStat.size > MAX_INDEX_FILE_BYTES) return fallback;

    const chunks = [];
    let total = 0;
    while (total <= MAX_INDEX_FILE_BYTES) {
      const remaining = MAX_INDEX_FILE_BYTES + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > MAX_INDEX_FILE_BYTES) return fallback;

    const finalStat = await handle.stat();
    if (!sameFileVersion(openedStat, finalStat) || total !== finalStat.size) return fallback;
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeJsonAtomicAsync(filePath, data) {
  const serialized = JSON.stringify(data, null, 1);
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > MAX_INDEX_FILE_BYTES) {
    throw new Error(`recording index exceeds ${MAX_INDEX_FILE_BYTES} bytes`);
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  let handle = null;
  let tmp = '';
  let openedStat = null;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      tmp = `${filePath}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      try {
        handle = await fs.promises.open(
          tmp,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW || 0),
          0o644,
        );
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST' || attempt === 7) throw err;
      }
    }
    if (!handle) throw new Error('recording index temporary file could not be created');
    openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error('recording index temporary path is not a file');
    await handle.writeFile(serialized, 'utf8');
    const writtenStat = await handle.stat();
    if (!sameFileIdentity(openedStat, writtenStat) || writtenStat.size !== serializedBytes) {
      throw new Error('recording index temporary file changed while writing');
    }
    await handle.sync();
    await handle.close();
    handle = null;

    const pathStat = await fs.promises.lstat(tmp);
    if (pathStat.isSymbolicLink() || !sameFileIdentity(openedStat, pathStat) ||
        pathStat.size !== serializedBytes) {
      throw new Error('recording index temporary file changed before commit');
    }
    await renameReplacing(tmp, filePath);
    tmp = '';
  } finally {
    await handle?.close().catch(() => {});
    if (tmp) await fs.promises.unlink(tmp).catch(() => {});
  }
}

async function renameReplacing(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
  } catch (err) {
    // POSIX renameは既存ファイルをアトミックに交換できるが、Windowsでは
    // EPERM/EEXISTになることがある。生成済みの同一job名だけを対象に置換する。
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err;
    await fs.promises.unlink(targetPath).catch(unlinkErr => {
      if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
    });
    await fs.promises.rename(sourcePath, targetPath);
  }
}

function lowerChildPriority(child) {
  if (!child?.pid) return;
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch {
    // 権限やOSにより変更できない場合は、ffmpeg側の1thread制限で継続する。
  }
}

/** ffmpeg受信用UDPポートをsocketごと予約する（RTP/RTCP mux）。 */
async function reserveUdpPort() {
  const bindOne = (port = 0) => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { try { sock.close(); } catch (_) {} resolve(null); });
    sock.bind(port, '127.0.0.1', () => resolve(sock));
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const socket = await bindOne(0);
    if (!socket) continue;
    const port = socket.address().port;
    // 映像・音声の両方を確保するまでbindを維持し、OSが同じephemeral portを
    // 再割当する競合を防ぐ。呼び出し元がFFmpeg起動直前にcloseする。
    return { socket, port };
  }
  throw new Error('録画用UDPポートを確保できません');
}

/** 1メディアぶんの SDP セクションを生成する */
function sdpMediaSection(kind, rtpParameters, rtpPort, rtcpPort) {
  const codec = rtpParameters.codecs[0];
  const codecName = codec.mimeType.split('/')[1];
  const pt = codec.payloadType;
  const channels = kind === 'audio' && codec.channels ? `/${codec.channels}` : '';
  const lines = [
    `m=${kind} ${rtpPort} RTP/AVP ${pt}`,
    `a=rtcp:${rtcpPort}`,
    'a=rtcp-mux',
    `a=rtpmap:${pt} ${codecName}/${codec.clockRate}${channels}`,
  ];
  const params = asObject(codec.parameters);
  const fmtp = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  if (fmtp) lines.push(`a=fmtp:${pt} ${fmtp}`);
  lines.push('a=recvonly');
  return lines;
}

/** ffmpeg 用 SDP(映像+任意で音声)を生成する */
function buildSdp(media) {
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=CHECKHOUSE Recording',
    'c=IN IP4 127.0.0.1',
    't=0 0',
  ];
  for (const item of media) {
    lines.push(...sdpMediaSection(item.kind, item.rtpParameters, item.rtpPort, item.rtcpPort));
  }
  return `${lines.join('\n')}\n`;
}

class RecordingManager {
  constructor({
    getRouter,
    log,
    settingsFile,
    reserveTransportSlots,
    releaseTransportSlots,
    onClientPolicyChange,
    ffmpegDetectSpawn,
    ffmpegDetectTimeoutMs,
  }) {
    this.getRouter = getRouter;
    this.log = typeof log === 'function' ? log : (msg) => console.log(msg);
    this.settingsFile = settingsFile;
    this.reserveTransportSlots = typeof reserveTransportSlots === 'function'
      ? reserveTransportSlots : () => true;
    this.releaseTransportSlots = typeof releaseTransportSlots === 'function'
      ? releaseTransportSlots : () => {};
    this.onClientPolicyChange = typeof onClientPolicyChange === 'function'
      ? onClientPolicyChange : () => {};
    // 検出専用の注入点。通常の録画/圧縮ffmpegは引き続きspawnを直接使う。
    this._ffmpegDetectSpawn = typeof ffmpegDetectSpawn === 'function' ? ffmpegDetectSpawn : spawn;
    this._ffmpegDetectTimeoutMs = clampInt(
      ffmpegDetectTimeoutMs,
      10,
      30_000,
      FFMPEG_DETECT_TIMEOUT_MS,
    );

    const persistedSettings = this._loadSettingsFile();
    const persistedVersion = Number(persistedSettings.schemaVersion);
    const migrateLegacySettings = fs.existsSync(this.settingsFile) &&
      (!Number.isInteger(persistedVersion) || persistedVersion < RECORDING_SETTINGS_SCHEMA_VERSION);
    this.settings = { ...DEFAULT_SETTINGS, ...persistedSettings };
    this._applyEnvDefaults({ migrateLegacySafetyDefaults: migrateLegacySettings });
    if (migrateLegacySettings) {
      try {
        // schemaVersionが無い旧設定だけを一度だけ会議優先値へ移行する。
        // 成功時はversionも同時に書き、次回起動以降の利用者設定を上書きしない。
        writeJsonAtomic(this.settingsFile, this.settings);
        this.log('[Recording] 旧録画設定を会議優先schemaへ移行しました');
      } catch (err) {
        this.log(`[Recording] WARN: 旧録画設定の移行結果を保存できません: ${err.message}`);
      }
    }

    this.candidates = new Map(); // 映像producerId → { producer, socketId, locationName, source, appType, nextAttemptAt, createdAt }
    this.sessions = new Map();   // 映像producerId → session
    // 音声producerの登録簿: socketId → Map<source('microphone'|'screen-audio'), producer>
    // 録画セッションは同一拠点の対応する音声producerをペアにして記録する。
    // ミュートはproducer.pause()=RTP停止としてそのまま反映される(無音区間になる)。
    this.audioProducers = new Map();
    this.finalizeInFlight = new Set(); // 圧縮キュー投入済みの raw ファイルパス
    this.compressionQueue = [];  // { rawPath, meta }
    this.compressionActive = new Set(); // 圧縮実行中の raw ファイル名(並列数ぶん)
    this.compressionChildren = new Set(); // ffprobe/圧縮ffmpeg。OFF/終了時に停止する
    this.finalizeFailures = new Map(); // rawPath → { attempts, nextAttemptAt }
    this.finalizedRawPaths = new Map(); // rawPath → localReadyPath。raw削除だけを再試行する
    this.recordingBackpressure = false;
    this.stagingLowDisk = false;
    this.lowDisk = false;
    this.settingsGeneration = 0;
    this.storageOk = false;
    this.storageError = '未確認';
    this.ffmpegPath = null;
    this.ffprobePath = null;
    this.ffmpegError = '';
    this.lastSweepAt = 0;
    this._indexChain = Promise.resolve(); // インデックス書き込みの直列化
    this._dayCache = new Map();           // dayFilePath → { mtimeMs, data }
    this._pendingLocationUpdates = new Map(); // locations.jsonの一時失敗を後続周期で修復
    this._retentionSweepInFlight = null;
    this._freeSpaceSweepInFlight = null;
    this._stopped = false;
    this._ffmpegDetectFailures = 0;
    this._nextFfmpegDetectAt = 0;
    this._ffmpegDetectGeneration = 0;
    this._ffmpegDetectCommittedGeneration = -1;
    this._ffmpegDetectPromise = null;
    this._ffmpegDetectChild = null;
    this._ffmpegDetectCancelCandidate = null;
    this._lastClientPolicy = this._computeClientCameraPolicy();

    void this._detectFfmpeg({ force: true });
    this._checkStorage().catch(() => {});

    this._reconcileTimer = setInterval(() => this._reconcile().catch(() => {}), RECONCILE_INTERVAL_MS);
    this._storageTimer = setInterval(() => this._checkStorage().catch(() => {}), STORAGE_CHECK_INTERVAL_MS);
    this._finalizeTimer = setInterval(() => this._sweepRawSegments().catch(() => {}), SEGMENT_FINALIZE_IDLE_MS / 2);
    this._retentionTimer = setInterval(() => this.sweepRetention().catch(() => {}), RETENTION_SWEEP_INTERVAL_MS);
    // 最低空き容量の確保はディスクが急に埋まる事態に備えて短い周期で確認する
    this._freeSpaceTimer = setInterval(() => this._enforceMinFreeSpace().catch(() => {}), 5 * 60 * 1000);
    // 起動直後にも一度掃除(前回稼働分の期限切れ・取り残しrawの回収)
    this._startupMaintenanceTimer = setTimeout(() => {
      this._startupMaintenanceTimer = null;
      this._sweepRawSegments().catch(() => {});
      this.sweepRetention().catch(() => {});
      this._enforceMinFreeSpace().catch(() => {});
    }, 20_000);
    this._startupMaintenanceTimer.unref?.();

    if (this.settings.enabled) {
      this.log(`[Recording] 録画有効: 保存先=${this.recordingsDir()} DB=${this.dbDir()} 保持=${this.settings.retentionDays}日 圧縮=${this.settings.compressionMode}`);
      if (!this.ffmpegPath) this.log('[Recording] ffmpeg / ffprobe を非同期に検出中です');
    }
  }

  // ── 設定 ────────────────────────────────────────────────

  _loadSettingsFile() {
    return asObject(readJson(this.settingsFile, {}));
  }

  /** 環境変数は「設定ファイルにまだ値が無い」項目の初期値としてのみ使う */
  _applyEnvDefaults({ migrateLegacySafetyDefaults = false } = {}) {
    const s = this.settings;
    if (!s.recordingsDir && process.env.RECORDINGS_DIR) s.recordingsDir = process.env.RECORDINGS_DIR;
    if (!s.dbDir && process.env.RECORDINGS_DB_DIR) s.dbDir = process.env.RECORDINGS_DB_DIR;
    if (!s.ffmpegPath && process.env.FFMPEG_PATH) s.ffmpegPath = process.env.FFMPEG_PATH;
    if (process.env.RECORDING_ENABLED && !fs.existsSync(this.settingsFile)) {
      s.enabled = /^(1|true|yes)$/i.test(process.env.RECORDING_ENABLED);
    }
    this.settings = this._sanitizeSettings(s, { migrateLegacySafetyDefaults });
  }

  _sanitizeSettings(input, { migrateLegacySafetyDefaults = false } = {}) {
    const raw = asObject(input);
    return {
      schemaVersion: RECORDING_SETTINGS_SCHEMA_VERSION,
      enabled: !!raw.enabled,
      recordingsDir: shortString(raw.recordingsDir, 1024).trim(),
      dbDir: shortString(raw.dbDir, 1024).trim(),
      stagingDir: shortString(raw.stagingDir, 1024).trim(),
      retentionDays: clampInt(raw.retentionDays, 1, 3650, DEFAULT_SETTINGS.retentionDays),
      segmentSeconds: clampInt(raw.segmentSeconds, 60, 3600, DEFAULT_SETTINGS.segmentSeconds),
      compressionMode: migrateLegacySafetyDefaults
        ? 'none'
        : (['strong', 'standard', 'light', 'none'].includes(raw.compressionMode)
          ? raw.compressionMode : DEFAULT_SETTINGS.compressionMode),
      recordScreen: !!raw.recordScreen,
      recordAudio: raw.recordAudio === undefined ? DEFAULT_SETTINGS.recordAudio : !!raw.recordAudio,
      timestampOverlay: migrateLegacySafetyDefaults
        ? false
        : (raw.timestampOverlay === undefined ? DEFAULT_SETTINGS.timestampOverlay : !!raw.timestampOverlay),
      ffmpegPath: shortString(raw.ffmpegPath, 1024).trim(),
      compressionConcurrency: migrateLegacySafetyDefaults
        ? 1
        : clampInt(raw.compressionConcurrency, 0, 8, DEFAULT_SETTINGS.compressionConcurrency),
      minFreeGb: clampInt(raw.minFreeGb, 1, 1000, DEFAULT_SETTINGS.minFreeGb),
    };
  }

  /** 実際に使う圧縮並列数 */
  compressionConcurrency() {
    return this.settings.compressionConcurrency || autoCompressionConcurrency();
  }

  getSettings() {
    return { ...this.settings };
  }

  /** 設定を適用・永続化する。保存先変更時はセッションを貼り直す */
  applySettings(patch) {
    const before = this.settings;
    const next = this._sanitizeSettings({ ...before, ...asObject(patch) });
    const dirChanged = next.recordingsDir !== before.recordingsDir || next.dbDir !== before.dbDir ||
      next.stagingDir !== before.stagingDir;
    const segmentChanged = next.segmentSeconds !== before.segmentSeconds;
    const ffmpegChanged = next.ffmpegPath !== before.ffmpegPath;
    const processingChanged = dirChanged || ffmpegChanged ||
      next.compressionMode !== before.compressionMode ||
      next.timestampOverlay !== before.timestampOverlay ||
      next.compressionConcurrency !== before.compressionConcurrency;
    this.settings = next;
    this._notifyClientPolicyIfChanged();

    try {
      writeJsonAtomic(this.settingsFile, next);
    } catch (err) {
      this.log(`[Recording] WARN: 設定ファイルを保存できません (${this.settingsFile}): ${err.message}`);
    }

    if (processingChanged || !next.enabled) this._pauseCompressionWork('録画設定変更');
    if (ffmpegChanged) void this._detectFfmpeg({ force: true });
    this._dayCache.clear();
    if (dirChanged) {
      this._summaryDiskCache = null;
      this._usageCache = null;
    }
    this._checkStorage().catch(() => {});

    if (!next.enabled) {
      this._stopAllSessions('録画無効化');
    } else if (dirChanged || segmentChanged) {
      this._stopAllSessions(dirChanged ? '保存先変更' : 'セグメント長変更');
    }
    if (!next.recordScreen) {
      for (const [producerId, session] of this.sessions) {
        if (session.source === 'screen') this._stopSession(producerId, '画面共有録画の無効化');
      }
    }
    // 録音ON→OFF: 音声付きで走っているセッションを貼り直して映像のみにする
    // (OFF→ONは reconcile の音声producer再ピン留めが自動で貼り直す)
    if (!next.recordAudio && before.recordAudio) {
      for (const [producerId, session] of this.sessions) {
        if (session.audioConsumer) this._stopSession(producerId, '音声録音の無効化');
      }
    }
    this.log(`[Recording] 設定を更新: enabled=${next.enabled} 保存先=${this.recordingsDir()} DB=${this.dbDir()} 保持=${next.retentionDays}日 セグメント=${next.segmentSeconds}s 圧縮=${next.compressionMode} 画面共有=${next.recordScreen} 音声=${next.recordAudio}`);
    this._reconcile().catch(() => {});
    return this.getSettings();
  }

  recordingsDir() {
    return this.settings.recordingsDir || path.join(path.dirname(this.settingsFile), 'recordings');
  }

  dbDir() {
    return this.settings.dbDir || path.join(this.recordingsDir(), 'recording-db');
  }

  rawDir() {
    // 取込ffmpegはNASへ直接書かず、サーバーのローカル領域へ一度保全する。
    // NASの一時停止/再接続待ちがRTP取込プロセスに波及するのを防ぐ。
    const stagingRoot = this.settings.stagingDir || process.env.RECORDING_STAGING_DIR ||
      path.join(path.dirname(path.resolve(this.settingsFile)), 'recording-staging');
    return path.join(stagingRoot, 'raw');
  }

  encodedDir() {
    return path.join(path.dirname(this.rawDir()), 'encoded');
  }

  _computeClientCameraPolicy() {
    return !!this.settings?.enabled && !this._stopped && this.storageOk &&
      !this.recordingBackpressure && !this.stagingLowDisk && !this.lowDisk;
  }

  /** クライアントに「カメラOFFでも送信を継続」させるか(録画有効時のみ) */
  clientShouldKeepSendingCamera() {
    return this._computeClientCameraPolicy();
  }

  _notifyClientPolicyIfChanged() {
    const next = this._computeClientCameraPolicy();
    if (next === this._lastClientPolicy) return;
    this._lastClientPolicy = next;
    try {
      this.onClientPolicyChange(next);
    } catch (err) {
      this.log(`[Recording] WARN: クライアント録画方針の通知に失敗: ${err.message}`);
    }
  }

  _pauseCompressionWork(reason = '') {
    this.settingsGeneration += 1;
    for (const job of this.compressionQueue.splice(0)) {
      this.finalizeInFlight.delete(job.rawPath);
    }
    for (const child of this.compressionChildren) {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
    if (reason && this.compressionChildren.size) {
      this.log(`[Recording] バックグラウンド処理を中断: ${reason}`);
    }
  }

  // ── ffmpeg / 保存先ヘルス ────────────────────────────────

  /**
   * ffmpeg/ffprobe の探索。優先順:
   *   1. 設定(ffmpegPath) / 環境変数 FFMPEG_PATH・FFPROBE_PATH
   *      (server-gui のパッケージ版は同梱バイナリのパスをここで渡してくる)
   *   2. 同梱npmパッケージ ffmpeg-static / ffprobe-static
   *   3. PATH・OS標準の場所(システムにインストール済みの ffmpeg)
   */
  _ffmpegCandidates() {
    const candidates = [];
    if (this.settings.ffmpegPath) candidates.push(this.settings.ffmpegPath);
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    try {
      const bundled = require('ffmpeg-static');
      if (bundled) candidates.push(bundled);
    } catch (_) { /* 未インストール環境では次の候補へ */ }
    candidates.push('ffmpeg');
    if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
    if (process.platform === 'win32') candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
    if (process.platform === 'linux') candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
    return [...new Set(candidates)];
  }

  _ffprobeCandidates(ffmpegPath) {
    const candidates = [];
    if (process.env.FFPROBE_PATH) candidates.push(process.env.FFPROBE_PATH);
    try {
      const bundledProbe = require('ffprobe-static');
      if (bundledProbe?.path) candidates.push(bundledProbe.path);
    } catch (_) { /* 未インストール環境では次の候補へ */ }
    if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
      candidates.push(path.join(
        path.dirname(ffmpegPath),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      ));
    }
    candidates.push('ffprobe');
    return [...new Set(candidates)];
  }

  /** 1候補の -version 確認。timeout/stop/設定変更で必ずchildをkillする。 */
  _checkFfmpegCandidate(candidate, generation) {
    if (this._stopped || generation !== this._ffmpegDetectGeneration) {
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      let child;
      let settled = false;
      let cancelling = false;
      let timeout = null;
      let killGraceTimeout = null;

      const finish = works => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killGraceTimeout) clearTimeout(killGraceTimeout);
        child?.removeListener?.('error', onError);
        child?.removeListener?.('close', onClose);
        if (this._ffmpegDetectChild === child) this._ffmpegDetectChild = null;
        if (this._ffmpegDetectCancelCandidate === cancel) {
          this._ffmpegDetectCancelCandidate = null;
        }
        resolve(!!works && !this._stopped && generation === this._ffmpegDetectGeneration);
      };
      const cancel = () => {
        if (settled || cancelling) return;
        cancelling = true;
        try {
          if (child && child.exitCode == null && !child.killed) child.kill('SIGKILL');
        } catch (_) { /* finishで候補失敗として回収 */ }
        // 通常はcloseを待って次候補へ進み、killを無視する異常childだけ
        // 短いgrace後に切り離す。これにより候補processの重複を避ける。
        killGraceTimeout = setTimeout(() => {
          try {
            if (child && child.exitCode == null) child.kill('SIGKILL');
          } catch (_) { /* 最終回収を続行 */ }
          finish(false);
        }, FFMPEG_DETECT_KILL_GRACE_MS);
        killGraceTimeout.unref?.();
      };
      const onError = () => finish(false);
      const onClose = code => finish(!cancelling && code === 0);

      try {
        child = this._ffmpegDetectSpawn(candidate, ['-version'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        if (!child || typeof child.once !== 'function') {
          cancel();
          return;
        }
        this._ffmpegDetectChild = child;
        this._ffmpegDetectCancelCandidate = cancel;
        child.once('error', onError);
        child.once('close', onClose);
        timeout = setTimeout(cancel, this._ffmpegDetectTimeoutMs);
        timeout.unref?.();
      } catch (_) {
        cancel();
      }
    });
  }

  async _firstWorkingFfmpegCandidate(candidates, generation) {
    for (const candidate of candidates) {
      if (this._stopped || generation !== this._ffmpegDetectGeneration) return null;
      if (await this._checkFfmpegCandidate(candidate, generation)) return candidate;
    }
    return null;
  }

  async _runFfmpegDetectionLoop() {
    while (!this._stopped) {
      const generation = this._ffmpegDetectGeneration;
      let ffmpegPath = null;
      let ffprobePath = null;
      try {
        ffmpegPath = await this._firstWorkingFfmpegCandidate(
          this._ffmpegCandidates(),
          generation,
        );
        if (ffmpegPath && generation === this._ffmpegDetectGeneration && !this._stopped) {
          ffprobePath = await this._firstWorkingFfmpegCandidate(
            this._ffprobeCandidates(ffmpegPath),
            generation,
          );
        }
      } catch (err) {
        if (generation === this._ffmpegDetectGeneration && !this._stopped) {
          try { this.log(`[Recording] WARN: ffmpeg 検出に失敗しました: ${err.message}`); } catch (_) {}
        }
      }

      if (this._stopped) return false;
      // force設定変更中に古い候補が成功してもcommitしない。
      // 同じsingle-flight runner内で最新世代を探索し直す。
      if (generation !== this._ffmpegDetectGeneration) continue;

      const previousPath = this.ffmpegPath;
      const previousError = this.ffmpegError;
      this.ffmpegPath = ffmpegPath;
      this.ffprobePath = ffprobePath;
      this.ffmpegError = ffmpegPath
        ? ''
        : 'ffmpeg が見つかりません。サーバーGUI同梱版の再インストール、または設定で ffmpeg のパスを指定してください';
      if (ffmpegPath) {
        this._ffmpegDetectFailures = 0;
        this._nextFfmpegDetectAt = 0;
        if (this.settings.enabled && previousPath !== ffmpegPath) {
          try { this.log(`[Recording] ffmpeg を検出しました: ${ffmpegPath}`); } catch (_) {}
        }
      } else {
        this._ffmpegDetectFailures = Math.min(8, this._ffmpegDetectFailures + 1);
        const retryMs = Math.min(
          5 * 60_000,
          15_000 * (2 ** (this._ffmpegDetectFailures - 1)),
        );
        this._nextFfmpegDetectAt = Date.now() + retryMs;
        if (this.settings.enabled && previousError !== this.ffmpegError) {
          try { this.log(`[Recording] WARN: ${this.ffmpegError}。録画は検出後に自動再開します`); } catch (_) {}
        }
      }
      this._ffmpegDetectCommittedGeneration = generation;
      return !!ffmpegPath;
    }
    return false;
  }

  _cancelActiveFfmpegDetection() {
    const cancel = this._ffmpegDetectCancelCandidate;
    if (cancel) cancel();
  }

  /**
   * ffmpeg/ffprobeをevent loopを止めずに探索するsingle-flight。
   * forceは現在の候補をkillし、同じrunnerで最新設定を探索し直す。
   */
  _detectFfmpeg({ force = false } = {}) {
    if (this._stopped) return Promise.resolve(false);
    if (force) {
      this._ffmpegDetectGeneration += 1;
      this._ffmpegDetectFailures = 0;
      this._nextFfmpegDetectAt = 0;
      this.ffmpegPath = null;
      this.ffprobePath = null;
      this.ffmpegError = 'ffmpeg / ffprobe を検出中です';
      this._cancelActiveFfmpegDetection();
    }
    if (this._ffmpegDetectPromise) return this._ffmpegDetectPromise;
    if (!force && this.ffmpegPath) return Promise.resolve(true);
    if (!force && Date.now() < this._nextFfmpegDetectAt) return Promise.resolve(false);

    let detectionPromise;
    detectionPromise = this._runFfmpegDetectionLoop()
      .catch(err => {
        if (!this._stopped) {
          try { this.log(`[Recording] WARN: ffmpeg 検出処理が失敗しました: ${err.message}`); } catch (_) {}
          this.ffmpegPath = null;
          this.ffprobePath = null;
          this.ffmpegError = 'ffmpeg 検出処理に失敗しました';
          this._ffmpegDetectFailures = Math.min(8, this._ffmpegDetectFailures + 1);
          this._nextFfmpegDetectAt = Date.now() + 15_000;
          this._ffmpegDetectCommittedGeneration = this._ffmpegDetectGeneration;
        }
        return false;
      })
      .finally(() => {
        if (this._ffmpegDetectPromise !== detectionPromise) return;
        this._ffmpegDetectPromise = null;
        if (!this._stopped) {
          if (this._ffmpegDetectCommittedGeneration !== this._ffmpegDetectGeneration) {
            // commit直後のforceで世代が進んだ稀な競合も取りこぼさない。
            queueMicrotask(() => { void this._detectFfmpeg(); });
          } else {
            // 検出中にreconcileが待機していたcandidateを即時再評価する。
            queueMicrotask(() => this._reconcile().catch(() => {}));
          }
        }
      });
    this._ffmpegDetectPromise = detectionPromise;
    return detectionPromise;
  }

  /**
   * タイムスタンプ焼き込み(drawtext)用のフォントを探す。
   * ffmpeg-static は fontconfig を含まないため fontfile の明示が必要。
   */
  _findFontFile() {
    if (this._fontFile !== undefined) return this._fontFile;
    const candidates = process.platform === 'darwin' ? [
      '/System/Library/Fonts/Helvetica.ttc',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Monaco.ttf',
    ] : process.platform === 'win32' ? [
      'C:\\Windows\\Fonts\\consola.ttf',
      'C:\\Windows\\Fonts\\arial.ttf',
      'C:\\Windows\\Fonts\\segoeui.ttf',
    ] : [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    ];
    this._fontFile = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    if (!this._fontFile) {
      this.log('[Recording] WARN: タイムスタンプ用フォントが見つからないため、日時焼き込みをスキップします');
    }
    return this._fontFile;
  }

  /** 保存先(NAS含む)の書き込み可否を確認する */
  async _checkStorage() {
    if (this._storageCheckInFlight) return this._storageCheckInFlight;
    const checkPromise = (async () => {
      if (!this.settings.enabled) {
        this.storageOk = false;
        this.storageError = '録画が無効です';
        this._notifyClientPolicyIfChanged();
        return;
      }
      try {
        for (const dir of [this.recordingsDir(), this.rawDir(), this.encodedDir(), this.dbDir()]) {
          await fs.promises.mkdir(dir, { recursive: true });
        }
        for (const dir of [this.recordingsDir(), this.rawDir(), this.dbDir()]) {
          const testFile = path.join(dir, `.write-test-${process.pid}`);
          await fs.promises.writeFile(testFile, String(Date.now()));
          await fs.promises.unlink(testFile).catch(() => {});
        }
        const [recordingFs, stagingFs] = await Promise.all([
          fs.promises.statfs(this.recordingsDir()).catch(() => null),
          fs.promises.statfs(this.rawDir()).catch(() => null),
        ]);
        if (recordingFs) {
          const freeBytes = recordingFs.bavail * recordingFs.bsize;
          const wasLowDisk = this.lowDisk;
          this.lowDisk = freeBytes < this.settings.minFreeGb * 1024 ** 3;
          this._summaryDiskCache = {
            ...(this._summaryDiskCache || {}),
            at: Date.now(),
            freeBytes,
            totalBytes: recordingFs.blocks * recordingFs.bsize,
          };
          if (this.lowDisk && !wasLowDisk) {
            this.log(`[Recording] WARN: 最終保存先の空きが最低確保量(${this.settings.minFreeGb}GB)を下回ったため録画を一時停止します`);
            this._pauseCompressionWork('最終保存先の容量不足');
            this._stopAllSessions('最終保存先の容量不足');
          }
        }
        const stagingFreeBytes = stagingFs ? stagingFs.bavail * stagingFs.bsize : null;
        const wasStagingLow = this.stagingLowDisk;
        this.stagingLowDisk = stagingFreeBytes !== null &&
          stagingFreeBytes < MIN_STAGING_FREE_GB * 1024 ** 3;
        if (this.stagingLowDisk && !wasStagingLow) {
          this.log(`[Recording] WARN: ローカル一時保存先の空きが${MIN_STAGING_FREE_GB}GB未満のため新規録画を停止します`);
          this._pauseCompressionWork('ローカル一時保存先の容量不足');
          this._stopAllSessions('ローカル一時保存先の容量不足');
        }
        if (!this.storageOk) this.log(`[Recording] 保存先が利用可能になりました: ${this.recordingsDir()}`);
        this.storageOk = true;
        this.storageError = '';
        this._notifyClientPolicyIfChanged();
        if (this.lowDisk) this._enforceMinFreeSpace().catch(() => {});
        // day indexはcommit済みだがlocations.jsonだけ失敗した更新を、
        // 次のヘルスチェックで非同期に修復する。
        this._flushPendingLocationUpdates().catch(() => {});
        // 使用量推定も定期チェック側で非同期更新し、500ms周期の
        // status取得からNAS index走査を完全に分離する。
        this._refreshUsageCacheAsync().catch(() => {});
      } catch (err) {
        const becameUnavailable = this.storageOk;
        if (this.storageOk || this.storageError === '未確認') {
          this.log(`[Recording] WARN: 保存先へ書き込めません(NAS切断?): ${err.message}。復旧を待ちます`);
        }
        this.storageOk = false;
        this.storageError = err.message;
        this._notifyClientPolicyIfChanged();
        if (becameUnavailable) {
          this._pauseCompressionWork('保存先が利用できません');
          this._stopAllSessions('保存先が利用できません');
        }
      }
    })();
    this._storageCheckInFlight = checkPromise;
    try {
      return await checkPromise;
    } finally {
      if (this._storageCheckInFlight === checkPromise) this._storageCheckInFlight = null;
    }
  }

  // ── candidate 管理(server/index.js から呼ばれる) ─────────

  /**
   * 新しい producer を録画候補として登録する。
   * 映像(camera/screen)は録画セッションの主体、音声(microphone/screen-audio)は
   * 同一拠点の映像セッションにペアで記録される。
   * 実際に録画対象か(有効/ソース種別/ffmpeg/保存先)は reconcile が判定する。
   */
  onProducerCreated({ producer, socketId, locationName, source, appType, getLocationName }) {
    if (!producer || producer.closed) return;
    if (!['client', 'screen-share'].includes(appType || 'client')) return;

    if (producer.kind === 'audio' && ['microphone', 'screen-audio'].includes(source)) {
      let bySource = this.audioProducers.get(socketId);
      if (!bySource) { bySource = new Map(); this.audioProducers.set(socketId, bySource); }
      bySource.set(source, producer);
      producer.observer.once('close', () => {
        const current = this.audioProducers.get(socketId);
        if (current?.get(source) === producer) current.delete(source);
        if (current && !current.size) this.audioProducers.delete(socketId);
        // セッションは映像だけで継続する(音声が復活したら reconcile が貼り直す)
      });
      // 既存セッションへの音声の後付けは reconcile の貼り直しで行う
      this._reconcile().catch(() => {});
      return;
    }

    if (producer.kind !== 'video') return;
    if (!['camera', 'screen'].includes(source)) return;

    this.candidates.set(producer.id, {
      producer,
      socketId,
      locationName: shortString(locationName || 'unknown', 128),
      getLocationName: typeof getLocationName === 'function' ? getLocationName : null,
      source,
      appType: appType || 'client',
      nextAttemptAt: 0,
      failureCount: 0,
      createdAt: Date.now(),
    });
    producer.observer.once('close', () => {
      this.candidates.delete(producer.id);
      this._stopSession(producer.id, 'producer閉鎖');
    });
    // 即時に開始を試みる(次のreconcileを待たない)
    this._reconcile().catch(() => {});
  }

  /** 映像ソースに対応する音声producer(生きているもの)を返す。録音OFF設定時は常にnull */
  _audioProducerFor(socketId, videoSource) {
    if (!this.settings.recordAudio) return null;
    const audioSource = videoSource === 'screen' ? 'screen-audio' : 'microphone';
    const producer = this.audioProducers.get(socketId)?.get(audioSource);
    return producer && !producer.closed ? producer : null;
  }

  _shouldRecord(candidate) {
    if (!this.settings.enabled) return false;
    if (candidate.source === 'screen' && !this.settings.recordScreen) return false;
    return true;
  }

  async _reconcile() {
    if (this._stopped) return;
    if (this._reconciling) return;
    this._reconciling = true;
    try {
      // 死んだセッションの回収(ffmpeg異常終了・映像consumer/transport閉鎖)
      for (const [producerId, session] of [...this.sessions]) {
        const dead = session.ffmpegExited || session.consumer?.closed ||
          (session.transports || []).some(transport => transport.closed);
        if (dead) this._stopSession(producerId, session.lastError || 'セッション異常終了');
      }
      if (!this.settings.enabled) return;
      if (!this.ffmpegPath) {
        void this._detectFfmpeg();
        return;
      }
      if (!this.storageOk) { await this._checkStorage(); if (!this.storageOk) return; }
      if (this.stagingLowDisk) {
        this._stopAllSessions('ローカル一時保存先の容量不足');
        return;
      }
      if (this.lowDisk) {
        // 低容量中は新規取込・NASへの確定処理を増やさず、保守処理の回復を待つ。
        this._stopAllSessions('最終保存先の容量不足');
        return;
      }
      if (this.recordingBackpressure) {
        if (this.compressionQueue.length <= COMPRESSION_RESUME_QUEUE) {
          this.recordingBackpressure = false;
          this._notifyClientPolicyIfChanged();
          this.log('[Recording] 圧縮待ちキューが回復したため録画を再開します');
        } else {
          this._stopAllSessions('圧縮待ちキュー過多');
          return;
        }
      }

      const now = Date.now();

      // 音声producerの出現/入れ替わりを既存セッションへ反映する(貼り直し)。
      // ffmpeg の入力(SDP)は起動後に変えられないため、セッションを作り直す。
      for (const [producerId, session] of [...this.sessions]) {
        const audio = this._audioProducerFor(session.socketId, session.source);
        const wantAudioId = audio?.id || null;
        if (wantAudioId && wantAudioId !== session.audioProducerId &&
            now - session.startedAt > 5000) {
          this._stopSession(producerId, '音声producerの追加/変更に伴う貼り直し');
        }
      }

      for (const [producerId, candidate] of this.candidates) {
        if (this.sessions.has(producerId)) continue;
        if (!this._shouldRecord(candidate)) continue;
        if (this.sessions.size >= MAX_ACTIVE_RECORDING_SESSIONS) break;
        if (candidate.producer.closed) { this.candidates.delete(producerId); continue; }
        if (now < candidate.nextAttemptAt) continue;
        // 映像直後に音声producerが作られるのが通常なので、揃うまで少し待つ
        // (揃わなくても猶予経過後は映像のみで開始する。録音OFF時は待たない)
        if (this.settings.recordAudio &&
            !this._audioProducerFor(candidate.socketId, candidate.source) &&
            now - candidate.createdAt < AUDIO_WAIT_GRACE_MS) continue;
        candidate.nextAttemptAt = now + SESSION_RETRY_BACKOFF_MS;
        // 拠点名は setMetadata で後から確定することがあるため開始直前に取り直す
        const currentName = shortString(candidate.getLocationName?.() || '', 128);
        if (currentName && currentName !== '接続中...') candidate.locationName = currentName;
        try {
          await this._startSession(candidate);
          candidate.failureCount = 0;
        } catch (err) {
          candidate.failureCount = Math.min(12, (candidate.failureCount || 0) + 1);
          const retryBaseMs = Math.min(5 * 60_000, SESSION_RETRY_BACKOFF_MS * (2 ** Math.min(candidate.failureCount - 1, 5)));
          const retryJitterMs = Math.floor(Math.random() * Math.min(15_000, retryBaseMs / 4));
          candidate.nextAttemptAt = Date.now() + retryBaseMs + retryJitterMs;
          this.log(`[Recording] WARN: 録画開始に失敗 name=${candidate.locationName} source=${candidate.source}: ${err.message}(${Math.round((retryBaseMs + retryJitterMs) / 1000)}秒後に再試行)`);
        }
      }
    } finally {
      this._reconciling = false;
    }
  }

  // ── 録画セッション ───────────────────────────────────────

  async _startSession(candidate) {
    const router = this.getRouter();
    if (!router || router.closed) throw new Error('router 未準備');
    const { producer } = candidate;
    const audioProducer = this._audioProducerFor(candidate.socketId, candidate.source);
    const requiredTransportSlots = audioProducer ? 2 : 1;
    if (!this.reserveTransportSlots(requiredTransportSlots)) {
      throw new Error('会議用RTC portの余力を確保できないため録画を待機します');
    }
    let session = null;
    try {
      const locKey = locationKeyOf(candidate.locationName);
      const sessionTag = randTag(6);
      const outDir = path.join(this.rawDir(), locKey, candidate.source);

      session = {
        producerId: producer.id,
        audioProducerId: audioProducer?.id || null,
        socketId: candidate.socketId,
        locationName: candidate.locationName,
        locKey,
        source: candidate.source,
        sessionTag,
        outDir,
        rawExt: 'webm',
        transports: [],
        udpReservations: [],
        consumer: null,       // 映像consumer
        audioConsumer: null,
        ffmpeg: null,
        ffmpegExited: false,
        startedAt: Date.now(),
        lastError: '',
        keyframeTimer: null,
        sdpPath: '',
        reservedTransportSlots: requiredTransportSlots,
      };
      this.sessions.set(producer.id, session);
      const assertSessionCurrent = () => {
        if (router.closed || producer.closed || this.sessions.get(producer.id) !== session) {
          throw new Error('録画開始中にメディアセッションが変更されました');
        }
      };

      await fs.promises.mkdir(outDir, { recursive: true });
      assertSessionCurrent();
      const media = [];

      // ── 映像 ──
      const videoTransport = await router.createPlainTransport({
        listenIp: '127.0.0.1', rtcpMux: true, comedia: false,
      });
      session.transports.push(videoTransport);
      assertSessionCurrent();
      const videoReservation = await reserveUdpPort();
      session.udpReservations.push(videoReservation);
      const videoPort = videoReservation.port;
      assertSessionCurrent();
      await videoTransport.connect({ ip: '127.0.0.1', port: videoPort });
      assertSessionCurrent();
      const consumer = await videoTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });
      session.consumer = consumer;
      assertSessionCurrent();
      // 既定は中間レイヤ。最高画質を全拠点で常時転送して会議を圧迫しない。
      try { await consumer.setPreferredLayers({ spatialLayer: RECORDING_SPATIAL_LAYER, temporalLayer: 2 }); } catch (_) {}
      media.push({ kind: 'video', rtpParameters: consumer.rtpParameters, rtpPort: videoPort, rtcpPort: videoPort });

      // 生セグメントの容器: VP8/VP9+Opus は webm(ブラウザでライブ視聴可)、それ以外は mkv
      const videoCodec = (consumer.rtpParameters.codecs[0]?.mimeType || '').split('/')[1]?.toLowerCase() || '';
      session.rawExt = ['vp8', 'vp9'].includes(videoCodec) ? 'webm' : 'mkv';

      // ── 音声(同一拠点のマイク/画面音声。ミュート中はRTPが止まり無音になる) ──
      if (audioProducer) {
        const audioTransport = await router.createPlainTransport({
          listenIp: '127.0.0.1', rtcpMux: true, comedia: false,
        });
        session.transports.push(audioTransport);
        assertSessionCurrent();
        const audioReservation = await reserveUdpPort();
        session.udpReservations.push(audioReservation);
        const audioPort = audioReservation.port;
        assertSessionCurrent();
        await audioTransport.connect({ ip: '127.0.0.1', port: audioPort });
        assertSessionCurrent();
        const audioConsumer = await audioTransport.consume({
          producerId: audioProducer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true,
        });
        session.audioConsumer = audioConsumer;
        assertSessionCurrent();
        media.push({ kind: 'audio', rtpParameters: audioConsumer.rtpParameters, rtpPort: audioPort, rtcpPort: audioPort });
      }

      session.sdpPath = path.join(os.tmpdir(), `chk-rec-${sessionTag}.sdp`);
      await fs.promises.writeFile(session.sdpPath, buildSdp(media), { mode: 0o600 });
      assertSessionCurrent();

      const pattern = path.join(outDir, `%Y%m%d-%H%M%S_${sessionTag}.${session.rawExt}`);
      const args = [
        '-hide_banner', '-loglevel', 'warning', '-nostdin',
        '-protocol_whitelist', 'file,udp,rtp',
        // ミュート中(音声RTP無し)でも起動・書き込みが止まらないように、
        // ストリーム解析とインターリーブ待ちを短くする
        '-analyzeduration', '2000000',
        '-i', session.sdpPath,
        '-map', '0:v:0',
        ...(session.audioConsumer ? ['-map', '0:a:0?'] : []),
        '-c', 'copy',
        '-max_interleave_delta', '1000000',
        '-f', 'segment',
        '-segment_format', session.rawExt === 'webm' ? 'webm' : 'matroska',
        '-segment_time', String(this.settings.segmentSeconds),
        '-reset_timestamps', '1',
        '-strftime', '1',
        pattern,
      ];
      // 両portの一意性を保ったまま準備し、bind競合の窓をFFmpeg spawn直前まで縮める。
      await Promise.all(session.udpReservations.splice(0).map(reservation => new Promise(resolve => {
        try { reservation.socket.close(resolve); } catch (_) { resolve(); }
      })));
      assertSessionCurrent();
      const ffmpeg = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      session.ffmpeg = ffmpeg;

      let stderrTail = '';
      ffmpeg.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      ffmpeg.on('error', err => {
        session.ffmpegExited = true;
        session.lastError = `ffmpeg起動失敗: ${err.message}`;
      });
      ffmpeg.on('close', code => {
        if (session.killTimer) {
          clearTimeout(session.killTimer);
          session.killTimer = null;
        }
        session.ffmpegExited = true;
        if (!session.stopping && code !== 0) {
          session.lastError = `ffmpeg終了 code=${code} ${stderrTail.split('\n').slice(-2).join(' ')}`.trim();
          this.log(`[Recording] WARN: ffmpeg が停止しました name=${session.locationName} source=${session.source}: ${session.lastError}`);
        }
        // 完了セグメントの回収を早める
        this._sweepRawSegments().catch(() => {});
      });

      // ffmpeg がポートを開くまでわずかに待ってから RTP を流し始める
      await new Promise(resolve => setTimeout(resolve, 500));
      if (session.ffmpegExited || ffmpeg.exitCode !== null) {
        throw new Error(session.lastError || 'ffmpeg が取込開始前に終了しました');
      }
      if (consumer.closed) throw new Error('consumer が閉じられました');
      await consumer.resume();
      if (session.audioConsumer && !session.audioConsumer.closed) {
        await session.audioConsumer.resume();
      }
      try { await consumer.requestKeyFrame(); } catch (_) {}
      // 以後はセグメント長に合わせ、producerごとのjitterで分散して要求する。
      // 旧実装の30秒同期PLIは、多拠点でキーフレームburstとなっていた。
      const keyframeBaseMs = Math.max(60_000, this.settings.segmentSeconds * 1000);
      const jitterMaxMs = Math.min(30_000, Math.floor(keyframeBaseMs / 5));
      const jitterMs = parseInt(crypto.createHash('sha1').update(producer.id).digest('hex').slice(0, 8), 16) %
        Math.max(1, jitterMaxMs);
      const scheduleKeyframe = () => {
        session.keyframeTimer = setTimeout(() => {
          if (session.stopping || consumer.closed) return;
          consumer.requestKeyFrame().catch(() => {});
          scheduleKeyframe();
        }, keyframeBaseMs + jitterMs);
        session.keyframeTimer.unref?.();
      };
      scheduleKeyframe();

      this.log(`[Recording] 録画開始 name=${candidate.locationName} source=${candidate.source} 音声=${audioProducer ? 'あり' : 'なし'} → ${outDir}`);
    } catch (err) {
      if (session && this.sessions.get(producer.id) === session) {
        this._stopSession(producer.id, `起動失敗: ${err.message}`, { quiet: true });
      } else if (session) {
        this._disposeSessionResources(session);
      } else {
        // 予約後のID/パス生成で同期例外が起き、sessionへ予約の
        // 所有権を移す前に失敗した経路でも確実に返却する。
        this.releaseTransportSlots(requiredTransportSlots);
      }
      throw err;
    }
  }

  _disposeSessionResources(session) {
    if (!session) return;
    session.stopping = true;
    if (session.keyframeTimer) {
      clearTimeout(session.keyframeTimer);
      session.keyframeTimer = null;
    }
    try { session.consumer?.close(); } catch (_) {}
    try { session.audioConsumer?.close(); } catch (_) {}
    for (const transport of session.transports?.splice(0) || []) {
      try { transport.close(); } catch (_) {}
    }
    for (const reservation of session.udpReservations?.splice(0) || []) {
      try { reservation.socket.close(); } catch (_) {}
    }
    if (session.reservedTransportSlots) {
      this.releaseTransportSlots(session.reservedTransportSlots);
      session.reservedTransportSlots = 0;
    }
    if (session.ffmpeg && !session.ffmpegExited) {
      try { session.ffmpeg.kill('SIGINT'); } catch (_) {}
      const proc = session.ffmpeg;
      if (!session.killTimer) {
        session.killTimer = setTimeout(() => {
          session.killTimer = null;
          try { proc.kill('SIGKILL'); } catch (_) {}
        }, 2000);
        session.killTimer.unref?.();
      }
    }
    if (session.sdpPath) {
      const sdpPath = session.sdpPath;
      session.sdpPath = '';
      const cleanupTimer = setTimeout(() => {
        fs.promises.unlink(sdpPath).catch(() => {});
      }, 3000);
      cleanupTimer.unref?.();
    }
  }

  _stopSession(producerId, reason = '', { quiet = false } = {}) {
    const session = this.sessions.get(producerId);
    if (!session) return;
    this.sessions.delete(producerId);
    this._disposeSessionResources(session);
    if (!quiet) {
      this.log(`[Recording] 録画停止 name=${session.locationName} source=${session.source}${reason ? ` (${reason})` : ''}`);
    }
    // 最終セグメントの回収(ffmpeg終了を少し待つ)
    setTimeout(() => this._sweepRawSegments().catch(() => {}), 4000).unref?.();
  }

  // ── ライブ視聴(録画中セグメントの追記追従ストリーミング) ──

  /** 現在録画中のセッション一覧(再生UIのライブモード用) */
  getLiveSessions() {
    return [...this.sessions.values()]
      .filter(session => !session.ffmpegExited)
      .map(session => ({
        producerId: session.producerId,
        key: `${session.locKey}__${session.source}`,
        locKey: session.locKey,
        source: session.source,
        locationName: session.locationName,
        socketId: session.socketId,
        hasAudio: !!session.audioConsumer,
        startedAt: session.startedAt,
        rawExt: session.rawExt,
        liveUrl: `/recordings/live/${encodeURIComponent(session.producerId)}`,
      }));
  }

  /**
   * ライブ視聴対象 = そのセッションが現在書き込み中の生セグメントファイル。
   * webm(VP8/Opus)はブラウザがそのまま再生できる。
   */
  async resolveLiveFile(videoProducerId) {
    const session = this.sessions.get(shortString(videoProducerId, 128));
    if (!session || session.ffmpegExited) return null;
    let names = [];
    try {
      names = (await fs.promises.readdir(session.outDir))
        .filter(n => RAW_FILE_RE.test(n) && n.includes(`_${session.sessionTag}.`))
        .sort();
    } catch { return null; }
    if (!names.length) return null;
    const name = names[names.length - 1];
    return {
      filePath: path.join(session.outDir, name),
      mime: session.rawExt === 'webm' ? 'video/webm' : 'video/x-matroska',
      producerId: session.producerId,
    };
  }

  /**
   * 書込み中の生セグメントをO_NOFOLLOWで一度だけopenする。
   * ルート/出力ディレクトリの内外判定とlstat/fstatの同一性を確認し、
   * 呼び出し元は追記追従中もこの同じFileHandleだけを使う。
   */
  async openLiveFile(videoProducerId) {
    const live = await this.resolveLiveFile(videoProducerId);
    if (!live) return null;
    const session = this.sessions.get(shortString(videoProducerId, 128));
    if (!session || session.ffmpegExited) return null;

    const rawRoot = path.resolve(this.rawDir());
    const outDir = path.resolve(session.outDir);
    const outRelative = path.relative(rawRoot, outDir);
    if (!outRelative || outRelative === '..' || outRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(outRelative)) return null;

    const logicalPath = path.resolve(live.filePath);
    if (path.dirname(logicalPath) !== outDir) return null;
    let handle = null;
    try {
      const rootBefore = await fs.promises.lstat(rawRoot);
      if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return null;
      const rootReal = await fs.promises.realpath(rawRoot);

      const outBefore = await fs.promises.lstat(outDir);
      if (!outBefore.isDirectory() || outBefore.isSymbolicLink()) return null;
      const outReal = await fs.promises.realpath(outDir);
      const realOutRelative = path.relative(rootReal, outReal);
      if (!realOutRelative || realOutRelative === '..' || realOutRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(realOutRelative)) return null;

      const pathStat = await fs.promises.lstat(logicalPath);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
      const fileReal = await fs.promises.realpath(logicalPath);
      if (path.dirname(fileReal) !== outReal) return null;

      handle = await fs.promises.open(
        fileReal,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const openedStat = await handle.stat();
      if (!sameFileIdentity(pathStat, openedStat)) {
        await handle.close().catch(() => {});
        return null;
      }

      // Detect root/outDir replacement during validation/open. The already
      // opened file is safe, but rejecting avoids serving an ambiguous race.
      const [rootAfter, rootRealAfter, outAfter, outRealAfter] = await Promise.all([
        fs.promises.lstat(rawRoot),
        fs.promises.realpath(rawRoot),
        fs.promises.lstat(outDir),
        fs.promises.realpath(outDir),
      ]);
      if (rootAfter.isSymbolicLink() || outAfter.isSymbolicLink() ||
          !sameDirectoryIdentity(rootBefore, rootAfter) ||
          !sameDirectoryIdentity(outBefore, outAfter) ||
          rootRealAfter !== rootReal || outRealAfter !== outReal) {
        await handle.close().catch(() => {});
        return null;
      }
      return {
        ...live,
        handle,
        stat: openedStat,
        filePath: fileReal,
        logicalPath,
      };
    } catch {
      await handle?.close().catch(() => {});
      return null;
    }
  }

  _stopAllSessions(reason) {
    for (const producerId of [...this.sessions.keys()]) this._stopSession(producerId, reason);
  }

  // ── セグメント完了検出 → 圧縮キュー ──────────────────────

  /** raw ディレクトリを走査し、書き込みが完了したセグメントを圧縮キューへ入れる */
  async _sweepRawSegments() {
    if (this._sweepInFlight) return this._sweepInFlight;
    const sweepPromise = this._sweepRawSegmentsOnce();
    this._sweepInFlight = sweepPromise;
    try {
      return await sweepPromise;
    } finally {
      if (this._sweepInFlight === sweepPromise) this._sweepInFlight = null;
    }
  }

  async _sweepRawSegmentsOnce() {
    // index/NAS commit後のrawまたはlocal encoded削除だけが失敗した
    // ジョブは、rawディレクトリ列挙とは独立して必ず再試行する。
    for (const [rawPath, localReadyPath] of [...this.finalizedRawPaths]) {
      await this._deleteFinalizedRaw(rawPath, localReadyPath);
    }
    if (!this.storageOk) return;
    const rawRoot = this.rawDir();
    let locEntries = [];
    try {
      locEntries = (await fs.promises.readdir(rawRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && LOCATION_KEY_RE.test(entry.name))
        .slice(0, MAINTENANCE_MAX_KEY_DIRS);
    } catch { return; }

    // アクティブセッションが現在書き込み中のファイル(そのdirの最新ファイル)は除外する
    const activeDirs = new Map(); // outDir → session
    for (const session of this.sessions.values()) {
      if (!session.ffmpegExited) activeDirs.set(session.outDir, session);
    }

    const now = Date.now();
    for (const locEntry of locEntries) {
      const locKey = locEntry.name;
      const locDir = path.join(rawRoot, locKey);
      let sourceEntries = [];
      try {
        sourceEntries = (await fs.promises.readdir(locDir, { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && ['camera', 'screen'].includes(entry.name));
      } catch { continue; }
      for (const sourceEntry of sourceEntries) {
        const source = sourceEntry.name;
        const dir = path.join(locDir, source);
        let names = [];
        try {
          names = (await fs.promises.readdir(dir, { withFileTypes: true }))
            .filter(entry => entry.isFile() && RAW_FILE_RE.test(entry.name))
            .map(entry => entry.name)
            .sort();
        } catch { continue; }
        const activeSession = activeDirs.get(dir);
        const newest = names[names.length - 1];

        for (const name of names) {
          const rawPath = path.join(dir, name);
          if (this.finalizeInFlight.has(rawPath)) continue;
          if (this.finalizedRawPaths.has(rawPath)) {
            await this._deleteFinalizedRaw(rawPath, this.finalizedRawPaths.get(rawPath));
            continue;
          }
          const failure = this.finalizeFailures.get(rawPath);
          if (failure && now < failure.nextAttemptAt) continue;
          let st;
          try { st = await fs.promises.stat(rawPath); } catch { continue; }

          // アクティブセッションの最新ファイルは書き込み途中
          if (activeSession && name === newest && name.includes(`_${activeSession.sessionTag}.`)) continue;
          // 書き込みが止まってから一定時間経つまで待つ
          if (now - st.mtimeMs < SEGMENT_FINALIZE_IDLE_MS) continue;

          if (st.size < 4096) {
            // RTPが届かないまま閉じた空セグメントは破棄
            await fs.promises.unlink(rawPath).catch(() => {});
            continue;
          }
          const meta = this._parseRawName(locKey, source, name, st);
          if (!meta) continue;
          if (this.compressionQueue.length + this.compressionActive.size >= MAX_COMPRESSION_QUEUE) {
            if (!this.recordingBackpressure) {
              this.recordingBackpressure = true;
              this._notifyClientPolicyIfChanged();
              this.log(`[Recording] WARN: 圧縮待ちが${MAX_COMPRESSION_QUEUE}件に達したため、会議を優先して新規録画を一時停止します`);
              this._stopAllSessions('圧縮待ちキュー過多');
            }
            this._runCompressionQueue();
            return;
          }
          this.finalizeInFlight.add(rawPath);
          this.compressionQueue.push({ rawPath, meta });
        }
      }
    }
    this._runCompressionQueue();
  }

  _parseRawName(locKey, source, name, st) {
    const m = name.match(RAW_FILE_RE);
    if (!m) return null;
    const [, Y, Mo, D, H, Mi, S, sessionTag] = m;
    const startMs = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S)).getTime();
    if (!Number.isFinite(startMs)) return null;
    const durationMs = Math.max(500, Math.min(st.mtimeMs - startMs, 24 * 3600 * 1000));
    return { locKey, source, startMs, durationMs, size: st.size, sessionTag };
  }

  async _deleteFinalizedRaw(rawPath, localReadyPath = '') {
    this.finalizedRawPaths.set(rawPath, localReadyPath || '');
    // index/NAS commit後のcleanup。先にencodedを消し、rawを最後に残すことで、
    // 途中でprocessが落ちても次回raw走査から決定的IDで復旧できる。
    if (localReadyPath) {
      try {
        await fs.promises.unlink(localReadyPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') return false;
      }
    }
    try {
      await fs.promises.unlink(rawPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
    }
    this.finalizedRawPaths.delete(rawPath);
    return true;
  }

  /**
   * 確定queueを処理する。既定は同時1ジョブで、各ffmpegも1threadへ制限する。
   * 複数拠点が同時にsegment境界を跨いだ場合は、取り込みと会議を優先して順番に処理する。
   */
  _runCompressionQueue() {
    if (this._stopped || !this.settings.enabled || !this.storageOk || this.stagingLowDisk || this.lowDisk) return;
    const limit = this.compressionConcurrency();
    while (this.compressionActive.size < limit && this.compressionQueue.length) {
      const job = this.compressionQueue.shift();
      const jobName = path.basename(job.rawPath);
      const generation = this.settingsGeneration;
      this.compressionActive.add(job.rawPath);
      this._finalizeRaw(job.rawPath, job.meta, generation)
        .then(() => this.finalizeFailures.delete(job.rawPath))
        .catch(err => {
          const previous = this.finalizeFailures.get(job.rawPath) || { attempts: 0 };
          const attempts = previous.attempts + 1;
          const retryMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts - 1, 7)));
          this.finalizeFailures.set(job.rawPath, { attempts, nextAttemptAt: Date.now() + retryMs });
          this.log(`[Recording] WARN: セグメント処理失敗 ${jobName}: ${err.message} (${Math.round(retryMs / 1000)}秒後に再試行)`);
        })
        .finally(() => {
          this.finalizeInFlight.delete(job.rawPath);
          this.compressionActive.delete(job.rawPath);
          // 続きがあれば次へ
          setTimeout(() => this._runCompressionQueue(), 100).unref?.();
        });
    }
  }

  async _probeInfo(filePath) {
    if (!this.ffprobePath || this._stopped || !this.settings.enabled) return {};
    return new Promise(resolve => {
      let settled = false;
      let stdout = '';
      let overflow = false;
      let timeout = null;
      let killFallback = null;
      let proc;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killFallback) clearTimeout(killFallback);
        if (proc) this.compressionChildren.delete(proc);
        resolve(value);
      };
      try {
        proc = spawn(this.ffprobePath, [
          '-v', 'error',
          '-show_entries', 'stream=codec_type,codec_name:format=duration',
          '-of', 'json',
          filePath,
        ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch {
        finish({});
        return;
      }
      this.compressionChildren.add(proc);
      lowerChildPriority(proc);
      proc.stdout.on('data', chunk => {
        if (overflow) return;
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout) > 1024 * 1024) {
          overflow = true;
          try { proc.kill('SIGKILL'); } catch (_) {}
        }
      });
      proc.on('error', () => {
        // spawn error後もcloseが通常発火するため、child slotはcloseまで
        // 保持する。OS異常時だけ短いfallbackで解放する。
        if (!killFallback) {
          killFallback = setTimeout(() => finish({}), 2000);
          killFallback.unref?.();
        }
      });
      proc.on('close', code => {
        if (code !== 0 || overflow) return finish({});
        try {
          const data = JSON.parse(stdout || '{}');
          const streams = Array.isArray(data.streams) ? data.streams.slice(0, 32) : [];
          const durationSec = Number(data.format?.duration);
          finish({
            codec: shortString(streams.find(s => s?.codec_type === 'video')?.codec_name, 32),
            audioCodec: shortString(streams.find(s => s?.codec_type === 'audio')?.codec_name, 32),
            hasAudio: streams.some(s => s?.codec_type === 'audio'),
            durationMs: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
          });
        } catch {
          finish({});
        }
      });
      timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        // slotはchildのcloseを待って解放する。OS異常時のみ2秒後に打ち切る。
        killFallback = setTimeout(() => finish({}), 2000);
        killFallback.unref?.();
      }, 15_000);
      timeout.unref?.();
    });
  }

  /**
   * タイムスタンプ焼き込み(右下)の drawtext フィルタを組み立てる。
   * セグメント開始時刻(壁時計)+フレーム時刻で実時刻を描画する。
   */
  _timestampFilter(startMs, maxHeight) {
    if (!this.settings.timestampOverlay) return null;
    const fontFile = this._findFontFile();
    if (!fontFile) return null;
    // Windowsパスの \ と : は filtergraph 内でエスケープが必要
    const escapedFont = fontFile.replace(/\\/g, '/').replace(/:/g, '\\:');
    const epochSec = Math.floor(startMs / 1000);
    const fontsize = maxHeight >= 1080 ? 32 : maxHeight >= 720 ? 24 : 18;
    // localtime の既定書式は "%Y-%m-%d %H:%M:%S"(そのまま監視カメラ様式)
    return `drawtext=fontfile='${escapedFont}'` +
      `:text='%{pts\\:localtime\\:${epochSec}}'` +
      `:x=w-tw-12:y=h-th-10:fontsize=${fontsize}:fontcolor=white` +
      `:box=1:boxcolor=black@0.45:boxborderw=6`;
  }

  async _cleanupEncodedJob(jobHash) {
    let names = [];
    try { names = await fs.promises.readdir(this.encodedDir()); } catch { return; }
    await Promise.all(names
      .filter(name => name.startsWith(`${jobHash}.`))
      .map(name => fs.promises.unlink(path.join(this.encodedDir(), name)).catch(() => {})));
  }

  async _finalizeRaw(rawPath, meta, generation = this.settingsGeneration) {
    const assertCurrent = () => {
      if (this._stopped || !this.settings.enabled || generation !== this.settingsGeneration) {
        throw new Error('録画設定の変更により処理を中断しました');
      }
    };
    assertCurrent();
    let st;
    try { st = await fs.promises.stat(rawPath); } catch { return; } // 消えていたら何もしない

    // raw名+サイズから決定的なIDを作る。同じrawの再試行やサーバー再起動で
    // 出力名/index IDが変わらないため、重複圧縮と重複indexを防げる。
    const rawName = path.basename(rawPath);
    const jobHash = crypto.createHash('sha256')
      .update(`${meta.locKey}\0${meta.source}\0${rawName}\0${st.size}`)
      .digest('hex')
      .slice(0, 16);
    const dateStr = fmtDate(meta.startMs);
    const id = `${meta.locKey}~${meta.source}~${dateStr}~${meta.startMs}~${jobHash}`;
    const recordingsRoot = path.resolve(this.recordingsDir());
    const dbRoot = path.resolve(this.dbDir());

    // index+mediaが既にcommit済みなら、raw削除だけを再試行する。
    const existingDayFile = path.join(dbRoot, 'segments', `${meta.locKey}__${meta.source}`, `${dateStr}.json`);
    const existingDay = asObject(await readJsonAsync(existingDayFile, null));
    const existingEntry = Array.isArray(existingDay.segments)
      ? existingDay.segments.find(entry => entry?.id === id)
      : null;
    if (existingEntry?.file) {
      const existingPath = path.resolve(recordingsRoot, existingEntry.file);
      if (existingPath.startsWith(recordingsRoot + path.sep)) {
        const existingStat = await fs.promises.stat(existingPath).catch(() => null);
        if (existingStat?.isFile() && existingStat.size >= 1024) {
          const removed = await this._deleteFinalizedRaw(rawPath);
          if (removed) await this._cleanupEncodedJob(jobHash);
          return;
        }
      }
    }

    const probe = await this._probeInfo(rawPath);
    assertCurrent();
    if (probe.durationMs) meta.durationMs = probe.durationMs;
    const srcCodec = probe.codec || 'vp8';
    const hasAudio = !!probe.hasAudio;

    const finalDir = path.join(recordingsRoot, meta.locKey, meta.source, dateStr);
    const encodedDir = this.encodedDir();
    const mode = this.settings.compressionMode;
    const baseName = `${fmtTimeCompact(meta.startMs)}_${jobHash}`;

    // タイムスタンプ焼き込みは再エンコードでのみ可能。
    // 「圧縮しない」設定でも焼き込みONなら再エンコードする(高画質プリセット)。
    const preset = COMPRESSION_PRESETS[mode] || COMPRESSION_PRESETS.light;
    const timestampFilter = this._timestampFilter(meta.startMs, preset.maxHeight);
    const reencode = mode !== 'none' || !!timestampFilter;

    const remuxSuffix = srcCodec === 'h264'
      ? (hasAudio ? 'mkv' : 'mp4')
      : (srcCodec === 'vp8' || srcCodec === 'vp9' ? 'webm' : 'mkv');
    const filters = [];
    if (mode !== 'none') filters.push(`scale=-2:min(${preset.maxHeight}\\,ih)`);
    if (timestampFilter) filters.push(timestampFilter);
    const primary = reencode
      ? {
          suffix: 'mp4',
          codec: 'h264',
          status: 'ready',
          args: output => [
            '-i', rawPath,
            '-c:v', 'libx264', '-preset', 'veryfast',
            '-threads', '1', '-filter_threads', '1',
            '-crf', String(mode !== 'none' ? preset.crf : 23),
            ...(filters.length ? ['-vf', filters.join(',')] : []),
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'] : ['-an']),
            output,
          ],
        }
      : {
          suffix: remuxSuffix,
          codec: srcCodec,
          status: 'ready',
          args: output => [
            '-i', rawPath, '-c', 'copy', '-threads', '1',
            ...(remuxSuffix === 'mp4' ? ['-movflags', '+faststart'] : []),
            output,
          ],
        };
    const fallback = {
      suffix: remuxSuffix,
      codec: srcCodec,
      status: 'ready',
      args: output => [
        '-i', rawPath, '-c', 'copy', '-threads', '1',
        ...(remuxSuffix === 'mp4' ? ['-movflags', '+faststart'] : []),
        output,
      ],
    };
    const sourceContainer = ['webm', 'mkv'].includes(path.extname(rawPath).slice(1).toLowerCase())
      ? path.extname(rawPath).slice(1).toLowerCase()
      : 'mkv';
    const rawFallback = { suffix: `raw.${sourceContainer}`, codec: srcCodec, status: 'raw' };
    const candidates = [primary, ...(reencode ? [fallback] : []), rawFallback]
      .filter((candidate, index, all) => all.findIndex(item => item.suffix === candidate.suffix) === index);

    await fs.promises.mkdir(encodedDir, { recursive: true });
    await fs.promises.mkdir(finalDir, { recursive: true });

    const usableStat = async filePath => {
      const fileStat = await fs.promises.stat(filePath).catch(() => null);
      return fileStat?.isFile() && fileStat.size >= 1024 ? fileStat : null;
    };

    // 前回がNAS転送後/index書込前に終了した場合は、NAS上の決定的な
    // 最終ファイルを再利用し、再エンコードしない。
    let selected = null;
    let localReadyPath = '';
    let finalPath = '';
    let outSize = 0;
    for (const candidate of candidates) {
      const candidateFinal = path.join(finalDir, `${baseName}.${candidate.suffix}`);
      const candidateStat = await usableStat(candidateFinal);
      if (!candidateStat) continue;
      selected = candidate;
      finalPath = candidateFinal;
      outSize = candidateStat.size;
      break;
    }

    if (!selected) {
      for (const candidate of candidates) {
        const candidateLocal = path.join(encodedDir, `${jobHash}.${candidate.suffix}`);
        if (!await usableStat(candidateLocal)) continue;
        selected = candidate;
        localReadyPath = candidateLocal;
        break;
      }
    }

    if (!selected) {
      const attempts = [primary, ...(reencode ? [fallback] : [])];
      for (const attempt of attempts) {
        const partialPath = path.join(encodedDir, `${jobHash}.partial.${attempt.suffix}`);
        const readyPath = path.join(encodedDir, `${jobHash}.${attempt.suffix}`);
        await fs.promises.unlink(partialPath).catch(() => {});
        const ok = await this._runFfmpeg([
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          ...attempt.args(partialPath),
        ]);
        assertCurrent();
        const partialStat = ok ? await usableStat(partialPath) : null;
        if (!partialStat) {
          await fs.promises.unlink(partialPath).catch(() => {});
          continue;
        }
        await renameReplacing(partialPath, readyPath);
        selected = attempt;
        localReadyPath = readyPath;
        break;
      }
    }

    if (!selected) {
      // 壊れかけのrawでremuxもできない場合は、ローカルstaging内で非同期
      // copyして保全する。NASへの大容量copyをNodeの同期I/Oで行わない。
      const partialPath = path.join(encodedDir, `${jobHash}.partial.${rawFallback.suffix}`);
      const readyPath = path.join(encodedDir, `${jobHash}.${rawFallback.suffix}`);
      await fs.promises.unlink(partialPath).catch(() => {});
      await fs.promises.copyFile(rawPath, partialPath);
      assertCurrent();
      if (!await usableStat(partialPath)) {
        await fs.promises.unlink(partialPath).catch(() => {});
        throw new Error('rawセグメントのローカル保全に失敗しました');
      }
      await renameReplacing(partialPath, readyPath);
      selected = rawFallback;
      localReadyPath = readyPath;
    }

    if (!finalPath) {
      assertCurrent();
      finalPath = path.join(finalDir, `${baseName}.${selected.suffix}`);
      const localStat = await usableStat(localReadyPath);
      if (!localStat) throw new Error('ローカルの処理済みセグメントが見つかりません');
      const existingFinal = await usableStat(finalPath);
      if (!existingFinal || existingFinal.size !== localStat.size) {
        const transferPartial = `${finalPath}.${process.pid}.${jobHash}.partial`;
        await fs.promises.unlink(transferPartial).catch(() => {});
        try {
          await fs.promises.copyFile(localReadyPath, transferPartial);
          assertCurrent();
          const copiedStat = await usableStat(transferPartial);
          if (!copiedStat || copiedStat.size !== localStat.size) {
            throw new Error('NASへの転送サイズが一致しません');
          }
          await renameReplacing(transferPartial, finalPath);
        } finally {
          await fs.promises.unlink(transferPartial).catch(() => {});
        }
      }
      outSize = (await usableStat(finalPath))?.size || 0;
    }

    if (outSize < 1024) throw new Error('完成セグメントが空です');
    assertCurrent();
    const relFile = path.relative(recordingsRoot, finalPath);
    const entry = {
      id,
      startMs: meta.startMs,
      durationMs: meta.durationMs,
      file: relFile.split(path.sep).join('/'),
      size: outSize,
      codec: selected.codec,
      audio: hasAudio,
      status: selected.status,
    };
    await this._appendIndexEntry(meta.locKey, meta.source, dateStr, entry, { dbRoot });
    const removed = await this._deleteFinalizedRaw(rawPath, localReadyPath);
    if (removed) await this._cleanupEncodedJob(jobHash);
    if (!removed) {
      this.log(`[Recording] WARN: index登録済み一時ファイルを削除できないため、削除だけを再試行します: ${rawName}`);
    }
    this._usageCache = null;
    const ratio = st.size > 0 ? Math.round((outSize / st.size) * 100) : 100;
    this.log(`[Recording] セグメント保存 ${meta.locKey}/${meta.source} ${dateStr} ${fmtTimeCompact(meta.startMs)} ${(outSize / 1024 / 1024).toFixed(1)}MB (元比${ratio}%)`);
  }

  _runFfmpeg(args) {
    return new Promise(resolve => {
      let settled = false;
      let timedOut = false;
      let spawnError = false;
      let timeout = null;
      let killFallback = null;
      let proc;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killFallback) clearTimeout(killFallback);
        if (proc) this.compressionChildren.delete(proc);
        resolve(value);
      };
      try {
        proc = spawn(this.ffmpegPath, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        });
      } catch {
        finish(false);
        return;
      }
      this.compressionChildren.add(proc);
      lowerChildPriority(proc);
      let stderrTail = '';
      proc.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-1000); });
      proc.on('error', () => {
        spawnError = true;
        if (!killFallback) {
          killFallback = setTimeout(() => finish(false), 2000);
          killFallback.unref?.();
        }
      });
      proc.on('close', code => {
        if (code !== 0 && stderrTail) this.log(`[Recording] ffmpeg: ${stderrTail.split('\n').slice(-1)[0]}`);
        finish(!timedOut && !spawnError && code === 0);
      });
      // 暴走防止(1セグメントの処理は最長15分)
      timeout = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGKILL'); } catch (_) {}
        // 通常はcloseを待ってslotを解放。OSレベルで子プロセスが固まり
        // closeしない場合のみ、5秒後に管理上のslotを解放する。
        killFallback = setTimeout(() => finish(false), 5000);
        killFallback.unref?.();
      }, 15 * 60 * 1000);
      timeout.unref?.();
    });
  }

  // ── インデックス(データベース) ───────────────────────────

  _segmentsDir() {
    return path.join(this.dbDir(), 'segments');
  }

  _dayFilePath(locKey, source, dateStr) {
    return path.join(this._segmentsDir(), `${locKey}__${source}`, `${dateStr}.json`);
  }

  _locationsFilePath() {
    return path.join(this.dbDir(), 'locations.json');
  }

  /** インデックス更新は直列化する(圧縮キューと保持期間掃除の競合防止) */
  _withIndexLock(fn) {
    const next = this._indexChain.then(fn, fn);
    this._indexChain = next.catch(() => {});
    return next;
  }

  _locationUpdateKey(update) {
    return `${path.resolve(update.dbRoot)}\0${update.locKey}\0${update.source}`;
  }

  async _writeLocationUpdates(dbRoot, updates) {
    if (!updates.length) return;
    const locFile = path.join(dbRoot, 'locations.json');
    const locations = asObject(await readJsonAsync(locFile, {}));
    for (const update of updates) {
      const key = `${update.locKey}__${update.source}`;
      const known = asObject(locations[key]);
      locations[key] = {
        locKey: update.locKey,
        source: update.source,
        locationName: update.locationName || known.locationName || update.locKey,
        lastSegmentAt: Math.max(Number(known.lastSegmentAt) || 0, update.lastSegmentAt),
      };
    }
    await writeJsonAtomicAsync(locFile, locations);
  }

  _flushPendingLocationUpdates() {
    if (!this._pendingLocationUpdates.size || this._stopped || !this.storageOk) {
      return Promise.resolve();
    }
    return this._withIndexLock(async () => {
      // 保存先変更の前後が混在しても、dbRoot単位で独立して修復する。
      const byRoot = new Map();
      for (const update of this._pendingLocationUpdates.values()) {
        if (!byRoot.has(update.dbRoot)) byRoot.set(update.dbRoot, []);
        byRoot.get(update.dbRoot).push(update);
      }
      for (const [dbRoot, updates] of byRoot) {
        try {
          await this._writeLocationUpdates(dbRoot, updates);
          for (const update of updates) {
            const updateKey = this._locationUpdateKey(update);
            if (this._pendingLocationUpdates.get(updateKey) === update) {
              this._pendingLocationUpdates.delete(updateKey);
            }
          }
        } catch (err) {
          this.log(`[Recording] WARN: 拠点レジストリの再試行に失敗: ${err.message}`);
        }
      }
    });
  }

  _appendIndexEntry(locKey, source, dateStr, entry, { dbRoot = this.dbDir() } = {}) {
    return this._withIndexLock(async () => {
      const dayFile = path.join(dbRoot, 'segments', `${locKey}__${source}`, `${dateStr}.json`);
      const data = asObject(await readJsonAsync(dayFile, null)) || { locKey, source, date: dateStr, segments: [] };
      if (!Array.isArray(data.segments)) data.segments = [];
      // 決定的IDでupsertし、day書込後のクラッシュ/再試行でも重複させない。
      data.segments = data.segments.filter(segment => segment?.id !== entry.id);
      data.segments.push(entry);
      data.segments.sort((a, b) => a.startMs - b.startMs);
      await writeJsonAtomicAsync(dayFile, data);
      this._dayCache.delete(dayFile);

      // day indexは録画データのcommit。locations更新の一時失敗でdayまで
      // 失敗扱いにするとrawを再圧縮するため、レジストリだけ独立して縮退する。
      const session = [...this.sessions.values()].find(s => s.locKey === locKey && s.source === source);
      const currentUpdate = {
        dbRoot: path.resolve(dbRoot),
        locKey,
        source,
        locationName: session?.locationName || '',
        lastSegmentAt: entry.startMs + entry.durationMs,
      };
      const currentUpdateKey = this._locationUpdateKey(currentUpdate);
      this._pendingLocationUpdates.set(currentUpdateKey, currentUpdate);
      try {
        // 今回分と、同じDBに向けた以前の失敗分をまとめてupsertする。
        const updates = [...this._pendingLocationUpdates.values()]
          .filter(update => path.resolve(update.dbRoot) === currentUpdate.dbRoot);
        await this._writeLocationUpdates(currentUpdate.dbRoot, updates);
        for (const update of updates) {
          const updateKey = this._locationUpdateKey(update);
          if (this._pendingLocationUpdates.get(updateKey) === update) {
            this._pendingLocationUpdates.delete(updateKey);
          }
        }
      } catch (err) {
        this.log(`[Recording] WARN: 拠点レジストリの更新に失敗: ${err.message}`);
      }
    });
  }

  async _readDayFile(locKey, source, dateStr) {
    const dayFile = this._dayFilePath(locKey, source, dateStr);
    let st;
    try { st = await fs.promises.stat(dayFile); } catch { return null; }
    const cached = this._dayCache.get(dayFile);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    const data = asObject(await readJsonAsync(dayFile, null));
    if (!data || !Array.isArray(data.segments)) return null;
    this._dayCache.set(dayFile, { mtimeMs: st.mtimeMs, data });
    if (this._dayCache.size > 200) {
      const first = this._dayCache.keys().next().value;
      this._dayCache.delete(first);
    }
    return data;
  }

  /** 録画のある拠点一覧(インデックス + 現在録画中) */
  async listLocations() {
    const locations = asObject(await readJsonAsync(this._locationsFilePath(), {}));
    const result = new Map();
    let scanned = 0;
    for (const key in locations) {
      if (!Object.prototype.hasOwnProperty.call(locations, key)) continue;
      scanned += 1;
      if (scanned > 2048 || result.size >= 512) break;
      const value = locations[key];
      const item = asObject(value);
      if (!SEGMENT_QUERY_KEY_RE.test(shortString(key, 128)) ||
          !LOCATION_KEY_RE.test(shortString(item.locKey, 64)) ||
          !['camera', 'screen'].includes(item.source) ||
          key !== `${item.locKey}__${item.source}`) continue;
      result.set(key, {
        key,
        locKey: item.locKey,
        source: item.source,
        locationName: shortString(item.locationName || item.locKey, 128),
        lastSegmentAt: Number(item.lastSegmentAt) || 0,
        recording: false,
      });
    }
    for (const session of this.sessions.values()) {
      const key = `${session.locKey}__${session.source}`;
      const existing = result.get(key) || {
        key,
        locKey: session.locKey,
        source: session.source,
        locationName: session.locationName,
        lastSegmentAt: 0,
      };
      existing.locationName = session.locationName;
      existing.recording = !session.ffmpegExited;
      result.set(key, existing);
    }
    return [...result.values()].sort((a, b) => a.locationName.localeCompare(b.locationName, 'ja'));
  }

  /** 期間内のセグメント一覧。keys 未指定なら全拠点 */
  async querySegments({ keys = null, fromMs, toMs }) {
    const queryWindow = normalizeSegmentQueryWindow(fromMs, toMs);
    if (!queryWindow) return [];
    const { from, to, firstDayMs, dayCount } = queryWindow;
    const knownLocations = await this.listLocations();
    const knownKeys = new Set(knownLocations
      .map(location => shortString(location.key, 128))
      .filter(key => SEGMENT_QUERY_KEY_RE.test(key)));
    const requestedKeys = Array.isArray(keys) && keys.length
      ? keys.map(key => shortString(key, 128))
      : [...knownKeys];
    const wanted = [...new Set(requestedKeys)]
      .filter(key => knownKeys.has(key))
      .slice(0, 64);

    // 日付ファイル内の segments は _appendIndexEntry で startMs 順に保持される。
    // 各ファイルを1本のソート済み列として最小ヒープでマージし、
    // 全体で最も古い5000件が確定した時点で走査を終える。
    const heap = [];
    let sequence = 0;
    const queueNextSegment = stream => {
      while (stream.index < stream.segments.length) {
        const seg = stream.segments[stream.index++];
        const startMs = Number(seg?.startMs);
        const durationMs = Number(seg?.durationMs || 0);
        if (!Number.isSafeInteger(startMs) || !Number.isFinite(durationMs)) continue;
        const segEnd = startMs + Math.max(0, durationMs);
        if (segEnd <= from || startMs >= to) continue;
        segmentHeapPush(heap, { startMs, sequence: sequence++, seg, stream });
        return;
      }
    };

    for (const key of wanted) {
      const sep = key.lastIndexOf('__');
      const locKey = key.slice(0, sep);
      const source = key.slice(sep + 2);
      const seenDates = new Set();
      // 期間がまたぐ日付を列挙(前日開始のセグメントも拾うため1日前から)
      for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
        const dayMs = firstDayMs + dayIndex * DAY_MS;
        const dateStr = fmtDate(dayMs);
        if (seenDates.has(dateStr)) continue;
        seenDates.add(dateStr);
        const data = await this._readDayFile(locKey, source, dateStr);
        if (!data) continue;
        const stream = { segments: data.segments, index: 0, key, locKey, source };
        queueNextSegment(stream);
      }
    }

    const results = [];
    while (heap.length && results.length < MAX_SEGMENT_QUERY_RESULTS) {
      const entry = segmentHeapPop(heap);
      const { seg, stream } = entry;
      results.push({ ...seg, key: stream.key, locKey: stream.locKey, source: stream.source });
      queueNextSegment(stream);
    }
    return results;
  }

  /**
   * セグメントIDから実ファイルを検証し、配信用FileHandleを開く。
   *
   * 検証後にパスを改めてopenすると、NAS上のファイルをsymlinkへ
   * 差し替えられるTOCTOU競合が残る。ここでO_NOFOLLOW付きでopenし、
   * lstatとfstatのファイル同一性も確認した同じFDを呼び出し元へ渡す。
   * 呼び出し元は必ずhandle.close()すること。
   */
  async openMediaFile(id) {
    const rawId = String(id ?? '');
    if (!rawId || rawId.length > 256) return null;
    const cleanId = rawId;
    const parts = cleanId.split('~');
    if (parts.length !== 5) return null;
    const [locKey, source, dateStr] = parts;
    if (!LOCATION_KEY_RE.test(locKey) || !['camera', 'screen'].includes(source) ||
        !SEGMENT_DATE_RE.test(dateStr)) return null;
    const data = await this._readDayFile(locKey, source, dateStr);
    if (!data) return null;
    let seg = null;
    let scanned = 0;
    for (const candidate of data.segments) {
      scanned += 1;
      if (scanned > 100_000) break;
      if (candidate?.id === cleanId) {
        seg = candidate;
        break;
      }
    }
    if (!seg || typeof seg.file !== 'string' || !seg.file || seg.file.length > 4096) return null;
    const root = path.resolve(this.recordingsDir());
    const abs = path.resolve(root, seg.file);
    if (!abs.startsWith(root + path.sep)) return null;
    let handle = null;
    try {
      const [rootReal, stat, real] = await Promise.all([
        fs.promises.realpath(root),
        fs.promises.lstat(abs),
        fs.promises.realpath(abs),
      ]);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      if (!real.startsWith(rootReal + path.sep)) return null;
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      handle = await fs.promises.open(real, fs.constants.O_RDONLY | noFollow);
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        await handle.close().catch(() => {});
        return null;
      }
      // POSIXではdev+inoで、それらが利用できない環境でも
      // O_NOFOLLOWと同一FD配信で、検証後の最終成分差し替えを防ぐ。
      const hasStableIdentity = Number(stat.dev) !== 0 && Number(stat.ino) !== 0 &&
        Number(openedStat.dev) !== 0 && Number(openedStat.ino) !== 0;
      if (hasStableIdentity && (stat.dev !== openedStat.dev || stat.ino !== openedStat.ino)) {
        await handle.close().catch(() => {});
        return null;
      }
      return { handle, stat: openedStat, filePath: real };
    } catch {
      await handle?.close().catch(() => {});
      return null;
    }
  }

  /** 後方互換用。新規のメディア配信はopenMediaFile()の同一FDを使う。 */
  async resolveMediaPath(id) {
    const opened = await this.openMediaFile(id);
    if (!opened) return null;
    try {
      return opened.filePath;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  // ── 容量管理(使用レート推定・最低空き容量の確保) ─────────

  async _diskFreeBytes() {
    try {
      const st = await fs.promises.statfs(this.recordingsDir());
      const freeBytes = st.bavail * st.bsize;
      this._summaryDiskCache = {
        ...(this._summaryDiskCache || {}),
        at: Date.now(),
        freeBytes,
        totalBytes: st.blocks * st.bsize,
      };
      return freeBytes;
    } catch {
      return null;
    }
  }

  async _refreshUsageCacheAsync() {
    if (this._usageRefreshInFlight) return this._usageRefreshInFlight;
    if (this._stopped || !this.storageOk) return null;
    // NAS indexの複数readは非同期でもI/O帯域を使う。録画中は30分、無負荷時も
    // 5分のcacheを使い、24時間録画で永久にstaleにはしない一方、毎分走査を避ける。
    const busy = this.sessions.size || this.compressionQueue.length || this.finalizeInFlight.size ||
      this.compressionActive.size || this.compressionChildren.size;
    const minRefreshMs = busy ? 30 * 60 * 1000 : 5 * 60 * 1000;
    if (this._usageCache && Date.now() - this._usageCache.at < minRefreshMs) {
      return this._usageCache.data;
    }

    const refreshPromise = (async () => {
      const now = Date.now();
      const fromMs = now - DAY_MS;
      const dbRoot = path.resolve(this.dbDir());
      const locationData = asObject(await readJsonAsync(path.join(dbRoot, 'locations.json'), {}));
      const keys = new Map();
      for (const value of Object.values(locationData)) {
        const item = asObject(value);
        if (!LOCATION_KEY_RE.test(shortString(item.locKey, 64)) ||
            !['camera', 'screen'].includes(item.source)) continue;
        keys.set(`${item.locKey}__${item.source}`, { locKey: item.locKey, source: item.source });
        if (keys.size >= 128) break;
      }
      for (const session of this.sessions.values()) {
        if (keys.size >= 128) break;
        keys.set(`${session.locKey}__${session.source}`, { locKey: session.locKey, source: session.source });
      }

      // 日付変更/DSTと、24h前に開始した長いsegmentを拾うため最大3日分。
      const dates = [...new Set([fmtDate(now), fmtDate(now - DAY_MS), fmtDate(now - 2 * DAY_MS)])];
      let bytes = 0;
      let oldestMs = now;
      for (const { locKey, source } of keys.values()) {
        for (const dateStr of dates) {
          const dayFile = path.join(dbRoot, 'segments', `${locKey}__${source}`, `${dateStr}.json`);
          const day = asObject(await readJsonAsync(dayFile, null));
          for (const segment of (Array.isArray(day.segments) ? day.segments : [])) {
            const startMs = Number(segment?.startMs);
            const size = Number(segment?.size);
            if (!Number.isSafeInteger(startMs) || startMs < fromMs || startMs > now + 3600e3 ||
                !Number.isFinite(size) || size < 0) continue;
            bytes += size;
            if (startMs < oldestMs) oldestMs = startMs;
          }
        }
      }

      let bytesPerDay = null;
      if (bytes > 0) {
        const spanMs = Math.max(now - oldestMs, 3600e3);
        bytesPerDay = Math.round(bytes * DAY_MS / spanMs);
      }
      const freeBytes = this._summaryDiskCache?.freeBytes;
      const minFreeBytes = this.settings.minFreeGb * 1024 ** 3;
      let estimatedRemainingDays = null;
      if (bytesPerDay && Number.isFinite(freeBytes)) {
        estimatedRemainingDays = Math.max(0, (freeBytes - minFreeBytes) / bytesPerDay);
        estimatedRemainingDays = Math.min(estimatedRemainingDays, this.settings.retentionDays);
        estimatedRemainingDays = Math.round(estimatedRemainingDays * 10) / 10;
      }
      const data = { bytesPerDay, estimatedRemainingDays, sampledBytes24h: bytes };
      this._usageCache = { at: now, data };
      this._summaryDiskCache = { ...(this._summaryDiskCache || {}), usage: data };
      return data;
    })();
    this._usageRefreshInFlight = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (this._usageRefreshInFlight === refreshPromise) this._usageRefreshInFlight = null;
    }
  }

  /**
   * 互換用の同期getter。NAS走査は行わず、非同期refreshが作った値だけを返す。
   */
  _estimateUsage() {
    return this._usageCache?.data || {
      bytesPerDay: null,
      estimatedRemainingDays: null,
      sampledBytes24h: 0,
    };
  }

  /**
   * 最低空き容量(既定10GB)を確保する。下回った場合は保持期間内であっても
   * 全拠点を通して最も古いセグメントから順に削除する。
   */
  async _enforceMinFreeSpace() {
    if (this._freeSpaceSweepInFlight) return this._freeSpaceSweepInFlight;
    const sweep = this._enforceMinFreeSpaceOnce();
    this._freeSpaceSweepInFlight = sweep;
    try {
      return await sweep;
    } finally {
      if (this._freeSpaceSweepInFlight === sweep) this._freeSpaceSweepInFlight = null;
    }
  }

  /** 保守対象の日次indexを、全拠点に公平な件数上限付きで古い順に列挙する。 */
  async _listMaintenanceDayFiles() {
    let keyEntries = [];
    try {
      keyEntries = await fs.promises.readdir(this._segmentsDir(), { withFileTypes: true });
    } catch {
      return [];
    }
    keyEntries = keyEntries
      .filter(entry => entry.isDirectory() && SEGMENT_QUERY_KEY_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAINTENANCE_MAX_KEY_DIRS);
    if (!keyEntries.length) return [];

    // 1拠点が大量の日次fileを持っていても他拠点の古い録画が候補から
    // 押し出されないよう、各拠点から同数程度ずつ採る。
    const perKeyLimit = Math.max(1, Math.floor(MAINTENANCE_MAX_DAY_FILES / keyEntries.length));
    const files = [];
    for (const keyEntry of keyEntries) {
      const dirPath = path.join(this._segmentsDir(), keyEntry.name);
      let dayEntries = [];
      try {
        dayEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = dayEntries
        .filter(entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .slice(0, perKeyLimit);
      for (const name of names) {
        files.push({
          filePath: path.join(dirPath, name),
          dateStr: name.slice(0, 10),
        });
      }
    }
    return files
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr) || a.filePath.localeCompare(b.filePath))
      .slice(0, MAINTENANCE_MAX_DAY_FILES);
  }

  /**
   * index内の相対パスを検証して削除する。root外・symlink・非通常fileは拒否し、
   * 不正なindexから任意パスを削除できないようにする。
   */
  async _removeIndexedMediaFile(relativeFile) {
    const raw = shortString(relativeFile, 1024).trim();
    if (!raw || path.isAbsolute(raw)) return { safe: false, removed: false, bytes: 0 };
    const root = path.resolve(this.recordingsDir());
    const abs = path.resolve(root, raw);
    const lexicalRelative = path.relative(root, abs);
    if (!lexicalRelative || lexicalRelative.startsWith(`..${path.sep}`) ||
        lexicalRelative === '..' || path.isAbsolute(lexicalRelative)) {
      return { safe: false, removed: false, bytes: 0 };
    }

    let rootReal;
    try {
      rootReal = await fs.promises.realpath(root);
    } catch {
      return { safe: false, removed: false, bytes: 0 };
    }
    let stat;
    try {
      stat = await fs.promises.lstat(abs);
    } catch (err) {
      if (err?.code === 'ENOENT') return { safe: true, removed: false, bytes: 0 };
      return { safe: false, removed: false, bytes: 0 };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return { safe: false, removed: false, bytes: 0 };

    let real;
    try {
      real = await fs.promises.realpath(abs);
    } catch {
      return { safe: false, removed: false, bytes: 0 };
    }
    const realRelative = path.relative(rootReal, real);
    if (!realRelative || realRelative.startsWith(`..${path.sep}`) ||
        realRelative === '..' || path.isAbsolute(realRelative)) {
      return { safe: false, removed: false, bytes: 0 };
    }
    try {
      await fs.promises.unlink(real);
      return { safe: true, removed: true, bytes: stat.size };
    } catch (err) {
      if (err?.code === 'ENOENT') return { safe: true, removed: false, bytes: 0 };
      return { safe: false, removed: false, bytes: 0 };
    }
  }

  async _writeMaintenanceDayFile(filePath, data, keep) {
    if (!keep.length) {
      await fs.promises.unlink(filePath).catch(err => {
        if (err?.code !== 'ENOENT') throw err;
      });
    } else {
      await writeJsonAtomicAsync(filePath, { ...data, segments: keep });
    }
    this._dayCache.delete(filePath);
  }

  async _enforceMinFreeSpaceOnce() {
    if (!this.settings.enabled || !this.storageOk || this._stopped) return;
    const minFreeBytes = this.settings.minFreeGb * 1024 ** 3;
    const free = await this._diskFreeBytes();
    if (free === null) return;
    const wasLowDisk = this.lowDisk;
    this.lowDisk = free < minFreeBytes;
    this._notifyClientPolicyIfChanged();
    if (!this.lowDisk) {
      if (wasLowDisk) {
        this.log('[Recording] 最終保存先の空き容量が回復したため録画を再開します');
        this._sweepRawSegments().catch(() => {});
        this._reconcile().catch(() => {});
      }
      return;
    }

    // 5%の余裕まで回復させ、閾値付近での停止・再開の反復を避ける。
    const needBytes = Math.max(0, Math.round(minFreeBytes * 1.05) - free);
    let freed = 0;
    let removedEntries = 0;
    let removedFiles = 0;
    let unsafeEntries = 0;

    await this._withIndexLock(async () => {
      const dayFiles = await this._listMaintenanceDayFiles();
      for (const { filePath } of dayFiles) {
        if (freed >= needBytes || removedEntries >= MAINTENANCE_MAX_DELETES) break;
        const data = asObject(await readJsonAsync(filePath, null));
        const segments = Array.isArray(data.segments) ? data.segments : [];
        if (!segments.length) continue;
        const removedIds = new Set();
        const ordered = [...segments].sort((a, b) => (Number(a?.startMs) || 0) - (Number(b?.startMs) || 0));
        for (const segment of ordered) {
          if (freed >= needBytes || removedEntries >= MAINTENANCE_MAX_DELETES) break;
          if (!segment?.id || !segment?.file) { unsafeEntries += 1; continue; }
          const result = await this._removeIndexedMediaFile(segment.file);
          if (!result.safe) { unsafeEntries += 1; continue; }
          removedIds.add(segment.id);
          removedEntries += 1;
          if (result.removed) removedFiles += 1;
          freed += result.bytes;
        }
        if (removedIds.size) {
          const keep = segments.filter(segment => !removedIds.has(segment?.id));
          await this._writeMaintenanceDayFile(filePath, data, keep);
        }
      }
    });

    this._usageCache = null;
    if (removedEntries > 0) {
      this.log(`[Recording] WARN: 最低空き容量の確保で古い録画${removedFiles}ファイル・index ${removedEntries}件(約${(freed / 1024 / 1024 / 1024).toFixed(1)}GB)を削除しました`);
    } else if (unsafeEntries > 0) {
      this.log(`[Recording] WARN: 安全に削除できない録画index ${unsafeEntries}件を拒否しました`);
    } else {
      this.log(`[Recording] WARN: 空き容量が${this.settings.minFreeGb}GBを下回っていますが、削除できる録画がありません`);
    }

    const freeAfter = await this._diskFreeBytes();
    this.lowDisk = freeAfter === null || freeAfter < minFreeBytes;
    this._notifyClientPolicyIfChanged();
    if (!this.lowDisk) {
      this.log('[Recording] 最終保存先の空き容量が回復したため録画を再開します');
      this._sweepRawSegments().catch(() => {});
      this._reconcile().catch(() => {});
    } else if (removedEntries >= MAINTENANCE_MAX_DELETES && !this._stopped && !this._maintenanceRetryTimer) {
      // 1回の削除量を抑えつつ、深い滞留は次の5分周期を待たず段階的に解消する。
      this._maintenanceRetryTimer = setTimeout(() => {
        this._maintenanceRetryTimer = null;
        this._enforceMinFreeSpace().catch(() => {});
      }, 10_000);
      this._maintenanceRetryTimer.unref?.();
    }
  }

  // ── 保持期間による自動削除 ───────────────────────────────

  async sweepRetention() {
    if (this._retentionSweepInFlight) return this._retentionSweepInFlight;
    const sweep = this._sweepRetentionOnce();
    this._retentionSweepInFlight = sweep;
    try {
      return await sweep;
    } finally {
      if (this._retentionSweepInFlight === sweep) this._retentionSweepInFlight = null;
    }
  }

  async _sweepRetentionOnce() {
    if (!this.storageOk || this._stopped) return;
    const cutoffMs = Date.now() - this.settings.retentionDays * 24 * 3600 * 1000;
    const cutoffDate = fmtDate(cutoffMs);
    let removedFiles = 0;
    let removedEntries = 0;
    let unsafeEntries = 0;

    await this._withIndexLock(async () => {
      const dayFiles = await this._listMaintenanceDayFiles();
      for (const { filePath, dateStr } of dayFiles) {
        if (removedEntries >= MAINTENANCE_MAX_DELETES) break;
        if (dateStr > cutoffDate) continue;
        const data = asObject(await readJsonAsync(filePath, null));
        const segments = Array.isArray(data.segments) ? data.segments : [];
        const removedIds = new Set();
        for (const segment of segments) {
          if (removedEntries >= MAINTENANCE_MAX_DELETES) break;
          if (!Number.isFinite(Number(segment?.startMs)) || Number(segment.startMs) >= cutoffMs) continue;
          if (!segment?.id || !segment?.file) { unsafeEntries += 1; continue; }
          const result = await this._removeIndexedMediaFile(segment.file);
          if (!result.safe) { unsafeEntries += 1; continue; }
          removedIds.add(segment.id);
          removedEntries += 1;
          if (result.removed) removedFiles += 1;
        }
        if (removedIds.size) {
          const keep = segments.filter(segment => !removedIds.has(segment?.id));
          await this._writeMaintenanceDayFile(filePath, data, keep);
        }
      }
    });

    // 取り残された古いrawも非同期で削除する。取込中・確定処理中のpathは除外する。
    try {
      const rawRoot = this.rawDir();
      const activeDirs = new Set([...this.sessions.values()]
        .filter(session => !session.ffmpegExited)
        .map(session => path.resolve(session.outDir)));
      const protectedPaths = new Set([
        ...this.finalizeInFlight,
        ...this.compressionActive,
        ...this.compressionQueue.map(job => job.rawPath),
      ].map(filePath => path.resolve(filePath)));
      const locEntries = (await fs.promises.readdir(rawRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && LOCATION_KEY_RE.test(entry.name))
        .slice(0, MAINTENANCE_MAX_KEY_DIRS);
      for (const locEntry of locEntries) {
        if (removedEntries >= MAINTENANCE_MAX_DELETES) break;
        const locDir = path.join(rawRoot, locEntry.name);
        let sourceEntries = [];
        try { sourceEntries = await fs.promises.readdir(locDir, { withFileTypes: true }); } catch { continue; }
        for (const sourceEntry of sourceEntries) {
          if (removedEntries >= MAINTENANCE_MAX_DELETES) break;
          if (!sourceEntry.isDirectory() || !['camera', 'screen'].includes(sourceEntry.name)) continue;
          const dir = path.join(locDir, sourceEntry.name);
          if (activeDirs.has(path.resolve(dir))) continue;
          let entries = [];
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
          for (const entry of entries) {
            if (removedEntries >= MAINTENANCE_MAX_DELETES) break;
            if (!entry.isFile()) continue;
            const match = entry.name.match(RAW_FILE_RE);
            if (!match) continue;
            const startMs = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
            const rawPath = path.resolve(dir, entry.name);
            if (startMs >= cutoffMs || protectedPaths.has(rawPath)) continue;
            try {
              await fs.promises.unlink(rawPath);
              removedFiles += 1;
              removedEntries += 1;
            } catch (_) { /* 次回周期で再試行 */ }
          }
        }
      }
    } catch (_) { /* rawDir 無しは正常 */ }

    this.lastSweepAt = Date.now();
    if (removedEntries > 0) {
      this.log(`[Recording] 保持期間(${this.settings.retentionDays}日)超過を削除: ${removedFiles}ファイル・index ${removedEntries}件`);
      this._usageCache = null;
    }
    if (unsafeEntries > 0) {
      this.log(`[Recording] WARN: 保持期間掃除で安全に削除できないindex ${unsafeEntries}件を拒否しました`);
    }
    // 保持期間の掃除後も足りなければ最低空き容量を確保する
    await this._enforceMinFreeSpace();
  }

  // ── 状態(監視GUI / API 用) ───────────────────────────────

  getStatus() {
    const summaryCache = this._summaryDiskCache || {};
    const disk = Number.isFinite(summaryCache.freeBytes)
      ? { freeBytes: summaryCache.freeBytes, totalBytes: summaryCache.totalBytes ?? null }
      : null;
    const usage = summaryCache.usage || this._usageCache?.data || {
      bytesPerDay: null,
      estimatedRemainingDays: null,
      sampledBytes24h: 0,
    };

    return {
      settings: this.getSettings(),
      resolvedRecordingsDir: this.recordingsDir(),
      resolvedDbDir: this.dbDir(),
      ffmpegOk: !!this.ffmpegPath,
      ffmpegPath: this.ffmpegPath || '',
      ffprobeOk: !!this.ffprobePath,
      ffmpegError: this.ffmpegError,
      storageOk: this.storageOk,
      storageError: this.storageError,
      disk,
      usage,
      lowDisk: !!this.lowDisk,
      compressionConcurrency: this.compressionConcurrency(),
      lastSweepAt: this.lastSweepAt,
      compressionQueue: this.compressionQueue.length + this.compressionActive.size,
      compressionActive: [...this.compressionActive],
      activeSessions: [...this.sessions.values()].map(session => ({
        socketId: session.socketId,
        producerId: session.producerId,
        locationName: session.locationName,
        locKey: session.locKey,
        source: session.source,
        startedAt: session.startedAt,
        alive: !session.ffmpegExited,
        hasAudio: !!session.audioConsumer,
        lastError: session.lastError,
      })),
    };
  }

  /** stats snapshot 向けの軽量サマリ(500ms周期で呼ばれるため軽く保つ) */
  getStatusSummary() {
    // この関数は500ms周期で呼ばれる。NASに対するstatfs/index走査は一切行わず、
    // 非同期storage check/index更新が作ったキャッシュだけを返す。
    const summaryCache = this._summaryDiskCache || {};
    const usage = summaryCache.usage || this._usageCache?.data || {
      bytesPerDay: null,
      estimatedRemainingDays: null,
    };
    return {
      enabled: this.settings.enabled,
      ffmpegOk: !!this.ffmpegPath,
      storageOk: this.storageOk,
      storageError: this.storageOk ? '' : this.storageError,
      recordingsDir: this.recordingsDir(),
      activeCount: [...this.sessions.values()].filter(s => !s.ffmpegExited).length,
      recordingSocketIds: [...this.sessions.values()].filter(s => !s.ffmpegExited).map(s => s.socketId),
      compressionQueue: this.compressionQueue.length + this.compressionActive.size,
      compressionActiveCount: this.compressionActive.size,
      retentionDays: this.settings.retentionDays,
      minFreeGb: this.settings.minFreeGb,
      lowDisk: !!this.lowDisk,
      freeBytes: summaryCache.freeBytes ?? null,
      bytesPerDay: usage.bytesPerDay,
      estimatedRemainingDays: usage.estimatedRemainingDays,
    };
  }

  shutdown() {
    this._stopped = true;
    this._ffmpegDetectGeneration += 1;
    this._cancelActiveFfmpegDetection();
    this._notifyClientPolicyIfChanged();
    clearInterval(this._reconcileTimer);
    clearInterval(this._storageTimer);
    clearInterval(this._finalizeTimer);
    clearInterval(this._retentionTimer);
    clearInterval(this._freeSpaceTimer);
    if (this._startupMaintenanceTimer) {
      clearTimeout(this._startupMaintenanceTimer);
      this._startupMaintenanceTimer = null;
    }
    if (this._maintenanceRetryTimer) {
      clearTimeout(this._maintenanceRetryTimer);
      this._maintenanceRetryTimer = null;
    }
    this._pauseCompressionWork('サーバー終了');
    this._stopAllSessions('サーバー終了');
  }
}

function createRecordingManager(options) {
  return new RecordingManager(options);
}

module.exports = {
  createRecordingManager,
  locationKeyOf,
  normalizeSegmentQueryWindow,
  readJsonAsync,
  writeJsonAtomicAsync,
};
