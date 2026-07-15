/**
 * WebRTC SFU Server (mediasoup)
 *
 * 拠点間の常時接続映像・音声共有サーバー。
 *
 * 追加シグナリングイベント:
 *   Client → Server:
 *     setMetadata({ locationName, appType, channelId, appVersion })
 *                                            拠点名・アプリ種別・チャンネルを登録
 *     setChannel({ channelId })           音声チャンネルを変更
 *     createChannel({ name })             チャンネルを追加
 *     updateChannel({ channelId, name })  チャンネル名を変更
 *     deleteChannel({ channelId })        チャンネルを削除
 *     movePeerToChannel({ targetSocketId, channelId })
 *                                            拠点をチャンネル移動
 *     callPeer({ targetSocketId })        指定拠点を呼び出し
 *     endPrivateCall()                    個別通話を終了して元チャンネルへ戻る
 *     getSystemState()                    チャンネル/バージョン/更新情報を取得
 *     pauseProducer({ producerId })       カメラ/マイク OFF を通知
 *     resumeProducer({ producerId })      カメラ/マイク ON を通知
 *
 *   Server → Client:
 *     systemStateUpdated({ ... })         チャンネル/更新情報変更通知
 *     incomingCall({ fromSocketId, fromName, fromChannelId, callId })
 *     privateCallStarted({ channelId })   個別通話チャンネルへ移動
 *     privateCallEnded({ channelId, shouldMuteMic })
 *     peerChannelChanged({ socketId, channelId })
 *     updateCommand({ appType, packageInfo, forced })
 *     newProducer({ producerId, socketId, locationName, kind, paused, source, channelId })
 *     producerClosed({ producerId, socketId })
 *     producerPaused({ producerId, socketId })
 *     producerResumed({ producerId, socketId })
 *     peerDisconnected({ socketId })
 */

const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const config = require('./config');
const serverPackage = require('./package.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' })); // 録画設定API(POST /recordings/api/settings)用

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 30000,
  connectTimeout: 15000,
});

let workers = [];
let nextWorkerIdx = 0;
let router;
let routerWorker;        // router が載っている worker
let webRtcServer = null; // RTC_PORT 指定時の固定ポート集約（routerWorker 上に作る）
let activeExtraTcpPorts = []; // 実際にバインドできた追加TCP待受ポート（監視GUI表示用）
let recovering = false;  // 二重リカバリ防止
const RESTART_ACK_TIMEOUT_MS = 2500;
// テレメトリ断を理由にクライアントを丸ごと再起動させる復旧機構。
// 不安定なVPN経路ではテレメトリのACK(1.5秒)が落ちやすく、誤発火すると
// 「接続→数十秒で再起動」のループに陥り、かえって常時接続を妨げる。
// そのため既定の閾値を大きく取り、クールダウンも延ばして暴発を防ぐ。
// TELEMETRY_AUTO_RESTART=0 で完全停止も可能（ネットワーク調査時に有用）。
const TELEMETRY_AUTO_RESTART = !/^(0|false|no|off)$/i.test(process.env.TELEMETRY_AUTO_RESTART || '');
const TELEMETRY_MISSING_RESTART_MS = Number(process.env.TELEMETRY_MISSING_RESTART_MS) || 45000;
const TELEMETRY_STALE_RESTART_MS = Number(process.env.TELEMETRY_STALE_RESTART_MS) || 90000;
const TELEMETRY_RESTART_COOLDOWN_MS = Number(process.env.TELEMETRY_RESTART_COOLDOWN_MS) || 180000;
// ICEが disconnected のまま復帰しない transport を強制的に閉じるまでの猶予。
// 劣化VPN経路では close_notify が届かず dtlsstatechange も発火しないまま
// transport が残り続け、RTCポート範囲/mediasoup-worker のネイティブリソースを
// 長時間稼働で消費し続ける（サーバーOSフリーズの一因）。バックストップとして回収する。
const ICE_DISCONNECTED_CLOSE_MS = Number(process.env.ICE_DISCONNECTED_CLOSE_MS) || 20000;
// メディアフロー監視: producer(サーバーが受信する上り映像/音声)の実RTP受信量
// (byteCount)を周期サンプリングし、「シグナリングは繋がっているのにUDPメディアが
// 届いていない」状態を検出する。announcedIp不一致・UDP遮断・VPN経路劣化などでは
// DTLS/ICEが生きたまま映像だけ止まるため、接続状態の監視だけでは検出できない。
// 停滞を検出したら当該ピアのメディアを破棄して mediaLayerRestarted でセッションを
// 作り直させ、それでも復旧しない場合は restartCommand へエスカレーションする。
// MEDIA_STALL_RECOVERY=0 で無効化可能。
const MEDIA_STALL_RECOVERY = !/^(0|false|no|off)$/i.test(process.env.MEDIA_STALL_RECOVERY || '');
const MEDIA_STALL_CHECK_MS = Number(process.env.MEDIA_STALL_CHECK_MS) || 5000;
const MEDIA_STALL_RESTART_MS = Number(process.env.MEDIA_STALL_RESTART_MS) || 15000;
const MEDIA_STALL_COOLDOWN_MS = Number(process.env.MEDIA_STALL_COOLDOWN_MS) || 60000;
// クライアント側の受信実態(テレメトリ)との突き合わせ。サーバーが下りRTPを
// 送出できていても、受信側クライアントで「カメラ映像トラックが無い/mutedのまま」
// が続く場合は、consumer取りこぼしや経路異常としてセッションを貼り直す。
const CLIENT_RECV_STALL_MS = Number(process.env.CLIENT_RECV_STALL_MS) || 20000;
// 中継の確実化: 他拠点の生きている producer に対する consumer がクライアントに
// 一定時間存在しない場合、newProducer を再通知（取りこぼし回収）し、
// それでも消費されなければセッション貼り直し→restartCommand へエスカレーションする。
const CONSUME_MISSING_NUDGE_MS = Number(process.env.CONSUME_MISSING_NUDGE_MS) || 15000;
const CONSUME_MISSING_REBUILD_MS = Number(process.env.CONSUME_MISSING_REBUILD_MS) || 45000;
// 拠点単位の自動TCPフォールバック。UTM/ファイアウォール設置拠点では UDP の
// STUN/DTLS/SRTP がIPS・アプリケーション制御で遮断され「シグナリングは通るのに
// メディアが確立しない/すぐ止まる」となる。以下の条件でその拠点だけメディアを
// TCP(ICE-TCP)に切り替える（他拠点は低遅延なUDPのまま）:
//   - DTLS接続要求から TCP_FALLBACK_CONNECT_MS 経っても一度も確立しない
//   - メディア停滞の復旧(セッション貼り直し)が TCP_FALLBACK_AFTER_STRIKES 回続く
// 切替は instanceId 単位で TCP_FALLBACK_TTL_MS 記憶され、アプリ再起動後も維持
// される（TTL経過後はUDPを再試行し、まだ遮断されていれば自動で再切替）。
// MEDIA_TCP_FALLBACK=0 で無効化可能。
const MEDIA_TCP_FALLBACK = !/^(0|false|no|off)$/i.test(process.env.MEDIA_TCP_FALLBACK || '');
const TCP_FALLBACK_CONNECT_MS = Number(process.env.TCP_FALLBACK_CONNECT_MS) || 30000;
const TCP_FALLBACK_AFTER_STRIKES = Number(process.env.TCP_FALLBACK_AFTER_STRIKES) || 2;
const TCP_FALLBACK_TTL_MS = Number(process.env.TCP_FALLBACK_TTL_MS) || 6 * 60 * 60 * 1000;
const TCP_FALLBACK_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// instanceId → { at, ttlMs }。端末単位で記憶し、再接続・アプリ再起動後も引き継ぐ
const tcpFallbackInstances = new Map();
// 復旧方針: 映像/音声の受信が確認できない拠点は、サーバー側のセッションを
// 仮で残したままセッション貼り直しを無限に繰り返させる（クライアント側は
// 画面そのまま+スピナー表示）。それでも MEDIA_RECOVERY_RELAUNCH_MS 連続で
// 復旧しない場合のみ、最終手段としてアプリ本体の再起動を指示する。
const MEDIA_RECOVERY_RELAUNCH_MS = Number(process.env.MEDIA_RECOVERY_RELAUNCH_MS) || 5 * 60 * 1000;
// 予期しない切断後もセッションを仮で残す猶予。この間、他拠点のタイルは
// 消えずに「サーバー接続中」表示になり、同じ端末(instanceId)の再接続で
// 新しいセッションへ置き換わる。猶予を過ぎたら正式に切断扱いにする。
const PEER_DISCONNECT_GRACE_MS = Number(process.env.PEER_DISCONNECT_GRACE_MS) || 5 * 60 * 1000;
// 重複セッションの扱い: 既存セッションのテレメトリがこの時間以内に届いていれば
// 「稼働中の正規セッション」とみなし、後から来た重複接続の方を拒否する。
// 従来の「常に新しい接続で置き換える」方式は、同じ拠点で2つのアプリが同時に
// 動いている場合（二重起動・撤去し忘れの旧端末など）に置き換え合戦となり、
// その拠点が全拠点から「数秒ごとに再接続する不安定な拠点」に見える原因だった。
// 既存側が無応答（クラッシュ・ハーフオープン切断）ならテレメトリが止まるので、
// 従来どおり新しい接続で即時置き換えられる。
const DUPLICATE_ACTIVE_KEEP_MS = Number(process.env.DUPLICATE_ACTIVE_KEEP_MS) || 15000;
const DUPLICATE_REJECT_RETRY_MS = Number(process.env.DUPLICATE_REJECT_RETRY_MS) || 60000;
// フォールバック記憶の永続化先。server-gui 経由の起動では userData 配下が渡され、
// サーバープロセスを再起動してもUTM拠点のTCP切替が即座に復元される
// （再起動のたびにUDP再検出→切替の断が一巡発生するのを防ぐ）。
const SERVER_STATE_FILE = process.env.SERVER_STATE_FILE || path.join(__dirname, 'sfu-state.json');

function loadServerState() {
  try {
    const raw = JSON.parse(fs.readFileSync(SERVER_STATE_FILE, 'utf8'));
    const entries = asObject(raw.tcpFallback);
    const now = Date.now();
    for (const [instanceId, value] of Object.entries(entries)) {
      const entry = asObject(value);
      const at = Number(entry.at);
      const ttlMs = Math.min(Number(entry.ttlMs) || TCP_FALLBACK_TTL_MS, TCP_FALLBACK_TTL_MAX_MS);
      // 期限切れでも30日間は履歴として保持する（再発時のTTL延長判定に使う）
      if (!Number.isFinite(at) || now - at >= 30 * 24 * 60 * 60 * 1000) continue;
      tcpFallbackInstances.set(shortString(instanceId, 64), { at, ttlMs });
    }
    if (tcpFallbackInstances.size) {
      console.log(`[State] TCPフォールバック記憶を復元: ${tcpFallbackInstances.size}端末 (${SERVER_STATE_FILE})`);
    }
  } catch (_) { /* 初回起動・ファイル無しは正常 */ }
}

let serverStateSaveFailed = false;
function saveServerState() {
  const tcpFallback = {};
  for (const [instanceId, entry] of tcpFallbackInstances) tcpFallback[instanceId] = entry;
  try {
    fs.writeFileSync(SERVER_STATE_FILE, JSON.stringify({ tcpFallback }, null, 2));
  } catch (err) {
    if (!serverStateSaveFailed) {
      serverStateSaveFailed = true;
      console.warn(`[State] 状態ファイルを保存できません (${SERVER_STATE_FILE}): ${err.message}`);
    }
  }
}
loadServerState();

// ── サーバー録画 ─────────────────────────────────────────
// 各拠点のカメラ映像を PlainTransport → ffmpeg で常時録画する。
// カメラOFF(論理pause)中もクライアントは送信を続けるため録画は途切れない。
// 設定(保存先/保持期間/圧縮など)は recording-settings.json に永続化され、
// server-gui の IPC(set-recording-settings) または /recordings/api/settings で変更できる。
const { createRecordingManager } = require('./recording');
const RECORDING_SETTINGS_FILE = process.env.RECORDING_SETTINGS_FILE
  || path.join(path.dirname(SERVER_STATE_FILE), 'recording-settings.json');
const recording = createRecordingManager({
  getRouter: () => router,
  log: message => sendAdminLog(message),
  settingsFile: RECORDING_SETTINGS_FILE,
});

const SYSTEM_NAME = 'CHECKHOUSE Meeting System';
const DEFAULT_CHANNELS = [
  { id: 'general', name: '一般' },
  { id: 'support', name: 'サポート' },
];
const PRIVATE_CHANNEL_PREFIX = 'private-';
const PRIVATE_CHANNEL_NAME = '個別';
const APP_TYPES = ['client', 'viewer', 'screen-share', 'server', 'server-gui'];
const SERVER_APP_VERSION = serverPackage.version || '0.0.0';
const DEFAULT_APP_VERSIONS = {
  client: '0.6.0',
  viewer: '0.1.1',
  'screen-share': '0.2.1',
  server: SERVER_APP_VERSION,
  'server-gui': '1.4.0',
};
// ルーティン再起動の既定値。長時間稼働によるリソース肥大・原因不明の不調を
// 予防するため、指定時刻(HH:MM、複数可)にサーバー/クライアントを計画再起動する。
// 設定は server-gui で編集され、systemState 経由で全クライアントへ同期される。
const DEFAULT_MAINTENANCE = {
  serverRestartTimes: [],  // サーバープロセスの再起動時刻(server-gui監視下で自動復帰)
  clientRestartTimes: [],  // クライアントアプリの再起動時刻(全拠点へ配信)
};

let systemState = {
  brand: SYSTEM_NAME,
  channels: DEFAULT_CHANNELS,
  latestVersions: { ...DEFAULT_APP_VERSIONS },
  updatePackages: {},
  maintenance: { ...DEFAULT_MAINTENANCE },
  updatedAt: Date.now(),
};
const privateSessions = new Map();

/**
 * peers[socket.id] = {
 *   socket,
 *   locationName: string,
 *   transports: Map<transportId, Transport>,
 *   producers: Map<producerId, { producer, kind, paused }>,
 *   consumers: Map<consumerId, Consumer>,
 *   deviceState: object,
 *   monitorState: object,
 *   lastHeartbeatAt: number,
 * }
 */
const peers = {};
const MAX_DEVICE_LIST = 32;
const MAX_MONITOR_PEERS = 32;
const MAX_RTT_SAMPLES = 20;

// アップデート配布フォルダ（server-gui から set-update-dir で指定される）
let updateDir = process.env.UPDATE_DIR && fs.existsSync(process.env.UPDATE_DIR)
  ? process.env.UPDATE_DIR
  : null;

// ── Workers ──────────────────────────────────────────────

async function spawnWorker() {
  const worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags:  config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });
  worker.on('died', () => {
    console.error(`[Worker] died pid=${worker.pid}`);
    workers = workers.filter(w => w !== worker);
    // router を載せていた worker が死んだら、メディア層を作り直してクライアントを復帰させる
    if (worker === routerWorker) {
      recoverMediaLayer();
    } else {
      spawnWorker()
        .then(w => workers.push(w))
        .catch(err => console.error('[Worker] replacement failed:', err));
    }
  });
  console.log(`[Worker] created pid=${worker.pid}`);
  return worker;
}

async function createWorkers() {
  for (let i = 0; i < config.mediasoup.numWorkers; i++) {
    workers.push(await spawnWorker());
  }
}

function getWorker() {
  const w = workers[nextWorkerIdx % workers.length];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return w;
}

