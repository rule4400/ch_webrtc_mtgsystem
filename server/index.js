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
const io = new Server(server, { cors: { origin: '*' } });

let workers = [];
let nextWorkerIdx = 0;
let router;
let routerWorker;        // router が載っている worker
let recovering = false;  // 二重リカバリ防止

/**
 * peers[socket.id] = {
 *   socket,
 *   locationName: string,
 *   transports: Map<transportId, Transport>,
 *   producers: Map<producerId, { producer, kind, paused }>,
 *   consumers: Map<consumerId, Consumer>,
 * }
 */
const peers = {};

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

function getStatsSnapshot() {
  let totalProducers = 0;
  let totalConsumers = 0;
  const clients = [];

  for (const [id, peer] of Object.entries(peers)) {
    totalProducers += peer.producers.size;
    totalConsumers += peer.consumers.size;
    clients.push({
      id,
      name: peer.locationName,
      producers: peer.producers.size,
      consumers: peer.consumers.size,
    });
  }

  return {
    status: recovering ? 'recovering' : 'ok',
    uptimeSec: Math.round(process.uptime()),
    memory: process.memoryUsage().rss,
    peerCount: Object.keys(peers).length,
    totalProducers,
    totalConsumers,
    clients,
    workerPids: workers.map(w => w.pid),
    routerWorkerPid: routerWorker?.pid || null,
    announcedIp: config.announcedIp,
    rtcPortRange: config.rtcPortRange,
    iceServerCount: (config.iceServers || []).length,
  };
}

app.get('/health', (_, res) => res.json(getStatsSnapshot()));

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
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };

  // ── 拠点名の設定 ──
  socket.on('setMetadata', ({ locationName }) => {
    if (peers[socket.id]) {
      peers[socket.id].locationName = locationName || '不明';
      console.log(`[Meta] ${socket.id} → "${locationName}"`);
    }
  });

  // ── Router capabilities ──
  socket.on('getRouterRtpCapabilities', (_, callback) => {
    callback(router.rtpCapabilities);
  });

  // ── サーバー設定（ICE サーバーなど）──
  socket.on('getServerConfig', (_, callback) => {
    callback({ iceServers: config.iceServers || [] });
  });

  // ── Transport 生成 ──
  socket.on('createWebRtcTransport', async ({ forceTcp }, callback) => {
    try {
      const transport = await createWebRtcTransport(router, !!forceTcp);
      peers[socket.id].transports.set(transport.id, transport);
      callback({
        params: {
          id:              transport.id,
          iceParameters:   transport.iceParameters,
          iceCandidates:   transport.iceCandidates,
          dtlsParameters:  transport.dtlsParameters,
        },
      });
    } catch (err) {
      console.error('[createWebRtcTransport]', err);
      callback({ error: err.message });
    }
  });

  // ── Transport 接続 ──
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = peers[socket.id].transports.get(transportId);
      if (!transport) return callback({ error: 'transport not found' });
      await transport.connect({ dtlsParameters });
      callback({});
    } catch (err) {
      callback({ error: err.message });
    }
  });

  // ── Produce（映像/音声の送信開始）──
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const transport = peers[socket.id].transports.get(transportId);
      if (!transport) return callback({ error: 'transport not found' });
      const producer = await transport.produce({ kind, rtpParameters, appData });

      peers[socket.id].producers.set(producer.id, { producer, kind, paused: false });

      producer.on('transportclose', () => {
        producer.close();
        peers[socket.id]?.producers.delete(producer.id);
      });

      callback({ id: producer.id });

      // 他の全ピアへ通知（拠点名・kind・paused 状態も含む）
      socket.broadcast.emit('newProducer', {
        producerId:    producer.id,
        socketId:      socket.id,
        locationName:  peers[socket.id].locationName,
        kind:          producer.kind,
        paused:        false,
      });

    } catch (err) {
      console.error('[produce]', err);
      callback({ error: err.message });
    }
  });

  // ── Consume（他拠点の受信開始）──
  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const transport = peers[socket.id].transports.get(transportId);
      if (!transport) return callback({ error: 'transport not found' });
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'cannot consume' });
      }
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });

      peers[socket.id].consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        consumer.close();
        peers[socket.id]?.consumers.delete(consumer.id);
      });
      consumer.on('producerclose', () => {
        socket.emit('producerClosed', { producerId });
        consumer.close();
        peers[socket.id]?.consumers.delete(consumer.id);
      });

      callback({
        params: {
          id:            consumer.id,
          producerId:    consumer.producerId,
          kind:          consumer.kind,
          rtpParameters: consumer.rtpParameters,
        },
      });
    } catch (err) {
      console.error('[consume]', err);
      callback({ error: err.message });
    }
  });

  // ── Consumer 再生開始 ──
  socket.on('resume', async ({ consumerId }, callback) => {
    try {
      const consumer = peers[socket.id].consumers.get(consumerId);
      if (!consumer) return callback({ error: 'consumer not found' });
      await consumer.resume();
      callback({});
    } catch (err) {
      callback({ error: err.message });
    }
  });

  // ── ICE restart（VPN/拠点間の経路切替・一時断からの復旧）──
  socket.on('restartIce', async ({ transportId }, callback) => {
    try {
      const transport = peers[socket.id]?.transports.get(transportId);
      if (!transport) return callback({ error: 'transport not found' });
      const iceParameters = await transport.restartIce();
      callback({ iceParameters });
    } catch (err) {
      callback({ error: err.message });
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
    callback(list);
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
    callback(list);
  });

  // ── カメラ/マイク OFF（Producer 一時停止）──
  socket.on('pauseProducer', async ({ producerId }, callback) => {
    try {
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
  socket.on('resumeProducer', async ({ producerId }, callback) => {
    try {
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
    socket.broadcast.emit('restartCommand');
  });

  // ── 切断 ──
  socket.on('disconnect', () => {
    console.log(`[-] disconnect ${socket.id}`);
    const peer = peers[socket.id];
    if (peer) resetPeerMedia(peer);
    delete peers[socket.id];
    // 全拠点に切断を通知
    io.emit('peerDisconnected', { socketId: socket.id });
  });
});

// ── Admin IPC（GUIラッパー向け）────────────────────────

if (process.send) {
  let lastCpuUsage = process.cpuUsage();

  setInterval(() => {
    const cu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const cpuPercent = ((cu.user + cu.system) / 1_000 / 2000 * 100).toFixed(1);
    const snapshot = getStatsSnapshot();
    process.send({
      type: 'stats',
      data: { ...snapshot, cpu: cpuPercent },
    });
  }, 2000);

  process.on('message', msg => {
    if (msg.type === 'kick' && msg.socketId) {
      io.sockets.sockets.get(msg.socketId)?.disconnect(true);
    } else if (msg.type === 'restart-all') {
      io.emit('restartCommand');
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
