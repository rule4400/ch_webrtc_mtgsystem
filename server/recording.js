/**
 * サーバー録画マネージャ
 *
 * 各拠点のカメラ映像+マイク音声(producer)を mediasoup PlainTransport → ffmpeg で
 * 受信し、セグメント(既定5分)単位で保存する。
 *
 *   受信(RTP, stream copy, .webm[VP8/Opus])
 *     │  └─ ライブ視聴: 書き込み中セグメントを追記追従で配信(resolveLiveFile)
 *     → バックグラウンド圧縮(H.264+AAC/mp4、タイムスタンプ焼き込み、N並列)
 *     → JSONインデックス(データベース)へ登録
 *     → 保持期間を過ぎたセグメントは毎時の掃除で自動削除
 *     → 空き容量が最低確保量(既定10GB)を下回ったら古い録画から自動削除
 *
 * 設計方針:
 *  - クライアントのカメラがOFF(論理pause)でも RTP は届き続けるため録画は継続する
 *  - マイクミュート=音声producerのpause=RTP停止。その区間は音声が記録されない
 *  - 取り込みは拠点ごとに独立した ffmpeg プロセス(12拠点なら12並列)。
 *    圧縮も別プロセスのワーカープール(compressionConcurrency)で並列実行する
 *  - 保存先/DB保存先は設定で変更可能。NAS(SMB/NFSマウント)を想定し、
 *    到達不能になっても録画機能全体は落とさず、復旧したら自動再開する
 *    (reconcile ループが candidate → session を常時突き合わせる)
 *  - インデックスは「拠点×ソース×日」単位の小さなJSONファイル。NAS上でも
 *    ロック不要で読め、専用ビューアアプリがサーバー無しで直接読める
 *  - すべての書き込みは tmp+rename のアトミック書き込み
 *
 * 外部依存: ffmpeg / ffprobe (同梱の ffmpeg-static / ffprobe-static を自動検出。
 * server-gui パッケージ版は同梱バイナリのパスが FFMPEG_PATH で渡される)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RECONCILE_INTERVAL_MS = 10_000;   // candidate/session 突き合わせ周期
const STORAGE_CHECK_INTERVAL_MS = 60_000; // 保存先(NAS)ヘルスチェック周期
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 保持期間掃除の周期
const SEGMENT_FINALIZE_IDLE_MS = 20_000; // 書き込みが止まってから「完了」とみなすまで
const KEYFRAME_INTERVAL_MS = 30_000;     // キーフレーム要求周期(セグメント境界の精度)
const SESSION_RETRY_BACKOFF_MS = 15_000; // セッション起動失敗時の再試行間隔
const AUDIO_WAIT_GRACE_MS = 2_500;       // 映像producer登録後、音声producerの到着を待つ猶予
// 生セグメント。VP8/Opus は webm、H.264等は mkv に copy 記録する
const RAW_FILE_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_([a-z0-9]{6})\.(webm|mkv)$/;

/** 圧縮モード → ffmpeg パラメータ。strong ほど容量が小さい */
const COMPRESSION_PRESETS = {
  strong:   { crf: 34, maxHeight: 480 },
  standard: { crf: 29, maxHeight: 720 },
  light:    { crf: 24, maxHeight: 1080 },
  // none: 再エンコードせずコンテナ詰め替えのみ
};

const DEFAULT_SETTINGS = {
  enabled: false,
  recordingsDir: '',       // 空 = 設定ファイルと同じ場所の recordings/
  dbDir: '',               // 空 = recordingsDir/recording-db
  retentionDays: 14,       // 保持期間(日)。経過したセグメントは自動削除
  segmentSeconds: 300,     // セグメント長(秒)
  compressionMode: 'standard', // strong / standard / light / none
  recordScreen: false,     // 画面共有(screen-share)映像も録画するか
  recordAudio: true,       // 音声(マイク/画面共有音声)も録音するか。OFF=映像のみ
  timestampOverlay: true,  // 映像右下に日時を焼き込む(監視カメラ様式)
  ffmpegPath: '',          // 空 = 自動検出(同梱 ffmpeg-static → システム)
  // バックグラウンド圧縮の並列数。0 = 自動(CPUコア数から算出、12拠点想定で2〜4)。
  // 取り込み(RTP受信)は拠点ごとに独立した ffmpeg プロセスで元々並列動作する。
  compressionConcurrency: 0,
  // 保存先に常に確保しておく最低空き容量(GB)。下回ったら保持期間内でも
  // 古い録画から順に削除して確保する。
  minFreeGb: 10,
};