/** router を（再）生成。worker 死亡時はここで作り直し、全クライアントを再接続させる */
async function createRouter() {
  routerWorker = getWorker();

  // RTC_PORT 固定ポートモード: 全 transport を1つの UDP/TCP ポートに集約する。
  // UTM/FWの許可設定が1ポートで済み、動的ポート起因の「たまたま通らない」を排除する。
  // 追加TCP待受(443等)は権限やポート競合で失敗しうるため、
  // 「追加ポート込み → 本体ポートのみ → 従来のポート範囲」の順で縮退する。
  if (config.rtcPort) {
    if (webRtcServer && !webRtcServer.closed) {
      try { webRtcServer.close(); } catch (_) {}
    }
    webRtcServer = null;
    activeExtraTcpPorts = [];

    const portPlans = [];
    if (config.rtcExtraTcpPorts.length) portPlans.push(config.rtcExtraTcpPorts);
    portPlans.push([]);

    for (const extraPorts of portPlans) {
      if (webRtcServer) break;
      const listenInfos = config.buildRtcListenInfos(config.rtcPort, extraPorts);
      if (!listenInfos.length) break;
      // worker 死亡直後の再作成では旧プロセスのポート解放が間に合わないことが
      // あるため、失敗は少し待って1回だけ再試行する。
      for (let attempt = 0; attempt < 2 && !webRtcServer; attempt += 1) {
        try {
          webRtcServer = await routerWorker.createWebRtcServer({ listenInfos });
          activeExtraTcpPorts = extraPorts;
          const extraNote = extraPorts.length ? ` extraTcp=${extraPorts.join(',')}` : '';
          console.log(`[Router] WebRtcServer created port=${config.rtcPort}${extraNote} on worker pid=${routerWorker.pid}`);
        } catch (err) {
          console.error(`[Router] WebRtcServer creation failed (attempt ${attempt + 1}${extraPorts.length ? ` extraTcp=${extraPorts.join(',')}` : ''}):`, err.message);
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      if (!webRtcServer && extraPorts.length) {
        console.error(`[Router] 追加TCP待受(${extraPorts.join(',')})をバインドできません(権限またはポート競合)。追加ポート無しで再試行します`);
      }
    }
    if (!webRtcServer) {
      console.error('[Router] WebRtcServer を作成できないため、従来のポート範囲方式で継続します');
    }
  }

  router = await routerWorker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
  console.log(`[Router] created on worker pid=${routerWorker.pid}`);
}

async function recoverMediaLayer() {
  if (recovering) return;
  recovering = true;
  console.error('[Recover] rebuilding media layer...');
  try {
    if (workers.length === 0) workers.push(await spawnWorker());
    await createRouter();
    while (workers.length < config.mediasoup.numWorkers) {
      workers.push(await spawnWorker());
    }
    // 既存ピアの Socket.IO 接続は残し、mediasoup オブジェクトだけ作り直させる。
    // server disconnect はクライアントの自動再接続に乗らないため、専用イベントで復旧する。
    for (const peer of Object.values(peers)) {
      resetPeerMedia(peer);
      peer.socket.emit('mediaLayerRestarted');
    }
    console.error('[Recover] done. clients will rebuild media sessions.');
  } catch (err) {
    console.error('[Recover] failed, exiting for supervisor restart:', err);
    setTimeout(() => process.exit(1), 1000);
  } finally {
    recovering = false;
  }
}

function resetPeerMedia(peer) {
  if (!peer) return;
  for (const transport of peer.transports.values()) {
    try { transport.close(); } catch (_) {}
  }
  peer.transports.clear();
  peer.producers.clear();
  peer.consumers.clear();
  // consume欠落の追跡は貼り直し後にゼロから数え直す（即再発火の防止）
  if (peer.missingConsumers) peer.missingConsumers.clear();
}

/**
 * 拠点の「復旧中」状態を設定し、変化があれば全拠点へ配信する。
 * 復旧中の拠点は、本人には中央スピナー(サーバーと接続中...)、
 * 他拠点にはタイル上の「サーバー接続中」表示として反映される。
 */
function setPeerRecovering(socketId, peer, recovering, reason = '') {
  if (!peer || !!peer.mediaRecovering === !!recovering) return;
  peer.mediaRecovering = !!recovering;
  peer.mediaRecoveringSince = recovering ? Date.now() : 0;
  io.emit('peerRecoveryChanged', {
    socketId,
    locationName: peer.locationName,
    recovering: !!recovering,
    serverTime: Date.now(),
  });
  sendAdminLog(`[Recovery] ${recovering ? 'recovering' : 'recovered'} name=${peer.locationName} socket=${socketId}${reason ? ` reason=${reason}` : ''}`);
}

/** 仮セッションも含めて拠点を正式に削除し、全拠点へ切断を通知する */
function removePeer(socketId, reason = 'disconnect') {
  const peer = peers[socketId];
  if (!peer) return;
  resetPeerMedia(peer);
  delete peers[socketId];
  io.emit('peerDisconnected', { socketId, serverTime: Date.now() });
  sendAdminLog(`[Session] removed name=${peer.locationName} socket=${socketId} reason=${reason}`);
}

/** 切断猶予(仮セッション)の期限を掃除する */
function sweepDisconnectedPeers(now = Date.now()) {
  for (const [socketId, peer] of Object.entries(peers)) {
    if (!peer.socketDisconnectedAt) continue;
    if (peer.socket?.connected) { peer.socketDisconnectedAt = null; continue; }
    if (now - peer.socketDisconnectedAt < PEER_DISCONNECT_GRACE_MS) continue;
    removePeer(socketId, 'grace-expired');
    broadcastViewerPresence();
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function shortString(value, max = 256) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function stableId(value, fallback = 'general') {
  const raw = shortString(value, 64).trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function sanitizeChannels(channels) {
  if (!Array.isArray(channels)) return DEFAULT_CHANNELS;
  const seen = new Set();
  const sanitized = [];

  for (const item of channels.slice(0, 32)) {
    const input = asObject(item);
    const id = stableId(input.id || input.name, '');
    const name = shortString(input.name || id, 48).trim();
    if (input.private || input.temporary || id.startsWith(PRIVATE_CHANNEL_PREFIX)) continue;
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    sanitized.push({ id, name });
  }

  return sanitized.length ? sanitized : DEFAULT_CHANNELS;
}

function publicPrivateChannel(session) {
  return {
    id: session.channelId,
    name: PRIVATE_CHANNEL_NAME,
    private: true,
    temporary: true,
    memberCount: session.members.size,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function getPrivateChannels() {
  return Array.from(privateSessions.values())
    .filter(session => session.members.size > 0)
    .map(publicPrivateChannel);
}

function getAllChannels() {
  return [...systemState.channels, ...getPrivateChannels()];
}

function createUniqueChannelId(name) {
  const base = stableId(name, 'channel');
  const existing = new Set(getAllChannels().map(channel => channel.id));
  if (!existing.has(base)) return base;

  for (let index = 2; index <= 99; index += 1) {
    const candidate = stableId(`${base}-${index}`, `channel-${index}`);
    if (!existing.has(candidate)) return candidate;
  }
  return stableId(`${base}-${Date.now()}`, `channel-${Date.now()}`);
}

function normalizeChannelId(channelId) {
  const id = stableId(channelId, systemState.channels[0]?.id || DEFAULT_CHANNELS[0].id);
  return systemState.channels.some(channel => channel.id === id) || privateSessions.has(id)
    ? id
    : (systemState.channels[0]?.id || DEFAULT_CHANNELS[0].id);
}

function isPrivateChannelId(channelId) {
  const id = stableId(channelId, '');
  return !!id && privateSessions.has(id);
}

function fallbackChannelId(preferred = '') {
  const id = stableId(preferred, '');
  if (id && systemState.channels.some(channel => channel.id === id)) return id;
  return systemState.channels[0]?.id || DEFAULT_CHANNELS[0].id;
}

function sanitizeVersionMap(input, previous = {}) {
  const raw = asObject(input);
  const next = { ...previous };
  for (const appType of APP_TYPES) {
    if (raw[appType] == null) continue;
    next[appType] = shortString(raw[appType], 48).trim();
  }
  return next;
}

function sanitizeUpdatePackages(input, previous = {}) {
  const raw = asObject(input);
  const next = { ...previous };
  for (const appType of APP_TYPES) {
    if (raw[appType] == null) continue;
    const pkg = asObject(raw[appType]);
    const version = shortString(pkg.version || systemState.latestVersions[appType] || '', 48).trim();
    const url = shortString(pkg.url, 1024).trim();
    const notes = shortString(pkg.notes, 1000).trim();
    const sha256 = shortString(pkg.sha256, 128).trim();
    next[appType] = {
      version,
      url,
      notes,
      sha256,
      required: !!pkg.required,
      registeredAt: Number.isFinite(pkg.registeredAt) ? pkg.registeredAt : Date.now(),
    };
  }
  return next;
}

/** "HH:MM" 形式の時刻リストを検証・正規化する(ゼロ埋め・重複除去・昇順・最大12件) */
function sanitizeRestartTimes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value.slice(0, 32)) {
    const match = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(item ?? ''));
    if (!match) continue;
    seen.add(`${match[1].padStart(2, '0')}:${match[2]}`);
  }
  return Array.from(seen).sort().slice(0, 12);
}

function sanitizeMaintenance(value, fallback = DEFAULT_MAINTENANCE) {
  const raw = asObject(value);
  const base = asObject(fallback);
  return {
    serverRestartTimes: raw.serverRestartTimes == null
      ? sanitizeRestartTimes(base.serverRestartTimes)
      : sanitizeRestartTimes(raw.serverRestartTimes),
    clientRestartTimes: raw.clientRestartTimes == null
      ? sanitizeRestartTimes(base.clientRestartTimes)
      : sanitizeRestartTimes(raw.clientRestartTimes),
  };
}

function sanitizeSystemStatePatch(patch) {
  const raw = asObject(patch);
  const channels = raw.channels == null ? systemState.channels : sanitizeChannels(raw.channels);
  const latestVersions = sanitizeVersionMap(raw.latestVersions, systemState.latestVersions);
  const updatePackages = sanitizeUpdatePackages(raw.updatePackages, systemState.updatePackages);
  const maintenance = raw.maintenance == null
    ? sanitizeMaintenance(systemState.maintenance)
    : sanitizeMaintenance(raw.maintenance, systemState.maintenance);

  return {
    brand: SYSTEM_NAME,
    channels,
    latestVersions,
    updatePackages,
    maintenance,
    updatedAt: Date.now(),
  };
}

/** 配布URLが相対パス（/updates/...）の場合、サーバーの公開IPで絶対URLへ解決する */
function resolveUpdateUrl(url) {
  const value = shortString(url, 1024).trim();
  if (!value || /^https?:\/\//i.test(value)) return value;
  const host = config.announcedIp || localIpv4Addresses()[0] || config.listenIp || '127.0.0.1';
  const pathname = value.startsWith('/') ? value : `/${value}`;
  return `http://${host}:${config.listenPort}${pathname}`;
}

function getSystemStateSnapshot() {
  const updatePackages = {};
  for (const [appType, pkg] of Object.entries(systemState.updatePackages || {})) {
    updatePackages[appType] = { ...pkg, url: resolveUpdateUrl(pkg.url) };
  }
  return {
    ...systemState,
    channels: getAllChannels(),
    updatePackages,
    serverVersion: SERVER_APP_VERSION,
  };
}

function broadcastSystemState() {
  const snapshot = getSystemStateSnapshot();
  io.emit('systemStateUpdated', snapshot);
  return snapshot;
}

function emitPeerChannelChanged(socketId, peer) {
  if (!peer) return;
  io.emit('peerChannelChanged', {
    socketId,
    channelId: peer.channelId,
    locationName: peer.locationName,
    serverTime: Date.now(),
  });
}

function getPrivateSessionForSocket(socketId) {
  for (const session of privateSessions.values()) {
    if (session.members.has(socketId)) return session;
  }
  return null;
}

function getPrivateCallForSocket(socketId) {
  const session = getPrivateSessionForSocket(socketId);
  if (!session) return null;
  const member = session.members.get(socketId) || {};
  return {
    privateChannelId: session.channelId,
    channelId: session.channelId,
    channelName: PRIVATE_CHANNEL_NAME,
    previousChannelId: fallbackChannelId(member.previousChannelId),
    memberSocketIds: Array.from(session.members.keys()),
    createdAt: session.createdAt,
    joinedAt: member.joinedAt || session.createdAt,
  };
}

function emitSelfSystemState(socketId, peer) {
  if (!peer?.socket) return;
  peer.socket.emit('systemStateUpdated', {
    ...getSystemStateSnapshot(),
    self: {
      socketId,
      channelId: peer.channelId,
      appType: peer.appType,
      appVersion: peer.appVersion,
      privateCall: getPrivateCallForSocket(socketId),
    },
  });
}

function emitPrivateCallStarted(socketId, session, previousChannelId, source = 'server') {
  const peer = peers[socketId];
  if (!peer?.socket) return;
  peer.socket.emit('privateCallStarted', {
    privateChannelId: session.channelId,
    channelId: session.channelId,
    channelName: PRIVATE_CHANNEL_NAME,
    previousChannelId: fallbackChannelId(previousChannelId),
    memberSocketIds: Array.from(session.members.keys()),
    source,
    serverTime: Date.now(),
  });
}

function emitPrivateCallEnded(socketId, privateChannelId, returnChannelId, reason = 'ended', { shouldMuteMic = true } = {}) {
  const peer = peers[socketId];
  if (!peer?.socket) return;
  const returnChannel = systemState.channels.find(channel => channel.id === returnChannelId) || systemState.channels[0];
  peer.socket.emit('privateCallEnded', {
    privateChannelId,
    channelId: returnChannel?.id || returnChannelId,
    channelName: returnChannel?.name || '',
    shouldMuteMic: !!shouldMuteMic,
    reason,
    serverTime: Date.now(),
  });
}

function assignPeerChannel(socketId, channelId, source = 'server') {
  const peer = peers[socketId];
  if (!peer) return { ok: false, error: 'client not connected' };
  const nextChannelId = normalizeChannelId(channelId);
  const changed = peer.channelId !== nextChannelId;
  peer.channelId = nextChannelId;
  if (changed) emitPeerChannelChanged(socketId, peer);
  emitSelfSystemState(socketId, peer);
  sendAdminLog(`[Channel] set peer=${socketId} channel=${nextChannelId} source=${source}`);
  return { ok: true, channelId: nextChannelId };
}

function leavePrivateSession(socketId, {
  targetChannelId = '',
  reason = 'ended',
  source = 'server',
  notify = true,
  shouldMuteMic = true,
  closeWhenAlone = true,
} = {}) {
  const session = getPrivateSessionForSocket(socketId);
  const peer = peers[socketId];
  if (!session) {
    return peer
      ? { ok: true, channelId: fallbackChannelId(targetChannelId || peer.channelId), privateChannelId: '' }
      : { ok: false, error: 'client not connected' };
  }

  const member = session.members.get(socketId) || {};
  const returnChannelId = fallbackChannelId(targetChannelId || member.previousChannelId);
  session.members.delete(socketId);
  session.updatedAt = Date.now();
  assignPeerChannel(socketId, returnChannelId, source);
  if (notify) emitPrivateCallEnded(socketId, session.channelId, returnChannelId, reason, { shouldMuteMic });

  if (session.members.size === 0) {
    privateSessions.delete(session.channelId);
  } else if (closeWhenAlone && session.members.size === 1) {
    const [remainingSocketId] = Array.from(session.members.keys());
    leavePrivateSession(remainingSocketId, {
      reason: 'peer-left',
      source,
      notify: true,
      shouldMuteMic: true,
      closeWhenAlone: false,
    });
    privateSessions.delete(session.channelId);
  }

  broadcastSystemState();
  sendAdminLog(`[PrivateCall] leave peer=${socketId} privateChannel=${session.channelId} return=${returnChannelId} reason=${reason} source=${source}`);
  return { ok: true, channelId: returnChannelId, privateChannelId: session.channelId };
}

function closePrivateSession(session, reason = 'closed', { source = 'server', shouldMuteMic = true } = {}) {
  if (!session) return;
  for (const socketId of Array.from(session.members.keys())) {
    leavePrivateSession(socketId, {
      reason,
      source,
      notify: true,
      shouldMuteMic,
      closeWhenAlone: false,
    });
  }
  privateSessions.delete(session.channelId);
}

function createPrivateChannelId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const id = stableId(`${PRIVATE_CHANNEL_PREFIX}${suffix}`, `${PRIVATE_CHANNEL_PREFIX}${Date.now()}`);
    if (!privateSessions.has(id) && !systemState.channels.some(channel => channel.id === id)) return id;
  }
  return stableId(`${PRIVATE_CHANNEL_PREFIX}${Date.now()}-${process.pid}`, `${PRIVATE_CHANNEL_PREFIX}${Date.now()}`);
}

function addPeerToPrivateSession(session, socketId, source = 'server') {
  const peer = peers[socketId];
  if (!peer) return { ok: false, error: 'client not connected' };

  const existingSession = getPrivateSessionForSocket(socketId);
  if (existingSession && existingSession.channelId !== session.channelId) {
    leavePrivateSession(socketId, {
      reason: 'private-transfer',
      source,
      notify: true,
      shouldMuteMic: false,
      closeWhenAlone: true,
    });
  }

  const currentMember = session.members.get(socketId);
  const previousChannelId = currentMember?.previousChannelId
    || (isPrivateChannelId(peer.channelId) ? fallbackChannelId() : fallbackChannelId(peer.channelId));
  session.members.set(socketId, {
    previousChannelId,
    joinedAt: currentMember?.joinedAt || Date.now(),
  });
  session.updatedAt = Date.now();

  assignPeerChannel(socketId, session.channelId, source);
  emitPrivateCallStarted(socketId, session, previousChannelId, source);
  broadcastSystemState();
  sendAdminLog(`[PrivateCall] join peer=${socketId} privateChannel=${session.channelId} previous=${previousChannelId} source=${source}`);
  return { ok: true, channelId: session.channelId, privateChannelId: session.channelId, previousChannelId };
}

function ensurePrivateSessionForCaller(socketId, source = 'server') {
  const peer = peers[socketId];
  if (!peer) return { ok: false, error: 'client not connected' };
  const existingSession = getPrivateSessionForSocket(socketId);
  if (existingSession) {
    return { ok: true, session: existingSession, created: false };
  }

  const channelId = createPrivateChannelId();
  const session = {
    channelId,
    members: new Map(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  privateSessions.set(channelId, session);
  const joined = addPeerToPrivateSession(session, socketId, source);
  if (!joined.ok) {
    privateSessions.delete(channelId);
    return joined;
  }
  return { ok: true, session, created: true };
}

function cleanupFailedPrivateCall(call, action) {
  if (!call?.privateChannelId || !call.privateCreatedForCall || action === 'answered') return;
  const session = privateSessions.get(call.privateChannelId);
  if (!session) return;
  if (session.members.size <= 1 && session.members.has(call.fromSocketId)) {
    closePrivateSession(session, `call-${action}`, { source: 'private-call', shouldMuteMic: true });
  }
}

function setPeerChannel(socketId, channelId, source = 'server') {
  const peer = peers[socketId];
  if (!peer) return { ok: false, error: 'client not connected' };
  const nextChannelId = normalizeChannelId(channelId);
  const activePrivateSession = getPrivateSessionForSocket(socketId);
  const targetPrivateSession = privateSessions.get(nextChannelId);

  if (targetPrivateSession && !targetPrivateSession.members.has(socketId)) {
    return { ok: false, error: 'private channel requires a call invitation' };
  }

  if (activePrivateSession && nextChannelId !== activePrivateSession.channelId) {
    return leavePrivateSession(socketId, {
      targetChannelId: nextChannelId,
      reason: 'channel-change',
      source,
      notify: true,
      shouldMuteMic: false,
      closeWhenAlone: true,
    });
  }

  return assignPeerChannel(socketId, nextChannelId, source);
}

function sanitizeProducerSource(kind, appData = {}) {
  const requested = shortString(appData.source || appData.mediaTag || appData.type, 32);
  if (kind === 'audio') {
    if (requested === 'screen-audio' || requested === 'system-audio' || requested === 'desktop-audio') {
      return 'screen-audio';
    }
    return 'microphone';
  }
  if (requested === 'screen' || requested === 'window' || requested === 'application') return 'screen';
  return 'camera';
}

function publicProducer(producerId, entry) {
  const source = entry.source || sanitizeProducerSource(entry.kind, entry.appData);
  return {
    producerId,
    kind: entry.kind,
    paused: !!entry.paused,
    source,
    appData: {
      ...(entry.appData || {}),
      source,
    },
    channelId: entry.channelId || null,
    // サーバーが実RTP受信を確認できているか（監視GUI向け。停滞中は true）
    flowStalled: !!entry.flowStalled,
  };
}

function findProducerOwner(producerId) {
  for (const [peerId, peer] of Object.entries(peers)) {
    if (peer.producers.has(producerId)) return { peerId, peer, entry: peer.producers.get(producerId) };
  }
  return null;
}

/**
 * カメラ映像のOFFを「配信の停止」として扱う producer か。
 * 該当する producer は pause 時に producer 自体を止めず、他拠点へ配る
 * consumer だけを pause する。クライアントは送信を続けるため、
 * サーバー録画はカメラOFF中も継続できる。マイク/画面共有は従来どおり
 * producer.pause() で完全に停止する(音声プライバシー・帯域節約)。
 */
function isCameraRelayControlled(entry) {
  const source = entry.source || sanitizeProducerSource(entry.kind, entry.appData);
  return entry.kind === 'video' && source === 'camera';
}

/**
 * 指定 producer に紐づく全拠点の consumer の配信を一括で止める/再開する。
 * 再開はクライアントが 'resume' 済み(resumedByClient)の consumer に限る。
 */
async function setRelayPausedForProducer(producerId, paused) {
  for (const peer of Object.values(peers)) {
    for (const consumer of peer.consumers.values()) {
      if (consumer.closed || consumer.producerId !== producerId) continue;
      try {
        if (paused) await consumer.pause();
        else if (consumer.appData?.resumedByClient) await consumer.resume();
      } catch (_) { /* 閉鎖済み等は無視 */ }
    }
  }
}

function safeCallback(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function getPeerForRequest(socket, callback) {
  const peer = peers[socket.id];
  if (!peer) safeCallback(callback, { error: 'peer not found' });
  return peer || null;
}

function sanitizeDeviceList(devices) {
  if (!Array.isArray(devices)) return [];
  return devices.slice(0, MAX_DEVICE_LIST).map(device => {
    const item = asObject(device);
    return {
      deviceId: shortString(item.deviceId, 256),
      groupId: shortString(item.groupId, 256),
      kind: shortString(item.kind, 32),
      label: shortString(item.label || item.kind || 'device', 160),
    };
  });
}

function sanitizeTelemetry(report) {
  const data = asObject(report);
  const devices = asObject(data.devices);
  const selectedDevices = asObject(data.selectedDevices);
  const localMedia = asObject(data.localMedia);
  const remoteMonitor = asObject(data.remoteMonitor);
  const connection = asObject(data.connection);
  const transports = asObject(data.transports);

  const monitorPeers = Array.isArray(remoteMonitor.peers)
    ? remoteMonitor.peers.slice(0, MAX_MONITOR_PEERS).map(peer => {
      const item = asObject(peer);
      return {
        socketId: shortString(item.socketId, 128),
        name: shortString(item.name || 'unknown', 128),
        videoPaused: !!item.videoPaused,
        audioPaused: !!item.audioPaused,
        receivingVideo: !!item.receivingVideo,
        receivingAudio: !!item.receivingAudio,
        video: asObject(item.video),
        audio: asObject(item.audio),
      };
    })
    : [];

  return {
    appType: shortString(data.appType || 'client', 24),
    appVersion: shortString(data.appVersion || '', 48),
    locationName: shortString(data.locationName || '', 128),
    channelId: normalizeChannelId(data.channelId),
    status: shortString(data.status || '', 32),
    clientTime: Number.isFinite(data.clientTime) ? data.clientTime : null,
    devices: {
      video: sanitizeDeviceList(devices.video),
      audioInput: sanitizeDeviceList(devices.audioInput),
      audioOutput: sanitizeDeviceList(devices.audioOutput),
    },
    selectedDevices: {
      video: shortString(selectedDevices.video, 256),
      audioInput: shortString(selectedDevices.audioInput, 256),
      audioOutput: shortString(selectedDevices.audioOutput, 256),
    },
    localMedia,
    remoteMonitor: {
      peerCount: Number(remoteMonitor.peerCount) || monitorPeers.length,
      receivingVideoCount: Number(remoteMonitor.receivingVideoCount) || 0,
      receivingAudioCount: Number(remoteMonitor.receivingAudioCount) || 0,
      peers: monitorPeers,
    },
    connection,
    transports,
    consumers: Array.isArray(data.consumers) ? data.consumers.slice(0, MAX_MONITOR_PEERS) : [],
  };
}

function safeProcessSend(message) {
  if (!process.send || process.connected === false) return;
  try {
    process.send(message);
  } catch (err) {
    console.error('[IPC] send failed:', err.message);
  }
}

function healthStatus(peer, now = Date.now()) {
  if (!peer) return 'offline';
  if (peer.socket?.connected === false) return 'offline';
  if (!peer.lastHeartbeatAt) return 'warming';
  const age = now - peer.lastHeartbeatAt;
  if (age <= 7000) return 'healthy';
  if (age <= 20000) return 'degraded';
  return 'stale';
}

/** telemetry RTT の履歴から平均・ジッタ・安定度を算出する */
function connectionQuality(peer) {
  const samples = Array.isArray(peer.rttHistory) ? peer.rttHistory : [];
  if (!samples.length) {
    return { rttMs: peer.rttMs ?? null, avgRttMs: null, jitterMs: null, level: 'unknown', samples: 0 };
  }
  const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  let jitter = 0;
  for (let i = 1; i < samples.length; i += 1) jitter += Math.abs(samples[i] - samples[i - 1]);
  jitter = samples.length > 1 ? jitter / (samples.length - 1) : 0;

  const level =
    avg <= 80 && jitter <= 30 ? 'good' :
    avg <= 200 && jitter <= 80 ? 'fair' :
    'poor';

  return {
    rttMs: peer.rttMs ?? null,
    avgRttMs: Math.round(avg),
    jitterMs: Math.round(jitter),
    level,
    samples: samples.length,
  };
}

/**
 * producer の実状態からカメラ/マイク/画面共有の ON/OFF を導出する。
 * クライアントの pause/resume はサーバーへ即時通知されるため、
 * telemetry（2秒周期）より早く・確実に実態を反映できる。
 */
function deriveMediaState(peer) {
  const state = { camera: 'none', mic: 'none', screen: 'none', screenAudio: 'none' };
  for (const entry of peer.producers.values()) {
    const source = entry.source || sanitizeProducerSource(entry.kind, entry.appData);
    const value = entry.paused ? 'off' : 'on';
    if (source === 'camera') state.camera = value;
    else if (source === 'microphone') state.mic = value;
    else if (source === 'screen') state.screen = value;
    else if (source === 'screen-audio') state.screenAudio = value;
  }
  return state;
}

function getPeerClientSnapshot(id, peer, now = Date.now()) {
  const producerList = Array.from(peer.producers.entries()).map(([producerId, entry]) => publicProducer(producerId, entry));
  const consumerList = Array.from(peer.consumers.entries()).map(([consumerId, consumer]) => ({
    consumerId,
    producerId: consumer.producerId,
    kind: consumer.kind,
    paused: consumer.paused,
    closed: consumer.closed,
    // サーバーからこのピアへの下りRTPが実際に流れているか（停滞中は true）
    flowStalled: !!consumer.appData?.flowStalled,
  }));
  const heartbeatAgeMs = peer.lastHeartbeatAt ? now - peer.lastHeartbeatAt : null;
  // メディア経路の実態（監視GUIの「メディア経路」タブ用）。ICE/DTLS状態と
  // 実際に選択された経路(UDP/TCP・相手アドレス)を transport ごとに返す。
  const transportList = Array.from(peer.transports.values()).map(transport => ({
    id: transport.id,
    closed: !!transport.closed,
    iceState: transport.iceState,
    dtlsState: transport.dtlsState,
    iceSelectedTuple: transport.iceSelectedTuple || null,
  }));

  return {
    id,
    name: peer.locationName,
    appType: peer.appType || peer.telemetry?.appType || 'client',
    appVersion: peer.appVersion || peer.telemetry?.appVersion || '',
    channelId: peer.channelId || DEFAULT_CHANNELS[0].id,
    presenceMode: peer.presenceMode || 'none',
    remoteAddress: peer.socket.handshake.address,
    connectedAt: peer.connectedAt,
    heartbeatAgeMs,
    health: healthStatus(peer, now),
    connected: peer.socket?.connected !== false,
    recovering: !!peer.mediaRecovering,
    recoveringForMs: peer.mediaRecovering && peer.mediaRecoveringSince ? now - peer.mediaRecoveringSince : null,
    rttMs: peer.rttMs ?? null,
    signalLevel: signalLevelFor(peer, now),
    tcpFallback: !!peer.forceTcp,
    transportList,
    connectionQuality: connectionQuality(peer),
    mediaState: deriveMediaState(peer),
    producers: peer.producers.size,
    consumers: peer.consumers.size,
    producerList,
    consumerList,
    devices: peer.deviceState?.devices || { video: [], audioInput: [], audioOutput: [] },
    selectedDevices: peer.deviceState?.selectedDevices || {},
    localMedia: peer.monitorState?.localMedia || {},
    remoteMonitor: peer.monitorState?.remoteMonitor || {},
    viewerPresence: !!peer.viewerPresenceActive,
    connection: peer.monitorState?.connection || {},
    transports: peer.monitorState?.transports || {},
    telemetry: peer.telemetry || null,
  };
}

function localIpv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(item => item && item.family === 'IPv4' && !item.internal)
    .map(item => item.address);
}

// ── 外部 STUN/TURN サーバーの死活監視（監視GUI「メディア経路」タブ用）──────
// 本システムのメディアはSFU直結（固定ポート/443のICE-TCP）でTURN/STUNには
// 依存しないが、STUN_URLS/TURN_URLS が設定されている場合はSTUN Binding
// リクエストで応答を確認し、稼働状態をGUIに表示する。
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const ICE_PROBE_INTERVAL_MS = Number(process.env.ICE_PROBE_INTERVAL_MS) || 60000;
let iceProbeResults = [];

function stunBindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);        // Binding Request
  buf.writeUInt16BE(0x0000, 2);        // 属性なし
  buf.writeUInt32BE(0x2112a442, 4);    // Magic Cookie
  crypto.randomFillSync(buf, 8, 12);   // Transaction ID
  return buf;
}

function parseIceUrl(url) {
  const match = /^(stuns?|turns?):([^:?/]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(String(url || '').trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const secure = scheme === 'stuns' || scheme === 'turns';
  return {
    scheme,
    host: match[2],
    port: Number(match[3]) || (secure ? 5349 : 3478),
    transport: (match[4] || (secure ? 'tcp' : 'udp')).toLowerCase(),
  };
}

function probeStunUdp(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const request = stunBindingRequest();
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.close(); } catch (_) { /* closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '応答なし(timeout)' }), timeoutMs);
    socket.on('error', err => { clearTimeout(timer); finish({ ok: false, error: err.message }); });
    socket.on('message', message => {
      if (message.length >= 20 && message.readUInt32BE(4) === 0x2112a442 &&
          message.subarray(8, 20).equals(request.subarray(8, 20))) {
        clearTimeout(timer);
        finish({ ok: true, rttMs: Date.now() - startedAt });
      }
    });
    socket.send(request, port, host, err => {
      if (err) { clearTimeout(timer); finish({ ok: false, error: err.message }); }
    });
  });
}

function probeStunTcp(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const request = stunBindingRequest();
    let received = Buffer.alloc(0);
    let done = false;
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) { /* closed */ }
      resolve(result);
    };
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 20 && received.readUInt32BE(4) === 0x2112a442) {
        finish({ ok: true, rttMs: Date.now() - startedAt });
      }
    });
    socket.on('timeout', () => finish({ ok: false, error: '応答なし(timeout)' }));
    socket.on('error', err => finish({ ok: false, error: err.message }));
    socket.on('close', () => finish({ ok: false, error: '応答前に切断されました' }));
  });
}

