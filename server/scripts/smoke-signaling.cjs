#!/usr/bin/env node

const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { io } = require('socket.io-client');

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

async function expectSocketRejected(url, options, label) {
  const candidate = io(url, { ...options, reconnection: false });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${label} rejection timeout`));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        candidate.off('connect', onConnect);
        candidate.off('connect_error', onConnectError);
      };
      const onConnect = () => {
        cleanup();
        reject(new Error(`${label} unexpectedly connected`));
      };
      const onConnectError = () => {
        cleanup();
        resolve();
      };
      candidate.once('connect', onConnect);
      candidate.once('connect_error', onConnectError);
    });
  } finally {
    candidate.disconnect();
  }
}

async function run() {
  const httpPort = await getFreePort();
  const rtcBase = 42000 + Math.floor(Math.random() * 1000);
  const smokeAuthToken = 'smoke-shared-token-not-for-production';
  const smokeAdminToken = 'smoke-admin-token-not-for-production';
  const smokeRecordingToken = 'smoke-recording-token-not-for-production';
  const recordingFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-recording-http-smoke-'));
  const recordingSettingsFile = path.join(recordingFixtureRoot, 'recording-settings.json');
  const recordingsDir = path.join(recordingFixtureRoot, 'recordings');
  const recordingDbDir = path.join(recordingFixtureRoot, 'recording-db');
  const updatesDir = path.join(recordingFixtureRoot, 'updates');
  const ringtonesDir = path.join(recordingFixtureRoot, 'ringtones');
  const updateName = '000-primary.zip';
  const updatePath = path.join(updatesDir, updateName);
  const updateBytes = Buffer.alloc(1024 * 1024, 0x41);
  updateBytes.write('SAFE-UPDATE-INODE', 0, 'utf8');
  const ringtoneName = 'notice.mp3';
  const ringtoneBytes = Buffer.from('safe-ringtone-bytes');
  const publishedOutsidePath = path.join(recordingFixtureRoot, 'published-outside-secret');
  const recordingDate = '2026-08-31';
  const recordingId = `tokyo~camera~${recordingDate}~1788145200000~smoketest`;
  const recordingRelativePath = path.join('tokyo', 'camera', recordingDate, '120000_smoketest.webm');
  const recordingMediaPath = path.join(recordingsDir, recordingRelativePath);
  const recordingBytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  fs.mkdirSync(path.dirname(recordingMediaPath), { recursive: true });
  fs.mkdirSync(path.join(recordingDbDir, 'segments', 'tokyo__camera'), { recursive: true });
  fs.mkdirSync(updatesDir, { recursive: true });
  fs.mkdirSync(ringtonesDir, { recursive: true });
  fs.writeFileSync(recordingMediaPath, recordingBytes);
  fs.writeFileSync(updatePath, updateBytes);
  fs.writeFileSync(path.join(ringtonesDir, ringtoneName), ringtoneBytes);
  fs.writeFileSync(publishedOutsidePath, 'MUST-NOT-BE-PUBLISHED');
  for (let index = 0; index < 270; index += 1) {
    fs.writeFileSync(path.join(updatesDir, `package-${String(index).padStart(3, '0')}.zip`), 'fixture');
  }
  fs.writeFileSync(recordingSettingsFile, JSON.stringify({
    schemaVersion: 1,
    enabled: false,
    recordingsDir,
    dbDir: recordingDbDir,
    stagingDir: path.join(recordingFixtureRoot, 'staging'),
  }));
  fs.writeFileSync(
    path.join(recordingDbDir, 'segments', 'tokyo__camera', `${recordingDate}.json`),
    JSON.stringify({
      locKey: 'tokyo',
      source: 'camera',
      date: recordingDate,
      segments: [{
        id: recordingId,
        startMs: 1788145200000,
        durationMs: 5000,
        file: recordingRelativePath.split(path.sep).join('/'),
        size: recordingBytes.length,
        codec: 'vp8',
        audio: false,
        status: 'ready',
      }],
    }),
  );
  const socketOptions = {
    transports: ['websocket'],
    timeout: 3000,
    auth: { token: smokeAuthToken },
  };
  const child = fork(serverEntry, [], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(httpPort),
      ANNOUNCED_IP: '127.0.0.1',
      RTC_MIN_PORT: String(rtcBase),
      RTC_MAX_PORT: String(rtcBase + 20),
      SFU_AUTH_TOKEN: smokeAuthToken,
      SFU_ADMIN_TOKEN: smokeAdminToken,
      RECORDING_ACCESS_TOKEN: smokeRecordingToken,
      RECORDING_SETTINGS_FILE: recordingSettingsFile,
      RECORDING_QUERY_CLIENT_MAX: '8',
      RINGTONES_DIR: ringtonesDir,
      SFU_REQUIRE_AUTH: '1',
      SFU_TRUST_PROXY: 'loopback',
      UPDATE_DIR: updatesDir,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let socket;
  let targetSocket;
  let viewerSocket;
  const adminLogs = [];
  const stats = [];
  const systemStateChangedMessages = [];
  const recordingSettingsChangedMessages = [];

  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('message', message => {
    if (message?.type === 'admin-log') adminLogs.push(message.data);
    if (message?.type === 'stats') stats.push(message.data);
    if (message?.type === 'system-state-changed') systemStateChangedMessages.push(message);
    if (message?.type === 'recording-settings-changed') recordingSettingsChangedMessages.push(message);
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

    await expectSocketRejected(`http://127.0.0.1:${httpPort}`, {
      ...socketOptions,
      extraHeaders: { Origin: 'https://evil.example' },
    }, 'disallowed websocket Origin');

    // Electron の file:// renderer は環境により Origin:null となる。
    // Origin 無しのnative client（直後の通常接続）と併せて互換性を固定する。
    const nullOriginSocket = io(`http://127.0.0.1:${httpPort}`, {
      ...socketOptions,
      extraHeaders: { Origin: 'null' },
      reconnection: false,
    });
    try {
      await onceWithTimeout(nullOriginSocket, 'connect', 5000);
    } finally {
      nullOriginSocket.disconnect();
    }

    socket = io(`http://127.0.0.1:${httpPort}`, socketOptions);
    await onceWithTimeout(socket, 'connect', 5000);

    const systemStateEvents = [];
    socket.on('systemStateUpdated', payload => systemStateEvents.push(payload));
    const peerChannelEvents = [];
    socket.on('peerChannelChanged', payload => peerChannelEvents.push(payload));

    socket.emit('setMetadata', { locationName: 'smoke-client', appType: 'client', appVersion: '0.4.0', channelId: 'general' });
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
        latestVersions: { client: '0.4.0' },
        updatePackages: { client: { version: '0.4.0', url: 'https://example.com/client' } },
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
    if (!systemStateChangedMessages.some(message => message.state?.channels?.some(channel => channel.id === 'ops'))) {
      throw new Error('durable system-state-changed IPC message was not emitted');
    }

    const restoreChannelAck = await emitAck(socket, 'setChannel', { channelId: 'ops' });
    if (restoreChannelAck?.channelId !== 'ops') throw new Error('setChannel restore ack failed');

    const telemetry = await emitAck(socket, 'clientTelemetry', {
      appType: 'client',
      appVersion: '0.4.0',
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
        video: { readyState: 'live', injected: { shouldNotPersist: true } },
        audio: { readyState: 'live' },
        injected: { shouldNotPersist: true },
      },
      remoteMonitor: { peerCount: 0, receivingVideoCount: 0, receivingAudioCount: 0, peers: [] },
      connection: { telemetryRttMs: 3, appStatus: 'connected', injected: { shouldNotPersist: true } },
      transports: { socketConnected: true, sendState: 'connected', injected: { shouldNotPersist: true } },
      consumers: [{ producerId: 'smoke-producer', id: 'smoke-consumer', kind: 'video', injected: true }],
    });
    if (!telemetry?.ok) throw new Error('telemetry ack failed');

    targetSocket = io(`http://127.0.0.1:${httpPort}`, socketOptions);
    await onceWithTimeout(targetSocket, 'connect', 5000);
    targetSocket.emit('setMetadata', { locationName: 'smoke-target', appType: 'client', appVersion: '0.4.0', channelId: 'general' });

    let privateIncoming = null;
    const callerPrivateStarted = [];
    const targetPrivateStarted = [];
    const callerPrivateEnded = [];
    const targetPrivateEnded = [];
    socket.on('privateCallStarted', payload => callerPrivateStarted.push(payload));
    targetSocket.on('privateCallStarted', payload => targetPrivateStarted.push(payload));
    socket.on('privateCallEnded', payload => callerPrivateEnded.push(payload));
    targetSocket.on('privateCallEnded', payload => targetPrivateEnded.push(payload));
    targetSocket.on('incomingCall', (payload, ack) => {
      privateIncoming = payload;
      ack?.({ ok: true });
    });

    const privateCallAck = await emitAck(socket, 'callPeer', { targetSocketId: targetSocket.id });
    if (!privateCallAck?.ok || !privateCallAck.privateChannelId) throw new Error('private callPeer ack failed');
    await wait(250);
    if (
      privateIncoming?.fromSocketId !== socket.id ||
      privateIncoming?.callMode !== 'private' ||
      privateIncoming?.fromChannelId !== privateCallAck.privateChannelId ||
      privateIncoming?.fromChannelName !== '個別'
    ) {
      throw new Error('private incomingCall payload was not delivered');
    }
    if (!callerPrivateStarted.some(event => event.channelId === privateCallAck.privateChannelId)) {
      throw new Error('caller did not enter private channel');
    }

    const privateAnswerAck = await emitAck(targetSocket, 'callAck', { callId: privateCallAck.callId, action: 'answered' });
    if (!privateAnswerAck?.ok || privateAnswerAck.privateChannelId !== privateCallAck.privateChannelId) {
      throw new Error('private call answer ack failed');
    }
    await wait(250);
    if (!targetPrivateStarted.some(event => event.channelId === privateCallAck.privateChannelId)) {
      throw new Error('target did not enter private channel');
    }
    const callerPrivateState = await emitAck(socket, 'getSystemState', {});
    const targetPrivateState = await emitAck(targetSocket, 'getSystemState', {});
    if (callerPrivateState.self?.channelId !== privateCallAck.privateChannelId) throw new Error('caller system state did not move to private channel');
    if (targetPrivateState.self?.channelId !== privateCallAck.privateChannelId) throw new Error('target system state did not move to private channel');
    if (!callerPrivateState.channels?.some(channel => channel.id === privateCallAck.privateChannelId && channel.private === true)) {
      throw new Error('private channel was not published in system state');
    }

    const privateEndAck = await emitAck(socket, 'endPrivateCall', {});
    if (!privateEndAck?.ok || privateEndAck.channelId !== 'ops' || privateEndAck.shouldMuteMic !== true) {
      throw new Error('private call end ack failed');
    }
    await wait(300);
    const callerReturnedState = await emitAck(socket, 'getSystemState', {});
    const targetReturnedState = await emitAck(targetSocket, 'getSystemState', {});
    if (callerReturnedState.self?.channelId !== 'ops') throw new Error('caller did not return to previous channel after private call');
    if (targetReturnedState.self?.channelId !== 'general') throw new Error('target did not return to previous channel after private call');
    if (callerReturnedState.channels?.some(channel => channel.id === privateCallAck.privateChannelId)) {
      throw new Error('private channel remained after all members left');
    }
    if (!callerPrivateEnded.some(event => event.channelId === 'ops' && event.shouldMuteMic === true)) {
      throw new Error('caller privateCallEnded event missing mute instruction');
    }
    if (!targetPrivateEnded.some(event => event.channelId === 'general' && event.shouldMuteMic === true)) {
      throw new Error('target privateCallEnded event missing auto-return');
    }

    targetSocket.disconnect();
    targetSocket = null;

    viewerSocket = io(`http://127.0.0.1:${httpPort}`, socketOptions);
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
      updateOk = payload.appType === 'client' && payload.version === '0.4.0';
      ack?.({ ok: true, socketId: socket.id, receivedAt: Date.now() });
    });
    child.send({ type: 'force-update', appType: 'client' });
    await wait(250);
    if (!updateOk) throw new Error('updateCommand was not delivered');

    const publicHealth = await fetch(`http://127.0.0.1:${httpPort}/health`).then(response => response.json());
    if (publicHealth.peerCount < 1 || publicHealth.clients || publicHealth.systemState) {
      throw new Error('public health response was not minimized');
    }
    const unauthorizedDetails = await fetch(`http://127.0.0.1:${httpPort}/health/details`);
    if (unauthorizedDetails.status !== 401) throw new Error('health details accepted an anonymous request');
    const clientTokenDetails = await fetch(`http://127.0.0.1:${httpPort}/health/details`, {
      headers: { Authorization: `Bearer ${smokeAuthToken}` },
    });
    if (clientTokenDetails.status !== 401) throw new Error('health details accepted the client signaling token');
    const recordingTokenDetails = await fetch(`http://127.0.0.1:${httpPort}/health/details`, {
      headers: { Authorization: `Bearer ${smokeRecordingToken}` },
    });
    if (recordingTokenDetails.status !== 401) throw new Error('health details accepted the recording token');
    const healthResponse = await fetch(`http://127.0.0.1:${httpPort}/health/details`, {
      headers: { Authorization: `Bearer ${smokeAdminToken}` },
    });
    if (!healthResponse.ok) throw new Error(`authenticated health details failed: ${healthResponse.status}`);
    const health = await healthResponse.json();
    const healthClient = health.clients?.find(client => client.id === socket.id);
    if (healthClient?.health !== 'healthy') throw new Error('health snapshot did not include healthy client');
    if (healthClient?.viewerPresence !== true) throw new Error('health snapshot did not include viewer presence');
    if (healthClient?.channelId !== 'ops') throw new Error('health snapshot did not include client channel');
    if (
      healthClient?.localMedia?.injected ||
      healthClient?.localMedia?.video?.injected ||
      healthClient?.connection?.injected ||
      healthClient?.transports?.injected ||
      healthClient?.telemetry?.consumers?.[0]?.injected
    ) {
      throw new Error('telemetry sanitizer retained an unapproved nested field');
    }
    if (health.systemState?.latestVersions?.client !== '0.4.0') throw new Error('health snapshot did not include systemState');

    const anonymousRecordingStatus = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/status`);
    if (anonymousRecordingStatus.status !== 401) throw new Error('recording status accepted an anonymous request');
    const recordingSessionResponse = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${smokeRecordingToken}` },
    });
    if (!recordingSessionResponse.ok) throw new Error('recording session exchange failed');
    const recordingCookie = String(recordingSessionResponse.headers.get('set-cookie') || '').split(';')[0];
    if (!recordingCookie.startsWith('sfu_recording_session=')) throw new Error('recording session cookie missing');
    for (const wrongToken of [smokeAuthToken, smokeAdminToken]) {
      const wrongRecordingSession = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wrongToken}` },
      });
      if (wrongRecordingSession.status !== 401) throw new Error('recording session accepted a non-recording token');
    }
    const recordingStatusResponse = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/status`, {
      headers: { Cookie: recordingCookie },
    });
    if (!recordingStatusResponse.ok) throw new Error('recording session cookie was rejected');
    const recordingStatus = await recordingStatusResponse.json();
    if ('recordingsDir' in recordingStatus || 'recordingSocketIds' in recordingStatus || 'storageError' in recordingStatus) {
      throw new Error('public recording status leaked internal details');
    }
    const anonymousRecordingSettings = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (anonymousRecordingSettings.status !== 401) throw new Error('recording settings accepted an anonymous request');
    const recordingTokenSettings = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smokeRecordingToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (recordingTokenSettings.status !== 401) throw new Error('recording settings accepted the recording token');
    const adminRecordingSettings = await fetch(`http://127.0.0.1:${httpPort}/recordings/api/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smokeAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ retentionDays: 21 }),
    });
    if (!adminRecordingSettings.ok) throw new Error('recording settings rejected the admin token');
    const changedSettings = await adminRecordingSettings.json();
    if (changedSettings.settings?.retentionDays !== 21) throw new Error('recording settings were not applied');
    for (let attempt = 0; attempt < 20 && !recordingSettingsChangedMessages.length; attempt += 1) {
      await wait(25);
    }
    if (recordingSettingsChangedMessages.at(-1)?.settings?.retentionDays !== 21) {
      throw new Error('recording settings change was not synchronized to the GUI parent');
    }
    if (JSON.parse(fs.readFileSync(recordingSettingsFile, 'utf8')).retentionDays !== 21) {
      throw new Error('recording settings change was not persisted');
    }

    // 録画メディアは認証を必須とし、検証済みの同一FDから
    // GET / HEAD / Rangeを配信する。Chromiumのシークに必要な206/416も確認する。
    const recordingMediaUrl = `http://127.0.0.1:${httpPort}/recordings/media/${encodeURIComponent(recordingId)}`;
    const anonymousMedia = await fetch(recordingMediaUrl);
    if (anonymousMedia.status !== 401) throw new Error('recording media accepted an anonymous request');

    const recordingHeaders = { Authorization: `Bearer ${smokeRecordingToken}` };
    const fullMedia = await fetch(recordingMediaUrl, { headers: recordingHeaders });
    if (fullMedia.status !== 200 || fullMedia.headers.get('accept-ranges') !== 'bytes') {
      throw new Error(`recording media full GET failed: ${fullMedia.status}`);
    }
    const fullBytes = Buffer.from(await fullMedia.arrayBuffer());
    if (!fullBytes.equals(recordingBytes)) throw new Error('recording media full GET returned different bytes');

    const headMedia = await fetch(recordingMediaUrl, { method: 'HEAD', headers: recordingHeaders });
    if (headMedia.status !== 200 || Number(headMedia.headers.get('content-length')) !== recordingBytes.length) {
      throw new Error(`recording media HEAD failed: ${headMedia.status}`);
    }

    const rangeMedia = await fetch(recordingMediaUrl, {
      headers: { ...recordingHeaders, Range: 'bytes=10-19' },
    });
    if (rangeMedia.status !== 206 || rangeMedia.headers.get('content-range') !== `bytes 10-19/${recordingBytes.length}`) {
      throw new Error(`recording media Range failed: ${rangeMedia.status}`);
    }
    const rangeBytes = Buffer.from(await rangeMedia.arrayBuffer());
    if (!rangeBytes.equals(recordingBytes.subarray(10, 20))) {
      throw new Error('recording media Range returned different bytes');
    }

    const invalidRange = await fetch(recordingMediaUrl, {
      headers: { ...recordingHeaders, Range: `bytes=${recordingBytes.length}-` },
    });
    if (invalidRange.status !== 416 || invalidRange.headers.get('content-range') !== `bytes */${recordingBytes.length}`) {
      throw new Error(`recording media invalid Range was not rejected: ${invalidRange.status}`);
    }

    // 最終パスをsymlinkに差し替えても、録画ルート外を配信しない。
    const recordingBackupPath = `${recordingMediaPath}.backup`;
    const outsideMediaPath = path.join(recordingFixtureRoot, 'outside-secret.webm');
    fs.writeFileSync(outsideMediaPath, Buffer.from('must-not-be-served'));
    fs.renameSync(recordingMediaPath, recordingBackupPath);
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideMediaPath, recordingMediaPath);
      symlinkCreated = true;
      const symlinkMedia = await fetch(recordingMediaUrl, { headers: recordingHeaders });
      if (symlinkMedia.status !== 404) {
        throw new Error(`recording media followed a symlink: ${symlinkMedia.status}`);
      }
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
    } finally {
      if (symlinkCreated) fs.unlinkSync(recordingMediaPath);
      fs.renameSync(recordingBackupPath, recordingMediaPath);
    }

    // Trusted proxies can surface many client IPs. The per-source tracker must
    // stay bounded and reject a new source once its cap is full.
    const locationsUrl = `http://127.0.0.1:${httpPort}/recordings/api/locations`;
    for (let index = 1; index <= 7; index += 1) {
      const admitted = await fetch(locationsUrl, {
        headers: {
          ...recordingHeaders,
          'X-Forwarded-For': `198.51.100.${index}`,
        },
      });
      if (admitted.status === 429) {
        throw new Error(`recording query source cap rejected source ${index} too early`);
      }
    }
    const capped = await fetch(locationsUrl, {
      headers: {
        ...recordingHeaders,
        'X-Forwarded-For': '198.51.100.8',
      },
    });
    if (capped.status !== 429) {
      throw new Error(`recording query source cap did not reject overflow: ${capped.status}`);
    }

    // Update/ringtone listings and downloads are bounded and never follow a
    // final symlink. A pathname replaced after headers must still stream the
    // already-opened original inode.
    const updateListResponse = await fetch(`http://127.0.0.1:${httpPort}/updates`);
    const updateList = await updateListResponse.json();
    if (!updateListResponse.ok || !Array.isArray(updateList.files) || updateList.files.length !== 256) {
      throw new Error(`update listing was not capped at 256: ${updateList.files?.length}`);
    }
    const updateUrl = `http://127.0.0.1:${httpPort}/updates/${encodeURIComponent(updateName)}`;
    const updateHead = await fetch(updateUrl, { method: 'HEAD' });
    if (updateHead.status !== 200 || Number(updateHead.headers.get('content-length')) !== updateBytes.length) {
      throw new Error(`update HEAD failed: ${updateHead.status}`);
    }

    const openedUpdateResponse = await fetch(updateUrl);
    if (openedUpdateResponse.status !== 200) throw new Error(`update GET failed: ${openedUpdateResponse.status}`);
    const updateBackupPath = `${updatePath}.opened`;
    let updatePathMoved = false;
    let updateReplacementLink = false;
    try {
      fs.renameSync(updatePath, updateBackupPath);
      updatePathMoved = true;
      try {
        fs.symlinkSync(publishedOutsidePath, updatePath);
        updateReplacementLink = true;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
      }
      const streamedUpdate = Buffer.from(await openedUpdateResponse.arrayBuffer());
      if (!streamedUpdate.equals(updateBytes)) throw new Error('update response reopened a replaced pathname');
    } finally {
      if (updateReplacementLink) fs.unlinkSync(updatePath);
      if (updatePathMoved) fs.renameSync(updateBackupPath, updatePath);
    }

    for (const [directory, linkName, route] of [
      [updatesDir, 'outside.zip', 'updates'],
      [ringtonesDir, 'outside.mp3', 'ringtones'],
    ]) {
      const linkPath = path.join(directory, linkName);
      let linkCreated = false;
      try {
        fs.symlinkSync(publishedOutsidePath, linkPath);
        linkCreated = true;
        const linkedResponse = await fetch(`http://127.0.0.1:${httpPort}/${route}/${linkName}`);
        if (linkedResponse.status !== 404) {
          throw new Error(`${route} download followed an outside symlink: ${linkedResponse.status}`);
        }
      } catch (err) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
      } finally {
        if (linkCreated) fs.unlinkSync(linkPath);
      }
    }
    const ringtoneResponse = await fetch(`http://127.0.0.1:${httpPort}/ringtones/${ringtoneName}`);
    if (ringtoneResponse.status !== 200 ||
        !Buffer.from(await ringtoneResponse.arrayBuffer()).equals(ringtoneBytes)) {
      throw new Error(`ringtone GET failed: ${ringtoneResponse.status}`);
    }

    // The configured root itself is pinned, not only its final children. A
    // replacement with an outside symlink (or another directory on platforms
    // that forbid symlinks) must invalidate both listing and download paths.
    const outsideUpdatesDir = path.join(recordingFixtureRoot, 'outside-updates');
    const outsideUpdateName = 'escaped.zip';
    const configuredUpdatesBackup = `${updatesDir}.configured`;
    fs.mkdirSync(outsideUpdatesDir);
    fs.writeFileSync(path.join(outsideUpdatesDir, outsideUpdateName), 'MUST-NOT-ESCAPE-ROOT');
    fs.renameSync(updatesDir, configuredUpdatesBackup);
    let replacementIsSymlink = false;
    try {
      try {
        fs.symlinkSync(outsideUpdatesDir, updatesDir, process.platform === 'win32' ? 'junction' : 'dir');
        replacementIsSymlink = true;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
        fs.mkdirSync(updatesDir);
        fs.copyFileSync(
          path.join(outsideUpdatesDir, outsideUpdateName),
          path.join(updatesDir, outsideUpdateName),
        );
      }
      const replacedList = await fetch(`http://127.0.0.1:${httpPort}/updates`);
      if (replacedList.ok) {
        throw new Error(`update listing accepted a replaced configured root: ${replacedList.status}`);
      }
      const escapedDownload = await fetch(
        `http://127.0.0.1:${httpPort}/updates/${encodeURIComponent(outsideUpdateName)}`,
      );
      if (escapedDownload.status !== 404) {
        throw new Error(`update download accepted a replaced configured root: ${escapedDownload.status}`);
      }
    } finally {
      if (replacementIsSymlink) fs.unlinkSync(updatesDir);
      else fs.rmSync(updatesDir, { recursive: true, force: true });
      fs.renameSync(configuredUpdatesBackup, updatesDir);
    }

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
    targetSocket?.disconnect();
    socket?.disconnect();
    child.kill('SIGTERM');
    await wait(300);
    fs.rmSync(recordingFixtureRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(`[smoke] ${error.stack || error.message}`);
  process.exit(1);
});
