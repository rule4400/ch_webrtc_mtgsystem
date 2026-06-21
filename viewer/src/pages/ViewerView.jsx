import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Hash, MicOff, MonitorPlay, Settings, Volume2, VolumeX, VideoOff } from 'lucide-react';
import { ViewerWebRTCManager } from '../services/viewer-webrtc';

const APP_VERSION = '0.1.5';
const APP_TYPE = 'viewer';
const DEFAULT_SYSTEM_STATE = {
  brand: 'CHECKHOUSE Meeting System',
  channels: [{ id: 'general', name: '一般' }],
  latestVersions: { [APP_TYPE]: APP_VERSION },
  updatePackages: {},
};

function getGridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function serializeDevices(devices) {
  return devices.map(device => ({
    deviceId: device.deviceId,
    groupId: device.groupId,
    kind: device.kind,
    label: device.label || device.kind,
  }));
}

function trackReport(track) {
  if (!track) return { present: false, readyState: 'missing', enabled: false, muted: false, label: '' };
  return {
    present: true,
    readyState: track.readyState,
    enabled: track.enabled,
    muted: !!track.muted,
    label: track.label || '',
  };
}

const defaultViewerConfig = {
  serverIp: '127.0.0.1',
  serverPort: '3000',
  viewerName: '閲覧端末',
};
const QUICK_RESTART_CONNECT_WINDOW_MS = 5000;
const VIEWER_INSTANCE_ID_KEY = 'sfu_viewer_instance_id';

function createInstanceId(prefix) {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${random}`;
}

function getOrCreateInstanceId(storageKey, prefix) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return saved;
    const next = createInstanceId(prefix);
    localStorage.setItem(storageKey, next);
    return next;
  } catch {
    return createInstanceId(prefix);
  }
}

async function connectWithinStartupWindow(manager, serverUrl, viewerName, options = {}) {
  let timedOut = false;
  const connectPromise = manager.connect(serverUrl, viewerName, options)
    .then(() => 'connected')
    .catch((err) => {
      if (timedOut) {
        console.warn('[ViewerQuickRestart] connection failed after startup window:', err.message);
        return 'failed-late';
      }
      throw err;
    });
  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => {
      timedOut = true;
      resolve('pending');
    }, QUICK_RESTART_CONNECT_WINDOW_MS);
  });
  return Promise.race([connectPromise, timeoutPromise]);
}

function sanitizeViewerConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const serverIp = String(raw.serverIp || defaultViewerConfig.serverIp).trim() || defaultViewerConfig.serverIp;
  const rawPort = String(raw.serverPort || defaultViewerConfig.serverPort).trim();
  const serverPort = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535
    ? rawPort
    : defaultViewerConfig.serverPort;
  const viewerName = String(raw.viewerName || defaultViewerConfig.viewerName).trim() || defaultViewerConfig.viewerName;

  return {
    ...raw,
    serverIp,
    serverPort,
    viewerName,
  };
}

function loadViewerConfig() {
  const saved = localStorage.getItem('sfu_viewer_config');
  if (!saved) return defaultViewerConfig;

  try {
    return sanitizeViewerConfig(JSON.parse(saved));
  } catch (err) {
    console.warn('[Config] invalid sfu_viewer_config ignored:', err.message);
    localStorage.removeItem('sfu_viewer_config');
    return defaultViewerConfig;
  }
}

function serverUrlFromViewerConfig(config) {
  const clean = sanitizeViewerConfig(config);
  return `http://${clean.serverIp}:${clean.serverPort || 3000}`;
}

async function probeServerReady(config, timeoutMs = 800) {
  const baseUrl = serverUrlFromViewerConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ready = await fetch(`${baseUrl}/ready`, { signal: controller.signal, cache: 'no-store' });
    if (ready.ok) return true;
  } catch {
    // /ready がない古いサーバーもあるため /health を見る。
  } finally {
    clearTimeout(timer);
  }

  const fallbackController = new AbortController();
  const fallbackTimer = setTimeout(() => fallbackController.abort(), timeoutMs);
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: fallbackController.signal, cache: 'no-store' });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(fallbackTimer);
  }
}

