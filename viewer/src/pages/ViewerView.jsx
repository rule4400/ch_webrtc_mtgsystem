import React, { useCallback, useEffect, useRef, useState } from 'react';
import packageInfo from '../../package.json';
import { Download, Hash, MicOff, MonitorPlay, Settings, Volume2, VolumeX, VideoOff } from 'lucide-react';
import { ViewerWebRTCManager } from '../services/viewer-webrtc';

const APP_VERSION = packageInfo.version;
const APP_TYPE = 'viewer';
const DEFAULT_SYSTEM_STATE = {
  brand: 'CHECKHOUSE Meeting System',
  channels: [{ id: 'general', name: '一般' }],
  latestVersions: { [APP_TYPE]: APP_VERSION },
  updatePackages: {},
};

function isNewerVersion(latest, current) {
  if (!latest || latest === current) return false;
  const parse = value => String(value).trim().replace(/^v/i, '').split('.').map(part => parseInt(part, 10));
  const a = parse(latest);
  const b = parse(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return latest !== current;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

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
  authToken: '',
  viewerName: '閲覧端末',
};
const QUICK_RESTART_CONNECT_WINDOW_MS = 5000;

async function connectWithinStartupWindow(manager, serverUrl, viewerName, options = {}) {
  let timedOut = false;
  let timeoutId = null;
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
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve('pending');
    }, QUICK_RESTART_CONNECT_WINDOW_MS);
  });
  try {
    return await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function sanitizeViewerConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const serverIp = String(raw.serverIp || defaultViewerConfig.serverIp).trim() || defaultViewerConfig.serverIp;
  const rawPort = String(raw.serverPort || defaultViewerConfig.serverPort).trim();
  const serverPort = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535
    ? rawPort
    : defaultViewerConfig.serverPort;
  const viewerName = String(raw.viewerName || defaultViewerConfig.viewerName).trim() || defaultViewerConfig.viewerName;
  const authToken = typeof raw.authToken === 'string' ? raw.authToken.trim().slice(0, 2048) : '';

  return {
    ...raw,
    serverIp,
    serverPort,
    authToken,
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

const LAST_FRAME_HOLD_MS = 20 * 1000;
const LAST_FRAME_SAMPLE_MS = 2000;
const LAST_FRAME_STALL_GRACE_MS = 3000;
const LAST_FRAME_MAX_WIDTH = 640;
const LAST_FRAME_MAX_HEIGHT = 360;

// 瞬断時の最終フレームは URL 化せず canvas に保持し、20秒で必ず解除する。
function useLastFrameHold({ videoRef, stream, enabled, outageHint = false }) {
  const canvasRef = useRef(null);
  const enabledRef = useRef(enabled);
  const outageHintRef = useRef(outageHint);
  const streamRef = useRef(stream);
  const previousStreamRef = useRef(stream);
  const hasSnapshotRef = useRef(false);
  const snapshotCapturedAtRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const progressStreamRef = useRef(stream);
  const progressMediaTimeRef = useRef(Number.NaN);
  const progressDecodedFramesRef = useRef(Number.NaN);
  const outageStartedAtRef = useRef(0);
  const outageExpiredRef = useRef(false);
  const holdTimerRef = useRef(null);
  const statusRef = useRef('healthy');
  const [holdStatus, setHoldStatus] = useState('healthy');

  useEffect(() => {
    enabledRef.current = enabled;
    outageHintRef.current = outageHint;
    streamRef.current = stream;
    if (progressStreamRef.current !== stream) {
      progressStreamRef.current = stream;
      progressMediaTimeRef.current = Number.NaN;
      progressDecodedFramesRef.current = Number.NaN;
    }
  }, [enabled, outageHint, stream]);

  const updateStatus = useCallback((next) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setHoldStatus(next);
  }, []);
  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);
  const clearSnapshot = useCallback(() => {
    hasSnapshotRef.current = false;
    snapshotCapturedAtRef.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 1;
    canvas.height = 1;
  }, []);
  const resetOutage = useCallback((discardSnapshot = false) => {
    clearHoldTimer();
    outageStartedAtRef.current = 0;
    outageExpiredRef.current = false;
    updateStatus('healthy');
    if (discardSnapshot) {
      lastProgressAtRef.current = 0;
      clearSnapshot();
    }
  }, [clearHoldTimer, clearSnapshot, updateStatus]);
  const beginOutage = useCallback((observedAt = Date.now()) => {
    if (!enabledRef.current) return;
    const now = Date.now();
    const capturedAt = snapshotCapturedAtRef.current;
    const observedCandidate = Number.isFinite(observedAt)
      ? Math.min(now, Math.max(0, observedAt))
      : now;
    const candidate = capturedAt > 0
      ? Math.min(observedCandidate, capturedAt)
      : observedCandidate;
    if (!outageStartedAtRef.current) {
      outageStartedAtRef.current = candidate;
    }
    if (outageExpiredRef.current || !hasSnapshotRef.current || capturedAt <= 0) {
      updateStatus('fallback');
      return;
    }
    updateStatus('holding');
    clearHoldTimer();
    const remaining = Math.max(0, LAST_FRAME_HOLD_MS - (now - outageStartedAtRef.current));
    if (remaining === 0) {
      outageExpiredRef.current = true;
      updateStatus('fallback');
      return;
    }
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      outageExpiredRef.current = true;
      updateStatus('fallback');
    }, remaining);
  }, [clearHoldTimer, updateStatus]);
  const captureSnapshot = useCallback(({
    expectedStream = streamRef.current,
    allowInactiveTrack = false,
    capturedAt = Date.now(),
  } = {}) => {
    if (!enabledRef.current || (!allowInactiveTrack && outageHintRef.current) || document.hidden) return false;
    const video = videoRef.current;
    const track = expectedStream?.getVideoTracks?.()[0] || null;
    if (!video || !expectedStream || video.srcObject !== expectedStream ||
        (!allowInactiveTrack &&
          (!track || track.readyState !== 'live' || track.muted || !track.enabled || video.ended)) ||
        video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    const scale = Math.min(
      1,
      LAST_FRAME_MAX_WIDTH / video.videoWidth,
      LAST_FRAME_MAX_HEIGHT / video.videoHeight,
    );
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = canvasRef.current;
    if (!canvas) return false;
    try {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return false;
      context.drawImage(video, 0, 0, width, height);
      hasSnapshotRef.current = true;
      const now = Date.now();
      snapshotCapturedAtRef.current = Number.isFinite(capturedAt)
        ? Math.min(now, Math.max(0, capturedAt))
        : now;
      return true;
    } catch {
      return false;
    }
  }, [videoRef]);
  const captureBeforeOutage = useCallback((expectedStream, capturedAt = Date.now()) => {
    if (outageExpiredRef.current || statusRef.current === 'fallback') return false;
    return captureSnapshot({ expectedStream, allowInactiveTrack: true, capturedAt });
  }, [captureSnapshot]);
  const captureAndRecover = useCallback((capturedAt = Date.now()) => {
    if (!captureSnapshot({ capturedAt })) return false;
    lastProgressAtRef.current = capturedAt;
    if (outageStartedAtRef.current || statusRef.current !== 'healthy') resetOutage(false);
    return true;
  }, [captureSnapshot, resetOutage]);

  useEffect(() => () => {
    clearHoldTimer();
    clearSnapshot();
  }, [clearHoldTimer, clearSnapshot]);
  useEffect(() => {
    if (holdStatus === 'fallback') clearSnapshot();
  }, [clearSnapshot, holdStatus]);
  useEffect(() => {
    const previous = previousStreamRef.current;
    previousStreamRef.current = stream;
    if (enabled && (!stream || (previous && previous !== stream))) {
      const observedAt = Date.now();
      const lastFrameAt = lastProgressAtRef.current || snapshotCapturedAtRef.current || observedAt;
      if (previous) captureBeforeOutage(previous, lastFrameAt);
      beginOutage(lastFrameAt);
    }
  }, [beginOutage, captureBeforeOutage, enabled, stream]);
  useEffect(() => {
    if (!enabled) {
      resetOutage(true);
      return;
    }
    if (outageHint) {
      const observedAt = Date.now();
      const lastFrameAt = lastProgressAtRef.current || snapshotCapturedAtRef.current || observedAt;
      captureBeforeOutage(stream, lastFrameAt);
      beginOutage(lastFrameAt);
    }
  }, [beginOutage, captureBeforeOutage, enabled, outageHint, resetOutage, stream]);
  useEffect(() => {
    if (!enabled) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let lastProgressCheckAt = 0;
    const fail = () => {
      const observedAt = Date.now();
      const lastFrameAt = lastProgressAtRef.current || snapshotCapturedAtRef.current || observedAt;
      captureBeforeOutage(stream, lastFrameAt);
      beginOutage(lastFrameAt);
    };
    const recover = () => captureAndRecover(Date.now());
    const noteProgress = () => {
      const now = Date.now();
      if (now - lastProgressCheckAt < 200) return;
      lastProgressCheckAt = now;
      const currentStream = streamRef.current;
      const currentTrack = currentStream?.getVideoTracks?.()[0] || null;
      if (video.srcObject === currentStream && currentTrack?.readyState === 'live' &&
          !currentTrack.muted && currentTrack.enabled && video.readyState >= 2 &&
          !video.paused && !video.ended) {
        const mediaTime = Number(video.currentTime);
        let decodedFrames = Number.NaN;
        try {
          decodedFrames = Number(video.getVideoPlaybackQuality?.().totalVideoFrames);
        } catch { /* currentTime fallback below */ }
        if (!Number.isFinite(decodedFrames)) decodedFrames = Number(video.webkitDecodedFrameCount);
        if (progressStreamRef.current !== currentStream) {
          progressStreamRef.current = currentStream;
          progressMediaTimeRef.current = Number.NaN;
          progressDecodedFramesRef.current = Number.NaN;
        }
        const hasFrameCounter = Number.isFinite(decodedFrames);
        const progressed = hasFrameCounter
          ? (Number.isFinite(progressDecodedFramesRef.current) &&
            decodedFrames > progressDecodedFramesRef.current)
          : (Number.isFinite(progressMediaTimeRef.current) && Number.isFinite(mediaTime) &&
            mediaTime > progressMediaTimeRef.current + 0.01);
        progressMediaTimeRef.current = mediaTime;
        progressDecodedFramesRef.current = decodedFrames;
        if (progressed) lastProgressAtRef.current = now;
      }
    };
    const failureEvents = ['waiting', 'stalled', 'emptied', 'abort', 'error', 'ended', 'pause'];
    const recoveryEvents = ['loadeddata'];
    failureEvents.forEach(name => video.addEventListener(name, fail));
    recoveryEvents.forEach(name => video.addEventListener(name, recover));
    video.addEventListener('timeupdate', noteProgress);

    const track = stream?.getVideoTracks?.()[0] || null;
    const unmute = () => { video.play().catch(() => {}); };
    track?.addEventListener('mute', fail);
    track?.addEventListener('ended', fail);
    track?.addEventListener('unmute', unmute);
    stream?.addEventListener?.('addtrack', fail);
    stream?.addEventListener?.('removetrack', fail);
    return () => {
      failureEvents.forEach(name => video.removeEventListener(name, fail));
      recoveryEvents.forEach(name => video.removeEventListener(name, recover));
      video.removeEventListener('timeupdate', noteProgress);
      track?.removeEventListener('mute', fail);
      track?.removeEventListener('ended', fail);
      track?.removeEventListener('unmute', unmute);
      stream?.removeEventListener?.('addtrack', fail);
      stream?.removeEventListener?.('removetrack', fail);
    };
  }, [beginOutage, captureAndRecover, captureBeforeOutage, enabled, stream, videoRef]);
  useEffect(() => {
    if (!enabled) return undefined;
    let lastMediaTime = Number.NaN;
    let lastDecodedFrames = Number.NaN;
    if (!lastProgressAtRef.current) lastProgressAtRef.current = Date.now();
    const inspect = () => {
      if (!enabledRef.current || document.hidden) return;
      if (outageHintRef.current) {
        beginOutage(outageStartedAtRef.current || lastProgressAtRef.current);
        return;
      }
      const now = Date.now();
      const video = videoRef.current;
      const currentStream = streamRef.current;
      const track = currentStream?.getVideoTracks?.()[0] || null;
      if (!video || !currentStream || video.srcObject !== currentStream ||
          !track || track.readyState !== 'live' || track.muted || !track.enabled ||
          video.readyState < 2 || video.ended) {
        const lastFrameAt = lastProgressAtRef.current || snapshotCapturedAtRef.current || now;
        captureBeforeOutage(currentStream, lastFrameAt);
        beginOutage(lastFrameAt);
        return;
      }
      const mediaTime = Number(video.currentTime);
      let decodedFrames = Number.NaN;
      try {
        decodedFrames = Number(video.getVideoPlaybackQuality?.().totalVideoFrames);
      } catch { /* currentTime fallback below */ }
      if (!Number.isFinite(decodedFrames)) decodedFrames = Number(video.webkitDecodedFrameCount);
      const hasFrameCounter = Number.isFinite(decodedFrames);
      const hasBaseline = hasFrameCounter
        ? Number.isFinite(lastDecodedFrames)
        : Number.isFinite(lastMediaTime);
      const progressed = hasFrameCounter
        ? (hasBaseline && decodedFrames > lastDecodedFrames)
        : (hasBaseline && Number.isFinite(mediaTime) && mediaTime > lastMediaTime + 0.01);
      lastMediaTime = mediaTime;
      lastDecodedFrames = decodedFrames;
      if (!hasBaseline) {
        lastProgressAtRef.current = now;
        return;
      }
      if (progressed) {
        captureAndRecover(now);
      } else if (video.paused || now - lastProgressAtRef.current >= LAST_FRAME_STALL_GRACE_MS) {
        const lastFrameAt = lastProgressAtRef.current || snapshotCapturedAtRef.current || now;
        captureBeforeOutage(currentStream, lastFrameAt);
        beginOutage(lastFrameAt);
      }
    };
    inspect();
    const id = setInterval(inspect, LAST_FRAME_SAMPLE_MS);
    return () => clearInterval(id);
  }, [beginOutage, captureAndRecover, captureBeforeOutage, enabled, stream, videoRef]);

  useEffect(() => {
    const checkDeadline = () => {
      if (!document.hidden && statusRef.current === 'holding') {
        beginOutage(outageStartedAtRef.current || Date.now());
      }
    };
    document.addEventListener('visibilitychange', checkDeadline);
    return () => document.removeEventListener('visibilitychange', checkDeadline);
  }, [beginOutage]);

  return {
    canvasRef,
    holdingLastFrame: holdStatus === 'holding',
    lastFrameFallback: holdStatus === 'fallback',
  };
}

