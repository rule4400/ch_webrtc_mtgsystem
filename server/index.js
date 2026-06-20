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
const { appendDebugLog, debugLogInfo } = require('./debug-log');

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
const SYSTEM_NAME = 'CHECKHOUSE Meeting System';
const DEFAULT_CHANNELS = [
  { id: 'general', name: '一般' },
  { id: 'support', name: 'サポート' },
];
const APP_TYPES = ['client', 'viewer', 'screen-share', 'server', 'server-gui'];
const APP_PLATFORMS = ['darwin', 'win32', 'linux'];
const SERVER_APP_VERSION = serverPackage.version || '0.0.0';
const DEFAULT_APP_VERSIONS = {
  client: '0.2.5',
  viewer: '0.1.5',
  'screen-share': '0.1.4',
  server: SERVER_APP_VERSION,
  'server-gui': '1.0.5',
};
let systemState = {
  brand: SYSTEM_NAME,
  channels: DEFAULT_CHANNELS,
  latestVersions: { ...DEFAULT_APP_VERSIONS },
  updatePackages: {},
  mediaTransport: {
    forceTcp: !!config.forceTcpMedia,
  },
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
const REPLACED_BY_NEW_CONNECTION_REASON = 'replaced-by-new-connection';
const METADATA_TIMEOUT_MS = 15000;
const DEFAULT_VPN_BANDWIDTH_MBPS = Number(process.env.VPN_BANDWIDTH_MBPS) || 200;
const STATS_INTERVAL_MS = Math.max(500, Number(process.env.STATS_INTERVAL_MS) || 1000);
const ESTIMATED_MEDIA_BITRATES_BPS = {
  camera: 450_000,
  screen: 700_000,
  microphone: 24_000,
  'screen-audio': 32_000,
};

function compactRtpStats(items = []) {
  return items.map(item => {
    const first = Array.isArray(item.stats) ? item.stats[0] : null;
    return {
      source: item.source || '',
      producerId: item.producerId || item.id || '',
      consumerId: item.consumerId || item.id || '',
      kind: item.kind || first?.kind || '',
      error: item.error || '',
      bytesSent: first?.bytesSent ?? null,
      bytesReceived: first?.bytesReceived ?? null,
      packetsSent: first?.packetsSent ?? null,
      packetsReceived: first?.packetsReceived ?? null,
      packetsLost: first?.packetsLost ?? null,
      framesEncoded: first?.framesEncoded ?? null,
      framesDecoded: first?.framesDecoded ?? null,
      framesPerSecond: first?.framesPerSecond ?? null,
      frameWidth: first?.frameWidth ?? null,
      frameHeight: first?.frameHeight ?? null,
      jitter: first?.jitter ?? null,
    };
  });
}

function telemetryDebugSummary(socketId, peer, payload = {}) {
  const mediaStats = payload.mediaStats || {};
  const outbound = compactRtpStats(mediaStats.producers || []);
  const inbound = compactRtpStats(mediaStats.consumers || []);
  const localMedia = payload.localMedia || {};
  const remoteMonitor = payload.remoteMonitor || {};
  const transports = payload.transports || {};
  const sendPair = transports.sendSelectedCandidatePair || null;
  const recvPair = transports.recvSelectedCandidatePair || null;
  const flags = [];

  const outboundVideo = outbound.find(item => item.kind === 'video' || item.source === 'camera');
  const outboundAudio = outbound.find(item => item.kind === 'audio' || item.source === 'microphone');
  const inboundVideo = inbound.find(item => item.kind === 'video');
  const inboundAudio = inbound.find(item => item.kind === 'audio');

  if (localMedia.cameraEnabled && !localMedia.video?.present) flags.push('camera-enabled-but-track-missing');
  if (localMedia.micEnabled && !localMedia.audio?.present) flags.push('mic-enabled-but-track-missing');
  if (localMedia.video?.readyState === 'live' && Number(outboundVideo?.bytesSent || 0) <= 0) flags.push('video-track-live-but-no-outbound-rtp');
  if (localMedia.audio?.readyState === 'live' && Number(outboundAudio?.bytesSent || 0) <= 0) flags.push('audio-track-live-but-no-outbound-rtp');
  if (remoteMonitor.peerCount > 0 && Number(inboundVideo?.bytesReceived || 0) <= 0) flags.push('remote-peer-present-but-no-inbound-video-rtp');
  if (remoteMonitor.peerCount > 0 && Number(inboundAudio?.bytesReceived || 0) <= 0) flags.push('remote-peer-present-but-no-inbound-audio-rtp');
  if (transports.socketConnected && !['connected', 'completed'].includes(String(transports.sendState || '').toLowerCase())) flags.push('socket-connected-send-transport-not-connected');
  if (transports.socketConnected && !['connected', 'completed'].includes(String(transports.recvState || '').toLowerCase())) flags.push('socket-connected-recv-transport-not-connected');
  if (sendPair?.local?.protocol === 'tcp' || recvPair?.local?.protocol === 'tcp') flags.push('ice-using-tcp');
  if (sendPair?.local?.candidateType === 'relay' || recvPair?.local?.candidateType === 'relay') flags.push('ice-using-turn-relay');

  return {
    socketId,
    locationName: peer?.locationName || payload.locationName || '',
    appType: peer?.appType || payload.appType || '',
    appVersion: payload.appVersion || peer?.appVersion || '',
    channelId: peer?.channelId || payload.channelId || '',
    status: payload.status || '',
    clientTime: payload.clientTime || null,
    connection: payload.connection || {},
    transports: {
      socketConnected: !!transports.socketConnected,
      sendState: transports.sendState || '',
      recvState: transports.recvState || '',
      sendClosed: !!transports.sendClosed,
      recvClosed: !!transports.recvClosed,
      sendSelectedCandidatePair: sendPair,
      recvSelectedCandidatePair: recvPair,
    },
    localMedia: {
      cameraEnabled: !!localMedia.cameraEnabled,
      micEnabled: !!localMedia.micEnabled,
      speakerMuted: !!localMedia.speakerMuted,
      video: localMedia.video || {},
      audio: localMedia.audio || {},
      error: localMedia.error || null,
      audioProfile: localMedia.audioProfile || {},
    },
    remoteMonitor: {
      peerCount: remoteMonitor.peerCount || 0,
      receivingVideoCount: remoteMonitor.receivingVideoCount || 0,
      receivingAudioCount: remoteMonitor.receivingAudioCount || 0,
      peers: remoteMonitor.peers || [],
    },
    rtp: {
      outbound,
      inbound,
    },
    flags,
  };
}

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
    appendDebugLog('worker.died', { workerPid: worker.pid }, 'error');
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
  appendDebugLog('worker.created', { workerPid: worker.pid });
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
  appendDebugLog('router.created', { workerPid: routerWorker.pid, mediaCodecs: config.mediasoup.router.mediaCodecs });
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

function closePeerProducer(socketId, producerId, { notify = true, closeProducer = true, reason = 'closed' } = {}) {
  const peer = peers[socketId];
  const entry = peer?.producers.get(producerId);
  if (!peer || !entry) return false;

  peer.producers.delete(producerId);
  appendDebugLog('producer.closed', {
    socketId,
    producerId,
    reason,
    notify,
    closeProducer,
    kind: entry.kind,
    source: entry.source || entry.appData?.source || '',
    locationName: peer.locationName,
    channelId: peer.channelId,
  });
  if (closeProducer) {
    try { entry.producer.close(); } catch (_) {}
  }
  if (notify) {
    peer.socket?.broadcast.emit('producerClosed', { producerId, socketId, reason });
  }
  return true;
}

function transportFromRecord(record) {
  return record?.transport || record || null;
}

function resetPeerMedia(peer) {
  if (!peer) return;
  const socketId = peer.socket?.id;
  if (socketId) {
    for (const producerId of Array.from(peer.producers.keys())) {
      closePeerProducer(socketId, producerId, { reason: 'media-reset' });
    }
  }
  for (const record of peer.transports.values()) {
    const transport = transportFromRecord(record);
    try { transport.close(); } catch (_) {}
  }
  peer.transports.clear();
  peer.producers.clear();
  peer.consumers.clear();
}

function cleanupPeer(socketId, reason = 'disconnect') {
  const peer = peers[socketId];
  if (!peer) return false;

  if (peer.metadataTimer) clearTimeout(peer.metadataTimer);
  finishCallsForSocket(socketId);
  resetPeerMedia(peer);
  delete peers[socketId];
  io.emit('peerDisconnected', { socketId, reason });
  broadcastViewerPresence();
  return true;
}

function replaceExistingClientInstance(currentSocket, currentPeer) {
  const clientInstanceId = currentPeer?.clientInstanceId;
  if (!clientInstanceId) return;

  for (const [socketId, peer] of Object.entries(peers)) {
    if (socketId === currentSocket.id) continue;
    if (peer.clientInstanceId !== clientInstanceId) continue;
    if ((peer.appType || 'client') !== (currentPeer.appType || 'client')) continue;

    console.warn(`[Peer] replacing stale duplicate instance=${clientInstanceId} old=${socketId} new=${currentSocket.id}`);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanupPeer(socketId, REPLACED_BY_NEW_CONNECTION_REASON);
      try {
        peer.socket.disconnect(true);
      } catch (err) {
        console.warn(`[Peer] failed to disconnect stale socket=${socketId}: ${err.message}`);
      }
    };
    const timer = setTimeout(finish, 300);
    try {
      peer.socket.timeout(250).emit('instanceReplaced', {
        reason: REPLACED_BY_NEW_CONNECTION_REASON,
        replacementSocketId: currentSocket.id,
        serverTime: Date.now(),
      }, () => {
        clearTimeout(timer);
        finish();
      });
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[Peer] failed to notify stale socket=${socketId}: ${err.message}`);
      finish();
    }
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function shortString(value, max = 256) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function sanitizeClientInstanceId(value) {
  return shortString(value, 128).trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 96);
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

function normalizeClientPlatform(value) {
  const raw = shortString(value, 32).trim().toLowerCase();
  if (raw === 'mac' || raw === 'macos' || raw === 'osx') return 'darwin';
  if (raw === 'windows' || raw === 'win' || raw === 'win64') return 'win32';
  if (raw === 'linux') return 'linux';
  return APP_PLATFORMS.includes(raw) ? raw : '';
}

function sanitizePackageInfo(input, fallbackVersion = '') {
  const pkg = asObject(input);
  return {
    version: shortString(pkg.version || fallbackVersion || '', 48).trim(),
    url: shortString(pkg.url, 1024).trim(),
    notes: shortString(pkg.notes, 1000).trim(),
    sha256: shortString(pkg.sha256, 128).trim(),
    required: !!pkg.required,
    fileName: shortString(pkg.fileName, 512).trim(),
    platform: normalizeClientPlatform(pkg.platform),
    registeredAt: Number.isFinite(pkg.registeredAt) ? pkg.registeredAt : Date.now(),
  };
}

function sanitizeUpdatePackages(input, previous = {}) {
  const raw = asObject(input);
  const next = { ...previous };
  for (const appType of APP_TYPES) {
    if (raw[appType] == null) continue;
    const pkg = asObject(raw[appType]);
    const version = shortString(pkg.version || systemState.latestVersions[appType] || '', 48).trim();
    const clean = sanitizePackageInfo(pkg, version);
    const rawPlatforms = asObject(pkg.platforms);
    const platforms = {};
    for (const [platform, platformPkg] of Object.entries(rawPlatforms)) {
      const normalizedPlatform = normalizeClientPlatform(platform);
      if (!normalizedPlatform) continue;
      platforms[normalizedPlatform] = sanitizePackageInfo({ ...platformPkg, platform: normalizedPlatform }, version);
    }
    next[appType] = Object.keys(platforms).length ? { ...clean, platforms } : clean;
  }
  return next;
}

function sanitizeSystemStatePatch(patch) {
  const raw = asObject(patch);
  const channels = raw.channels == null ? systemState.channels : sanitizeChannels(raw.channels);
  const latestVersions = sanitizeVersionMap(raw.latestVersions, systemState.latestVersions);
  const updatePackages = sanitizeUpdatePackages(raw.updatePackages, systemState.updatePackages);
  const mediaTransport = {
    forceTcp: raw.mediaTransport == null
      ? !!systemState.mediaTransport?.forceTcp
      : !!asObject(raw.mediaTransport).forceTcp,
  };

  return {
    brand: SYSTEM_NAME,
    channels,
    latestVersions,
    updatePackages,
    mediaTransport,
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

function resolvePackageUrls(pkg) {
  if (!pkg) return null;
  const next = { ...pkg, url: resolveUpdateUrl(pkg.url) };
  if (pkg.platforms && typeof pkg.platforms === 'object') {
    next.platforms = Object.fromEntries(Object.entries(pkg.platforms).map(([platform, platformPkg]) => [
      platform,
      { ...platformPkg, url: resolveUpdateUrl(platformPkg.url) },
    ]));
  }
  return next;
}

function packageForPlatform(appType, platform) {
  const pkg = systemState.updatePackages[appType] || null;
  if (!pkg) return null;
  const normalizedPlatform = normalizeClientPlatform(platform);
  const platformPkg = normalizedPlatform ? pkg.platforms?.[normalizedPlatform] : null;
  return resolvePackageUrls(platformPkg || pkg);
}

function getSystemStateSnapshot() {
  const updatePackages = {};
  for (const [appType, pkg] of Object.entries(systemState.updatePackages || {})) {
    updatePackages[appType] = resolvePackageUrls(pkg);
  }
  return {
    ...systemState,
    updatePackages,
    serverVersion: SERVER_APP_VERSION,
  };
}

function isForceTcpMediaEnabled() {
  return !!systemState.mediaTransport?.forceTcp;
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
    score: Array.isArray(entry.score) ? entry.score : [],
    scoreUpdatedAt: entry.scoreUpdatedAt || null,
    appData: {
      ...(entry.appData || {}),
      source,
    },
    channelId: entry.channelId || null,
  };
}

function publicTuple(tuple) {
  if (!tuple || typeof tuple !== 'object') return null;
  return {
    protocol: shortString(tuple.protocol, 16),
    localIp: shortString(tuple.localIp, 64),
    localPort: Number(tuple.localPort) || null,
    remoteIp: shortString(tuple.remoteIp, 64),
    remotePort: Number(tuple.remotePort) || null,
  };
}

function createTransportRecord(transport, { direction = 'unknown', forceTcp = false } = {}) {
  const record = {
    id: transport.id,
    transport,
    direction: shortString(direction, 16) || 'unknown',
    forceTcp: !!forceTcp,
    iceState: transport.iceState || 'new',
    dtlsState: transport.dtlsState || 'new',
    sctpState: transport.sctpState || '',
    selectedTuple: publicTuple(transport.iceSelectedTuple || transport.tuple),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closedAt: null,
  };
  const touch = () => { record.updatedAt = Date.now(); };
  transport.on('icestatechange', state => {
    record.iceState = state;
    touch();
    appendDebugLog('transport.ice-state', {
      transportId: record.id,
      direction: record.direction,
      forceTcp: record.forceTcp,
      iceState: state,
      selectedTuple: record.selectedTuple,
    }, ['failed', 'disconnected', 'closed'].includes(state) ? 'warn' : 'info');
  });
  transport.on('iceselectedtuplechange', tuple => {
    record.selectedTuple = publicTuple(tuple);
    touch();
    appendDebugLog('transport.ice-selected-tuple', {
      transportId: record.id,
      direction: record.direction,
      forceTcp: record.forceTcp,
      selectedTuple: record.selectedTuple,
    });
  });
  transport.on('dtlsstatechange', state => {
    record.dtlsState = state;
    touch();
    appendDebugLog('transport.dtls-state', {
      transportId: record.id,
      direction: record.direction,
      forceTcp: record.forceTcp,
      dtlsState: state,
      selectedTuple: record.selectedTuple,
    }, ['failed', 'closed'].includes(state) ? 'warn' : 'info');
    if (state === 'closed') transport.close();
  });
  transport.on('sctpstatechange', state => {
    record.sctpState = state;
    touch();
    appendDebugLog('transport.sctp-state', {
      transportId: record.id,
      direction: record.direction,
      forceTcp: record.forceTcp,
      sctpState: state,
    });
  });
  transport.on('close', () => {
    record.closedAt = Date.now();
    record.updatedAt = record.closedAt;
    console.log('[Transport] closed');
    appendDebugLog('transport.closed', {
      transportId: record.id,
      direction: record.direction,
      forceTcp: record.forceTcp,
      iceState: record.iceState,
      dtlsState: record.dtlsState,
      selectedTuple: record.selectedTuple,
    });
  });
  return record;
}

function publicTransportRecord(record) {
  const transport = transportFromRecord(record);
  if (!transport) return null;
  return {
    id: record.id || transport.id,
    direction: record.direction || 'unknown',
    forceTcp: !!record.forceTcp,
    iceState: record.iceState || transport.iceState || '',
    dtlsState: record.dtlsState || transport.dtlsState || '',
    sctpState: record.sctpState || transport.sctpState || '',
    selectedTuple: record.selectedTuple || publicTuple(transport.iceSelectedTuple || transport.tuple),
    closed: !!transport.closed,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    closedAt: record.closedAt || null,
  };
}

function estimatedProducerBitrate(entry) {
  if (!entry) return 0;
  const source = entry.source || sanitizeProducerSource(entry.kind, entry.appData);
  if (entry.paused) return 0;
  return ESTIMATED_MEDIA_BITRATES_BPS[source] || (entry.kind === 'video' ? ESTIMATED_MEDIA_BITRATES_BPS.camera : ESTIMATED_MEDIA_BITRATES_BPS.microphone);
}

function bandwidthEstimateSnapshot() {
  let serverIngressBps = 0;
  let serverEgressBps = 0;
  let activeVideoProducers = 0;
  let activeAudioProducers = 0;

  for (const peer of Object.values(peers)) {
    for (const entry of peer.producers.values()) {
      const bps = estimatedProducerBitrate(entry);
      serverIngressBps += bps;
      if (bps > 0 && entry.kind === 'video') activeVideoProducers += 1;
      if (bps > 0 && entry.kind === 'audio') activeAudioProducers += 1;
    }
    for (const consumer of peer.consumers.values()) {
      if (consumer.paused || consumer.closed) continue;
      const owner = findProducerOwner(consumer.producerId);
      serverEgressBps += estimatedProducerBitrate(owner?.entry);
    }
  }

  const vpnBudgetBps = DEFAULT_VPN_BANDWIDTH_MBPS * 1_000_000;
  const usageRatio = vpnBudgetBps > 0 ? serverEgressBps / vpnBudgetBps : 0;
  return {
    vpnBudgetMbps: DEFAULT_VPN_BANDWIDTH_MBPS,
    estimatedServerIngressMbps: Number((serverIngressBps / 1_000_000).toFixed(2)),
    estimatedServerEgressMbps: Number((serverEgressBps / 1_000_000).toFixed(2)),
    estimatedBudgetUsagePercent: Number((usageRatio * 100).toFixed(1)),
    activeVideoProducers,
    activeAudioProducers,
    qualityMode: mediaPeerCount() >= 4 ? 'conservative' : 'balanced',
  };
}

function mediaPeerCount() {
  return Object.values(peers).filter(peer => peer.metadataReady && peer.appType !== 'server-gui').length;
}

function preferredConsumerLayers(entry) {
  if (!entry || entry.kind !== 'video') return null;
  const source = entry.source || sanitizeProducerSource(entry.kind, entry.appData);
  const congested = mediaPeerCount() >= 4;
  if (source === 'screen') {
    return congested
      ? { spatialLayer: 0, temporalLayer: 0 }
      : { spatialLayer: 1, temporalLayer: 0 };
  }
  return congested
    ? { spatialLayer: 0, temporalLayer: 0 }
    : { spatialLayer: 1, temporalLayer: 0 };
}

async function applyConsumerReliabilityPolicy(consumer, entry) {
  if (!consumer || !entry || entry.kind !== 'video') return;
  try {
    const layers = preferredConsumerLayers(entry);
    if (layers) {
      await consumer.setPreferredLayers(layers);
      if (consumer.__chDiagnostics) consumer.__chDiagnostics.preferredLayers = layers;
    }
  } catch (err) {
    console.warn(`[ConsumerPolicy] preferred layers skipped consumer=${consumer.id}: ${err.message}`);
  }
  try {
    await consumer.setPriority((entry.source || entry.appData?.source) === 'screen' ? 2 : 1);
  } catch {
    // setPriority is optional depending on transport/consumer state.
  }
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

function sanitizeRtpStatList(items) {
  return Array.isArray(items) ? items.slice(0, 8).map(item => asObject(item)) : [];
}

function sanitizeMediaStats(rawStats) {
  const data = asObject(rawStats);
  const sanitizeItems = items => (Array.isArray(items) ? items.slice(0, 48).map(raw => {
    const item = asObject(raw);
    return {
      source: shortString(item.source, 32),
      producerId: shortString(item.producerId, 128),
      id: shortString(item.id, 128),
      kind: shortString(item.kind, 16),
      error: shortString(item.error, 160),
      stats: sanitizeRtpStatList(item.stats),
    };
  }) : []);
  return {
    producers: sanitizeItems(data.producers),
    consumers: sanitizeItems(data.consumers),
  };
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
    platform: normalizeClientPlatform(data.platform),
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
    mediaStats: sanitizeMediaStats(data.mediaStats),
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
    score: Array.isArray(consumer.__chDiagnostics?.score) ? consumer.__chDiagnostics.score : [],
    preferredLayers: consumer.__chDiagnostics?.preferredLayers || null,
    currentLayers: consumer.__chDiagnostics?.currentLayers || null,
    scoreUpdatedAt: consumer.__chDiagnostics?.scoreUpdatedAt || null,
  }));
  const serverTransportList = Array.from(peer.transports.values())
    .map(publicTransportRecord)
    .filter(Boolean);
  const heartbeatAgeMs = peer.lastHeartbeatAt ? now - peer.lastHeartbeatAt : null;

  return {
    id,
    name: peer.locationName,
    appType: peer.appType || peer.telemetry?.appType || 'client',
    appVersion: peer.appVersion || peer.telemetry?.appVersion || '',
    platform: peer.platform || peer.telemetry?.platform || '',
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
    transports: {
      ...(peer.monitorState?.transports || {}),
      server: serverTransportList,
    },
    mediaStats: peer.monitorState?.mediaStats || {},
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
    serverIps,
    currentIp: config.announcedIp || serverIps[0] || config.listenIp || '',
    rtcPortRange: config.rtcPortRange,
    iceServerCount: (config.iceServers || []).length,
    bandwidthEstimate: bandwidthEstimateSnapshot(),
    systemState: getSystemStateSnapshot(),
  };
}

// ── アップデートファイル配信 ──────────────────────────────
// server-gui で選択されたフォルダ内のビルド済みパッケージを配布する。

function listUpdateFiles() {
  if (!updateDir || !fs.existsSync(updateDir)) return [];
  try {
    const files = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, relativeName);
          continue;
        }
        if (!entry.isFile() || !/\.(dmg|pkg|zip|exe|msi|appimage|deb|7z)$/i.test(entry.name)) continue;
        const stat = fs.statSync(fullPath);
        files.push({ name: relativeName, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    };
    walk(updateDir);
    return files;
  } catch (err) {
    console.error('[Updates] list failed:', err.message);
    return [];
  }
}

app.get('/updates', (_, res) => {
  res.json({ updateDir: updateDir || null, files: listUpdateFiles() });
});

app.get(/^\/updates\/(.+)$/, (req, res) => {
  if (!updateDir) return res.status(404).json({ error: 'update dir not configured' });
  let fileName = String(req.params[0] || '');
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    return res.status(400).json({ error: 'invalid file path' });
  }
  const relativePath = path.normalize(fileName).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.resolve(updateDir, relativePath);
  const root = path.resolve(updateDir);
  if (!relativePath || !filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file not found' });
  }
  res.download(filePath, path.basename(relativePath));
});

app.get('/health', (_, res) => res.json({ ...getStatsSnapshot(), debugLog: debugLogInfo() }));
app.get('/debug/log-info', (_, res) => res.json(debugLogInfo()));
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

function emitUpdateCommand(targetSockets, appType, { forced = false, reason = 'server-gui' } = {}) {
  const type = shortString(appType, 24);
  const sockets = Array.isArray(targetSockets) ? targetSockets : [];
  const recipientCount = sockets.length;
  sendAdminLog(`[Admin] updateCommand requested appType=${type || 'all'} forced=${!!forced} recipients=${recipientCount}`);
  if (recipientCount === 0) return;

  let completed = 0;
  let acknowledged = 0;
  for (const socket of sockets) {
    const peer = peers[socket.id] || {};
    const targetAppType = type && type !== 'all' ? type : (peer.appType || type);
    const packageInfo = packageForPlatform(targetAppType, peer.platform);
    const version = packageInfo?.version || systemState.latestVersions[targetAppType] || '';
    const payload = {
      appType: targetAppType,
      brand: SYSTEM_NAME,
      version,
      platform: peer.platform || '',
      packageInfo,
      forced: !!forced,
      reason,
      issuedAt: Date.now(),
    };

    socket.timeout(RESTART_ACK_TIMEOUT_MS).emit('updateCommand', payload, (err, response) => {
      completed += 1;
      if (!err && !response?.error) acknowledged += 1;
      if (completed === recipientCount) {
        const timedOut = recipientCount - acknowledged;
        const suffix = timedOut > 0 ? ` timeout=${timedOut}` : '';
        sendAdminLog(`[Admin] updateCommand ack=${acknowledged}/${recipientCount}${suffix}`);
      }
    });
  }
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

const viewerPresenceTimer = setInterval(broadcastViewerPresence, 2000);
viewerPresenceTimer.unref?.();

// ── Transport ─────────────────────────────────────────────

async function createWebRtcTransport(router, forceTcp = false) {
  const {
    listenIps,
    initialAvailableOutgoingBitrate,
    minimumAvailableOutgoingBitrate,
    maxSctpMessageSize,
  } = config.mediasoup.webRtcTransport;
  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: !forceTcp,
    enableTcp: true,
    preferUdp: !forceTcp,
    initialAvailableOutgoingBitrate,
    minimumAvailableOutgoingBitrate,
    maxSctpMessageSize,
  });
  return transport;
}

// ── Socket.io ────────────────────────────────────────────

io.on('connection', async socket => {
  console.log(`[+] connect  ${socket.id}`);
  appendDebugLog('socket.connected', {
    socketId: socket.id,
    remoteAddress: socket.handshake.address,
    userAgent: socket.handshake.headers?.['user-agent'] || '',
    transport: socket.conn?.transport?.name || '',
  });

  peers[socket.id] = {
    socket,
    locationName: '接続中...',
    appType: 'client',
    appVersion: '',
    clientInstanceId: '',
    platform: '',
    channelId: DEFAULT_CHANNELS[0].id,
    metadataReady: false,
    connectedAt: Date.now(),
    lastHeartbeatAt: null,
    rttMs: null,
    rttHistory: [],
    telemetry: null,
    deviceState: { devices: { video: [], audioInput: [], audioOutput: [] }, selectedDevices: {} },
    monitorState: {},
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    viewerPresenceActive: false,
    metadataTimer: null,
  };

  peers[socket.id].metadataTimer = setTimeout(() => {
    const peer = peers[socket.id];
    if (!peer || peer.metadataReady) return;
    console.warn(`[Peer] metadata timeout socket=${socket.id} remote=${socket.handshake.address}`);
    cleanupPeer(socket.id, 'metadata-timeout');
    try {
      socket.disconnect(true);
    } catch (err) {
      console.warn(`[Peer] failed to disconnect metadata-timeout socket=${socket.id}: ${err.message}`);
    }
  }, METADATA_TIMEOUT_MS);

  // ── 拠点名の設定 ──
  socket.on('setMetadata', (metadata = {}) => {
    const { locationName, appType, channelId, appVersion, clientInstanceId, platform } = asObject(metadata);
    if (peers[socket.id]) {
      const peer = peers[socket.id];
      const isFirstMetadata = !peer.metadataReady;
      peer.locationName = shortString(locationName || '不明', 128);
      if (appType) peer.appType = shortString(appType, 24);
      if (appVersion) peer.appVersion = shortString(appVersion, 48);
      if (clientInstanceId) peer.clientInstanceId = sanitizeClientInstanceId(clientInstanceId);
      if (platform) peer.platform = normalizeClientPlatform(platform);
      if (channelId) peer.channelId = normalizeChannelId(channelId);
      if (peer.metadataTimer) {
        clearTimeout(peer.metadataTimer);
        peer.metadataTimer = null;
      }
      replaceExistingClientInstance(socket, peer);
      peer.metadataReady = true;
      console.log(`[Meta] ${socket.id} → "${locationName}"`);
      appendDebugLog('peer.metadata', {
        socketId: socket.id,
        locationName: peer.locationName,
        appType: peer.appType,
        appVersion: peer.appVersion,
        clientInstanceId: peer.clientInstanceId,
        platform: peer.platform,
        channelId: peer.channelId,
        remoteAddress: socket.handshake.address,
      });
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
          platform: peer.platform,
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
    peer.platform = clean.platform || peer.platform || '';
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
      mediaStats: clean.mediaStats || {},
    };
    appendDebugLog('client.telemetry', telemetryDebugSummary(socket.id, peer, clean));
    broadcastViewerPresence();
    callback?.({ ok: true, serverTime: Date.now() });
  });

  // ── Router capabilities ──
  socket.on('getRouterRtpCapabilities', (_, callback) => {
    if (!router) return safeCallback(callback, { error: 'router not ready' });
    safeCallback(callback, router.rtpCapabilities);
  });

  // ── サーバー設定（ICE サーバーなど）──
  socket.on('getServerConfig', (_, callback) => {
    safeCallback(callback, {
      iceServers: config.iceServers || [],
      forceTcpMedia: isForceTcpMediaEnabled(),
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
      const direction = ['send', 'recv'].includes(asObject(payload).direction)
        ? asObject(payload).direction
        : 'unknown';
      const transport = await createWebRtcTransport(router, !!forceTcp);
      if (forceTcp) {
        console.log(`[Transport] TCP-only media transport created socket=${socket.id} direction=${direction}`);
      }
      peer.transports.set(transport.id, createTransportRecord(transport, { direction, forceTcp: !!forceTcp }));
      appendDebugLog('transport.created', {
        socketId: socket.id,
        locationName: peer.locationName,
        transportId: transport.id,
        direction,
        forceTcp: !!forceTcp,
        iceCandidates: transport.iceCandidates?.map(candidate => ({
          protocol: candidate.protocol,
          ip: candidate.ip,
          port: candidate.port,
          type: candidate.type,
          tcpType: candidate.tcpType || '',
        })) || [],
      });
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

  // ── Transport 接続 ──
  socket.on('connectTransport', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { transportId, dtlsParameters } = asObject(payload);
      const transport = transportFromRecord(peer.transports.get(transportId));
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      await transport.connect({ dtlsParameters });
      appendDebugLog('transport.connected', {
        socketId: socket.id,
        locationName: peer.locationName,
        transportId,
        dtlsState: transport.dtlsState || '',
        iceState: transport.iceState || '',
        selectedTuple: publicTuple(transport.iceSelectedTuple || transport.tuple),
      });
      safeCallback(callback, {});
    } catch (err) {
      appendDebugLog('transport.connect-error', { socketId: socket.id, error: err.message }, 'error');
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
      const transport = transportFromRecord(peer.transports.get(transportId));
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
        score: [],
        scoreUpdatedAt: null,
      });
      const producerEntry = peer.producers.get(producer.id);

      producer.on('score', score => {
        producerEntry.score = Array.isArray(score) ? score : [];
        producerEntry.scoreUpdatedAt = Date.now();
        appendDebugLog('producer.score', {
          socketId: socket.id,
          producerId: producer.id,
          kind: producer.kind,
          source,
          score: producerEntry.score,
        });
      });

      producer.on('transportclose', () => {
        closePeerProducer(socket.id, producer.id, {
          closeProducer: false,
          reason: 'transportclose',
        });
      });

      safeCallback(callback, { id: producer.id });
      appendDebugLog('producer.created', {
        socketId: socket.id,
        locationName: peer.locationName,
        producerId: producer.id,
        transportId,
        kind: producer.kind,
        source,
        channelId: peer.channelId,
        paused: producer.paused,
        rtpEncodings: rtpParameters?.encodings || [],
        rtpCodecs: rtpParameters?.codecs?.map(codec => ({
          mimeType: codec.mimeType,
          clockRate: codec.clockRate,
          channels: codec.channels,
        })) || [],
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
      appendDebugLog('producer.create-error', { socketId: socket.id, error: err.message }, 'error');
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
      const transport = transportFromRecord(peer.transports.get(transportId));
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      const owner = findProducerOwner(producerId);
      if (!owner) return safeCallback(callback, { error: 'producer not found' });
      if (owner.peerId === socket.id) return safeCallback(callback, { error: 'cannot consume own producer' });
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return safeCallback(callback, { error: 'cannot consume' });
      }
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
      consumer.__chDiagnostics = {
        producerId,
        score: [],
        preferredLayers: null,
        currentLayers: null,
        scoreUpdatedAt: null,
      };
      consumer.on('score', score => {
        consumer.__chDiagnostics.score = Array.isArray(score) ? score : [];
        consumer.__chDiagnostics.scoreUpdatedAt = Date.now();
        appendDebugLog('consumer.score', {
          socketId: socket.id,
          consumerId: consumer.id,
          producerId,
          kind: consumer.kind,
          score: consumer.__chDiagnostics.score,
        });
      });
      consumer.on('layerschange', layers => {
        consumer.__chDiagnostics.currentLayers = layers || null;
        appendDebugLog('consumer.layers', {
          socketId: socket.id,
          consumerId: consumer.id,
          producerId,
          kind: consumer.kind,
          layers: layers || null,
        });
      });
      await applyConsumerReliabilityPolicy(consumer, owner.entry);

      peer.consumers.set(consumer.id, consumer);

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
      appendDebugLog('consumer.created', {
        socketId: socket.id,
        locationName: peer.locationName,
        consumerId: consumer.id,
        producerId,
        producerOwnerSocketId: owner.peerId,
        producerOwnerName: owner.peer.locationName,
        kind: consumer.kind,
        source: owner.entry.source || owner.entry.appData?.source || '',
        paused: consumer.paused,
        transportId,
      });
    } catch (err) {
      console.error('[consume]', err);
      appendDebugLog('consumer.create-error', { socketId: socket.id, error: err.message }, 'error');
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
      appendDebugLog('consumer.resumed', {
        socketId: socket.id,
        locationName: peer.locationName,
        consumerId,
        producerId: consumer.producerId,
        kind: consumer.kind,
      });
      safeCallback(callback, {});
    } catch (err) {
      appendDebugLog('consumer.resume-error', { socketId: socket.id, error: err.message }, 'error');
      safeCallback(callback, { error: err.message });
    }
  });

  // ── ICE restart（VPN/拠点間の経路切替・一時断からの復旧）──
  socket.on('restartIce', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      const { transportId } = asObject(payload);
      const transport = transportFromRecord(peer.transports.get(transportId));
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      const iceParameters = await transport.restartIce();
      appendDebugLog('transport.ice-restart', {
        socketId: socket.id,
        locationName: peer.locationName,
        transportId,
        iceState: transport.iceState || '',
        dtlsState: transport.dtlsState || '',
      });
      safeCallback(callback, { iceParameters });
    } catch (err) {
      appendDebugLog('transport.ice-restart-error', { socketId: socket.id, error: err.message }, 'error');
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
      appendDebugLog('producer.paused', {
        socketId: socket.id,
        locationName: peers[socket.id]?.locationName || '',
        producerId,
        kind: entry.kind,
        source: entry.source || entry.appData?.source || '',
      });
      socket.broadcast.emit('producerPaused', { producerId, socketId: socket.id });
      callback?.({});
    } catch (err) {
      appendDebugLog('producer.pause-error', { socketId: socket.id, error: err.message }, 'error');
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
      appendDebugLog('producer.resumed', {
        socketId: socket.id,
        locationName: peers[socket.id]?.locationName || '',
        producerId,
        kind: entry.kind,
        source: entry.source || entry.appData?.source || '',
      });
      socket.broadcast.emit('producerResumed', { producerId, socketId: socket.id });
      callback?.({});
    } catch (err) {
      appendDebugLog('producer.resume-error', { socketId: socket.id, error: err.message }, 'error');
      callback?.({ error: err.message });
    }
  });

  // ── Producer 終了（画面共有停止など）──
  socket.on('closeProducer', (payload = {}, callback) => {
    try {
      const { producerId } = asObject(payload);
      if (!closePeerProducer(socket.id, producerId, { reason: 'client-close' })) {
        return callback?.({ error: 'not found' });
      }
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
  socket.on('disconnect', reason => {
    console.log(`[-] disconnect ${socket.id}`);
    appendDebugLog('socket.disconnected', {
      socketId: socket.id,
      locationName: peers[socket.id]?.locationName || '',
      appType: peers[socket.id]?.appType || '',
      reason,
      producers: peers[socket.id]?.producers?.size || 0,
      consumers: peers[socket.id]?.consumers?.size || 0,
      transports: peers[socket.id]?.transports?.size || 0,
    });
    cleanupPeer(socket.id);
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
  }, STATS_INTERVAL_MS);

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
      emitUpdateCommand(sockets, targetAppType, { forced: true, reason: 'server-gui' });
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
  appendDebugLog('server.shutdown', { signal, peers: Object.keys(peers).length }, 'warn');
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
  appendDebugLog('process.unhandled-rejection', { error: err?.stack || err?.message || String(err) }, 'error');
});
process.on('uncaughtException', err => {
  console.error('[Process] uncaughtException:', err);
  appendDebugLog('process.uncaught-exception', { error: err?.stack || err?.message || String(err) }, 'error');
  process.exit(1);
});

// ── 起動 ──────────────────────────────────────────────────

async function run() {
  await createWorkers();
  await createRouter();
  server.listen(config.listenPort, config.listenIp, () => {
    console.log(`[SFU] listening on ${config.listenIp}:${config.listenPort}`);
    const info = debugLogInfo();
    console.log(`[DebugLog] writing JSONL logs to ${info.file}`);
    appendDebugLog('server.started', {
      version: SERVER_APP_VERSION,
      listenIp: config.listenIp,
      listenPort: config.listenPort,
      announcedIp: config.announcedIp,
      rtcPortRange: config.rtcPortRange,
      forceTcpMedia: config.forceTcpMedia,
      iceServersConfigured: config.iceServers.length,
      debugLog: info,
    });
  });
}

run().catch(err => {
  console.error('[SFU] fatal:', err);
  appendDebugLog('server.fatal', { error: err?.stack || err?.message || String(err) }, 'error');
  process.exit(1);
});
