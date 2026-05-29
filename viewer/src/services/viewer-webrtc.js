import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

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
    this._manualDisconnect = false;
    this._setupInFlight = null;
    this._consumeInFlight = new Set();
    this._iceRestartTimers = new Map();
    this._setupRetryTimer = null;
    this._setupRetryDelay = 1000;
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;

    this.onPeerUpdated = null;
    this.onPeerRemoved = null;
    this.onRestartCommand = null;
    this.onAdminSetDevice = null;
    this.onAdminRefreshDevices = null;
    this.onConnectionChange = null;
  }

  connect(serverUrl, viewerName) {
    this._viewerName = viewerName || '閲覧端末';
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
        this._initialized = false;
        this._clearSetupRetry();
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

    this._setupInFlight = (async () => {
      this._clearSetupRetry();
      this.socket.emit('setMetadata', { locationName: this._viewerName, appType: 'viewer' });
      await this._initMediasoup();
      this._initialized = true;

      const queued = this._pendingQueue.splice(0);
      for (const producer of queued) {
        await this._consumePeer(producer.producerId, producer.socketId, producer.locationName, producer.kind, producer.paused);
      }

      this.onConnectionChange?.(true);
    })();

    try {
      return await this._setupInFlight;
    } finally {
      this._setupInFlight = null;
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

  _bindServerEvents() {
    this.socket.on('newProducer', async ({ producerId, socketId, locationName, kind, paused }) => {
      if (!this._initialized) {
        if (!this._pendingQueue.find(p => p.producerId === producerId)) {
          this._pendingQueue.push({ producerId, socketId, locationName, kind, paused });
        }
        return;
      }
      await this._consumePeer(producerId, socketId, locationName, kind, paused);
    });

    this.socket.on('producerClosed', ({ producerId }) => this._handleProducerClosed(producerId));
    this.socket.on('producerPaused', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, true));
    this.socket.on('producerResumed', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, false));

    this.socket.on('peerDisconnected', ({ socketId }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        for (const producerId of [peer.videoProducerId, peer.audioProducerId]) {
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
      peer.videoProducerId = null;
      peer.audioProducerId = null;
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
      await this._consumePeer(producer.producerId, producer.socketId, producer.locationName, producer.kind, producer.paused);
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
      this._restartTransportIce(transport).catch(err => console.warn(`[${label} restartIce]`, err.message));
    }, 1500);
    this._iceRestartTimers.set(transport.id, timer);
  }

  async _restartTransportIce(transport) {
    if (!transport || transport.closed) return;
    const { iceParameters } = await this._request('restartIce', { transportId: transport.id });
    if (iceParameters) await transport.restartIce({ iceParameters });
  }

  async _consumePeer(producerId, socketId, locationName, kind, paused) {
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
          stream: new MediaStream(),
          videoProducerId: null,
          audioProducerId: null,
          videoPaused: false,
          audioPaused: false,
        };
        this.peers.set(socketId, peer);
      }

      if (locationName) peer.locationName = locationName;
      peer.stream.addTrack(consumer.track);
      if (kind === 'video') {
        peer.videoProducerId = producerId;
        peer.videoPaused = !!paused;
      } else {
        peer.audioProducerId = producerId;
        peer.audioPaused = !!paused;
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
    }
  }

  _setProducerPaused(producerId, socketId, paused) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    if (peer.videoProducerId === producerId) peer.videoPaused = paused;
    if (peer.audioProducerId === producerId) peer.audioPaused = paused;
    this.onPeerUpdated?.(socketId, { ...peer });
  }

  async syncPeers() {
    if (!this._initialized) return;

    try {
      const peerList = await this._request('getPeers');

      for (const peer of peerList) {
        if (peer.isSelf) continue;
        for (const { producerId, kind, paused } of peer.producers) {
          await this._consumePeer(producerId, peer.socketId, peer.locationName, kind, paused);
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
        for (const { kind, paused } of peer.producers) {
          if (kind === 'video' && localPeer.videoPaused !== !!paused) {
            localPeer.videoPaused = !!paused;
            this.onPeerUpdated?.(peer.socketId, { ...localPeer });
          }
          if (kind === 'audio' && localPeer.audioPaused !== !!paused) {
            localPeer.audioPaused = !!paused;
            this.onPeerUpdated?.(peer.socketId, { ...localPeer });
          }
        }
      }
    } catch (err) {
      console.warn('[ViewerWebRTC syncPeers]', err.message);
    }
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

  disconnect() {
    this._manualDisconnect = true;
    this._initialized = false;
    this.consumers.forEach(consumer => {
      try { consumer.close(); } catch { /* ignore close errors */ }
    });
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }
    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    this._clearSetupRetry();
    this.socket?.disconnect();
    this.peers.clear();
    this.consumers.clear();
  }
}
