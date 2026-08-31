import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import packageInfo from '../../package.json';

const SETUP_WATCHDOG_MS = 20000;
const HARD_RECONNECT_DELAY_MS = 1000;

export class ViewerWebRTCManager {
  constructor() {
    this.socket = null;
    this.device = null;
    this.recvTransport = null;

    this.consumers = new Map();
    this.peers = new Map();

    this.iceServers = [];
    this._initialized = false;
    this._pendingQueue = [];
    this._viewerName = '';
    this._appVersion = packageInfo.version;
    this._manualDisconnect = false;
    this._setupInFlight = null;
    this._consumeInFlight = new Map();
    this._syncInFlight = null;
    this._pendingRequests = new Set();
    this._iceRestartTimers = new Map();
    this._iceRecoveryTimers = new Map();
    this._setupRetryTimer = null;
    this._setupRetryDelay = 1000;
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;
    this._setupGeneration = 0;
    this._setupStartedAt = 0;
    this._setupWatchdogTimer = null;
    this._hardReconnectTimer = null;
    this._sessionRebuildTimer = null;

    this.onPeerUpdated = null;
    this.onPeerRemoved = null;
    this.onRestartCommand = null;
    this.onAdminSetDevice = null;
    this.onAdminSetMediaState = null;
    this.onAdminRefreshDevices = null;
    this.onConnectionChange = null;
    this.onSystemStateUpdated = null;
    this.onPeerChannelChanged = null;
    this.onUpdateCommand = null;
  }

