import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const SCREEN_SHARE_ENCODINGS = [
  { rid: 'r0', maxBitrate: 180_000, scaleResolutionDownBy: 2 },
  { rid: 'r1', maxBitrate: 700_000 },
];
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

function summarizeOutboundStats(stats) {
  return statsItems(stats)
    .filter(item => item.type === 'outbound-rtp' && !item.isRemote)
    .map(item => ({
      id: item.id,
      kind: item.kind || item.mediaType || '',
      bytesSent: Number.isFinite(item.bytesSent) ? item.bytesSent : null,
      packetsSent: Number.isFinite(item.packetsSent) ? item.packetsSent : null,
      framesEncoded: Number.isFinite(item.framesEncoded) ? item.framesEncoded : null,
      frameWidth: Number.isFinite(item.frameWidth) ? item.frameWidth : null,
      frameHeight: Number.isFinite(item.frameHeight) ? item.frameHeight : null,
      framesPerSecond: Number.isFinite(item.framesPerSecond) ? item.framesPerSecond : null,
    }));
}

export class ScreenShareWebRTCManager {
  constructor() {
    this.socket = null;
    this.device = null;
    this.sendTransport = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.localScreenVideoTrack = null;
    this.localScreenAudioTrack = null;
    this.screenLabel = '';
    this.iceServers = [];
    this.forceTcpMedia = false;
    this._initialized = false;
    this._manualDisconnect = false;
    this._displayName = '画面共有';
    this._appVersion = '0.1.4';
    this._clientInstanceId = '';
    this._platform = '';
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;
    this._setupInFlight = null;
    this._setupRetryTimer = null;
    this._setupRetryDelay = 1000;
    this._setupGeneration = 0;
    this._setupStartedAt = 0;
    this._setupWatchdogTimer = null;
    this._hardReconnectTimer = null;
    this._sessionRebuildTimer = null;
    this._iceRestartTimers = new Map();

    this.onConnectionChange = null;
    this.onSystemStateUpdated = null;
    this.onUpdateCommand = null;
  }

