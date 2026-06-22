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

const MEDIA_QUALITY_PROFILES = {
  stable: {
    width: 640,
    height: 360,
    frameRate: 15,
    cameraMaxBitrate: 650_000,
    cameraStartBitrate: 450,
    screenMaxBitrate: 900_000,
  },
  'vpn-balanced': {
    width: 960,
    height: 540,
    frameRate: 24,
    cameraMaxBitrate: 1_400_000,
    cameraStartBitrate: 900,
    screenMaxBitrate: 1_800_000,
  },
  high: {
    width: 1280,
    height: 720,
    frameRate: 30,
    cameraMaxBitrate: 2_500_000,
    cameraStartBitrate: 1200,
    screenMaxBitrate: 3_000_000,
  },
  fhd: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    cameraMaxBitrate: 4_500_000,
    cameraStartBitrate: 1800,
    screenMaxBitrate: 5_000_000,
  },
};

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeMediaQuality(config = {}) {
  const raw = config?.mediaTransport && typeof config.mediaTransport === 'object'
    ? config.mediaTransport
    : {};
  const profileName = ['stable', 'vpn-balanced', 'high', 'fhd'].includes(raw.videoProfile)
    ? raw.videoProfile
    : 'vpn-balanced';
  const profile = MEDIA_QUALITY_PROFILES[profileName];
  return {
    profile: profileName,
    width: profile.width,
    height: profile.height,
    frameRate: profile.frameRate,
    cameraMaxBitrate: Math.round(clampNumber(raw.cameraMaxBitrateKbps, 200, 6000, profile.cameraMaxBitrate / 1000) * 1000),
    cameraStartBitrate: Math.round(clampNumber(raw.cameraStartBitrateKbps, 150, 4000, profile.cameraStartBitrate)),
    screenMaxBitrate: Math.round(clampNumber(raw.screenMaxBitrateKbps, 300, 8000, profile.screenMaxBitrate / 1000) * 1000),
  };
}

function cameraEncodingsForQuality(quality) {
  const max = quality.cameraMaxBitrate;
  return [
    { rid: 'r0', maxBitrate: Math.round(max * 0.18), scaleResolutionDownBy: 4 },
    { rid: 'r1', maxBitrate: Math.round(max * 0.45), scaleResolutionDownBy: 2 },
    { rid: 'r2', maxBitrate: max },
  ];
}

function screenEncodingsForQuality(quality) {
  const max = quality.screenMaxBitrate;
  return [
    { rid: 'r0', maxBitrate: Math.round(max * 0.35), scaleResolutionDownBy: 2 },
    { rid: 'r1', maxBitrate: max },
  ];
}

function isTransportReadyState(state) {
  return ['connected', 'completed'].includes(String(state || '').toLowerCase());
}

function isTransportTerminalState(state) {
  return ['failed', 'closed'].includes(String(state || '').toLowerCase());
}

const ONE_WAY_WATCHDOG = {
  recvUnreadyMs: 8_000,
  inboundStallMs: 12_000,
  recoveryCooldownMs: 18_000,
};
const SETUP_WATCHDOG_MS = 20_000;
const HARD_RECONNECT_DELAY_MS = 1_000;
const DIAGNOSTIC_STAT_TIMEOUT_MS = 700;
const TELEMETRY_DIAGNOSTIC_TIMEOUT_MS = 900;

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

function statsItems(stats) {
  if (!stats || typeof stats.values !== 'function') return [];
  return Array.from(stats.values());
}

function candidateAddress(candidate = {}) {
  return candidate.address || candidate.ip || candidate.ipAddress || '';
}

function selectedCandidatePair(stats) {
  const items = statsItems(stats);
  const byId = new Map(items.map(item => [item.id, item]));
  let pair = items.find(item => item.type === 'transport' && item.selectedCandidatePairId);
  pair = pair ? byId.get(pair.selectedCandidatePairId) : null;
  if (!pair) {
    pair = items.find(item => item.type === 'candidate-pair' && (item.selected || item.nominated || item.state === 'succeeded'));
  }
  if (!pair) return null;
  const local = byId.get(pair.localCandidateId) || {};
  const remote = byId.get(pair.remoteCandidateId) || {};
  return {
    state: pair.state || '',
    nominated: !!pair.nominated,
    currentRoundTripTime: Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null,
    availableOutgoingBitrate: Number.isFinite(pair.availableOutgoingBitrate) ? pair.availableOutgoingBitrate : null,
    bytesSent: Number.isFinite(pair.bytesSent) ? pair.bytesSent : null,
    bytesReceived: Number.isFinite(pair.bytesReceived) ? pair.bytesReceived : null,
    local: {
      protocol: local.protocol || '',
      candidateType: local.candidateType || '',
      address: candidateAddress(local),
      port: Number(local.port) || null,
      networkType: local.networkType || '',
    },
    remote: {
      protocol: remote.protocol || '',
      candidateType: remote.candidateType || '',
      address: candidateAddress(remote),
      port: Number(remote.port) || null,
    },
  };
}

