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
 *     getSystemState()                    チャンネル/バージョン/更新情報を取得
 *     pauseProducer({ producerId })       カメラ/マイク OFF を通知
 *     resumeProducer({ producerId })      カメラ/マイク ON を通知
 *
 *   Server → Client:
 *     systemStateUpdated({ ... })         チャンネル/更新情報変更通知
 *     incomingCall({ fromSocketId, fromName, fromChannelId, callId })
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
// 連続してこの回数セッション再構築しても止まったままなら、クライアント本体の
// クイック再起動(restartCommand)へ切り替える
const MEDIA_STALL_ESCALATE_STRIKES = Number(process.env.MEDIA_STALL_ESCALATE_STRIKES) || 3;
const SYSTEM_NAME = 'CHECKHOUSE Meeting System';
const DEFAULT_CHANNELS = [
  { id: 'general', name: '一般' },
  { id: 'support', name: 'サポート' },
];
const APP_TYPES = ['client', 'viewer', 'screen-share', 'server', 'server-gui'];
const SERVER_APP_VERSION = serverPackage.version || '0.0.0';
const DEFAULT_APP_VERSIONS = {
  client: '0.3.2',
  viewer: '0.1.1',
  'screen-share': '0.1.0',
  server: SERVER_APP_VERSION,
  'server-gui': '1.1.2',
};
let systemState = {
  brand: SYSTEM_NAME,
  channels: DEFAULT_CHANNELS,
  latestVersions: { ...DEFAULT_APP_VERSIONS },
  updatePackages: {},
  updatedAt: Date.now(),
};

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
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    sanitized.push({ id, name });
  }

  return sanitized.length ? sanitized : DEFAULT_CHANNELS;
}

function createUniqueChannelId(name) {
  const base = stableId(name, 'channel');
  const existing = new Set(systemState.channels.map(channel => channel.id));
  if (!existing.has(base)) return base;

  for (let index = 2; index <= 99; index += 1) {
    const candidate = stableId(`${base}-${index}`, `channel-${index}`);
    if (!existing.has(candidate)) return candidate;
  }
  return stableId(`${base}-${Date.now()}`, `channel-${Date.now()}`);
}