/** 自動時の圧縮並列数: コア数の半分(2〜4)。mediasoup と取り込みffmpegの分を残す */
function autoCompressionConcurrency() {
  const cpus = os.cpus()?.length || 4;
  return Math.max(2, Math.min(4, Math.floor(cpus / 2)));
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

/** 空きUDPポートのペア(RTP/RTCP)を確保する。可能なら偶奇連番を選ぶ */
async function allocateUdpPortPair() {
  const bindOne = (port = 0) => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { try { sock.close(); } catch (_) {} resolve(null); });
    sock.bind(port, '127.0.0.1', () => resolve(sock));
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const first = await bindOne(0);
    if (!first) continue;
    const base = first.address().port;
    const even = base % 2 === 0 ? base : base + 1;
    if (even !== base) { try { first.close(); } catch (_) {} }
    const rtpSock = even === base ? first : await bindOne(even);
    if (!rtpSock) continue;
    const rtcpSock = await bindOne(even + 1);
    if (!rtcpSock) { try { rtpSock.close(); } catch (_) {} continue; }
    try { rtpSock.close(); } catch (_) {}
    try { rtcpSock.close(); } catch (_) {}
    return { rtpPort: even, rtcpPort: even + 1 };
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
  constructor({ getRouter, log, settingsFile }) {
    this.getRouter = getRouter;
    this.log = typeof log === 'function' ? log : (msg) => console.log(msg);
    this.settingsFile = settingsFile;

    this.settings = { ...DEFAULT_SETTINGS, ...this._loadSettingsFile() };
    this._applyEnvDefaults();

    this.candidates = new Map(); // 映像producerId → { producer, socketId, locationName, source, appType, nextAttemptAt, createdAt }
    this.sessions = new Map();   // 映像producerId → session
    // 音声producerの登録簿: socketId → Map<source('microphone'|'screen-audio'), producer>
    // 録画セッションは同一拠点の対応する音声producerをペアにして記録する。
    // ミュートはproducer.pause()=RTP停止としてそのまま反映される(無音区間になる)。
    this.audioProducers = new Map();
    this.finalizeInFlight = new Set(); // 圧縮キュー投入済みの raw ファイルパス
    this.compressionQueue = [];  // { rawPath, meta }
    this.compressionActive = new Set(); // 圧縮実行中の raw ファイル名(並列数ぶん)
    this.storageOk = false;
    this.storageError = '未確認';
    this.ffmpegPath = null;
    this.ffprobePath = null;
    this.ffmpegError = '';
    this.lastSweepAt = 0;
    this._indexChain = Promise.resolve(); // インデックス書き込みの直列化
    this._dayCache = new Map();           // dayFilePath → { mtimeMs, data }
    this._stopped = false;

    this._detectFfmpeg();
    this._checkStorage();

    this._reconcileTimer = setInterval(() => this._reconcile().catch(() => {}), RECONCILE_INTERVAL_MS);
    this._storageTimer = setInterval(() => this._checkStorage(), STORAGE_CHECK_INTERVAL_MS);
    this._finalizeTimer = setInterval(() => this._sweepRawSegments().catch(() => {}), SEGMENT_FINALIZE_IDLE_MS / 2);
    this._retentionTimer = setInterval(() => this.sweepRetention().catch(() => {}), RETENTION_SWEEP_INTERVAL_MS);
    // 最低空き容量の確保はディスクが急に埋まる事態に備えて短い周期で確認する
    this._freeSpaceTimer = setInterval(() => this._enforceMinFreeSpace().catch(() => {}), 5 * 60 * 1000);
    // 起動直後にも一度掃除(前回稼働分の期限切れ・取り残しrawの回収)
    setTimeout(() => {
      this._sweepRawSegments().catch(() => {});
      this.sweepRetention().catch(() => {});
      this._enforceMinFreeSpace().catch(() => {});
    }, 20_000);

    if (this.settings.enabled) {
      this.log(`[Recording] 録画有効: 保存先=${this.recordingsDir()} DB=${this.dbDir()} 保持=${this.settings.retentionDays}日 圧縮=${this.settings.compressionMode}`);
      if (!this.ffmpegPath) this.log(`[Recording] WARN: ffmpeg が見つかりません (${this.ffmpegError})。録画は ffmpeg 検出後に開始されます`);
    }
  }

  // ── 設定 ────────────────────────────────────────────────

  _loadSettingsFile() {
    return asObject(readJson(this.settingsFile, {}));
  }

  /** 環境変数は「設定ファイルにまだ値が無い」項目の初期値としてのみ使う */
  _applyEnvDefaults() {
    const s = this.settings;
    if (!s.recordingsDir && process.env.RECORDINGS_DIR) s.recordingsDir = process.env.RECORDINGS_DIR;
    if (!s.dbDir && process.env.RECORDINGS_DB_DIR) s.dbDir = process.env.RECORDINGS_DB_DIR;
    if (!s.ffmpegPath && process.env.FFMPEG_PATH) s.ffmpegPath = process.env.FFMPEG_PATH;
    if (process.env.RECORDING_ENABLED && !fs.existsSync(this.settingsFile)) {
      s.enabled = /^(1|true|yes)$/i.test(process.env.RECORDING_ENABLED);
    }
    this.settings = this._sanitizeSettings(s);
  }

  _sanitizeSettings(input) {
    const raw = asObject(input);
    return {
      enabled: !!raw.enabled,
      recordingsDir: shortString(raw.recordingsDir, 1024).trim(),
      dbDir: shortString(raw.dbDir, 1024).trim(),
      retentionDays: clampInt(raw.retentionDays, 1, 3650, DEFAULT_SETTINGS.retentionDays),
      segmentSeconds: clampInt(raw.segmentSeconds, 60, 3600, DEFAULT_SETTINGS.segmentSeconds),
      compressionMode: ['strong', 'standard', 'light', 'none'].includes(raw.compressionMode)
        ? raw.compressionMode : DEFAULT_SETTINGS.compressionMode,
      recordScreen: !!raw.recordScreen,
      recordAudio: raw.recordAudio === undefined ? DEFAULT_SETTINGS.recordAudio : !!raw.recordAudio,
      timestampOverlay: raw.timestampOverlay === undefined ? DEFAULT_SETTINGS.timestampOverlay : !!raw.timestampOverlay,
      ffmpegPath: shortString(raw.ffmpegPath, 1024).trim(),
      compressionConcurrency: clampInt(raw.compressionConcurrency, 0, 8, 0),
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
    const dirChanged = next.recordingsDir !== before.recordingsDir || next.dbDir !== before.dbDir;
    const segmentChanged = next.segmentSeconds !== before.segmentSeconds;
    const ffmpegChanged = next.ffmpegPath !== before.ffmpegPath;
    this.settings = next;

    try {
      writeJsonAtomic(this.settingsFile, next);
    } catch (err) {
      this.log(`[Recording] WARN: 設定ファイルを保存できません (${this.settingsFile}): ${err.message}`);
    }

    if (ffmpegChanged) this._detectFfmpeg();
    this._dayCache.clear();
    this._checkStorage();

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
    // 生セグメントは常に録画保存先の raw/ 配下(圧縮後に本置き場へ移動)
    return path.join(this.recordingsDir(), 'raw');
  }

  /** クライアントに「カメラOFFでも送信を継続」させるか(録画有効時のみ) */
  clientShouldKeepSendingCamera() {
    return !!this.settings.enabled;
  }

  // ── ffmpeg / 保存先ヘルス ────────────────────────────────

  /**
   * ffmpeg/ffprobe の探索。優先順:
   *   1. 設定(ffmpegPath) / 環境変数 FFMPEG_PATH・FFPROBE_PATH
   *      (server-gui のパッケージ版は同梱バイナリのパスをここで渡してくる)
   *   2. 同梱npmパッケージ ffmpeg-static / ffprobe-static
   *   3. PATH・OS標準の場所(システムにインストール済みの ffmpeg)
   */
  _detectFfmpeg() {
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

    const works = candidate => {
      try {
        return spawnSync(candidate, ['-version'], { timeout: 5000, stdio: 'ignore' }).status === 0;
      } catch (_) {
        return false;
      }
    };

    this.ffmpegPath = candidates.find(works) || null;

    const probeCandidates = [];
    if (process.env.FFPROBE_PATH) probeCandidates.push(process.env.FFPROBE_PATH);
    try {
      const bundledProbe = require('ffprobe-static');
      if (bundledProbe?.path) probeCandidates.push(bundledProbe.path);
    } catch (_) { /* 未インストール環境では次の候補へ */ }
    if (this.ffmpegPath && this.ffmpegPath !== 'ffmpeg') {
      probeCandidates.push(path.join(path.dirname(this.ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    }
    probeCandidates.push('ffprobe');
    this.ffprobePath = probeCandidates.find(works) || null;

    this.ffmpegError = this.ffmpegPath
      ? ''
      : 'ffmpeg が見つかりません。サーバーGUI同梱版の再インストール、または設定で ffmpeg のパスを指定してください';
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
  _checkStorage() {
    if (!this.settings.enabled) { this.storageOk = false; this.storageError = '録画が無効です'; return; }
    try {
      for (const dir of [this.recordingsDir(), this.rawDir(), this.dbDir()]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const testFile = path.join(this.recordingsDir(), '.write-test');
      fs.writeFileSync(testFile, String(Date.now()));
      fs.unlinkSync(testFile);
      if (!this.storageOk) this.log(`[Recording] 保存先が利用可能になりました: ${this.recordingsDir()}`);
      this.storageOk = true;
      this.storageError = '';
    } catch (err) {
      if (this.storageOk || this.storageError === '未確認') {
        this.log(`[Recording] WARN: 保存先へ書き込めません(NAS切断?): ${err.message}。復旧を待ちます`);
      }
      this.storageOk = false;
      this.storageError = err.message;
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
      if (!this.ffmpegPath) { this._detectFfmpeg(); if (!this.ffmpegPath) return; }
      if (!this.storageOk) { this._checkStorage(); if (!this.storageOk) return; }

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
        } catch (err) {
          this.log(`[Recording] WARN: 録画開始に失敗 name=${candidate.locationName} source=${candidate.source}: ${err.message}(${Math.round(SESSION_RETRY_BACKOFF_MS / 1000)}秒後に再試行)`);
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
    const locKey = locationKeyOf(candidate.locationName);
    const sessionTag = randTag(6);
    const outDir = path.join(this.rawDir(), locKey, candidate.source);
    fs.mkdirSync(outDir, { recursive: true });

    const session = {
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
      consumer: null,       // 映像consumer
      audioConsumer: null,
      ffmpeg: null,
      ffmpegExited: false,
      startedAt: Date.now(),
      lastError: '',
      keyframeTimer: null,
      sdpPath: '',
    };
    this.sessions.set(producer.id, session);

    try {
      const media = [];

      // ── 映像 ──
      const videoTransport = await router.createPlainTransport({
        listenIp: '127.0.0.1', rtcpMux: false, comedia: false,
      });
      session.transports.push(videoTransport);
      const videoPorts = await allocateUdpPortPair();
      await videoTransport.connect({ ip: '127.0.0.1', port: videoPorts.rtpPort, rtcpPort: videoPorts.rtcpPort });
      const consumer = await videoTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });
      session.consumer = consumer;
      // simulcast の場合は最高画質レイヤを記録する
      try { await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 }); } catch (_) {}
      media.push({ kind: 'video', rtpParameters: consumer.rtpParameters, rtpPort: videoPorts.rtpPort, rtcpPort: videoPorts.rtcpPort });

      // 生セグメントの容器: VP8/VP9+Opus は webm(ブラウザでライブ視聴可)、それ以外は mkv
      const videoCodec = (consumer.rtpParameters.codecs[0]?.mimeType || '').split('/')[1]?.toLowerCase() || '';
      session.rawExt = ['vp8', 'vp9'].includes(videoCodec) ? 'webm' : 'mkv';

      // ── 音声(同一拠点のマイク/画面音声。ミュート中はRTPが止まり無音になる) ──
      if (audioProducer) {
        const audioTransport = await router.createPlainTransport({
          listenIp: '127.0.0.1', rtcpMux: false, comedia: false,
        });
        session.transports.push(audioTransport);
        const audioPorts = await allocateUdpPortPair();
        await audioTransport.connect({ ip: '127.0.0.1', port: audioPorts.rtpPort, rtcpPort: audioPorts.rtcpPort });
        const audioConsumer = await audioTransport.consume({
          producerId: audioProducer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true,
        });
        session.audioConsumer = audioConsumer;
        media.push({ kind: 'audio', rtpParameters: audioConsumer.rtpParameters, rtpPort: audioPorts.rtpPort, rtcpPort: audioPorts.rtcpPort });
      }

      session.sdpPath = path.join(os.tmpdir(), `chk-rec-${sessionTag}.sdp`);
      fs.writeFileSync(session.sdpPath, buildSdp(media));

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
      if (consumer.closed) throw new Error('consumer が閉じられました');
      await consumer.resume();
      if (session.audioConsumer && !session.audioConsumer.closed) {
        await session.audioConsumer.resume();
      }
      try { await consumer.requestKeyFrame(); } catch (_) {}
      // 立ち上がり直後は複数回キーフレームを要求(最初のセグメントを確実にデコード可能に)
      for (const delay of [1000, 3000]) {
        setTimeout(() => { consumer.requestKeyFrame().catch(() => {}); }, delay);
      }
      // 以後は周期要求(セグメント分割はキーフレーム境界でしか起きないため)
      session.keyframeTimer = setInterval(() => {
        consumer.requestKeyFrame().catch(() => {});
      }, KEYFRAME_INTERVAL_MS);

      this.log(`[Recording] 録画開始 name=${candidate.locationName} source=${candidate.source} 音声=${audioProducer ? 'あり' : 'なし'} → ${outDir}`);
    } catch (err) {
      this._stopSession(producer.id, `起動失敗: ${err.message}`, { quiet: true });
      throw err;
    }
  }

  _stopSession(producerId, reason = '', { quiet = false } = {}) {
    const session = this.sessions.get(producerId);
    if (!session) return;
    this.sessions.delete(producerId);
    session.stopping = true;
    if (session.keyframeTimer) clearInterval(session.keyframeTimer);
    try { session.consumer?.close(); } catch (_) {}
    try { session.audioConsumer?.close(); } catch (_) {}
    for (const transport of session.transports || []) {
      try { transport.close(); } catch (_) {}
    }
    if (session.ffmpeg && !session.ffmpegExited) {
      try { session.ffmpeg.kill('SIGINT'); } catch (_) {}
      const proc = session.ffmpeg;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000).unref?.();
    }
    if (session.sdpPath) {
      setTimeout(() => { try { fs.unlinkSync(session.sdpPath); } catch (_) {} }, 5000).unref?.();
    }
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
  resolveLiveFile(videoProducerId) {
    const session = this.sessions.get(shortString(videoProducerId, 128));
    if (!session || session.ffmpegExited) return null;
    let names = [];
    try {
      names = fs.readdirSync(session.outDir)
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

  _stopAllSessions(reason) {
    for (const producerId of [...this.sessions.keys()]) this._stopSession(producerId, reason);
  }

  // ── セグメント完了検出 → 圧縮キュー ──────────────────────

  /** raw ディレクトリを走査し、書き込みが完了したセグメントを圧縮キューへ入れる */
  async _sweepRawSegments() {
    if (!this.storageOk) return;
    const rawRoot = this.rawDir();
    let locKeys = [];
    try { locKeys = fs.readdirSync(rawRoot); } catch { return; }

    // アクティブセッションが現在書き込み中のファイル(そのdirの最新ファイル)は除外する
    const activeDirs = new Map(); // outDir → session
    for (const session of this.sessions.values()) {
      if (!session.ffmpegExited) activeDirs.set(session.outDir, session);
    }

    const now = Date.now();
    for (const locKey of locKeys) {
      const locDir = path.join(rawRoot, locKey);
      let sources = [];
      try { sources = fs.readdirSync(locDir).filter(n => !n.startsWith('.')); } catch { continue; }
      for (const source of sources) {
        const dir = path.join(locDir, source);
        let names = [];
        try { names = fs.readdirSync(dir).filter(n => RAW_FILE_RE.test(n)).sort(); } catch { continue; }
        const activeSession = activeDirs.get(dir);
        const newest = names[names.length - 1];

        for (const name of names) {
          const rawPath = path.join(dir, name);
          if (this.finalizeInFlight.has(rawPath)) continue;
          let st;
          try { st = fs.statSync(rawPath); } catch { continue; }

          // アクティブセッションの最新ファイルは書き込み途中
          if (activeSession && name === newest && name.includes(`_${activeSession.sessionTag}.`)) continue;
          // 書き込みが止まってから一定時間経つまで待つ
          if (now - st.mtimeMs < SEGMENT_FINALIZE_IDLE_MS) continue;

          if (st.size < 4096) {
            // RTPが届かないまま閉じた空セグメントは破棄
            try { fs.unlinkSync(rawPath); } catch (_) {}
            continue;
          }
          const meta = this._parseRawName(locKey, source, name, st);
          if (!meta) continue;
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
    const [, Y, Mo, D, H, Mi, S] = m;
    const startMs = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S)).getTime();
    if (!Number.isFinite(startMs)) return null;
    const durationMs = Math.max(500, Math.min(st.mtimeMs - startMs, 24 * 3600 * 1000));
    return { locKey, source, startMs, durationMs, size: st.size };
  }

  /**
   * 圧縮キューを並列処理する(既定はCPUコア数から自動、設定で変更可)。
   * 各ジョブは独立した ffmpeg プロセス(=マルチコアで真に並列)で、
   * -threads を絞ることで mediasoup/取り込みffmpegのCPUを奪わないようにする。
   * 12拠点が同時にセグメント境界を跨いでも、数珠つなぎで滞留しない。
   */
  _runCompressionQueue() {
    const limit = this.compressionConcurrency();
    while (this.compressionActive.size < limit && this.compressionQueue.length) {
      const job = this.compressionQueue.shift();
      const jobName = path.basename(job.rawPath);
      this.compressionActive.add(jobName);
      this._finalizeRaw(job.rawPath, job.meta)
        .catch(err => this.log(`[Recording] WARN: セグメント処理失敗 ${jobName}: ${err.message}`))
        .finally(() => {
          this.finalizeInFlight.delete(job.rawPath);
          this.compressionActive.delete(jobName);
          // 続きがあれば次へ
          setTimeout(() => this._runCompressionQueue(), 100);
        });
    }
  }

  _probeInfo(filePath) {
    if (!this.ffprobePath) return {};
    try {
      const result = spawnSync(this.ffprobePath, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name:format=duration',
        '-of', 'json',
        filePath,
      ], { timeout: 15000, encoding: 'utf8' });
      if (result.status !== 0) return {};
      const data = JSON.parse(result.stdout || '{}');
      const streams = Array.isArray(data.streams) ? data.streams : [];
      const durationSec = Number(data.format?.duration);
      return {
        codec: streams.find(s => s.codec_type === 'video')?.codec_name || '',
        audioCodec: streams.find(s => s.codec_type === 'audio')?.codec_name || '',
        hasAudio: streams.some(s => s.codec_type === 'audio'),
        durationMs: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
      };
    } catch {
      return {};
    }
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

  async _finalizeRaw(rawPath, meta) {
    let st;
    try { st = fs.statSync(rawPath); } catch { return; } // 消えていたら何もしない

    const probe = this._probeInfo(rawPath);
    if (probe.durationMs) meta.durationMs = probe.durationMs;
    const srcCodec = probe.codec || 'vp8';
    const hasAudio = !!probe.hasAudio;

    const dateStr = fmtDate(meta.startMs);
    const finalDir = path.join(this.recordingsDir(), meta.locKey, meta.source, dateStr);
    const mode = this.settings.compressionMode;
    const baseName = `${fmtTimeCompact(meta.startMs)}_${Math.round(meta.durationMs / 1000)}s_${randTag(4)}`;

    // タイムスタンプ焼き込みは再エンコードでのみ可能。
    // 「圧縮しない」設定でも焼き込みONなら再エンコードする(高画質プリセット)。
    const preset = COMPRESSION_PRESETS[mode] || COMPRESSION_PRESETS.light;
    const timestampFilter = this._timestampFilter(meta.startMs, preset.maxHeight);
    const reencode = mode !== 'none' || !!timestampFilter;

    let outPath;
    let args;
    let codec;
    if (!reencode) {
      // 再エンコード無し: コンテナ詰め替えのみ(ブラウザ再生可能な形式へ)。
      // 音声(Opus)は mp4 と相性が悪いため、Opus付きは webm/mkv を維持する。
      const ext = srcCodec === 'h264'
        ? (hasAudio ? 'mkv' : 'mp4')
        : (srcCodec === 'vp8' || srcCodec === 'vp9' ? 'webm' : 'mkv');
      outPath = path.join(finalDir, `${baseName}.${ext}`);
      args = ['-i', rawPath, '-c', 'copy'];
      if (ext === 'mp4') args.push('-movflags', '+faststart');
      args.push(outPath);
      codec = srcCodec;
    } else {
      // 監視システム標準(ONVIF系NVRのエクスポート形式)に合わせて H.264+AAC/mp4 に統一
      const filters = [];
      if (mode !== 'none') filters.push(`scale=-2:min(${preset.maxHeight}\\,ih)`);
      if (timestampFilter) filters.push(timestampFilter);
      outPath = path.join(finalDir, `${baseName}.mp4`);
      args = [
        '-i', rawPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        // 並列圧縮時に1ジョブがCPUを占有しないようスレッド数を絞る
        '-threads', '2',
        '-crf', String(mode !== 'none' ? preset.crf : 23),
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'] : ['-an']),
        outPath,
      ];
      codec = 'h264';
    }

    fs.mkdirSync(finalDir, { recursive: true });
    let ok = await this._runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);

    if (!ok && reencode) {
      // 再エンコード失敗時はコピー詰め替えで保全(壊れかけのrawでも救えることがある)
      try { fs.unlinkSync(outPath); } catch (_) {}
      outPath = path.join(finalDir, `${baseName}.${srcCodec === 'vp8' || srcCodec === 'vp9' ? 'webm' : 'mkv'}`);
      ok = await this._runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', rawPath, '-c', 'copy', outPath]);
      codec = srcCodec;
    }

    if (!ok) {
      // ffmpegで処理できない場合は raw をそのまま本置き場へ移して保全する
      try { fs.unlinkSync(outPath); } catch (_) {}
      outPath = path.join(finalDir, `${baseName}.raw.mkv`);
      try {
        fs.copyFileSync(rawPath, outPath);
      } catch (err) {
        throw new Error(`セグメントを保全できません: ${err.message}`);
      }
      codec = srcCodec;
    }

    let outSize = 0;
    try { outSize = fs.statSync(outPath).size; } catch (_) {}
    if (outSize < 1024) {
      try { fs.unlinkSync(outPath); } catch (_) {}
      try { fs.unlinkSync(rawPath); } catch (_) {}
      return; // 実質空(映像が届いていない)セグメント
    }

    const id = `${meta.locKey}~${meta.source}~${dateStr}~${meta.startMs}~${randTag(4)}`;
    const relFile = path.relative(this.recordingsDir(), outPath);
    const entry = {
      id,
      startMs: meta.startMs,
      durationMs: meta.durationMs,
      file: relFile.split(path.sep).join('/'),
      size: outSize,
      codec,
      audio: hasAudio,
      status: ok ? 'ready' : 'raw',
    };
    await this._appendIndexEntry(meta.locKey, meta.source, dateStr, entry);
    try { fs.unlinkSync(rawPath); } catch (_) {}
    const ratio = st.size > 0 ? Math.round((outSize / st.size) * 100) : 100;
    this.log(`[Recording] セグメント保存 ${meta.locKey}/${meta.source} ${dateStr} ${fmtTimeCompact(meta.startMs)} ${(outSize / 1024 / 1024).toFixed(1)}MB (元比${ratio}%)`);
  }

  _runFfmpeg(args) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; resolve(value); } };
      let proc;
      try {
        proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch {
        return finish(false);
      }
      let stderrTail = '';
      proc.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-1000); });
      proc.on('error', () => finish(false));
      proc.on('close', code => {
        if (code !== 0 && stderrTail) this.log(`[Recording] ffmpeg: ${stderrTail.split('\n').slice(-1)[0]}`);
        finish(code === 0);
      });
      // 暴走防止(1セグメントの処理は最長15分)
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(false); }, 15 * 60 * 1000).unref?.();
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

  _appendIndexEntry(locKey, source, dateStr, entry) {
    return this._withIndexLock(() => {
      const dayFile = this._dayFilePath(locKey, source, dateStr);
      const data = asObject(readJson(dayFile, null)) || { locKey, source, date: dateStr, segments: [] };
      if (!Array.isArray(data.segments)) data.segments = [];
      data.segments.push(entry);
      data.segments.sort((a, b) => a.startMs - b.startMs);
      writeJsonAtomic(dayFile, data);
      this._dayCache.delete(dayFile);

      // 拠点レジストリ更新
      const locFile = this._locationsFilePath();
      const locations = asObject(readJson(locFile, {}));
      const key = `${locKey}__${source}`;
      const known = asObject(locations[key]);
      const session = [...this.sessions.values()].find(s => s.locKey === locKey && s.source === source);
      locations[key] = {
        locKey,
        source,
        locationName: session?.locationName || known.locationName || locKey,
        lastSegmentAt: Math.max(Number(known.lastSegmentAt) || 0, entry.startMs + entry.durationMs),
      };
      writeJsonAtomic(locFile, locations);
    });
  }

  _readDayFile(locKey, source, dateStr) {
    const dayFile = this._dayFilePath(locKey, source, dateStr);
    let st;
    try { st = fs.statSync(dayFile); } catch { return null; }
    const cached = this._dayCache.get(dayFile);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    const data = asObject(readJson(dayFile, null));
    if (!data || !Array.isArray(data.segments)) return null;
    this._dayCache.set(dayFile, { mtimeMs: st.mtimeMs, data });
    if (this._dayCache.size > 200) {
      const first = this._dayCache.keys().next().value;
      this._dayCache.delete(first);
    }
    return data;
  }

  /** 録画のある拠点一覧(インデックス + 現在録画中) */
  listLocations() {
    const locations = asObject(readJson(this._locationsFilePath(), {}));
    const result = new Map();
    for (const [key, value] of Object.entries(locations)) {
      const item = asObject(value);
      if (!item.locKey || !item.source) continue;
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
  querySegments({ keys = null, fromMs, toMs }) {
    const from = Number(fromMs);
    const to = Number(toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const wanted = Array.isArray(keys) && keys.length
      ? keys.map(k => shortString(k, 128))
      : this.listLocations().map(l => l.key);

    const results = [];
    for (const key of wanted.slice(0, 64)) {
      const sep = key.lastIndexOf('__');
      if (sep <= 0) continue;
      const locKey = key.slice(0, sep);
      const source = key.slice(sep + 2);
      // 期間がまたぐ日付を列挙(前日開始のセグメントも拾うため1日前から)
      for (let dayMs = from - 24 * 3600 * 1000; dayMs < to + 24 * 3600 * 1000; dayMs += 24 * 3600 * 1000) {
        const dateStr = fmtDate(dayMs);
        const data = this._readDayFile(locKey, source, dateStr);
        if (!data) continue;
        for (const seg of data.segments) {
          const segEnd = seg.startMs + (seg.durationMs || 0);
          if (segEnd <= from || seg.startMs >= to) continue;
          results.push({ ...seg, key, locKey, source });
        }
      }
    }
    results.sort((a, b) => a.startMs - b.startMs);
    return results.slice(0, 5000);
  }

  /** セグメントID → 実ファイルの絶対パス(メディア配信用) */
  resolveMediaPath(id) {
    const parts = shortString(id, 256).split('~');
    if (parts.length !== 5) return null;
    const [locKey, source, dateStr] = parts;
    const data = this._readDayFile(locKey, source, dateStr);
    if (!data) return null;
    const seg = data.segments.find(s => s.id === id);
    if (!seg || !seg.file) return null;
    const abs = path.resolve(this.recordingsDir(), seg.file);
    if (!abs.startsWith(path.resolve(this.recordingsDir()) + path.sep)) return null;
    return abs;
  }

  // ── 容量管理(使用レート推定・最低空き容量の確保) ─────────

  _diskFreeBytes() {
    try {
      const st = fs.statfsSync(this.recordingsDir());
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }

  /**
   * 直近24時間に記録されたセグメントの合計サイズから
   * 1日あたりの使用量と「予想される残り保存期間」を推定する。
   * 録画開始から24時間未満の場合は実績時間から外挿する。
   */
  _estimateUsage() {
    const now = Date.now();
    if (this._usageCache && now - this._usageCache.at < 60_000) return this._usageCache.data;

    let bytes = 0;
    let oldestMs = now;
    try {
      const segments = this.querySegments({ fromMs: now - 24 * 3600e3, toMs: now + 3600e3 });
      for (const seg of segments) {
        bytes += Number(seg.size) || 0;
        if (seg.startMs < oldestMs) oldestMs = seg.startMs;
      }
    } catch { /* インデックス未作成時など */ }

    let bytesPerDay = null;
    if (bytes > 0) {
      const spanMs = Math.max(now - oldestMs, 3600e3); // 最低1時間で外挿
      bytesPerDay = Math.round(bytes * (24 * 3600e3) / spanMs);
    }

    const free = this._diskFreeBytes();
    const minFreeBytes = this.settings.minFreeGb * 1024 ** 3;
    // 「最低空き容量を割るまで」を残り保存期間とする。保持期間より長くは残らない
    let estimatedRemainingDays = null;
    if (bytesPerDay && free !== null) {
      estimatedRemainingDays = Math.max(0, (free - minFreeBytes) / bytesPerDay);
      estimatedRemainingDays = Math.min(estimatedRemainingDays, this.settings.retentionDays);
      estimatedRemainingDays = Math.round(estimatedRemainingDays * 10) / 10;
    }

    const data = { bytesPerDay, estimatedRemainingDays, sampledBytes24h: bytes };
    this._usageCache = { at: now, data };
    return data;
  }

  /**
   * 最低空き容量(既定10GB)を確保する。下回った場合は保持期間内であっても
   * 全拠点を通して最も古いセグメントから順に削除する。
   */
  async _enforceMinFreeSpace() {
    if (!this.settings.enabled || !this.storageOk) return;
    const minFreeBytes = this.settings.minFreeGb * 1024 ** 3;
    const free = this._diskFreeBytes();
    if (free === null) return;
    this.lowDisk = free < minFreeBytes;
    if (!this.lowDisk) return;

    const needBytes = Math.round(minFreeBytes * 1.05) - free; // 少し余分に空けてフラッピングを防ぐ
    let freed = 0;
    let removedCount = 0;

    await this._withIndexLock(() => {
      // 全拠点・全日のセグメントを開始時刻の昇順に集める
      const all = [];
      let keyDirs = [];
      try { keyDirs = fs.readdirSync(this._segmentsDir()); } catch { return; }
      for (const keyDir of keyDirs) {
        const dirPath = path.join(this._segmentsDir(), keyDir);
        let dayFiles = [];
        try { dayFiles = fs.readdirSync(dirPath).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)); } catch { continue; }
        for (const dayFile of dayFiles) {
          const filePath = path.join(dirPath, dayFile);
          const data = asObject(readJson(filePath, null));
          for (const seg of (Array.isArray(data.segments) ? data.segments : [])) {
            all.push({ seg, dayFilePath: filePath });
          }
        }
      }
      all.sort((a, b) => a.seg.startMs - b.seg.startMs);

      const removedByDayFile = new Map(); // dayFilePath → Set(segId)
      for (const { seg, dayFilePath } of all) {
        if (freed >= needBytes) break;
        const abs = seg.file ? path.resolve(this.recordingsDir(), seg.file) : null;
        if (abs && abs.startsWith(path.resolve(this.recordingsDir()) + path.sep)) {
          try { fs.unlinkSync(abs); } catch (_) { /* 既に無い場合も index からは消す */ }
        }
        freed += Number(seg.size) || 0;
        removedCount += 1;
        if (!removedByDayFile.has(dayFilePath)) removedByDayFile.set(dayFilePath, new Set());
        removedByDayFile.get(dayFilePath).add(seg.id);
      }

      for (const [dayFilePath, removedIds] of removedByDayFile) {
        const data = asObject(readJson(dayFilePath, null));
        const keep = (Array.isArray(data.segments) ? data.segments : []).filter(seg => !removedIds.has(seg.id));
        if (!keep.length) {
          try { fs.unlinkSync(dayFilePath); } catch (_) {}
        } else {
          writeJsonAtomic(dayFilePath, { ...data, segments: keep });
        }
        this._dayCache.delete(dayFilePath);
      }
    });

    this._usageCache = null;
    this._removeEmptyDirs(this.recordingsDir(), 3);
    if (removedCount > 0) {
      this.log(`[Recording] WARN: 空き容量が最低確保量(${this.settings.minFreeGb}GB)を下回ったため、古い録画${removedCount}件(約${(freed / 1024 / 1024 / 1024).toFixed(1)}GB)を削除しました`);
    } else {
      this.log(`[Recording] WARN: 空き容量が${this.settings.minFreeGb}GBを下回っていますが、削除できる録画がありません`);
    }
    this.lowDisk = (this._diskFreeBytes() ?? 0) < minFreeBytes;
  }

  // ── 保持期間による自動削除 ───────────────────────────────

  async sweepRetention() {
    if (!this.storageOk) return;
    const cutoffMs = Date.now() - this.settings.retentionDays * 24 * 3600 * 1000;
    const cutoffDate = fmtDate(cutoffMs);
    let removedFiles = 0;

    await this._withIndexLock(() => {
      let keyDirs = [];
      try { keyDirs = fs.readdirSync(this._segmentsDir()); } catch { return; }
      for (const keyDir of keyDirs) {
        const dirPath = path.join(this._segmentsDir(), keyDir);
        let dayFiles = [];
        try { dayFiles = fs.readdirSync(dirPath).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)); } catch { continue; }
        for (const dayFile of dayFiles) {
          const dateStr = dayFile.slice(0, 10);
          if (dateStr > cutoffDate) continue;
          const filePath = path.join(dirPath, dayFile);
          const data = asObject(readJson(filePath, null));
          const segments = Array.isArray(data.segments) ? data.segments : [];
          const keep = [];
          for (const seg of segments) {
            if (seg.startMs >= cutoffMs) { keep.push(seg); continue; }
            const abs = seg.file ? path.resolve(this.recordingsDir(), seg.file) : null;
            if (abs && abs.startsWith(path.resolve(this.recordingsDir()) + path.sep)) {
              try { fs.unlinkSync(abs); removedFiles += 1; } catch (_) {}
            }
          }
          if (!keep.length) {
            try { fs.unlinkSync(filePath); } catch (_) {}
            this._dayCache.delete(filePath);
          } else if (keep.length !== segments.length) {
            writeJsonAtomic(filePath, { ...data, segments: keep });
            this._dayCache.delete(filePath);
          }
        }
      }
    });

    // 取り残された古い raw ファイルも削除
    try {
      const rawRoot = this.rawDir();
      for (const locKey of fs.readdirSync(rawRoot)) {
        const locDir = path.join(rawRoot, locKey);
        let sources = [];
        try { sources = fs.readdirSync(locDir); } catch { continue; }
        for (const source of sources) {
          const dir = path.join(locDir, source);
          let names = [];
          try { names = fs.readdirSync(dir); } catch { continue; }
          for (const name of names) {
            const m = name.match(RAW_FILE_RE);
            if (!m) continue;
            const startMs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
            if (startMs < cutoffMs) {
              try { fs.unlinkSync(path.join(dir, name)); removedFiles += 1; } catch (_) {}
            }
          }
        }
      }
    } catch (_) { /* rawDir 無しは正常 */ }

    // 空になった日付ディレクトリを掃除
    this._removeEmptyDirs(this.recordingsDir(), 3);

    this.lastSweepAt = Date.now();
    if (removedFiles > 0) {
      this.log(`[Recording] 保持期間(${this.settings.retentionDays}日)超過の録画を削除: ${removedFiles}ファイル`);
      this._usageCache = null;
    }
    // 保持期間の掃除後も足りなければ最低空き容量を確保する
    await this._enforceMinFreeSpace();
  }

  _removeEmptyDirs(root, depth) {
    if (depth <= 0) return;
    let names = [];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'recording-db') continue;
      const child = path.join(root, name);
      let st;
      try { st = fs.statSync(child); } catch { continue; }
      if (!st.isDirectory()) continue;
      this._removeEmptyDirs(child, depth - 1);
      try {
        if (!fs.readdirSync(child).length) fs.rmdirSync(child);
      } catch (_) {}
    }
  }

  // ── 状態(監視GUI / API 用) ───────────────────────────────

  getStatus() {
    let disk = null;
    try {
      const st = fs.statfsSync(this.recordingsDir());
      disk = {
        freeBytes: st.bavail * st.bsize,
        totalBytes: st.blocks * st.bsize,
      };
    } catch (_) { /* 保存先未到達時など */ }

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
      usage: this._estimateUsage(),
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
    // ディスク情報は数十秒キャッシュ(500ms周期のstatfs/インデックス走査を避ける)
    const now = Date.now();
    if (!this._summaryDiskCache || now - this._summaryDiskCache.at > 30_000) {
      this._summaryDiskCache = {
        at: now,
        freeBytes: this._diskFreeBytes(),
        usage: this.settings.enabled ? this._estimateUsage() : { bytesPerDay: null, estimatedRemainingDays: null },
      };
    }
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
      freeBytes: this._summaryDiskCache.freeBytes,
      bytesPerDay: this._summaryDiskCache.usage.bytesPerDay,
      estimatedRemainingDays: this._summaryDiskCache.usage.estimatedRemainingDays,
    };
  }

  shutdown() {
    this._stopped = true;
    clearInterval(this._reconcileTimer);
    clearInterval(this._storageTimer);
    clearInterval(this._finalizeTimer);
    clearInterval(this._retentionTimer);
    clearInterval(this._freeSpaceTimer);
    this._stopAllSessions('サーバー終了');
  }
}

function createRecordingManager(options) {
  return new RecordingManager(options);
}

module.exports = { createRecordingManager, locationKeyOf };
