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

const SETUP_WATCHDOG_MS = 20000;
const HARD_RECONNECT_DELAY_MS = 1000;
const INBOUND_STALL_WATCHDOG_MS = 12000;
const WATCHDOG_RECOVERY_COOLDOWN_MS = 18000;
const STATS_SAMPLE_TIMEOUT_MS = 600;

function statsItems(stats) {
  if (!stats || typeof stats.values !== 'function') return [];
  return Array.from(stats.values());
}

function sumInboundBytes(stats) {
  const items = statsItems(stats).filter(item => item.type === 'inbound-rtp' && !item.isRemote);
  if (!items.length) return null;
  return items.reduce((total, item) => total + (Number.isFinite(item.bytesReceived) ? item.bytesReceived : 0), 0);
}

function withTimeout(promise, timeoutMs, fallback = null) {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve(fallback);
  let timer = null;
  return new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then(value => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  });
}

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

    // 画面共有（カメラとは別 Producer。screen-share 専用アプリと同じ appData 規約）
    this.localScreenVideoTrack = null;
    this.localScreenAudioTrack = null;
    this.screenLabel           = '';
    this.screenProducer        = null;
    this.screenAudioProducer   = null;
    this.screenPaused          = false;

    this.iceServers      = [];     // サーバーから取得
    this._initialized    = false;
    this._pendingQueue   = [];     // 初期化前に届いた newProducer
    this._locationName   = '';
    this._channelId      = 'general';
    this._appVersion     = '0.1.0';
    this._manualDisconnect = false;
    this._setupInFlight = null;
    this._consumeInFlight = new Set();
    this._iceRestartTimers = new Map();
    this._setupRetryTimer = null;
    this._setupRetryDelay = 1000;
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;
    this._connectGeneration = 0;
    this._setupGeneration = 0;
    this._setupStartedAt = 0;
    this._setupWatchdogTimer = null;
    this._hardReconnectTimer = null;
    this._sessionRebuildTimer = null;
    this._selfSocketId = '';
    this._receiveWatchdog = {
      lastInboundBytes: null,
      lastInboundAt: null,
      lastRecoveryAt: 0,
      sampling: false,
    };

    // コールバック
    this.onPeerUpdated      = null;  // (socketId, peer) => void
    this.onPeerRemoved      = null;  // (socketId) => void
    this.onRestartCommand   = null;  // () => void
    this.onAdminSetDevice   = null;  // ({ kind, deviceId }) => Promise
    this.onAdminSetMediaState = null; // ({ kind, enabled }) => Promise
    this.onAdminRefreshDevices = null; // () => Promise
    this.onConnectionChange = null;  // (connected: bool) => void
    this.onViewerPresenceChange = null; // (active: bool) => void
    this.onSystemStateUpdated = null; // (state) => void
    this.onPeerChannelChanged = null; // (payload) => void
    this.onUpdateCommand = null;  // (payload) => void
    this.onPeerJoined = null; // (payload) => void
    this.onIncomingCall = null; // (payload) => void
    this.onCallResult = null; // ({ callId, action }) => void 発信した呼び出しの結果
    this.onCallCancelled = null; // ({ callId }) => void 着信中の呼び出しが取り消された
    this.onScreenShareEnded = null; // () => void 共有トラック終了（ウィンドウが閉じた等）
  }

  // ── 接続（mediasoup 初期化＋ローカル produce まで await）──────────────

  connect(serverUrl, locationName, options = {}) {
    this._locationName = locationName;
    this._channelId = options.channelId || this._channelId || 'general';
    this._appVersion = options.appVersion || this._appVersion || '0.1.0';
    this._manualDisconnect = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

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

      this.socket.on('connect', async () => {
        const generation = this._connectGeneration + 1;
        this._connectGeneration = generation;
        this._selfSocketId = this.socket.id || '';
        console.log('[WebRTC] connected', this.socket.id);
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
          if (generation === this._connectGeneration) resolveOnce();
        } catch (err) {
          console.error('[WebRTC] connect setup failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
          rejectOnce(err);
        }
      });

      this.socket.on('connect_error', (err) => {
        console.warn('[WebRTC] connect_error:', err.message);
        this._initialized = false;
        this.onConnectionChange?.(false);
      });

      this.socket.on('disconnect', (reason) => {
        console.warn('[WebRTC] disconnected:', reason);
        this._connectGeneration += 1;
        this._setupGeneration += 1;
        this._initialized = false;
        this._clearSetupRetry();
        this._clearSetupWatchdog();
        this._resetMediaSession({ notifyPeers: true, keepPeers: false });
        this.onConnectionChange?.(false);
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          setTimeout(() => this.socket?.connect(), 2000);
        }
      });

      this.socket.io.on('reconnect_attempt', () => {
        if (!this._manualDisconnect) this.onConnectionChange?.(false);
      });

      this.socket.io.on('reconnect', () => {
        console.log('[WebRTC] reconnect transport restored');
      });

      this._bindServerEvents();
    });
  }

  /** 接続/再接続のたびに呼ぶ: device→transport→既存consume→ローカルreproduceを再構築 */
  async _setupSession() {
    if (this._setupInFlight) return this._setupInFlight;
    const setupGeneration = this._setupGeneration + 1;
    const connectGeneration = this._connectGeneration;
    this._setupGeneration = setupGeneration;
    this._setupStartedAt = Date.now();
    this._armSetupWatchdog(setupGeneration);

    const assertCurrent = (stage) => {
      if (
        this._manualDisconnect ||
        !this.socket?.connected ||
        this._setupGeneration !== setupGeneration ||
        this._connectGeneration !== connectGeneration
      ) {
        throw new Error(`setup superseded at ${stage}`);
      }
    };

    const setupPromise = (async () => {
      this._clearSetupRetry();
      this.socket.emit('setMetadata', {
        locationName: this._locationName,
        appType: 'client',
        channelId: this._channelId,
        appVersion: this._appVersion,
      });
      await this._initMediasoup();
      assertCurrent('init-mediasoup');
      this._initialized = true;

      // 初期化前にキューイングした newProducer を処理
      const queued = this._pendingQueue.splice(0);
      for (const p of queued) {
        await this._consumePeer(p.producerId, p.socketId, p.locationName, p.kind, p.paused, p);
        assertCurrent('queued-consume');
      }

      // ローカルトラックを（再）produce
      await this._reproduceLocal();
      assertCurrent('reproduce-local');

      this.onConnectionChange?.(true);
      await this.syncPeers();
      assertCurrent('sync-peers');
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
      console.warn('[WebRTC] setup watchdog fired; hard reconnecting');
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
    console.warn(`[WebRTC] hard reconnect requested reason=${reason}`);
    this._setupGeneration += 1;
    this._setupInFlight = null;
    this._initialized = false;
    this._clearSetupRetry();
    this._clearSessionRebuild();
    this._clearSetupWatchdog();
    this._resetMediaSession({ notifyPeers: true, keepPeers: false });
    this.onConnectionChange?.(false);

    const socket = this.socket;
    try { socket.disconnect(); } catch { /* ignore disconnect errors */ }
    this._hardReconnectTimer = setTimeout(() => {
      this._hardReconnectTimer = null;
      if (!this._manualDisconnect && socket === this.socket) {
        try { this.socket.connect(); } catch { /* reconnect will retry through socket.io */ }
      }
    }, HARD_RECONNECT_DELAY_MS);
  }

  _scheduleSessionRebuild(reason = 'transport-failure') {
    if (this._manualDisconnect || !this.socket?.connected || this._sessionRebuildTimer) return;
    this._sessionRebuildTimer = setTimeout(async () => {
      this._sessionRebuildTimer = null;
      if (this._manualDisconnect || !this.socket?.connected) return;
      console.warn(`[WebRTC] rebuilding media session reason=${reason}`);
      this._initialized = false;
      this._resetMediaSession({ keepPeers: true });
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[WebRTC] session rebuild failed', err);
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

  async _sampleInboundBytes() {
    const consumers = Array.from(this.consumers.values()).filter(consumer => consumer && !consumer.closed);
    if (!consumers.length) return null;
    const values = await Promise.all(consumers.map(async (consumer) => {
      const stats = await withTimeout(consumer.getStats?.(), STATS_SAMPLE_TIMEOUT_MS, null);
      return sumInboundBytes(stats);
    }));
    const numeric = values.filter(value => Number.isFinite(value));
    if (!numeric.length) return null;
    return numeric.reduce((total, value) => total + value, 0);
  }

  _evaluateReceiveWatchdog(report = {}) {
    if (this._receiveWatchdog.sampling || this._manualDisconnect || !this.socket?.connected || !this._initialized) return;
    const remotePeerCount = Number(report.remoteMonitor?.peerCount || 0);
    if (remotePeerCount <= 0 || this.consumers.size <= 0) {
      this._receiveWatchdog.lastInboundBytes = null;
      this._receiveWatchdog.lastInboundAt = null;
      return;
    }

    this._receiveWatchdog.sampling = true;
    this._sampleInboundBytes()
      .then(inboundBytes => {
        const now = Date.now();
        if (inboundBytes == null) return;
        const lastBytes = this._receiveWatchdog.lastInboundBytes;
        if (lastBytes == null || inboundBytes > lastBytes) {
          this._receiveWatchdog.lastInboundBytes = inboundBytes;
          this._receiveWatchdog.lastInboundAt = now;
          return;
        }

        const stalledFor = now - (this._receiveWatchdog.lastInboundAt || now);
        const sinceRecovery = now - (this._receiveWatchdog.lastRecoveryAt || 0);
        this._receiveWatchdog.lastInboundBytes = inboundBytes;
        if (stalledFor >= INBOUND_STALL_WATCHDOG_MS && sinceRecovery >= WATCHDOG_RECOVERY_COOLDOWN_MS) {
          this._receiveWatchdog.lastRecoveryAt = now;
          console.warn(`[WebRTC] inbound RTP stalled for ${stalledFor}ms; rebuilding session`);
          this._scheduleSessionRebuild('inbound-rtp-stalled');
        }
      })
      .finally(() => {
        this._receiveWatchdog.sampling = false;
      });
  }

  _resetMediaSession({ notifyPeers = false, keepPeers = false } = {}) {
    try { this.videoProducer?.close(); } catch { /* ignore close errors */ }
    try { this.audioProducer?.close(); } catch { /* ignore close errors */ }
    try { this.screenProducer?.close(); } catch { /* ignore close errors */ }
    try { this.screenAudioProducer?.close(); } catch { /* ignore close errors */ }
    this.consumers.forEach(consumer => {
      try { consumer.close(); } catch { /* ignore close errors */ }
    });
    try { this.sendTransport?.close(); } catch { /* ignore close errors */ }
    try { this.recvTransport?.close(); } catch { /* ignore close errors */ }

    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    this._consumeInFlight.clear();
    this._pendingQueue = [];
    this.consumers.clear();
    this.sendTransport = null;
    this.recvTransport = null;
    this.videoProducer = null;
    this.audioProducer = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this._receiveWatchdog.lastInboundBytes = null;
    this._receiveWatchdog.lastInboundAt = null;
    this._receiveWatchdog.sampling = false;

    if (notifyPeers && !keepPeers) {
      for (const socketId of this.peers.keys()) this.onPeerRemoved?.(socketId);
    }
    if (!keepPeers) this.peers.clear();
  }

  _bindServerEvents() {
    this.socket.on('newProducer', async ({ producerId, socketId, locationName: name, kind, paused, source, appData, channelId, appType }) => {
      if (this._isSelfSocket(socketId)) return;
      const payload = { producerId, socketId, locationName: name, kind, paused, source, appData, channelId, appType };
      if (!this._initialized) {
        if (!this._pendingQueue.find(p => p.producerId === producerId)) {
          this._pendingQueue.push(payload);
        }
        return;
      }
      await this._consumePeer(producerId, socketId, name, kind, paused, payload);
    });

    this.socket.on('producerClosed', ({ producerId }) => this._handleProducerClosed(producerId));
    this.socket.on('producerPaused',  ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, true));
    this.socket.on('producerResumed', ({ producerId, socketId }) => this._setProducerPaused(producerId, socketId, false));

    this.socket.on('viewerPresence', (payload = {}) => {
      this.onViewerPresenceChange?.(!!payload.active);
    });

    this.socket.on('systemStateUpdated', (payload = {}) => {
      this.onSystemStateUpdated?.(payload);
    });

    this.socket.on('peerChannelChanged', (payload = {}) => {
      const socketId = payload.socketId;
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.channelId = payload.channelId || peer.channelId;
        this.onPeerUpdated?.(socketId, { ...peer });
      }
      this.onPeerChannelChanged?.(payload);
    });

    this.socket.on('peerJoined', (payload = {}) => {
      this.onPeerJoined?.(payload);
    });

    this.socket.on('incomingCall', (payload = {}, ack) => {
      ack?.({ ok: true, receivedAt: Date.now(), socketId: this.socket.id });
      this.onIncomingCall?.(payload);
    });

    this.socket.on('callResult', (payload = {}) => {
      this.onCallResult?.(payload);
    });

    this.socket.on('callCancelled', (payload = {}) => {
      this.onCallCancelled?.(payload);
    });

    this.socket.on('updateCommand', (payload = {}, ack) => {
      ack?.({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
      this.onUpdateCommand?.(payload);
    });

    this.socket.on('peerDisconnected', ({ socketId }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        for (const pid of [peer.videoProducerId, peer.audioProducerId, peer.screenProducerId, peer.screenAudioProducerId]) {
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
    try { this.screenProducer?.close(); } catch { /* ignore close errors */ }
    try { this.screenAudioProducer?.close(); } catch { /* ignore close errors */ }
    this.sendTransport = null;
    this.recvTransport = null;
    this.videoProducer = null;
    this.audioProducer = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.consumers.clear();
    // peers の stream は残すが、consumer は再生成される
    for (const peer of this.peers.values()) {
      peer.stream = new MediaStream();
      peer.screenStream = new MediaStream();
      peer.videoProducerId = null;
      peer.audioProducerId = null;
      peer.screenProducerId = null;
      peer.screenAudioProducerId = null;
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
      await this._consumePeer(p.producerId, p.socketId, p.locationName, p.kind, p.paused, p);
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
      if (s === 'failed') this._scheduleIceRestart(this.sendTransport, 'sendTransport', 500);
      if (s === 'disconnected') this._scheduleIceRestart(this.sendTransport, 'sendTransport', 4500);
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
      if (s === 'failed') this._scheduleIceRestart(this.recvTransport, 'recvTransport', 500);
      if (s === 'disconnected') this._scheduleIceRestart(this.recvTransport, 'recvTransport', 4500);
    });
  }

  _scheduleIceRestart(transport, label, delay = 1500) {
    if (!transport || transport.closed) return;
    if (this._iceRestartTimers.has(transport.id)) return;

    const timer = setTimeout(() => {
      this._iceRestartTimers.delete(transport.id);
      this._restartTransportIce(transport).catch(err => {
        console.warn(`[${label} restartIce]`, err.message);
        this._scheduleSessionRebuild(`${label}-ice-restart-failed`);
      });
    }, delay);
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
    // 画面共有中に再接続した場合は共有も復元する
    try {
      await this._reproduceScreen();
    } catch (err) {
      console.warn('[reproduceScreen]', err.message);
    }
  }

  async _produceTrack(track, kind) {
    const params = {
      track,
      appData: {
        source: kind === 'video' ? 'camera' : 'microphone',
        channelId: this._channelId,
      },
    };
    if (kind === 'video') {
      params.encodings = [
        { rid: 'r0', maxBitrate: 150_000, scaleResolutionDownBy: 4 },
        { rid: 'r1', maxBitrate: 500_000, scaleResolutionDownBy: 2 },
        { rid: 'r2', maxBitrate: 1_200_000 },
      ];
      params.codecOptions = { videoGoogleStartBitrate: 1000 };
    } else if (kind === 'audio') {
      params.codecOptions = {
        opusStereo: false,
        opusDtx: true,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
      };
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

  async setChannel(channelId) {
    this._channelId = channelId || this._channelId || 'general';
    if (!this.socket?.connected) return { channelId: this._channelId };
    const result = await this._request('setChannel', { channelId: this._channelId });
    if (result?.channelId) this._channelId = result.channelId;
    return result;
  }

  async createChannel(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('channel name is required');
    const result = await this._request('createChannel', { name: trimmed });
    return result;
  }

  async updateChannel(channelId, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('channel name is required');
    return this._request('updateChannel', { channelId, name: trimmed });
  }

  async deleteChannel(channelId) {
    return this._request('deleteChannel', { channelId });
  }

  async movePeerToChannel(targetSocketId, channelId) {
    return this._request('movePeerToChannel', { targetSocketId, channelId });
  }

  async callPeer(targetSocketId) {
    return this._request('callPeer', { targetSocketId });
  }

  /** 着信への応答/拒否をサーバーへ通知し、発信側の鳴動表示を止める */
  async ackCall(callId, action) {
    if (!callId) return { ok: false };
    return this._request('callAck', { callId, action: action === 'answered' ? 'answered' : 'dismissed' });
  }

  /** 発信した呼び出しをキャンセルし、相手の鳴動を止める */
  async cancelCall(callId) {
    if (!callId) return { ok: false };
    return this._request('callCancel', { callId });
  }

  // ── 画面共有（送信側）─────────────────────────────────────
  // screen-share 専用アプリと同じ appData 規約（source: 'screen' / 'screen-audio', label）
  // を使うため、受信側（Client / Viewer / 旧バージョン）はそのまま表示できる。

  async startScreenShare(videoTrack, label, audioTrack = null) {
    if (!this.sendTransport) throw new Error('サーバー未接続のため画面共有を開始できません');
    if (!videoTrack) throw new Error('共有映像を取得できませんでした');
    await this.stopScreenShare({ stopTracks: false });

    this.localScreenVideoTrack = videoTrack;
    this.localScreenAudioTrack = audioTrack || null;
    this.screenLabel = label || videoTrack.label || '画面共有';
    this.screenPaused = false;
    await this._reproduceScreen();
  }

  async _reproduceScreen() {
    if (!this.sendTransport || !this.localScreenVideoTrack) return;
    if (this.localScreenVideoTrack.readyState !== 'live') {
      this.localScreenVideoTrack = null;
      this.localScreenAudioTrack = null;
      return;
    }

    this.screenProducer = await this.sendTransport.produce({
      track: this.localScreenVideoTrack,
      appData: {
        source: 'screen',
        label: this.screenLabel || '画面共有',
        channelId: this._channelId,
      },
      encodings: [
        { rid: 'r0', maxBitrate: 600_000, scaleResolutionDownBy: 2 },
        { rid: 'r1', maxBitrate: 1_800_000 },
      ],
      codecOptions: { videoGoogleStartBitrate: 1200 },
    });
    this.screenProducer.on('transportclose', () => { this.screenProducer = null; });
    this.screenProducer.on('trackended', () => {
      // 共有元のウィンドウが閉じられた等。共有を終了してUIへ通知する。
      this.stopScreenShare().catch(() => {});
      this.onScreenShareEnded?.();
    });

    if (this.localScreenAudioTrack && this.localScreenAudioTrack.readyState === 'live') {
      this.screenAudioProducer = await this.sendTransport.produce({
        track: this.localScreenAudioTrack,
        appData: {
          source: 'screen-audio',
          label: this.screenLabel || '画面共有音声',
          channelId: this._channelId,
        },
        codecOptions: { opusStereo: 1, opusDtx: 1 },
      });
      this.screenAudioProducer.on('transportclose', () => { this.screenAudioProducer = null; });
    }

    if (this.screenPaused) {
      await this.setScreenSharePaused(true);
    }
  }

  async setScreenSharePaused(paused) {
    this.screenPaused = !!paused;
    for (const producer of [this.screenProducer, this.screenAudioProducer]) {
      if (!producer) continue;
      if (paused) await this._pauseProducer(producer);
      else        await this._resumeProducer(producer);
    }
  }

  async setScreenAudioEnabled(enabled) {
    if (!this.screenAudioProducer) return;
    if (enabled) await this._resumeProducer(this.screenAudioProducer);
    else         await this._pauseProducer(this.screenAudioProducer);
  }

  async stopScreenShare({ stopTracks = true } = {}) {
    const producers = [this.screenProducer, this.screenAudioProducer].filter(Boolean);
    const tracks = [this.localScreenVideoTrack, this.localScreenAudioTrack].filter(Boolean);
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.localScreenVideoTrack = null;
    this.localScreenAudioTrack = null;
    this.screenLabel = '';
    this.screenPaused = false;

    for (const producer of producers) {
      const producerId = producer.id;
      try { producer.close(); } catch { /* ignore close errors */ }
      try {
        if (this.socket?.connected) await this._request('closeProducer', { producerId });
      } catch {
        // サーバー側は transport close でも掃除される
      }
    }
    if (stopTracks) {
      for (const track of tracks) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
  }

  isScreenSharing() {
    return !!this.screenProducer && !this.screenProducer.closed;
  }

  async getSystemState() {
    return this._request('getSystemState');
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

  async _consumePeer(producerId, socketId, locationName, kind, paused, metadata = {}) {
    if (this._isSelfSocket(socketId)) return;
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
          appType:         metadata.appType || 'client',
          appVersion:      metadata.appVersion || '',
          channelId:       metadata.peerChannelId || metadata.channelId || 'general',
          stream:          new MediaStream(),
          screenStream:    new MediaStream(),
          videoProducerId: null,
          audioProducerId: null,
          screenProducerId: null,
          screenAudioProducerId: null,
          videoPaused:     false,
          audioPaused:     false,
          screenPaused:    false,
          screenAudioPaused: false,
          screenLabel:     '',
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
        if (kind === 'video') { peer.videoProducerId = producerId; peer.videoPaused = !!paused; }
        else                  { peer.audioProducerId = producerId; peer.audioPaused = !!paused; }
      }

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
    const closedTrack = consumer?.track || null;
    if (consumer) {
      try { consumer.close(); } catch { /* ignore close errors */ }
      this.consumers.delete(producerId);
    }
    for (const [socketId, peer] of this.peers) {
      if (peer.videoProducerId === producerId) { peer.videoProducerId = null; this.onPeerUpdated?.(socketId, { ...peer }); break; }
      if (peer.audioProducerId === producerId) { peer.audioProducerId = null; this.onPeerUpdated?.(socketId, { ...peer }); break; }
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

  // ── 1秒ポーリング用: サーバーの状態と同期 ────────────────

  async syncPeers() {
    if (!this._initialized) return;
    try {
      const peerList = await this._request('getPeers');

      for (const peer of peerList) {
        if (peer.isSelf || this._isSelfSocket(peer.socketId)) continue;
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

      const active = new Set(peerList
        .filter(p => !p.isSelf && !this._isSelfSocket(p.socketId) && (p.producers.length > 0 || p.appType !== 'screen-share'))
        .map(p => p.socketId));
      for (const [socketId] of this.peers) {
        if (!active.has(socketId)) {
          this.peers.delete(socketId);
          this.onPeerRemoved?.(socketId);
        }
      }

      for (const peer of peerList) {
        if (peer.isSelf || this._isSelfSocket(peer.socketId)) continue;
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
      console.warn('[syncPeers]', err.message);
    }
  }

  // ── ユーティリティ ────────────────────────────────────────

  sendTelemetry(report) {
    if (!this.socket?.connected) return;
    const sentAt = Date.now();
    const payload = {
      ...report,
      appVersion: report.appVersion || this._appVersion,
      channelId: report.channelId || this._channelId,
      clientTime: sentAt,
      connection: {
        ...(report.connection || {}),
        telemetryRttMs: this._lastTelemetryRtt,
        lastTelemetryAckAt: this._lastTelemetryAckAt,
      },
      transports: this.getTransportReport(),
      consumers: this.getConsumerReport(),
    };

    this._evaluateReceiveWatchdog(payload);

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

  _isSelfSocket(socketId) {
    return !!socketId && (socketId === this._selfSocketId || socketId === this.socket?.id);
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
    this._resetMediaSession({ notifyPeers: true, keepPeers: false });
    this.socket?.disconnect();
  }
}
