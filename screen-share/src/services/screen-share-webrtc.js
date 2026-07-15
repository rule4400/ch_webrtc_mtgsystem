import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const SETUP_WATCHDOG_MS = 20000;
const HARD_RECONNECT_DELAY_MS = 1000;

/**
 * 端末ごとに永続な一意ID。setMetadata でサーバーへ申告すると、サーバーは同じ
 * instanceId の古いセッションを新しい接続で即時置き換える。瞬断・再起動後に
 * 古いソケットが ping タイムアウトまで残って「同じPCが二重に接続中」に
 * 見える状態を防ぐ（クライアントアプリと同じ仕組み）。
 */
function getInstanceId() {
  const KEY = 'screen_share_instance_id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    if (!getInstanceId._fallback) {
      getInstanceId._fallback = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    return getInstanceId._fallback;
  }
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
    this._initialized = false;
    this._manualDisconnect = false;
    this._displayName = '画面共有';
    this._appVersion = '0.1.0';
    this._channelId = 'general';
    this._instanceId = getInstanceId();
    this._maxBitrate = 2_500_000;
    this._lastTelemetryRtt = null;
    this._lastTelemetryAckAt = null;
    this._setupInFlight = null;
    this._setupGeneration = 0;
    this._setupStartedAt = 0;
    this._setupWatchdogTimer = null;
    this._hardReconnectTimer = null;
    // サーバーから「重複セッション」として拒否された場合、この時刻まで自動再接続を控える
    // （クライアントアプリと同じ仕組み。無いと1秒周期の到達確認が拒否→再接続を延々繰り返す）
    this._rejectedUntil = 0;
    // 接続済みなのに未初期化の場合のセットアップ再試行の間隔制御
    this._lastSetupAttemptAt = 0;

    this.onConnectionChange = null;
    this.onSystemStateUpdated = null;
    this.onUpdateCommand = null;
    this.onSessionRejected = null; // (payload) => void 重複セッションとして拒否された
  }

  connect(serverUrl, displayName, options = {}) {
    this._displayName = displayName || '画面共有';
    this._appVersion = options.appVersion || this._appVersion;
    this._channelId = options.channelId || this._channelId || 'general';
    this._manualDisconnect = false;
    this._rejectedUntil = 0; // 明示的な接続要求では拒否バックオフを持ち越さない

    // 既存ソケットがある状態で connect が呼ばれた場合は必ず破棄してから作り直す。
    // 破棄しないと古いソケットが裏で自動再接続を続け、同じ端末から二重セッションを
    // 張ってしまう（クライアントアプリと同じ対策）。
    if (this.socket) {
      const oldSocket = this.socket;
      this.socket = null;
      this._setupGeneration += 1;
      this._setupInFlight = null;
      this._initialized = false;
      this._clearSetupWatchdog();
      if (this._hardReconnectTimer) {
        clearTimeout(this._hardReconnectTimer);
        this._hardReconnectTimer = null;
      }
      try { oldSocket.removeAllListeners(); } catch { /* ignore */ }
      try { oldSocket.io?.removeAllListeners?.(); } catch { /* ignore */ }
      try { oldSocket.disconnect(); } catch { /* ignore */ }
    }

    return new Promise((resolve, reject) => {
      this.socket = io(serverUrl, {
        // 同一URLでの Manager/Socket 共有(multiplex)を防ぐ。共有されると破棄済みの
        // ハンドラが同じソケット上で蘇り、重複 transport/producer の原因になる。
        forceNew: true,
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

      this.socket.on('disconnect', (reason) => {
        this._setupGeneration += 1;
        this._initialized = false;
        // 古いセットアップPromiseを切り離す。残したままだと、再接続直後の
        // _setupSession() が切断前の（もう成功し得ない）Promiseをそのまま返し、
        // setMetadata が再送されず metadataReady=false のゾンビ接続になる。
        this._setupInFlight = null;
        this._clearSetupWatchdog();
        this.onConnectionChange?.(false);
        if (!this._manualDisconnect && reason === 'io server disconnect') {
          // サーバー都合の切断は socket.io の自動再接続に乗らないため自前で繋ぎ直す。
          // 重複セッションとして拒否された直後は、正規セッションとの
          // 置き換え合戦を避けるためバックオフ時刻まで待つ。
          const delay = Math.max(2000, this._rejectedUntil - Date.now());
          setTimeout(() => {
            if (!this._manualDisconnect) this.socket?.connect();
          }, delay);
        }
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

      // 同じ端末の稼働中セッションが既に存在するため、この接続は受け入れられなかった。
      // すぐ再接続すると正規セッションと置き換え合戦になるので、一定時間待ってから
      // 再試行する（クライアントアプリと同じ仕組み）。
      this.socket.on('sessionRejected', (payload = {}) => {
        const retryMs = Number(payload.retryAfterMs) > 0 ? Number(payload.retryAfterMs) : 60000;
        this._rejectedUntil = Date.now() + retryMs;
        console.warn(`[ScreenShare] session rejected (${payload.reason || 'duplicate'}); retrying in ${Math.round(retryMs / 1000)}s`);
        this.onSessionRejected?.(payload);
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
        channelId: this._channelId,
        instanceId: this._instanceId,
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

  /** 共有解像度設定に応じた送信ビットレート上限（bps） */
  setMaxBitrate(bitrate) {
    if (Number.isFinite(bitrate) && bitrate > 0) this._maxBitrate = bitrate;
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
          { rid: 'r0', maxBitrate: Math.max(300_000, Math.round(this._maxBitrate / 4)), scaleResolutionDownBy: 2 },
          { rid: 'r1', maxBitrate: this._maxBitrate },
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

  /** 配信先チャンネルを変更する（クライアントの setChannel と同じサーバーAPI） */
  async setChannel(channelId) {
    this._channelId = channelId || this._channelId || 'general';
    if (!this.socket?.connected) return { channelId: this._channelId };
    const result = await this._request('setChannel', { channelId: this._channelId });
    if (result?.channelId) this._channelId = result.channelId;
    return { channelId: this._channelId };
  }

  /** 全ピア状態（チャンネル別メンバー表示用。クライアントの1秒ポーリングと同じAPI） */
  async getPeers() {
    return this._request('getPeers');
  }

  isSocketConnected() {
    return !!this.socket?.connected;
  }

  isInitialized() {
    return this._initialized;
  }

  /** サーバーに重複セッションとして拒否され、再試行待ちの間 true */
  isSessionRejected() {
    return Date.now() < this._rejectedUntil;
  }

  /** サーバー復帰時に再接続・セットアップ再開を促す（1秒周期の到達確認から呼ばれる） */
  requestReconnect() {
    if (this._manualDisconnect || !this.socket) return;
    if (Date.now() < this._rejectedUntil) return; // 重複拒否バックオフ中は待つ
    if (!this.socket.connected) {
      // socket.io の自動再接続が進行中(active)なら任せる。毎秒 connect() を重ねると
      // 劣化経路では接続試行同士が輻輳して、かえって確立しにくくなる。
      if (this.socket.active) return;
      try { this.socket.connect(); } catch { /* socket.io が再試行する */ }
      return;
    }
    if (!this._initialized) {
      // 接続済みなのに未初期化のまま: セットアップが途中で失敗した状態。
      // 放置するとソケットは健全なため誰も再開せず、サーバー上は
      // metadataReady=false のゾンビ接続として残り続ける。
      const setupAge = this._setupStartedAt ? Date.now() - this._setupStartedAt : 0;
      if (this._setupInFlight && setupAge >= SETUP_WATCHDOG_MS) {
        this._hardReconnect('probe-setup-stalled');
        return;
      }
      if (this._setupInFlight) return; // 進行中のセットアップを待つ
      if (Date.now() - this._lastSetupAttemptAt < 3000) return; // 再試行は3秒間隔
      this._lastSetupAttemptAt = Date.now();
      this._setupSession().catch(err => {
        console.warn('[ScreenShare] setup retry failed:', err.message);
        this.onConnectionChange?.(false);
      });
    }
  }

  sendTelemetry(report = {}) {
    if (!this.socket?.connected) return;
    const sentAt = Date.now();
    this.socket.timeout(1500).emit('clientTelemetry', {
      ...report,
      appType: 'screen-share',
      appVersion: this._appVersion,
      locationName: this._displayName,
      channelId: this._channelId,
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
    // リスナーを全て外してから切断する。外さないと、ソケットが後続の接続に
    // 再利用された場合に破棄済みハンドラが発火して重複セッションの原因になる。
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.removeAllListeners(); } catch { /* ignore */ }
      try { socket.io?.removeAllListeners?.(); } catch { /* ignore */ }
      try { socket.disconnect(); } catch { /* ignore */ }
    }
  }
}
