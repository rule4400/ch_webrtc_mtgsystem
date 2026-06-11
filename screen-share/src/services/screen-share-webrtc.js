import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

export class ScreenShareWebRTCManager {
  constructor() {
    this.socket = null;
    this.device = null;
    this.sendTransport = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.iceServers = [];
    this._initialized = false;
    this._manualDisconnect = false;
    this._displayName = '画面共有';
    this._appVersion = '0.1.0';
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;

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
        this._initialized = false;
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
    });
  }

  async _setupSession() {
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
    this._initialized = true;
    this.onConnectionChange?.(true);
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

  async startScreenShare(track, label, audioTrack = null) {
    if (!this.sendTransport) throw new Error('送信トランスポートが準備できていません');
    await this.stopScreenShare({ stopTrack: false });

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
    this.stopScreenShare().catch(() => {});
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    this.socket?.disconnect();
  }
}