function normalizeChannelId(channelId) {
  const id = stableId(channelId, systemState.channels[0]?.id || DEFAULT_CHANNELS[0].id);
  return systemState.channels.some(channel => channel.id === id)
    ? id
    : (systemState.channels[0]?.id || DEFAULT_CHANNELS[0].id);
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

function sanitizeSystemStatePatch(patch) {
  const raw = asObject(patch);
  const channels = raw.channels == null ? systemState.channels : sanitizeChannels(raw.channels);
  const latestVersions = sanitizeVersionMap(raw.latestVersions, systemState.latestVersions);
  const updatePackages = sanitizeUpdatePackages(raw.updatePackages, systemState.updatePackages);

  return {
    brand: SYSTEM_NAME,
    channels,
    latestVersions,
    updatePackages,
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

function emitSelfSystemState(socketId, peer) {
  if (!peer?.socket) return;
  peer.socket.emit('systemStateUpdated', {
    ...getSystemStateSnapshot(),
    self: {
      socketId,
      channelId: peer.channelId,
      appType: peer.appType,
      appVersion: peer.appVersion,
    },
  });
}

function setPeerChannel(socketId, channelId, source = 'server') {
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

  return {
    id,
    name: peer.locationName,
    appType: peer.appType || peer.telemetry?.appType || 'client',
    appVersion: peer.appVersion || peer.telemetry?.appVersion || '',
    channelId: peer.channelId || DEFAULT_CHANNELS[0].id,
    remoteAddress: peer.socket.handshake.address,
    connectedAt: peer.connectedAt,
    heartbeatAgeMs,
    health: healthStatus(peer, now),
    rttMs: peer.rttMs ?? null,
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
    iceServerCount: (config.iceServers || []).length,
    systemState: getSystemStateSnapshot(),
  };
}

// ── アップデートファイル配信 ──────────────────────────────
// server-gui で選択されたフォルダ内のビルド済みパッケージを配布する。

function listUpdateFiles() {
  if (!updateDir || !fs.existsSync(updateDir)) return [];
  try {
    return fs.readdirSync(updateDir)
      .filter(name => /\.(dmg|pkg|zip|exe|msi|appimage|deb|7z)$/i.test(name))
      .map(name => {
        const stat = fs.statSync(path.join(updateDir, name));
        return { name, size: stat.size, mtimeMs: stat.mtimeMs };
      });
  } catch (err) {
    console.error('[Updates] list failed:', err.message);
    return [];
  }
}

app.get('/updates', (_, res) => {
  res.json({ updateDir: updateDir || null, files: listUpdateFiles() });
});

app.get('/updates/:filename', (req, res) => {
  if (!updateDir) return res.status(404).json({ error: 'update dir not configured' });
  const fileName = path.basename(String(req.params.filename || ''));
  const filePath = path.join(updateDir, fileName);
  if (!fileName || !filePath.startsWith(updateDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file not found' });
  }
  res.download(filePath, fileName);
});

app.get('/health', (_, res) => res.json(getStatsSnapshot()));
app.get('/ready', (_, res) => {
  const ready = !!router && workers.length > 0 && !recovering;
  res.status(ready ? 200 : 503).json({ ready, recovering, workers: workers.length });
});

function sendAdminLog(message) {
  if (process.send) safeProcessSend({ type: 'admin-log', data: message });
  else console.log(message);
}

function emitRestartCommand(target, recipientCount, reason) {
  const issuedAt = Date.now();
  const payload = { issuedAt, reason };

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

function applySystemStatePatch(patch, source = 'server') {
  systemState = sanitizeSystemStatePatch(patch);
  for (const [socketId, peer] of Object.entries(peers)) {
    const previousChannelId = peer.channelId;
    peer.channelId = normalizeChannelId(peer.channelId);
    if (previousChannelId !== peer.channelId) emitPeerChannelChanged(socketId, peer);
    emitSelfSystemState(socketId, peer);
  }
  const snapshot = broadcastSystemState();
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
const pendingCalls = new Map(); // callId → { fromSocketId, targetSocketId, timer }
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
    ? systemState.channels.find(channel => channel.id === rawFromChannelId)
    : null;
  const callPayload = {
    callId: shortString(payload.callId || `call-${issuedAt}-${Math.random().toString(36).slice(2, 8)}`, 80),
    fromSocketId: shortString(payload.fromSocketId, 128),
    fromName: shortString(payload.fromName || '呼び出し', 128),
    fromAppType: shortString(payload.fromAppType || 'client', 24),
    fromChannelId: fromChannel?.id || '',
    fromChannelName: fromChannel?.name || '',
    targetSocketId: socketId,
    targetName: targetPeer.locationName,
    serverTime: issuedAt,
  };

  // 応答待ちとして登録（旧クライアントが callAck を返さなくてもタイムアウトで確実に終了する）
  pendingCalls.set(callPayload.callId, {
    fromSocketId: callPayload.fromSocketId || '',
    targetSocketId: socketId,
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
const telemetryRecoveryTimer = setInterval(recoverTelemetryMissingPeers, 5000);
telemetryRecoveryTimer.unref?.();

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

/** 停滞を検出したピアへの復旧指示（クールダウン+エスカレーション込み） */
function recoverStalledPeer(socketId, peer, stalledKinds, now) {
  if (now - (peer.mediaStallRecoveryAt || 0) < MEDIA_STALL_COOLDOWN_MS) return;
  peer.mediaStallRecoveryAt = now;
  peer.mediaStallStrikes = (peer.mediaStallStrikes || 0) + 1;

  if (peer.mediaStallStrikes >= MEDIA_STALL_ESCALATE_STRIKES) {
    // セッション再構築を繰り返しても届かない → クライアント側の
    // ネットワークスタック/アプリごと再起動させる方が復旧確率が高い。
    peer.mediaStallStrikes = 0;
    sendAdminLog(`[Recovery] media-stalled escalation name=${peer.locationName} kinds=${stalledKinds.join(',')} → restartCommand`);
    emitRestartCommand(peer.socket, 1, `media-stalled:${socketId}`);
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

    for (const [socketId, peer] of Object.entries(peers)) {
      if (!peer.socket?.connected || !peer.metadataReady) continue;

      const stalledKinds = [];
      for (const [producerId, entry] of peer.producers) {
        const producer = entry.producer;
        // paused(ミュート等)や閉じた producer はRTPが止まるのが正常。
        // 追跡をリセットしておき、resume 後に停滞時計がゼロから始まるようにする。
        if (!producer || producer.closed || entry.paused || producer.paused) {
          entry.flowBytes = null;
          entry.flowAt = null;
          entry.flowStalled = false;
          continue;
        }
        let bytes;
        try {
          bytes = await sampleProducerInboundBytes(producer);
        } catch {
          continue; // 取得失敗はスキップ（次周期で再試行）
        }
        if (entry.flowBytes == null || bytes > entry.flowBytes) {
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
          continue;
        }
        let bytes;
        try {
          bytes = await sampleConsumerOutboundBytes(consumer);
        } catch {
          continue;
        }
        if (tracking.flowBytes == null || bytes > tracking.flowBytes) {
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

      if (!stalledKinds.length) {
        // 上り・下りとも健全 → エスカレーション用の連続停滞カウントをリセット
        if (peer.producers.size > 0 || peer.consumers.size > 0) peer.mediaStallStrikes = 0;
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
  // クライアントの要求(forceTcp)とサーバー設定(FORCE_TCP/PREFER_TCP)を合成する。
  // どちらかがTCPを要求すればTCPで伝送する（映像・音声・画面共有すべて）。
  const tcpOnly = forceTcp || !!config.mediaTransport?.forceTcp;
  const preferTcp = tcpOnly || !!config.mediaTransport?.preferTcp;
  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: !tcpOnly,
    enableTcp: true,
    preferUdp: !preferTcp,
    preferTcp,
    initialAvailableOutgoingBitrate,
  });
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
    recvQuality: 'high',
    connectedAt: Date.now(),
    lastHeartbeatAt: null,
    telemetryRecoveryAt: 0,
    mediaStallRecoveryAt: 0,
    mediaStallStrikes: 0,
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
      if (channelId) peer.channelId = normalizeChannelId(channelId);

      // 同一クライアントインスタンス(端末)からの重複セッションを排除する。
      // レンダラークラッシュや瞬断後の再接続では、古いソケットがpingタイムアウト
      // まで生き残り「同じ拠点が二重にいる」状態になる。instanceId はクライアント
      // 端末ごとに永続で、同じIDの古いセッションは新しい接続で即時置き換える。
      const cleanInstanceId = shortString(instanceId || '', 64);
      if (cleanInstanceId) {
        peer.instanceId = cleanInstanceId;
        for (const [otherId, other] of Object.entries(peers)) {
          if (otherId === socket.id || other.instanceId !== cleanInstanceId) continue;
          sendAdminLog(`[Session] duplicate instance replaced name=${other.locationName} old=${otherId} new=${socket.id}`);
          try { other.socket.disconnect(true); } catch (_) { /* 切断済みなら無視 */ }
        }
      }

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
    const result = emitIncomingCall(targetSocketId, {
      fromSocketId: socket.id,
      fromName: peer.locationName,
      fromAppType: peer.appType,
      fromChannelId: peer.channelId,
    }, `client:${socket.id}`);
    if (!result.ok) return safeCallback(callback, { error: result.error });
    safeCallback(callback, {
      ok: true,
      callId: result.call.callId,
      targetSocketId,
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
    finishCall(id, action === 'answered' ? 'answered' : 'dismissed');
    safeCallback(callback, { ok: true });
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

  // ── Transport 接続 ──
  socket.on('connectTransport', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { transportId, dtlsParameters } = asObject(payload);
      const transport = peer.transports.get(transportId);
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
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
        isSelf:       peerId === socket.id,
        producers,
      });
    }
    safeCallback(callback, list);
  });

  // ── カメラ/マイク OFF（Producer 一時停止）──
  socket.on('pauseProducer', async (payload = {}, callback) => {
    try {
      const { producerId } = asObject(payload);
      const entry = peers[socket.id]?.producers.get(producerId);
      if (!entry) return callback?.({ error: 'not found' });
      await entry.producer.pause();
      entry.paused = true;
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
      await entry.producer.resume();
      entry.paused = false;
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
    const peer = peers[socket.id];
    if (peer) resetPeerMedia(peer);
    delete peers[socket.id];
    // 全拠点に切断を通知
    io.emit('peerDisconnected', { socketId: socket.id });
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
      io.sockets.sockets.get(socketId)?.disconnect(true);
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
