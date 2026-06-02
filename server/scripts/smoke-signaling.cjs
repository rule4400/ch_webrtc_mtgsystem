#!/usr/bin/env node

const { fork } = require('child_process');
const net = require('net');
const path = require('path');

const { io } = require(path.resolve(__dirname, '..', '..', 'client', 'node_modules', 'socket.io-client'));

const rootDir = path.resolve(__dirname, '..', '..');
const serverDir = path.join(rootDir, 'server');
const serverEntry = path.join(serverDir, 'index.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function onceWithTimeout(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${event} timeout`));
    }, timeoutMs);
    const handler = (...args) => {
      cleanup();
      resolve(args);
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.off?.(event, handler);
      target.removeListener?.(event, handler);
    };
    target.on(event, handler);
  });
}

function emitAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeoutMs);
    socket.emit(event, payload, response => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function run() {
  const httpPort = await getFreePort();
  const rtcBase = 42000 + Math.floor(Math.random() * 1000);
  const child = fork(serverEntry, [], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(httpPort),
      ANNOUNCED_IP: '127.0.0.1',
      RTC_MIN_PORT: String(rtcBase),
      RTC_MAX_PORT: String(rtcBase + 20),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let socket;
  let viewerSocket;
  const adminLogs = [];
  const stats = [];

  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('message', message => {
    if (message?.type === 'admin-log') adminLogs.push(message.data);
    if (message?.type === 'stats') stats.push(message.data);
  });

  try {
    await Promise.race([
      onceWithTimeout(child.stdout, 'data', 12000).then(async ([chunk]) => {
        if (!chunk.toString().includes('[SFU] listening')) {
          while (true) {
            const [next] = await onceWithTimeout(child.stdout, 'data', 12000);
            if (next.toString().includes('[SFU] listening')) return;
          }
        }
      }),
      onceWithTimeout(child, 'exit', 12000).then(([code]) => {
        throw new Error(`server exited before ready: ${code}`);
      }),
    ]);

    socket = io(`http://127.0.0.1:${httpPort}`, { transports: ['websocket'], timeout: 3000 });
    await onceWithTimeout(socket, 'connect', 5000);

    socket.emit('setMetadata', { locationName: 'smoke-client', appType: 'client' });
    const viewerPresenceEvents = [];
    socket.on('viewerPresence', payload => viewerPresenceEvents.push(payload));

    const telemetry = await emitAck(socket, 'clientTelemetry', {
      appType: 'client',
      locationName: 'smoke-client',
      devices: {
        video: [{ deviceId: 'cam1', kind: 'videoinput', label: 'Camera 1' }],
        audioInput: [{ deviceId: 'mic1', kind: 'audioinput', label: 'Mic 1' }],
        audioOutput: [{ deviceId: 'spk1', kind: 'audiooutput', label: 'Speaker 1' }],
      },
      selectedDevices: { video: 'cam1', audioInput: 'mic1', audioOutput: 'spk1' },
      localMedia: {
        cameraEnabled: true,
        micEnabled: true,
        speakerMuted: false,
        video: { readyState: 'live' },
        audio: { readyState: 'live' },
      },
      remoteMonitor: { peerCount: 0, receivingVideoCount: 0, receivingAudioCount: 0, peers: [] },
      connection: { telemetryRttMs: 3, appStatus: 'connected' },
    });
    if (!telemetry?.ok) throw new Error('telemetry ack failed');

    viewerSocket = io(`http://127.0.0.1:${httpPort}`, { transports: ['websocket'], timeout: 3000 });
    await onceWithTimeout(viewerSocket, 'connect', 5000);
    viewerSocket.emit('setMetadata', { locationName: 'smoke-viewer', appType: 'viewer' });
    const viewerTelemetry = await emitAck(viewerSocket, 'clientTelemetry', {
      appType: 'viewer',
      locationName: 'smoke-viewer',
      devices: { video: [], audioInput: [], audioOutput: [] },
      selectedDevices: {},
      localMedia: { cameraEnabled: false, micEnabled: false, speakerMuted: false },
      remoteMonitor: {
        peerCount: 1,
        receivingVideoCount: 1,
        receivingAudioCount: 0,
        peers: [{
          socketId: socket.id,
          name: 'smoke-client',
          receivingVideo: true,
          receivingAudio: false,
        }],
      },
      connection: { telemetryRttMs: 4, appStatus: 'connected' },
    });
    if (!viewerTelemetry?.ok) throw new Error('viewer telemetry ack failed');
    await wait(250);
    if (!viewerPresenceEvents.some(event => event?.active === true)) {
      throw new Error('viewerPresence active event was not delivered to client');
    }

    const caps = await emitAck(socket, 'getRouterRtpCapabilities', {});
    if (!Array.isArray(caps?.codecs)) throw new Error('router capabilities missing');

    const malformed = await emitAck(socket, 'createWebRtcTransport', null);
    if (!malformed?.params?.id) throw new Error(`transport creation failed: ${malformed?.error || 'unknown'}`);

    const badConnect = await emitAck(socket, 'connectTransport', { transportId: 'missing', dtlsParameters: {} });
    if (badConnect?.error !== 'transport not found') throw new Error('invalid transport did not return a controlled error');

    let deviceCommandOk = false;
    socket.on('adminSetDevice', (payload, ack) => {
      deviceCommandOk = payload.kind === 'video' && payload.deviceId === 'cam1';
      ack({ ok: true });
    });
    child.send({ type: 'set-client-device', socketId: socket.id, kind: 'video', deviceId: 'cam1' });
    await wait(250);
    if (!deviceCommandOk) throw new Error('adminSetDevice was not delivered');

    let mediaStateCommandOk = false;
    socket.on('adminSetMediaState', (payload, ack) => {
      mediaStateCommandOk = payload.kind === 'mic' && payload.enabled === false;
      ack({ ok: true });
    });
    child.send({ type: 'set-client-media-state', socketId: socket.id, kind: 'mic', enabled: false });
    await wait(250);
    if (!mediaStateCommandOk) throw new Error('adminSetMediaState was not delivered');

    let restartOk = false;
    socket.on('restartCommand', (_payload, ack) => {
      restartOk = true;
      ack?.({ ok: true, socketId: socket.id, receivedAt: Date.now() });
    });
    child.send({ type: 'restart-client', socketId: socket.id });
    await wait(250);
    if (!restartOk) throw new Error('restartCommand was not delivered');

    const health = await fetch(`http://127.0.0.1:${httpPort}/health`).then(response => response.json());
    const healthClient = health.clients?.find(client => client.id === socket.id);
    if (healthClient?.health !== 'healthy') throw new Error('health snapshot did not include healthy client');
    if (healthClient?.viewerPresence !== true) throw new Error('health snapshot did not include viewer presence');

    viewerSocket.disconnect();
    viewerSocket = null;
    await wait(350);
    if (!viewerPresenceEvents.some(event => event?.active === false)) {
      throw new Error('viewerPresence inactive event was not delivered after viewer disconnect');
    }

    await wait(1100);
    if (!stats.some(snapshot => snapshot.clients?.some(client => client.id === socket.id))) {
      throw new Error('stats IPC did not include client snapshot');
    }
    if (!adminLogs.some(log => log.includes('restartCommand ack=1/1'))) {
      throw new Error('restart acknowledgement log missing');
    }

    console.log('[smoke] signaling, telemetry, admin commands ok');
  } finally {
    viewerSocket?.disconnect();
    socket?.disconnect();
    child.kill('SIGTERM');
    await wait(300);
  }
}

run().catch(error => {
  console.error(`[smoke] ${error.stack || error.message}`);
  process.exit(1);
});