  connect(serverUrl, displayName, options = {}) {
    this._displayName = displayName || '画面共有';
    this._appVersion = options.appVersion || this._appVersion;
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
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
        randomizationFactor: 0.5,
        timeout: 12000,
      });

      this.socket.on('connect', async () => {
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
          resolveOnce();
        } catch (err) {
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
          rejectOnce(err);
        }
      });

      this.socket.on('connect_error', (err) => {
        this._initialized = false;
        this.onConnectionChange?.(false);
        rejectOnce(new Error(`接続失敗: ${err.message}`));
      });

      this.socket.on('disconnect', (reason) => {
        console.warn('[ScreenShare] disconnected:', reason);
        this._setupGeneration += 1;
        this._initialized = false;
        this._clearSetupRetry();
        this._clearSetupWatchdog();
        this._resetMediaSession({ stopTracks: false });
        this.onConnectionChange?.(false);
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          setTimeout(() => this.socket?.connect(), 2000);
        }
      });

      this.socket.io.on('reconnect', () => {
        console.log('[ScreenShare] reconnect transport restored');
      });

      this.socket.on('systemStateUpdated', (payload = {}) => {
        const mediaTransportChanged = this._applyMediaTransportConfig(payload, 'system-state');
        this.onSystemStateUpdated?.(payload);
        if (mediaTransportChanged && this._initialized) {
          this._scheduleSessionRebuild('media-transport-config-changed');
        }
      });

      this.socket.on('updateCommand', (payload = {}, ack) => {
        ack?.({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
        if (!payload.appType || payload.appType === 'screen-share' || payload.appType === 'all') {
          this.onUpdateCommand?.(payload);
        }
      });

      this.socket.on('restartCommand', (payload = {}, ack) => {
        ack?.({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
        setTimeout(() => this._hardReconnect(payload.reason || 'server-command'), 100);
      });

      this.socket.on('instanceReplaced', (payload = {}, ack) => {
        ack?.({ ok: true, socketId: this.socket.id, receivedAt: Date.now() });
        console.warn('[ScreenShare] instance replaced by newer connection:', payload.replacementSocketId || 'unknown');
        this._manualDisconnect = true;
        this._initialized = false;
        this._clearSetupRetry();
        this._clearSessionRebuild();
        this.stopScreenShare().catch(() => {});
        this.onConnectionChange?.(false);
        this.socket?.disconnect();
      });

      this.socket.on('mediaLayerRestarted', async () => {
        console.warn('[ScreenShare] media layer restarted, rebuilding session');
        this._initialized = false;
        this._resetMediaSession({ stopTracks: false });
        try {
          await this._setupSession();
          this._setupRetryDelay = 1000;
        } catch (err) {
          console.error('[ScreenShare] media layer rebuild failed', err);
          this.onConnectionChange?.(false);
          this._scheduleSetupRetry();
        }
      });
    });
  }

  _extractForceTcpMedia(config) {
    if (typeof config?.forceTcpMedia === 'boolean') return config.forceTcpMedia;
    if (typeof config?.mediaTransport?.forceTcp === 'boolean') return config.mediaTransport.forceTcp;
    return null;
  }

  _applyMediaTransportConfig(config, reason = 'server-config') {
    const nextForceTcp = this._extractForceTcpMedia(config);
    if (nextForceTcp == null || nextForceTcp === this.forceTcpMedia) return false;
    this.forceTcpMedia = nextForceTcp;
    console.warn(`[ScreenShare] media transport mode changed reason=${reason} forceTcp=${this.forceTcpMedia}`);
    return true;
  }

  async _setupSession() {
    if (this._setupInFlight) return this._setupInFlight;

    const setupGeneration = this._setupGeneration + 1;
    this._setupGeneration = setupGeneration;
    this._setupStartedAt = Date.now();
    this._armSetupWatchdog(setupGeneration);

    const assertCurrent = (stage) => {
      if (this._manualDisconnect || !this.socket?.connected || this._setupGeneration !== setupGeneration) {
        throw new Error(`screen-share setup superseded at ${stage}`);
      }
    };

    const setupPromise = (async () => {
      this._clearSetupRetry();
      this.socket.emit('setMetadata', {
        locationName: this._displayName,
        appType: 'screen-share',
        appVersion: this._appVersion,
        clientInstanceId: this._clientInstanceId,
        platform: this._platform,
      });

      try {
        const config = await this._request('getServerConfig');
        if (Array.isArray(config?.iceServers)) this.iceServers = config.iceServers;
        this._applyMediaTransportConfig(config, 'server-config');
      } catch {
        // Optional on older servers.
      }

      const caps = await this._request('getRouterRtpCapabilities');
      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities: caps });
      await this._initSendTransport();
      assertCurrent('init-send-transport');
      this._initialized = true;
      await this._reproduceScreen();
      assertCurrent('reproduce-screen');
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
      console.warn(`[ScreenShare] retrying media setup in-place after ${delay}ms backoff`);
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[ScreenShare] setup retry failed', err);
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
      console.warn('[ScreenShare] setup watchdog fired; hard reconnecting');
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
    console.warn(`[ScreenShare] hard reconnect requested reason=${reason}`);
    this._setupGeneration += 1;
    this._setupInFlight = null;
    this._initialized = false;
    this._clearSetupRetry();
    this._clearSessionRebuild();
    this._clearSetupWatchdog();
    this._resetMediaSession({ stopTracks: false });
    this.onConnectionChange?.(false);

    const socket = this.socket;
    try { socket.disconnect(); } catch { /* ignore disconnect errors */ }
    this._hardReconnectTimer = setTimeout(() => {
      this._hardReconnectTimer = null;
      if (!this._manualDisconnect && socket === this.socket) {
        try { this.socket.connect(); } catch { /* socket.io reconnect will keep retrying */ }
      }
    }, HARD_RECONNECT_DELAY_MS);
  }

  _scheduleSessionRebuild(reason = 'transport-failure') {
    if (this._manualDisconnect || !this.socket?.connected || this._sessionRebuildTimer) return;
    this._sessionRebuildTimer = setTimeout(async () => {
      this._sessionRebuildTimer = null;
      if (this._manualDisconnect || !this.socket?.connected) return;
      console.warn(`[ScreenShare] rebuilding media session reason=${reason}`);
      this._initialized = false;
      this._resetMediaSession({ stopTracks: false });
      try {
        await this._setupSession();
        this._setupRetryDelay = 1000;
      } catch (err) {
        console.error('[ScreenShare] session rebuild failed', err);
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

  _resetMediaSession({ stopTracks = false } = {}) {
    const tracks = [this.localScreenVideoTrack, this.localScreenAudioTrack].filter(Boolean);
    try { this.screenProducer?.close(); } catch { /* ignore */ }
    try { this.screenAudioProducer?.close(); } catch { /* ignore */ }
    try { this.sendTransport?.close(); } catch { /* ignore */ }

    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    this.sendTransport = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;

    if (stopTracks) {
      for (const track of tracks) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this.localScreenVideoTrack = null;
      this.localScreenAudioTrack = null;
      this.screenLabel = '';
    }
  }

  async _initSendTransport() {
    this._resetMediaSession({ stopTracks: false });
    const { params } = await this._request('createWebRtcTransport', { forceTcp: this.forceTcpMedia, direction: 'send' });
    const options = this.iceServers.length ? { ...params, iceServers: this.iceServers } : params;
    this.sendTransport = this.device.createSendTransport(options);

    this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this._request('connectTransport', { transportId: this.sendTransport.id, dtlsParameters });
        callback();
      } catch (err) {
        errback(err);
      }
    });

    this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { id } = await this._request('produce', {
          transportId: this.sendTransport.id,
          kind,
          rtpParameters,
          appData,
        });
        callback({ id });
      } catch (err) {
        errback(err);
      }
    });

    this.sendTransport.on('connectionstatechange', state => {
      console.log('[screenShareSendTransport]', state);
      if (state === 'failed') this._scheduleIceRestart(this.sendTransport, 'screenShareSendTransport', 500);
      if (state === 'disconnected') this._scheduleIceRestart(this.sendTransport, 'screenShareSendTransport', 4500);
    });
  }

  async startScreenShare(track, label, audioTrack = null) {
    if (!this.sendTransport) throw new Error('送信トランスポートが準備できていません');
    await this.stopScreenShare({ stopTrack: false });

    try {
      this.localScreenVideoTrack = track;
      this.localScreenAudioTrack = audioTrack || null;
      this.screenLabel = label || track.label || '画面共有';
      await this._reproduceScreen();
    } catch (err) {
      await this.stopScreenShare({ stopTrack: false });
      throw err;
    }
    return this.screenProducer;
  }

  async _reproduceScreen() {
    if (!this.sendTransport || !this.localScreenVideoTrack) return null;
    if (this.localScreenVideoTrack.readyState !== 'live') {
      this.localScreenVideoTrack = null;
      this.localScreenAudioTrack = null;
      this.screenLabel = '';
      return null;
    }

    try { this.screenProducer?.close(); } catch { /* ignore */ }
    try { this.screenAudioProducer?.close(); } catch { /* ignore */ }
    this.screenProducer = null;
    this.screenAudioProducer = null;

    const track = this.localScreenVideoTrack;
    const audioTrack = this.localScreenAudioTrack?.readyState === 'live'
      ? this.localScreenAudioTrack
      : null;

    this.screenProducer = await this.sendTransport.produce({
      track,
      appData: {
        source: 'screen',
        label: this.screenLabel || track.label || '画面共有',
      },
      encodings: SCREEN_SHARE_ENCODINGS,
      codecOptions: { videoGoogleStartBitrate: 500 },
    });

    this.screenProducer.on('transportclose', () => {
      this.screenProducer = null;
    });
    this.screenProducer.on('trackended', () => {
      this.stopScreenShare().catch(() => {});
    });

    if (audioTrack) {
      this.screenAudioProducer = await this.sendTransport.produce({
        track: audioTrack,
        appData: {
          source: 'screen-audio',
          label: this.screenLabel || audioTrack.label || '画面共有音声',
        },
        codecOptions: {
          opusStereo: false,
          opusDtx: true,
          opusFec: true,
          opusMaxAverageBitrate: 32_000,
        },
      });
      this.screenAudioProducer.on('transportclose', () => {
        this.screenAudioProducer = null;
      });
      this.screenAudioProducer.on('trackended', () => {
        this._closeScreenAudioProducer().catch(() => {});
      });
    }

    return this.screenProducer;
  }

  async stopScreenShare({ stopTrack = true } = {}) {
    const audioProducer = this.screenAudioProducer;
    this.screenAudioProducer = null;
    const audioTrack = audioProducer?.track || this.localScreenAudioTrack;
    if (audioProducer) {
      try {
        if (this.socket?.connected) await this._request('closeProducer', { producerId: audioProducer.id });
      } catch {
        // The server will also clean up on transport close.
      }
      try { audioProducer.close(); } catch { /* ignore */ }
      if (stopTrack) {
        try { audioTrack?.stop(); } catch { /* ignore */ }
      }
    }

    const producer = this.screenProducer;
    this.screenProducer = null;
    const track = producer?.track || this.localScreenVideoTrack;
    this.localScreenVideoTrack = null;
    this.localScreenAudioTrack = null;
    this.screenLabel = '';
    if (!producer) {
      if (stopTrack) {
        try { track?.stop(); } catch { /* ignore */ }
        try { audioTrack?.stop(); } catch { /* ignore */ }
      }
      return;
    }

    try {
      if (this.socket?.connected) await this._request('closeProducer', { producerId: producer.id });
    } catch {
      // The server will also clean up on transport close.
    }
    try { producer.close(); } catch { /* ignore */ }
    if (stopTrack) {
      try { track?.stop(); } catch { /* ignore */ }
    }
  }

  async _closeScreenAudioProducer() {
    const producer = this.screenAudioProducer;
    this.screenAudioProducer = null;
    this.localScreenAudioTrack = null;
    if (!producer) return;
    try {
      if (this.socket?.connected) await this._request('closeProducer', { producerId: producer.id });
    } catch {
      // ignore
    }
    try { producer.close(); } catch { /* ignore */ }
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

  async _collectWebRtcDiagnostics() {
    const transports = {};
    const producers = [];

    try {
      const stats = await withTimeout(this.sendTransport?.getStats?.(), DIAGNOSTIC_STAT_TIMEOUT_MS, null);
      if (stats) transports.sendSelectedCandidatePair = selectedCandidatePair(stats);
      else if (this.sendTransport && !this.sendTransport.closed) transports.sendStatsError = 'stats timeout';
    } catch (err) {
      transports.sendStatsError = err.message;
    }

    for (const [source, producer] of [
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
          ...(stats ? { stats: summarizeOutboundStats(stats) } : { error: 'stats timeout' }),
        });
      } catch (err) {
        producers.push({ source, id: producer.id, kind: producer.kind, error: err.message });
      }
    }

    return { transports, mediaStats: { producers, consumers: [] } };
  }

  sendTelemetry(report = {}) {
    if (!this.socket?.connected) return;
    const sentAt = Date.now();
    withTimeout(this._collectWebRtcDiagnostics(), TELEMETRY_DIAGNOSTIC_TIMEOUT_MS, {
      transports: { diagnosticsError: 'diagnostics timeout' },
      mediaStats: { producers: [], consumers: [] },
    }).then(diagnostics => {
      if (!this.socket?.connected) return;
      this.socket.timeout(1500).emit('clientTelemetry', {
        ...report,
        appType: 'screen-share',
        appVersion: this._appVersion,
        platform: report.platform || this._platform,
        locationName: this._displayName,
        clientTime: sentAt,
        connection: {
          ...(report.connection || {}),
          telemetryRttMs: this._lastTelemetryRtt,
          lastTelemetryAckAt: this._lastTelemetryAckAt,
        },
        transports: {
          socketConnected: !!this.socket?.connected,
          sendState: this.sendTransport?.connectionState || 'none',
          recvState: 'none',
          sendClosed: !!this.sendTransport?.closed,
          recvClosed: true,
          ...(diagnostics.transports || {}),
        },
        consumers: [],
        mediaStats: diagnostics.mediaStats || {},
      }, (err) => {
        if (err) return;
        this._lastTelemetryRtt = Date.now() - sentAt;
        this._lastTelemetryAckAt = Date.now();
      });
    }).catch(() => {});
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
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
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
    this.stopScreenShare().catch(() => {});
    this._resetMediaSession({ stopTracks: false });
    this.socket?.disconnect();
  }
}
