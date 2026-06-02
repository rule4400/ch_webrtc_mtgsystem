/**
 * MainView.jsx
 *
 * 設計:
 *   - 起動時に自動でカメラ取得 → SFU 接続
 *   - 1秒ごとにサーバーからピア状態を取得し同期
 *   - ミュート/カメラ/スピーカーボタンにデバイス選択ドロップダウン
 *   - ビデオセルは常に <video> 要素をレンダリング（可視性だけ CSS で制御）
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Mic, MicOff, Video, VideoOff,
  Volume2, VolumeX, Settings, ChevronDown, X,
} from 'lucide-react';
import { WebRTCManager } from '../services/webrtc';

// ─── デバイス選択ドロップダウンボタン ────────────────────

function DeviceButton({ active, onToggle, Icon, IconOff, devices, selectedId, onDeviceChange, title }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // 外クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="device-btn-group" ref={wrapRef} title={title}>
      {/* メインボタン（ミュートトグル） */}
      <button className={`ctrl-btn ${!active ? 'danger' : ''}`} onClick={onToggle}>
        {active ? <Icon size={20} /> : <IconOff size={20} />}
      </button>
      {/* デバイス選択トリガー */}
      {devices.length > 0 && (
        <button
          className={`chevron-btn ${!active ? 'danger' : ''}`}
          onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        >
          <ChevronDown size={12} />
        </button>
      )}
      {/* ドロップダウンメニュー */}
      {open && (
        <div className="device-menu">
          {devices.map(d => (
            <button
              key={d.deviceId}
              className={`device-item ${d.deviceId === selectedId ? 'active' : ''}`}
              onClick={() => { onDeviceChange(d.deviceId); setOpen(false); }}
            >
              {d.label || '（名前なし）'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ビデオセル ───────────────────────────────────────────

const VideoCell = React.memo(function VideoCell({
  label, stream, isSelf, videoPaused, audioPaused, speakerDeviceId, speakerMuted, volume = 1,
}) {
  const videoRef = useRef(null);

  // stream が変わったら srcObject を更新して再生
  // 重要: muted は React 属性だと DOM プロパティに反映されない既知問題があり、
  // 音声付きストリームの autoplay がブロックされて黒画面になる。必ず命令的に設定する。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // 自拠点プレビューは常にミュート（ハウリング防止）。他拠点は speakerMuted に従う。
    video.muted = isSelf ? true : !!speakerMuted;
    video.volume = isSelf || speakerMuted ? 0 : volume;
    if (video.srcObject !== stream) {
      video.srcObject = stream || null;
    }
    if (!stream) return;

    const tryPlay = () => {
      const p = video.play();
      if (p && p.catch) {
        p.catch((err) => {
          console.warn('play():', err.message);
          // autoplay がブロックされた場合は次のユーザー操作で再試行
          const resume = () => { video.play().catch(() => {}); cleanup(); };
          const cleanup = () => {
            document.removeEventListener('click', resume);
            document.removeEventListener('keydown', resume);
          };
          document.addEventListener('click', resume, { once: true });
          document.addEventListener('keydown', resume, { once: true });
        });
      }
    };
    tryPlay();
  }, [stream, isSelf, speakerMuted, volume]);

  // スピーカーデバイス変更
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isSelf) return;
    if (speakerDeviceId && typeof video.setSinkId === 'function') {
      video.setSinkId(speakerDeviceId).catch(() => {});
    }
  }, [speakerDeviceId, isSelf]);

  const cameraOff = !!videoPaused;

  return (
    <div
      className="video-cell"
      style={{ outline: isSelf ? '2px solid #4ade80' : '2px solid rgba(255,255,255,0.08)' }}
    >
      {/* 常に video 要素を置く（display で可視性を制御） */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isSelf}
        style={{
          width: '100%', height: '100%',
          objectFit: 'contain',
          transform: isSelf ? 'scaleX(-1)' : 'none',
          background: '#000',
          display: cameraOff ? 'none' : 'block',
        }}
      />

      {/* カメラ OFF オーバーレイ */}
      {cameraOff && (
        <div className="cam-off-overlay">
          <VideoOff size={30} color="rgba(255,255,255,0.3)" />
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem', marginTop: 8 }}>
            カメラ OFF
          </span>
        </div>
      )}

      {/* 拠点名ラベル */}
      <div className="cell-label">
        {isSelf && <span className="self-dot" />}
        {audioPaused && <MicOff size={11} color="#ef4444" style={{ flexShrink: 0 }} />}
        <span>{label}</span>
        {isSelf && <span style={{ opacity: 0.5, marginLeft: 3, flexShrink: 0 }}>（自拠点）</span>}
      </div>

      {/* マイクOFF バッジ */}
      {audioPaused && (
        <div className="mute-badge">
          <MicOff size={12} color="white" />
        </div>
      )}
    </div>
  );
});

// ─── 堅牢なメディア取得 ───────────────────────────────────
// exact 制約は OverconstrainedError で落ちやすいので、段階的にフォールバックする。
// 戻り値: { stream, error } — stream が null でも error メッセージを返す。
async function acquireMedia({ videoId, audioId, wantVideo = true, wantAudio = true }) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: null, error: 'この環境ではカメラ/マイクAPI（getUserMedia）が利用できません。' };
  }

  const videoBase = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  const audioBase = {
    echoCancellation: { ideal: true },
    voiceIsolation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    googEchoCancellation: true,
    googAutoGainControl: true,
    googNoiseSuppression: true,
    googHighpassFilter: true,
  };

  // 試行リスト: ①指定デバイス(exact) → ②指定デバイス(ideal) → ③デバイス無指定
  const buildConstraints = (mode) => {
    const c = {};
    if (wantVideo) {
      c.video = { ...videoBase };
      if (videoId && mode === 'exact') c.video.deviceId = { exact: videoId };
      else if (videoId && mode === 'ideal') c.video.deviceId = { ideal: videoId };
    }
    if (wantAudio) {
      c.audio = { ...audioBase };
      if (audioId && mode === 'exact') c.audio.deviceId = { exact: audioId };
      else if (audioId && mode === 'ideal') c.audio.deviceId = { ideal: audioId };
    }
    return c;
  };

  const attempts = ['exact', 'ideal', 'any'];
  let lastErr = null;
  for (const mode of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildConstraints(mode));
      return { stream, error: null };
    } catch (err) {
      lastErr = err;
      // 権限拒否・デバイス未検出は段階フォールバックしても無駄なので即抜ける
      if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') break;
    }
  }

  // 映像+音声で失敗 → 片方ずつ救済（カメラ不可でもマイクだけは通す等）
  if (wantVideo && wantAudio) {
    const videoOnly = await acquireMedia({ videoId, audioId, wantVideo: true, wantAudio: false });
    if (videoOnly.stream) return { stream: videoOnly.stream, error: 'マイクを取得できませんでした（映像のみ）。' };
    const audioOnly = await acquireMedia({ videoId, audioId, wantVideo: false, wantAudio: true });
    if (audioOnly.stream) return { stream: audioOnly.stream, error: 'カメラを取得できませんでした（音声のみ）。' };
  }

  const msg =
    lastErr?.name === 'NotAllowedError' ? 'カメラ・マイクの使用が拒否されました。システム設定（プライバシー）でこのアプリに権限を許可してください。' :
    lastErr?.name === 'NotFoundError'   ? 'カメラまたはマイクが見つかりません。接続を確認してください。' :
    lastErr?.name === 'NotReadableError'? 'カメラ/マイクが他のアプリに使用されています。他のアプリを閉じて再起動してください。' :
    `カメラ・マイク取得に失敗しました: ${lastErr?.name || lastErr?.message || '不明なエラー'}`;
  return { stream: null, error: msg };
}