let iceProbeRunning = false;
async function probeIceServers() {
  if (iceProbeRunning) return;
  const targets = [];
  for (const server of config.iceServers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      const parsed = parseIceUrl(url);
      if (parsed) targets.push({ url, ...parsed });
    }
  }
  if (!targets.length) {
    iceProbeResults = [];
    return;
  }
  iceProbeRunning = true;
  try {
    iceProbeResults = await Promise.all(targets.map(async target => {
      const result = target.transport === 'tcp'
        ? await probeStunTcp(target.host, target.port)
        : await probeStunUdp(target.host, target.port);
      return { url: target.url, transport: target.transport, checkedAt: Date.now(), ...result };
    }));
  } finally {
    iceProbeRunning = false;
  }
}

if ((config.iceServers || []).length) {
  probeIceServers().catch(err => console.warn('[IceProbe]', err.message));
  const iceProbeTimer = setInterval(() => {
    probeIceServers().catch(err => console.warn('[IceProbe]', err.message));
  }, ICE_PROBE_INTERVAL_MS);
  iceProbeTimer.unref?.();
}

function getStatsSnapshot() {
  let totalProducers = 0;
  let totalConsumers = 0;
  const clients = [];
  const now = Date.now();

  for (const [id, peer] of Object.entries(peers)) {
    totalProducers += peer.producers.size;
    totalConsumers += peer.consumers.size;
    clients.push(getPeerClientSnapshot(id, peer, now));
  }

  const healthCounts = clients.reduce((acc, client) => {
    acc[client.health] = (acc[client.health] || 0) + 1;
    return acc;
  }, {});

  const serverIps = localIpv4Addresses();

  return {
    status: recovering ? 'recovering' : 'ok',
    uptimeSec: Math.round(process.uptime()),
    memory: process.memoryUsage().rss,
    peerCount: Object.keys(peers).length,
    totalProducers,
    totalConsumers,
    healthCounts,
    clients,
    workerPids: workers.map(w => w.pid),
    routerWorkerPid: routerWorker?.pid || null,
    listenIp: config.listenIp,
    listenPort: config.listenPort,
    announcedIp: config.announcedIp,
    announcedIps: config.announcedIps || [config.announcedIp],
    serverIps,
    currentIp: config.announcedIp || serverIps[0] || config.listenIp || '',
    rtcPortRange: config.rtcPortRange,
    rtcPort: config.rtcPort || null,
    rtcSinglePortActive: !!(webRtcServer && !webRtcServer.closed),
    rtcExtraTcpPorts: activeExtraTcpPorts,
    iceServerCount: (config.iceServers || []).length,
    // 監視GUI「メディア経路」タブ用: 外部STUN/TURN設定と死活確認結果
    iceServers: (config.iceServers || []).map(server => ({
      urls: server.urls,
      hasCredential: !!server.credential,
    })),
    iceProbes: iceProbeResults,
    systemState: getSystemStateSnapshot(),
    recording: recording.getStatusSummary(),
  };
}