  connect(serverUrl, viewerName, options = {}) {
    if (this.socket) this.disconnect();

    this._viewerName = viewerName || '閲覧端末';
    this._appVersion = options.appVersion || this._appVersion || packageInfo.version;
    this._manualDisconnect = false;
    this._setupRetryDelay = 1000;
    const authToken = typeof options.authToken === 'string'
      ? options.authToken.trim().slice(0, 2048)
      : '';

    return new Promise((resolve, reject) => {
      const socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        upgrade: true,
        rememberUpgrade: true,
        forceNew: true,
        auth: authToken ? { token: authToken } : {},
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
        randomizationFactor: 0.5,
        timeout: 12000,
      });
      this.socket = socket;
      let initialConnectionSettled = false;

      const resolveInitialConnection = () => {
        if (initialConnectionSettled) return;
        initialConnectionSettled = true;
        resolve();
      };
      const rejectInitialConnection = (err) => {
        if (initialConnectionSettled) return;
        initialConnectionSettled = true;
        reject(err);
      };

      // Socket.IO Manager の `reconnect` は namespace Socket が connected になる前に
      // 発火することがある。初回も再接続も Socket の `connect` のみを
      // セッション構築の入口にし、not connected 競合を避ける。
      socket.on('connect', async () => {
        if (socket !== this.socket || this._manualDisconnect) return;
        console.log('[ViewerWebRTC] connected', socket.id);
        try {
          await this._setupSession();
          if (socket !== this.socket || this._manualDisconnect) return;
          this._setupRetryDelay = 1000;
          resolveInitialConnection();
        } catch (err) {
          if (socket !== this.socket || this._manualDisconnect) return;
          console.error('[ViewerWebRTC] init failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
          rejectInitialConnection(err);
        }
      });

      socket.on('connect_error', (err) => {
        if (socket !== this.socket || this._manualDisconnect) return;
        rejectInitialConnection(new Error(`接続失敗: ${err.message}`));
      });

      socket.on('disconnect', (reason) => {
        if (socket !== this.socket) return;
        console.warn('[ViewerWebRTC] disconnected:', reason);
        this._setupGeneration += 1;
        this._setupInFlight = null;
        this._setupStartedAt = 0;
        this._initialized = false;
        this._failPendingRequests(new Error(`socket disconnected: ${reason}`));
        this._syncInFlight = null;
        this._clearSetupRetry();
        this._clearSessionRebuild();
        this._clearSetupWatchdog();
        this._resetMediaSession({ notifyPeers: true, failPending: false });
        this.onConnectionChange?.(false);
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          setTimeout(() => {
            if (!this._manualDisconnect && socket === this.socket) socket.connect();
          }, 2000);
        }
      });

      this._bindServerEvents(socket);
    });
  }

  async _setupSession() {
    if (this._setupInFlight) return this._setupInFlight;

    const setupGeneration = this._setupGeneration + 1;
    this._setupGeneration = setupGeneration;
    this._setupStartedAt = Date.now();
    this._initialized = false;
    this._armSetupWatchdog(setupGeneration);

    const assertCurrent = (stage) => {
      if (this._manualDisconnect || !this.socket?.connected || this._setupGeneration !== setupGeneration) {
        throw new Error(`viewer setup superseded at ${stage}`);
      }
    };

    const setupPromise = (async () => {
      this._clearSetupRetry();
      this.socket.emit('setMetadata', {
        locationName: this._viewerName,
        appType: 'viewer',
        appVersion: this._appVersion,
      });
      await this._initMediasoup(setupGeneration);
      assertCurrent('init-mediasoup');

      const queued = this._pendingQueue.splice(0);
      for (const producer of queued) {
        await this._consumePeer(producer.producerId, producer.socketId, producer.locationName, producer.kind, producer.paused, producer);
        assertCurrent('queued-consume');
      }

      assertCurrent('ready');
      this._initialized = true;
      this.onConnectionChange?.(true);
    })();
    this._setupInFlight = setupPromise;

    try {
      return await setupPromise;
    } catch (err) {
      if (this._setupGeneration === setupGeneration) {
        this._initialized = false;
        this._resetMediaSession({ notifyPeers: true });
      }
      throw err;
    } finally {
      if (this._setupInFlight === setupPromise) this._setupInFlight = null;
      if (this._setupGeneration === setupGeneration) {
        this._setupStartedAt = 0;
        this._clearSetupWatchdog();
      }
    }
  }

  _scheduleSetupRetry() {
    if (this._manualDisconnect || !this.socket?.connected || this._setupRetryTimer) return;
    const delay = this._setupRetryDelay;
    this._setupRetryDelay = Math.min(30000, Math.round(this._setupRetryDelay * 1.7));

    this._setupRetryTimer = setTimeout(async () => {
      this._setupRetryTimer = null;
      if (this._manualDisconnect || !this.socket?.connected) return;
      console.warn(`[ViewerWebRTC] retrying media setup in-place after ${delay}ms backoff`);
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[ViewerWebRTC] setup retry failed', err);
        this.onConnectionChange?.(false);
        this._scheduleSetupRetry();
      }
    }, delay);
  }

  _clearSetupRetry() {
    if (!this._setupRetryTimer) return;
    clearTimeout(this._setupRetryTimer);
    this._setupRetryTimer = null;
  }

  _armSetupWatchdog(setupGeneration) {
    this._clearSetupWatchdog();
    this._setupWatchdogTimer = setTimeout(() => {
      if (
        this._manualDisconnect ||
        !this.socket?.connected ||
        this._setupGeneration !== setupGeneration ||
        !this._setupInFlight ||
        this._initialized
      ) return;
      console.warn('[ViewerWebRTC] setup watchdog fired; hard reconnecting');
      this._hardReconnect('setup-watchdog-timeout');
    }, SETUP_WATCHDOG_MS);
  }

  _clearSetupWatchdog() {
    if (!this._setupWatchdogTimer) return;
    clearTimeout(this._setupWatchdogTimer);
    this._setupWatchdogTimer = null;
  }

  _hardReconnect(reason = 'manual-recovery') {
    if (this._manualDisconnect || !this.socket || this._hardReconnectTimer) return;
    console.warn(`[ViewerWebRTC] hard reconnect requested reason=${reason}`);
    this._setupGeneration += 1;
    this._setupInFlight = null;
    this._setupStartedAt = 0;
    this._initialized = false;
    this._clearSetupRetry();
    this._clearSessionRebuild();
    this._clearSetupWatchdog();
    this._resetMediaSession({ notifyPeers: true });
    this.onConnectionChange?.(false);

    const socket = this.socket;
    try { socket.disconnect(); } catch { /* ignore disconnect errors */ }
    this._hardReconnectTimer = setTimeout(() => {
      this._hardReconnectTimer = null;
      if (!this._manualDisconnect && socket === this.socket) {
        try { this.socket.connect(); } catch { /* socket.io will retry */ }
      }
    }, HARD_RECONNECT_DELAY_MS);
  }

  _resetMediaSession({ notifyPeers = false, failPending = true } = {}) {
    if (failPending) this._failPendingRequests(new Error('viewer media session reset'));
    this.consumers.forEach(consumer => {
      try { consumer.close(); } catch { /* ignore close errors */ }
    });
    const recvTransport = this.recvTransport;
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }
    if (recvTransport && this.socket?.connected) {
      this.socket.emit('closeTransport', { transportId: recvTransport.id }, () => {});
    }

    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    for (const timer of this._iceRecoveryTimers.values()) clearTimeout(timer);
    this._iceRecoveryTimers.clear();
    this._consumeInFlight.clear();
    this._syncInFlight = null;
    this._pendingQueue = [];
    this.recvTransport = null;
    this.device = null;
    this.consumers.clear();

    if (notifyPeers) {
      for (const socketId of this.peers.keys()) this.onPeerRemoved?.(socketId);
    }
    this.peers.clear();
  }

  _scheduleSessionRebuild(reason = 'transport-failure') {
    if (this._manualDisconnect || !this.socket?.connected || this._sessionRebuildTimer) return;
    this._sessionRebuildTimer = setTimeout(async () => {
      this._sessionRebuildTimer = null;
      if (this._manualDisconnect || !this.socket?.connected) return;
      console.warn(`[ViewerWebRTC] rebuilding media session reason=${reason}`);
      this._setupGeneration += 1;
      this._setupInFlight = null;
      this._initialized = false;
      this._resetMediaSession({ notifyPeers: true });
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[ViewerWebRTC] session rebuild failed', err);
        this.onConnectionChange?.(false);
        this._scheduleSetupRetry();
      }
    }, 2500);
  }

  _clearSessionRebuild() {
    if (!this._sessionRebuildTimer) return;
    clearTimeout(this._sessionRebuildTimer);
    this._sessionRebuildTimer = null;
  }

  _bindServerEvents(socket) {
    socket.on('newProducer', async ({ producerId, socketId, locationName, kind, paused, source, appData, channelId, appType }) => {
      if (socket !== this.socket || this._manualDisconnect) return;
      const payload = { producerId, socketId, locationName, kind, paused, source, appData, channelId, appType };
      if (!this._initialized) {
        if (!this._pendingQueue.find(p => p.producerId === producerId)) {
          this._pendingQueue.push(payload);
        }
        return;
      }
      await this._consumePeer(producerId, socketId, locationName, kind, paused, payload);
    });

    socket.on('producerClosed', ({ producerId }) => this._handleProducerClosed(producerId));
    socket.on('producerPaused', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, true));
    socket.on('producerResumed', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, false));

    socket.on('systemStateUpdated', (payload = {}) => {
      this.onSystemStateUpdated?.(payload);
    });

    socket.on('peerChannelChanged', (payload = {}) => {
      const peer = this.peers.get(payload.socketId);
      if (peer) {
        peer.channelId = payload.channelId || peer.channelId;
        this.onPeerUpdated?.(payload.socketId, { ...peer });
      }
      this.onPeerChannelChanged?.(payload);
    });

    socket.on('updateCommand', (payload = {}, ack) => {
      ack?.({ ok: true, socketId: socket.id, receivedAt: Date.now() });
      this.onUpdateCommand?.(payload);
    });

    socket.on('peerDisconnected', ({ socketId }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        for (const producerId of [peer.videoProducerId, peer.audioProducerId, peer.screenProducerId, peer.screenAudioProducerId]) {
          if (!producerId) continue;
          const consumer = this.consumers.get(producerId);
          if (consumer) {
            try { consumer.close(); } catch { /* ignore close errors */ }
            this.consumers.delete(producerId);
          }
        }
        this.peers.delete(socketId);
      }
      this.onPeerRemoved?.(socketId);
    });

    socket.on('restartCommand', (payload, ack) => {
      if (typeof ack === 'function') {
        ack({ ok: true, socketId: socket.id, receivedAt: Date.now() });
      }
      setTimeout(() => this.onRestartCommand?.(payload), 100);
    });

    socket.on('adminSetDevice', async (payload, ack) => {
      try {
        if (!this.onAdminSetDevice) throw new Error('device control is not ready');
        const result = await this.onAdminSetDevice(payload || {});
        ack?.({ ok: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    socket.on('adminSetMediaState', async (payload, ack) => {
      try {
        if (!this.onAdminSetMediaState) throw new Error('media state control is not ready');
        const result = await this.onAdminSetMediaState(payload || {});
        ack?.({ ok: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    socket.on('adminRefreshDevices', async (_payload, ack) => {
      try {
        if (!this.onAdminRefreshDevices) throw new Error('device refresh is not ready');
        const result = await this.onAdminRefreshDevices();
        ack?.({ ok: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    socket.on('mediaLayerRestarted', async () => {
      if (socket !== this.socket || this._manualDisconnect) return;
      console.warn('[ViewerWebRTC] media layer restarted, rebuilding session');
      this._setupGeneration += 1;
      this._setupInFlight = null;
      this._initialized = false;
      this._clearSessionRebuild();
      this._clearSetupWatchdog();
      this._resetMediaSession({ notifyPeers: true });
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[ViewerWebRTC] media layer rebuild failed', err);
        this.onConnectionChange?.(false);
        this._scheduleSetupRetry();
      }
    });
  }

  _isSessionCurrent(setupGeneration, transport = null) {
    return !this._manualDisconnect &&
      !!this.socket?.connected &&
      this._setupGeneration === setupGeneration &&
      (!transport || this.recvTransport === transport);
  }

  _assertSessionCurrent(setupGeneration, stage, transport = null) {
    if (!this._isSessionCurrent(setupGeneration, transport)) {
      throw new Error(`viewer session superseded at ${stage}`);
    }
  }

  async _initMediasoup(setupGeneration) {
    this.consumers.forEach(consumer => {
      try { consumer.close(); } catch { /* ignore close errors */ }
    });
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }
    this.recvTransport = null;
    this.consumers.clear();

    for (const peer of this.peers.values()) {
      peer.stream = new MediaStream();
      peer.screenStream = new MediaStream();
      peer.videoProducerId = null;
      peer.audioProducerId = null;
      peer.screenProducerId = null;
      peer.screenAudioProducerId = null;
    }

    try {
      const config = await this._request('getServerConfig');
      if (config && Array.isArray(config.iceServers)) this.iceServers = config.iceServers;
    } catch {
      // Older server versions did not expose this optional event.
    }
    this._assertSessionCurrent(setupGeneration, 'server-config');

    const caps = await this._request('getRouterRtpCapabilities');
    this._assertSessionCurrent(setupGeneration, 'router-capabilities');
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: caps });
    this._assertSessionCurrent(setupGeneration, 'device-load');
    this.device = device;
    await this._initRecvTransport(setupGeneration, device);
    this._assertSessionCurrent(setupGeneration, 'recv-transport', this.recvTransport);

    const existing = await this._request('getProducers');
    this._assertSessionCurrent(setupGeneration, 'get-producers', this.recvTransport);
    for (const producer of existing) {
      await this._consumePeer(producer.producerId, producer.socketId, producer.locationName, producer.kind, producer.paused, producer);
      this._assertSessionCurrent(setupGeneration, 'existing-consume', this.recvTransport);
    }
  }

  _transportOptions(params) {
    return this.iceServers.length ? { ...params, iceServers: this.iceServers } : params;
  }

  async _initRecvTransport(setupGeneration, device) {
    const { params, transportLeaseRequired } = await this._request('createWebRtcTransport', {
      forceTcp: false,
      supportsTransportLease: true,
    });
    this._assertSessionCurrent(setupGeneration, 'create-recv-transport');
    const transport = device.createRecvTransport(this._transportOptions(params));
    this.recvTransport = transport;
    if (transportLeaseRequired === true) {
      try {
        await this._request('acceptTransport', { transportId: transport.id });
        this._assertSessionCurrent(setupGeneration, 'accept-recv-transport', transport);
      } catch (err) {
        try { transport.close(); } catch { /* ignore */ }
        if (this.recvTransport === transport) this.recvTransport = null;
        this.socket?.emit('closeTransport', { transportId: transport.id }, () => {});
        throw err;
      }
    }

    transport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      try {
        this._assertSessionCurrent(setupGeneration, 'connect-recv-transport', transport);
        await this._request('connectTransport', { transportId: transport.id, dtlsParameters });
        this._assertSessionCurrent(setupGeneration, 'connected-recv-transport', transport);
        cb();
      } catch (err) {
        eb(err);
      }
    });
    transport.on('connectionstatechange', (state) => {
      console.log('[viewerRecvTransport]', state);
      if (!this._isSessionCurrent(setupGeneration, transport)) return;
      if (state === 'connected') {
        this._clearIceRecovery(transport.id);
        this._clearSessionRebuild();
      } else if (state === 'failed' || state === 'disconnected') {
        this._scheduleIceRestart(transport, 'viewerRecvTransport', setupGeneration);
      } else if (state === 'closed') {
        this._clearIceRecovery(transport.id);
      }
    });
  }

  _clearIceRecovery(transportId) {
    const restartTimer = this._iceRestartTimers.get(transportId);
    if (restartTimer) clearTimeout(restartTimer);
    this._iceRestartTimers.delete(transportId);

    const recoveryTimer = this._iceRecoveryTimers.get(transportId);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    this._iceRecoveryTimers.delete(transportId);
  }

  _scheduleIceRestart(transport, label, setupGeneration) {
    if (!transport || transport.closed) return;
    if (this._iceRestartTimers.has(transport.id) || this._iceRecoveryTimers.has(transport.id)) return;

    const timer = setTimeout(async () => {
      this._iceRestartTimers.delete(transport.id);
      if (!this._isSessionCurrent(setupGeneration, transport)) return;
      if (transport.connectionState === 'connected') return;

      try {
        await this._restartTransportIce(transport, setupGeneration);
        if (!this._isSessionCurrent(setupGeneration, transport)) return;
        if (transport.connectionState === 'connected') return;

        const recoveryTimer = setTimeout(() => {
          this._iceRecoveryTimers.delete(transport.id);
          if (!this._isSessionCurrent(setupGeneration, transport)) return;
          if (transport.connectionState === 'connected') return;
          console.warn(`[${label}] ICE did not recover after restart`);
          this._scheduleSessionRebuild(`${label}-ice-restart-no-recovery`);
        }, 8000);
        this._iceRecoveryTimers.set(transport.id, recoveryTimer);
      } catch (err) {
        if (!this._isSessionCurrent(setupGeneration, transport)) return;
        console.warn(`[${label} restartIce]`, err.message);
        this._scheduleSessionRebuild(`${label}-ice-restart-failed`);
      }
    }, 1500);
    this._iceRestartTimers.set(transport.id, timer);
  }

  async _restartTransportIce(transport, setupGeneration) {
    if (!transport || transport.closed) return;
    const { iceParameters } = await this._request('restartIce', { transportId: transport.id });
    this._assertSessionCurrent(setupGeneration, 'restart-ice-response', transport);
    if (iceParameters) await transport.restartIce({ iceParameters });
    this._assertSessionCurrent(setupGeneration, 'restart-ice-local', transport);
  }

  _replaceStreamTrack(stream, nextTrack) {
    if (!stream || !nextTrack) return;
    for (const track of stream.getTracks()) {
      if (track !== nextTrack && track.kind === nextTrack.kind) {
        try { stream.removeTrack(track); } catch { /* already removed */ }
      }
    }
    if (!stream.getTracks().includes(nextTrack)) stream.addTrack(nextTrack);
  }

  async _consumePeer(producerId, socketId, locationName, kind, paused, metadata = {}) {
    const transport = this.recvTransport;
    const device = this.device;
    const setupGeneration = this._setupGeneration;
    if (!transport || !device) return;
    if (this.consumers.has(producerId)) return;
    if (this._consumeInFlight.has(producerId)) return;
    const consumeToken = {};
    this._consumeInFlight.set(producerId, consumeToken);
    let consumer = null;
    let serverConsumerId = null;

    try {
      const { params } = await this._request('consume', {
        transportId: transport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      serverConsumerId = params.id;
      this._assertSessionCurrent(setupGeneration, 'consume-response', transport);

      consumer = await transport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });
      this._assertSessionCurrent(setupGeneration, 'local-consume', transport);

      await this._request('resume', { consumerId: consumer.id });
      this._assertSessionCurrent(setupGeneration, 'resume-consumer', transport);
      this.consumers.set(producerId, consumer);

      let peer = this.peers.get(socketId);
      if (!peer) {
        peer = {
          locationName: locationName || '不明',
          appType: metadata.appType || 'client',
          appVersion: metadata.appVersion || '',
          channelId: metadata.peerChannelId || metadata.channelId || 'general',
          stream: new MediaStream(),
          screenStream: new MediaStream(),
          videoProducerId: null,
          audioProducerId: null,
          screenProducerId: null,
          screenAudioProducerId: null,
          videoPaused: false,
          audioPaused: false,
          screenPaused: false,
          screenAudioPaused: false,
          screenLabel: '',
        };
        this.peers.set(socketId, peer);
      }

      if (locationName) peer.locationName = locationName;
      if (metadata.appType) peer.appType = metadata.appType;
      if (metadata.appVersion) peer.appVersion = metadata.appVersion;
      if (metadata.peerChannelId || metadata.channelId) peer.channelId = metadata.peerChannelId || metadata.channelId;

      const appData = metadata.appData || {};
      const source = metadata.source || appData.source || (kind === 'video' ? 'camera' : 'microphone');
      if (kind === 'video' && source === 'screen') {
        this._replaceStreamTrack(peer.screenStream, consumer.track);
        peer.screenProducerId = producerId;
        peer.screenPaused = !!paused;
        peer.screenLabel = appData.label || appData.sourceName || '画面共有';
      } else if (kind === 'audio' && source === 'screen-audio') {
        this._replaceStreamTrack(peer.screenStream, consumer.track);
        peer.screenAudioProducerId = producerId;
        peer.screenAudioPaused = !!paused;
        peer.screenLabel = peer.screenLabel || appData.label || appData.sourceName || '画面共有';
      } else {
        this._replaceStreamTrack(peer.stream, consumer.track);
      }

      if (kind === 'video' && source !== 'screen') {
        peer.videoProducerId = producerId;
        peer.videoPaused = !!paused;
      } else if (source !== 'screen-audio') {
        if (kind === 'audio') {
          peer.audioProducerId = producerId;
          peer.audioPaused = !!paused;
        }
      }

      this.onPeerUpdated?.(socketId, { ...peer, stream: peer.stream });
    } catch (err) {
      if (this.consumers.get(producerId) === consumer) this.consumers.delete(producerId);
      try { consumer?.close(); } catch { /* ignore close errors */ }
      if (serverConsumerId) this._closeServerConsumer(serverConsumerId);
      if (this._isSessionCurrent(setupGeneration, transport)) {
        console.error('[ViewerWebRTC _consumePeer]', err);
      }
    } finally {
      if (this._consumeInFlight.get(producerId) === consumeToken) {
        this._consumeInFlight.delete(producerId);
      }
    }
  }

  _closeServerConsumer(consumerId) {
    if (!consumerId || !this.socket?.connected) return;
    this.socket.emit('closeConsumer', { consumerId }, () => {});
  }

  _handleProducerClosed(producerId) {
    const consumer = this.consumers.get(producerId);
    const closedTrack = consumer?.track || null;
    if (consumer) {
      try { consumer.close(); } catch { /* ignore close errors */ }
      this.consumers.delete(producerId);
    }

    for (const [socketId, peer] of this.peers) {
      if (peer.videoProducerId === producerId) {
        peer.videoProducerId = null;
        peer.videoPaused = true;
        if (closedTrack) {
          try { peer.stream?.removeTrack(closedTrack); } catch { /* already removed */ }
        }
        this.onPeerUpdated?.(socketId, { ...peer });
        break;
      }
      if (peer.audioProducerId === producerId) {
        peer.audioProducerId = null;
        peer.audioPaused = true;
        if (closedTrack) {
          try { peer.stream?.removeTrack(closedTrack); } catch { /* already removed */ }
        }
        this.onPeerUpdated?.(socketId, { ...peer });
        break;
      }
      if (peer.screenAudioProducerId === producerId) {
        peer.screenAudioProducerId = null;
        peer.screenAudioPaused = true;
        if (closedTrack) {
          try { peer.screenStream?.removeTrack(closedTrack); } catch { /* ignore */ }
        }
        this.onPeerUpdated?.(socketId, { ...peer });
        break;
      }
      if (peer.screenProducerId === producerId) {
        peer.screenProducerId = null;
        peer.screenPaused = true;
        peer.screenAudioProducerId = null;
        peer.screenAudioPaused = true;
        peer.screenStream = new MediaStream();
        this.onPeerUpdated?.(socketId, { ...peer });
        break;
      }
    }
  }

  _setProducerPaused(producerId, socketId, paused) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    if (peer.videoProducerId === producerId) peer.videoPaused = paused;
    if (peer.audioProducerId === producerId) peer.audioPaused = paused;
    if (peer.screenProducerId === producerId) peer.screenPaused = paused;
    if (peer.screenAudioProducerId === producerId) peer.screenAudioPaused = paused;
    this.onPeerUpdated?.(socketId, { ...peer });
  }

  async syncPeers() {
    if (!this._initialized) return;
    if (this._syncInFlight) return this._syncInFlight;

    const setupGeneration = this._setupGeneration;
    const transport = this.recvTransport;
    const syncPromise = (async () => {
      const peerList = await this._request('getPeers');
      this._assertSessionCurrent(setupGeneration, 'sync-peers-response', transport);

      for (const peer of peerList) {
        if (peer.isSelf) continue;
        for (const producer of peer.producers) {
          await this._consumePeer(
            producer.producerId,
            peer.socketId,
            peer.locationName,
            producer.kind,
            producer.paused,
            { ...producer, appType: peer.appType, appVersion: peer.appVersion, peerChannelId: peer.channelId },
          );
          this._assertSessionCurrent(setupGeneration, 'sync-peers-consume', transport);
        }
      }

      const active = new Set(peerList.filter(p => !p.isSelf && p.producers.length > 0).map(p => p.socketId));
      for (const [socketId] of this.peers) {
        if (!active.has(socketId)) {
          this.peers.delete(socketId);
          this.onPeerRemoved?.(socketId);
        }
      }

      for (const peer of peerList) {
        if (peer.isSelf || peer.producers.length === 0) continue;
        const localPeer = this.peers.get(peer.socketId);
        if (!localPeer) continue;
        if (peer.locationName && localPeer.locationName !== peer.locationName) {
          localPeer.locationName = peer.locationName;
          this.onPeerUpdated?.(peer.socketId, { ...localPeer });
        }
        if (peer.channelId && localPeer.channelId !== peer.channelId) {
          localPeer.channelId = peer.channelId;
          this.onPeerUpdated?.(peer.socketId, { ...localPeer });
        }
        for (const producer of peer.producers) {
          const source = producer.source || producer.appData?.source || (producer.kind === 'video' ? 'camera' : 'microphone');
          if (producer.kind === 'video' && source === 'screen' && localPeer.screenPaused !== !!producer.paused) {
            localPeer.screenPaused = !!producer.paused;
            this.onPeerUpdated?.(peer.socketId, { ...localPeer });
          } else if (producer.kind === 'video' && localPeer.videoPaused !== !!producer.paused) {
            localPeer.videoPaused = !!producer.paused;
            this.onPeerUpdated?.(peer.socketId, { ...localPeer });
          }
          if (producer.kind === 'audio' && source === 'screen-audio' && localPeer.screenAudioPaused !== !!producer.paused) {
            localPeer.screenAudioPaused = !!producer.paused;
            this.onPeerUpdated?.(peer.socketId, { ...localPeer });
          } else if (producer.kind === 'audio' && localPeer.audioPaused !== !!producer.paused) {
            localPeer.audioPaused = !!producer.paused;
            this.onPeerUpdated?.(peer.socketId, { ...localPeer });
          }
        }
      }
    })();
    this._syncInFlight = syncPromise;

    try {
      return await syncPromise;
    } catch (err) {
      if (this._isSessionCurrent(setupGeneration, transport)) {
        console.warn('[ViewerWebRTC syncPeers]', err.message);
      }
    } finally {
      if (this._syncInFlight === syncPromise) this._syncInFlight = null;
    }
  }

  async getSystemState() {
    return this._request('getSystemState');
  }

  _request(type, data = {}) {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) return reject(new Error('not connected'));
      let done = false;
      let timer = null;
      const pendingRequest = {
        type,
        cancel: (err) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          this._pendingRequests.delete(pendingRequest);
          reject(err instanceof Error ? err : new Error(String(err || `${type} cancelled`)));
        },
      };
      this._pendingRequests.add(pendingRequest);

      timer = setTimeout(() => {
        if (!done) {
          done = true;
          this._pendingRequests.delete(pendingRequest);
          reject(new Error(`${type} timeout`));
        }
      }, 12000);

      socket.emit(type, data, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._pendingRequests.delete(pendingRequest);
        if (res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  _failPendingRequests(err) {
    const error = err instanceof Error ? err : new Error(String(err || 'viewer request cancelled'));
    for (const pendingRequest of Array.from(this._pendingRequests)) {
      pendingRequest.cancel(error);
    }
  }

  sendTelemetry(report) {
    if (!this.socket?.connected) return;
    const sentAt = Date.now();
    const payload = {
      ...report,
      appVersion: report.appVersion || this._appVersion,
      clientTime: sentAt,
      connection: {
        ...(report.connection || {}),
        telemetryRttMs: this._lastTelemetryRtt,
        lastTelemetryAckAt: this._lastTelemetryAckAt,
      },
      transports: this.getTransportReport(),
      consumers: this.getConsumerReport(),
    };

    this.socket.timeout(1500).emit('clientTelemetry', payload, (err) => {
      if (err) return;
      this._lastTelemetryRtt = Date.now() - sentAt;
      this._lastTelemetryAckAt = Date.now();
    });
  }

  getTransportReport() {
    return {
      socketConnected: !!this.socket?.connected,
      sendState: 'none',
      recvState: this.recvTransport?.connectionState || 'none',
      sendClosed: true,
      recvClosed: !!this.recvTransport?.closed,
    };
  }

  getConsumerReport() {
    return Array.from(this.consumers.entries()).map(([producerId, consumer]) => ({
      producerId,
      id: consumer.id,
      kind: consumer.kind,
      closed: !!consumer.closed,
      paused: !!consumer.paused,
      trackReadyState: consumer.track?.readyState || 'missing',
      trackMuted: !!consumer.track?.muted,
    }));
  }

  isSocketConnected() {
    return !!this.socket?.connected;
  }

  isInitialized() {
    return !!this._initialized;
  }

  requestReconnect() {
    if (this._manualDisconnect || !this.socket) return;
    if (!this.socket.connected) {
      this.socket.connect();
      return;
    }
    if (!this._initialized) {
      const setupAge = this._setupStartedAt ? Date.now() - this._setupStartedAt : 0;
      if (this._setupInFlight && setupAge >= SETUP_WATCHDOG_MS) {
        this._hardReconnect('server-probe-setup-stalled');
        return;
      }
      this._scheduleSetupRetry();
    }
  }

  disconnect() {
    this._manualDisconnect = true;
    this._setupGeneration += 1;
    this._setupInFlight = null;
    this._setupStartedAt = 0;
    this._initialized = false;
    this._failPendingRequests(new Error('viewer disconnected'));
    this._syncInFlight = null;
    this._clearSetupRetry();
    this._clearSessionRebuild();
    this._clearSetupWatchdog();
    if (this._hardReconnectTimer) {
      clearTimeout(this._hardReconnectTimer);
      this._hardReconnectTimer = null;
    }
    this._resetMediaSession({ notifyPeers: true, failPending: false });
    this.device = null;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      try { socket.disconnect(); } catch { /* ignore disconnect errors */ }
    }
  }
}