const SPEAKER_AUDIO_PROFILE = {
  maxRemoteVolume: 0.86,
  minRemoteVolume: 0.42,
  localTalkDucking: 0.72,
  localTalkFloor: 0.32,
  localSpeechThreshold: 0.025,
  localSpeechHoldMs: 650,
  monitorFpsMs: 80,
};

function calculateRemoteAudioVolume({ audiblePeerCount, localSpeaking, speakerMuted }) {
  if (speakerMuted || audiblePeerCount <= 0) return 0;

  const countAdjustedVolume = SPEAKER_AUDIO_PROFILE.maxRemoteVolume / Math.sqrt(audiblePeerCount);
  const roomSafeVolume = Math.max(
    SPEAKER_AUDIO_PROFILE.minRemoteVolume,
    Math.min(SPEAKER_AUDIO_PROFILE.maxRemoteVolume, countAdjustedVolume),
  );

  if (!localSpeaking) return roomSafeVolume;
  return Math.max(
    SPEAKER_AUDIO_PROFILE.localTalkFloor,
    roomSafeVolume * SPEAKER_AUDIO_PROFILE.localTalkDucking,
  );
}

// ─── グリッド列数 ─────────────────────────────────────────
function getGridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

const VIDEO_ASPECT = 16 / 9;
const GRID_GAP_PX = 8;

function calculateGridLayout(cellCount, width, height) {
  const count = Math.max(1, cellCount);
  const availableWidth = Math.max(1, width);
  const availableHeight = Math.max(1, height);
  let best = {
    cols: getGridCols(count),
    rows: Math.ceil(count / getGridCols(count)),
    cellWidth: 1,
    cellHeight: 1,
    score: 0,
  };

  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const totalGapX = GRID_GAP_PX * (cols - 1);
    const totalGapY = GRID_GAP_PX * (rows - 1);
    const maxCellWidth = (availableWidth - totalGapX) / cols;
    const maxCellHeight = (availableHeight - totalGapY) / rows;
    if (maxCellWidth <= 0 || maxCellHeight <= 0) continue;

    const cellWidth = Math.min(maxCellWidth, maxCellHeight * VIDEO_ASPECT);
    const cellHeight = cellWidth / VIDEO_ASPECT;
    const score = cellWidth * cellHeight;
    const usesFewerRows = score === best.score && rows < best.rows;

    if (score > best.score || usesFewerRows) {
      best = { cols, rows, cellWidth, cellHeight, score };
    }
  }

  return {
    cols: best.cols,
    rows: best.rows,
    cellWidth: Math.floor(best.cellWidth),
    cellHeight: Math.floor(best.cellHeight),
  };
}

