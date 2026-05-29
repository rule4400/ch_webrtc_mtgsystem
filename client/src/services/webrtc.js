/**
 * webrtc.js – mediasoup-client + Socket.IO
 *
 * 安定化のポイント:
 *   - 再接続時に device/transport を作り直し、ローカルトラックを必ず再 produce する
 *   - producer は manager が所有（MainView 側の stale ref を排除）
 *   - cam/mic の ON/OFF 状態を保持し、再接続後も復元する
 *   - サーバーから iceServers を受け取り、拠点間 NAT 越えの TCP/TURN フォールバックに対応
 *   - newProducer は初期化前ならキューイング、consume は重複防止＋失敗時は黙ってスキップ
 *     （1秒ポーリング syncPeers が取りこぼしを回収する）
 */

import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

export class WebRTCManager {
  constructor() {
    this.socket        = null;
    this.device        = null;
    this.sendTransport = null;
    this.recvTransport = null;

    this.consumers = new Map();   // producerId → Consumer
    this.peers     = new Map();   // socketId   → PeerInfo

    // ローカル送信状態（再接続時に復元するため manager が保持）
    this.localVideoTrack = null;
    this.localAudioTrack = null;
    this.videoProducer   = null;
    this.audioProducer   = null;
    this.camEnabled      = true;
    this.micEnabled      = true;

    this.iceServers      = [];     // サーバーから取得
    this._initialized    = false;
    this._pendingQueue   = [];     // 初期化前に届いた newProducer
    this._locationName   = '';
    this._manualDisconnect = false;
    this._setupInFlight = null;
    this._consumeInFlight = new Set();
    this._iceRestartTimers = new Map();
    this._setupRetryTimer = null;
    this._setupRetryDelay = 1000;
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;

    // コールバック
    this.onPeerUpdated      = null;  // (socketId, peer) => void
    this.onPeerRemoved      = null;  // (socketId) => void
    this.onRestartCommand   = null;  // () => void
    this.onAdminSetDevice   = null;  // ({ kind, deviceId }) => Promise
    this.onAdminRefreshDevices = null; // () => Promise
    this.onConnectionChange = null;  // (connected: bool) => void
    this.onViewerPresenceChange = null; // (active: bool) => void
  }

  // ── 接続（mediasoup 初期化＋ローカル produce まで await）──────────────

  connect(serverUrl, locationName) {
    this._locationName = locationName;
    this._manualDisconnect = false;
    return new Promise((resolve, reject) => {
      this.socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        upgrade: true,
        rememberUpgrade: true,
        reconnectionAttempts: Infinity,   // 常時接続用途: 無限リトライ
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
        randomizationFactor: 0.5,
        timeout: 12000,
      });

      this.socket.once('connect', async () => {
        console.log('[WebRTC] connected', this.socket.id);
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
          resolve();
        } catch (err) {
          console.error('[WebRTC] init failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
          reject(err);
        }
      });

      this.socket.once('connect_error', (err) => {
        reject(new Error(`接続失敗: ${err.message}`));
      });

      this.socket.on('disconnect', (reason) => {
        console.warn('[WebRTC] disconnected:', reason);
        this._initialized = false;
        this._clearSetupRetry();
        this.onConnectionChange?.(false);
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          setTimeout(() => this.socket?.connect(), 2000);
        }
      });

      // socket.io の自動再接続後に毎回セッションを張り直す
      this.socket.io.on('reconnect', async () => {
        console.log('[WebRTC] reconnected, rebuilding session');
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
        } catch (err) {
          console.error('[WebRTC] reconnect setup failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
        }
      });