// ── アップデートファイル配信 ──────────────────────────────
// server-gui で選択されたフォルダ内のビルド済みパッケージを配布する。

function listUpdateFiles() {
  if (!updateDir || !fs.existsSync(updateDir)) return [];
  try {
    return fs.readdirSync(updateDir)
      // macOS の AppleDouble(._*)や .DS_Store 等の隠しファイルは配布対象外。
      // ._foo.dmg は拡張子が一致してしまい、本物の代わりに配布登録されると
      // ダウンロードが dotfile 拒否(404 NotFoundError)になる（実障害の原因）。
      .filter(name => !name.startsWith('.') && /\.(dmg|pkg|zip|exe|msi|appimage|deb|7z)$/i.test(name))
      .map(name => {
        const stat = fs.statSync(path.join(updateDir, name));
        return { name, size: stat.size, mtimeMs: stat.mtimeMs };
      });
  } catch (err) {
    console.error('[Updates] list failed:', err.message);
    return [];
  }
}

/**
 * 配布ファイルを手動ストリームで送る。
 * express の res.download(内部の send)は、パス中に「.」で始まる要素が
 * 1つでもあると（macOS の ._AppleDouble ファイルや、隠しフォルダ配下に
 * 置かれた配布ディレクトリなど）既定設定で 404 NotFoundError を投げる。
 * 手動配信にすることでファイル名・配置場所に依存せず確実に配布できる。
 */
function sendDownload(req, res, filePath, fileName) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).json({ error: 'file not found' });
  }
  if (!stat.isFile()) return res.status(404).json({ error: 'file not found' });

  // 非ASCIIファイル名は RFC 5987 (filename*) で渡し、filename には安全な代替名を入れる
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[Download] stream failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'read failed' });
    else res.destroy();
  });
  stream.pipe(res);
}

app.get('/updates', (_, res) => {
  res.json({ updateDir: updateDir || null, files: listUpdateFiles() });
});

app.get('/updates/:filename', (req, res) => {
  if (!updateDir) return res.status(404).json({ error: 'update dir not configured' });
  const fileName = path.basename(String(req.params.filename || ''));
  const filePath = path.join(updateDir, fileName);
  if (!fileName || fileName.startsWith('.') || !filePath.startsWith(updateDir) || !fs.existsSync(filePath)) {
    console.warn(`[Updates] download not found: "${fileName}" dir=${updateDir}`);
    return res.status(404).json({ error: 'file not found', fileName });
  }
  sendDownload(req, res, filePath, fileName);
});

// ── 通知音（着信音）配信 ──────────────────────────────────
// RINGTONES_DIR（未指定なら server/ringtones）に置いた mp3/wav 等を全クライアントへ
// 配布する。クライアントは一覧から選んで取り込み、ローカルに保存して使用する
// （取り込み後はサーバーが落ちていても鳴る）。server-gui 経由の起動では
// RINGTONES_DIR が userData 配下に設定され、サーバー更新後もファイルが残る。
const RINGTONE_FILE_EXT = /\.(mp3|wav|ogg|m4a|aac)$/i;
const ringtonesDir = process.env.RINGTONES_DIR || path.join(__dirname, 'ringtones');
try {
  fs.mkdirSync(ringtonesDir, { recursive: true });
} catch (err) {
  console.warn('[Ringtones] ディレクトリを作成できません:', err.message);
}