function summarizeRtpStats(stats, direction) {
  const targetType = direction === 'outbound' ? 'outbound-rtp' : 'inbound-rtp';
  return statsItems(stats)
    .filter(item => item.type === targetType && !item.isRemote)
    .map(item => ({
      id: item.id,
      kind: item.kind || item.mediaType || '',
      bytesSent: Number.isFinite(item.bytesSent) ? item.bytesSent : null,
      packetsSent: Number.isFinite(item.packetsSent) ? item.packetsSent : null,
      bytesReceived: Number.isFinite(item.bytesReceived) ? item.bytesReceived : null,
      packetsReceived: Number.isFinite(item.packetsReceived) ? item.packetsReceived : null,
      packetsLost: Number.isFinite(item.packetsLost) ? item.packetsLost : null,
      framesEncoded: Number.isFinite(item.framesEncoded) ? item.framesEncoded : null,
      framesDecoded: Number.isFinite(item.framesDecoded) ? item.framesDecoded : null,
      framesDropped: Number.isFinite(item.framesDropped) ? item.framesDropped : null,
      frameWidth: Number.isFinite(item.frameWidth) ? item.frameWidth : null,
      frameHeight: Number.isFinite(item.frameHeight) ? item.frameHeight : null,
      framesPerSecond: Number.isFinite(item.framesPerSecond) ? item.framesPerSecond : null,
      jitter: Number.isFinite(item.jitter) ? item.jitter : null,
    }));
}

function firstStats(items = [], kindOrSource = '') {
  for (const item of items) {
    if (item.kind === kindOrSource || item.source === kindOrSource) return Array.isArray(item.stats) ? item.stats[0] : null;
  }
  return null;
}

function telemetrySummary(payload = {}) {
  const mediaStats = payload.mediaStats || {};
  const producers = Array.isArray(mediaStats.producers) ? mediaStats.producers : [];
  const consumers = Array.isArray(mediaStats.consumers) ? mediaStats.consumers : [];
  const localMedia = payload.localMedia || {};
  const transports = payload.transports || {};
  const remoteMonitor = payload.remoteMonitor || {};
  const outboundVideo = firstStats(producers, 'camera') || firstStats(producers, 'video');
  const outboundAudio = firstStats(producers, 'microphone') || firstStats(producers, 'audio');
  const inboundVideo = firstStats(consumers, 'video');
  const inboundAudio = firstStats(consumers, 'audio');
  const flags = [];

  if (localMedia.cameraEnabled && !localMedia.video?.present) flags.push('camera-enabled-but-track-missing');
  if (localMedia.micEnabled && !localMedia.audio?.present) flags.push('mic-enabled-but-track-missing');
  if (localMedia.video?.readyState === 'live' && Number(outboundVideo?.bytesSent || 0) <= 0) flags.push('video-track-live-but-no-outbound-rtp');
  if (localMedia.audio?.readyState === 'live' && Number(outboundAudio?.bytesSent || 0) <= 0) flags.push('audio-track-live-but-no-outbound-rtp');
  if (remoteMonitor.peerCount > 0 && Number(inboundVideo?.bytesReceived || 0) <= 0) flags.push('remote-peer-present-but-no-inbound-video-rtp');
  if (remoteMonitor.peerCount > 0 && Number(inboundAudio?.bytesReceived || 0) <= 0) flags.push('remote-peer-present-but-no-inbound-audio-rtp');
  if (transports.socketConnected && !['connected', 'completed'].includes(String(transports.sendState || '').toLowerCase())) flags.push('socket-connected-send-transport-not-connected');
  if (transports.socketConnected && !['connected', 'completed'].includes(String(transports.recvState || '').toLowerCase())) flags.push('socket-connected-recv-transport-not-connected');

  return {
    appType: payload.appType || '',
    appVersion: payload.appVersion || '',
    locationName: payload.locationName || '',
    channelId: payload.channelId || '',
    status: payload.status || '',
    connection: payload.connection || {},
    localMedia: {
      cameraEnabled: !!localMedia.cameraEnabled,
      micEnabled: !!localMedia.micEnabled,
      speakerMuted: !!localMedia.speakerMuted,
      video: localMedia.video || {},
      audio: localMedia.audio || {},
      error: localMedia.error || null,
      audioProfile: localMedia.audioProfile || {},
    },
    remoteMonitor,
    transports,
    mediaStats,
    rtpQuickLook: {
      outboundVideo,
      outboundAudio,
      inboundVideo,
      inboundAudio,
    },
    flags,
  };
}