function useFittedVideoGrid(cellCount) {
  const gridRef = useRef(null);
  const [layout, setLayout] = useState(() => {
    const cols = getGridCols(cellCount);
    return { cols, rows: Math.ceil(Math.max(1, cellCount) / cols), cellWidth: 0, cellHeight: 0 };
  });

  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) return undefined;

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const next = calculateGridLayout(cellCount, rect.width, rect.height);
        setLayout(prev => (
          prev.cols === next.cols &&
          prev.rows === next.rows &&
          prev.cellWidth === next.cellWidth &&
          prev.cellHeight === next.cellHeight
            ? prev
            : next
        ));
      });
    };

    update();

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
    };
  }, [cellCount]);

  return { gridRef, layout };
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

const defaultClientConfig = {
  serverIp: '127.0.0.1',
  serverPort: '3000',
  locationName: '自拠点',
};
const QUICK_RESTART_CONNECT_WINDOW_MS = 5000;

async function connectWithinStartupWindow(manager, serverUrl, locationName) {
  let timedOut = false;
  const connectPromise = manager.connect(serverUrl, locationName)
    .then(() => 'connected')
    .catch((err) => {
      if (timedOut) {
        console.warn('[QuickRestart] connection failed after startup window:', err.message);
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

function sanitizeClientConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const serverIp = String(raw.serverIp || defaultClientConfig.serverIp).trim() || defaultClientConfig.serverIp;
  const rawPort = String(raw.serverPort || defaultClientConfig.serverPort).trim();
  const serverPort = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535
    ? rawPort
    : defaultClientConfig.serverPort;
  const locationName = String(raw.locationName || defaultClientConfig.locationName).trim() || defaultClientConfig.locationName;

  return {
    ...raw,
    serverIp,
    serverPort,
    locationName,
  };
}

function loadClientConfig() {
  const saved = localStorage.getItem('sfu_config');
  if (!saved) return defaultClientConfig;

  try {
    return sanitizeClientConfig(JSON.parse(saved));
  } catch (err) {
    console.warn('[Config] invalid sfu_config ignored:', err.message);
    localStorage.removeItem('sfu_config');
    return defaultClientConfig;
  }
}

function serverUrlFromConfig(config) {
  const conf = sanitizeClientConfig(config);
  return `http://${conf.serverIp}:${conf.serverPort || 3000}`;
}

async function probeServerReady(config, timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseUrl = serverUrlFromConfig(config);

  try {
    const ready = await fetch(`${baseUrl}/ready`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (ready.ok) return true;
  } catch {
    // 古いサーバーや起動直後は /ready が返らないことがあるので /health も見る。
  } finally {
    clearTimeout(timer);
  }

  const fallbackController = new AbortController();
  const fallbackTimer = setTimeout(() => fallbackController.abort(), timeoutMs);
  try {
    const health = await fetch(`${baseUrl}/health`, {
      signal: fallbackController.signal,
      cache: 'no-store',
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(fallbackTimer);
  }
}

// ─── メインビュー ─────────────────────────────────────────
export default function MainView() {
  // ── 映像/音声状態 ──
  const [localStream,  setLocalStream]  = useState(null);
  const [micEnabled,   setMicEnabled]   = useState(true);
  const [camEnabled,   setCamEnabled]   = useState(true);
  const [speakerMuted, setSpeakerMuted] = useState(false);

  // ── デバイス一覧 ──
  const [videoDevices,   setVideoDevices]   = useState([]);
  const [audioInDevices, setAudioInDevices] = useState([]);
  const [audioOutDevices, setAudioOutDevices] = useState([]);
  const [selectedVideoId,    setSelectedVideoId]    = useState('');
  const [selectedAudioInId,  setSelectedAudioInId]  = useState('');
  const [selectedAudioOutId, setSelectedAudioOutId] = useState('');

  // ── SFU / ピア状態 ──
  const [peers,      setPeers]      = useState(new Map());
  const [sfuStatus,  setSfuStatus]  = useState('connecting');
  const [selfName,   setSelfName]   = useState('自拠点');
  const [camError,   setCamError]   = useState(null);
  const [viewerPresenceActive, setViewerPresenceActive] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [uiResetToken, setUiResetToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(() => sanitizeClientConfig(loadClientConfig()));

  // refs（クリーンアップ・デバイス変更用）
  const webrtcRef = useRef(null);
  const streamRef = useRef(null);
  const configRef = useRef({});
  const mediaRecoveryRef = useRef(false);
  const telemetryStateRef = useRef({});
  const adminHandlersRef = useRef({});
  const audioMonitorRef = useRef({});
  const softRestartInFlightRef = useRef(false);
  const softRestartHandlerRef = useRef(null);
  const serverProbeInFlightRef = useRef(false);

  const audiblePeerCount = useMemo(() => (
    Array.from(peers.values()).filter((peer) => {
      const audio = peer.stream?.getAudioTracks()[0] || null;
      return !!audio && audio.readyState === 'live' && !peer.audioPaused;
    }).length
  ), [peers]);

  const remoteAudioVolume = useMemo(() => calculateRemoteAudioVolume({
    audiblePeerCount,
    localSpeaking,
    speakerMuted,
  }), [audiblePeerCount, localSpeaking, speakerMuted]);

  const stopLocalAudioMonitor = useCallback(() => {
    const monitor = audioMonitorRef.current;
    if (monitor.frame) cancelAnimationFrame(monitor.frame);
    if (monitor.track && monitor.onEnded) monitor.track.removeEventListener('ended', monitor.onEnded);
    try {
      monitor.source?.disconnect();
    } catch {
      // すでに切断済みなら何もしない
    }
    if (monitor.context && monitor.context.state !== 'closed') {
      monitor.context.close().catch(() => {});
    }
    audioMonitorRef.current = {};
    setLocalSpeaking(false);
  }, []);

  const startLocalAudioMonitor = useCallback((stream) => {
    stopLocalAudioMonitor();

    const track = stream?.getAudioTracks()[0] || null;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!track || !AudioContextClass) return;

    try {
      const audioOnlyStream = new MediaStream([track]);
      const context = new AudioContextClass();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;

      const source = context.createMediaStreamSource(audioOnlyStream);
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      const monitor = {
        analyser,
        context,
        source,
        track,
        frame: 0,
        lastSpeechAt: Number.NEGATIVE_INFINITY,
        lastSampleAt: 0,
        resumePending: false,
        onEnded: () => stopLocalAudioMonitor(),
      };
      audioMonitorRef.current = monitor;
      track.addEventListener('ended', monitor.onEnded, { once: true });

      const tick = (now) => {
        if (audioMonitorRef.current !== monitor) return;

        if (context.state === 'suspended' && !monitor.resumePending) {
          monitor.resumePending = true;
          context.resume()
            .catch(() => {})
            .finally(() => { monitor.resumePending = false; });
        }

        if (now - monitor.lastSampleAt >= SPEAKER_AUDIO_PROFILE.monitorFpsMs) {
          analyser.getByteTimeDomainData(samples);
          let sumSquares = 0;
          for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            sumSquares += normalized * normalized;
          }
          const rms = Math.sqrt(sumSquares / samples.length);
          if (rms >= SPEAKER_AUDIO_PROFILE.localSpeechThreshold) {
            monitor.lastSpeechAt = now;
          }
          const speaking = now - monitor.lastSpeechAt <= SPEAKER_AUDIO_PROFILE.localSpeechHoldMs;
          setLocalSpeaking(prev => (prev === speaking ? prev : speaking));
          monitor.lastSampleAt = now;
        }

        monitor.frame = requestAnimationFrame(tick);
      };

      monitor.frame = requestAnimationFrame(tick);
    } catch (err) {
      console.warn('[audioMonitor]', err.message);
      stopLocalAudioMonitor();
    }
  }, [stopLocalAudioMonitor]);

  useEffect(() => {
    telemetryStateRef.current = {
      videoDevices,
      audioInDevices,
      audioOutDevices,
      selectedVideoId,
      selectedAudioInId,
      selectedAudioOutId,
      micEnabled,
      camEnabled,
      speakerMuted,
      peers,
      sfuStatus,
      selfName,
      camError,
      localSpeaking,
      audiblePeerCount,
      remoteAudioVolume,
    };
  }, [
    videoDevices,
    audioInDevices,
    audioOutDevices,
    selectedVideoId,
    selectedAudioInId,
    selectedAudioOutId,
    micEnabled,
    camEnabled,
    speakerMuted,
    peers,
    sfuStatus,
    selfName,
    camError,
    localSpeaking,
    audiblePeerCount,
    remoteAudioVolume,
  ]);

  // ─── デバイス一覧を取得 ──────────────────────────────────
  const refreshDevices = useCallback(async () => {
    try {
      const devs     = await navigator.mediaDevices.enumerateDevices();
      const video    = devs.filter(d => d.kind === 'videoinput');
      const audioIn  = devs.filter(d => d.kind === 'audioinput');
      const audioOut = devs.filter(d => d.kind === 'audiooutput');
      setVideoDevices(video);
      setAudioInDevices(audioIn);
      setAudioOutDevices(audioOut);
      return { video, audioIn, audioOut };
    } catch {
      return { video: [], audioIn: [], audioOut: [] };
    }
  }, []);

  const installLocalStream = useCallback(async (newStream, error, { stopPrevious = true } = {}) => {
    if (!newStream) {
      setCamError(error);
      return false;
    }

    newStream.getVideoTracks().forEach(t => (t.enabled = camEnabled));
    newStream.getAudioTracks().forEach(t => (t.enabled = micEnabled));

    const newVideoTrack = newStream.getVideoTracks()[0] || null;
    const newAudioTrack = newStream.getAudioTracks()[0] || null;
    if (webrtcRef.current) {
      webrtcRef.current.setLocalTracks(newVideoTrack, newAudioTrack);
      if (newVideoTrack) await webrtcRef.current.replaceVideoTrack(newVideoTrack);
      if (newAudioTrack) await webrtcRef.current.replaceAudioTrack(newAudioTrack);
    }

    const oldStream = streamRef.current;
    streamRef.current = newStream;
    setLocalStream(newStream);
    setCamError(error);
    startLocalAudioMonitor(newStream);

    if (stopPrevious && oldStream && oldStream !== newStream) {
      oldStream.getTracks().forEach(t => t.stop());
    }
    return true;
  }, [camEnabled, micEnabled, startLocalAudioMonitor]);

  const recoverLocalMedia = useCallback(async () => {
    if (mediaRecoveryRef.current || softRestartInFlightRef.current) return;
    mediaRecoveryRef.current = true;
    try {
      const conf = configRef.current;
      const videoId = conf.selectedVideoId || selectedVideoId;
      const audioId = conf.selectedAudioInId || selectedAudioInId;
      const { stream, error } = await acquireMedia({ videoId, audioId });
      await installLocalStream(stream, error);
    } finally {
      mediaRecoveryRef.current = false;
    }
  }, [installLocalStream, selectedVideoId, selectedAudioInId]);

  const releaseClientRuntime = useCallback(({ status = 'connecting', updateState = true } = {}) => {
    const manager = webrtcRef.current;
    webrtcRef.current = null;
    if (manager) {
      manager.onPeerUpdated = null;
      manager.onPeerRemoved = null;
      manager.onConnectionChange = null;
      manager.onViewerPresenceChange = null;
      manager.onRestartCommand = null;
      manager.onAdminSetDevice = null;
      manager.onAdminSetMediaState = null;
      manager.onAdminRefreshDevices = null;
      manager.disconnect();
    }

    stopLocalAudioMonitor();
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (updateState) {
      setLocalStream(null);
      setPeers(new Map());
      setViewerPresenceActive(false);
      setSfuStatus(status);
    }
  }, [stopLocalAudioMonitor]);

  const startClientSession = useCallback(async ({ stopPreviousStream = false } = {}) => {
    const conf = sanitizeClientConfig(loadClientConfig());
    configRef.current = conf;
    setSettingsDraft(conf);
    setSelfName(conf.locationName || '自拠点');

    const devs = await refreshDevices();
    const videoId = conf.selectedVideoId   || devs.video[0]?.deviceId    || '';
    const audioId = conf.selectedAudioInId || devs.audioIn[0]?.deviceId  || '';
    const outId   = conf.selectedAudioOutId|| devs.audioOut[0]?.deviceId || '';
    configRef.current = { ...conf, selectedVideoId: videoId, selectedAudioInId: audioId, selectedAudioOutId: outId };
    setSelectedVideoId(videoId);
    setSelectedAudioInId(audioId);
    setSelectedAudioOutId(outId);

    const { stream, error } = await acquireMedia({ videoId, audioId });
    await installLocalStream(stream, error, { stopPrevious: stopPreviousStream });

    const rtcManager = new WebRTCManager();
    webrtcRef.current = rtcManager;

    rtcManager.onPeerUpdated = (socketId, peer) => {
      setPeers(prev => { const m = new Map(prev); m.set(socketId, peer); return m; });
    };
    rtcManager.onPeerRemoved = (socketId) => {
      setPeers(prev => { const m = new Map(prev); m.delete(socketId); return m; });
    };
    rtcManager.onConnectionChange = (ok) => {
      setSfuStatus(ok ? 'connected' : 'error');
      if (!ok) setViewerPresenceActive(false);
    };
    rtcManager.onViewerPresenceChange = setViewerPresenceActive;
    rtcManager.onRestartCommand = (payload) => softRestartHandlerRef.current?.(payload);
    rtcManager.onAdminSetDevice = (payload) => {
      if (!adminHandlersRef.current.setDevice) throw new Error('device control is not ready');
      return adminHandlersRef.current.setDevice(payload);
    };
    rtcManager.onAdminSetMediaState = (payload) => {
      if (!adminHandlersRef.current.setMediaState) throw new Error('media state control is not ready');
      return adminHandlersRef.current.setMediaState(payload);
    };
    rtcManager.onAdminRefreshDevices = () => {
      if (!adminHandlersRef.current.refreshDevices) throw new Error('device refresh is not ready');
      return adminHandlersRef.current.refreshDevices();
    };

    const currentStream = streamRef.current;
    rtcManager.camEnabled = camEnabled;
    rtcManager.micEnabled = micEnabled;
    rtcManager.setLocalTracks(
      currentStream?.getVideoTracks()[0] || null,
      currentStream?.getAudioTracks()[0] || null,
    );

    const serverUrl = serverUrlFromConfig(conf);
    const connectionState = await connectWithinStartupWindow(rtcManager, serverUrl, conf.locationName);
    setSfuStatus(connectionState === 'connected' ? 'connected' : 'connecting');
    return { manager: rtcManager, connectionState };
  }, [camEnabled, micEnabled, installLocalStream, refreshDevices]);

  const performQuickRestart = useCallback(async (payload = {}) => {
    if (softRestartInFlightRef.current) return;
    softRestartInFlightRef.current = true;
    const startedAt = Date.now();
    const reason = payload?.reason || payload?.source || 'server-command';
    console.log(`[QuickRestart] requested reason=${reason}`);

    try {
      releaseClientRuntime({ status: 'restarting' });
      setCamError(null);
      setUiResetToken(token => token + 1);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const { connectionState } = await startClientSession({ stopPreviousStream: false });
      window.electronAPI?.quickRestartResult?.({
        ok: true,
        reason,
        connectionState,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (err) {
      console.error('[QuickRestart] failed:', err);
      setSfuStatus('error');
      setCamError(err.message || 'クイック再起動に失敗しました。');
      window.electronAPI?.quickRestartResult?.({
        ok: false,
        reason,
        error: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      softRestartInFlightRef.current = false;
    }
  }, [releaseClientRuntime, startClientSession]);

  useEffect(() => {
    softRestartHandlerRef.current = performQuickRestart;
  }, [performQuickRestart]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onQuickRestartRequest?.((payload) => {
      softRestartHandlerRef.current?.(payload);
    });
    return () => unsubscribe?.();
  }, []);

  // ─── 初期化 ──────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    const init = async () => {
      try {
        await startClientSession({ stopPreviousStream: false });
      } catch (err) {
        if (disposed) return;
        console.error('[SFU]', err);
        setSfuStatus('error');
      }
    };

    init();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
      releaseClientRuntime({ updateState: false });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 1秒ポーリング ──────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      webrtcRef.current?.syncPeers();
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ─── サーバー到達確認: オフライン復帰を1秒周期で拾う ─────────────
  useEffect(() => {
    const id = setInterval(async () => {
      if (softRestartInFlightRef.current || serverProbeInFlightRef.current) return;
      const manager = webrtcRef.current;
      if (manager?.isSocketConnected() && manager?.isInitialized()) return;

      serverProbeInFlightRef.current = true;
      try {
        const conf = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
        const reachable = await probeServerReady(conf);
        if (!reachable) {
          setSfuStatus(prev => (prev === 'restarting' ? prev : 'error'));
          return;
        }

        setSfuStatus(prev => (prev === 'connected' ? prev : 'connecting'));
        if (manager) {
          manager.requestReconnect();
        } else {
          await startClientSession({ stopPreviousStream: false });
        }
      } catch (err) {
        console.warn('[serverProbe]', err.message);
      } finally {
        serverProbeInFlightRef.current = false;
      }
    }, 1000);

    return () => clearInterval(id);
  }, [startClientSession]);

  // ─── ローカルカメラ/マイク自己復旧 ───────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const stream = streamRef.current;
      const videoTrack = stream?.getVideoTracks()[0] || null;
      const audioTrack = stream?.getAudioTracks()[0] || null;
      const needsVideo = camEnabled && (!videoTrack || videoTrack.readyState === 'ended');
      const needsAudio = micEnabled && (!audioTrack || audioTrack.readyState === 'ended');
      if (needsVideo || needsAudio) recoverLocalMedia().catch(err => console.warn('[recoverLocalMedia]', err.message));
    }, 5000);
    return () => clearInterval(id);
  }, [camEnabled, micEnabled, recoverLocalMedia]);

  // ─── デバイス変更（カメラ/マイク）────────────────────────
  const changeMediaDevice = useCallback(async (type, deviceId) => {
    try {
      const conf = configRef.current;
      const videoId = type === 'video'   ? deviceId : (configRef.current.selectedVideoId   || selectedVideoId);
      const audioId = type === 'audioIn' ? deviceId : (configRef.current.selectedAudioInId || selectedAudioInId);

      const { stream: newStream, error } = await acquireMedia({ videoId, audioId });
      const applied = await installLocalStream(newStream, error);
      if (!applied) return;

      // 設定を保存
      const newConf = { ...conf, selectedVideoId: videoId, selectedAudioInId: audioId };
      configRef.current = newConf;
      localStorage.setItem('sfu_config', JSON.stringify(newConf));

      if (type === 'video')   setSelectedVideoId(deviceId);
      if (type === 'audioIn') setSelectedAudioInId(deviceId);
    } catch (err) {
      console.error('[changeDevice]', err);
    }
  }, [installLocalStream, selectedVideoId, selectedAudioInId]);

  const changeSpeaker = useCallback((deviceId) => {
    setSelectedAudioOutId(deviceId);
    const conf = { ...configRef.current, selectedAudioOutId: deviceId };
    configRef.current = conf;
    localStorage.setItem('sfu_config', JSON.stringify(conf));
  }, []);

  const setCameraEnabled = useCallback(async (enabled) => {
    const next = !!enabled;
    streamRef.current?.getVideoTracks().forEach(t => (t.enabled = next));
    setCamEnabled(next);
    await webrtcRef.current?.setCamEnabled(next);
  }, []);

  const setMicrophoneEnabled = useCallback(async (enabled) => {
    const next = !!enabled;
    streamRef.current?.getAudioTracks().forEach(t => (t.enabled = next));
    setMicEnabled(next);
    await webrtcRef.current?.setMicEnabled(next);
  }, []);

  const setSpeakerOutputEnabled = useCallback((enabled) => {
    setSpeakerMuted(!enabled);
  }, []);

  useEffect(() => {
    adminHandlersRef.current = {
      setDevice: async ({ kind, deviceId }) => {
        if (!deviceId && deviceId !== '') throw new Error('deviceId is required');
        if (kind === 'video') {
          await changeMediaDevice('video', deviceId);
          return { selectedDevices: { video: deviceId } };
        }
        if (kind === 'audioInput') {
          await changeMediaDevice('audioIn', deviceId);
          return { selectedDevices: { audioInput: deviceId } };
        }
        if (kind === 'audioOutput') {
          changeSpeaker(deviceId);
          return { selectedDevices: { audioOutput: deviceId } };
        }
        throw new Error(`unsupported device kind: ${kind}`);
      },
      setMediaState: async ({ kind, enabled }) => {
        if (kind === 'camera') {
          await setCameraEnabled(enabled);
          return { localMedia: { cameraEnabled: !!enabled } };
        }
        if (kind === 'mic') {
          await setMicrophoneEnabled(enabled);
          return { localMedia: { micEnabled: !!enabled } };
        }
        if (kind === 'speaker') {
          setSpeakerOutputEnabled(!!enabled);
          return { localMedia: { speakerMuted: !enabled } };
        }
        throw new Error(`unsupported media kind: ${kind}`);
      },
      refreshDevices: async () => {
        const devices = await refreshDevices();
        return {
          devices: {
            video: serializeDevices(devices.video),
            audioInput: serializeDevices(devices.audioIn),
            audioOutput: serializeDevices(devices.audioOut),
          },
        };
      },
    };
  }, [changeMediaDevice, changeSpeaker, refreshDevices, setCameraEnabled, setMicrophoneEnabled, setSpeakerOutputEnabled]);

  useEffect(() => {
    const sendTelemetry = () => {
      const manager = webrtcRef.current;
      if (!manager) return;
      const state = telemetryStateRef.current;
      const stream = streamRef.current;
      const videoTrack = stream?.getVideoTracks()[0] || null;
      const audioTrack = stream?.getAudioTracks()[0] || null;
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
        appType: 'client',
        locationName: state.selfName,
        status: state.sfuStatus,
        devices: {
          video: serializeDevices(state.videoDevices || []),
          audioInput: serializeDevices(state.audioInDevices || []),
          audioOutput: serializeDevices(state.audioOutDevices || []),
        },
        selectedDevices: {
          video: state.selectedVideoId,
          audioInput: state.selectedAudioInId,
          audioOutput: state.selectedAudioOutId,
        },
        localMedia: {
          cameraEnabled: !!state.camEnabled,
          micEnabled: !!state.micEnabled,
          speakerMuted: !!state.speakerMuted,
          video: trackReport(videoTrack),
          audio: trackReport(audioTrack),
          error: state.camError || null,
          audioProfile: {
            mode: 'speaker-room',
            localSpeaking: !!state.localSpeaking,
            audiblePeerCount: state.audiblePeerCount || 0,
            remoteAudioVolume: Number((state.remoteAudioVolume || 0).toFixed(2)),
          },
        },
        remoteMonitor: {
          peerCount: remotePeers.length,
          receivingVideoCount: remotePeers.filter(peer => peer.receivingVideo).length,
          receivingAudioCount: remotePeers.filter(peer => peer.receivingAudio).length,
          peers: remotePeers,
        },
        connection: {
          appStatus: state.sfuStatus,
        },
      });
    };

    sendTelemetry();
    const id = setInterval(sendTelemetry, 2000);
    return () => clearInterval(id);
  }, []);

  // ─── カメラ ON/OFF ────────────────────────────────────────
  const toggleCam = useCallback(async () => {
    setCameraEnabled(!camEnabled).catch(() => {});
  }, [camEnabled, setCameraEnabled]);

  // ─── マイク ON/OFF ────────────────────────────────────────
  const toggleMic = useCallback(async () => {
    setMicrophoneEnabled(!micEnabled).catch(() => {});
  }, [micEnabled, setMicrophoneEnabled]);

  const openSettingsPanel = useCallback(() => {
    const current = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
    setSettingsDraft(current);
    setSettingsOpen(true);
  }, []);

  const updateSettingsDraft = useCallback((key, value) => {
    setSettingsDraft(prev => ({ ...prev, [key]: value }));
  }, []);

  const saveSettingsDraft = useCallback(async () => {
    const previous = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
    const next = sanitizeClientConfig({ ...configRef.current, ...settingsDraft });
    const requiresReconnect =
      previous.serverIp !== next.serverIp ||
      previous.serverPort !== next.serverPort ||
      previous.locationName !== next.locationName;

    configRef.current = next;
    localStorage.setItem('sfu_config', JSON.stringify(next));
    setSelfName(next.locationName || '自拠点');
    setSettingsDraft(next);
    setSettingsOpen(false);

    if (requiresReconnect) {
      await performQuickRestart({ reason: 'settings-updated' });
    }
  }, [performQuickRestart, settingsDraft]);

  // ─── グリッド ────────────────────────────────────────────
  const totalCells = peers.size + 1;
  const { gridRef, layout: gridLayout } = useFittedVideoGrid(totalCells);

  return (
    <div className="main-layout">

      <div className="floating-status">
        <span className="status-dot" style={{
          background:
            sfuStatus === 'connected'  ? '#4ade80' :
            sfuStatus === 'error'      ? '#ef4444' :
            sfuStatus === 'restarting' ? '#60a5fa' : '#facc15',
        }} />
        {sfuStatus === 'connected'  ? `接続中 ${peers.size + 1}拠点` :
         sfuStatus === 'error'      ? 'サーバー未接続' :
         sfuStatus === 'restarting' ? '再構築中...' : '接続中...'}
      </div>

      {/* ── カメラエラー表示 ── */}
      {camError && (
        <div className="cam-error-bar">⚠ {camError}</div>
      )}

      {/* ── ビデオグリッド ── */}
      <div
        ref={gridRef}
        className="video-grid"
        style={{
          gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, ${gridLayout.cellWidth || 1}px))`,
          gridTemplateRows: `repeat(${gridLayout.rows}, minmax(0, ${gridLayout.cellHeight || 1}px))`,
        }}
      >
        {/* 自拠点 */}
        <VideoCell
          key={`self-${uiResetToken}`}
          label={selfName}
          stream={localStream}
          isSelf={true}
          videoPaused={!camEnabled}
          audioPaused={!micEnabled}
          speakerMuted={false}
        />
        {/* 他拠点 */}
        {Array.from(peers.entries()).map(([socketId, peer]) => (
          <VideoCell
            key={`${uiResetToken}-${socketId}`}
            label={peer.locationName}
            stream={peer.stream}
            isSelf={false}
            videoPaused={peer.videoPaused}
            audioPaused={peer.audioPaused}
            speakerDeviceId={selectedAudioOutId}
            speakerMuted={speakerMuted}
            volume={remoteAudioVolume}
          />
        ))}
      </div>

      {viewerPresenceActive && (
        <div className="viewer-presence-dot" aria-hidden="true" />
      )}

      {/* ── コントロールバー ── */}
      <div className="control-bar">
        {/* マイク */}
        <DeviceButton
          active={micEnabled}
          onToggle={toggleMic}
          Icon={Mic}
          IconOff={MicOff}
          devices={audioInDevices}
          selectedId={selectedAudioInId}
          onDeviceChange={(id) => changeMediaDevice('audioIn', id)}
          title="マイク"
        />

        {/* カメラ */}
        <DeviceButton
          active={camEnabled}
          onToggle={toggleCam}
          Icon={Video}
          IconOff={VideoOff}
          devices={videoDevices}
          selectedId={selectedVideoId}
          onDeviceChange={(id) => changeMediaDevice('video', id)}
          title="カメラ"
        />

        {/* スピーカー */}
        <DeviceButton
          active={!speakerMuted}
          onToggle={() => setSpeakerOutputEnabled(speakerMuted)}
          Icon={Volume2}
          IconOff={VolumeX}
          devices={audioOutDevices}
          selectedId={selectedAudioOutId}
          onDeviceChange={changeSpeaker}
          title="スピーカー"
        />
      </div>

      <button
        className="settings-fab"
        onClick={openSettingsPanel}
        title="設定"
        aria-label="設定"
      >
        <Settings size={18} />
      </button>

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="接続設定">
          <div className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <h1>接続設定</h1>
                <p>この画面を開いている間も通信は継続します</p>
              </div>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="閉じる">
                <X size={18} />
              </button>
            </div>

            <div className="settings-section">
              <h2>基本設定</h2>
              <div className="field">
                <label>拠点名</label>
                <input
                  type="text"
                  value={settingsDraft.locationName}
                  onChange={e => updateSettingsDraft('locationName', e.target.value)}
                  placeholder="例: 東京本社"
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
                    onChange={e => updateSettingsDraft('serverIp', e.target.value)}
                    placeholder="例: 192.168.1.223"
                  />
                </div>
                <div className="field">
                  <label>ポート</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={settingsDraft.serverPort}
                    onChange={e => updateSettingsDraft('serverPort', e.target.value)}
                    placeholder="3000"
                  />
                </div>
              </div>
            </div>

            <button className="btn-join" onClick={saveSettingsDraft}>
              保存して反映
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
