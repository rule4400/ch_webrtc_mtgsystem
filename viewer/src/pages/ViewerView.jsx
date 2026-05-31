import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MicOff, MonitorPlay, Settings, Volume2, VolumeX, VideoOff } from 'lucide-react';
import { ViewerWebRTCManager } from '../services/viewer-webrtc';

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

async function connectWithinStartupWindow(manager, serverUrl, viewerName) {
  let timedOut = false;
  const connectPromise = manager.connect(serverUrl, viewerName)
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

const VideoCell = React.memo(function VideoCell({
  label, stream, videoPaused, audioPaused, speakerDeviceId, speakerMuted,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !!speakerMuted;
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
  }, [stream, speakerMuted]);

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
  const navigate = useNavigate();
  const [peers, setPeers] = useState(new Map());
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [audioOutDevices, setAudioOutDevices] = useState([]);
  const [selectedAudioOutId, setSelectedAudioOutId] = useState('');
  const [uiResetToken, setUiResetToken] = useState(0);

  const managerRef = useRef(null);
  const configRef = useRef({});
  const selectedAudioOutIdRef = useRef('');
  const telemetryStateRef = useRef({});
  const adminHandlersRef = useRef({});
  const quickRestartInFlightRef = useRef(false);
  const quickRestartHandlerRef = useRef(null);

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
    };
  }, [peers, status, error, speakerMuted, audioOutDevices, selectedAudioOutId]);

  const releaseViewerRuntime = useCallback(({ status: nextStatus = 'connecting', updateState = true } = {}) => {
    const manager = managerRef.current;
    managerRef.current = null;
    if (manager) {
      manager.onPeerUpdated = null;
      manager.onPeerRemoved = null;
      manager.onConnectionChange = null;
      manager.onRestartCommand = null;
      manager.onAdminSetDevice = null;
      manager.onAdminRefreshDevices = null;
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
    manager.onRestartCommand = (payload) => quickRestartHandlerRef.current?.(payload);
    manager.onAdminSetDevice = (payload) => {
      if (!adminHandlersRef.current.setDevice) throw new Error('device control is not ready');
      return adminHandlersRef.current.setDevice(payload);
    };
    manager.onAdminRefreshDevices = () => {
      if (!adminHandlersRef.current.refreshDevices) throw new Error('device refresh is not ready');
      return adminHandlersRef.current.refreshDevices();
    };

    const serverUrl = `http://${config.serverIp}:${config.serverPort || 3000}`;
    const connectionState = await connectWithinStartupWindow(manager, serverUrl, config.viewerName);
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

  const changeSpeaker = useCallback((deviceId) => {
    selectedAudioOutIdRef.current = deviceId;
    setSelectedAudioOutId(deviceId);
    const config = { ...configRef.current, selectedAudioOutId: deviceId };
    configRef.current = config;
    localStorage.setItem('sfu_viewer_config', JSON.stringify(config));
  }, []);

  useEffect(() => {
    adminHandlersRef.current = {
      setDevice: async ({ kind, deviceId }) => {
        if (kind !== 'audioOutput') throw new Error(`unsupported device kind: ${kind}`);
        changeSpeaker(deviceId);
        return { selectedDevices: { audioOutput: deviceId } };
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
        return {
          socketId,
          name: peer.locationName,
          videoPaused: !!peer.videoPaused,
          audioPaused: !!peer.audioPaused,
          video: trackReport(video),
          audio: trackReport(audio),
          receivingVideo: !!video && video.readyState === 'live' && !peer.videoPaused,
          receivingAudio: !!audio && audio.readyState === 'live' && !peer.audioPaused,
        };
      });

      manager.sendTelemetry({
        appType: 'viewer',
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
          receivingVideoCount: remotePeers.filter(peer => peer.receivingVideo).length,
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
  const cols = getGridCols(peerList.length || 1);

  return (
    <div className="main-layout viewer-layout">
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
            onClick={() => navigate('/settings')}
            title="設定"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {error && (
        <div className="cam-error-bar">接続エラー: {error}</div>
      )}

      <div
        className="video-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {peerList.length === 0 ? (
          <div className="viewer-empty">
            <MonitorPlay size={42} color="rgba(255,255,255,0.35)" />
            <div>受信できる拠点映像を待機中</div>
          </div>
        ) : (
	          peerList.map(([socketId, peer]) => (
	            <VideoCell
	              key={`${uiResetToken}-${socketId}`}
	              label={peer.locationName}
              stream={peer.stream}
              videoPaused={peer.videoPaused}
              audioPaused={peer.audioPaused}
              speakerDeviceId={selectedAudioOutId}
              speakerMuted={speakerMuted}
            />
          ))
        )}
      </div>
    </div>
  );
}