function totalInboundBytes(consumers = []) {
  let total = 0;
  let hasStats = false;
  for (const consumer of consumers) {
    const stats = Array.isArray(consumer?.stats) ? consumer.stats : [];
    for (const item of stats) {
      if (!Number.isFinite(item?.bytesReceived)) continue;
      hasStats = true;
      total += item.bytesReceived;
    }
  }
  return hasStats ? total : null;
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
    this.forceTcpMedia   = false;
    this.mediaQuality    = normalizeMediaQuality();
    this._initialized    = false;
    this._pendingQueue   = [];     // 初期化前に届いた newProducer
    this._locationName   = '';
    this._channelId      = 'general';
    this._appVersion     = '0.2.11';
    this._clientInstanceId = '';
    this._platform       = '';
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
    this._debugSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this._oneWayWatchdog = {
      recvUnreadySince: null,
      lastInboundBytes: null,
      lastInboundAt: null,
      lastRecoveryAt: 0,
      lastReason: '',
    };

    // コールバック
    this.onPeerUpdated      = null;  // (socketId, peer) => void
    this.onPeerRemoved      = null;  // (socketId) => void
    this.onRestartCommand   = null;  // () => void
    this.onAdminSetDevice   = null;  // ({ kind, deviceId }) => Promise
    this.onAdminSetMediaState = null; // ({ kind, enabled }) => Promise
    this.onAdminRefreshDevices = null; // () => Promise
    this.onConnectionChange = null;  // (connected: bool, health?: object) => void
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

  _debugLog(event, details = {}, severity = 'info') {
    const payload = {
      event,
      severity,
      details: {
        debugSessionId: this._debugSessionId,
        socketId: this.socket?.id || this._selfSocketId || '',
        locationName: this._locationName,
        channelId: this._channelId,
        appVersion: this._appVersion,
        platform: this._platform,
        initialized: !!this._initialized,
        forceTcpMedia: !!this.forceTcpMedia,
        ...details,
      },
    };
    try {
      const result = window.electronAPI?.writeDebugLog?.(payload);
      result?.catch?.(() => {});
    } catch {
      // Browser/dev environments without Electron logging still use console output.
    }
  }

  // ── 接続（mediasoup 初期化＋ローカル produce まで await）──────────────

  connect(serverUrl, locationName, options = {}) {
    this._locationName = locationName;
    this._channelId = options.channelId || this._channelId || 'general';
    this._appVersion = options.appVersion || this._appVersion || '0.2.11';
    this._clientInstanceId = options.clientInstanceId || this._clientInstanceId || '';
    this._platform = options.platform || this._platform || '';
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
      this._debugLog('socket.connect-start', {
        serverUrl,
        options: {
          channelId: this._channelId,
          clientInstanceId: this._clientInstanceId,
        },
      });

      this.socket.on('connect', async () => {
        const generation = this._connectGeneration + 1;
        this._connectGeneration = generation;
        this._selfSocketId = this.socket.id || '';
        console.log('[WebRTC] connected', this.socket.id);
        this._debugLog('socket.connected', {
          socketId: this.socket.id,
          transport: this.socket.io?.engine?.transport?.name || '',
        });
        this._sendMetadata();
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
          if (generation === this._connectGeneration) resolveOnce();
        } catch (err) {
          console.error('[WebRTC] connect setup failed', err);
          this._debugLog('session.setup-error', { error: err.message, stack: err.stack }, 'error');
          this.onConnectionChange?.(false, this.getConnectionHealth('setup-error'));
          this._scheduleSetupRetry();
          rejectOnce(err);
        }
      });

      this.socket.on('connect_error', (err) => {
        console.warn('[WebRTC] connect_error:', err.message);
        this._debugLog('socket.connect-error', { error: err.message, stack: err.stack }, 'error');
        this._initialized = false;
        this.onConnectionChange?.(false, this.getConnectionHealth('socket-connect-error'));
      });

      this.socket.on('disconnect', (reason) => {
        console.warn('[WebRTC] disconnected:', reason);
        this._debugLog('socket.disconnected', { reason }, 'warn');
        this._connectGeneration += 1;
        this._setupGeneration += 1;
        this._initialized = false;
        this._clearSetupRetry();
        this._clearSetupWatchdog();
        this._resetMediaSession({ notifyPeers: true, keepPeers: false });
        this.onConnectionChange?.(false, this.getConnectionHealth(`socket-disconnect:${reason}`));
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          setTimeout(() => this.socket?.connect(), 2000);
        }
      });

      this.socket.io.on('reconnect_attempt', () => {
        this._debugLog('socket.reconnect-attempt', {});
        if (!this._manualDisconnect) this.onConnectionChange?.(false, this.getConnectionHealth('socket-reconnect-attempt'));
      });

      this.socket.io.on('reconnect', () => {
        console.log('[WebRTC] reconnect transport restored');
        this._debugLog('socket.reconnected', { transport: this.socket.io?.engine?.transport?.name || '' });
      });

      this._bindServerEvents();
    });
  }

  _sendMetadata() {
    if (!this.socket?.connected) return;
    this.socket.emit('setMetadata', {
      locationName: this._locationName,
      appType: 'client',
      channelId: this._channelId,
      appVersion: this._appVersion,
      clientInstanceId: this._clientInstanceId,
      platform: this._platform,
    });
  }

  _extractForceTcpMedia(config) {
    if (typeof config?.forceTcpMedia === 'boolean') return config.forceTcpMedia;
    if (typeof config?.mediaTransport?.forceTcp === 'boolean') return config.mediaTransport.forceTcp;
    return null;
  }

  _applyMediaTransportConfig(config, reason = 'server-config') {
    const nextForceTcp = this._extractForceTcpMedia(config);
    let changed = false;
    if (nextForceTcp != null && nextForceTcp !== this.forceTcpMedia) {
      this.forceTcpMedia = nextForceTcp;
      console.warn(`[WebRTC] media transport mode changed reason=${reason} forceTcp=${this.forceTcpMedia}`);
      changed = true;
    }
    const nextQuality = normalizeMediaQuality(config);
    const previousQuality = this.mediaQuality || normalizeMediaQuality();
    const qualityChanged = JSON.stringify(nextQuality) !== JSON.stringify(previousQuality);
    if (qualityChanged) {
      this.mediaQuality = nextQuality;
      this._applyLocalVideoQuality(reason).catch(err => {
        this._debugLog('media-quality.apply-error', { reason, error: err.message }, 'warn');
      });
      changed = true;
    }
    return changed;
  }

  async _applyLocalVideoQuality(reason = 'quality-config') {
    const track = this.localVideoTrack;
    if (!track || track.readyState !== 'live') return;
    const quality = this.mediaQuality || normalizeMediaQuality();
    try {
      await track.applyConstraints({
        width: { ideal: quality.width, max: quality.width },
        height: { ideal: quality.height, max: quality.height },
        frameRate: { ideal: quality.frameRate, max: quality.frameRate },
      });
      this._debugLog('media-quality.track-constraints-applied', { reason, quality });
    } catch (err) {
      this._debugLog('media-quality.track-constraints-failed', { reason, quality, error: err.message }, 'warn');
    }
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
      this._debugLog('session.setup-start', {
        hasVideoTrack: !!this.localVideoTrack,
        hasAudioTrack: !!this.localAudioTrack,
        queuedProducers: this._pendingQueue.length,
      });
      this._clearSetupRetry();
      this._sendMetadata();
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

      this.onConnectionChange?.(true, this.getConnectionHealth('setup-complete'));
      await this.syncPeers();
      assertCurrent('sync-peers');
      this._debugLog('session.setup-complete', {
        sendTransportId: this.sendTransport?.id || '',
        recvTransportId: this.recvTransport?.id || '',
        videoProducerId: this.videoProducer?.id || '',
        audioProducerId: this.audioProducer?.id || '',
        consumers: this.consumers.size,
        peers: this.peers.size,
      });
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
      this._debugLog('session.setup-retry', { delayMs: delay }, 'warn');
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[WebRTC] setup retry failed', err);
        this._debugLog('session.setup-retry-error', { error: err.message, stack: err.stack }, 'error');
        this.onConnectionChange?.(false, this.getConnectionHealth('setup-retry-error'));
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
      this._debugLog('session.setup-watchdog-timeout', { setupGeneration }, 'warn');
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
    this._debugLog('socket.hard-reconnect-requested', { reason }, 'warn');
    this._setupGeneration += 1;
    this._setupInFlight = null;
    this._initialized = false;
    this._clearSetupRetry();
    this._clearSessionRebuild();
    this._clearSetupWatchdog();
    this._resetMediaSession({ notifyPeers: true, keepPeers: false });
    this.onConnectionChange?.(false, this.getConnectionHealth(`hard-reconnect:${reason}`));

    const socket = this.socket;
    try { socket.disconnect(); } catch { /* ignore disconnect errors */ }
    this._hardReconnectTimer = setTimeout(() => {
      this._hardReconnectTimer = null;
      if (!this._manualDisconnect && socket === this.socket) {
        try { this.socket.connect(); } catch { /* socket.io reconnect will keep retrying */ }
      }
    }, HARD_RECONNECT_DELAY_MS);
  }

  _scheduleSessionRebuild(reason = 'transport-failure', { force = false } = {}) {
    if (this._manualDisconnect || !this.socket?.connected || this._sessionRebuildTimer) return;
    this._sessionRebuildTimer = setTimeout(async () => {
      this._sessionRebuildTimer = null;
      if (this._manualDisconnect || !this.socket?.connected) return;
      const health = this.getConnectionHealth(reason);
      if (!force && health.status === 'connected') {
        this._debugLog('session.rebuild-skipped', { reason, health });
        return;
      }
      console.warn(`[WebRTC] rebuilding media session reason=${reason}`);
      this._debugLog('session.rebuild-start', { reason, force }, 'warn');
      this._initialized = false;
      this.onConnectionChange?.(false, this.getConnectionHealth(`rebuilding:${reason}`));
      this._resetMediaSession({ keepPeers: true });
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[WebRTC] session rebuild failed', err);
        this._debugLog('session.rebuild-error', { reason, error: err.message, stack: err.stack }, 'error');
        this.onConnectionChange?.(false, this.getConnectionHealth(`rebuild-error:${reason}`));
        this._scheduleSetupRetry();
      }
    }, 2500);
  }

  _clearSessionRebuild() {
    if (!this._sessionRebuildTimer) return;
    clearTimeout(this._sessionRebuildTimer);
    this._sessionRebuildTimer = null;
  }

  _resetOneWayWatchdog(reason = 'reset') {
    this._oneWayWatchdog = {
      recvUnreadySince: null,
      lastInboundBytes: null,
      lastInboundAt: null,
      lastRecoveryAt: this._oneWayWatchdog?.lastRecoveryAt || 0,
      lastReason: reason,
    };
  }

  _requestWatchdogRecovery(reason, details = {}) {
    const now = Date.now();
    const elapsed = now - (this._oneWayWatchdog.lastRecoveryAt || 0);
    if (elapsed < ONE_WAY_WATCHDOG.recoveryCooldownMs) {
      this._debugLog('watchdog.recovery-suppressed', {
        reason,
        cooldownRemainingMs: ONE_WAY_WATCHDOG.recoveryCooldownMs - elapsed,
        ...details,
      }, 'warn');
      return;
    }

    this._oneWayWatchdog.lastRecoveryAt = now;
    this._oneWayWatchdog.lastReason = reason;
    this._debugLog('watchdog.recovery-requested', { reason, ...details }, 'warn');
    this._scheduleSessionRebuild(`watchdog:${reason}`, { force: true });
  }

  _evaluateOneWayWatchdog(payload = {}) {
    if (this._manualDisconnect || !this.socket?.connected || !this._initialized) {
      this._resetOneWayWatchdog('inactive');
      return;
    }

    const now = Date.now();
    const report = payload.remoteMonitor || {};
    const mediaStats = payload.mediaStats || {};
    const remotePeerCount = Number(report.peerCount || 0);
    const expectedInbound = remotePeerCount > 0 && this.consumers.size > 0;
    const sendState = this.sendTransport?.connectionState || 'none';
    const recvState = this.recvTransport?.connectionState || 'none';
    const sendReady = isTransportReadyState(sendState);
    const recvReady = isTransportReadyState(recvState);

    if (!recvReady) {
      if (!this._oneWayWatchdog.recvUnreadySince) this._oneWayWatchdog.recvUnreadySince = now;
      const recvUnreadyMs = now - this._oneWayWatchdog.recvUnreadySince;
      if (sendReady && expectedInbound && recvUnreadyMs >= ONE_WAY_WATCHDOG.recvUnreadyMs) {
        this._requestWatchdogRecovery('recv-transport-not-ready', {
          sendState,
          recvState,
          recvUnreadyMs,
          remotePeerCount,
          consumers: this.consumers.size,
        });
      }
      return;
    }

    this._oneWayWatchdog.recvUnreadySince = null;

    const inboundBytes = totalInboundBytes(mediaStats.consumers || []);
    if (!expectedInbound || inboundBytes == null) {
      this._oneWayWatchdog.lastInboundBytes = inboundBytes;
      this._oneWayWatchdog.lastInboundAt = now;
      return;
    }

    const lastBytes = this._oneWayWatchdog.lastInboundBytes;
    if (lastBytes == null || inboundBytes > lastBytes) {
      this._oneWayWatchdog.lastInboundBytes = inboundBytes;
      this._oneWayWatchdog.lastInboundAt = now;
      return;
    }

    this._oneWayWatchdog.lastInboundBytes = inboundBytes;
    const lastInboundAt = this._oneWayWatchdog.lastInboundAt || now;
    const stalledMs = now - lastInboundAt;
    if (sendReady && recvReady && stalledMs >= ONE_WAY_WATCHDOG.inboundStallMs) {
      this._requestWatchdogRecovery('inbound-rtp-stalled', {
        sendState,
        recvState,
        stalledMs,
        inboundBytes,
        remotePeerCount,
        consumers: this.consumers.size,
        receivingVideoCount: Number(report.receivingVideoCount || 0),
        receivingAudioCount: Number(report.receivingAudioCount || 0),
      });
      this._oneWayWatchdog.lastInboundAt = now;
    }
  }

  _resetMediaSession({ notifyPeers = false, keepPeers = false } = {}) {
    this._debugLog('session.reset-media', {
      notifyPeers,
      keepPeers,
      producers: {
        video: this.videoProducer?.id || '',
        audio: this.audioProducer?.id || '',
        screen: this.screenProducer?.id || '',
        screenAudio: this.screenAudioProducer?.id || '',
      },
      consumers: this.consumers.size,
      peers: this.peers.size,
    });
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
    this._resetOneWayWatchdog('media-session-reset');

    if (notifyPeers && !keepPeers) {
      for (const socketId of this.peers.keys()) this.onPeerRemoved?.(socketId);
    }
    if (!keepPeers) this.peers.clear();
  }

  _bindServerEvents() {
    this.socket.on('newProducer', async ({ producerId, socketId, locationName: name, kind, paused, source, appData, channelId, appType }) => {
      if (this._isSelfSocket(socketId)) return;
      const payload = { producerId, socketId, locationName: name, kind, paused, source, appData, channelId, appType };
      this._debugLog('server.new-producer', payload);
      if (!this._initialized) {
        if (!this._pendingQueue.find(p => p.producerId === producerId)) {
          this._pendingQueue.push(payload);
        }
        return;
      }
      await this._consumePeer(producerId, socketId, name, kind, paused, payload);
    });

    this.socket.on('producerClosed', ({ producerId }) => {
      this._debugLog('server.producer-closed', { producerId });
      this._handleProducerClosed(producerId);
    });
    this.socket.on('producerPaused',  ({ producerId, socketId }) => {
      this._debugLog('server.producer-paused', { producerId, socketId });
      this._setProducerPaused(producerId, socketId, true);
    });
    this.socket.on('producerResumed', ({ producerId, socketId }) => {
      this._debugLog('server.producer-resumed', { producerId, socketId });
      this._setProducerPaused(producerId, socketId, false);
    });

    this.socket.on('viewerPresence', (payload = {}) => {
      this.onViewerPresenceChange?.(!!payload.active);
    });

    this.socket.on('systemStateUpdated', (payload = {}) => {
      const mediaTransportChanged = this._applyMediaTransportConfig(payload, 'system-state');
      this._debugLog('server.system-state', {
        mediaTransportChanged,
        mediaTransport: payload.mediaTransport || {},
        channels: Array.isArray(payload.channels) ? payload.channels.length : 0,
        latestVersions: payload.latestVersions || {},
      });
      this.onSystemStateUpdated?.(payload);
      if (mediaTransportChanged && this._initialized) {
        this._scheduleSessionRebuild('media-transport-config-changed');
      }
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

    this.socket.on('instanceReplaced', (payload = {}, ack) => {
      ack?.({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
      console.warn('[WebRTC] instance replaced by newer connection:', payload.replacementSocketId || 'unknown');
      this._debugLog('server.instance-replaced', payload, 'warn');
      this._manualDisconnect = true;
      this._initialized = false;
      this._clearSetupRetry();
      this._clearSessionRebuild();
      this._resetMediaSession({ notifyPeers: true, keepPeers: false });
      this.onConnectionChange?.(false, this.getConnectionHealth('instance-replaced'));
      this.socket?.disconnect();
    });

    this.socket.on('peerDisconnected', ({ socketId }) => {
      this._debugLog('server.peer-disconnected', { socketId });
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
      this._debugLog('server.media-layer-restarted', {}, 'warn');
      this._initialized = false;
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[WebRTC] media layer rebuild failed', err);
        this.onConnectionChange?.(false, this.getConnectionHealth('media-layer-rebuild-error'));
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
      this._applyMediaTransportConfig(cfg, 'server-config');
      this._debugLog('server.config', {
        iceServersConfigured: this.iceServers.length,
        forceTcpMedia: this.forceTcpMedia,
        mediaQuality: this.mediaQuality,
      });
    } catch {
      // Older server versions did not expose this optional event.
      this._debugLog('server.config-unavailable', {}, 'warn');
    }

    const caps = await this._request('getRouterRtpCapabilities');
    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities: caps });
    this._debugLog('mediasoup.device-loaded', {
      handlerName: this.device.handlerName,
      canProduceVideo: this.device.canProduce('video'),
      canProduceAudio: this.device.canProduce('audio'),
    });
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
    const { params } = await this._request('createWebRtcTransport', { forceTcp: this.forceTcpMedia, direction: 'send' });
    this.sendTransport = this.device.createSendTransport(this._transportOptions(params));
    this._debugLog('transport.created', {
      direction: 'send',
      transportId: this.sendTransport.id,
      forceTcpMedia: this.forceTcpMedia,
      iceServersConfigured: this.iceServers.length,
      iceCandidates: params.iceCandidates || [],
    });
    this.sendTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      try {
        await this._request('connectTransport', { transportId: this.sendTransport.id, dtlsParameters });
        this._debugLog('transport.connected', { direction: 'send', transportId: this.sendTransport.id });
        cb();
      }
      catch (e) {
        this._debugLog('transport.connect-error', { direction: 'send', transportId: this.sendTransport?.id || '', error: e.message }, 'error');
        eb(e);
      }
    });
    this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, eb) => {
      try {
        const { id } = await this._request('produce', { transportId: this.sendTransport.id, kind, rtpParameters, appData });
        this._debugLog('producer.created', {
          producerId: id,
          transportId: this.sendTransport.id,
          kind,
          source: appData?.source || '',
          rtpEncodings: rtpParameters?.encodings || [],
          rtpCodecs: rtpParameters?.codecs?.map(codec => ({
            mimeType: codec.mimeType,
            clockRate: codec.clockRate,
            channels: codec.channels,
          })) || [],
        });
        cb({ id });
      }
      catch (e) {
        this._debugLog('producer.create-error', { kind, source: appData?.source || '', error: e.message }, 'error');
        eb(e);
      }
    });
    this.sendTransport.on('connectionstatechange', (s) => {
      console.log('[sendTransport]', s);
      this._debugLog('transport.connection-state', { direction: 'send', transportId: this.sendTransport?.id || '', state: s }, ['failed', 'disconnected', 'closed'].includes(s) ? 'warn' : 'info');
      if (s === 'failed') this._scheduleIceRestart(this.sendTransport, 'sendTransport', 500);
      if (s === 'disconnected') this._scheduleIceRestart(this.sendTransport, 'sendTransport', 4500);
    });
  }

  async _initRecvTransport() {
    const { params } = await this._request('createWebRtcTransport', { forceTcp: this.forceTcpMedia, direction: 'recv' });
    this.recvTransport = this.device.createRecvTransport(this._transportOptions(params));
    this._debugLog('transport.created', {
      direction: 'recv',
      transportId: this.recvTransport.id,
      forceTcpMedia: this.forceTcpMedia,
      iceServersConfigured: this.iceServers.length,
      iceCandidates: params.iceCandidates || [],
    });
    this.recvTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      try {
        await this._request('connectTransport', { transportId: this.recvTransport.id, dtlsParameters });
        this._debugLog('transport.connected', { direction: 'recv', transportId: this.recvTransport.id });
        cb();
      }
      catch (e) {
        this._debugLog('transport.connect-error', { direction: 'recv', transportId: this.recvTransport?.id || '', error: e.message }, 'error');
        eb(e);
      }
    });
    this.recvTransport.on('connectionstatechange', (s) => {
      console.log('[recvTransport]', s);
      this._debugLog('transport.connection-state', { direction: 'recv', transportId: this.recvTransport?.id || '', state: s }, ['failed', 'disconnected', 'closed'].includes(s) ? 'warn' : 'info');
      if (s === 'failed') this._scheduleIceRestart(this.recvTransport, 'recvTransport', 500);
      if (s === 'disconnected') this._scheduleIceRestart(this.recvTransport, 'recvTransport', 4500);
    });
  }

  _scheduleIceRestart(transport, label, delay = 1500) {
    if (!transport || transport.closed) return;
    if (this._iceRestartTimers.has(transport.id)) return;

    const timer = setTimeout(() => {
      this._iceRestartTimers.delete(transport.id);
      if (this._manualDisconnect || !this.socket?.connected) return;
      if (transport.closed || isTransportReadyState(transport.connectionState)) {
        this._debugLog('transport.ice-restart-skipped', {
          label,
          transportId: transport.id,
          state: transport.connectionState,
        });
        return;
      }
      this._debugLog('transport.ice-restart-start', { label, transportId: transport.id, delayMs: delay }, 'warn');
      this._restartTransportIce(transport).catch(err => {
        console.warn(`[${label} restartIce]`, err.message);
        this._debugLog('transport.ice-restart-error', { label, transportId: transport.id, error: err.message }, 'error');
        if (!isTransportReadyState(transport.connectionState)) {
          this._scheduleSessionRebuild(`${label}-ice-restart-failed`);
        }
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
      await this._applyLocalVideoQuality('before-produce');
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
      params.encodings = cameraEncodingsForQuality(this.mediaQuality);
      params.codecOptions = { videoGoogleStartBitrate: this.mediaQuality.cameraStartBitrate };
      params.degradationPreference = 'maintain-framerate';
    } else if (kind === 'audio') {
      params.codecOptions = {
        opusStereo: false,
        opusDtx: true,
        opusFec: true,
        opusMaxAverageBitrate: 24_000,
        opusMaxPlaybackRate: 48000,
      };
    }
    const producer = await this.sendTransport.produce(params);
    producer.on('transportclose', () => {
      this._debugLog('producer.transport-closed', {
        producerId: producer.id,
        kind,
        source: params.appData.source,
      }, 'warn');
      if (kind === 'video' && this.videoProducer === producer) this.videoProducer = null;
      if (kind === 'audio' && this.audioProducer === producer) this.audioProducer = null;
    });
    producer.on('trackended', () => {
      console.warn(`[producer] ${kind} track ended`);
      this._debugLog('producer.track-ended', {
        producerId: producer.id,
        kind,
        source: params.appData.source,
        trackLabel: track.label || '',
        trackReadyState: track.readyState,
        trackMuted: !!track.muted,
      }, 'warn');
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
      encodings: screenEncodingsForQuality(this.mediaQuality),
      codecOptions: { videoGoogleStartBitrate: Math.max(500, Math.round(this.mediaQuality.cameraStartBitrate * 0.8)) },
      degradationPreference: 'maintain-resolution',
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
        codecOptions: {
          opusStereo: false,
          opusDtx: true,
          opusFec: true,
          opusMaxAverageBitrate: 32_000,
        },
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
      this._debugLog('consumer.created', {
        consumerId: consumer.id,
        producerId,
        socketId,
        locationName,
        kind: consumer.kind,
        source: metadata.source || metadata.appData?.source || '',
        trackReadyState: consumer.track?.readyState || '',
        trackMuted: !!consumer.track?.muted,
      });
      consumer.on('transportclose', () => {
        this._debugLog('consumer.transport-closed', {
          consumerId: consumer.id,
          producerId,
          socketId,
          kind: consumer.kind,
        }, 'warn');
      });
      consumer.on('trackended', () => {
        this._debugLog('consumer.track-ended', {
          consumerId: consumer.id,
          producerId,
          socketId,
          kind: consumer.kind,
          trackReadyState: consumer.track?.readyState || '',
          trackMuted: !!consumer.track?.muted,
        }, 'warn');
      });

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
      this._debugLog('consumer.create-error', {
        producerId,
        socketId,
        locationName,
        kind,
        source: metadata.source || metadata.appData?.source || '',
        error: err.message,
        stack: err.stack,
      }, 'error');
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

  async _collectWebRtcDiagnostics() {
    const transports = {};
    const producers = [];
    const consumers = [];

    try {
      const stats = await withTimeout(this.sendTransport?.getStats?.(), DIAGNOSTIC_STAT_TIMEOUT_MS, null);
      if (stats) transports.sendSelectedCandidatePair = selectedCandidatePair(stats);
      else if (this.sendTransport && !this.sendTransport.closed) transports.sendStatsError = 'stats timeout';
    } catch (err) {
      transports.sendStatsError = err.message;
    }

    try {
      const stats = await withTimeout(this.recvTransport?.getStats?.(), DIAGNOSTIC_STAT_TIMEOUT_MS, null);
      if (stats) transports.recvSelectedCandidatePair = selectedCandidatePair(stats);
      else if (this.recvTransport && !this.recvTransport.closed) transports.recvStatsError = 'stats timeout';
    } catch (err) {
      transports.recvStatsError = err.message;
    }

    for (const [source, producer] of [
      ['camera', this.videoProducer],
      ['microphone', this.audioProducer],
      ['screen', this.screenProducer],
      ['screen-audio', this.screenAudioProducer],
    ]) {
      if (!producer || producer.closed) continue;
      try {
        const stats = await withTimeout(producer.getStats(), DIAGNOSTIC_STAT_TIMEOUT_MS, null);
        producers.push({
          source,
          id: producer.id,
          kind: producer.kind,
          ...(stats ? { stats: summarizeRtpStats(stats, 'outbound') } : { error: 'stats timeout' }),
        });
      } catch (err) {
        producers.push({ source, id: producer.id, kind: producer.kind, error: err.message });
      }
    }

    for (const [producerId, consumer] of this.consumers.entries()) {
      if (!consumer || consumer.closed) continue;
      try {
        const stats = await withTimeout(consumer.getStats(), DIAGNOSTIC_STAT_TIMEOUT_MS, null);
        consumers.push({
          producerId,
          id: consumer.id,
          kind: consumer.kind,
          ...(stats ? { stats: summarizeRtpStats(stats, 'inbound') } : { error: 'stats timeout' }),
        });
      } catch (err) {
        consumers.push({ producerId, id: consumer.id, kind: consumer.kind, error: err.message });
      }
    }

    return { transports, mediaStats: { producers, consumers } };
  }

  sendTelemetry(report) {
    if (!this.socket?.connected) return;
    const sentAt = Date.now();
    withTimeout(this._collectWebRtcDiagnostics(), TELEMETRY_DIAGNOSTIC_TIMEOUT_MS, {
      transports: { diagnosticsError: 'diagnostics timeout' },
      mediaStats: { producers: [], consumers: [] },
    }).then(diagnostics => {
      if (!this.socket?.connected) return;
      const payload = {
        ...report,
        appVersion: report.appVersion || this._appVersion,
        platform: report.platform || this._platform,
        channelId: report.channelId || this._channelId,
        clientTime: sentAt,
        connection: {
          ...(report.connection || {}),
          telemetryRttMs: this._lastTelemetryRtt,
          lastTelemetryAckAt: this._lastTelemetryAckAt,
        },
        transports: {
          ...this.getTransportReport(),
          ...(diagnostics.transports || {}),
        },
        consumers: this.getConsumerReport(),
        mediaStats: diagnostics.mediaStats || {},
      };

      this._debugLog('client.telemetry', telemetrySummary(payload));
      this._evaluateOneWayWatchdog(payload);

      this.socket.timeout(1500).emit('clientTelemetry', payload, (err) => {
        if (err) {
          this._debugLog('client.telemetry-ack-error', { error: err.message || String(err) }, 'warn');
          return;
        }
        this._lastTelemetryRtt = Date.now() - sentAt;
        this._lastTelemetryAckAt = Date.now();
      });
    }).catch(() => {});
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

  getConnectionHealth(reason = '') {
    const socketConnected = !!this.socket?.connected;
    const sendState = this.sendTransport?.connectionState || 'none';
    const recvState = this.recvTransport?.connectionState || 'none';
    const sendClosed = !!this.sendTransport?.closed;
    const recvClosed = !!this.recvTransport?.closed;
    const initialized = !!this._initialized;
    const socketId = this.socket?.id || this._selfSocketId || '';
    const base = {
      reason,
      socketConnected,
      initialized,
      socketId,
      sendState,
      recvState,
      sendClosed,
      recvClosed,
      setupInFlight: !!this._setupInFlight,
      setupRetryPending: !!this._setupRetryTimer,
      sessionRebuildPending: !!this._sessionRebuildTimer,
    };

    if (!socketConnected) return { ...base, status: 'disconnected' };
    if (!initialized || this._setupInFlight || this._setupRetryTimer) return { ...base, status: 'connecting' };
    if (sendClosed || recvClosed || isTransportTerminalState(sendState) || isTransportTerminalState(recvState)) {
      return { ...base, status: 'unstable' };
    }
    if (!isTransportReadyState(sendState) || !isTransportReadyState(recvState)) {
      return { ...base, status: 'unstable' };
    }
    return { ...base, status: 'connected' };
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
      if (!this.socket?.connected) {
        this._debugLog('signal.request-error', { type, error: 'not connected' }, 'error');
        return reject(new Error('not connected'));
      }
      const startedAt = Date.now();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          this._debugLog('signal.request-timeout', { type, elapsedMs: Date.now() - startedAt }, 'error');
          reject(new Error(`${type} timeout`));
        }
      }, 12000);
      this.socket.emit(type, data, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (res && res.error) {
          this._debugLog('signal.request-error', { type, elapsedMs: Date.now() - startedAt, error: res.error }, 'error');
          reject(new Error(res.error));
        } else {
          if (['createWebRtcTransport', 'connectTransport', 'produce', 'consume', 'resume', 'restartIce'].includes(type)) {
            this._debugLog('signal.request-ok', { type, elapsedMs: Date.now() - startedAt });
          }
          resolve(res);
        }
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
    this._debugLog('client.disconnect-requested', {});
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