const VideoCell = React.memo(function VideoCell({
  label, stream, videoPaused, audioPaused, speakerDeviceId, speakerMuted,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !!(speakerMuted || audioPaused);
    if (video.srcObject !== stream) video.srcObject = stream || null;
    if (!stream) return;

    const play = () => {
      const promise = video.play();
      if (promise?.catch) {
        promise.catch(() => {
          const retry = () => {
            video.play().catch(() => {});
            cleanup();
          };
          const cleanup = () => {
            document.removeEventListener('click', retry);
            document.removeEventListener('keydown', retry);
          };
          document.addEventListener('click', retry, { once: true });
          document.addEventListener('keydown', retry, { once: true });
        });
      }
    };

    play();
  }, [stream, speakerMuted, audioPaused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (speakerDeviceId && typeof video.setSinkId === 'function') {
      video.setSinkId(speakerDeviceId).catch(() => {});
    }
  }, [speakerDeviceId]);

  const cameraOff = !!videoPaused || !stream?.getVideoTracks().length;

  return (
    <div className="video-cell">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: '#000',
          display: cameraOff ? 'none' : 'block',
        }}
      />

      {cameraOff && (
        <div className="cam-off-overlay">
          <VideoOff size={30} color="rgba(255,255,255,0.3)" />
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem', marginTop: 8 }}>
            映像なし
          </span>
        </div>
      )}

      <div className="cell-label">
        {audioPaused && <MicOff size={11} color="#ef4444" style={{ flexShrink: 0 }} />}
        <span>{label}</span>
      </div>

      {audioPaused && (
        <div className="mute-badge">
          <MicOff size={12} color="white" />
        </div>
      )}
    </div>
  );
});

