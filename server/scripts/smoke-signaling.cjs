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

    const systemStateEvents = [];
    socket.on('systemStateUpdated', payload => systemStateEvents.push(payload));
    const peerChannelEvents = [];
    socket.on('peerChannelChanged', payload => peerChannelEvents.push(payload));

    socket.emit('setMetadata', { locationName: 'smoke-client', appType: 'client', appVersion: '0.3.3', channelId: 'general' });
    const viewerPresenceEvents = [];
    socket.on('viewerPresence', payload => viewerPresenceEvents.push(payload));

    const systemState = await emitAck(socket, 'getSystemState', {});
    if (!Array.isArray(systemState.channels) || systemState.channels.length === 0) {
      throw new Error('system state did not include channels');
    }

    child.send({
      type: 'set-system-state',
      state: {
        channels: [{ id: 'general', name: '一般' }, { id: 'ops', name: 'Ops' }],
        latestVersions: { client: '0.3.3' },
        updatePackages: { client: { version: '0.3.3', url: 'https://example.com/client' } },
      },
    });
    await wait(250);
    if (!systemStateEvents.some(event => event.channels?.some(channel => channel.id === 'ops'))) {
      throw new Error('systemStateUpdated with new channels was not delivered');
    }

    const channelAck = await emitAck(socket, 'setChannel', { channelId: 'ops' });
    if (channelAck?.channelId !== 'ops') throw new Error('setChannel ack failed');
    await wait(100);
    if (!peerChannelEvents.some(event => event.socketId === socket.id && event.channelId === 'ops')) {
      throw new Error('peerChannelChanged was not delivered');
    }

    const createdChannel = await emitAck(socket, 'createChannel', { name: '緊急連絡' });
    const createdChannelId = createdChannel?.channel?.id;
    if (!createdChannel?.ok || !createdChannelId) throw new Error('createChannel ack failed');

    const updatedChannel = await emitAck(socket, 'updateChannel', { channelId: createdChannelId, name: '緊急連絡改' });
    if (!updatedChannel?.ok || updatedChannel.channel?.name !== '緊急連絡改') {
      throw new Error('updateChannel ack failed');
    }

    const moveAck = await emitAck(socket, 'movePeerToChannel', { targetSocketId: socket.id, channelId: createdChannelId });
    if (!moveAck?.ok || moveAck.channelId !== createdChannelId) throw new Error('movePeerToChannel ack failed');

    const deleteAck = await emitAck(socket, 'deleteChannel', { channelId: createdChannelId });
    if (!deleteAck?.ok || deleteAck.deletedChannelId !== createdChannelId) throw new Error('deleteChannel ack failed');

    const restoreChannelAck = await emitAck(socket, 'setChannel', { channelId: 'ops' });
    if (restoreChannelAck?.channelId !== 'ops') throw new Error('setChannel restore ack failed');

    const telemetry = await emitAck(socket, 'clientTelemetry', {
      appType: 'client',
      appVersion: '0.3.3',
      locationName: 'smoke-client',
      channelId: 'ops',
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
    viewerSocket.emit('setMetadata', { locationName: 'smoke-viewer', appType: 'viewer', appVersion: '0.1.0' });
    const viewerTelemetry = await emitAck(viewerSocket, 'clientTelemetry', {
      appType: 'viewer',
      appVersion: '0.1.0',
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

    let peerCallOk = false;
    viewerSocket.on('incomingCall', (payload, ack) => {
      peerCallOk =
        payload.fromSocketId === socket.id &&
        payload.fromName === 'smoke-client' &&
        payload.fromChannelId === 'ops' &&
        payload.fromChannelName === 'Ops';
      ack?.({ ok: true });
    });
    const callAck = await emitAck(socket, 'callPeer', { targetSocketId: viewerSocket.id });
    if (!callAck?.ok) throw new Error('callPeer ack failed');
    await wait(250);
    if (!peerCallOk) throw new Error('incomingCall was not delivered to target peer');

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

    let adminCallOk = false;
    socket.on('incomingCall', (payload, ack) => {
      adminCallOk =
        payload.fromAppType === 'server-gui' &&
        payload.fromName === 'サーバー管理画面' &&
        !payload.fromChannelId;
      ack?.({ ok: true });
    });
    child.send({ type: 'call-client', socketId: socket.id });
    await wait(250);
    if (!adminCallOk) throw new Error('admin incomingCall was not delivered');

    let restartOk = false;
    socket.on('restartCommand', (_payload, ack) => {
      restartOk = true;
      ack?.({ ok: true, socketId: socket.id, receivedAt: Date.now() });
    });
    child.send({ type: 'restart-client', socketId: socket.id });
    await wait(250);
    if (!restartOk) throw new Error('restartCommand was not delivered');

    let updateOk = false;
    socket.on('updateCommand', (payload, ack) => {
      updateOk = payload.appType === 'client' && payload.version === '0.3.3';
      ack?.({ ok: true, socketId: socket.id, receivedAt: Date.now() });
    });
    child.send({ type: 'force-update', appType: 'client' });
    await wait(250);
    if (!updateOk) throw new Error('updateCommand was not delivered');

    const health = await fetch(`http://127.0.0.1:${httpPort}/health`).then(response => response.json());
    const healthClient = health.clients?.find(client => client.id === socket.id);
    if (healthClient?.health !== 'healthy') throw new Error('health snapshot did not include healthy client');
    if (healthClient?.viewerPresence !== true) throw new Error('health snapshot did not include viewer presence');
    if (healthClient?.channelId !== 'ops') throw new Error('health snapshot did not include client channel');
    if (health.systemState?.latestVersions?.client !== '0.3.3') throw new Error('health snapshot did not include systemState');

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