function listRingtones() {
  if (!ringtonesDir || !fs.existsSync(ringtonesDir)) return [];
  try {
    return fs.readdirSync(ringtonesDir)
      .filter(name => !name.startsWith('.') && RINGTONE_FILE_EXT.test(name))
      .map(name => {
        const stat = fs.statSync(path.join(ringtonesDir, name));
        return { name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  } catch (err) {
    console.error('[Ringtones] list failed:', err.message);
    return [];
  }
}

app.get('/ringtones', (_, res) => {
  res.json({ dir: ringtonesDir, files: listRingtones() });
});

app.get('/ringtones/:filename', (req, res) => {
  const fileName = path.basename(String(req.params.filename || ''));
  const filePath = path.join(ringtonesDir, fileName);
  if (!fileName || fileName.startsWith('.') || !RINGTONE_FILE_EXT.test(fileName) || !filePath.startsWith(ringtonesDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ringtone not found' });
  }
  sendDownload(req, res, filePath, fileName);
});

// ── 録画: タイムライン再生UI と API ───────────────────────
// /recordings              … ブラウザ用の再生UI(拠点選択・タイムライン・同時再生)
// /recordings/api/*        … 拠点一覧・セグメント検索・状態・設定変更
// /recordings/media/:id    … セグメント動画の配信(Range対応、シーク可能)
// 専用ビューアアプリ(recording-viewer)の「サーバー接続モード」もこのAPIを使う。

app.get('/recordings', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'recordings.html'));
});

app.get('/recordings/api/status', (_, res) => {
  res.json(recording.getStatus());
});

app.get('/recordings/api/locations', (_, res) => {
  res.json({ locations: recording.listLocations(), serverTime: Date.now() });
});

app.get('/recordings/api/segments', (req, res) => {
  const keys = String(req.query.keys || '').split(',').map(s => s.trim()).filter(Boolean);
  const segments = recording.querySegments({
    keys: keys.length ? keys : null,
    fromMs: Number(req.query.from),
    toMs: Number(req.query.to),
  }).map(seg => ({ ...seg, mediaUrl: `/recordings/media/${encodeURIComponent(seg.id)}` }));
  res.json({ segments });
});

app.post('/recordings/api/settings', (req, res) => {
  try {
    const settings = recording.applySettings(asObject(req.body));
    res.json({ ok: true, settings, status: recording.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ライブ視聴 ──
// 録画中の生セグメント(webm: VP8/Opus)を追記追従でストリーミングする。
// クライアントはバッファ末尾へシークすることで数秒遅れのリアルタイム視聴になる。
// セグメントが切り替わる(既定5分ごと)とストリームは終了し、クライアントが再接続する。

app.get('/recordings/api/live', (_, res) => {
  res.json({ sessions: recording.getLiveSessions(), serverTime: Date.now() });
});

app.get('/recordings/live/:producerId', (req, res) => {
  const producerId = String(req.params.producerId || '');
  const live = recording.resolveLiveFile(producerId);
  if (!live) return res.status(404).json({ error: 'live session not found' });

  res.writeHead(200, {
    'Content-Type': live.mime,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });

  let position = 0;
  let closed = false;
  let idleTicks = 0;
  req.on('close', () => { closed = true; });

  const pump = () => {
    if (closed) return;
    fs.stat(live.filePath, (err, stat) => {
      if (closed) return;
      if (err) { res.end(); return; }
      if (stat.size > position) {
        idleTicks = 0;
        const stream = fs.createReadStream(live.filePath, { start: position, end: stat.size - 1 });
        position = stat.size;
        stream.pipe(res, { end: false });
        stream.on('end', () => setTimeout(pump, 500));
        stream.on('error', () => res.end());
        return;
      }
      // 書き込みが進んでいない: セグメント切替/セッション終了なら閉じる(クライアントが再接続)
      const current = recording.resolveLiveFile(producerId);
      if (!current || current.filePath !== live.filePath) { res.end(); return; }
      idleTicks += 1;
      if (idleTicks > 60) { res.end(); return; } // 30秒無更新(RTP停滞)は一旦切る
      setTimeout(pump, 500);
    });
  };
  pump();
});

app.get('/recordings/media/:id', (req, res) => {
  const abs = recording.resolveMediaPath(String(req.params.id || ''));
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'segment not found' });
  // sendFile は Range リクエストに対応しており、タイムラインのシークに必要
  res.sendFile(abs, { acceptRanges: true, dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
});

app.get('/health', (_, res) => res.json(getStatsSnapshot()));
app.get('/ready', (_, res) => {
  const ready = !!router && workers.length > 0 && !recovering;
  res.status(ready ? 200 : 503).json({ ready, recovering, workers: workers.length });
});
// クライアントのサーバー選択用: 実際に接続中の拠点数を軽量に返す。
// フェイルオーバー/再接続時に「他拠点が接続している方のサーバー」へ寄せることで、
// 復旧タイミングの差で拠点がメイン/サブへ散らばる(お互いが見えない)のを防ぐ。
app.get('/presence', (_, res) => {
  let clientCount = 0;
  let clientAppCount = 0;
  let screenAppCount = 0;
  const locations = [];
  const now = Date.now();
  for (const peer of Object.values(peers)) {
    if (!peer.socket?.connected || !peer.metadataReady) continue;
    const appType = peer.appType || 'client';
    if (appType !== 'client' && appType !== 'screen-share') continue;
    // 回線断直後で pingTimeout 待ちのゾンビ接続（heartbeatが古い）は数えない。
    // これを数えると、同時に再起動した拠点同士が互いの旧セッションを見て
    // 別サーバーへ移り合う誤判定の原因になる（DUPLICATE_ACTIVE_KEEP_MS と同じ鮮度基準）。
    if (peer.lastHeartbeatAt && now - peer.lastHeartbeatAt > DUPLICATE_ACTIVE_KEEP_MS) continue;
    clientCount += 1;
    if (appType === 'client') clientAppCount += 1;
    else screenAppCount += 1;
    if (locations.length < 32) locations.push(peer.locationName);
  }
  res.json({
    ok: true,
    clientCount,
    // 会議アプリ(client)のみの数。サーバー選択は「会議アプリが居る方へ寄せる」判定に
    // こちらを使う（screen-share を拠点と数えると空の会議室へ寄ってしまうため）。
    clientAppCount,
    screenAppCount,
    locations,
    ready: !!router && workers.length > 0 && !recovering,
    uptimeSec: Math.round(process.uptime()),
    serverTime: Date.now(),
  });
});

function sendAdminLog(message) {
  if (process.send) safeProcessSend({ type: 'admin-log', data: message });
  else console.log(message);
}

function emitRestartCommand(target, recipientCount, reason, extra = {}) {
  const issuedAt = Date.now();
  const payload = { issuedAt, reason, ...extra };

  sendAdminLog(`[Admin] restartCommand requested reason=${reason} recipients=${recipientCount}`);
  if (recipientCount === 0) return;

  target.timeout(RESTART_ACK_TIMEOUT_MS).emit('restartCommand', payload, (err, responses = []) => {
    const acknowledged = Array.isArray(responses) ? responses.length : (responses ? 1 : 0);
    const timedOut = err ? Math.max(recipientCount - acknowledged, 0) : 0;
    const elapsedMs = Date.now() - issuedAt;
    const suffix = timedOut > 0 ? ` timeout=${timedOut}` : '';
    sendAdminLog(`[Admin] restartCommand ack=${acknowledged}/${recipientCount}${suffix} elapsed=${elapsedMs}ms`);
  });
}

function durableSystemStateForStorage() {
  return {
    channels: sanitizeChannels(systemState.channels),
    latestVersions: { ...systemState.latestVersions },
    updatePackages: { ...systemState.updatePackages },
    maintenance: sanitizeMaintenance(systemState.maintenance),
    updatedAt: systemState.updatedAt,
  };
}

function applySystemStatePatch(patch, source = 'server') {
  systemState = sanitizeSystemStatePatch(patch);
  for (const [socketId, peer] of Object.entries(peers)) {
    const previousChannelId = peer.channelId;
    peer.channelId = normalizeChannelId(peer.channelId);
    if (previousChannelId !== peer.channelId) emitPeerChannelChanged(socketId, peer);
    emitSelfSystemState(socketId, peer);
  }
  const snapshot = broadcastSystemState();
  if (source !== 'server-gui') {
    safeProcessSend({
      type: 'system-state-changed',
      source,
      state: durableSystemStateForStorage(),
    });
  }
  sendAdminLog(`[Admin] systemState updated source=${source} channels=${snapshot.channels.length}`);
  return snapshot;
}

function emitUpdateCommand(target, recipientCount, appType, { forced = false, reason = 'server-gui' } = {}) {
  const type = shortString(appType, 24);
  const rawPackage = systemState.updatePackages[type] || null;
  const packageInfo = rawPackage ? { ...rawPackage, url: resolveUpdateUrl(rawPackage.url) } : null;
  const version = systemState.latestVersions[type] || packageInfo?.version || '';
  const payload = {
    appType: type,
    brand: SYSTEM_NAME,
    version,
    packageInfo,
    forced: !!forced,
    reason,
    issuedAt: Date.now(),
  };

  sendAdminLog(`[Admin] updateCommand requested appType=${type || 'all'} forced=${!!forced} recipients=${recipientCount}`);
  if (recipientCount === 0) return;

  target.timeout(RESTART_ACK_TIMEOUT_MS).emit('updateCommand', payload, (err, responses = []) => {
    const acknowledged = Array.isArray(responses) ? responses.length : (responses ? 1 : 0);
    const timedOut = err ? Math.max(recipientCount - acknowledged, 0) : 0;
    const suffix = timedOut > 0 ? ` timeout=${timedOut}` : '';
    sendAdminLog(`[Admin] updateCommand ack=${acknowledged}/${recipientCount}${suffix}`);
  });
}

function emitTargetCommand(socketId, eventName, payload, label) {
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) {
    sendAdminLog(`[Admin] ${label} failed: client not connected socket=${socketId}`);
    return;
  }

  const issuedAt = Date.now();
  socket.timeout(RESTART_ACK_TIMEOUT_MS).emit(eventName, payload || {}, (err, response) => {
    const elapsedMs = Date.now() - issuedAt;
    if (err || response?.error) {
      sendAdminLog(`[Admin] ${label} failed socket=${socketId} error=${response?.error || err.message} elapsed=${elapsedMs}ms`);
      return;
    }
    sendAdminLog(`[Admin] ${label} ok socket=${socketId} elapsed=${elapsedMs}ms`);
  });
}

// ── 呼び出しライフサイクル ────────────────────────────────
// 発信側が「呼び出し中」状態を表示できるよう、応答(answered)・拒否(dismissed)・
// キャンセル(cancelled)・タイムアウト(timeout)・切断(disconnected)を発信元へ通知する。
const pendingCalls = new Map(); // callId → { fromSocketId, targetSocketId, timer, privateChannelId }
const CALL_PENDING_TIMEOUT_MS = 30000;

function finishCall(callId, action, { notifyCaller = true, notifyTarget = false } = {}) {
  const call = pendingCalls.get(callId);
  if (!call) return null;
  clearTimeout(call.timer);
  pendingCalls.delete(callId);

  if (notifyCaller && call.fromSocketId) {
    io.sockets.sockets.get(call.fromSocketId)?.emit('callResult', {
      callId,
      action,
      targetSocketId: call.targetSocketId,
      serverTime: Date.now(),
    });
  }
  if (notifyTarget) {
    io.sockets.sockets.get(call.targetSocketId)?.emit('callCancelled', { callId, serverTime: Date.now() });
  }
  cleanupFailedPrivateCall(call, action);
  sendAdminLog(`[Call] finished callId=${callId} action=${action}`);
  return call;
}

function finishCallsForSocket(socketId) {
  for (const [callId, call] of pendingCalls) {
    if (call.targetSocketId === socketId) {
      // 着信側が落ちた: 発信側へ通知して鳴動表示を止める
      finishCall(callId, 'disconnected');
    } else if (call.fromSocketId === socketId) {
      // 発信側が落ちた: 着信側の鳴動を止める
      finishCall(callId, 'cancelled', { notifyCaller: false, notifyTarget: true });
    }
  }
}

function emitIncomingCall(socketId, payload, source = 'server') {
  const targetPeer = peers[socketId];
  if (!targetPeer?.socket) {
    sendAdminLog(`[Call] failed source=${source} target=${socketId} error=client not connected`);
    return { ok: false, error: 'client not connected' };
  }

  const issuedAt = Date.now();
  const sourcePeer = payload.fromSocketId ? peers[payload.fromSocketId] : null;
  const rawFromChannelId = stableId(payload.fromChannelId || sourcePeer?.channelId, '');
  const fromChannel = rawFromChannelId
    ? getAllChannels().find(channel => channel.id === rawFromChannelId)
    : null;
  const callPayload = {
    callId: shortString(payload.callId || `call-${issuedAt}-${Math.random().toString(36).slice(2, 8)}`, 80),
    fromSocketId: shortString(payload.fromSocketId, 128),
    fromName: shortString(payload.fromName || '呼び出し', 128),
    fromAppType: shortString(payload.fromAppType || 'client', 24),
    fromChannelId: fromChannel?.id || '',
    fromChannelName: fromChannel?.name || '',
    callMode: payload.privateChannelId ? 'private' : 'channel',
    privateChannelId: shortString(payload.privateChannelId, 80),
    targetSocketId: socketId,
    targetName: targetPeer.locationName,
    serverTime: issuedAt,
  };

  // 応答待ちとして登録（旧クライアントが callAck を返さなくてもタイムアウトで確実に終了する）
  pendingCalls.set(callPayload.callId, {
    fromSocketId: callPayload.fromSocketId || '',
    targetSocketId: socketId,
    privateChannelId: callPayload.privateChannelId || '',
    privateCreatedForCall: !!payload.privateCreatedForCall,
    timer: setTimeout(() => finishCall(callPayload.callId, 'timeout'), CALL_PENDING_TIMEOUT_MS),
  });

  targetPeer.socket.timeout(RESTART_ACK_TIMEOUT_MS).emit('incomingCall', callPayload, (err, response) => {
    const elapsedMs = Date.now() - issuedAt;
    if (err || response?.error) {
      sendAdminLog(`[Call] delivery uncertain source=${source} target=${socketId} error=${response?.error || err.message} elapsed=${elapsedMs}ms`);
      return;
    }
    sendAdminLog(`[Call] delivered source=${source} target=${socketId} from=${callPayload.fromSocketId || callPayload.fromAppType} elapsed=${elapsedMs}ms`);
  });

  return { ok: true, call: callPayload };
}

/**
 * 拠点のサーバー通信安定度を0-5で算出する（クライアントのアンテナ表示用）。
 * telemetry RTT の平均とジッタ、ハートビート鮮度から求める。
 *   5=非常に良好 / 4=良好 / 3=普通 / 2=不安定 / 1=非常に不安定 / 0=切断
 */
function signalLevelFor(peer, now = Date.now()) {
  if (!peer?.socket?.connected) return 0;
  const heartbeatAge = peer.lastHeartbeatAt ? now - peer.lastHeartbeatAt : null;
  if (heartbeatAge == null) return 3;       // telemetry未着（起動直後など）
  if (heartbeatAge > 15000) return 1;       // ハートビートが途絶え気味
  const quality = connectionQuality(peer);
  if (quality.level === 'unknown') return 3;
  const avg = quality.avgRttMs ?? 0;
  const jitter = quality.jitterMs ?? 0;
  if (avg <= 50 && jitter <= 15) return 5;
  if (avg <= 120 && jitter <= 40) return 4;
  if (avg <= 250 && jitter <= 90) return 3;
  if (avg <= 500) return 2;
  return 1;
}

/** 受信画質(low/medium/high)を simulcast の空間レイヤ(0/1/2)に変換する */
function recvQualityToSpatialLayer(quality) {
  if (quality === 'low') return 0;
  if (quality === 'medium') return 1;
  return 2;
}

function normalizeMediaStateKind(kind) {
  const value = shortString(kind, 32);
  if (value === 'camera' || value === 'video') return 'camera';
  if (value === 'mic' || value === 'microphone' || value === 'audioInput') return 'mic';
  if (value === 'speaker' || value === 'audioOutput') return 'speaker';
  return '';
}

function computeViewerPresence(now = Date.now()) {
  const activeTargets = new Set();

  for (const [viewerId, peer] of Object.entries(peers)) {
    const appType = peer.appType || peer.telemetry?.appType;
    if (appType !== 'viewer') continue;
    if (!peer.lastHeartbeatAt || now - peer.lastHeartbeatAt > 10000) continue;

    const monitorPeers = peer.monitorState?.remoteMonitor?.peers || [];
    for (const item of monitorPeers) {
      const targetId = shortString(item?.socketId, 128);
      if (!targetId || targetId === viewerId) continue;
      if (peers[targetId]) activeTargets.add(targetId);
    }
  }

  return activeTargets;
}

function broadcastViewerPresence() {
  const activeTargets = computeViewerPresence();

  for (const [socketId, peer] of Object.entries(peers)) {
    const appType = peer.appType || peer.telemetry?.appType;
    if (appType === 'viewer') continue;

    const active = activeTargets.has(socketId);
    if (peer.viewerPresenceActive === active) continue;
    peer.viewerPresenceActive = active;
    peer.socket.emit('viewerPresence', { active, serverTime: Date.now() });
  }
}

function recoverTelemetryMissingPeers(now = Date.now()) {
  if (!TELEMETRY_AUTO_RESTART) return;
  for (const [socketId, peer] of Object.entries(peers)) {
    const appType = peer.appType || peer.telemetry?.appType || 'client';
    if (!['client', 'viewer', 'screen-share'].includes(appType)) continue;
    if (!peer.socket?.connected || !peer.metadataReady) continue;

    const connectedAge = now - (peer.connectedAt || now);
    const heartbeatAge = peer.lastHeartbeatAt ? now - peer.lastHeartbeatAt : null;
    const missingInitialTelemetry = !peer.lastHeartbeatAt && connectedAge >= TELEMETRY_MISSING_RESTART_MS;
    const staleTelemetry = heartbeatAge != null && heartbeatAge >= TELEMETRY_STALE_RESTART_MS;
    if (!missingInitialTelemetry && !staleTelemetry) continue;

    const sinceLastRestart = now - (peer.telemetryRecoveryAt || 0);
    if (sinceLastRestart < TELEMETRY_RESTART_COOLDOWN_MS) continue;

    peer.telemetryRecoveryAt = now;
    const reason = missingInitialTelemetry
      ? `telemetry-missing:${socketId}`
      : `telemetry-stale:${socketId}`;
    sendAdminLog(`[Recovery] restartCommand ${reason} name=${peer.locationName} appType=${appType} connectedAge=${connectedAge} heartbeatAge=${heartbeatAge ?? 'none'}`);
    emitRestartCommand(peer.socket, 1, reason);
  }
}

const viewerPresenceTimer = setInterval(broadcastViewerPresence, 2000);
viewerPresenceTimer.unref?.();
// 切断猶予(仮セッション)の期限掃除
const graceSweepTimer = setInterval(() => sweepDisconnectedPeers(), 10000);
graceSweepTimer.unref?.();
const telemetryRecoveryTimer = setInterval(recoverTelemetryMissingPeers, 5000);
telemetryRecoveryTimer.unref?.();

// ── リソースしきい値監視（ジワジワ型のメモリ/ポート枯渇への予防対応）─────────
// 長時間稼働でメモリやRTCポートが枯渇するとOSごとフリーズし遠隔復旧できなくなる。
// クラッシュ(急死)には自動再起動があるが、ジワジワ型には反応しないため、
// しきい値を超えた時点で警告し、監視下(server-gui等の自動再起動あり)なら
// 接続数が実質空になるのを待たず予防的にプロセスを再起動して回収する。
//   MEM_WARN_MB=1200 / MEM_RESTART_MB=2200 (0で無効) / RESOURCE_CHECK_MS=60000
const RESOURCE_CHECK_MS = Number(process.env.RESOURCE_CHECK_MS) || 60000;
const MEM_WARN_MB = Number(process.env.MEM_WARN_MB ?? 1200);
const MEM_RESTART_MB = Number(process.env.MEM_RESTART_MB ?? 2200);
let resourceWarnedAt = 0;

function checkResourcePressure() {
  const now = Date.now();
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const warnOk = now - resourceWarnedAt >= 300000; // 警告は5分に1回まで

  // RTCポート範囲の逼迫（固定ポートモード時は対象外）。transport 1つにつき
  // announced IP の数だけポートを消費するため、リークや拠点増で枯渇しうる。
  if (!config.rtcPort && warnOk) {
    let transportCount = 0;
    for (const peer of Object.values(peers)) transportCount += peer.transports.size;
    const capacity = config.rtcPortRange.max - config.rtcPortRange.min + 1;
    const used = transportCount * Math.max(1, (config.announcedIps || []).length);
    if (used >= capacity * 0.8) {
      resourceWarnedAt = now;
      sendAdminLog(`[Resource] RTCポート範囲が逼迫しています: 推定使用 ${used}/${capacity}。RTC_PORT(固定ポート)への移行かポート範囲の拡大を検討してください`);
    }
  }

  if (MEM_RESTART_MB > 0 && rssMb >= MEM_RESTART_MB) {
    if (process.send) {
      sendAdminLog(`[Resource] メモリ使用量 ${rssMb}MB がしきい値 ${MEM_RESTART_MB}MB を超過。予防再起動します（自動再起動で復帰）`);
      shutdown('memory-pressure');
    } else if (warnOk) {
      resourceWarnedAt = now;
      console.warn(`[Resource] メモリ使用量 ${rssMb}MB がしきい値 ${MEM_RESTART_MB}MB を超過していますが、監視プロセスが無いため自動再起動しません`);
    }
    return;
  }
  if (MEM_WARN_MB > 0 && rssMb >= MEM_WARN_MB && warnOk) {
    resourceWarnedAt = now;
    sendAdminLog(`[Resource] メモリ使用量が増加しています: ${rssMb}MB (警告しきい値 ${MEM_WARN_MB}MB)`);
  }
}

const resourceTimer = setInterval(checkResourcePressure, RESOURCE_CHECK_MS);
resourceTimer.unref?.();

// ── ルーティン再起動（サーバー）───────────────────────────
// 指定時刻(HH:MM、複数可)にサーバープロセスを計画再起動する。長時間稼働による
// ネイティブリソースの肥大・断片化を、障害になる前に定期的にリセットする目的。
// server-gui の監視下では終了後に自動で再起動される。監視プロセスが無い
// スタンドアロン起動では、exit すると復帰できないため既定ではスキップする
// (systemd/pm2 等の管理下なら ROUTINE_RESTART_STANDALONE=1 で有効化)。
const ROUTINE_RESTART_CHECK_MS = 15000;
// 起動直後の抑制: 再起動して戻ってきた直後に同じ時刻へ再一致して
// 再起動ループになるのを防ぐ(時刻窓は1分、復帰は数秒のため5分で十分)
const ROUTINE_RESTART_MIN_UPTIME_SEC = Number(process.env.ROUTINE_RESTART_MIN_UPTIME_SEC) || 300;
let lastRoutineRestartKey = '';

function currentHhmm(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function checkServerRoutineRestart() {
  if (recovering) return;
  const times = systemState.maintenance?.serverRestartTimes || [];
  if (!times.length) return;
  const now = new Date();
  const hhmm = currentHhmm(now);
  if (!times.includes(hhmm)) return;
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${hhmm}`;
  if (lastRoutineRestartKey === key) return;
  lastRoutineRestartKey = key;

  if (process.uptime() < ROUTINE_RESTART_MIN_UPTIME_SEC) return;
  const supervised = !!process.send;
  if (!supervised && !/^(1|true|yes|on)$/i.test(process.env.ROUTINE_RESTART_STANDALONE || '')) {
    sendAdminLog(`[Maintenance] ルーティン再起動時刻(${hhmm})ですが、監視プロセスが無いためスキップします(server-gui配下で起動するか ROUTINE_RESTART_STANDALONE=1 を設定してください)`);
    return;
  }
  sendAdminLog(`[Maintenance] ルーティン再起動を実行します (${hhmm})。終了後は自動的に復帰し、各拠点は自動再接続します`);
  shutdown('routine-restart');
}

const routineRestartTimer = setInterval(checkServerRoutineRestart, ROUTINE_RESTART_CHECK_MS);
routineRestartTimer.unref?.();

// ── メディアフロー監視（上りRTPが実際に届いているかの確認と自動復旧）─────────

async function sampleProducerInboundBytes(producer) {
  const stats = await producer.getStats();
  let bytes = 0;
  for (const item of stats) {
    if (item.type === 'inbound-rtp') bytes += Number(item.byteCount) || 0;
  }
  return bytes;
}

/** consumer(下りRTP)の送信済みバイト数を取得する */
async function sampleConsumerOutboundBytes(consumer) {
  const stats = await consumer.getStats();
  let bytes = 0;
  for (const item of stats) {
    if (item.type === 'outbound-rtp') bytes += Number(item.byteCount) || 0;
  }
  return bytes;
}

/**
 * 拠点をTCPメディアへ切り替える。UTM/FW設置拠点で UDP(STUN/DTLS/SRTP)が
 * 遮断されている場合、以降この拠点の transport はTCP候補のみを提示する。
 * mediasoup-client はサーバーの候補に従うため、クライアント側の設定変更は不要。
 */
function markTcpFallback(socketId, peer, reason) {
  if (!MEDIA_TCP_FALLBACK || peer.forceTcp) return false;
  peer.forceTcp = true;
  if (peer.instanceId) {
    // 同じ端末で再発した場合はTTLを4倍に延長する(最大7日)。UTM側の設定が
    // 入らない限りUDPは何度試しても失敗するため、期限切れごとの
    // 「UDP再試行→失敗→再切替」の断を段階的に減らす。
    const previous = tcpFallbackInstances.get(peer.instanceId);
    const ttlMs = previous
      ? Math.min((previous.ttlMs || TCP_FALLBACK_TTL_MS) * 4, TCP_FALLBACK_TTL_MAX_MS)
      : TCP_FALLBACK_TTL_MS;
    tcpFallbackInstances.set(peer.instanceId, { at: Date.now(), ttlMs });
    saveServerState();
  }
  sendAdminLog(`[Recovery] TCP fallback name=${peer.locationName} socket=${socketId} reason=${reason} (UDPメディア不達のためこの拠点はTCPで中継します)`);
  return true;
}

/** 停滞を検出したピアへの復旧指示（クールダウン+無限リトライ+最終手段のアプリ再起動） */
function recoverStalledPeer(socketId, peer, stalledKinds, now) {
  if (now - (peer.mediaStallRecoveryAt || 0) < MEDIA_STALL_COOLDOWN_MS) return;
  peer.mediaStallRecoveryAt = now;
  peer.mediaStallStrikes = (peer.mediaStallStrikes || 0) + 1;
  // セッションは仮で残したまま復旧中フラグを立て、全拠点へ配信する
  // （本人=中央スピナー、他拠点=タイルに「サーバー接続中」表示）。
  setPeerRecovering(socketId, peer, true, `media-stalled:${stalledKinds.join(',')}`);

  // UDPのまま停滞を繰り返す拠点は、再構築の前にTCP中継へ切り替える
  // （UTM等でUDPが選別遮断される拠点では、貼り直しだけ繰り返しても復旧しない）
  if (peer.mediaStallStrikes >= TCP_FALLBACK_AFTER_STRIKES) {
    markTcpFallback(socketId, peer, `media-stalled-strike${peer.mediaStallStrikes}`);
  }

  // 受信確認が取れるまでセッション貼り直しを繰り返す（回数上限なし）。
  // それでも MEDIA_RECOVERY_RELAUNCH_MS 連続で復旧しない場合のみ、
  // 最終手段としてクライアントアプリ本体の再起動(mode:relaunch)を指示する。
  const recoveringFor = now - (peer.mediaRecoveringSince || now);
  if (recoveringFor >= MEDIA_RECOVERY_RELAUNCH_MS) {
    peer.mediaRecoveringSince = now; // 再指示は次の周期(5分後)まで抑制
    sendAdminLog(`[Recovery] media-recovery timeout name=${peer.locationName} (${Math.round(recoveringFor / 1000)}s) → app relaunch`);
    emitRestartCommand(peer.socket, 1, `media-recovery-timeout:${socketId}`, { mode: 'relaunch' });
    return;
  }

  sendAdminLog(`[Recovery] media-stalled name=${peer.locationName} kinds=${stalledKinds.join(',')} strike=${peer.mediaStallStrikes} → session rebuild`);
  // サーバー側の古い transport/producer を破棄してから作り直させる。
  // 生かしたままだとクライアントの再構築後も停滞した経路が残り続ける。
  resetPeerMedia(peer);
  peer.socket.emit('mediaLayerRestarted');
}

let mediaFlowCheckRunning = false;
async function checkMediaFlow(now = Date.now()) {
  if (!MEDIA_STALL_RECOVERY || recovering || mediaFlowCheckRunning) return;
  mediaFlowCheckRunning = true;
  try {
    // ── フェーズ1: 上り(producer)。サーバーが各拠点から実際にRTPを受信できているか ──
    // このtickでバイト増加が確認できた producerId の集合。フェーズ2で
    // 「上りは届いているのに下りが止まっている」判定に使う。
    const flowingProducers = new Set();
    const stalledByPeer = new Map(); // socketId → string[]
    // 生きている全 producer の所有者索引（フェーズ2の受信報告突き合わせ・中継照合用）
    const producerOwners = new Map(); // producerId → { ownerId, ownerPeer, entry }
    // このtickで実RTPの進行（バイト増加）を確認できた拠点。復旧中フラグの解除判定に使う
    const peerSawFlow = new Set();
    // このtickでDTLSが確立している拠点（アクティブなメディアが無い場合の解除判定用）
    const peerDtlsConnected = new Set();
    // このtickでフロー計測対象（非pauseのproducer/consumer）があった拠点
    const peerHadSampleTargets = new Set();

    for (const [socketId, peer] of Object.entries(peers)) {
      if (!peer.socket?.connected || !peer.metadataReady) continue;

      // ── フェーズ0: DTLSが確立しない拠点の検出（UDP遮断・UTM設置拠点の典型）──
      // シグナリング(connectTransport)までは届いているのに、メディアの
      // STUN/DTLS だけが確立しない場合、UTM/FWによるUDP遮断が濃厚。
      // TCP中継へ切り替えたうえで、確立するまでセッション貼り直しを繰り返させる。
      {
        let anyConnected = false;
        let pendingSince = null;
        for (const transport of peer.transports.values()) {
          if (transport.closed) continue;
          if (transport.dtlsState === 'connected') { anyConnected = true; break; }
          const requestedAt = transport.appData?.connectRequestedAt;
          if (requestedAt && (!pendingSince || requestedAt < pendingSince)) pendingSince = requestedAt;
        }
        if (anyConnected) peerDtlsConnected.add(socketId);
        if (!anyConnected && pendingSince && now - pendingSince >= TCP_FALLBACK_CONNECT_MS) {
          markTcpFallback(socketId, peer, `dtls-never-connected:${Math.round((now - pendingSince) / 1000)}s`);
          setPeerRecovering(socketId, peer, true, 'dtls-not-connected');
          const recoveringFor = now - (peer.mediaRecoveringSince || now);
          if (recoveringFor >= MEDIA_RECOVERY_RELAUNCH_MS) {
            peer.mediaRecoveringSince = now;
            sendAdminLog(`[Recovery] dtls-recovery timeout name=${peer.locationName} (${Math.round(recoveringFor / 1000)}s) → app relaunch`);
            emitRestartCommand(peer.socket, 1, `media-recovery-timeout:${socketId}`, { mode: 'relaunch' });
          } else if (now - (peer.mediaStallRecoveryAt || 0) >= MEDIA_STALL_COOLDOWN_MS) {
            peer.mediaStallRecoveryAt = now;
            resetPeerMedia(peer);
            peer.socket.emit('mediaLayerRestarted');
          }
          continue;
        }
      }

      const stalledKinds = [];
      for (const [producerId, entry] of peer.producers) {
        const producer = entry.producer;
        if (producer && !producer.closed) {
          producerOwners.set(producerId, { ownerId: socketId, ownerPeer: peer, entry });
        }
        // paused(ミュート等)や閉じた producer はRTPが止まるのが正常。
        // 追跡をリセットしておき、resume 後に停滞時計がゼロから始まるようにする。
        if (!producer || producer.closed || entry.paused || producer.paused) {
          entry.flowBytes = null;
          entry.flowAt = null;
          entry.flowStalled = false;
          continue;
        }
        peerHadSampleTargets.add(socketId);
        let bytes;
        try {
          bytes = await sampleProducerInboundBytes(producer);
        } catch {
          continue; // 取得失敗はスキップ（次周期で再試行）
        }
        if (entry.flowBytes == null || bytes > entry.flowBytes) {
          if (entry.flowBytes != null) peerSawFlow.add(socketId);
          entry.flowBytes = bytes;
          entry.flowAt = now;
          entry.flowStalled = false;
          flowingProducers.add(producerId);
          continue;
        }
        const stalledFor = now - (entry.flowAt || now);
        if (stalledFor >= MEDIA_STALL_RESTART_MS) {
          entry.flowStalled = true;
          stalledKinds.push(`${entry.source || entry.kind}:${Math.round(stalledFor / 1000)}s`);
        }
      }
      if (stalledKinds.length) stalledByPeer.set(socketId, stalledKinds);
    }

    // ── フェーズ2: 下り(consumer)。サーバーが各拠点へ実際にRTPを送出できているか ──
    // 「セッションは接続されているのに映像が真っ暗」の典型例: 上り(producer)は
    // 流れているのに、受信側ピアへの consumer 送出だけが止まっているケースを検出する。
    for (const [socketId, peer] of Object.entries(peers)) {
      if (!peer.socket?.connected || !peer.metadataReady) continue;

      const stalledKinds = stalledByPeer.get(socketId) || [];
      // クライアント側の受信実態（テレメトリの remoteMonitor）。鮮度が無い報告で
      // 誤発火しないよう、直近10秒以内のテレメトリがある場合だけ突き合わせる。
      const heartbeatAge = peer.lastHeartbeatAt ? now - peer.lastHeartbeatAt : null;
      const telemetryFresh = heartbeatAge != null && heartbeatAge <= 10000;
      const reportBySocket = telemetryFresh
        ? new Map((peer.monitorState?.remoteMonitor?.peers || []).map(item => [item.socketId, item]))
        : null;

      for (const consumer of peer.consumers.values()) {
        const tracking = consumer.appData || (consumer.appData = {});
        // paused/producerPaused 中は送出が止まるのが正常。元のproducerが
        // 流れていない場合も、原因は上り側（フェーズ1が回収する）なので対象外。
        if (
          consumer.closed || consumer.paused || consumer.producerPaused ||
          !flowingProducers.has(consumer.producerId)
        ) {
          tracking.flowBytes = null;
          tracking.flowAt = null;
          tracking.flowStalled = false;
          tracking.clientRecvFailAt = null;
          continue;
        }

        // 受信報告との突き合わせ: サーバーは送出しているのに、受信側クライアントが
        // 「このカメラ映像を受け取れていない（トラック無し/mutedのまま）」を報告し
        // 続ける場合、consumer の取りこぼしや経路異常であり、セッションを貼り直す。
        // サーバー側 outbound バイト数は送出量しか示さず、実際にクライアントへ
        // 届いているかはクライアントの報告でしか確認できない。
        if (reportBySocket && consumer.kind === 'video') {
          const owner = producerOwners.get(consumer.producerId);
          const report = owner?.entry?.source === 'camera' ? reportBySocket.get(owner.ownerId) : null;
          if (report && !report.videoPaused) {
            const failing = report.receivingVideo === false || report.video?.muted === true;
            if (!failing) {
              tracking.clientRecvFailAt = null;
            } else if (!tracking.clientRecvFailAt) {
              tracking.clientRecvFailAt = now;
            } else if (now - tracking.clientRecvFailAt >= CLIENT_RECV_STALL_MS) {
              stalledKinds.push(`client-no-video:${Math.round((now - tracking.clientRecvFailAt) / 1000)}s`);
            }
          }
        }

        peerHadSampleTargets.add(socketId);
        let bytes;
        try {
          bytes = await sampleConsumerOutboundBytes(consumer);
        } catch {
          continue;
        }
        if (tracking.flowBytes == null || bytes > tracking.flowBytes) {
          if (tracking.flowBytes != null) peerSawFlow.add(socketId);
          tracking.flowBytes = bytes;
          tracking.flowAt = now;
          tracking.flowStalled = false;
          continue;
        }
        const stalledFor = now - (tracking.flowAt || now);
        if (stalledFor >= MEDIA_STALL_RESTART_MS) {
          tracking.flowStalled = true;
          stalledKinds.push(`recv-${consumer.kind}:${Math.round(stalledFor / 1000)}s`);
        }
      }

      // ── 中継の確実化: サーバーが受信している全 producer を、この拠点が漏れなく
      // consume しているかを照合する。newProducer の取りこぼしや consume の連続失敗で
      // 「他拠点のカメラが1枠だけ映らない」状態が固定化するのを防ぐ。
      // まず newProducer を再通知（クライアントは重複consumeを自前で防ぐ）し、
      // それでも消費されなければセッション貼り直しへエスカレーションする。
      if ((peer.appType || 'client') === 'client' && telemetryFresh && peer.transports.size > 0) {
        const consumed = new Set();
        for (const consumer of peer.consumers.values()) {
          if (!consumer.closed) consumed.add(consumer.producerId);
        }
        const missing = peer.missingConsumers || (peer.missingConsumers = new Map());
        for (const [producerId, { ownerId, ownerPeer, entry }] of producerOwners) {
          if (ownerId === socketId) continue;
          if (consumed.has(producerId)) {
            missing.delete(producerId);
            continue;
          }
          let track = missing.get(producerId);
          if (!track) {
            track = { since: now, lastNudgeAt: 0 };
            missing.set(producerId, track);
          }
          const missingFor = now - track.since;
          if (missingFor >= CONSUME_MISSING_REBUILD_MS) {
            stalledKinds.push(`no-consume-${entry.kind}:${Math.round(missingFor / 1000)}s`);
          } else if (missingFor >= CONSUME_MISSING_NUDGE_MS && now - track.lastNudgeAt >= CONSUME_MISSING_NUDGE_MS) {
            track.lastNudgeAt = now;
            sendAdminLog(`[Relay] re-announce producer=${producerId.slice(0, 8)} kind=${entry.kind} from=${ownerPeer.locationName} to=${peer.locationName}`);
            peer.socket.emit('newProducer', {
              producerId,
              socketId: ownerId,
              locationName: ownerPeer.locationName,
              kind: entry.kind,
              paused: !!entry.paused,
              source: entry.source,
              appData: entry.appData,
              channelId: entry.channelId,
              appType: ownerPeer.appType,
            });
          }
        }
        // 閉じられた producer の追跡エントリを掃除
        for (const producerId of missing.keys()) {
          if (!producerOwners.has(producerId)) missing.delete(producerId);
        }
      }

      if (!stalledKinds.length) {
        // 上り・下りとも健全 → TCP切替判定用の連続停滞カウントをリセット
        if (peer.producers.size > 0 || peer.consumers.size > 0) peer.mediaStallStrikes = 0;
        // 復旧確認: 停滞ゼロ + 実RTPの進行（メディアが全て停止中の拠点はDTLS確立）を
        // 確認できたら「復旧中」を解除し、全拠点のタイル表示を通常へ戻す。
        if (peer.mediaRecovering && !peer.socketDisconnectedAt) {
          const flowConfirmed = peerSawFlow.has(socketId) ||
            (!peerHadSampleTargets.has(socketId) && peerDtlsConnected.has(socketId));
          if (flowConfirmed) setPeerRecovering(socketId, peer, false, 'media-flow-confirmed');
        }
        continue;
      }
      recoverStalledPeer(socketId, peer, stalledKinds, now);
    }
  } finally {
    mediaFlowCheckRunning = false;
  }
}

const mediaFlowTimer = setInterval(() => {
  checkMediaFlow().catch(err => console.error('[MediaFlow]', err));
}, MEDIA_STALL_CHECK_MS);
mediaFlowTimer.unref?.();

// ── Transport ─────────────────────────────────────────────

async function createWebRtcTransport(router, forceTcp = false, peer = null) {
  const { listenIps, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport;
  // クライアントの要求(forceTcp)・サーバー設定(FORCE_TCP/PREFER_TCP)・
  // 拠点単位の自動TCPフォールバック(peer.forceTcp)を合成する。
  // いずれかがTCPを要求すればTCPで伝送する（映像・音声・画面共有すべて）。
  const tcpOnly = forceTcp || !!peer?.forceTcp || !!config.mediaTransport?.forceTcp;
  const preferTcp = tcpOnly || !!config.mediaTransport?.preferTcp;
  const options = {
    enableUdp: !tcpOnly,
    enableTcp: true,
    preferUdp: !preferTcp,
    preferTcp,
    initialAvailableOutgoingBitrate,
  };
  // RTC_PORT 固定ポートモードでは WebRtcServer に集約、従来はポート範囲から動的割当
  if (webRtcServer && !webRtcServer.closed) options.webRtcServer = webRtcServer;
  else options.listenIps = listenIps;
  const transport = await router.createWebRtcTransport(options);
  transport.on('dtlsstatechange', state => { if (state === 'closed') transport.close(); });

  // ICEが disconnected のまま一定時間復帰しなければ強制クローズする。
  // クライアントの再接続/自己回復に任せることで、劣化経路で残り続ける
  // transport によるポート/メモリの永久占有を防ぐ。
  let iceDisconnectTimer = null;
  transport.on('icestatechange', state => {
    if (state === 'disconnected') {
      if (iceDisconnectTimer) return;
      iceDisconnectTimer = setTimeout(() => {
        iceDisconnectTimer = null;
        if (!transport.closed) transport.close();
      }, ICE_DISCONNECTED_CLOSE_MS);
    } else if (iceDisconnectTimer) {
      clearTimeout(iceDisconnectTimer);
      iceDisconnectTimer = null;
    }
  });

  transport.on('close', () => {
    if (iceDisconnectTimer) { clearTimeout(iceDisconnectTimer); iceDisconnectTimer = null; }
    peer?.transports.delete(transport.id);
    console.log('[Transport] closed');
  });
  return transport;
}

// ── Socket.io ────────────────────────────────────────────

io.on('connection', async socket => {
  console.log(`[+] connect  ${socket.id}`);

  peers[socket.id] = {
    socket,
    locationName: '接続中...',
    appType: 'client',
    appVersion: '',
    channelId: DEFAULT_CHANNELS[0].id,
    metadataReady: false,
    instanceId: '',
    forceTcp: false,   // 自動TCPフォールバック（UDP遮断拠点）
    recvQuality: 'high',
    presenceMode: 'none',
    connectedAt: Date.now(),
    lastHeartbeatAt: null,
    telemetryRecoveryAt: 0,
    mediaStallRecoveryAt: 0,
    mediaStallStrikes: 0,
    mediaRecovering: false,   // 復旧中（本人=スピナー、他拠点=「サーバー接続中」表示）
    mediaRecoveringSince: 0,
    socketDisconnectedAt: null, // 切断猶予(仮セッション)の開始時刻
    suppressGrace: false,       // 置き換え/明示切断: 仮セッションを残さない
    rttMs: null,
    rttHistory: [],
    telemetry: null,
    deviceState: { devices: { video: [], audioInput: [], audioOutput: [] }, selectedDevices: {} },
    monitorState: {},
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    viewerPresenceActive: false,
  };

  // ── 拠点名の設定 ──
  socket.on('setMetadata', (metadata = {}) => {
    const { locationName, appType, channelId, appVersion, instanceId } = asObject(metadata);
    if (peers[socket.id]) {
      const peer = peers[socket.id];
      const isFirstMetadata = !peer.metadataReady;
      peer.locationName = shortString(locationName || '不明', 128);
      if (appType) peer.appType = shortString(appType, 24);
      if (appVersion) peer.appVersion = shortString(appVersion, 48);
      if (channelId) {
        const requestedChannelId = normalizeChannelId(channelId);
        const privateSession = privateSessions.get(requestedChannelId);
        peer.channelId = privateSession && !privateSession.members.has(socket.id)
          ? fallbackChannelId()
          : requestedChannelId;
      }

      // 同一クライアントインスタンス(端末)からの重複セッションを排除する。
      // レンダラークラッシュや瞬断後の再接続では、古いソケットがpingタイムアウト
      // まで生き残り「同じ拠点が二重にいる」状態になる。instanceId はクライアント
      // 端末ごとに永続で、同じIDの古いセッションは新しい接続で即時置き換える。
      const cleanInstanceId = shortString(instanceId || '', 64);
      if (cleanInstanceId) peer.instanceId = cleanInstanceId;
      // この端末が過去にTCPフォールバック済みなら再接続・アプリ再起動後も維持する。
      // TTL経過後はUDPを再試行する（遮断が続けば自動で再切替され、TTLが延長される）。
      if (cleanInstanceId && MEDIA_TCP_FALLBACK) {
        const fallback = tcpFallbackInstances.get(cleanInstanceId);
        if (fallback && Date.now() - fallback.at < fallback.ttlMs) {
          peer.forceTcp = true;
        }
      }
      const selfAddress = socket.handshake.address;
      const now = Date.now();
      for (const [otherId, other] of Object.entries(peers)) {
        if (otherId === socket.id) continue;
        const sameInstance = !!cleanInstanceId && other.instanceId === cleanInstanceId;
        // instanceId 未対応のアプリ(旧クライアント/画面共有)やストレージ初期化後でも、
        // 「同一端末(IP)・同一アプリ・同一拠点名」の旧セッションは新しい接続で
        // 置き換える。放置すると古いソケットが ping タイムアウトまで「接続中」の
        // まま残り、同じ拠点が二重に見える・停止した producer へ配信し続ける。
        const sameEndpoint =
          other.appType === peer.appType &&
          peer.locationName && peer.locationName !== '不明' && peer.locationName !== '接続中...' &&
          other.locationName === peer.locationName &&
          other.socket?.handshake?.address === selfAddress;
        if (!sameInstance && !sameEndpoint) continue;

        // 既存セッションが「稼働中」（接続済み+テレメトリが新鮮）なら、置き換えずに
        // 新しい接続の方を拒否する。両方が生きたアプリの場合に置き換え合戦
        // （数秒ごとの相互切断＝再接続の多発）へ陥るのを防ぎ、正規セッションの
        // 常時接続を守る。既存側が実際に死んでいればテレメトリが止まり、
        // DUPLICATE_ACTIVE_KEEP_MS 経過後の再試行で置き換えられる。
        const otherHeartbeatAge = other.lastHeartbeatAt ? now - other.lastHeartbeatAt : null;
        const otherActive = other.socket?.connected &&
          otherHeartbeatAge != null && otherHeartbeatAge <= DUPLICATE_ACTIVE_KEEP_MS;
        if (otherActive) {
          sendAdminLog(`[Session] duplicate ${sameInstance ? 'instance' : 'endpoint'} rejected name=${peer.locationName} existing=${otherId} rejected=${socket.id} (既存セッションが稼働中のため新しい接続を拒否)`);
          peer.suppressGrace = true; // 拒否したセッションは仮セッションを残さない
          socket.emit('sessionRejected', {
            reason: 'duplicate-active-session',
            locationName: other.locationName,
            retryAfterMs: DUPLICATE_REJECT_RETRY_MS,
            serverTime: now,
          });
          // emit がフラッシュされてから切断する
          setTimeout(() => {
            try { socket.disconnect(true); } catch (_) { /* 切断済みなら無視 */ }
          }, 200);
          return;
        }

        sendAdminLog(`[Session] duplicate ${sameInstance ? 'instance' : 'endpoint'} replaced name=${other.locationName} old=${otherId} new=${socket.id}`);
        // 置き換え: 古いセッションは仮セッション(切断猶予)を残さず即座に破棄する。
        // これを怠ると「同じ拠点が別セッションとして接続中のまま残る」状態になる。
        other.suppressGrace = true;
        if (other.socket?.connected) {
          try { other.socket.disconnect(true); } catch (_) { /* 切断済みなら無視 */ }
        } else {
          removePeer(otherId, 'replaced-by-new-session');
        }
      }
      // この拠点の再接続が完了した＝復旧中表示を仮セッションから引き継がない
      peer.socketDisconnectedAt = null;

      peer.metadataReady = true;
      console.log(`[Meta] ${socket.id} → "${locationName}"`);
      if (isFirstMetadata) {
        socket.broadcast.emit('peerJoined', {
          socketId: socket.id,
          locationName: peer.locationName,
          appType: peer.appType,
          channelId: peer.channelId,
          serverTime: Date.now(),
        });
      }
      socket.emit('systemStateUpdated', {
        ...getSystemStateSnapshot(),
        self: {
          socketId: socket.id,
          channelId: peer.channelId,
          appType: peer.appType,
          appVersion: peer.appVersion,
          privateCall: getPrivateCallForSocket(socket.id),
        },
      });
    }
  });

  socket.on('clientTelemetry', (report = {}, callback) => {
    const peer = peers[socket.id];
    if (!peer) return callback?.({ error: 'peer not found' });
    const clean = sanitizeTelemetry(report);

    peer.lastHeartbeatAt = Date.now();
    peer.telemetry = clean;
    peer.appType = clean.appType || peer.appType || 'client';
    peer.appVersion = clean.appVersion || peer.appVersion || '';
    peer.channelId = clean.channelId || peer.channelId || DEFAULT_CHANNELS[0].id;
    if (clean.locationName) peer.locationName = clean.locationName;
    if (Number.isFinite(clean.connection?.telemetryRttMs)) {
      peer.rttMs = Math.round(clean.connection.telemetryRttMs);
      peer.rttHistory.push(peer.rttMs);
      if (peer.rttHistory.length > MAX_RTT_SAMPLES) peer.rttHistory.shift();
    }
    peer.deviceState = {
      devices: clean.devices || peer.deviceState.devices,
      selectedDevices: clean.selectedDevices || peer.deviceState.selectedDevices,
    };
    peer.monitorState = {
      localMedia: clean.localMedia || {},
      remoteMonitor: clean.remoteMonitor || {},
      connection: clean.connection || {},
      transports: clean.transports || {},
      consumers: clean.consumers || [],
    };
    broadcastViewerPresence();
    callback?.({ ok: true, serverTime: Date.now() });
  });

  // ── Router capabilities ──
  socket.on('getRouterRtpCapabilities', (_, callback) => {
    if (!router) return safeCallback(callback, { error: 'router not ready' });
    safeCallback(callback, router.rtpCapabilities);
  });

  // ── サーバー設定（ICE サーバー・ビットレート・TCP設定など）──
  socket.on('getServerConfig', (_, callback) => {
    safeCallback(callback, {
      iceServers: config.iceServers || [],
      mediaSettings: config.mediaSettings || {},
      mediaTransport: config.mediaTransport || {},
      // サーバー録画が有効な間、クライアントはカメラOFFでも送信を継続する
      // (サーバーは配信consumerを止めるため他拠点には映らない)
      recording: { cameraKeepSendingWhenOff: recording.clientShouldKeepSendingCamera() },
    });
  });

  socket.on('getSystemState', (_, callback) => {
    const peer = peers[socket.id];
    safeCallback(callback, {
      ...getSystemStateSnapshot(),
      self: peer ? {
        socketId: socket.id,
        channelId: peer.channelId,
        appType: peer.appType,
        appVersion: peer.appVersion,
        privateCall: getPrivateCallForSocket(socket.id),
      } : null,
    });
  });

  socket.on('setChannel', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const result = setPeerChannel(socket.id, asObject(payload).channelId, `client:${socket.id}`);
    safeCallback(callback, {
      ok: result.ok,
      channelId: result.channelId,
      systemState: getSystemStateSnapshot(),
    });
  });

  socket.on('createChannel', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const name = shortString(asObject(payload).name, 48).trim();
    if (!name) return safeCallback(callback, { error: 'channel name is required' });
    if (systemState.channels.length >= 32) return safeCallback(callback, { error: 'channel limit reached' });

    const existing = systemState.channels.find(channel => channel.name === name);
    if (existing) {
      return safeCallback(callback, {
        ok: true,
        channel: existing,
        systemState: getSystemStateSnapshot(),
      });
    }

    const channel = { id: createUniqueChannelId(name), name };
    const nextChannels = sanitizeChannels([...systemState.channels, channel]);
    const snapshot = applySystemStatePatch({ channels: nextChannels }, `client:${socket.id}`);
    safeCallback(callback, {
      ok: true,
      channel,
      systemState: snapshot,
    });
  });

  socket.on('updateChannel', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const data = asObject(payload);
    const channelId = stableId(data.channelId, '');
    const name = shortString(data.name, 48).trim();
    if (!channelId) return safeCallback(callback, { error: 'channelId is required' });
    if (!name) return safeCallback(callback, { error: 'channel name is required' });
    const existing = systemState.channels.find(channel => channel.id === channelId);
    if (!existing) return safeCallback(callback, { error: 'channel not found' });

    const nextChannels = systemState.channels.map(channel => (
      channel.id === channelId ? { ...channel, name } : channel
    ));
    const snapshot = applySystemStatePatch({ channels: nextChannels }, `client:${socket.id}`);
    safeCallback(callback, {
      ok: true,
      channel: snapshot.channels.find(channel => channel.id === channelId),
      systemState: snapshot,
    });
  });

  socket.on('deleteChannel', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const channelId = stableId(asObject(payload).channelId, '');
    if (!channelId) return safeCallback(callback, { error: 'channelId is required' });
    if (systemState.channels.length <= 1) {
      return safeCallback(callback, { error: 'at least one channel is required' });
    }
    const existing = systemState.channels.find(channel => channel.id === channelId);
    if (!existing) return safeCallback(callback, { error: 'channel not found' });

    const nextChannels = systemState.channels.filter(channel => channel.id !== channelId);
    const fallbackChannelId = nextChannels[0]?.id || DEFAULT_CHANNELS[0].id;
    const snapshot = applySystemStatePatch({ channels: nextChannels }, `client:${socket.id}`);
    safeCallback(callback, {
      ok: true,
      deletedChannelId: channelId,
      fallbackChannelId,
      systemState: snapshot,
    });
  });

  socket.on('movePeerToChannel', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const data = asObject(payload);
    const targetSocketId = shortString(data.targetSocketId || data.socketId, 128);
    if (!targetSocketId) return safeCallback(callback, { error: 'targetSocketId is required' });
    const result = setPeerChannel(targetSocketId, data.channelId, `client:${socket.id}`);
    if (!result.ok) return safeCallback(callback, { error: result.error });
    safeCallback(callback, {
      ok: true,
      targetSocketId,
      channelId: result.channelId,
      systemState: getSystemStateSnapshot(),
    });
  });

  socket.on('callPeer', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const targetSocketId = shortString(asObject(payload).targetSocketId || asObject(payload).socketId, 128);
    if (!targetSocketId) return safeCallback(callback, { error: 'targetSocketId is required' });
    if (targetSocketId === socket.id) return safeCallback(callback, { error: 'cannot call self' });
    if (!peers[targetSocketId]?.socket) return safeCallback(callback, { error: 'client not connected' });
    const privateSessionResult = ensurePrivateSessionForCaller(socket.id, `client:${socket.id}`);
    if (!privateSessionResult.ok) return safeCallback(callback, { error: privateSessionResult.error });
    const result = emitIncomingCall(targetSocketId, {
      fromSocketId: socket.id,
      fromName: peer.locationName,
      fromAppType: peer.appType,
      fromChannelId: privateSessionResult.session.channelId,
      privateChannelId: privateSessionResult.session.channelId,
      privateCreatedForCall: privateSessionResult.created,
    }, `client:${socket.id}`);
    if (!result.ok && privateSessionResult.created) {
      closePrivateSession(privateSessionResult.session, 'call-failed', { source: `client:${socket.id}`, shouldMuteMic: true });
    }
    if (!result.ok) return safeCallback(callback, { error: result.error });
    safeCallback(callback, {
      ok: true,
      callId: result.call.callId,
      targetSocketId,
      privateChannelId: privateSessionResult.session.channelId,
      channelId: privateSessionResult.session.channelId,
      channelName: PRIVATE_CHANNEL_NAME,
    });
  });

  // ── 着信側からの応答/拒否通知（発信側の鳴動表示を止める）──
  socket.on('callAck', (payload = {}, callback) => {
    const { callId, action } = asObject(payload);
    const id = shortString(callId, 80);
    const call = pendingCalls.get(id);
    if (!call || call.targetSocketId !== socket.id) {
      // 既にタイムアウト/キャンセル済み。古い通知は無害なので成功として返す。
      return safeCallback(callback, { ok: true, stale: true });
    }
    const answered = action === 'answered';
    let joinResult = null;
    if (answered && call.privateChannelId) {
      const session = privateSessions.get(call.privateChannelId);
      if (!session) {
        finishCall(id, 'dismissed');
        return safeCallback(callback, { error: 'private call expired' });
      }
      joinResult = addPeerToPrivateSession(session, socket.id, `client:${socket.id}`);
      if (!joinResult.ok) {
        finishCall(id, 'dismissed');
        return safeCallback(callback, { error: joinResult.error });
      }
    }
    finishCall(id, answered ? 'answered' : 'dismissed');
    safeCallback(callback, {
      ok: true,
      channelId: joinResult?.channelId,
      privateChannelId: joinResult?.privateChannelId,
      previousChannelId: joinResult?.previousChannelId,
    });
  });

  // ── 発信側からのキャンセル（着信側の鳴動を止める）──
  socket.on('callCancel', (payload = {}, callback) => {
    const { callId } = asObject(payload);
    const id = shortString(callId, 80);
    const call = pendingCalls.get(id);
    if (!call || call.fromSocketId !== socket.id) {
      return safeCallback(callback, { ok: true, stale: true });
    }
    finishCall(id, 'cancelled', { notifyCaller: false, notifyTarget: true });
    safeCallback(callback, { ok: true });
  });

  socket.on('endPrivateCall', (_payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const result = leavePrivateSession(socket.id, {
      reason: 'ended',
      source: `client:${socket.id}`,
      notify: true,
      shouldMuteMic: true,
      closeWhenAlone: true,
    });
    safeCallback(callback, {
      ok: result.ok,
      channelId: result.channelId || peer.channelId,
      privateChannelId: result.privateChannelId,
      shouldMuteMic: true,
    });
  });

  // ── Transport 生成 ──
  socket.on('createWebRtcTransport', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      if (!router) return safeCallback(callback, { error: 'router not ready' });
      const { forceTcp } = asObject(payload);
      const transport = await createWebRtcTransport(router, !!forceTcp, peer);
      peer.transports.set(transport.id, transport);
      safeCallback(callback, {
        params: {
          id:              transport.id,
          iceParameters:   transport.iceParameters,
          iceCandidates:   transport.iceCandidates,
          dtlsParameters:  transport.dtlsParameters,
        },
      });
    } catch (err) {
      console.error('[createWebRtcTransport]', err);
      safeCallback(callback, { error: err.message });
    }
  });

  // ── Transport 明示クローズ ──
  // クライアントが再接続/セッション再構築で古い transport を破棄したことを通知する。
  // ソケット接続を維持したまま transport だけ作り直すケース（_scheduleSetupRetry 等）では
  // 切断イベントでは回収されないため、これが無いと peer.transports にゴミが残り続ける。
  socket.on('closeTransport', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const { transportId } = asObject(payload);
    const transport = peer.transports.get(transportId);
    if (transport) {
      try { transport.close(); } catch (_) {}
      peer.transports.delete(transportId);
    }
    safeCallback(callback, { ok: true });
  });

  // ── Consumer 明示クローズ ──
  // クライアントが受信不良の consumer を破棄して再consumeする際に呼ぶ。
  // これが無いと、クライアント側だけ close された consumer がサーバーに残り、
  // 無駄なRTP送出とネイティブリソースの占有（長時間稼働のリーク要因）が続く。
  socket.on('closeConsumer', (payload = {}, callback) => {
    const peer = getPeerForRequest(socket, callback);
    if (!peer) return;
    const { consumerId } = asObject(payload);
    const consumer = peer.consumers.get(consumerId);
    if (consumer) {
      try { consumer.close(); } catch (_) {}
      peer.consumers.delete(consumerId);
    }
    safeCallback(callback, { ok: true });
  });

  // ── Transport 接続 ──
  socket.on('connectTransport', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { transportId, dtlsParameters } = asObject(payload);
      const transport = peer.transports.get(transportId);
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      // TCPフォールバック判定用: クライアントがDTLS確立を要求した時刻。
      // ここまで来てもメディアが確立しない＝シグナリングは通るがUDPが遮断されている。
      transport.appData.connectRequestedAt = Date.now();
      await transport.connect({ dtlsParameters });
      safeCallback(callback, {});
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ── Produce（映像/音声の送信開始）──
  socket.on('produce', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { transportId, kind, rtpParameters } = asObject(payload);
      const appData = asObject(payload.appData);
      if (!['audio', 'video'].includes(kind)) return safeCallback(callback, { error: 'invalid producer kind' });
      const transport = peer.transports.get(transportId);
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      const source = sanitizeProducerSource(kind, appData);
      const producerAppData = {
        ...appData,
        source,
        appType: peer.appType,
        channelId: peer.channelId,
      };
      const producer = await transport.produce({ kind, rtpParameters, appData: producerAppData });

      peer.producers.set(producer.id, {
        producer,
        kind,
        paused: false,
        source,
        appData: producerAppData,
        channelId: peer.channelId,
        // メディアフロー監視用（checkMediaFlow が更新する）
        flowBytes: null,
        flowAt: null,
        flowStalled: false,
      });

      producer.on('transportclose', () => {
        producer.close();
        peers[socket.id]?.producers.delete(producer.id);
      });

      safeCallback(callback, { id: producer.id });

      // サーバー録画: カメラ/画面共有の映像なら録画候補として登録する
      // (実際に録画するかは録画設定・ffmpeg/保存先の状態を見て recording 側が判定)
      recording.onProducerCreated({
        producer,
        socketId: socket.id,
        locationName: peer.locationName,
        source,
        appType: peer.appType,
        getLocationName: () => peers[socket.id]?.locationName,
      });

      // 他の全ピアへ通知（拠点名・kind・paused 状態も含む）
      socket.broadcast.emit('newProducer', {
        producerId:    producer.id,
        socketId:      socket.id,
        locationName:  peer.locationName,
        kind:          producer.kind,
        paused:        false,
        source,
        appData:       producerAppData,
        channelId:     peer.channelId,
        appType:       peer.appType,
      });

    } catch (err) {
      console.error('[produce]', err);
      safeCallback(callback, { error: err.message });
    }
  });

  // ── Consume（他拠点の受信開始）──
  socket.on('consume', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      if (!router) return safeCallback(callback, { error: 'router not ready' });
      const { transportId, producerId, rtpCapabilities } = asObject(payload);
      const transport = peer.transports.get(transportId);
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      const owner = findProducerOwner(producerId);
      if (!owner) return safeCallback(callback, { error: 'producer not found' });
      if (owner.peerId === socket.id) return safeCallback(callback, { error: 'cannot consume own producer' });
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return safeCallback(callback, { error: 'cannot consume' });
      }
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });

      peer.consumers.set(consumer.id, consumer);

      // このピアが受信画質を設定済みなら、新しい consumer にも適用する
      if (consumer.kind === 'video' && peer.recvQuality && peer.recvQuality !== 'high') {
        try {
          await consumer.setPreferredLayers({
            spatialLayer: recvQualityToSpatialLayer(peer.recvQuality),
            temporalLayer: 2,
          });
        } catch (_) { /* simulcastでない場合は無視 */ }
      }

      consumer.on('transportclose', () => {
        consumer.close();
        peers[socket.id]?.consumers.delete(consumer.id);
      });
      consumer.on('producerclose', () => {
        socket.emit('producerClosed', { producerId });
        consumer.close();
        peers[socket.id]?.consumers.delete(consumer.id);
      });

      safeCallback(callback, {
        params: {
          id:            consumer.id,
          producerId:    consumer.producerId,
          kind:          consumer.kind,
          rtpParameters: consumer.rtpParameters,
        },
      });
    } catch (err) {
      console.error('[consume]', err);
      safeCallback(callback, { error: err.message });
    }
  });

  // ── プレゼンスモード（商談中/不在/帰宅）の設定と全拠点への配信 ──
  socket.on('setPresenceMode', (payload = {}, callback) => {
    const peer = peers[socket.id];
    if (!peer) return safeCallback(callback, { error: 'peer not found' });
    const mode = ['none', 'busy', 'away', 'gohome'].includes(payload.mode) ? payload.mode : 'none';
    peer.presenceMode = mode;
    socket.broadcast.emit('peerPresenceChanged', {
      socketId: socket.id,
      locationName: peer.locationName,
      presenceMode: mode,
      serverTime: Date.now(),
    });
    safeCallback(callback, { ok: true, presenceMode: mode });
  });

  // ── 受信画質の設定（simulcastの優先レイヤ選択）──
  // クライアント側の「受信画質」設定。low/medium/high を空間レイヤ 0/1/2 に
  // マップし、既存および今後作られる video consumer に適用する。
  socket.on('setRecvQuality', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const quality = ['low', 'medium', 'high'].includes(payload.quality) ? payload.quality : 'high';
      peer.recvQuality = quality;
      const spatialLayer = recvQualityToSpatialLayer(quality);
      for (const consumer of peer.consumers.values()) {
        if (consumer.closed || consumer.kind !== 'video') continue;
        try {
          await consumer.setPreferredLayers({ spatialLayer, temporalLayer: 2 });
        } catch (_) { /* simulcastでないconsumer等は無視 */ }
      }
      safeCallback(callback, { ok: true, quality });
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ── Consumer 再生開始 ──
  socket.on('resume', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { consumerId } = asObject(payload);
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) return safeCallback(callback, { error: 'consumer not found' });
      // クライアントが受信を希望した記録。カメラOFF(配信停止)中はここでは
      // 再開せず、送信側の resumeProducer 時にまとめて再開する。
      consumer.appData.resumedByClient = true;
      const owner = findProducerOwner(consumer.producerId);
      if (owner?.entry && isCameraRelayControlled(owner.entry) && owner.entry.paused) {
        return safeCallback(callback, {});
      }
      await consumer.resume();
      safeCallback(callback, {});
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ── ICE restart（VPN/拠点間の経路切替・一時断からの復旧）──
  socket.on('restartIce', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { transportId } = asObject(payload);
      const transport = peer.transports.get(transportId);
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      const iceParameters = await transport.restartIce();
      safeCallback(callback, { iceParameters });
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ── 既存 Producer 一覧を返す ──
  socket.on('getProducers', (_, callback) => {
    const list = [];
    for (const [peerId, peerInfo] of Object.entries(peers)) {
      if (peerId === socket.id) continue;
      for (const [producerId, entry] of peerInfo.producers.entries()) {
        list.push({
          ...publicProducer(producerId, entry),
          producerId,
          socketId:     peerId,
          locationName: peerInfo.locationName,
          appType:      peerInfo.appType,
          appVersion:   peerInfo.appVersion,
          peerChannelId: peerInfo.channelId,
        });
      }
    }
    safeCallback(callback, list);
  });

  // ── 全ピア状態を返す（1秒ポーリング用）──
  socket.on('getPeers', (_, callback) => {
    const list = [];
    for (const [peerId, peerInfo] of Object.entries(peers)) {
      const producers = Array.from(peerInfo.producers.entries())
        .map(([producerId, entry]) => publicProducer(producerId, entry));
      list.push({
        socketId:     peerId,
        locationName: peerInfo.locationName,
        appType:      peerInfo.appType,
        appVersion:   peerInfo.appVersion,
        channelId:    peerInfo.channelId,
        presenceMode: peerInfo.presenceMode || 'none',
        signalLevel:  signalLevelFor(peerInfo),
        isSelf:       peerId === socket.id,
        // 復旧中（メディア停滞からの再構築中/切断猶予中）。受信側クライアントは
        // この拠点のタイルに「サーバー接続中」を表示する。
        recovering:   !!peerInfo.mediaRecovering,
        connected:    peerInfo.socket?.connected !== false,
        producers,
      });
    }
    safeCallback(callback, list);
  });

  // ── カメラ/マイク OFF（Producer 一時停止）──
  // カメラ映像は producer を止めず配信consumerのみ止める(サーバー録画継続のため)。
  // マイク/画面共有は従来どおり producer 自体を pause する。
  socket.on('pauseProducer', async (payload = {}, callback) => {
    try {
      const { producerId } = asObject(payload);
      const entry = peers[socket.id]?.producers.get(producerId);
      if (!entry) return callback?.({ error: 'not found' });
      if (isCameraRelayControlled(entry)) {
        entry.paused = true;
        await setRelayPausedForProducer(producerId, true);
      } else {
        await entry.producer.pause();
        entry.paused = true;
      }
      socket.broadcast.emit('producerPaused', { producerId, socketId: socket.id });
      callback?.({});
    } catch (err) {
      callback?.({ error: err.message });
    }
  });

  // ── カメラ/マイク ON（Producer 再開）──
  socket.on('resumeProducer', async (payload = {}, callback) => {
    try {
      const { producerId } = asObject(payload);
      const entry = peers[socket.id]?.producers.get(producerId);
      if (!entry) return callback?.({ error: 'not found' });
      if (isCameraRelayControlled(entry)) {
        entry.paused = false;
        await setRelayPausedForProducer(producerId, false);
      } else {
        await entry.producer.resume();
        entry.paused = false;
      }
      socket.broadcast.emit('producerResumed', { producerId, socketId: socket.id });
      callback?.({});
    } catch (err) {
      callback?.({ error: err.message });
    }
  });

  // ── Producer 終了（画面共有停止など）──
  socket.on('closeProducer', (payload = {}, callback) => {
    try {
      const { producerId } = asObject(payload);
      const peer = peers[socket.id];
      const entry = peer?.producers.get(producerId);
      if (!entry) return callback?.({ error: 'not found' });
      try { entry.producer.close(); } catch (_) {}
      peer.producers.delete(producerId);
      socket.broadcast.emit('producerClosed', { producerId, socketId: socket.id });
      callback?.({});
    } catch (err) {
      callback?.({ error: err.message });
    }
  });

  // ── Legacy client-originated restart request: disabled for stability/safety ──
  socket.on('forceRestart', () => {
    sendAdminLog(`[Admin] ignored client-originated forceRestart socket=${socket.id}`);
  });

  // ── 切断 ──
  socket.on('disconnect', () => {
    console.log(`[-] disconnect ${socket.id}`);
    finishCallsForSocket(socket.id);
    leavePrivateSession(socket.id, {
      reason: 'disconnect',
      source: 'disconnect',
      notify: false,
      shouldMuteMic: false,
      closeWhenAlone: true,
    });
    const peer = peers[socket.id];
    if (!peer) {
      io.emit('peerDisconnected', { socketId: socket.id });
      broadcastViewerPresence();
      return;
    }
    // mediasoupリソースは即座に回収する（仮セッションでもネイティブリソースは残さない）
    resetPeerMedia(peer);

    // 予期しない切断は、セッションを仮で残して再接続を待つ（切断猶予）。
    // 他拠点のタイルは消えず「サーバー接続中」表示になり、同じ端末の
    // 再接続(setMetadataの重複排除)で新セッションへ置き換わる。
    const graceEligible = PEER_DISCONNECT_GRACE_MS > 0 &&
      !peer.suppressGrace &&
      peer.metadataReady &&
      ['client', 'screen-share'].includes(peer.appType || 'client') &&
      !recovering;
    if (graceEligible) {
      peer.socketDisconnectedAt = Date.now();
      setPeerRecovering(socket.id, peer, true, 'socket-disconnected');
    } else {
      delete peers[socket.id];
      io.emit('peerDisconnected', { socketId: socket.id });
    }
    broadcastViewerPresence();
  });
});

// ── Admin IPC（GUIラッパー向け）────────────────────────

if (process.send) {
  let lastCpuUsage = process.cpuUsage();
  let lastCpuAt = process.hrtime.bigint();

  setInterval(() => {
    const now = process.hrtime.bigint();
    const cu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const elapsedMs = Number(now - lastCpuAt) / 1_000_000;
    lastCpuAt = now;
    const cpuPercent = elapsedMs > 0
      ? ((cu.user + cu.system) / 1_000 / elapsedMs * 100).toFixed(1)
      : '0.0';
    const snapshot = getStatsSnapshot();
    safeProcessSend({
      type: 'stats',
      data: { ...snapshot, cpu: cpuPercent },
    });
    // 既定500ms。全ピアのスナップショット構築+IPC送信はCPU/GC負荷が大きく、
    // 拠点数が増えると常時接続の安定性に影響するため頻度を抑えめにする。
    // 表示のリアルタイム性を上げたい場合は STATS_INTERVAL_MS で調整可能。
  }, Math.max(100, Number(process.env.STATS_INTERVAL_MS) || 500));

  process.on('message', rawMessage => {
    const msg = asObject(rawMessage);
    const socketId = shortString(msg.socketId, 128);
    if (msg.type === 'kick' && socketId) {
      const peer = peers[socketId];
      if (peer) peer.suppressGrace = true; // 明示切断: 仮セッションを残さない
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) targetSocket.disconnect(true);
      else if (peer) removePeer(socketId, 'admin-kick'); // 切断猶予中の仮セッションを破棄
    } else if (msg.type === 'restart-client' && socketId) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) emitRestartCommand(socket, 1, `server-gui:${socketId}`);
      else sendAdminLog(`[Admin] restart-client failed: client not connected socket=${socketId}`);
    } else if (msg.type === 'set-client-device' && socketId) {
      emitTargetCommand(
        socketId,
        'adminSetDevice',
        { kind: shortString(msg.kind, 32), deviceId: shortString(msg.deviceId, 256) },
        `set-device kind=${msg.kind}`,
      );
    } else if (msg.type === 'set-client-media-state' && socketId) {
      const kind = normalizeMediaStateKind(msg.kind);
      if (!kind) {
        sendAdminLog(`[Admin] set-media-state failed: unsupported kind=${msg.kind}`);
        return;
      }
      emitTargetCommand(
        socketId,
        'adminSetMediaState',
        { kind, enabled: !!msg.enabled },
        `set-media-state kind=${kind} enabled=${!!msg.enabled}`,
      );
    } else if (msg.type === 'refresh-client-devices' && socketId) {
      emitTargetCommand(socketId, 'adminRefreshDevices', {}, 'refresh-devices');
    } else if (msg.type === 'set-client-channel' && socketId) {
      const result = setPeerChannel(socketId, msg.channelId, 'server-gui');
      if (!result.ok) {
        sendAdminLog(`[Admin] set-client-channel failed: client not connected socket=${socketId}`);
        return;
      }
      sendAdminLog(`[Admin] set-client-channel ok socket=${socketId} channel=${result.channelId}`);
    } else if (msg.type === 'call-client' && socketId) {
      emitIncomingCall(socketId, {
        fromSocketId: 'server-gui',
        fromName: 'サーバー管理画面',
        fromAppType: 'server-gui',
      }, 'server-gui');
    } else if (msg.type === 'set-update-dir') {
      const dir = shortString(msg.dir, 1024);
      if (dir && fs.existsSync(dir)) {
        updateDir = dir;
        sendAdminLog(`[Updates] 配布フォルダを設定: ${dir} (${listUpdateFiles().length}ファイル)`);
      } else if (!dir) {
        updateDir = null;
        sendAdminLog('[Updates] 配布フォルダを解除しました');
      } else {
        sendAdminLog(`[Updates] 配布フォルダが見つかりません: ${dir}`);
      }
    } else if (msg.type === 'set-system-state') {
      applySystemStatePatch(msg.state || {}, 'server-gui');
    } else if (msg.type === 'set-recording-settings') {
      const settings = recording.applySettings(asObject(msg.settings));
      sendAdminLog(`[Recording] server-gui から録画設定を適用: enabled=${settings.enabled} 保持=${settings.retentionDays}日`);
    } else if (msg.type === 'force-update') {
      const targetAppType = shortString(msg.appType, 24);
      const sockets = Array.from(io.sockets.sockets.values()).filter(targetSocket => {
        if (!targetAppType || targetAppType === 'all') return true;
        return peers[targetSocket.id]?.appType === targetAppType;
      });
      const target = targetAppType && targetAppType !== 'all'
        ? io.to(sockets.map(targetSocket => targetSocket.id))
        : io;
      emitUpdateCommand(target, sockets.length, targetAppType, { forced: true, reason: 'server-gui' });
    } else if (msg.type === 'restart-all') {
      emitRestartCommand(io, io.sockets.sockets.size, 'server-gui');
    }
  });
}

function closeAllPeers() {
  for (const peer of Object.values(peers)) resetPeerMedia(peer);
}

function shutdown(signal) {
  console.log(`[SFU] shutting down: ${signal}`);
  recording.shutdown();
  closeAllPeers();
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', err => {
  console.error('[Process] unhandledRejection:', err);
});
process.on('uncaughtException', err => {
  console.error('[Process] uncaughtException:', err);
  process.exit(1);
});

// ── 起動 ──────────────────────────────────────────────────

async function run() {
  await createWorkers();
  await createRouter();
  server.listen(config.listenPort, config.listenIp, () => {
    console.log(`[SFU] listening on ${config.listenIp}:${config.listenPort}`);
  });
}

run().catch(err => {
  console.error('[SFU] fatal:', err);
  process.exit(1);
});