      this._bindServerEvents();
    });
  }

  /** 接続/再接続のたびに呼ぶ: device→transport→既存consume→ローカルreproduceを再構築 */
  async _setupSession() {
    if (this._setupInFlight) return this._setupInFlight;
    this._setupInFlight = (async () => {
      this._clearSetupRetry();
      this.socket.emit('setMetadata', { locationName: this._locationName, appType: 'client' });
      await this._initMediasoup();
      this._initialized = true;

      // 初期化前にキューイングした newProducer を処理
      const queued = this._pendingQueue.splice(0);
      for (const p of queued) {
        await this._consumePeer(p.producerId, p.socketId, p.locationName, p.kind, p.paused);
      }

      // ローカルトラックを（再）produce
      await this._reproduceLocal();

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
      console.warn(`[WebRTC] retrying media setup in-place after ${delay}ms backoff`);
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[WebRTC] setup retry failed', err);
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
    this.socket.on('newProducer', async ({ producerId, socketId, locationName: name, kind, paused }) => {
      if (!this._initialized) {
        if (!this._pendingQueue.find(p => p.producerId === producerId)) {
          this._pendingQueue.push({ producerId, socketId, locationName: name, kind, paused });
        }
        return;
      }
      await this._consumePeer(producerId, socketId, name, kind, paused);
    });

    this.socket.on('producerClosed', ({ producerId }) => this._handleProducerClosed(producerId));
    this.socket.on('producerPaused',  ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, true));
    this.socket.on('producerResumed', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, false));

    this.socket.on('viewerPresence', (payload = {}) => {
      this.onViewerPresenceChange?.(!!payload.active);
    });

    this.socket.on('peerDisconnected', ({ socketId }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        for (const pid of [peer.videoProducerId, peer.audioProducerId]) {
          if (!pid) continue;
          const consumer = this.consumers.get(pid);
          if (consumer) {
            try { consumer.close(); } catch { /* ignore close errors */ }
            this.consumers.delete(pid);
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
      console.warn('[WebRTC] media layer restarted, rebuilding session');
      this._initialized = false;
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[WebRTC] media layer rebuild failed', err);
        this.onConnectionChange?.(false);
        this._scheduleSetupRetry();
      }
    });
  }

  // ── mediasoup 初期化 ─────────────────────────────────────

  async _initMediasoup() {
    // 古い transport を掃除（再接続時）
    try { this.videoProducer?.close(); } catch { /* ignore close errors */ }
    try { this.audioProducer?.close(); } catch { /* ignore close errors */ }
    try { this.sendTransport?.close(); } catch { /* ignore close errors */ }
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }
    this.sendTransport = null;
    this.recvTransport = null;
    this.videoProducer = null;
    this.audioProducer = null;
    this.consumers.clear();
    // peers の stream は残すが、consumer は再生成される
    for (const peer of this.peers.values()) {
      peer.stream = new MediaStream();
      peer.videoProducerId = null;
      peer.audioProducerId = null;
    }

    // サーバー設定（iceServers）取得（任意・失敗しても続行）
    try {
      const cfg = await this._request('getServerConfig');
      if (cfg && Array.isArray(cfg.iceServers)) this.iceServers = cfg.iceServers;
    } catch {
      // Older server versions did not expose this optional event.
    }

    const caps = await this._request('getRouterRtpCapabilities');
    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities: caps });
    await this._initSendTransport();
    await this._initRecvTransport();

    // 既存 Producer を全て消費
    const existing = await this._request('getProducers');
    for (const p of existing) {
      await this._consumePeer(p.producerId, p.socketId, p.locationName, p.kind, p.paused);
    }
  }

  _transportOptions(params) {
    return this.iceServers.length
      ? { ...params, iceServers: this.iceServers }
      : params;
  }

  async _initSendTransport() {
    const { params } = await this._request('createWebRtcTransport', { forceTcp: false });
    this.sendTransport = this.device.createSendTransport(this._transportOptions(params));
    this.sendTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      try { await this._request('connectTransport', { transportId: this.sendTransport.id, dtlsParameters }); cb(); }
      catch (e) { eb(e); }
    });
    this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, eb) => {
      try { const { id } = await this._request('produce', { transportId: this.sendTransport.id, kind, rtpParameters, appData }); cb({ id }); }
      catch (e) { eb(e); }
    });
    this.sendTransport.on('connectionstatechange', (s) => {
      console.log('[sendTransport]', s);
      if (s === 'failed' || s === 'disconnected') this._scheduleIceRestart(this.sendTransport, 'sendTransport');
    });
  }

  async _initRecvTransport() {
    const { params } = await this._request('createWebRtcTransport', { forceTcp: false });
    this.recvTransport = this.device.createRecvTransport(this._transportOptions(params));
    this.recvTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      try { await this._request('connectTransport', { transportId: this.recvTransport.id, dtlsParameters }); cb(); }
      catch (e) { eb(e); }
    });
    this.recvTransport.on('connectionstatechange', (s) => {
      console.log('[recvTransport]', s);
      if (s === 'failed' || s === 'disconnected') this._scheduleIceRestart(this.recvTransport, 'recvTransport');
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

  // ── 送信 ─────────────────────────────────────────────────

  /** MainView から渡されたローカルトラックを登録（produce は _reproduceLocal で実施） */
  setLocalTracks(videoTrack, audioTrack) {
    this.localVideoTrack = videoTrack || null;
    this.localAudioTrack = audioTrack || null;
  }

  /** 登録済みローカルトラックを produce。再接続時もこれで復元する */
  async _reproduceLocal() {
    if (!this.sendTransport) return;
    if (this.localVideoTrack) {
      this.videoProducer = await this._produceTrack(this.localVideoTrack, 'video');
      if (!this.camEnabled) await this._pauseProducer(this.videoProducer);
    }
    if (this.localAudioTrack) {
      this.audioProducer = await this._produceTrack(this.localAudioTrack, 'audio');
      if (!this.micEnabled) await this._pauseProducer(this.audioProducer);
    }
  }

  async _produceTrack(track, kind) {
    const params = { track };
    if (kind === 'video') {
      params.encodings = [
        { rid: 'r0', maxBitrate: 150_000, scaleResolutionDownBy: 4 },
        { rid: 'r1', maxBitrate: 500_000, scaleResolutionDownBy: 2 },
        { rid: 'r2', maxBitrate: 1_200_000 },
      ];
      params.codecOptions = { videoGoogleStartBitrate: 1000 };
    }
    const producer = await this.sendTransport.produce(params);
    producer.on('transportclose', () => {
      if (kind === 'video' && this.videoProducer === producer) this.videoProducer = null;
      if (kind === 'audio' && this.audioProducer === producer) this.audioProducer = null;
    });
    producer.on('trackended', () => {
      console.warn(`[producer] ${kind} track ended`);
    });
    return producer;
  }

  /** カメラ差し替え（デバイス変更時） */
  async replaceVideoTrack(track) {
    this.localVideoTrack = track;
    if (this.videoProducer && track) {
      try { await this.videoProducer.replaceTrack({ track }); } catch (e) { console.error('[replaceVideoTrack]', e); }
    } else if (this.sendTransport && track) {
      this.videoProducer = await this._produceTrack(track, 'video');
      if (!this.camEnabled) await this._pauseProducer(this.videoProducer);
    }
  }

  async replaceAudioTrack(track) {
    this.localAudioTrack = track;
    if (this.audioProducer && track) {
      try { await this.audioProducer.replaceTrack({ track }); } catch (e) { console.error('[replaceAudioTrack]', e); }
    } else if (this.sendTransport && track) {
      this.audioProducer = await this._produceTrack(track, 'audio');
      if (!this.micEnabled) await this._pauseProducer(this.audioProducer);
    }
  }

  async setCamEnabled(enabled) {
    this.camEnabled = enabled;
    if (!this.videoProducer) return;
    if (enabled) await this._resumeProducer(this.videoProducer);
    else         await this._pauseProducer(this.videoProducer);
  }

  async setMicEnabled(enabled) {
    this.micEnabled = enabled;
    if (!this.audioProducer) return;
    if (enabled) await this._resumeProducer(this.audioProducer);
    else         await this._pauseProducer(this.audioProducer);
  }

  async _pauseProducer(p) {
    if (!p || p.paused) return;
    p.pause();
    try { await this._request('pauseProducer', { producerId: p.id }); } catch { /* keep local state */ }
  }

  async _resumeProducer(p) {
    if (!p || !p.paused) return;
    p.resume();
    try { await this._request('resumeProducer', { producerId: p.id }); } catch { /* keep local state */ }
  }

  // ── 受信 ─────────────────────────────────────────────────

  async _consumePeer(producerId, socketId, locationName, kind, paused) {
    if (!this.recvTransport) { console.warn('[consume] recvTransport not ready'); return; }
    if (this.consumers.has(producerId)) return; // 重複消費を防ぐ
    if (this._consumeInFlight.has(producerId)) return;
    this._consumeInFlight.add(producerId);

    try {
      const { params } = await this._request('consume', {
        transportId:     this.recvTransport.id,
        producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      });
      const consumer = await this.recvTransport.consume({
        id:            params.id,
        producerId:    params.producerId,
        kind:          params.kind,
        rtpParameters: params.rtpParameters,
      });
      this.consumers.set(producerId, consumer);
      await this._request('resume', { consumerId: consumer.id });

      let peer = this.peers.get(socketId);
      if (!peer) {
        peer = {
          locationName:    locationName || '不明',
          stream:          new MediaStream(),
          videoProducerId: null,
          audioProducerId: null,
          videoPaused:     false,
          audioPaused:     false,
        };
        this.peers.set(socketId, peer);
      }
      if (locationName) peer.locationName = locationName;
      peer.stream.addTrack(consumer.track);
      if (kind === 'video') { peer.videoProducerId = producerId; peer.videoPaused = !!paused; }
      else                  { peer.audioProducerId = producerId; peer.audioPaused = !!paused; }

      this.onPeerUpdated?.(socketId, { ...peer, stream: peer.stream });
      console.log(`[consume] ${socketId} ${kind} ok`);
    } catch (err) {
      console.error('[_consumePeer]', err);
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
      if (peer.videoProducerId === producerId) { peer.videoProducerId = null; this.onPeerUpdated?.(socketId, { ...peer }); break; }
      if (peer.audioProducerId === producerId) { peer.audioProducerId = null; this.onPeerUpdated?.(socketId, { ...peer }); break; }
    }
  }

  _setProducerPaused(producerId, socketId, paused) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    if (peer.videoProducerId === producerId) peer.videoPaused = paused;
    if (peer.audioProducerId === producerId) peer.audioPaused = paused;
    this.onPeerUpdated?.(socketId, { ...peer });
  }

  // ── 1秒ポーリング用: サーバーの状態と同期 ────────────────

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

      const active = new Set(peerList.filter(p => !p.isSelf).map(p => p.socketId));
      for (const [socketId] of this.peers) {
        if (!active.has(socketId)) {
          this.peers.delete(socketId);
          this.onPeerRemoved?.(socketId);
        }
      }

      for (const peer of peerList) {
        if (peer.isSelf) continue;
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
      console.warn('[syncPeers]', err.message);
    }
  }

  // ── ユーティリティ ────────────────────────────────────────

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
      sendState: this.sendTransport?.connectionState || 'none',
      recvState: this.recvTransport?.connectionState || 'none',
      sendClosed: !!this.sendTransport?.closed,
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

  _request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error('not connected'));
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`${type} timeout`)); } }, 12000);
      this.socket.emit(type, data, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  disconnect() {
    this._manualDisconnect = true;
    this._initialized = false;
    try { this.videoProducer?.close(); } catch { /* ignore close errors */ }
    try { this.audioProducer?.close(); } catch { /* ignore close errors */ }
    this.consumers.forEach(c => { try { c.close(); } catch { /* ignore close errors */ } });
    try { this.sendTransport?.close(); } catch { /* ignore close errors */ }
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }
    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    this._clearSetupRetry();
    this.socket?.disconnect();
    this.peers.clear();
    this.consumers.clear();
    this.videoProducer = null;
    this.audioProducer = null;
  }
}
