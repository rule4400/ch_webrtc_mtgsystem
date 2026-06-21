import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const SETUP_WATCHDOG_MS = 20000;
const HARD_RECONNECT_DELAY_MS = 1000;

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
    this._initialized = false;
    this._manualDisconnect = false;
    this._displayName = '画面共有';
    this._appVersion = '0.1.0';
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;
    this._setupInFlight = null;
    this._setupGeneration = 0;
    this._setupStartedAt = 0;
    this._setupWatchdogTimer = null;
    this._hardReconnectTimer = null;

    this.onConnectionChange = null;
    this.onSystemStateUpdated = null;
    this.onUpdateCommand = null;
  }

  connect(serverUrl, displayName, options = {}) {
    this._displayName = displayName || '画面共有';
    this._appVersion = options.appVersion || this._appVersion;
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

      this.socket.on('connect', async () => {
        try {
          await this._setupSession();
          resolve();
        } catch (err) {
          this.onConnectionChange?.(false);
          reject(err);
        }
      });

      this.socket.on('connect_error', () => {
        this._initialized = false;
        this.onConnectionChange?.(false);
      });

      this.socket.on('disconnect', () => {
        this._setupGeneration += 1;
        this._initialized = false;
        this._clearSetupWatchdog();
        this.onConnectionChange?.(false);
      });

      this.socket.io.on('reconnect', () => {
        this._setupSession().catch(err => {
          console.error('[ScreenShare] reconnect setup failed', err);
          this.onConnectionChange?.(false);
        });
      });

      this.socket.on('systemStateUpdated', (payload = {}) => {
        this.onSystemStateUpdated?.(payload);
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
        throw new Error(`screen-share setup superseded at ${stage}`);
      }
    };

    const setupPromise = (async () => {
      this.socket.emit('setMetadata', {
        locationName: this._displayName,
        appType: 'screen-share',
        appVersion: this._appVersion,
      });

      try {
        const config = await this._request('getServerConfig');
        if (Array.isArray(config?.iceServers)) this.iceServers = config.iceServers;
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

  async _initSendTransport() {
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    const { params } = await this._request('createWebRtcTransport', { forceTcp: false });
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
      if (state === 'failed' || state === 'disconnected') this.onConnectionChange?.(false);
    });
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
    this._clearSetupWatchdog();
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    this.sendTransport = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
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

  async startScreenShare(track, label, audioTrack = null) {
    if (!this.sendTransport) throw new Error('送信トランスポートが準備できていません');
    await this.stopScreenShare({ stopTrack: false });
    this.localScreenVideoTrack = track;
    this.localScreenAudioTrack = audioTrack;
    this.screenLabel = label || track.label || '画面共有';

    try {
      this.screenProducer = await this.sendTransport.produce({
        track,
        appData: {
          source: 'screen',
          label: label || track.label || '画面共有',
        },
        encodings: [
          { rid: 'r0', maxBitrate: 600_000, scaleResolutionDownBy: 2 },
          { rid: 'r1', maxBitrate: 1_800_000 },
        ],
        codecOptions: { videoGoogleStartBitrate: 1200 },
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
            label: label || audioTrack.label || '画面共有音声',
          },
          codecOptions: {
            opusStereo: 1,
            opusDtx: 1,
          },
        });
        this.screenAudioProducer.on('transportclose', () => {
          this.screenAudioProducer = null;
        });
        this.screenAudioProducer.on('trackended', () => {
          this._closeScreenAudioProducer().catch(() => {});
        });
      }
    } catch (err) {
      await this.stopScreenShare({ stopTrack: false });
      throw err;
    }
    return this.screenProducer;
  }

  async _reproduceScreen() {
    const track = this.localScreenVideoTrack;
    if (!track || track.readyState !== 'live') return;
    const audioTrack = this.localScreenAudioTrack?.readyState === 'live' ? this.localScreenAudioTrack : null;
    await this.startScreenShare(track, this.screenLabel || track.label || '画面共有', audioTrack);
  }

  async stopScreenShare({ stopTrack = true } = {}) {
    const audioProducer = this.screenAudioProducer;
    this.screenAudioProducer = null;
    if (audioProducer) {
      const audioTrack = audioProducer.track;
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
    if (!producer) return;

    const track = producer.track;
    try {
      if (this.socket?.connected) await this._request('closeProducer', { producerId: producer.id });
    } catch {
      // The server will also clean up on transport close.
    }
    try { producer.close(); } catch { /* ignore */ }
    if (stopTrack) {
      try { track?.stop(); } catch { /* ignore */ }
      if (this.localScreenVideoTrack === track) this.localScreenVideoTrack = null;
      this.localScreenAudioTrack = null;
    }
  }

  async _closeScreenAudioProducer() {
    const producer = this.screenAudioProducer;
    this.screenAudioProducer = null;
    if (!producer) return;
    try {
      if (this.socket?.connected) await this._request('closeProducer', { producerId: producer.id });
    } catch {
      // ignore
    }
    try { producer.close(); } catch { /* ignore */ }
  }

  sendTelemetry(report = {}) {
    if (!this.socket?.connected) return;
    const sentAt = Date.now();
    this.socket.timeout(1500).emit('clientTelemetry', {
      ...report,
      appType: 'screen-share',
      appVersion: this._appVersion,
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
      },
      consumers: [],
    }, (err) => {
      if (err) return;
      this._lastTelemetryRtt = Date.now() - sentAt;
      this._lastTelemetryAckAt = Date.now();
    });
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
    this._clearSetupWatchdog();
    if (this._hardReconnectTimer) {
      clearTimeout(this._hardReconnectTimer);
      this._hardReconnectTimer = null;
    }
    this.stopScreenShare().catch(() => {});
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    this.socket?.disconnect();
  }
}