export default function ViewerView() {
  const [peers, setPeers] = useState(new Map());
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [audioOutDevices, setAudioOutDevices] = useState([]);
  const [selectedAudioOutId, setSelectedAudioOutId] = useState('');
  const [uiResetToken, setUiResetToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(() => !localStorage.getItem('sfu_viewer_config'));
  const [settingsDraft, setSettingsDraft] = useState(() => sanitizeViewerConfig(loadViewerConfig()));
  const [systemState, setSystemState] = useState(DEFAULT_SYSTEM_STATE);
  const [updateNotice, setUpdateNotice] = useState(null);
  const [updateDownload, setUpdateDownload] = useState(null);

  const managerRef = useRef(null);
  const configRef = useRef({});
  const selectedAudioOutIdRef = useRef('');
  const telemetryStateRef = useRef({});
  const adminHandlersRef = useRef({});
  const quickRestartInFlightRef = useRef(false);
  const quickRestartHandlerRef = useRef(null);
  const serverProbeInFlightRef = useRef(false);
  const updateDownloadKeyRef = useRef('');

  const channels = Array.isArray(systemState.channels) && systemState.channels.length
    ? systemState.channels
    : DEFAULT_SYSTEM_STATE.channels;
  const currentPlatform = window.electronAPI?.platform || '';
  const rawUpdatePackage = systemState.updatePackages?.[APP_TYPE] || null;
  const updatePackage = rawUpdatePackage?.platforms?.[currentPlatform] || rawUpdatePackage;
  const latestVersion = updatePackage?.version || systemState.latestVersions?.[APP_TYPE] || APP_VERSION;
  const updateAvailable = latestVersion && latestVersion !== APP_VERSION;

  const refreshAudioOutputs = useCallback(async (preferredId = null) => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(device => device.kind === 'audiooutput');
      setAudioOutDevices(outputs);
      const currentId = preferredId ?? selectedAudioOutIdRef.current;
      if (!currentId && outputs[0]?.deviceId) {
        selectedAudioOutIdRef.current = outputs[0].deviceId;
        setSelectedAudioOutId(outputs[0].deviceId);
      }
      return outputs;
    } catch {
      // setSinkId/audiooutput enumeration is not available on every platform.
      return [];
    }
  }, []);

  useEffect(() => {
    telemetryStateRef.current = {
      peers,
      status,
      error,
      speakerMuted,
      audioOutDevices,
      selectedAudioOutId,
      viewerName: configRef.current.viewerName || '閲覧端末',
      systemState,
      updateNotice,
    };
  }, [peers, status, error, speakerMuted, audioOutDevices, selectedAudioOutId, systemState, updateNotice]);

  const releaseViewerRuntime = useCallback(({ status: nextStatus = 'connecting', updateState = true } = {}) => {
    const manager = managerRef.current;
    managerRef.current = null;
    if (manager) {
      manager.onPeerUpdated = null;
      manager.onPeerRemoved = null;
      manager.onConnectionChange = null;
      manager.onRestartCommand = null;
      manager.onAdminSetDevice = null;
      manager.onAdminSetMediaState = null;
      manager.onAdminRefreshDevices = null;
      manager.onSystemStateUpdated = null;
      manager.onPeerChannelChanged = null;
      manager.onUpdateCommand = null;
      manager.disconnect();
    }
    if (updateState) {
      setPeers(new Map());
      setStatus(nextStatus);
    }
  }, []);

  const startViewerSession = useCallback(async () => {
    const config = loadViewerConfig();
    configRef.current = config;
    selectedAudioOutIdRef.current = config.selectedAudioOutId || '';
    setSelectedAudioOutId(config.selectedAudioOutId || '');

    await refreshAudioOutputs(config.selectedAudioOutId || '');

    const manager = new ViewerWebRTCManager();
    managerRef.current = manager;

    manager.onPeerUpdated = (socketId, peer) => {
      setPeers(prev => {
        const next = new Map(prev);
        next.set(socketId, peer);
        return next;
      });
    };
    manager.onPeerRemoved = (socketId) => {
      setPeers(prev => {
        const next = new Map(prev);
        next.delete(socketId);
        return next;
      });
    };
    manager.onConnectionChange = (ok) => setStatus(ok ? 'connected' : 'error');
    manager.onSystemStateUpdated = (state = {}) => {
      setSystemState({ ...DEFAULT_SYSTEM_STATE, ...state });
    };
    manager.onUpdateCommand = (payload) => {
      if (payload?.appType && payload.appType !== APP_TYPE && payload.appType !== 'all') return;
      setUpdateNotice(payload);
    };
    manager.onRestartCommand = (payload) => quickRestartHandlerRef.current?.(payload);
    manager.onAdminSetDevice = (payload) => {
      if (!adminHandlersRef.current.setDevice) throw new Error('device control is not ready');
      return adminHandlersRef.current.setDevice(payload);
    };
    manager.onAdminSetMediaState = (payload) => {
      if (!adminHandlersRef.current.setMediaState) throw new Error('media state control is not ready');
      return adminHandlersRef.current.setMediaState(payload);
    };
    manager.onAdminRefreshDevices = () => {
      if (!adminHandlersRef.current.refreshDevices) throw new Error('device refresh is not ready');
      return adminHandlersRef.current.refreshDevices();
    };

    const serverUrl = serverUrlFromViewerConfig(config);
    const connectionState = await connectWithinStartupWindow(manager, serverUrl, config.viewerName, {
      appVersion: APP_VERSION,
      clientInstanceId: getOrCreateInstanceId(VIEWER_INSTANCE_ID_KEY, APP_TYPE),
      platform: window.electronAPI?.platform || '',
    });
    setStatus(connectionState === 'connected' ? 'connected' : 'connecting');
    setError(null);
    return { manager, connectionState };
  }, [refreshAudioOutputs]);

  const performQuickRestart = useCallback(async (payload = {}) => {
    if (quickRestartInFlightRef.current) return;
    quickRestartInFlightRef.current = true;
    const startedAt = Date.now();
    const reason = payload?.reason || payload?.source || 'server-command';

    try {
      releaseViewerRuntime({ status: 'restarting' });
      setError(null);
      setUiResetToken(token => token + 1);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const { connectionState } = await startViewerSession();
      window.electronAPI?.quickRestartResult?.({
        ok: true,
        reason,
        connectionState,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (err) {
      console.error('[ViewerQuickRestart] failed:', err);
      setStatus('error');
      setError(err.message);
      window.electronAPI?.quickRestartResult?.({
        ok: false,
        reason,
        error: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      quickRestartInFlightRef.current = false;
    }
  }, [releaseViewerRuntime, startViewerSession]);

  useEffect(() => {
    quickRestartHandlerRef.current = performQuickRestart;
  }, [performQuickRestart]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onQuickRestartRequest?.((payload) => {
      quickRestartHandlerRef.current?.(payload);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    let disposed = false;
    const init = async () => {
      try {
        await startViewerSession();
      } catch (err) {
        if (disposed) return;
        console.error('[Viewer]', err);
        setStatus('error');
        setError(err.message);
      }
    };

    init();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioOutputs);

    return () => {
      disposed = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshAudioOutputs);
      releaseViewerRuntime({ updateState: false });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => managerRef.current?.syncPeers(), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(async () => {
      if (quickRestartInFlightRef.current || serverProbeInFlightRef.current) return;
      const manager = managerRef.current;
      if (manager?.isSocketConnected() && manager?.isInitialized()) return;

      serverProbeInFlightRef.current = true;
      try {
        const config = sanitizeViewerConfig(configRef.current.serverIp ? configRef.current : loadViewerConfig());
        const reachable = await probeServerReady(config);
        if (!reachable) {
          setStatus(prev => (prev === 'restarting' ? prev : 'error'));
          return;
        }

        setStatus(prev => (prev === 'connected' ? prev : 'connecting'));
        if (manager) {
          manager.requestReconnect();
        } else {
          await startViewerSession();
        }
      } catch (err) {
        console.warn('[ViewerServerProbe]', err.message);
      } finally {
        serverProbeInFlightRef.current = false;
      }
    }, 1000);

    return () => clearInterval(id);
  }, [startViewerSession]);

  const changeSpeaker = useCallback((deviceId) => {
    selectedAudioOutIdRef.current = deviceId;
    setSelectedAudioOutId(deviceId);
    const config = { ...configRef.current, selectedAudioOutId: deviceId };
    configRef.current = config;
    localStorage.setItem('sfu_viewer_config', JSON.stringify(config));
  }, []);

  const openSettings = useCallback(() => {
    const config = sanitizeViewerConfig(configRef.current.serverIp ? configRef.current : loadViewerConfig());
    setSettingsDraft(config);
    setSettingsOpen(true);
  }, []);

  const updateSettingsDraft = useCallback((key, value) => {
    setSettingsDraft(prev => ({ ...prev, [key]: value }));
  }, []);

  const saveViewerSettings = useCallback(() => {
    const previous = sanitizeViewerConfig(configRef.current.serverIp ? configRef.current : loadViewerConfig());
    const next = sanitizeViewerConfig(settingsDraft);
    const merged = {
      ...previous,
      ...next,
      selectedAudioOutId: selectedAudioOutIdRef.current || previous.selectedAudioOutId || '',
    };
    const requiresReconnect =
      previous.serverIp !== merged.serverIp ||
      previous.serverPort !== merged.serverPort ||
      previous.viewerName !== merged.viewerName;

    configRef.current = merged;
    localStorage.setItem('sfu_viewer_config', JSON.stringify(merged));
    setSettingsDraft(merged);
    setSettingsOpen(false);

    if (requiresReconnect) {
      quickRestartHandlerRef.current?.({ reason: 'viewer-settings-saved' });
    }
  }, [settingsDraft]);

  const openUpdate = useCallback(() => {
    if (updateDownload?.path && updateDownload.status === 'ready') {
      window.electronAPI?.openDownloadedUpdate?.(updateDownload.path);
      return;
    }
    const url = updateNotice?.packageInfo?.url || updatePackage?.url;
    if (!url) return;
    window.electronAPI?.openExternal?.(url);
  }, [updateDownload, updateNotice, updatePackage]);

  useEffect(() => {
    const packageInfo = updateNotice?.packageInfo || updatePackage;
    if (!updateAvailable || !packageInfo?.url || !window.electronAPI?.downloadUpdatePackage) return;
    const key = `${packageInfo.version || latestVersion}:${packageInfo.url}`;
    if (updateDownloadKeyRef.current === key) return;
    updateDownloadKeyRef.current = key;
    let cancelled = false;
    setUpdateDownload({ status: 'downloading', packageInfo });
    window.electronAPI.downloadUpdatePackage(packageInfo)
      .then(result => {
        if (cancelled) return;
        setUpdateDownload({ status: 'ready', packageInfo, ...result });
      })
      .catch(err => {
        console.warn('[updateDownload]', err.message);
        if (!cancelled) setUpdateDownload({ status: 'error', packageInfo, error: err.message });
      });
    return () => { cancelled = true; };
  }, [latestVersion, updateAvailable, updateNotice, updatePackage]);

  useEffect(() => {
    adminHandlersRef.current = {
      setDevice: async ({ kind, deviceId }) => {
        if (kind !== 'audioOutput') throw new Error(`unsupported device kind: ${kind}`);
        changeSpeaker(deviceId);
        return { selectedDevices: { audioOutput: deviceId } };
      },
      setMediaState: async ({ kind, enabled }) => {
        if (kind !== 'speaker') throw new Error(`unsupported media kind: ${kind}`);
        setSpeakerMuted(!enabled);
        return { localMedia: { speakerMuted: !enabled } };
      },
      refreshDevices: async () => {
        const outputs = await refreshAudioOutputs();
        return {
          devices: {
            video: [],
            audioInput: [],
            audioOutput: serializeDevices(outputs),
          },
        };
      },
    };
  }, [changeSpeaker, refreshAudioOutputs]);

  useEffect(() => {
    const sendTelemetry = () => {
      const manager = managerRef.current;
      if (!manager) return;
      const state = telemetryStateRef.current;
      const remotePeers = Array.from((state.peers || new Map()).entries()).map(([socketId, peer]) => {
        const video = peer.stream?.getVideoTracks()[0] || null;
        const audio = peer.stream?.getAudioTracks()[0] || null;
        const screen = peer.screenStream?.getVideoTracks()[0] || null;
        const screenAudio = peer.screenStream?.getAudioTracks()[0] || null;
        return {
          socketId,
          name: peer.locationName,
          channelId: peer.channelId || '',
          appType: peer.appType || 'client',
          videoPaused: !!peer.videoPaused,
          audioPaused: !!peer.audioPaused,
          screenPaused: !!peer.screenPaused,
          screenAudioPaused: !!peer.screenAudioPaused,
          video: trackReport(video),
          audio: trackReport(audio),
          screen: trackReport(screen),
          screenAudio: trackReport(screenAudio),
          receivingVideo: !!video && video.readyState === 'live' && !peer.videoPaused,
          receivingAudio: !!audio && audio.readyState === 'live' && !peer.audioPaused,
          receivingScreen: !!screen && screen.readyState === 'live' && !peer.screenPaused,
          receivingScreenAudio: !!screenAudio && screenAudio.readyState === 'live' && !peer.screenAudioPaused,
        };
      });

      manager.sendTelemetry({
        appType: 'viewer',
        appVersion: APP_VERSION,
        locationName: state.viewerName,
        status: state.status,
        devices: {
          video: [],
          audioInput: [],
          audioOutput: serializeDevices(state.audioOutDevices || []),
        },
        selectedDevices: {
          audioOutput: state.selectedAudioOutId,
        },
        localMedia: {
          cameraEnabled: false,
          micEnabled: false,
          speakerMuted: !!state.speakerMuted,
          error: state.error || null,
        },
        remoteMonitor: {
          peerCount: remotePeers.length,
          receivingVideoCount: remotePeers.filter(peer => peer.receivingVideo || peer.receivingScreen).length,
          receivingAudioCount: remotePeers.filter(peer => peer.receivingAudio).length,
          peers: remotePeers,
        },
        connection: {
          appStatus: state.status,
        },
      });
    };

    sendTelemetry();
    const id = setInterval(sendTelemetry, 2000);
    return () => clearInterval(id);
  }, []);

  const peerList = Array.from(peers.entries());
  const screenShares = peerList.filter(([, peer]) => (
    peer.screenProducerId && peer.screenStream?.getVideoTracks().length && !peer.screenPaused
  ));
  const totalCells = peerList.length + screenShares.length;
  const cols = getGridCols(totalCells || 1);

  return (
    <div className="main-layout viewer-layout with-sidebar">
      <aside className="channel-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-mark">CH</div>
          <div>
            <div className="sidebar-title">CHECKHOUSE</div>
            <div className="sidebar-subtitle">Meeting System</div>
          </div>
        </div>

        <div className="channel-section-label">チャンネル</div>
        <div className="channel-list">
          {channels.map(channel => (
            <div key={channel.id} className="channel-item readonly" title={channel.name}>
              <Hash size={15} />
              <span>{channel.name}</span>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          {updateAvailable && (
            <button
              type="button"
              className="update-mini"
              onClick={openUpdate}
              disabled={!updatePackage?.url && !updateNotice?.packageInfo?.url && updateDownload?.status !== 'ready'}
              title={updateDownload?.status === 'ready' ? 'ダウンロード済みアップデートを開く' : 'アップデート'}
            >
              <Download size={14} />
              <span>v{latestVersion}</span>
            </button>
          )}
          <div className="version-line">Viewer v{APP_VERSION}</div>
        </div>
      </aside>

      <div className="meeting-stage">
      <div className="header-bar">
        <div className="header-title">閲覧専用モニター</div>
        <div className="header-right">
          <div className="header-status">
            <span
              className="status-dot"
              style={{
	                background:
	                  status === 'connected' ? '#4ade80' :
	                  status === 'error' ? '#ef4444' :
	                  status === 'restarting' ? '#60a5fa' : '#facc15',
	              }}
	            />
	            {status === 'connected' ? `受信中 ${peerList.length}拠点` :
	             status === 'error' ? 'サーバー未接続' :
	             status === 'restarting' ? '再構築中...' : '接続中...'}
          </div>

          <button
            className={`ctrl-btn ${speakerMuted ? 'danger' : ''}`}
            style={{ width: 32, height: 32 }}
            onClick={() => setSpeakerMuted(v => !v)}
            title="音声ミュート"
          >
            {speakerMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>

          {audioOutDevices.length > 0 && (
            <select
              className="viewer-select"
              value={selectedAudioOutId}
              onChange={event => changeSpeaker(event.target.value)}
              title="スピーカー"
            >
              {audioOutDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || 'スピーカー'}
                </option>
              ))}
            </select>
          )}

          <button
            className="ctrl-btn"
            style={{ width: 32, height: 32 }}
            onClick={openSettings}
            title="設定"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {error && (
        <div className="cam-error-bar">接続エラー: {error}</div>
      )}

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <div className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <h2>閲覧端末設定</h2>
                <p>設定を開いている間も受信は継続します</p>
              </div>
              <button className="mini-btn" onClick={() => setSettingsOpen(false)}>閉じる</button>
            </div>

            <div className="settings-section">
              <h2>表示設定</h2>
              <div className="field">
                <label>閲覧端末名</label>
                <input
                  type="text"
                  value={settingsDraft.viewerName}
                  onChange={event => updateSettingsDraft('viewerName', event.target.value)}
                  placeholder="例: 管理室モニター"
                />
              </div>
            </div>

            <div className="settings-section">
              <h2>SFUサーバー</h2>
              <div className="server-row">
                <div className="field">
                  <label>IPアドレス</label>
                  <input
                    type="text"
                    value={settingsDraft.serverIp}
                    onChange={event => updateSettingsDraft('serverIp', event.target.value)}
                    placeholder="例: 192.168.1.223"
                  />
                </div>
                <div className="field">
                  <label>ポート</label>
                  <input
                    type="text"
                    value={settingsDraft.serverPort}
                    onChange={event => updateSettingsDraft('serverPort', event.target.value)}
                    placeholder="3000"
                  />
                </div>
              </div>
            </div>

            <button className="btn-join" onClick={saveViewerSettings}>
              保存
            </button>
          </div>
        </div>
      )}

      <div
        className="video-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {totalCells === 0 ? (
          <div className="viewer-empty">
            <MonitorPlay size={42} color="rgba(255,255,255,0.35)" />
            <div>受信できる拠点映像を待機中</div>
          </div>
        ) : (
          <>
	          {peerList.map(([socketId, peer]) => (
	            <VideoCell
	              key={`${uiResetToken}-${socketId}`}
	              label={peer.locationName}
              stream={peer.stream}
              videoPaused={peer.videoPaused}
              audioPaused={peer.audioPaused}
              speakerDeviceId={selectedAudioOutId}
              speakerMuted={speakerMuted}
            />
          ))}
          {screenShares.map(([socketId, peer]) => (
            <VideoCell
              key={`${uiResetToken}-${socketId}-screen`}
              label={`${peer.locationName} / ${peer.screenLabel || '画面共有'}`}
              stream={peer.screenStream}
              videoPaused={peer.screenPaused}
              audioPaused={!!peer.screenAudioPaused}
              speakerDeviceId={selectedAudioOutId}
              speakerMuted={speakerMuted}
            />
          ))}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