const VideoCell = React.memo(function VideoCell({
  label, stream, videoPaused, audioPaused, speakerDeviceId, speakerMuted, reconnecting = false,
}) {
  const videoRef = useRef(null);
  const {
    canvasRef: lastFrameCanvasRef,
    holdingLastFrame,
    lastFrameFallback,
  } = useLastFrameHold({
    videoRef,
    stream,
    enabled: !videoPaused,
    outageHint: reconnecting,
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let removeRetryListeners = () => {};

    video.muted = !!(speakerMuted || audioPaused);
    if (video.srcObject !== stream) video.srcObject = stream || null;
    if (!stream) return;

    const play = () => {
      const promise = video.play();
      if (promise?.catch) {
        promise.catch(() => {
          if (disposed) return;
          const retry = () => {
            video.play().catch(() => {});
            removeRetryListeners();
          };
          removeRetryListeners = () => {
            document.removeEventListener('click', retry);
            document.removeEventListener('keydown', retry);
          };
          document.addEventListener('click', retry, { once: true });
          document.addEventListener('keydown', retry, { once: true });
        });
      }
    };

    play();
    return () => {
      disposed = true;
      removeRetryListeners();
    };
  }, [stream, speakerMuted, audioPaused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (speakerDeviceId && typeof video.setSinkId === 'function') {
      video.setSinkId(speakerDeviceId).catch(() => {});
    }
  }, [speakerDeviceId]);

  const cameraOff = !!videoPaused || !stream?.getVideoTracks().length || lastFrameFallback;

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

      <canvas
        ref={lastFrameCanvasRef}
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, zIndex: 5,
          width: '100%', height: '100%', objectFit: 'contain',
          background: '#000', display: holdingLastFrame ? 'block' : 'none',
          pointerEvents: 'none',
        }}
      />
      {holdingLastFrame && (
        <div style={{
          position: 'absolute', top: 8, right: 8, zIndex: 6,
          padding: '3px 7px', borderRadius: 4,
          color: 'rgba(255,255,255,0.78)', background: 'rgba(0,0,0,0.55)',
          fontSize: '0.65rem', pointerEvents: 'none',
        }}>
          映像復旧待機中（最終映像）
        </div>
      )}

      {cameraOff && !holdingLastFrame && (
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

  const managerRef = useRef(null);
  const configRef = useRef({});
  const selectedAudioOutIdRef = useRef('');
  const telemetryStateRef = useRef({});
  const adminHandlersRef = useRef({});
  const quickRestartInFlightRef = useRef(false);
  const quickRestartHandlerRef = useRef(null);
  const serverProbeInFlightRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const sessionStartInFlightRef = useRef(null);
  const disposedRef = useRef(false);

  const channels = Array.isArray(systemState.channels) && systemState.channels.length
    ? systemState.channels
    : DEFAULT_SYSTEM_STATE.channels;
  const updatePackage = systemState.updatePackages?.[APP_TYPE] || null;
  const latestVersion = systemState.latestVersions?.[APP_TYPE] || APP_VERSION;
  const updateAvailable = isNewerVersion(latestVersion, APP_VERSION);

  const refreshAudioOutputs = useCallback(async (preferredId = null, options = {}) => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(device => device.kind === 'audiooutput');
      if (options.isCurrent && !options.isCurrent()) return outputs;
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
    // 進行中の初期化も無効化し、後から完了した古い接続が
    // managerRef や React state を上書きしないようにする。
    sessionGenerationRef.current += 1;
    sessionStartInFlightRef.current = null;
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

  const startViewerSession = useCallback(() => {
    if (disposedRef.current) {
      return Promise.resolve({ manager: null, connectionState: 'disposed' });
    }
    if (sessionStartInFlightRef.current) return sessionStartInFlightRef.current.promise;

    // この関数が直接再実行された場合も、1端末1socketを保つ。
    if (managerRef.current) releaseViewerRuntime({ updateState: false });
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    const isCurrent = () => !disposedRef.current && sessionGenerationRef.current === generation;
    const startEntry = { generation, promise: null };

    const startPromise = (async () => {
      const config = loadViewerConfig();
      configRef.current = config;
      selectedAudioOutIdRef.current = config.selectedAudioOutId || '';
      if (isCurrent()) setSelectedAudioOutId(config.selectedAudioOutId || '');

      await refreshAudioOutputs(config.selectedAudioOutId || '', { isCurrent });
      if (!isCurrent()) return { manager: null, connectionState: 'superseded' };

      const manager = new ViewerWebRTCManager();
      managerRef.current = manager;
      const isManagerCurrent = () => isCurrent() && managerRef.current === manager;

      manager.onPeerUpdated = (socketId, peer) => {
        if (!isManagerCurrent()) return;
        setPeers(prev => {
          const next = new Map(prev);
          next.set(socketId, peer);
          return next;
        });
      };
      manager.onPeerRemoved = (socketId) => {
        if (!isManagerCurrent()) return;
        setPeers(prev => {
          const next = new Map(prev);
          next.delete(socketId);
          return next;
        });
      };
      manager.onConnectionChange = (ok) => {
        if (isManagerCurrent()) setStatus(ok ? 'connected' : 'error');
      };
      manager.onSystemStateUpdated = (state = {}) => {
        if (isManagerCurrent()) setSystemState({ ...DEFAULT_SYSTEM_STATE, ...state });
      };
      manager.onUpdateCommand = (payload) => {
        if (!isManagerCurrent()) return;
        if (payload?.appType && payload.appType !== APP_TYPE && payload.appType !== 'all') return;
        setUpdateNotice(payload);
      };
      manager.onRestartCommand = (payload) => {
        if (isManagerCurrent()) quickRestartHandlerRef.current?.(payload);
      };
      manager.onAdminSetDevice = (payload) => {
        if (!isManagerCurrent() || !adminHandlersRef.current.setDevice) throw new Error('device control is not ready');
        return adminHandlersRef.current.setDevice(payload);
      };
      manager.onAdminSetMediaState = (payload) => {
        if (!isManagerCurrent() || !adminHandlersRef.current.setMediaState) throw new Error('media state control is not ready');
        return adminHandlersRef.current.setMediaState(payload);
      };
      manager.onAdminRefreshDevices = () => {
        if (!isManagerCurrent() || !adminHandlersRef.current.refreshDevices) throw new Error('device refresh is not ready');
        return adminHandlersRef.current.refreshDevices();
      };

      const serverUrl = serverUrlFromViewerConfig(config);
      let connectionState;
      try {
        connectionState = await connectWithinStartupWindow(manager, serverUrl, config.viewerName, {
          appVersion: APP_VERSION,
          authToken: config.authToken,
        });
      } catch (err) {
        if (!isManagerCurrent()) {
          manager.disconnect();
          return { manager: null, connectionState: 'superseded' };
        }
        throw err;
      }
      if (!isManagerCurrent()) {
        manager.disconnect();
        return { manager: null, connectionState: 'superseded' };
      }
      setStatus(connectionState === 'connected' ? 'connected' : 'connecting');
      setError(null);
      return { manager, connectionState };
    })();

    startEntry.promise = startPromise;
    sessionStartInFlightRef.current = startEntry;
    return startPromise.finally(() => {
      if (sessionStartInFlightRef.current === startEntry) sessionStartInFlightRef.current = null;
    });
  }, [refreshAudioOutputs, releaseViewerRuntime]);

  const performQuickRestart = useCallback(async (payload = {}) => {
    if (disposedRef.current || quickRestartInFlightRef.current) return;
    quickRestartInFlightRef.current = true;
    const startedAt = Date.now();
    const reason = payload?.reason || payload?.source || 'server-command';

    try {
      releaseViewerRuntime({ status: 'restarting' });
      setError(null);
      setUiResetToken(token => token + 1);
      // requestAnimationFrame は最小化・遮蔽中に停止するため、必ず進む
      // タイマーで描画機会を一度譲ってから再構築する。
      await new Promise(resolve => setTimeout(resolve, 50));
      if (disposedRef.current) return;
      const { connectionState } = await startViewerSession();
      if (disposedRef.current || connectionState === 'superseded' || connectionState === 'disposed') return;
      window.electronAPI?.quickRestartResult?.({
        ok: true,
        reason,
        connectionState,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (disposedRef.current) return;
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
    disposedRef.current = false;
    const handleDeviceChange = () => refreshAudioOutputs();
    const init = async () => {
      try {
        await startViewerSession();
      } catch (err) {
        if (disposedRef.current) return;
        console.error('[Viewer]', err);
        setStatus('error');
        setError(err.message);
      }
    };

    init();
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);

    return () => {
      disposedRef.current = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
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
        if (disposedRef.current) return;
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
        if (!disposedRef.current) console.warn('[ViewerServerProbe]', err.message);
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
      previous.authToken !== merged.authToken ||
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
    const url = updateNotice?.packageInfo?.url || updatePackage?.url;
    if (!url) return;
    window.electronAPI?.openExternal?.(url);
  }, [updateNotice, updatePackage]);

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
              disabled={!updatePackage?.url && !updateNotice?.packageInfo?.url}
              title="アップデート"
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
              <div className="field">
                <label>接続トークン</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={settingsDraft.authToken || ''}
                  onChange={event => updateSettingsDraft('authToken', event.target.value)}
                  placeholder="サーバーの SFU_AUTH_TOKEN"
                />
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
              reconnecting={status !== 'connected'}
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
              reconnecting={status !== 'connected'}
            />
          ))}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
