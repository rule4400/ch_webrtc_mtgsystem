/**
 * WebRTC SFU Server (mediasoup)
 *
 * 拠点間の常時接続映像・音声共有サーバー。
 *
 * 追加シグナリングイベント:
 *   Client → Server:
 *     setMetadata({ locationName })       拠点名を登録
 *     pauseProducer({ producerId })       カメラ/マイク OFF を通知
 *     resumeProducer({ producerId })      カメラ/マイク ON を通知
 *
 *   Server → Client:
 *     newProducer({ producerId, socketId, locationName, kind, paused })
 *     producerClosed({ producerId, socketId })
 *     producerPaused({ producerId, socketId })
 *     producerResumed({ producerId, socketId })
 *     peerDisconnected({ socketId })
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const config = require('./config');

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
    locationName: shortString(data.locationName || '', 128),
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

function getPeerClientSnapshot(id, peer, now = Date.now()) {
  const producerList = Array.from(peer.producers.entries()).map(([producerId, { kind, paused }]) => ({
    producerId,
    kind,
    paused,
  }));
  const consumerList = Array.from(peer.consumers.entries()).map(([consumerId, consumer]) => ({
    consumerId,
    producerId: consumer.producerId,
    kind: consumer.kind,
    paused: consumer.paused,
    closed: consumer.closed,
  }));
  const heartbeatAgeMs = peer.lastHeartbeatAt ? now - peer.lastHeartbeatAt : null;

  return {
    id,
    name: peer.locationName,
    appType: peer.appType || peer.telemetry?.appType || 'client',
    remoteAddress: peer.socket.handshake.address,
    connectedAt: peer.connectedAt,
    heartbeatAgeMs,
    health: healthStatus(peer, now),
    rttMs: peer.rttMs ?? null,
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
    announcedIp: config.announcedIp,
    rtcPortRange: config.rtcPortRange,
    iceServerCount: (config.iceServers || []).length,
  };
}

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
  const { listenIps, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport;
  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: !forceTcp,
    enableTcp: true,
    preferUdp: !forceTcp,
    initialAvailableOutgoingBitrate,
  });
  transport.on('dtlsstatechange', state => { if (state === 'closed') transport.close(); });
  transport.on('close', () => console.log('[Transport] closed'));
  return transport;
}

// ── Socket.io ────────────────────────────────────────────

io.on('connection', async socket => {
  console.log(`[+] connect  ${socket.id}`);

  peers[socket.id] = {
    socket,
    locationName: '接続中...',
    appType: 'client',
    connectedAt: Date.now(),
    lastHeartbeatAt: null,
    rttMs: null,
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
    const { locationName, appType } = asObject(metadata);
    if (peers[socket.id]) {
      peers[socket.id].locationName = shortString(locationName || '不明', 128);
      if (appType) peers[socket.id].appType = shortString(appType, 24);
      console.log(`[Meta] ${socket.id} → "${locationName}"`);
    }
  });

  socket.on('clientTelemetry', (report = {}, callback) => {
    const peer = peers[socket.id];
    if (!peer) return callback?.({ error: 'peer not found' });
    const clean = sanitizeTelemetry(report);

    peer.lastHeartbeatAt = Date.now();
    peer.telemetry = clean;
    peer.appType = clean.appType || peer.appType || 'client';
    if (clean.locationName) peer.locationName = clean.locationName;
    peer.rttMs = Number.isFinite(clean.connection?.telemetryRttMs)
      ? Math.round(clean.connection.telemetryRttMs)
      : peer.rttMs;
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

  // ── サーバー設定（ICE サーバーなど）──
  socket.on('getServerConfig', (_, callback) => {
    safeCallback(callback, { iceServers: config.iceServers || [] });
  });

  // ── Transport 生成 ──
  socket.on('createWebRtcTransport', async (payload = {}, callback) => {
    try {
      const peer = getPeerForRequest(socket, callback);
      if (!peer) return;
      if (!router) return safeCallback(callback, { error: 'router not ready' });
      const { forceTcp } = asObject(payload);
      const transport = await createWebRtcTransport(router, !!forceTcp);
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
      const { transportId, kind, rtpParameters, appData } = asObject(payload);
      if (!['audio', 'video'].includes(kind)) return safeCallback(callback, { error: 'invalid producer kind' });
      const transport = peer.transports.get(transportId);
      if (!transport) return safeCallback(callback, { error: 'transport not found' });
      const producer = await transport.produce({ kind, rtpParameters, appData });

      peer.producers.set(producer.id, { producer, kind, paused: false });

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
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return safeCallback(callback, { error: 'cannot consume' });
      }
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });

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
    } catch (err) {
      console.error('[consume]', err);
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
      for (const [producerId, { kind, paused }] of peerInfo.producers.entries()) {
        list.push({
          producerId,
          socketId:     peerId,
          locationName: peerInfo.locationName,
          kind,
          paused,
        });
      }
    }
    safeCallback(callback, list);
  });

  // ── 全ピア状態を返す（1秒ポーリング用）──
  socket.on('getPeers', (_, callback) => {
    const list = [];
    for (const [peerId, peerInfo] of Object.entries(peers)) {
      const producers = [];
      for (const [producerId, { kind, paused }] of peerInfo.producers.entries()) {
        producers.push({ producerId, kind, paused });
      }
      list.push({
        socketId:     peerId,
        locationName: peerInfo.locationName,
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

  // ── Admin: クライアントキック ──
  socket.on('forceRestart', () => {
    emitRestartCommand(socket.broadcast, Math.max(io.sockets.sockets.size - 1, 0), `socket:${socket.id}`);
  });

  // ── 切断 ──
  socket.on('disconnect', () => {
    console.log(`[-] disconnect ${socket.id}`);
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
  }, 1000);

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
    } else if (msg.type === 'refresh-client-devices' && socketId) {
      emitTargetCommand(socketId, 'adminRefreshDevices', {}, 'refresh-devices');
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
