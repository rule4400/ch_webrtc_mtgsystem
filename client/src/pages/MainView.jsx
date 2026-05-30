/**
 * MainView.jsx
 *
 * 設計:
 *   - 起動時に自動でカメラ取得 → SFU 接続
 *   - 1秒ごとにサーバーからピア状態を取得し同期
 *   - ミュート/カメラ/スピーカーボタンにデバイス選択ドロップダウン
 *   - ビデオセルは常に <video> 要素をレンダリング（可視性だけ CSS で制御）
 */

import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mic, MicOff, Video, VideoOff,
  Volume2, VolumeX, Settings, ChevronDown,
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
  label, stream, isSelf, videoPaused, audioPaused, speakerDeviceId, speakerMuted,
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
  }, [stream, isSelf, speakerMuted]);

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
  const audioBase = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

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

// ─── メインビュー ─────────────────────────────────────────
export default function MainView() {
  const navigate = useNavigate();

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

  // refs（クリーンアップ・デバイス変更用）
  const webrtcRef = useRef(null);
  const streamRef = useRef(null);
  const configRef = useRef({});
  const mediaRecoveryRef = useRef(false);
  const telemetryStateRef = useRef({});
  const adminHandlersRef = useRef({});

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

    if (stopPrevious && oldStream && oldStream !== newStream) {
      oldStream.getTracks().forEach(t => t.stop());
    }
    return true;
  }, [camEnabled, micEnabled]);

  const recoverLocalMedia = useCallback(async () => {
    if (mediaRecoveryRef.current) return;
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

  // ─── 初期化 ──────────────────────────────────────────────
  useEffect(() => {
    let rtcManager = null;

    const init = async () => {
      // 設定読み込み
      const conf = loadClientConfig();
      configRef.current = conf;
      setSelfName(conf.locationName || '自拠点');

      // ── STEP 1: カメラ・マイク取得（SFU とは独立して必ず実行）──
      // OS権限は Electron main 側で初回だけ確認する。ここでは実際に使うストリームだけ取得する。
      const devs = await refreshDevices();

      const videoId = conf.selectedVideoId   || devs.video[0]?.deviceId    || '';
      const audioId = conf.selectedAudioInId || devs.audioIn[0]?.deviceId  || '';
      const outId   = conf.selectedAudioOutId|| devs.audioOut[0]?.deviceId || '';
      setSelectedVideoId(videoId);
      setSelectedAudioInId(audioId);
      setSelectedAudioOutId(outId);

      const { stream, error } = await acquireMedia({ videoId, audioId });
      await installLocalStream(stream, error, { stopPrevious: false }); // SFU 接続前に自拠点プレビューを表示

      // ── STEP 2: SFU 接続 ──
      try {
        rtcManager = new WebRTCManager();
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
        rtcManager.onRestartCommand = () => window.electronAPI?.restartApp?.();
        rtcManager.onAdminSetDevice = (payload) => {
          if (!adminHandlersRef.current.setDevice) throw new Error('device control is not ready');
          return adminHandlersRef.current.setDevice(payload);
        };
        rtcManager.onAdminRefreshDevices = () => {
          if (!adminHandlersRef.current.refreshDevices) throw new Error('device refresh is not ready');
          return adminHandlersRef.current.refreshDevices();
        };

        // 送信トラックを manager に登録（接続/再接続のたびに自動で produce される）
        const s = streamRef.current;
        rtcManager.camEnabled = true;
        rtcManager.micEnabled = true;
        rtcManager.setLocalTracks(s?.getVideoTracks()[0] || null, s?.getAudioTracks()[0] || null);

        const serverUrl = `http://${conf.serverIp}:${conf.serverPort || 3000}`;
        await rtcManager.connect(serverUrl, conf.locationName);
        setSfuStatus('connected');
      } catch (err) {
        console.error('[SFU]', err);
        setSfuStatus('error');
      }
    };

    init();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
      rtcManager?.disconnect();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 1秒ポーリング ──────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      webrtcRef.current?.syncPeers();
    }, 1000);
    return () => clearInterval(id);
  }, []);

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
  }, [changeMediaDevice, changeSpeaker, refreshDevices]);

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
    const next = !camEnabled;
    streamRef.current?.getVideoTracks().forEach(t => (t.enabled = next));
    setCamEnabled(next);
    webrtcRef.current?.setCamEnabled(next).catch(() => {});
  }, [camEnabled]);

  // ─── マイク ON/OFF ────────────────────────────────────────
  const toggleMic = useCallback(async () => {
    const next = !micEnabled;
    streamRef.current?.getAudioTracks().forEach(t => (t.enabled = next));
    setMicEnabled(next);
    webrtcRef.current?.setMicEnabled(next).catch(() => {});
  }, [micEnabled]);

  // ─── グリッド ────────────────────────────────────────────
  const totalCells = peers.size + 1;
  const { gridRef, layout: gridLayout } = useFittedVideoGrid(totalCells);

  return (
    <div className="main-layout">

      {/* ── ヘッダー ── */}
      <div className="header-bar">
        <div className="header-title">常時接続 会議システム</div>
        <div className="header-right">
          <div className="header-status">
            <span className="status-dot" style={{
              background:
                sfuStatus === 'connected'  ? '#4ade80' :
                sfuStatus === 'error'      ? '#ef4444' : '#facc15',
            }} />
            {sfuStatus === 'connected'  ? `接続中 ${peers.size + 1}拠点` :
             sfuStatus === 'error'      ? 'サーバー未接続' : '接続中...'}
          </div>
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
            key={socketId}
            label={peer.locationName}
            stream={peer.stream}
            isSelf={false}
            videoPaused={peer.videoPaused}
            audioPaused={peer.audioPaused}
            speakerDeviceId={selectedAudioOutId}
            speakerMuted={speakerMuted}
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
          onToggle={() => setSpeakerMuted(v => !v)}
          Icon={Volume2}
          IconOff={VolumeX}
          devices={audioOutDevices}
          selectedId={selectedAudioOutId}
          onDeviceChange={changeSpeaker}
          title="スピーカー"
        />
      </div>
    </div>
  );
}
