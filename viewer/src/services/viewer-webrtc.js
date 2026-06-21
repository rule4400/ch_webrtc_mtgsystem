import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

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
    this._appVersion = '0.1.0';
    this._manualDisconnect = false;
    this._setupInFlight = null;
    this._consumeInFlight = new Set();
    this._iceRestartTimers = new Map();
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
    this._viewerName = viewerName || '閲覧端末';
    this._appVersion = options.appVersion || this._appVersion || '0.1.0';
    this._manualDisconnect = false;

    return new Promise((resolve, reject) => {
      this.socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        upgrade: true,
        rememberUpgrade: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
        randomizationFactor: 0.5,
        timeout: 12000,
      });

      this.socket.once('connect', async () => {
        console.log('[ViewerWebRTC] connected', this.socket.id);
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
          resolve();
        } catch (err) {
          console.error('[ViewerWebRTC] init failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
          reject(err);
        }
      });

      this.socket.once('connect_error', (err) => {
        reject(new Error(`接続失敗: ${err.message}`));
      });

      this.socket.on('disconnect', (reason) => {
        console.warn('[ViewerWebRTC] disconnected:', reason);
        this._setupGeneration += 1;
        this._initialized = false;
        this._clearSetupRetry();
        this._clearSetupWatchdog();
        this.onConnectionChange?.(false);
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          setTimeout(() => this.socket?.connect(), 2000);
        }
      });

      this.socket.io.on('reconnect', async () => {
        console.log('[ViewerWebRTC] reconnected, rebuilding session');
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
        } catch (err) {
          console.error('[ViewerWebRTC] reconnect setup failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
        }
      });

      this._bindServerEvents();
    });
  }

  async _setupSession() {
    if (this._setupInFlight) return this._setupInFlight;

    const setupGeneration = this._setupGeneration + 1;
    this._setupGeneration = setupGeneration;
    this._setupStartedAt = Date.now();
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
      await this._initMediasoup();
      assertCurrent('init-mediasoup');
      this._initialized = true;

      const queued = this._pendingQueue.splice(0);
      for (const producer of queued) {
        await this._consumePeer(producer.producerId, producer.socketId, producer.locationName, producer.kind, producer.paused, producer);
        assertCurrent('queued-consume');
      }

      this.onConnectionChange?.(true);
    })();
    this._setupInFlight = setupPromise;

    try {
      return await setupPromise;
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

  _resetMediaSession({ notifyPeers = false } = {}) {
    this.consumers.forEach(consumer => {
      try { consumer.close(); } catch { /* ignore close errors */ }
    });
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }

    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    this._consumeInFlight.clear();
    this._pendingQueue = [];
    this.recvTransport = null;
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

  _bindServerEvents() {
    this.socket.on('newProducer', async ({ producerId, socketId, locationName, kind, paused, source, appData, channelId, appType }) => {
      const payload = { producerId, socketId, locationName, kind, paused, source, appData, channelId, appType };
      if (!this._initialized) {
        if (!this._pendingQueue.find(p => p.producerId === producerId)) {
          this._pendingQueue.push(payload);
        }
        return;
      }
      await this._consumePeer(producerId, socketId, locationName, kind, paused, payload);
    });

    this.socket.on('producerClosed', ({ producerId }) => this._handleProducerClosed(producerId));
    this.socket.on('producerPaused', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, true));
    this.socket.on('producerResumed', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, false));

    this.socket.on('systemStateUpdated', (payload = {}) => {
      this.onSystemStateUpdated?.(payload);
    });

    this.socket.on('peerChannelChanged', (payload = {}) => {
      const peer = this.peers.get(payload.socketId);
      if (peer) {
        peer.channelId = payload.channelId || peer.channelId;
        this.onPeerUpdated?.(payload.socketId, { ...peer });
      }
      this.onPeerChannelChanged?.(payload);
    });

    this.socket.on('updateCommand', (payload = {}, ack) => {
      ack?.({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
      this.onUpdateCommand?.(payload);
    });

    this.socket.on('peerDisconnected', ({ socketId }) => {
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

    this.socket.on('restartCommand', (payload, ack) => {
      if (typeof ack === 'function') {
        ack({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
      }
      setTimeout(() => this.onRestartCommand?.(payload), 100);
    });

    this.socket.on('adminSetDevice', async (payload, ack) => {
      try {
        if (!this.onAdminSetDevice) throw new Error('device control is not ready');
        const result = await this.onAdminSetDevice(payload || {});
        ack?.({ ok: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    this.socket.on('adminSetMediaState', async (payload, ack) => {
      try {
        if (!this.onAdminSetMediaState) throw new Error('media state control is not ready');
        const result = await this.onAdminSetMediaState(payload || {});
        ack?.({ ok: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    this.socket.on('adminRefreshDevices', async (_payload, ack) => {
      try {
        if (!this.onAdminRefreshDevices) throw new Error('device refresh is not ready');
        const result = await this.onAdminRefreshDevices();
        ack?.({ ok: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    this.socket.on('mediaLayerRestarted', async () => {
      console.warn('[ViewerWebRTC] media layer restarted, rebuilding session');
      this._initialized = false;
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

  async _initMediasoup() {
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

    const caps = await this._request('getRouterRtpCapabilities');
    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities: caps });
    await this._initRecvTransport();

    const existing = await this._request('getProducers');
    for (const producer of existing) {
      await this._consumePeer(producer.producerId, producer.socketId, producer.locationName, producer.kind, producer.paused, producer);
    }
  }

  _transportOptions(params) {
    return this.iceServers.length ? { ...params, iceServers: this.iceServers } : params;
  }

  async _initRecvTransport() {
    const { params } = await this._request('createWebRtcTransport', { forceTcp: false });
    this.recvTransport = this.device.createRecvTransport(this._transportOptions(params));
    this.recvTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      try {
        await this._request('connectTransport', { transportId: this.recvTransport.id, dtlsParameters });
        cb();
      } catch (err) {
        eb(err);
      }
    });
    this.recvTransport.on('connectionstatechange', (state) => {
      console.log('[viewerRecvTransport]', state);
      if (state === 'failed' || state === 'disconnected') this._scheduleIceRestart(this.recvTransport, 'viewerRecvTransport');
    });
  }

  _scheduleIceRestart(transport, label) {
    if (!transport || transport.closed) return;
    if (this._iceRestartTimers.has(transport.id)) return;

    const timer = setTimeout(() => {
      this._iceRestartTimers.delete(transport.id);
      this._restartTransportIce(transport).catch(err => {
        console.warn(`[${label} restartIce]`, err.message);
        this._scheduleSessionRebuild(`${label}-ice-restart-failed`);
      });
    }, 1500);
    this._iceRestartTimers.set(transport.id, timer);
  }

  async _restartTransportIce(transport) {
    if (!transport || transport.closed) return;
    const { iceParameters } = await this._request('restartIce', { transportId: transport.id });
    if (iceParameters) await transport.restartIce({ iceParameters });
  }

  async _consumePeer(producerId, socketId, locationName, kind, paused, metadata = {}) {
    if (!this.recvTransport) return;
    if (this.consumers.has(producerId)) return;
    if (this._consumeInFlight.has(producerId)) return;
    this._consumeInFlight.add(producerId);

    try {
      const { params } = await this._request('consume', {
        transportId: this.recvTransport.id,
        producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      });

      const consumer = await this.recvTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      this.consumers.set(producerId, consumer);
      await this._request('resume', { consumerId: consumer.id });

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
        peer.screenStream.addTrack(consumer.track);
        peer.screenProducerId = producerId;
        peer.screenPaused = !!paused;
        peer.screenLabel = appData.label || appData.sourceName || '画面共有';
      } else if (kind === 'audio' && source === 'screen-audio') {
        peer.screenStream.addTrack(consumer.track);
        peer.screenAudioProducerId = producerId;
        peer.screenAudioPaused = !!paused;
        peer.screenLabel = peer.screenLabel || appData.label || appData.sourceName || '画面共有';
      } else {
        peer.stream.addTrack(consumer.track);
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
      console.error('[ViewerWebRTC _consumePeer]', err);
    } finally {
      this._consumeInFlight.delete(producerId);
    }
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
        this.onPeerUpdated?.(socketId, { ...peer });
        break;
      }
      if (peer.audioProducerId === producerId) {
        peer.audioProducerId = null;
        peer.audioPaused = true;
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

    try {
      const peerList = await this._request('getPeers');

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
    } catch (err) {
      console.warn('[ViewerWebRTC syncPeers]', err.message);
    }
  }

  async getSystemState() {
    return this._request('getSystemState');
  }

  _request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error('not connected'));
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error(`${type} timeout`));
        }
      }, 12000);

      this.socket.emit(type, data, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
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
    this._initialized = false;
    this._clearSetupRetry();
    this._clearSessionRebuild();
    this._clearSetupWatchdog();
    if (this._hardReconnectTimer) {
      clearTimeout(this._hardReconnectTimer);
      this._hardReconnectTimer = null;
    }
    this._resetMediaSession({ notifyPeers: true });
    this.socket?.disconnect();
  }
}
