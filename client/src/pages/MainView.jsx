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
  Volume2, VolumeX, Settings, ChevronDown, X, Download,
  Plus, Pencil, PanelLeftClose, PanelLeftOpen, Maximize2, Minimize2,
  Volume1, Bell, BellRing, Trash2, Check, MonitorUp, Pause, Play, SwitchCamera, Square,
  Briefcase, Clock, Moon, Music, PhoneOff,
} from 'lucide-react';
import { WebRTCManager } from '../services/webrtc';
import ScreenShareModal from '../components/ScreenShareModal';
import {
  playSystemSound,
  startLoopingSystemSound,
  stopAllSystemSounds,
  stopLoopingSystemSound,
  systemSoundUrl,
} from '../services/system-sounds';

const APP_VERSION = '0.5.0';
// サーバーと確立できない状態がこの時間連続したら、アプリ本体を再起動する
// （無限リトライの最終手段。Electronメインの app.relaunch で完全再起動）。
const APP_RELAUNCH_AFTER_MS = 5 * 60 * 1000;
const APP_TYPE = 'client';

/**
 * latest が current より新しいときだけ true。
 * 単純な !== 比較だとサーバー登録が古い場合にダウングレード案内になるため数値比較する。
 * 数値として解釈できない形式は従来どおり不一致で更新扱い（運用でのフェイルセーフ）。
 */
function isNewerVersion(latest, current) {
  if (!latest || latest === current) return false;
  const parse = value => String(value).trim().replace(/^v/i, '').split('.').map(part => parseInt(part, 10));
  const a = parse(latest);
  const b = parse(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return latest !== current;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
const CALL_RING_TIMEOUT_MS = 30000;
const CALL_RING_INTERVAL_MS = 1500;
const DEFAULT_SYSTEM_STATE = {
  brand: 'CHECKHOUSE Meeting System',
  channels: [{ id: 'general', name: '一般' }],
  latestVersions: { [APP_TYPE]: APP_VERSION },
  updatePackages: {},
  maintenance: { serverRestartTimes: [], clientRestartTimes: [] },
};

// ── ルーティン再起動（サーバーから同期された時刻にアプリ本体を再起動）──────
// 長時間稼働によるレンダラー/GPUプロセスのリソース肥大を、営業時間外の
// 計画再起動で予防する。時刻(HH:MM、複数可)は server-gui で設定され、
// systemState.maintenance.clientRestartTimes として全拠点へ同期される。
const ROUTINE_RESTART_WINDOW_MS = 10 * 60 * 1000; // 通話中などの延期を許す猶予
const ROUTINE_RESTART_KEY = 'sfu_last_routine_restart';
const APP_STARTED_AT = Date.now();

// 全拠点が同一時刻に一斉再起動してサーバーへ集中しないよう、端末ごとに
// 0〜20秒の固定オフセットをずらす（instanceId から決定的に算出）
function routineRestartJitterMs() {
  let seed = '';
  try { seed = localStorage.getItem('sfu_instance_id') || ''; } catch { /* ignore */ }
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % 20000;
}
const ROUTINE_RESTART_JITTER_MS = routineRestartJitterMs();

// ─── デバイス選択ドロップダウンボタン ────────────────────

function DeviceButton({ active, onToggle, Icon, IconOff, devices, selectedId, onDeviceChange, title, label, shortcutKey }) {
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
        {label && <span className="ctrl-btn-label">{label}</span>}
        {shortcutKey && <kbd className="ctrl-btn-kbd" aria-hidden="true">{shortcutKey}</kbd>}
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

// ── 通信安定度アンテナ（各拠点タイル右下、5段階+色分け） ─────────
// 0=切断(グレー) 1=赤 2=オレンジ 3=黄 4=黄緑 5=緑
const SIGNAL_COLORS = ['#6b7280', '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
const SIGNAL_TITLES = ['切断', '非常に不安定', '不安定', '普通', '良好', '非常に良好'];

function SignalBars({ level }) {
  if (level == null) return null;
  const clamped = Math.max(0, Math.min(5, Math.round(level)));
  const color = SIGNAL_COLORS[clamped];
  return (
    <div
      className="signal-bars"
      title={`サーバー通信の安定度: ${SIGNAL_TITLES[clamped]}（${clamped}/5）`}
      aria-label={`通信安定度 ${clamped}/5`}
    >
      {[1, 2, 3, 4, 5].map(step => (
        <span
          key={step}
          className="signal-bar"
          style={{
            height: `${3 + step * 2.2}px`,
            background: step <= clamped ? color : 'rgba(255,255,255,0.22)',
          }}
        />
      ))}
    </div>
  );
}

// ─── ショートカットキー入力欄（キーを押して登録） ────────────────

const SHORTCUT_KEY_LABELS = { ' ': 'Space' };
const SHORTCUT_IGNORED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock']);

function formatShortcutKey(key) {
  if (!key) return '未設定';
  if (SHORTCUT_KEY_LABELS[key]) return SHORTCUT_KEY_LABELS[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

function ShortcutKeyField({ label, value, onChange }) {
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="text"
        readOnly
        className="shortcut-key-input"
        value={capturing ? 'キーを押してください…' : formatShortcutKey(value)}
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(event) => {
          event.preventDefault();
          if (SHORTCUT_IGNORED_KEYS.has(event.key)) return;
          if (event.key === 'Escape') { event.target.blur(); return; }
          onChange(event.key.length === 1 ? event.key.toLowerCase() : event.key);
          event.target.blur();
        }}
      />
    </div>
  );
}

// ─── ビデオセル ───────────────────────────────────────────

const VideoCell = React.memo(function VideoCell({
  label,
  stream,
  isSelf,
  isScreen = false,
  videoPaused,
  audioPaused,
  presenceMode = 'none',
  signalLevel = null,
  reconnecting = false,
  highlightMuted = false,
  speakerDeviceId,
  speakerMuted,
  volume = 1,
  tileId = '',
  focused = false,
  compact = false,
  mini = false,
  dimmed = false,
  canFocus = true,
  canControlVolume = false,
  volumeValue = 1,
  onFocus,
  onVolumeChange,
  onCall = null,
}) {
  const videoRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  // stream が変わったら srcObject を更新して再生
  // 重要: muted は React 属性だと DOM プロパティに反映されない既知問題があり、
  // 音声付きストリームの autoplay がブロックされて黒画面になる。必ず命令的に設定する。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // 自拠点プレビューは常にミュート（ハウリング防止）。他拠点は speakerMuted に従う。
    video.muted = isSelf ? true : !!(speakerMuted || audioPaused);
    video.volume = isSelf || speakerMuted || audioPaused ? 0 : clampNumber(volume, 0, 1);
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
  }, [stream, isSelf, speakerMuted, audioPaused, volume]);

  // 黒画面自己復旧: ストリームは生きているのに <video> の再生が止まっている
  // (自動再生ブロックの取りこぼし・デバイス復帰後の停止など)場合に再生を試みる。
  // セッションが健全でも再生が止まると「接続しているのに真っ暗」になるため、
  // 周期的に確認して自己回復する。
  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video || !video.srcObject) return;
      if (video.paused || video.ended) {
        video.play().catch(() => { /* 次周期で再試行 */ });
      }
    }, 4000);
    return () => clearInterval(id);
  }, []);

  // スピーカーデバイス変更
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isSelf) return;
    if (speakerDeviceId && typeof video.setSinkId === 'function') {
      video.setSinkId(speakerDeviceId).catch(() => {});
    }
  }, [speakerDeviceId, isSelf]);

  const cameraOff = !!videoPaused;
  // カメラONのはずなのに映像トラックが届いていない（consume未完了・経路劣化など）
  const noVideoSignal = !cameraOff && !isSelf && !isScreen &&
    (!stream || stream.getVideoTracks().length === 0);
  const selfMutedHighlight = isSelf && !!audioPaused && highlightMuted;

  return (
    <div
      className={`video-cell ${focused ? 'focused' : ''} ${compact ? 'compact' : ''} ${mini ? 'mini' : ''} ${dimmed ? 'dimmed' : ''}`}
      style={{ outline: selfMutedHighlight ? '2px solid #ef4444' : (isSelf ? '2px solid #4ade80' : '2px solid rgba(255,255,255,0.08)') }}
      onDoubleClick={() => canFocus && onFocus?.(tileId)}
      onContextMenu={(event) => {
        if (!canControlVolume) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
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
          // 画面共有は左右反転しない（自拠点カメラのみミラー表示）
          transform: isSelf && !isScreen ? 'scaleX(-1)' : 'none',
          background: '#000',
          display: cameraOff ? 'none' : 'block',
        }}
      />

      {/* カメラOFF / 映像未達 オーバーレイ: 拠点名を中央に大きく表示する */}
      {(cameraOff || noVideoSignal) && !reconnecting && (
        <div className="cam-off-overlay">
          <div className="camoff-name">{label}</div>
          <span className="camoff-caption">
            <VideoOff size={13} />
            {cameraOff ? 'カメラ OFF' : '映像を受信していません'}
          </span>
        </div>
      )}

      {/* この拠点がサーバーと再接続中（復旧中）: スピナーを中央に表示する */}
      {reconnecting && (
        <div className="tile-reconnect-overlay" role="status" aria-label={`${label} はサーバー接続中`}>
          <div className="camoff-name">{label}</div>
          <div className="tile-reconnect-row">
            <span className="reconnect-spinner small" aria-hidden="true" />
            <span>サーバー接続中...</span>
          </div>
        </div>
      )}

      {/* サーバー通信の安定度（右下・5段階アンテナ） */}
      {!isScreen && <SignalBars level={signalLevel} />}

      {/* プレゼンスモード（商談中/不在/帰宅）バッジ */}
      {!isScreen && PRESENCE_LABELS[presenceMode] && (
        <div className={`presence-badge presence-${presenceMode}`}>
          {PRESENCE_LABELS[presenceMode]}
        </div>
      )}

      {/* 拠点名ラベル */}
      <div className="cell-label">
        {isSelf && <span className="self-dot" />}
        {audioPaused && <MicOff size={11} color="#ef4444" style={{ flexShrink: 0 }} />}
        <span>{label}</span>
        {isSelf && <span style={{ opacity: 0.5, marginLeft: 3, flexShrink: 0 }}>（自拠点）</span>}
      </div>

      {/* ── ホバー操作オーバーレイ ──
          普段は映像を邪魔せず、マウスオーバー時のみタイル中央に大きめの
          半透明パネル（不透明度60%）を表示する。各ボタンはホバーで
          一言の補助説明（data-tip）を吹き出し表示する。 */}
      <div className="tile-actions" onDoubleClick={event => event.stopPropagation()}>
        {canFocus && (
          <button
            type="button"
            className={`tile-btn ${focused ? 'active' : ''}`}
            onClick={() => onFocus?.(tileId)}
            data-tip={focused ? '元のサイズに戻す' : 'この拠点を大きく表示'}
            aria-label={focused ? '元のサイズに戻す' : 'この拠点を大きく表示'}
          >
            {focused ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
          </button>
        )}

        {canControlVolume && (
          <button
            type="button"
            className={`tile-btn ${volumeValue <= 0 ? 'danger-active' : ''}`}
            onClick={() => onVolumeChange?.(tileId, volumeValue > 0 ? 0 : 1)}
            data-tip={volumeValue > 0 ? 'この拠点の音声を消す' : 'この拠点の音声を出す'}
            aria-label={volumeValue > 0 ? 'この拠点の音声を消す' : 'この拠点の音声を出す'}
          >
            {volumeValue > 0 ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
        )}

        {canControlVolume && (
          <button
            type="button"
            className={`tile-btn ${menuOpen ? 'active' : ''}`}
            onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open); }}
            onMouseDown={(event) => event.stopPropagation()}
            data-tip="音量を細かく調整"
            aria-label="音量を細かく調整"
          >
            <span className="tile-vol-text">{Math.round(volumeValue * 100)}%</span>
          </button>
        )}

        {onCall && (
          <button
            type="button"
            className="tile-btn call"
            onClick={onCall}
            data-tip="この拠点を呼び出す"
            aria-label="この拠点を呼び出す"
          >
            <BellRing size={20} />
          </button>
        )}
      </div>

      {/* 個別ミュート中バッジ */}
      {canControlVolume && volumeValue <= 0 && (
        <div className="tile-muted-badge" title="この拠点の音声をミュート中">
          <VolumeX size={12} color="white" />
        </div>
      )}

      {/* マイクOFF バッジ */}
      {audioPaused && (
        <div className="mute-badge">
          <MicOff size={12} color="white" />
        </div>
      )}

      {menuOpen && canControlVolume && (
        <div className="tile-volume-menu" ref={menuRef}>
          <div className="tile-volume-head">
            <Volume1 size={15} />
            <span>個別音量</span>
            <strong>{Math.round(volumeValue * 100)}%</strong>
          </div>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={volumeValue}
            onChange={event => onVolumeChange?.(tileId, Number(event.target.value))}
          />
          <div className="tile-volume-actions">
            <button type="button" onClick={() => onVolumeChange?.(tileId, 0)}>ミュート</button>
            <button type="button" onClick={() => onVolumeChange?.(tileId, 1)}>標準</button>
          </div>
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
  // コールバックref + state でグリッドDOMノードを追跡する。
  // useRef だと、フォーカス表示⇄グリッド表示の切替でグリッドが再マウントされた
  // ときに effect が再実行されず（依存が cellCount だけのため）、ResizeObserver が
  // 取り外された旧ノードを監視し続けて幅0を記録 → フォーカス解除後に全タイルが
  // 幅1pxで描画され「他拠点が表示されない」不具合になっていた。
  const [element, setElement] = useState(null);
  const gridRef = useCallback(node => setElement(node), []);
  const [layout, setLayout] = useState(() => {
    const cols = getGridCols(cellCount);
    return { cols, rows: Math.ceil(Math.max(1, cellCount) / cols), cellWidth: 0, cellHeight: 0 };
  });

  useLayoutEffect(() => {
    if (!element) return undefined;

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 取り外された/非表示のノードの計測（幅0）は捨てる。採用すると
        // セル幅0が残り、再マウント時にタイル数が同じだと再計測されない。
        if (!element.isConnected) return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
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
  }, [element, cellCount]);

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

// キーボードショートカット既定値（設定画面で変更可）。数字キー1-9によるチャンネル
// 移動はチャンネル一覧の並び順に固定で紐づくため、ここでは対象外。
const defaultShortcuts = {
  micToggle: 'm',
  speakerToggle: 's',
  cameraToggle: 'c',
  callAnswer: 'Enter',
  busyMode: 'u',
  awayMode: 'i',
  goHomeMode: 'o',
};

// プレゼンスモードの表示定義（タイルバッジ・ボタンで共用）
const PRESENCE_LABELS = {
  busy: '商談中',
  away: '不在',
  gohome: '帰宅',
};
const QUALITY_OPTIONS = ['high', 'medium', 'low'];
const QUALITY_LABELS = { high: '高', medium: '中', low: '低' };

function sanitizeVolumePercent(value, fallback = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

const defaultClientConfig = {
  serverIp: '127.0.0.1',
  serverPort: '3000',
  // 保険用サブサーバー（クラウド等）。メインに接続できない状態が続くと自動切替する。
  subServerIp: '',
  subServerPort: '3000',
  activeServer: 'main',     // 'main' | 'sub' 現在使用するサーバー
  locationName: '自拠点',
  channelId: 'general',
  shortcuts: { ...defaultShortcuts },
  autoUnmuteOnCallAnswer: true,
  highlightSelfMuted: true,
  startMicMuted: true,      // 起動時はマイクミュートで開始（設定で変更可）
  forceTcp: false,          // メディアをTCPで送受信（UDPが不安定な場合のみ）
  sendQuality: 'high',      // 送信画質（ビットレート倍率）
  recvQuality: 'high',      // 受信画質（simulcastレイヤ選択）
  voiceVolume: 100,         // 通話音声の音量（0-100）
  ringtoneVolume: 100,      // 着信音/呼び出し音の音量（0-100）
  effectsVolume: 100,       // 効果音の音量（0-100）
};

// ── カスタム着信音（mp3/wav等）の永続化 ─────────────────────
// dataURL として localStorage に保存する。設定(sfu_config)とは別キーにして
// 設定保存のたびに大きなデータを書き直さないようにする。localStorage は
// Electron の userData に保存されるため、アプリ更新後も引き継がれる。
const RINGTONE_STORAGE_KEY = 'sfu_ringtone';
const RINGTONE_MAX_BYTES = 3 * 1024 * 1024; // 3MB（dataURL化で約1.33倍になる）

function loadCustomRingtone() {
  try {
    const raw = localStorage.getItem(RINGTONE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.dataUrl !== 'string' || !parsed.dataUrl.startsWith('data:')) return null;
    return { name: String(parsed.name || 'カスタム着信音'), dataUrl: parsed.dataUrl };
  } catch {
    return null;
  }
}

function saveCustomRingtone(ringtone) {
  try {
    if (!ringtone) localStorage.removeItem(RINGTONE_STORAGE_KEY);
    else localStorage.setItem(RINGTONE_STORAGE_KEY, JSON.stringify(ringtone));
    return true;
  } catch (err) {
    console.warn('[ringtone] save failed:', err.message);
    return false;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
    reader.readAsDataURL(file);
  });
}
const QUICK_RESTART_CONNECT_WINDOW_MS = 5000;
// 直前の再起動からこの時間内に届いた「健全なセッションへの」再起動要求は無視する。
// 復旧機構（サーバーrestartCommand/クライアント自己復旧）の多重発火を吸収する。
const QUICK_RESTART_COOLDOWN_MS = 10000;

async function connectWithinStartupWindow(manager, serverUrl, locationName, options = {}) {
  let timedOut = false;
  const connectPromise = manager.connect(serverUrl, locationName, options)
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

function sanitizeShortcuts(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clean = {};
  for (const action of Object.keys(defaultShortcuts)) {
    const value = src[action];
    clean[action] = (typeof value === 'string' && value.length > 0) ? value : defaultShortcuts[action];
  }
  return clean;
}

function sanitizeClientConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const serverIp = String(raw.serverIp || defaultClientConfig.serverIp).trim() || defaultClientConfig.serverIp;
  const rawPort = String(raw.serverPort || defaultClientConfig.serverPort).trim();
  const serverPort = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535
    ? rawPort
    : defaultClientConfig.serverPort;
  const subServerIp = String(raw.subServerIp || '').trim();
  const rawSubPort = String(raw.subServerPort || defaultClientConfig.subServerPort).trim();
  const subServerPort = /^\d{1,5}$/.test(rawSubPort) && Number(rawSubPort) >= 1 && Number(rawSubPort) <= 65535
    ? rawSubPort
    : defaultClientConfig.subServerPort;
  // サブサーバーが未登録なら activeServer は必ず main に戻す
  const activeServer = raw.activeServer === 'sub' && subServerIp ? 'sub' : 'main';
  const locationName = String(raw.locationName || defaultClientConfig.locationName).trim() || defaultClientConfig.locationName;
  const channelId = String(raw.channelId || defaultClientConfig.channelId).trim() || defaultClientConfig.channelId;
  const shortcuts = sanitizeShortcuts(raw.shortcuts);
  // 明示的に false が保存されていない限り既定オン（後から追加した設定のため）。
  const autoUnmuteOnCallAnswer = raw.autoUnmuteOnCallAnswer !== false;
  const highlightSelfMuted = raw.highlightSelfMuted !== false;
  const startMicMuted = raw.startMicMuted !== false;
  const forceTcp = raw.forceTcp === true;
  const sendQuality = QUALITY_OPTIONS.includes(raw.sendQuality) ? raw.sendQuality : defaultClientConfig.sendQuality;
  const recvQuality = QUALITY_OPTIONS.includes(raw.recvQuality) ? raw.recvQuality : defaultClientConfig.recvQuality;
  const voiceVolume = sanitizeVolumePercent(raw.voiceVolume, defaultClientConfig.voiceVolume);
  const ringtoneVolume = sanitizeVolumePercent(raw.ringtoneVolume ?? raw.callVolume, defaultClientConfig.ringtoneVolume);
  const effectsVolume = sanitizeVolumePercent(raw.effectsVolume, defaultClientConfig.effectsVolume);

  return {
    ...raw,
    serverIp,
    serverPort,
    subServerIp,
    subServerPort,
    activeServer,
    locationName,
    channelId,
    shortcuts,
    autoUnmuteOnCallAnswer,
    highlightSelfMuted,
    startMicMuted,
    forceTcp,
    sendQuality,
    recvQuality,
    voiceVolume,
    ringtoneVolume,
    effectsVolume,
    callVolume: ringtoneVolume,
  };
}

function isPrivateChannel(channel) {
  return !!channel && (channel.private === true || String(channel.id || '').startsWith('private-'));
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

/** 現在使用するサーバー（メイン/サブ）のURLを返す */
function serverUrlFromConfig(config) {
  const conf = sanitizeClientConfig(config);
  if (conf.activeServer === 'sub' && conf.subServerIp) {
    return `http://${conf.subServerIp}:${conf.subServerPort || 3000}`;
  }
  return `http://${conf.serverIp}:${conf.serverPort || 3000}`;
}

// メイン到達不能がこの時間続き、かつもう一方のサーバーが応答するなら自動切替する
const FAILOVER_AFTER_MS = 12000;
const FAILOVER_COOLDOWN_MS = 30000;
// 手動でサーバーを切り替えた後、この時間は占有数ベースの自動選択で上書きしない
// （到達不能による自動フェイルオーバーは常に有効）
const MANUAL_SERVER_STICKY_MS = 10 * 60 * 1000;

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function loadSidebarWidth() {
  try {
    const saved = localStorage.getItem('client_sidebar_width');
    return saved == null ? 236 : clampNumber(saved, 196, 360);
  } catch {
    return 236;
  }
}

function memberInitials(name) {
  const text = String(name || '').trim();
  if (!text) return '拠';
  const compact = text.replace(/\s+/g, '');
  return compact.slice(0, 2).toUpperCase();
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

/**
 * サーバーの接続拠点数を問い合わせる（サーバー選択用）。
 * 新サーバーは軽量な /presence、旧サーバーは /health から数える。
 */
async function probeServerPresence(config, timeoutMs = 1200) {
  const baseUrl = serverUrlFromConfig(config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/presence`, { signal: controller.signal, cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const clientCount = Number(data.clientCount) || 0;
      // clientAppCount: 会議アプリ(client)のみの数。screen-share を「拠点がいる」と
      // 数えると、クライアント不在のサーバーへ寄ってしまうため、判定はこちらを優先する。
      // 旧サーバー(フィールド無し)は合算値へフォールバック。
      const clientAppCount = Number.isFinite(Number(data.clientAppCount))
        ? Number(data.clientAppCount)
        : clientCount;
      return { reachable: true, clientCount, clientAppCount };
    }
  } catch {
    // 旧サーバー(未実装)や到達不能。/health のフォールバックへ。
  } finally {
    clearTimeout(timer);
  }

  const fallbackController = new AbortController();
  const fallbackTimer = setTimeout(() => fallbackController.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: fallbackController.signal, cache: 'no-store' });
    if (!res.ok) return { reachable: false, clientCount: 0, clientAppCount: 0 };
    const data = await res.json();
    const clients = Array.isArray(data.clients) ? data.clients : [];
    const active = clients.filter(client => (
      (client.appType === 'client' || client.appType === 'screen-share') && client.connected !== false
    ));
    const clientAppCount = active.filter(client => client.appType === 'client').length;
    return { reachable: true, clientCount: active.length, clientAppCount };
  } catch {
    return { reachable: false, clientCount: 0, clientAppCount: 0 };
  } finally {
    clearTimeout(fallbackTimer);
  }
}

/**
 * メイン/サブ両サーバーの接続拠点数を確認し、接続すべきサーバーを返す（null=変更不要/判定不能）。
 * 到達性だけで選ぶと、復旧タイミングの差で拠点ごとに別サーバーへ散らばり
 * 「お互いの映像が見えない」スプリットブレインになるため、
 * 他拠点が接続しているサーバーへ寄せる。どちらも空なら メイン へ収束させる。
 */
async function chooseServerByOccupancy(config, { manualSelectionAt = 0 } = {}) {
  const conf = sanitizeClientConfig(config);
  if (!conf.subServerIp) return null;
  if (Date.now() - manualSelectionAt < MANUAL_SERVER_STICKY_MS) return null; // 手動選択を尊重

  const [main, sub] = await Promise.all([
    probeServerPresence({ ...conf, activeServer: 'main' }),
    probeServerPresence({ ...conf, activeServer: 'sub' }),
  ]);
  const current = conf.activeServer === 'sub' ? 'sub' : 'main';
  const other = current === 'main' ? 'sub' : 'main';
  const info = { main, sub };

  if (!info.main.reachable && !info.sub.reachable) return null;
  // 現サーバーが単発プローブで不達でも、もう一方が「空」なら移らない。
  // ルーティン再起動などの数秒のダウンで空のサブへ散らばり、復帰したメインと
  // 分裂したまま固定されるのを防ぐ。本当の障害は自動フェイルオーバー
  // (FAILOVER_AFTER_MS の継続監視)が拾うので、ここで急いで移る必要はない。
  if (!info[current].reachable) {
    return info[other].reachable && info[other].clientAppCount > 0 ? other : null;
  }
  if (!info[other].reachable) return current;
  // 両方到達可能: 会議アプリ(client)が多い方へ（同数・両方空はメインへ収束）
  return info.main.clientAppCount >= info.sub.clientAppCount ? 'main' : 'sub';
}

// ─── メインビュー ─────────────────────────────────────────
export default function MainView() {
  // ── 映像/音声状態 ──
  const [localStream,  setLocalStream]  = useState(null);
  // 起動時のマイク状態は設定に従う（既定: ミュートで開始）
  const [micEnabled,   setMicEnabled]   = useState(() => !loadClientConfig().startMicMuted);
  // プレゼンスモード（none/busy=商談中/away=不在/gohome=帰宅）。
  // ref は着信音量計算やショートカットなどコールバックから参照するために持つ。
  const [presenceMode, setPresenceMode] = useState('none');
  const presenceModeRef = useRef('none');
  // 自拠点のサーバー通信安定度（0-5、タイル右下のアンテナ表示用）
  const [selfSignalLevel, setSelfSignalLevel] = useState(0);
  // カスタム着信音（mp3/wav等、localStorageに永続化）
  const [customRingtone, setCustomRingtone] = useState(() => loadCustomRingtone());
  const customRingtoneRef = useRef(null);
  const ringtoneAudioRef = useRef(null);   // 鳴動中の Audio 要素（ループ再生）
  const [serverRingtones, setServerRingtones] = useState(null); // null=未取得
  const [ringtoneNotice, setRingtoneNotice] = useState('');
  // アプリ内確認ダイアログ（OS標準の confirm の代わり）
  // { title, message, confirmLabel, onConfirm }
  const [confirmDialog, setConfirmDialog] = useState(null);
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
  const [settingsOpen, setSettingsOpen] = useState(() => !localStorage.getItem('sfu_config'));
  const [settingsDraft, setSettingsDraft] = useState(() => sanitizeClientConfig(loadClientConfig()));
  const [systemState, setSystemState] = useState(DEFAULT_SYSTEM_STATE);
  const [channelId, setChannelId] = useState(() => sanitizeClientConfig(loadClientConfig()).channelId);
  const [highlightSelfMuted, setHighlightSelfMuted] = useState(() => sanitizeClientConfig(loadClientConfig()).highlightSelfMuted);
  const [updateNotice, setUpdateNotice] = useState(null);
  const [focusedTileId, setFocusedTileId] = useState('');
  const [peerVolumes, setPeerVolumes] = useState({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [channelEditorOpen, setChannelEditorOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [channelDrafts, setChannelDrafts] = useState({});
  const [memberMenu, setMemberMenu] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [outgoingCall, setOutgoingCall] = useState(null);   // { callId, targetSocketId, targetName }
  const [privateCall, setPrivateCall] = useState(null);     // { channelId, previousChannelId, channelName }
  const [callNotice, setCallNotice] = useState(null);       // 呼び出し結果の一時表示
  const [screenShare, setScreenShare] = useState(null);     // { sourceId, sourceName, hasAudio, audioEnabled, paused, stream }
  const [shareModalMode, setShareModalMode] = useState(null); // null | 'start' | 'change'

  // refs（クリーンアップ・デバイス変更用）
  const webrtcRef = useRef(null);
  const streamRef = useRef(null);
  const configRef = useRef({});
  // 呼び出し応答時の自動ミュート解除など、定義順の都合で先に参照したい
  // setMicrophoneEnabled/setSpeakerOutputEnabled への最新参照を保持する。
  const mediaControlsRef = useRef({});
  const mediaRecoveryRef = useRef(false);
  const telemetryStateRef = useRef({});
  const adminHandlersRef = useRef({});
  const audioMonitorRef = useRef({});
  const softRestartInFlightRef = useRef(false);
  const lastQuickRestartAtRef = useRef(0);
  // startClientSession の多重実行ガード。初期化中(メディア取得に数秒かかる)に
  // サーバー到達確認ポーリングが「managerがまだ無い」と判断してもう一度
  // セッションを開始すると、同じ拠点からサーバーへ二重セッションが張られる。
  const sessionStartInFlightRef = useRef(false);
  // 進行中のセッション開始 Promise。performQuickRestart が完了を待って直列化する。
  const sessionStartPromiseRef = useRef(null);
  // セッション世代。releaseClientRuntime のたびに進み、進行中の startClientSessionInner が
  // 「自分は破棄済み」と気付いて中断するために使う。これが無いと、初期化中に再起動が
  // 走った場合に破棄済みの manager が connect() で蘇り、誰からも参照されない
  // 孤児セッション(旧サーバーへ接続し続けるゴースト拠点)になる。
  const sessionGenerationRef = useRef(0);
  // 設定上の接続先と実際の接続先の不一致検出(連続カウント)
  const serverUrlMismatchRef = useRef(0);
  // 占有数の再収束チェック(自分だけ別サーバーに取り残された状態の自己修復)
  const reconvergeStrikesRef = useRef(0);
  const softRestartHandlerRef = useRef(null);
  const serverProbeInFlightRef = useRef(false);
  // 自動フェイルオーバーの状態（現サーバーの到達不能開始時刻と直近切替時刻）
  const serverFailoverRef = useRef({ downSince: null, lastSwitchAt: 0 });
  // 手動でサーバーを切り替えた時刻（この後しばらく占有数ベースの自動選択を抑制）
  const manualServerSelectAtRef = useRef(0);
  const micEnabledRef = useRef(micEnabled);
  const speakerMutedRef = useRef(false);
  const sfuStatusRef = useRef(sfuStatus);
  const peersRef = useRef(peers);
  const channelIdRef = useRef(channelId);
  const observedRemoteScreenSharesRef = useRef(new Set());
  const sendTelemetryRef = useRef(null);
  const joinAudioRef = useRef(null);
  const callAudioRef = useRef(null);
  const incomingCallTimerRef = useRef(null);
  const incomingCallRingIntervalRef = useRef(null);
  const activeIncomingCallIdRef = useRef('');
  const outgoingCallRef = useRef(null);
  const outgoingCallTimerRef = useRef(null);
  const privateCallRef = useRef(null);
  const callNoticeTimerRef = useRef(null);
  const screenShareRef = useRef(null);

  useEffect(() => { outgoingCallRef.current = outgoingCall; }, [outgoingCall]);
  useEffect(() => { privateCallRef.current = privateCall; }, [privateCall]);
  useEffect(() => { screenShareRef.current = screenShare; }, [screenShare]);
  useEffect(() => { channelIdRef.current = channelId; }, [channelId]);

  const channels = useMemo(() => {
    const items = Array.isArray(systemState.channels) && systemState.channels.length
      ? systemState.channels
      : DEFAULT_SYSTEM_STATE.channels;
    return items;
  }, [systemState]);
  const registeredChannels = useMemo(() => channels.filter(channel => !isPrivateChannel(channel)), [channels]);

  const activeChannel = useMemo(() => (
    channels.find(channel => channel.id === channelId) || channels[0] || DEFAULT_SYSTEM_STATE.channels[0]
  ), [channels, channelId]);
  const activeChannelId = activeChannel?.id || channelId || 'general';

  const updatePackage = systemState.updatePackages?.[APP_TYPE] || null;
  const latestVersion = systemState.latestVersions?.[APP_TYPE] || APP_VERSION;
  const updateAvailable = isNewerVersion(latestVersion, APP_VERSION);
  const peerEntries = useMemo(() => Array.from(peers.entries()), [peers]);

  const audiblePeerCount = useMemo(() => (
    peerEntries.filter(([, peer]) => {
      const audio = peer.stream?.getAudioTracks()[0] || null;
      const sameChannel = (peer.channelId || 'general') === activeChannelId;
      return !!audio && audio.readyState === 'live' && !peer.audioPaused && sameChannel;
    }).length
  ), [peerEntries, activeChannelId]);

  const remoteAudioVolume = useMemo(() => calculateRemoteAudioVolume({
    audiblePeerCount,
    localSpeaking,
    speakerMuted,
  }) * (sanitizeVolumePercent(settingsDraft.voiceVolume ?? 100) / 100), [
    audiblePeerCount,
    localSpeaking,
    settingsDraft.voiceVolume,
    speakerMuted,
  ]);

  useEffect(() => {
    micEnabledRef.current = micEnabled;
  }, [micEnabled]);

  useEffect(() => {
    speakerMutedRef.current = speakerMuted;
  }, [speakerMuted]);

  useEffect(() => {
    sfuStatusRef.current = sfuStatus;
  }, [sfuStatus]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  const effectsVolumeScale = useCallback(() => {
    const conf = configRef.current?.serverIp ? configRef.current : loadClientConfig();
    return sanitizeVolumePercent(conf.effectsVolume ?? 100) / 100;
  }, []);

  const playEffectSound = useCallback((key, options = {}) => (
    playSystemSound(key, {
      ...options,
      volume: options.volume ?? effectsVolumeScale(),
    })
  ), [effectsVolumeScale]);

  const channelMembers = useMemo(() => {
    const knownChannels = new Set(channels.map(channel => channel.id));
    const fallbackId = activeChannelId || channels[0]?.id || 'general';
    const membersByChannel = new Map(channels.map(channel => [channel.id, []]));
    const addMember = (member) => {
      const targetId = knownChannels.has(member.channelId) ? member.channelId : fallbackId;
      if (!membersByChannel.has(targetId)) membersByChannel.set(targetId, []);
      membersByChannel.get(targetId).push(member);
    };

    addMember({
      id: 'self',
      socketId: '',
      name: selfName,
      channelId: activeChannelId,
      isSelf: true,
      muted: !micEnabled,
    });

    for (const [socketId, peer] of peerEntries) {
      if (peer.appType === 'screen-share') continue;
      addMember({
        id: socketId,
        socketId,
        name: peer.locationName || '不明',
        channelId: peer.channelId || fallbackId,
        isSelf: false,
        muted: !!peer.audioPaused,
      });
    }

    for (const members of membersByChannel.values()) {
      members.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name, 'ja'));
    }
    return membersByChannel;
  }, [activeChannelId, channels, micEnabled, peerEntries, selfName]);

  const playJoinTone = useCallback(() => {
    if (speakerMutedRef.current) return;
    playEffectSound('channelJoin');
  }, [playEffectSound]);

  // customRingtone(state) をコールバックから参照するための ref 同期
  useEffect(() => {
    customRingtoneRef.current = customRingtone;
  }, [customRingtone]);

  /**
   * 着信音の実効音量（0-1）。設定の呼び出し音量に、商談中モードなら 0.5 を掛ける。
   * 不在/帰宅モードは 100% のまま。
   */
  const ringVolumeScale = useCallback(() => {
    const conf = configRef.current?.serverIp ? configRef.current : loadClientConfig();
    const base = sanitizeVolumePercent(conf.ringtoneVolume ?? conf.callVolume ?? 100) / 100;
    const busyFactor = presenceModeRef.current === 'busy' ? 0.5 : 1;
    return base * busyFactor;
  }, []);

  /** 既定のベル音を合成再生する（volume: 0-1） */
  const playSynthCallTone = useCallback((volume) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || volume <= 0) return;

    try {
      const context = callAudioRef.current && callAudioRef.current.state !== 'closed'
        ? callAudioRef.current
        : new AudioContextClass();
      callAudioRef.current = context;
      context.resume?.().catch(() => {});

      const now = context.currentTime;
      const master = context.createGain();
      master.gain.setValueAtTime(0.32 * volume, now);
      master.connect(context.destination);

      for (let index = 0; index < 6; index += 1) {
        const start = now + index * 0.22;
        const gain = context.createGain();
        const oscillator = context.createOscillator();
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(index % 2 === 0 ? 1040 : 780, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.85, start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(start + 0.19);
      }
    } catch (err) {
      console.warn('[callTone]', err.message);
    }
  }, []);

  /**
   * 着信音を鳴らす。カスタム着信音(mp3/wav)が設定されていればループ再生、
   * なければ既定のベル音を合成する。鳴動間隔(CALL_RING_INTERVAL_MS)ごとに
   * 呼ばれるが、カスタム音のループ再生中は多重再生しない。
   */
  const playCallTone = useCallback(() => {
    const volume = ringVolumeScale();
    if (volume <= 0) return;

    const ringtone = customRingtoneRef.current;
    const bundledRingtoneUrl = systemSoundUrl('incomingCall');
    const ringtoneSource = ringtone?.dataUrl || bundledRingtoneUrl;
    if (ringtoneSource) {
      const playing = ringtoneAudioRef.current;
      if (playing && playing._systemSoundSource === ringtoneSource && !playing.paused && !playing.ended) {
        playing.volume = volume; // モード切替を鳴動中にも反映
        return;
      }
      try {
        const audio = playing && playing._systemSoundSource === ringtoneSource
          ? playing
          : new Audio(ringtoneSource);
        audio.loop = true;
        audio.volume = volume;
        audio._systemSoundSource = ringtoneSource;
        ringtoneAudioRef.current = audio;
        audio.play().catch(err => {
          // 自動再生ブロック等。既定のベル音にフォールバックする。
          console.warn('[ringtone]', err.message);
          playSynthCallTone(volume);
        });
      } catch (err) {
        console.warn('[ringtone]', err.message);
        playSynthCallTone(volume);
      }
      return;
    }

    playSynthCallTone(volume);
  }, [playSynthCallTone, ringVolumeScale]);

  /** 設定画面の試聴用。ドラフト中の音量・選択中の音源で一度だけ鳴らす */
  const previewCallTone = useCallback((volumePercent) => {
    const volume = sanitizeVolumePercent(volumePercent ?? 100) / 100;
    const ringtone = customRingtoneRef.current;
    const ringtoneSource = ringtone?.dataUrl || systemSoundUrl('incomingCall');
    if (ringtoneSource) {
      try {
        const audio = new Audio(ringtoneSource);
        audio.volume = volume;
        audio.play().catch(() => {});
        // 試聴は数秒で止める（長い曲をフルで流さない）
        setTimeout(() => { try { audio.pause(); } catch { /* ignore */ } }, 4000);
        return;
      } catch { /* fall through to synth */ }
    }
    playSynthCallTone(volume);
  }, [playSynthCallTone]);

  // ── 呼び出し結果の一時通知（画面下部に数秒表示）──
  const showCallNotice = useCallback((text, tone = 'info') => {
    if (callNoticeTimerRef.current) clearTimeout(callNoticeTimerRef.current);
    playEffectSound('notification');
    setCallNotice({ text, tone });
    callNoticeTimerRef.current = setTimeout(() => setCallNotice(null), 4500);
  }, [playEffectSound]);

  // ── 発信中状態の終了（応答/拒否/タイムアウト/キャンセル/切断）──
  const stopOutgoingCall = useCallback((expectedCallId = '') => {
    const current = outgoingCallRef.current;
    if (expectedCallId && current && current.callId !== expectedCallId) return;
    if (outgoingCallTimerRef.current) {
      clearTimeout(outgoingCallTimerRef.current);
      outgoingCallTimerRef.current = null;
    }
    stopLoopingSystemSound('outgoingCall');
    outgoingCallRef.current = null;
    setOutgoingCall(null);
  }, []);

  const stopIncomingCall = useCallback((expectedCallId = '') => {
    if (expectedCallId && activeIncomingCallIdRef.current && activeIncomingCallIdRef.current !== expectedCallId) return;
    if (incomingCallTimerRef.current) {
      clearTimeout(incomingCallTimerRef.current);
      incomingCallTimerRef.current = null;
    }
    if (incomingCallRingIntervalRef.current) {
      clearInterval(incomingCallRingIntervalRef.current);
      incomingCallRingIntervalRef.current = null;
    }
    // カスタム着信音（ループ再生中の Audio 要素）を停止する
    if (ringtoneAudioRef.current) {
      try { ringtoneAudioRef.current.pause(); } catch { /* ignore */ }
      ringtoneAudioRef.current = null;
    }
    activeIncomingCallIdRef.current = '';
    setIncomingCall(null);
  }, []);

  const showIncomingCall = useCallback((payload = {}) => {
    const callerName = payload.fromName || '別拠点';
    const callId = payload.callId || `call-${Date.now()}`;
    const expiresAt = Date.now() + CALL_RING_TIMEOUT_MS;
    // 既に別の着信が鳴動中なら、前の発信元へ「応答なし」を返してから置き換える
    const previousCallId = activeIncomingCallIdRef.current;
    if (previousCallId && previousCallId !== callId) {
      webrtcRef.current?.ackCall(previousCallId, 'dismissed').catch(() => {});
    }
    stopIncomingCall();
    setIncomingCall({
      callId,
      callerName,
      fromSocketId: payload.fromSocketId || '',
      fromChannelId: payload.fromChannelId || '',
      fromChannelName: payload.fromChannelName || '',
      callMode: payload.callMode || '',
      privateChannelId: payload.privateChannelId || '',
      receivedAt: Date.now(),
      expiresAt,
    });
    activeIncomingCallIdRef.current = callId;
    playCallTone();
    incomingCallRingIntervalRef.current = setInterval(() => {
      if (Date.now() >= expiresAt) {
        stopIncomingCall(callId);
        return;
      }
      playCallTone();
    }, CALL_RING_INTERVAL_MS);
    incomingCallTimerRef.current = setTimeout(() => {
      stopIncomingCall(callId);
    }, CALL_RING_TIMEOUT_MS);
  }, [playCallTone, stopIncomingCall]);

  useEffect(() => () => {
    if (incomingCallTimerRef.current) clearTimeout(incomingCallTimerRef.current);
    if (incomingCallRingIntervalRef.current) clearInterval(incomingCallRingIntervalRef.current);
    if (outgoingCallTimerRef.current) clearTimeout(outgoingCallTimerRef.current);
    if (callNoticeTimerRef.current) clearTimeout(callNoticeTimerRef.current);
    stopAllSystemSounds();
    try { joinAudioRef.current?.close?.(); } catch { /* ignore */ }
    try { callAudioRef.current?.close?.(); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!memberMenu) return undefined;
    const close = () => setMemberMenu(null);
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [memberMenu]);

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
      channelId,
      systemState,
      updateNotice,
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
    channelId,
    systemState,
    updateNotice,
  ]);

  // 状態変更を次のレンダリング反映後すぐサーバーへ通知する（サーバー監視のリアルタイム性向上）
  const flushTelemetrySoon = useCallback(() => {
    setTimeout(() => sendTelemetryRef.current?.(), 150);
  }, []);

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

  const releaseClientRuntime = useCallback(({ status = 'connecting', updateState = true, keepLocalMedia = false, keepPeers = false } = {}) => {
    // 進行中の startClientSessionInner を無効化する（孤児セッション防止）
    sessionGenerationRef.current += 1;
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
      manager.onSystemStateUpdated = null;
      manager.onPeerChannelChanged = null;
      manager.onUpdateCommand = null;
      manager.onPeerJoined = null;
      manager.onIncomingCall = null;
      manager.onPrivateCallStarted = null;
      manager.onPrivateCallEnded = null;
      manager.onCallResult = null;
      manager.onCallCancelled = null;
      manager.onScreenShareEnded = null;
      manager.onSessionRejected = null;
      manager.disconnect();
    }

    // サーバー都合の再起動(keepLocalMedia)では自拠点カメラ/マイクは止めない。
    // producer は stopTracks:false で produce しているため、manager.disconnect で
    // セッションを破棄してもローカルトラックは生き続け、自拠点映像が途切れない。
    if (!keepLocalMedia) {
      stopLocalAudioMonitor();
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // セッション再構築時は画面共有・呼び出し状態もリセット（manager側のトラックは disconnect で閉じる）
    const share = screenShareRef.current;
    if (share) {
      share.stream?.getTracks().forEach(track => track.stop());
      screenShareRef.current = null;
    }
    if (outgoingCallTimerRef.current) {
      clearTimeout(outgoingCallTimerRef.current);
      outgoingCallTimerRef.current = null;
    }
    outgoingCallRef.current = null;

    if (updateState) {
      if (!keepLocalMedia) setLocalStream(null);
      // keepPeers: サーバー都合の再構築中はグリッドを消さず、画面はそのままに
      // 中央のスピナーだけを重ねる。再接続後の同期が古いタイルを回収する。
      if (!keepPeers) setPeers(new Map());
      setViewerPresenceActive(false);
      setScreenShare(null);
      setOutgoingCall(null);
      setPrivateCall(null);
      setSfuStatus(status);
    }
  }, [stopLocalAudioMonitor]);

  const startClientSessionInner = useCallback(async ({ stopPreviousStream = false, reuseLocalMedia = false } = {}) => {
    // 既存セッションが残っていれば必ず破棄してから開始する（1拠点1セッションの保証）。
    // 破棄せず新しい manager を作ると、古い socket が自動再接続を続けて
    // サーバーに同じ拠点が二重に現れる。
    if (webrtcRef.current) {
      releaseClientRuntime({ updateState: false, keepLocalMedia: true });
    }
    // このセッション開始の世代。途中で releaseClientRuntime が走った（＝別の
    // 再起動/切替がセッションを破棄した）ら、以降の処理を中断して孤児化を防ぐ。
    const generation = sessionGenerationRef.current;
    const superseded = () => sessionGenerationRef.current !== generation;
    const conf = sanitizeClientConfig(loadClientConfig());
    configRef.current = conf;
    setSettingsDraft(conf);
    setSelfName(conf.locationName || '自拠点');
    setChannelId(conf.channelId || 'general');

    const devs = await refreshDevices();
    const videoId = conf.selectedVideoId   || devs.video[0]?.deviceId    || '';
    const audioId = conf.selectedAudioInId || devs.audioIn[0]?.deviceId  || '';
    const outId   = conf.selectedAudioOutId|| devs.audioOut[0]?.deviceId || '';
    configRef.current = { ...conf, selectedVideoId: videoId, selectedAudioInId: audioId, selectedAudioOutId: outId };
    setSelectedVideoId(videoId);
    setSelectedAudioInId(audioId);
    setSelectedAudioOutId(outId);

    // サーバー都合の再起動では、生きているローカルメディアをそのまま再利用して
    // 自拠点映像を途切れさせない。トラックが落ちている場合のみ取り直す。
    const existingStream = streamRef.current;
    const existingLive = !!existingStream && existingStream.getTracks().some(track => track.readyState === 'live');
    if (!(reuseLocalMedia && existingLive)) {
      const { stream, error } = await acquireMedia({ videoId, audioId });
      await installLocalStream(stream, error, { stopPrevious: stopPreviousStream });
    }

    if (superseded()) return { manager: null, connectionState: 'superseded' };

    const rtcManager = new WebRTCManager();
    webrtcRef.current = rtcManager;

    rtcManager.onPeerUpdated = (socketId, peer) => {
      setPeers(prev => { const m = new Map(prev); m.set(socketId, peer); return m; });
    };
    rtcManager.onPeerRemoved = (socketId) => {
      const removedPeer = peersRef.current.get(socketId);
      if (removedPeer && removedPeer.appType !== 'viewer') playEffectSound('channelLeave');
      setPeers(prev => { const m = new Map(prev); m.delete(socketId); return m; });
    };
    rtcManager.onConnectionChange = (ok) => {
      if (!ok && sfuStatusRef.current === 'connected') playEffectSound('audioDisconnect');
      sfuStatusRef.current = ok ? 'connected' : 'error';
      setSfuStatus(ok ? 'connected' : 'error');
      if (!ok) setViewerPresenceActive(false);
    };
    rtcManager.onViewerPresenceChange = setViewerPresenceActive;
    rtcManager.onSystemStateUpdated = (state = {}) => {
      setSystemState({ ...DEFAULT_SYSTEM_STATE, ...state });
      const remoteChannels = Array.isArray(state.channels) && state.channels.length ? state.channels : DEFAULT_SYSTEM_STATE.channels;
      const current = configRef.current.channelId || conf.channelId || 'general';
      const selfChannelId = state.self?.channelId || '';
      const selfChannel = remoteChannels.find(channel => channel.id === selfChannelId);
      const selfPrivateCall = state.self?.privateCall || null;

      if (selfChannelId && selfChannel) {
        rtcManager.adoptChannel(selfChannelId);
        setChannelId(selfChannelId);
        if (isPrivateChannel(selfChannel)) {
          setPrivateCall({
            channelId: selfChannelId,
            privateChannelId: selfPrivateCall?.privateChannelId || selfChannelId,
            channelName: selfPrivateCall?.channelName || selfChannel.name || '個別',
            previousChannelId: selfPrivateCall?.previousChannelId || current,
            memberSocketIds: selfPrivateCall?.memberSocketIds || [],
          });
          return;
        }

        const hadPrivateCall = !!privateCallRef.current;
        setPrivateCall(null);
        if (selfChannelId !== current || hadPrivateCall) {
          const nextConfig = { ...sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig()), channelId: selfChannelId };
          configRef.current = nextConfig;
          localStorage.setItem('sfu_config', JSON.stringify(nextConfig));
          setSettingsDraft(nextConfig);
        }
        if (selfChannelId !== channelIdRef.current || hadPrivateCall) playEffectSound('channelMove');
      } else if (!remoteChannels.some(channel => channel.id === current)) {
        const fallback = remoteChannels[0]?.id || 'general';
        configRef.current = { ...configRef.current, channelId: fallback };
        localStorage.setItem('sfu_config', JSON.stringify(configRef.current));
        setSettingsDraft(configRef.current);
        setChannelId(fallback);
        rtcManager.adoptChannel(fallback);
        setPrivateCall(null);
        playEffectSound('channelMove');
      }
    };
    rtcManager.onUpdateCommand = (payload) => {
      if (payload?.appType && payload.appType !== APP_TYPE && payload.appType !== 'all') return;
      setUpdateNotice(payload);
    };
    rtcManager.onPeerJoined = (payload = {}) => {
      if (!payload.socketId || payload.socketId === rtcManager.socket?.id) return;
      if (payload.appType === 'viewer') return;
      playJoinTone();
    };
    rtcManager.onPeerChannelChanged = (payload = {}) => {
      if (!payload.socketId || payload.socketId === rtcManager.socket?.id) return;
      playEffectSound('channelMove');
    };
    rtcManager.onIncomingCall = showIncomingCall;
    rtcManager.onPrivateCallStarted = (payload = {}) => {
      const nextChannelId = payload.channelId || payload.privateChannelId || '';
      if (!nextChannelId) return;
      rtcManager.adoptChannel(nextChannelId);
      setChannelId(nextChannelId);
      setPrivateCall({
        channelId: nextChannelId,
        privateChannelId: payload.privateChannelId || nextChannelId,
        channelName: payload.channelName || '個別',
        previousChannelId: payload.previousChannelId || configRef.current.channelId || 'general',
        memberSocketIds: payload.memberSocketIds || [],
      });
      playEffectSound('channelMove');
    };
    rtcManager.onPrivateCallEnded = (payload = {}) => {
      const returnChannelId = payload.channelId || privateCallRef.current?.previousChannelId || configRef.current.channelId || 'general';
      rtcManager.adoptChannel(returnChannelId);
      const nextConfig = { ...sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig()), channelId: returnChannelId };
      configRef.current = nextConfig;
      localStorage.setItem('sfu_config', JSON.stringify(nextConfig));
      setSettingsDraft(nextConfig);
      setChannelId(returnChannelId);
      setPrivateCall(null);
      playEffectSound('channelMove');
      if (payload.shouldMuteMic !== false) {
        mediaControlsRef.current.setMicrophoneEnabled?.(false)?.catch?.(() => {});
      }
    };

    // 発信した呼び出しの結果（応答/拒否/タイムアウト/切断）→ 鳴動表示を止めて結果を通知
    rtcManager.onCallResult = (payload = {}) => {
      const current = outgoingCallRef.current;
      if (!current || current.callId !== payload.callId) return;
      const name = current.targetName || '相手拠点';
      stopOutgoingCall(payload.callId);
      if (payload.action === 'answered') {
        showCallNotice(`${name} が応答しました`);
        // 発信側も応答を受け取った時点でミュートを解除する（設定でオフ可・既定オン）。
        if (configRef.current?.autoUnmuteOnCallAnswer !== false) {
          mediaControlsRef.current.setMicrophoneEnabled?.(true)?.catch?.(() => {});
          mediaControlsRef.current.setSpeakerOutputEnabled?.(true);
        }
      } else if (payload.action === 'dismissed') showCallNotice(`${name} は応答できませんでした`, 'warn');
      else if (payload.action === 'timeout') showCallNotice(`${name} の応答がありませんでした`, 'warn');
      else if (payload.action === 'disconnected') showCallNotice(`${name} が切断されました`, 'warn');
    };

    // 発信側がキャンセルした → 着信側の鳴動を止める
    rtcManager.onCallCancelled = (payload = {}) => {
      stopIncomingCall(payload.callId || '');
    };

    // 同じ拠点の別端末（二重起動・撤去し忘れ等）が接続中のため、この接続は
    // 受け入れられなかった。manager側が再試行を抑制するので、UIで原因を知らせる。
    rtcManager.onSessionRejected = (payload = {}) => {
      setSfuStatus('error');
      setCamError(`「${payload.locationName || configRef.current.locationName || '同名拠点'}」の別の端末が接続中のため待機しています。別端末のアプリを終了してください。`);
    };

    // 共有元ウィンドウが閉じられた等でトラックが終了した → UIを共有停止状態へ
    rtcManager.onScreenShareEnded = () => {
      const share = screenShareRef.current;
      if (share) {
        share.stream?.getTracks().forEach(track => track.stop());
        screenShareRef.current = null;
        playEffectSound('screenShareStop');
      }
      setScreenShare(null);
      setShareModalMode(null);
    };

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
    // セッション再構築でもプレゼンスモードを維持する（接続後に自動申告される）
    rtcManager.setPresenceMode(presenceModeRef.current).catch(() => {});
    rtcManager.setLocalTracks(
      currentStream?.getVideoTracks()[0] || null,
      currentStream?.getAudioTracks()[0] || null,
    );

    // 接続前に他拠点がどちらのサーバーに集まっているかを確認して寄せる。
    // 再接続のタイミング差で自分だけ別サーバーへ繋がり「他拠点が見えない」
    // 状態になるのを防ぐ（サブ未設定・手動切替直後・判定不能時は現設定のまま）。
    try {
      const occupancyChoice = await chooseServerByOccupancy(configRef.current, {
        manualSelectionAt: manualServerSelectAtRef.current,
      });
      const currentServer = configRef.current.activeServer === 'sub' ? 'sub' : 'main';
      if (occupancyChoice && occupancyChoice !== currentServer) {
        const switched = sanitizeClientConfig({ ...configRef.current, activeServer: occupancyChoice });
        configRef.current = switched;
        localStorage.setItem('sfu_config', JSON.stringify(switched));
        setSettingsDraft(switched);
        console.warn(`[ServerSelect] 他拠点が接続している${occupancyChoice === 'sub' ? 'サブ' : 'メイン'}サーバーへ接続します`);
      }
    } catch (err) {
      console.warn('[ServerSelect]', err.message);
    }

    // 破棄済みなら接続しない。releaseClientRuntime → disconnect 済みの manager で
    // connect() すると _manualDisconnect が解除されて蘇り、孤児セッションになる。
    if (superseded() || webrtcRef.current !== rtcManager) {
      rtcManager.disconnect();
      return { manager: null, connectionState: 'superseded' };
    }

    const serverUrl = serverUrlFromConfig(configRef.current);
    const connectionState = await connectWithinStartupWindow(rtcManager, serverUrl, conf.locationName, {
      channelId: conf.channelId,
      appVersion: APP_VERSION,
      forceTcp: conf.forceTcp === true,
      sendQuality: conf.sendQuality,
      recvQuality: conf.recvQuality,
    });
    if (superseded() || webrtcRef.current !== rtcManager) {
      rtcManager.disconnect();
      return { manager: null, connectionState: 'superseded' };
    }
    setSfuStatus(connectionState === 'connected' ? 'connected' : 'connecting');
    return { manager: rtcManager, connectionState };
  }, [camEnabled, micEnabled, installLocalStream, playEffectSound, playJoinTone, refreshDevices, releaseClientRuntime, showIncomingCall, showCallNotice, stopIncomingCall, stopOutgoingCall]);

  // startClientSessionInner の多重実行ガード。初期化(メディア取得)には数秒かかり、
  // その間にサーバー到達確認ポーリング等が重ねてセッション開始を呼ぶと、
  // 同じ拠点からサーバーへ二重セッションが張られてしまう。
  const startClientSession = useCallback(async (options = {}) => {
    if (sessionStartInFlightRef.current) {
      return { manager: webrtcRef.current, connectionState: 'starting' };
    }
    sessionStartInFlightRef.current = true;
    const run = (async () => {
      try {
        return await startClientSessionInner(options);
      } finally {
        sessionStartInFlightRef.current = false;
        sessionStartPromiseRef.current = null;
      }
    })();
    sessionStartPromiseRef.current = run;
    return run;
  }, [startClientSessionInner]);

  const performQuickRestart = useCallback(async (payload = {}) => {
    // サーバーが「アプリ本体の再起動」を指示してきた場合（5分以上復旧しない拠点への
    // 最終手段）は、アプリ内再構築ではなく Electron の完全再起動を行う。
    if (payload?.mode === 'relaunch' && window.electronAPI?.restartApp) {
      console.warn('[QuickRestart] server requested full app relaunch:', payload?.reason || '');
      window.electronAPI.restartApp();
      return;
    }
    const reason = payload?.reason || payload?.source || 'server-command';
    const forced = payload?.forced || /manual|remote-config|update/.test(reason);

    // 進行中の再起動/セッション確立と重なった場合:
    //  - 通常要求: 進行中の再起動が同じ目的(接続の回復)を果たすので捨てる。
    //  - 強制要求(手動切替・フェイルオーバー・設定変更): 完了を待ってから実行する。
    //    以前はここで無言スキップしており、「トグルはサブ表示なのに実接続はメインのまま」
    //    という設定と実態の不一致が恒久化する取りこぼしの原因だった。
    if (softRestartInFlightRef.current || sessionStartInFlightRef.current) {
      if (!forced) return;
      const waitUntil = Date.now() + 20000;
      while ((softRestartInFlightRef.current || sessionStartInFlightRef.current) && Date.now() < waitUntil) {
        const pending = sessionStartPromiseRef.current;
        if (pending) await pending.catch(() => {});
        else await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // 不安定なVPN経路ではサーバーの restartCommand やクライアント自身の復旧が
    // 短時間に重なりやすい。直前に再起動して既にセッションが健全なら、重複した
    // 再起動要求は無視して常時接続を揺らさない（手動/明示要求は除く）。
    const sinceLast = Date.now() - lastQuickRestartAtRef.current;
    const manager = webrtcRef.current;
    if (!forced && sinceLast < QUICK_RESTART_COOLDOWN_MS && manager?.isSocketConnected() && manager?.isInitialized()) {
      console.log(`[QuickRestart] skipped (healthy, ${sinceLast}ms since last) reason=${reason}`);
      return;
    }
    // サーバー切替系の要求は、待っている間に先行の再起動が目的を果たしている
    // ことがある。既に設定どおりのサーバーへ健全に接続済みなら再実行しない
    // （トグル連打などで同じ再起動を二重に走らせない）。
    if (
      /server-switch|server-failover|server-occupancy|server-config-mismatch/.test(reason) &&
      manager?.isSocketConnected() && manager?.isInitialized() &&
      manager.getServerUrl?.() === serverUrlFromConfig(configRef.current.serverIp ? configRef.current : loadClientConfig())
    ) {
      console.log(`[QuickRestart] skipped (already on desired server) reason=${reason}`);
      return;
    }

    softRestartInFlightRef.current = true;
    lastQuickRestartAtRef.current = Date.now();
    const startedAt = Date.now();
    console.log(`[QuickRestart] requested reason=${reason}`);

    try {
      // サーバー都合の再起動でも自拠点カメラは保持し続ける（要件: 常時自拠点表示）。
      // タイルも消さず、画面はそのままに中央スピナーだけで再構築を伝える。
      releaseClientRuntime({ status: 'restarting', keepLocalMedia: true, keepPeers: true });
      setCamError(null); // 取り直しに失敗すれば installLocalStream が再設定する
      // スピナー描画を待つ小休止。requestAnimationFrame はウィンドウが最小化・
      // 非表示だと発火せず、再構築が「再構築中...」のまま永久に止まる
      // （最小化中の拠点がフェイルオーバー/再起動指示から復帰できない実障害）
      // ため、必ず進む setTimeout を使う。
      await new Promise(resolve => setTimeout(resolve, 50));
      const { connectionState } = await startClientSession({ stopPreviousStream: false, reuseLocalMedia: true });
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

  // ─── サーバー切り替え（サイドバー左下のトグル・設定画面から共用）─────────
  // 手動切替は占有数ベースの自動選択より優先される（MANUAL_SERVER_STICKY_MS の間）。
  // 到達不能時の自動フェイルオーバーは従来どおり常に有効。
  const switchActiveServer = useCallback(async (target) => {
    const conf = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
    const next = target === 'sub' ? 'sub' : 'main';
    const current = conf.activeServer === 'sub' ? 'sub' : 'main';
    if (next === current) return;
    if (next === 'sub' && !conf.subServerIp) return;

    manualServerSelectAtRef.current = Date.now();
    serverFailoverRef.current.lastSwitchAt = Date.now();
    serverFailoverRef.current.downSince = null;

    const nextConf = { ...conf, activeServer: next };
    configRef.current = nextConf;
    localStorage.setItem('sfu_config', JSON.stringify(nextConf));
    setSettingsDraft(nextConf);
    showCallNotice(next === 'sub' ? 'サブサーバーへ切り替えています…' : 'メインサーバーへ切り替えています…');
    await performQuickRestart({ reason: 'manual-server-switch', forced: true });
  }, [performQuickRestart, showCallNotice]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onQuickRestartRequest?.((payload) => {
      softRestartHandlerRef.current?.(payload);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const handleRemoteConfig = (event) => {
      try {
        const previous = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
        const next = sanitizeClientConfig({ ...previous, ...(event.detail || {}) });
        const requiresReconnect =
          previous.serverIp !== next.serverIp ||
          previous.serverPort !== next.serverPort ||
          previous.locationName !== next.locationName;

        configRef.current = next;
        localStorage.setItem('sfu_config', JSON.stringify(next));
        setSelfName(next.locationName || '自拠点');
        setChannelId(next.channelId || 'general');
        setSettingsDraft(next);
        setSettingsOpen(false);

        if (requiresReconnect) {
          softRestartHandlerRef.current?.({ reason: 'remote-config-applied' });
        }
      } catch (err) {
        console.warn('[RemoteConfig]', err.message);
      }
    };

    window.addEventListener('sfu-remote-config-applied', handleRemoteConfig);
    return () => window.removeEventListener('sfu-remote-config-applied', handleRemoteConfig);
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
      const manager = webrtcRef.current;
      manager?.syncPeers();

      // 右上ステータスとマネージャ実態のずれを常時補正する。
      // イベント(onConnectionChange)の取りこぼしや再構築の競合で
      // 「未接続表示なのに他拠点が見える」「接続表示なのに映像が来ない」
      // という不一致が固定化するのを防ぐ。
      const state = manager?.getConnectionState?.();
      if (state === 'connected') {
        if (sfuStatusRef.current !== 'connected') {
          sfuStatusRef.current = 'connected';
          setSfuStatus('connected');
        }
        // 再構築をまたいで残った旧セッションのタイルを回収する
        setPeers(prev => {
          let changed = false;
          const next = new Map();
          for (const [socketId, peer] of prev) {
            if (manager.peers.has(socketId)) next.set(socketId, peer);
            else changed = true;
          }
          return changed ? next : prev;
        });
      } else if (state === 'reconnecting' && sfuStatusRef.current === 'connected') {
        sfuStatusRef.current = 'restarting';
        setSfuStatus('restarting');
      } else if (state === 'disconnected' && sfuStatusRef.current === 'connected') {
        sfuStatusRef.current = 'error';
        setSfuStatus('error');
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ─── 最終手段: 5分間サーバーと確立できなければアプリ本体を再起動 ─────
  // セッション貼り直し/再接続は無限に繰り返すが、レンダラー内の復旧だけでは
  // 直らない状態（ネットワークスタック異常・リソース枯渇など）に備え、
  // APP_RELAUNCH_AFTER_MS 連続で未確立なら Electron ごと再起動して復帰させる。
  useEffect(() => {
    let downSince = null;
    let relaunchRequested = false;
    const id = setInterval(() => {
      const manager = webrtcRef.current;
      const healthy = !!manager?.isSocketConnected() && !!manager?.isInitialized();
      if (healthy) {
        downSince = null;
        return;
      }
      // 重複セッションとして拒否され待機中はネットワーク障害ではないので、
      // アプリ再起動しても解決しない（再起動→再拒否のループになるだけ）
      if (manager?.isSessionRejected?.()) {
        downSince = null;
        return;
      }
      if (downSince == null) {
        downSince = Date.now();
        return;
      }
      if (relaunchRequested || Date.now() - downSince < APP_RELAUNCH_AFTER_MS) return;
      relaunchRequested = true;
      console.error(`[Relaunch] ${Math.round(APP_RELAUNCH_AFTER_MS / 60000)}分間サーバーと確立できないため、アプリを再起動します`);
      if (window.electronAPI?.restartApp) window.electronAPI.restartApp();
      else window.location.reload();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // ─── ルーティン再起動: サーバー同期の指定時刻(HH:MM、複数可)にアプリを再起動 ───
  // 長時間稼働の予防保守。通話・呼び出し・画面共有中は延期し、猶予(10分)内に
  // 終われば実行する。実行済み時刻は localStorage に記録し、再起動後の再発動を防ぐ。
  useEffect(() => {
    const times = Array.isArray(systemState.maintenance?.clientRestartTimes)
      ? systemState.maintenance.clientRestartTimes
      : [];
    if (!times.length || !window.electronAPI?.restartApp) return undefined;

    const check = () => {
      const now = Date.now();
      for (const time of times) {
        const match = /^([0-2]?\d):([0-5]\d)$/.exec(String(time || ''));
        if (!match) continue;
        const scheduled = new Date();
        scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0);
        const scheduledAt = scheduled.getTime();
        const elapsed = now - scheduledAt;
        if (elapsed < ROUTINE_RESTART_JITTER_MS || elapsed > ROUTINE_RESTART_WINDOW_MS) continue;
        // この時刻より後に起動したアプリは対象外（起動直後の再起動ループ防止）
        if (APP_STARTED_AT >= scheduledAt) continue;
        let last = 0;
        try { last = Number(localStorage.getItem(ROUTINE_RESTART_KEY)) || 0; } catch { /* ignore */ }
        if (last >= scheduledAt) continue; // この回は実行済み
        // 使用中（通話/発着信/画面共有）は延期。猶予内の次のチェックで再評価する
        if (privateCallRef.current || outgoingCallRef.current || activeIncomingCallIdRef.current || screenShareRef.current) return;
        try { localStorage.setItem(ROUTINE_RESTART_KEY, String(scheduledAt)); } catch { /* ignore */ }
        console.warn(`[Maintenance] ルーティン再起動を実行します (${time})`);
        window.electronAPI.restartApp();
        return;
      }
    };

    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, [systemState]);

  // ─── サーバー到達確認: オフライン復帰を1秒周期で拾う ─────────────
  // あわせて自動フェイルオーバーを行う: 現在のサーバーに一定時間到達できず、
  // もう一方（メイン⇄サブ）のサーバーが応答する場合は自動で切り替えて再接続する。
  useEffect(() => {
    const id = setInterval(async () => {
      if (softRestartInFlightRef.current || serverProbeInFlightRef.current) return;
      const manager = webrtcRef.current;
      if (manager?.isSocketConnected() && manager?.isInitialized()) {
        serverFailoverRef.current.downSince = null;
        // 設定上の接続先と実接続先の不一致を自己修復する。手動切替・フェイルオーバーが
        // 進行中の再起動と競合して取りこぼされた場合の最終防衛線（5秒連続で不一致なら再接続）。
        const desiredUrl = serverUrlFromConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
        const actualUrl = manager.getServerUrl?.() || '';
        if (actualUrl && desiredUrl && actualUrl !== desiredUrl) {
          serverUrlMismatchRef.current += 1;
          if (serverUrlMismatchRef.current >= 5) {
            serverUrlMismatchRef.current = 0;
            console.warn(`[ServerSelect] 設定(${desiredUrl})と実接続(${actualUrl})の不一致を検出。接続し直します`);
            await softRestartHandlerRef.current?.({ reason: 'server-config-mismatch', forced: true });
          }
        } else {
          serverUrlMismatchRef.current = 0;
        }
        return;
      }
      serverUrlMismatchRef.current = 0;
      // 重複セッション拒否の待機中: サーバーは正常なので到達確認・フェイルオーバー・
      // 再接続促進はすべて不要（managerが待機明けに自動で再試行する）
      if (manager?.isSessionRejected?.()) {
        serverFailoverRef.current.downSince = null;
        return;
      }

      serverProbeInFlightRef.current = true;
      try {
        const conf = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
        const reachable = await probeServerReady(conf);
        if (!reachable) {
          setSfuStatus(prev => (prev === 'restarting' ? prev : 'error'));

          // ── 自動フェイルオーバー判定 ──
          const failover = serverFailoverRef.current;
          const now = Date.now();
          if (failover.downSince == null) failover.downSince = now;
          const otherServer = conf.activeServer === 'sub' ? 'main' : 'sub';
          const otherConfigured = otherServer === 'sub' ? !!conf.subServerIp : !!conf.serverIp;
          if (
            otherConfigured &&
            now - failover.downSince >= FAILOVER_AFTER_MS &&
            now - failover.lastSwitchAt >= FAILOVER_COOLDOWN_MS
          ) {
            const candidate = { ...conf, activeServer: otherServer };
            const candidateReachable = await probeServerReady(candidate);
            if (candidateReachable) {
              failover.lastSwitchAt = Date.now();
              failover.downSince = null;
              configRef.current = candidate;
              localStorage.setItem('sfu_config', JSON.stringify(candidate));
              setSettingsDraft(candidate);
              showCallNotice(
                otherServer === 'sub'
                  ? 'メインサーバーに接続できないため、サブサーバーへ切り替えます'
                  : 'サブサーバーに接続できないため、メインサーバーへ切り替えます',
                'warn',
              );
              console.warn(`[Failover] switching to ${otherServer} server`);
              await softRestartHandlerRef.current?.({ reason: 'server-failover', forced: true });
            }
          }
          return;
        }

        const wasDownFor = serverFailoverRef.current.downSince == null
          ? 0
          : Date.now() - serverFailoverRef.current.downSince;
        serverFailoverRef.current.downSince = null;
        setSfuStatus(prev => (prev === 'connected' ? prev : 'connecting'));

        // 長い断のあとの復帰: その間に他拠点が別サーバーへフェイルオーバーして
        // いる可能性があるため、繋ぎ直す前に占有数を確認して同じサーバーへ寄せる
        if (manager && wasDownFor >= FAILOVER_AFTER_MS) {
          const occupancyChoice = await chooseServerByOccupancy(conf, {
            manualSelectionAt: manualServerSelectAtRef.current,
          });
          const currentServer = conf.activeServer === 'sub' ? 'sub' : 'main';
          if (occupancyChoice && occupancyChoice !== currentServer) {
            serverFailoverRef.current.lastSwitchAt = Date.now();
            const switched = sanitizeClientConfig({ ...conf, activeServer: occupancyChoice });
            configRef.current = switched;
            localStorage.setItem('sfu_config', JSON.stringify(switched));
            setSettingsDraft(switched);
            showCallNotice(
              occupancyChoice === 'sub'
                ? '他拠点が接続しているサブサーバーへ切り替えます'
                : '他拠点が接続しているメインサーバーへ切り替えます',
              'warn',
            );
            console.warn(`[Failover] occupancy-based switch to ${occupancyChoice}`);
            await softRestartHandlerRef.current?.({ reason: 'server-occupancy-switch', forced: true });
            return;
          }
        }

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
  }, [startClientSession, showCallNotice]);

  // ─── 占有数の再収束: 「自分だけ別サーバー」の分裂を自己修復 ──────────
  // occupancy 判定は接続時にしか走らないため、再起動タイミングの差で一度分裂すると
  // 次の接続イベントまで（最悪、翌日のルーティン再起動まで）残ってしまう。
  // 健全稼働中も低頻度で確認し、「現サーバーに他の会議アプリが0・もう一方には居る」
  // 状態が3回(約3分)続いた時だけ寄せる。サブ→メインは1拠点でも寄り、
  // メイン→サブは2拠点以上で寄る片方向ルールにして、1対1で互いに
  // 移動し合う発振（スワップ）を構造的に起こさない。
  useEffect(() => {
    const id = setInterval(async () => {
      if (softRestartInFlightRef.current || sessionStartInFlightRef.current || serverProbeInFlightRef.current) return;
      const manager = webrtcRef.current;
      if (!manager?.isSocketConnected() || !manager?.isInitialized()) {
        reconvergeStrikesRef.current = 0;
        return;
      }
      const conf = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
      if (!conf.subServerIp) return;
      if (Date.now() - manualServerSelectAtRef.current < MANUAL_SERVER_STICKY_MS) {
        reconvergeStrikesRef.current = 0;
        return;
      }
      // 通話・呼び出し・画面共有中はサーバーを移動しない
      if (privateCallRef.current || outgoingCallRef.current || activeIncomingCallIdRef.current || screenShareRef.current) {
        reconvergeStrikesRef.current = 0;
        return;
      }

      const current = conf.activeServer === 'sub' ? 'sub' : 'main';
      const other = current === 'main' ? 'sub' : 'main';
      const [cur, oth] = await Promise.all([
        probeServerPresence(conf),
        probeServerPresence({ ...conf, activeServer: other }),
      ]);
      if (!cur.reachable || !oth.reachable) {
        reconvergeStrikesRef.current = 0;
        return;
      }
      const othersHere = Math.max(0, cur.clientAppCount - 1); // 自分を除いた会議アプリ数
      const there = oth.clientAppCount;
      const shouldMove = othersHere === 0 && (other === 'main' ? there >= 1 : there >= 2);
      if (!shouldMove) {
        reconvergeStrikesRef.current = 0;
        return;
      }
      reconvergeStrikesRef.current += 1;
      if (reconvergeStrikesRef.current < 3) return;
      reconvergeStrikesRef.current = 0;

      serverFailoverRef.current.lastSwitchAt = Date.now();
      const switched = sanitizeClientConfig({ ...conf, activeServer: other });
      configRef.current = switched;
      localStorage.setItem('sfu_config', JSON.stringify(switched));
      setSettingsDraft(switched);
      showCallNotice(other === 'sub'
        ? '他拠点が接続しているサブサーバーへ移動します'
        : '他拠点が接続しているメインサーバーへ移動します');
      console.warn(`[ServerSelect] occupancy reconverge to ${other} (here=${othersHere}, there=${there})`);
      await softRestartHandlerRef.current?.({ reason: 'server-occupancy-reconverge', forced: true });
    }, 60000);
    return () => clearInterval(id);
  }, [showCallNotice]);

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
      if (type === 'audioIn') playEffectSound('audioDeviceChange');
      flushTelemetrySoon();
    } catch (err) {
      console.error('[changeDevice]', err);
    }
  }, [installLocalStream, selectedVideoId, selectedAudioInId, flushTelemetrySoon, playEffectSound]);

  const changeSpeaker = useCallback((deviceId) => {
    setSelectedAudioOutId(deviceId);
    const conf = { ...configRef.current, selectedAudioOutId: deviceId };
    configRef.current = conf;
    localStorage.setItem('sfu_config', JSON.stringify(conf));
    playEffectSound('audioDeviceChange');
    flushTelemetrySoon();
  }, [flushTelemetrySoon, playEffectSound]);

  const setCameraEnabled = useCallback(async (enabled) => {
    const next = !!enabled;
    streamRef.current?.getVideoTracks().forEach(t => (t.enabled = next));
    setCamEnabled(next);
    await webrtcRef.current?.setCamEnabled(next);
    flushTelemetrySoon();
  }, [flushTelemetrySoon]);

  const setMicrophoneEnabled = useCallback(async (enabled) => {
    const next = !!enabled;
    const previous = micEnabledRef.current;
    streamRef.current?.getAudioTracks().forEach(t => (t.enabled = next));
    micEnabledRef.current = next;
    setMicEnabled(next);
    await webrtcRef.current?.setMicEnabled(next);
    if (previous !== next) playEffectSound(next ? 'micUnmute' : 'micMute');
    flushTelemetrySoon();
  }, [flushTelemetrySoon, playEffectSound]);

  const setSpeakerOutputEnabled = useCallback((enabled) => {
    const nextMuted = !enabled;
    const previousMuted = speakerMutedRef.current;
    speakerMutedRef.current = nextMuted;
    setSpeakerMuted(nextMuted);
    if (previousMuted !== nextMuted) playEffectSound(nextMuted ? 'speakerMute' : 'speakerUnmute');
    flushTelemetrySoon();
  }, [flushTelemetrySoon, playEffectSound]);

  useEffect(() => {
    mediaControlsRef.current.setMicrophoneEnabled = setMicrophoneEnabled;
    mediaControlsRef.current.setSpeakerOutputEnabled = setSpeakerOutputEnabled;
  }, [setMicrophoneEnabled, setSpeakerOutputEnabled]);

  const endPrivateCall = useCallback(async () => {
    try {
      const result = await webrtcRef.current?.endPrivateCall();
      const returnChannelId = result?.channelId || privateCallRef.current?.previousChannelId || configRef.current.channelId || 'general';
      if (returnChannelId) {
        const nextConfig = { ...sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig()), channelId: returnChannelId };
        configRef.current = nextConfig;
        localStorage.setItem('sfu_config', JSON.stringify(nextConfig));
        setSettingsDraft(nextConfig);
        setChannelId(returnChannelId);
        webrtcRef.current?.adoptChannel(returnChannelId);
      }
      setPrivateCall(null);
      await setMicrophoneEnabled(false);
    } catch (err) {
      console.warn('[endPrivateCall]', err.message);
      setCamError(`通話終了に失敗しました: ${err.message}`);
    }
  }, [setMicrophoneEnabled]);

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
      // 自拠点アンテナ表示の更新（未接続時は0=切断表示）
      setSelfSignalLevel(manager?.getSelfSignalLevel?.() ?? 0);
      if (!manager) return;
      const state = telemetryStateRef.current;
      const stream = streamRef.current;
      const videoTrack = stream?.getVideoTracks()[0] || null;
      const audioTrack = stream?.getAudioTracks()[0] || null;
      const remotePeers = Array.from((state.peers || new Map()).entries()).map(([socketId, peer]) => {
        const video = peer.stream?.getVideoTracks()[0] || null;
        const audio = peer.stream?.getAudioTracks()[0] || null;
        const screen = peer.screenStream?.getVideoTracks()[0] || null;
        const screenAudio = peer.screenStream?.getAudioTracks()[0] || null;
        const sameChannel = (peer.channelId || 'general') === (state.channelId || 'general');
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
          receivingAudio: !!audio && audio.readyState === 'live' && !peer.audioPaused && sameChannel,
          receivingScreen: !!screen && screen.readyState === 'live' && !peer.screenPaused,
          receivingScreenAudio: !!screenAudio && screenAudio.readyState === 'live' && !peer.screenAudioPaused,
        };
      });

      manager.sendTelemetry({
        appType: 'client',
        appVersion: APP_VERSION,
        channelId: state.channelId,
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
          receivingVideoCount: remotePeers.filter(peer => peer.receivingVideo || peer.receivingScreen).length,
          receivingAudioCount: remotePeers.filter(peer => peer.receivingAudio).length,
          peers: remotePeers,
        },
        connection: {
          appStatus: state.sfuStatus,
        },
      });
    };

    sendTelemetryRef.current = sendTelemetry;
    sendTelemetry();
    const id = setInterval(sendTelemetry, 1000);
    return () => {
      clearInterval(id);
      sendTelemetryRef.current = null;
    };
  }, []);

  // ─── カメラ ON/OFF ────────────────────────────────────────
  const toggleCam = useCallback(async () => {
    setCameraEnabled(!camEnabled).catch(() => {});
  }, [camEnabled, setCameraEnabled]);

  // ─── マイク ON/OFF ────────────────────────────────────────
  const toggleMic = useCallback(async () => {
    setMicrophoneEnabled(!micEnabled).catch(() => {});
  }, [micEnabled, setMicrophoneEnabled]);

  // ─── プレゼンスモード（商談中/不在/帰宅）────────────────────
  // 同じモードをもう一度押すと解除。モードは排他（同時に1つ）で、
  // サーバー経由で全拠点へ配信され、各拠点のタイルにバッジ表示される。
  const togglePresenceMode = useCallback((mode) => {
    const next = presenceModeRef.current === mode ? 'none' : mode;
    presenceModeRef.current = next;
    setPresenceMode(next);
    webrtcRef.current?.setPresenceMode(next)?.catch?.(() => {});
  }, []);

  // ─── カスタム着信音の管理 ──────────────────────────────────
  const applyCustomRingtone = useCallback((ringtone) => {
    if (saveCustomRingtone(ringtone)) {
      setCustomRingtone(ringtone);
      setRingtoneNotice(ringtone ? `「${ringtone.name}」を着信音に設定しました` : '既定の着信音に戻しました');
    } else {
      setRingtoneNotice('保存に失敗しました。ファイルサイズを小さくして再度お試しください。');
    }
  }, []);

  const importRingtoneFile = useCallback(async (file) => {
    if (!file) return;
    const isAudio = /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name) || String(file.type).startsWith('audio/');
    if (!isAudio) {
      setRingtoneNotice('mp3 / wav などの音声ファイルを選択してください');
      return;
    }
    if (file.size > RINGTONE_MAX_BYTES) {
      setRingtoneNotice('ファイルが大きすぎます（3MB以下の音声を選択してください）');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      applyCustomRingtone({ name: file.name, dataUrl });
    } catch (err) {
      setRingtoneNotice(`読み込みに失敗しました: ${err.message}`);
    }
  }, [applyCustomRingtone]);

  /** サーバーの ringtones フォルダにある通知音一覧を取得する（設定画面表示時） */
  const fetchServerRingtones = useCallback(async () => {
    setServerRingtones(null);
    try {
      const conf = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
      const res = await fetch(`${serverUrlFromConfig(conf)}/ringtones`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setServerRingtones(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      console.warn('[ringtones]', err.message);
      setServerRingtones([]);
    }
  }, []);

  /** サーバー配布の通知音をダウンロードしてローカルに保存し、着信音として使う */
  const importServerRingtone = useCallback(async (name) => {
    try {
      const conf = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
      const res = await fetch(`${serverUrlFromConfig(conf)}/ringtones/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size > RINGTONE_MAX_BYTES) throw new Error('ファイルが大きすぎます（3MB以下）');
      const dataUrl = await readFileAsDataUrl(blob);
      applyCustomRingtone({ name, dataUrl });
    } catch (err) {
      setRingtoneNotice(`取り込みに失敗しました: ${err.message}`);
    }
  }, [applyCustomRingtone]);

  const openSettingsPanel = useCallback(() => {
    const current = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
    setSettingsDraft(current);
    setRingtoneNotice('');
    setSettingsOpen(true);
    fetchServerRingtones();
  }, [fetchServerRingtones]);

  const updateSettingsDraft = useCallback((key, value) => {
    setSettingsDraft(prev => ({ ...prev, [key]: value }));
  }, []);

  const saveSettingsDraft = useCallback(async () => {
    const previous = sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
    const next = sanitizeClientConfig({ ...configRef.current, ...settingsDraft });
    const requiresReconnect =
      // 使用サーバー(メイン/サブ)の切替やIP/ポート変更で接続先URLが変わる場合
      serverUrlFromConfig(previous) !== serverUrlFromConfig(next) ||
      previous.locationName !== next.locationName ||
      // TCP切替と送信画質は transport/producer の再作成が必要
      previous.forceTcp !== next.forceTcp ||
      previous.sendQuality !== next.sendQuality;
    const channelChanged = previous.channelId !== next.channelId;
    const recvQualityChanged = previous.recvQuality !== next.recvQuality;

    // 設定画面からのサーバー切替も手動選択として扱い、占有数ベースの
    // 自動選択でしばらく上書きされないようにする
    if (previous.activeServer !== next.activeServer) {
      manualServerSelectAtRef.current = Date.now();
      serverFailoverRef.current.lastSwitchAt = Date.now();
    }

    configRef.current = next;
    localStorage.setItem('sfu_config', JSON.stringify(next));
    setSelfName(next.locationName || '自拠点');
    setChannelId(next.channelId || 'general');
    setHighlightSelfMuted(next.highlightSelfMuted);
    setSettingsDraft(next);
    setSettingsOpen(false);

    if (requiresReconnect) {
      await performQuickRestart({ reason: 'settings-updated' });
    } else {
      if (channelChanged) {
        await webrtcRef.current?.setChannel(next.channelId);
        playEffectSound('channelMove');
      }
      // 受信画質は再接続不要（サーバー側のレイヤ選択で即時反映）
      if (recvQualityChanged) await webrtcRef.current?.setRecvQuality(next.recvQuality);
    }
  }, [performQuickRestart, settingsDraft, playEffectSound]);

  const changeChannel = useCallback(async (nextChannelId) => {
    const nextId = nextChannelId || channels[0]?.id || 'general';
    const targetChannel = channels.find(channel => channel.id === nextId);
    if (isPrivateChannel(targetChannel)) return;
    const previousId = configRef.current.channelId || channelId || 'general';
    const nextConfig = { ...sanitizeClientConfig(configRef.current.serverIp ? configRef.current : loadClientConfig()), channelId: nextId };
    configRef.current = nextConfig;
    localStorage.setItem('sfu_config', JSON.stringify(nextConfig));
    setSettingsDraft(nextConfig);
    setChannelId(nextId);
    try {
      await webrtcRef.current?.setChannel(nextId);
    } catch (err) {
      console.warn('[setChannel]', err.message);
    }
    if (previousId !== nextId) playEffectSound('channelMove');
  }, [channelId, channels, playEffectSound]);

  const answerIncomingCall = useCallback(async (call) => {
    const targetChannelId = call?.fromChannelId || '';
    stopIncomingCall(call?.callId || '');
    // 発信側の鳴動表示を止める（失敗しても応答処理は続行）
    const ackResult = await webrtcRef.current?.ackCall(call?.callId, 'answered').catch(() => null);
    // 着信側も応答した時点でミュートを解除する（設定でオフ可・既定オン）。
    if (configRef.current?.autoUnmuteOnCallAnswer !== false) {
      mediaControlsRef.current.setMicrophoneEnabled?.(true)?.catch?.(() => {});
      mediaControlsRef.current.setSpeakerOutputEnabled?.(true);
    }
    if (call?.callMode === 'private' || call?.privateChannelId || ackResult?.privateChannelId) return;
    if (!targetChannelId || targetChannelId === activeChannelId) return;
    if (!channels.some(channel => channel.id === targetChannelId)) return;
    await changeChannel(targetChannelId);
  }, [activeChannelId, changeChannel, channels, stopIncomingCall]);

  const dismissIncomingCall = useCallback((call) => {
    stopIncomingCall(call?.callId || '');
    // 発信側へ「応答なし」を通知して鳴動表示を止める
    webrtcRef.current?.ackCall(call?.callId, 'dismissed').catch(() => {});
  }, [stopIncomingCall]);

  // ─── キーボードショートカット ──────────────────────────────
  // 数字キー1-9はチャンネル一覧の並び順に固定（設定不可）。マイク/スピーカー/
  // カメラ/着信応答のキーは設定画面で変更できる(既定 M/S/C/Enter)。
  // 設定画面を開いている間やテキスト入力中は無効化し、意図しない発火を防ぐ。
  // アプリ内確認ダイアログのキーボード操作（Enter=実行 / Esc=キャンセル）
  useEffect(() => {
    if (!confirmDialog) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConfirmDialog(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const dialog = confirmDialog;
        setConfirmDialog(null);
        dialog.onConfirm?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDialog]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (settingsOpen || confirmDialog) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;

      const shortcuts = configRef.current?.shortcuts || defaultShortcuts;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      // 着信中は応答キーを最優先で処理する（既定 Enter）
      if (incomingCall && key === (shortcuts.callAnswer || 'Enter')) {
        event.preventDefault();
        answerIncomingCall(incomingCall);
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        const channelTarget = channels[Number(event.key) - 1];
        if (channelTarget) {
          event.preventDefault();
          changeChannel(channelTarget.id);
        }
        return;
      }

      if (key === shortcuts.micToggle) {
        event.preventDefault();
        toggleMic();
      } else if (key === shortcuts.speakerToggle) {
        event.preventDefault();
        setSpeakerOutputEnabled(speakerMuted);
      } else if (key === shortcuts.cameraToggle) {
        event.preventDefault();
        toggleCam();
      } else if (key === (shortcuts.busyMode || 'u')) {
        event.preventDefault();
        togglePresenceMode('busy');
      } else if (key === (shortcuts.awayMode || 'i')) {
        event.preventDefault();
        togglePresenceMode('away');
      } else if (key === (shortcuts.goHomeMode || 'o')) {
        event.preventDefault();
        togglePresenceMode('gohome');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [settingsOpen, confirmDialog, channels, changeChannel, toggleMic, toggleCam, setSpeakerOutputEnabled, speakerMuted, incomingCall, answerIncomingCall, togglePresenceMode]);

  const createChannel = useCallback(async (event) => {
    event?.preventDefault?.();
    const name = newChannelName.trim();
    if (!name) return;

    try {
      const result = await webrtcRef.current?.createChannel(name);
      if (result?.systemState) setSystemState({ ...DEFAULT_SYSTEM_STATE, ...result.systemState });
      setNewChannelName('');
      setChannelEditorOpen(false);
      if (result?.channel?.id) await changeChannel(result.channel.id);
    } catch (err) {
      console.warn('[createChannel]', err.message);
      setCamError(`チャンネル作成に失敗しました: ${err.message}`);
    }
  }, [changeChannel, newChannelName]);

  const updateChannelDraft = useCallback((channelId, value) => {
    setChannelDrafts(prev => ({ ...prev, [channelId]: value }));
  }, []);

  const renameChannel = useCallback(async (targetChannelId) => {
    const currentChannel = channels.find(channel => channel.id === targetChannelId);
    const name = String(channelDrafts[targetChannelId] ?? currentChannel?.name ?? '').trim();
    if (!targetChannelId || !name) return;

    try {
      const result = await webrtcRef.current?.updateChannel(targetChannelId, name);
      if (result?.systemState) setSystemState({ ...DEFAULT_SYSTEM_STATE, ...result.systemState });
      setChannelDrafts(prev => ({ ...prev, [targetChannelId]: name }));
    } catch (err) {
      console.warn('[updateChannel]', err.message);
      setCamError(`チャンネル名の変更に失敗しました: ${err.message}`);
    }
  }, [channelDrafts, channels]);

  const deleteChannel = useCallback(async (targetChannelId) => {
    if (!targetChannelId || channels.length <= 1) return;
    const target = channels.find(channel => channel.id === targetChannelId);
    const confirmed = window.confirm(`「${target?.name || targetChannelId}」を削除しますか？`);
    if (!confirmed) return;

    try {
      const result = await webrtcRef.current?.deleteChannel(targetChannelId);
      if (result?.systemState) setSystemState({ ...DEFAULT_SYSTEM_STATE, ...result.systemState });
      if (targetChannelId === channelId) {
        await changeChannel(result?.fallbackChannelId || result?.systemState?.channels?.[0]?.id || 'general');
      }
    } catch (err) {
      console.warn('[deleteChannel]', err.message);
      setCamError(`チャンネル削除に失敗しました: ${err.message}`);
    }
  }, [changeChannel, channelId, channels]);

  const handleTileFocus = useCallback((tileId) => {
    if (!tileId) return;
    setFocusedTileId(prev => (prev === tileId ? '' : tileId));
  }, []);

  const getTileVolume = useCallback((tileId) => {
    const value = peerVolumes[tileId];
    return Number.isFinite(value) ? value : 1;
  }, [peerVolumes]);

  const handleTileVolumeChange = useCallback((tileId, value) => {
    const nextValue = clampNumber(value, 0, 1.5);
    const currentValue = getTileVolume(tileId);
    if ((currentValue > 0) !== (nextValue > 0)) {
      playEffectSound(nextValue > 0 ? 'speakerUnmute' : 'speakerMute');
    }
    setPeerVolumes(prev => ({ ...prev, [tileId]: nextValue }));
  }, [getTileVolume, playEffectSound]);

  const openMemberMenu = useCallback((event, member, channel) => {
    if (member.isSelf || !member.socketId) return;
    event.preventDefault();
    event.stopPropagation();
    setMemberMenu({
      socketId: member.socketId,
      memberName: member.name,
      channelId: member.channelId || channel.id,
      x: Math.min(event.clientX, Math.max(16, window.innerWidth - 286)),
      y: Math.min(event.clientY, Math.max(16, window.innerHeight - 320)),
    });
  }, []);

  const cancelOutgoingCall = useCallback(async () => {
    const current = outgoingCallRef.current;
    if (!current) return;
    stopOutgoingCall();
    showCallNotice('呼び出しをキャンセルしました');
    try {
      await webrtcRef.current?.cancelCall(current.callId);
    } catch {
      // 相手が既に応答/切断していた場合は何もしない
    }
  }, [showCallNotice, stopOutgoingCall]);

  const callMember = useCallback(async (socketId) => {
    if (!socketId) return;
    setMemberMenu(null);

    // 同じ相手をもう一度押したらキャンセル、別の相手なら先にキャンセルしてから発信
    const current = outgoingCallRef.current;
    if (current) {
      const sameTarget = current.targetSocketId === socketId;
      stopOutgoingCall();
      try { await webrtcRef.current?.cancelCall(current.callId); } catch { /* 既に終了 */ }
      if (sameTarget) {
        showCallNotice('呼び出しをキャンセルしました');
        return;
      }
    }

    const targetPeer = peers.get(socketId);
    const targetName = targetPeer?.locationName || '相手拠点';

    const startCall = async () => {
      try {
        const result = await webrtcRef.current?.callPeer(socketId);
        const callId = result?.callId || '';
        if (!callId) throw new Error('呼び出しIDを取得できませんでした');

        const call = { callId, targetSocketId: socketId, targetName, startedAt: Date.now() };
        outgoingCallRef.current = call;
        setOutgoingCall(call);
        startLoopingSystemSound('outgoingCall', { volume: ringVolumeScale() });

        // サーバー通知が届かない場合のフォールバック（サーバー側タイムアウトと同じ30秒）
        if (outgoingCallTimerRef.current) clearTimeout(outgoingCallTimerRef.current);
        outgoingCallTimerRef.current = setTimeout(() => {
          if (outgoingCallRef.current?.callId !== callId) return;
          stopOutgoingCall(callId);
          showCallNotice(`${targetName} の応答がありませんでした`, 'warn');
        }, CALL_RING_TIMEOUT_MS + 2000);
      } catch (err) {
        console.warn('[callPeer]', err.message);
        setCamError(`呼び出しに失敗しました: ${err.message}`);
      }
    };

    // 相手が商談中モードの場合はアプリ内ダイアログで確認してから呼び出す
    if (targetPeer?.presenceMode === 'busy') {
      setConfirmDialog({
        title: '商談中の拠点への呼び出し',
        message: `${targetName} は商談中です。本当に呼び出しますか？`,
        confirmLabel: '呼び出す',
        onConfirm: startCall,
      });
      return;
    }

    await startCall();
  }, [peers, ringVolumeScale, showCallNotice, stopOutgoingCall]);

  const moveMemberToChannel = useCallback(async (socketId, nextChannelId) => {
    if (!socketId || !nextChannelId) return;
    try {
      const result = await webrtcRef.current?.movePeerToChannel(socketId, nextChannelId);
      if (result?.systemState) setSystemState({ ...DEFAULT_SYSTEM_STATE, ...result.systemState });
      playEffectSound('channelMove');
      setPeers(prev => {
        const next = new Map(prev);
        const peer = next.get(socketId);
        if (peer) next.set(socketId, { ...peer, channelId: result?.channelId || nextChannelId });
        return next;
      });
      setMemberMenu(prev => (prev ? { ...prev, channelId: result?.channelId || nextChannelId } : prev));
    } catch (err) {
      console.warn('[movePeerToChannel]', err.message);
      setCamError(`チャンネル移動に失敗しました: ${err.message}`);
    }
  }, [playEffectSound]);

  const toggleMemberSpeakerMute = useCallback((socketId) => {
    if (!socketId) return;
    const tileId = `peer:${socketId}`;
    setPeerVolumes(prev => {
      const current = Number.isFinite(prev[tileId]) ? prev[tileId] : 1;
      return { ...prev, [tileId]: current > 0 ? 0 : 1 };
    });
  }, []);

  const startSidebarResize = useCallback((event) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const onMove = (moveEvent) => {
      const nextWidth = clampNumber(startWidth + moveEvent.clientX - startX, 196, 360);
      setSidebarWidth(nextWidth);
      try {
        localStorage.setItem('client_sidebar_width', String(nextWidth));
      } catch {
        // 保存できない環境では当該セッションだけ反映する。
      }
    };
    const onUp = () => {
      document.body.classList.remove('resizing-sidebar');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    document.body.classList.add('resizing-sidebar');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
  }, [sidebarCollapsed, sidebarWidth]);

  const openUpdate = useCallback(() => {
    let url = updateNotice?.packageInfo?.url || updatePackage?.url;
    if (!url) return;
    // サーバー配布の相対パス（/updates/...）は接続中サーバーのURLで解決する
    if (!/^https?:\/\//i.test(url)) {
      const base = serverUrlFromConfig(configRef.current.serverIp ? configRef.current : loadClientConfig());
      url = `${base}${url.startsWith('/') ? '' : '/'}${url}`;
    }
    window.electronAPI?.openExternal?.(url);
  }, [updateNotice, updatePackage]);

  // ─── 画面共有（Client内蔵）──────────────────────────────
  const stopScreenShare = useCallback(async () => {
    const share = screenShareRef.current;
    screenShareRef.current = null;
    setScreenShare(null);
    try {
      await webrtcRef.current?.stopScreenShare();
    } catch (err) {
      console.warn('[stopScreenShare]', err.message);
    }
    // manager 側でも止めるが、開始直後の失敗などに備えてUI側でも確実に止める
    share?.stream?.getTracks().forEach(track => { try { track.stop(); } catch { /* ignore */ } });
    if (share) playEffectSound('screenShareStop');
  }, [playEffectSound]);

  const startScreenShareFromSource = useCallback(async (source, withAudio) => {
    setShareModalMode(null);
    if (!source?.id) return;

    try {
      // Electron では chromeMediaSourceId 指定の getUserMedia で画面をキャプチャする。
      // 音声ループバックは Windows のみ対応（macはOS制約）。
      const constraints = {
        audio: withAudio && window.electronAPI?.platform === 'win32'
          ? { mandatory: { chromeMediaSource: 'desktop' } }
          : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: 15,
          },
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const videoTrack = stream.getVideoTracks()[0] || null;
      const audioTrack = stream.getAudioTracks()[0] || null;
      if (!videoTrack) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('共有映像を取得できませんでした');
      }

      const previous = screenShareRef.current;
      await webrtcRef.current?.startScreenShare(videoTrack, source.name, audioTrack);

      // 共有元変更時は旧ストリームを止める（manager は producer のみ閉じる）
      previous?.stream?.getTracks().forEach(track => { try { track.stop(); } catch { /* ignore */ } });

      const next = {
        sourceId: source.id,
        sourceName: source.name || '画面共有',
        hasAudio: !!audioTrack,
        audioEnabled: !!audioTrack,
        paused: false,
        stream,
      };
      screenShareRef.current = next;
      setScreenShare(next);
      setCamError(null);
      playEffectSound('screenShareStart');
    } catch (err) {
      console.error('[ScreenShare]', err);
      setCamError(`画面共有を開始できませんでした: ${err.message}`);
    }
  }, [playEffectSound]);

  const toggleSharePause = useCallback(async () => {
    const share = screenShareRef.current;
    if (!share) return;
    const paused = !share.paused;
    const next = { ...share, paused };
    screenShareRef.current = next;
    setScreenShare(next);
    try {
      await webrtcRef.current?.setScreenSharePaused(paused);
    } catch (err) {
      console.warn('[toggleSharePause]', err.message);
    }
  }, []);

  const toggleShareAudio = useCallback(async () => {
    const share = screenShareRef.current;
    if (!share?.hasAudio) return;
    const audioEnabled = !share.audioEnabled;
    share.stream?.getAudioTracks().forEach(track => { track.enabled = audioEnabled; });
    const next = { ...share, audioEnabled };
    screenShareRef.current = next;
    setScreenShare(next);
    try {
      await webrtcRef.current?.setScreenAudioEnabled(audioEnabled);
    } catch (err) {
      console.warn('[toggleShareAudio]', err.message);
    }
  }, []);

  // ─── グリッド ────────────────────────────────────────────
  const videoTiles = useMemo(() => {
    const tiles = [{
      id: 'self',
      // タイルのキーは socketId ベースで固定（再接続のたびに変える key にすると
      // <video> 要素が作り直され、一瞬の黒画面や再接続を繰り返すデコーダ生成/破棄
      // によるGPUプロセスのメモリ増加を招く）。stream の切り替えは VideoCell 内の
      // srcObject 差し替え effect が担う。
      key: 'self',
      label: selfName,
      stream: localStream,
      isSelf: true,
      videoPaused: !camEnabled,
      audioPaused: !micEnabled,
      speakerMuted: false,
      sameChannel: true,
      channelId: activeChannelId,
      presenceMode,
      signalLevel: selfSignalLevel,
      canControlVolume: false,
      baseVolume: 0,
      sortRank: 0,
    }];

    // 自分の共有映像は受信映像として戻ってこない（自ソケットはconsumeしない）ため、
    // ローカルプレビューとしてタイル表示する。
    if (screenShare?.stream) {
      tiles.push({
        id: 'self-screen',
        key: 'self-screen',
        label: `${selfName} / ${screenShare.sourceName}`,
        stream: screenShare.stream,
        isSelf: true,
        isScreen: true,
        videoPaused: !!screenShare.paused,
        audioPaused: !screenShare.hasAudio || !screenShare.audioEnabled,
        speakerMuted: true,
        sameChannel: true,
        channelId: activeChannelId,
        canControlVolume: false,
        baseVolume: 0,
        sortRank: 2,
      });
    }

    for (const [socketId, peer] of peerEntries) {
      const peerChannelId = peer.channelId || 'general';
      const sameChannel = peerChannelId === activeChannelId;
      const isScreenShareApp = peer.appType === 'screen-share';

      if (!isScreenShareApp) {
        tiles.push({
          id: `peer:${socketId}`,
          key: `peer:${socketId}`,
          label: peer.locationName || '不明',
          stream: peer.stream,
          isSelf: false,
          videoPaused: !!peer.videoPaused,
          audioPaused: !!peer.audioPaused || !sameChannel,
          speakerDeviceId: selectedAudioOutId,
          speakerMuted: speakerMuted || !sameChannel,
          sameChannel,
          channelId: peerChannelId,
          presenceMode: peer.presenceMode || 'none',
          signalLevel: Number.isFinite(peer.signalLevel) ? peer.signalLevel : null,
          recovering: !!peer.recovering,
          canControlVolume: true,
          baseVolume: remoteAudioVolume,
          sortRank: sameChannel ? 1 : 3,
        });
      }

      if (peer.screenProducerId && peer.screenStream?.getVideoTracks().length && !peer.screenPaused) {
        tiles.push({
          id: `screen:${socketId}`,
          key: `screen:${socketId}`,
          label: `${peer.locationName || '不明'} / ${peer.screenLabel || '画面共有'}`,
          stream: peer.screenStream,
          isSelf: false,
          isScreen: true,
          videoPaused: !!peer.screenPaused,
          audioPaused: !!peer.screenAudioPaused,
          speakerDeviceId: selectedAudioOutId,
          speakerMuted,
          sameChannel: true,
          channelId: peerChannelId,
          canControlVolume: true,
          baseVolume: remoteAudioVolume,
          sortRank: 2,
        });
      }
    }

    return tiles.sort((a, b) => (
      Number(b.sameChannel) - Number(a.sameChannel) ||
      a.sortRank - b.sortRank ||
      a.label.localeCompare(b.label, 'ja')
    ));
  }, [
    activeChannelId,
    camEnabled,
    localStream,
    micEnabled,
    peerEntries,
    presenceMode,
    selfSignalLevel,
    remoteAudioVolume,
    screenShare,
    selectedAudioOutId,
    selfName,
    speakerMuted,
  ]);

  useEffect(() => {
    if (sfuStatus !== 'connected') {
      observedRemoteScreenSharesRef.current = new Set();
      return;
    }

    const current = new Set();
    for (const [socketId, peer] of peerEntries) {
      const hasLiveScreen = !!peer.screenProducerId &&
        peer.screenStream?.getVideoTracks().some(track => track.readyState === 'live');
      if (hasLiveScreen) current.add(`${socketId}:${peer.screenProducerId}`);
    }

    const previous = observedRemoteScreenSharesRef.current;
    const started = Array.from(current).some(id => !previous.has(id));
    const stopped = Array.from(previous).some(id => !current.has(id));
    observedRemoteScreenSharesRef.current = current;

    if (started) playEffectSound('screenViewStart');
    if (stopped) playEffectSound('screenViewStop');
  }, [peerEntries, playEffectSound, sfuStatus]);

  // ── チャンネル別グルーピング ──
  //   メイン: 自チャンネルのカメラON・画面共有タイル（大きく表示）
  //   ドック: 自チャンネルのカメラOFFタイル（小さくアイコン表示。ONになれば即メインへ戻る）
  //   右レール: 他チャンネルのタイルをチャンネルごとにまとめて表示
  const { mainTiles, camOffDockTiles, otherChannelGroups } = useMemo(() => {
    const main = [];
    const dock = [];
    const groupsMap = new Map();

    for (const tile of videoTiles) {
      if (!tile.sameChannel) {
        const groupId = tile.channelId || 'general';
        if (!groupsMap.has(groupId)) groupsMap.set(groupId, []);
        groupsMap.get(groupId).push(tile);
        continue;
      }
      if (tile.videoPaused && !tile.isScreen) dock.push(tile);
      else main.push(tile);
    }

    const groups = Array.from(groupsMap, ([id, tiles]) => ({
      id,
      name: channels.find(channel => channel.id === id)?.name || id,
      tiles,
    })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    return { mainTiles: main, camOffDockTiles: dock, otherChannelGroups: groups };
  }, [videoTiles, channels]);

  const visibleFocusedTileId = videoTiles.some(tile => tile.id === focusedTileId) ? focusedTileId : '';
  const focusedTile = videoTiles.find(tile => tile.id === visibleFocusedTileId) || null;
  const secondaryTiles = focusedTile ? videoTiles.filter(tile => tile.id !== focusedTile.id) : videoTiles;
  const { gridRef, layout: gridLayout } = useFittedVideoGrid(focusedTile ? secondaryTiles.length : Math.max(1, mainTiles.length));

  const renderVideoTile = useCallback((tile, options = {}) => {
    const volumeValue = getTileVolume(tile.id);
    // カメラタイル（peer:xxx）のみ呼び出しボタンを表示する
    const callTargetSocketId = tile.id.startsWith('peer:') ? tile.id.slice(5) : '';
    const variant = options.focused ? 'focus' : options.mini ? 'mini' : options.compact ? 'compact' : 'grid';
    return (
      <VideoCell
        key={`${tile.key}-${variant}`}
        tileId={tile.id}
        label={tile.label}
        stream={tile.stream}
        isSelf={tile.isSelf}
        isScreen={!!tile.isScreen}
        videoPaused={tile.videoPaused}
        audioPaused={tile.audioPaused}
        presenceMode={tile.presenceMode || 'none'}
        signalLevel={tile.signalLevel ?? null}
        reconnecting={!!tile.recovering}
        highlightMuted={highlightSelfMuted}
        speakerDeviceId={tile.speakerDeviceId}
        speakerMuted={tile.speakerMuted}
        volume={tile.baseVolume * volumeValue}
        focused={!!options.focused}
        compact={!!options.compact || !!options.mini}
        mini={!!options.mini}
        dimmed={!!options.dimmed || !tile.sameChannel}
        canFocus={true}
        canControlVolume={tile.canControlVolume}
        volumeValue={volumeValue}
        onFocus={handleTileFocus}
        onVolumeChange={handleTileVolumeChange}
        onCall={callTargetSocketId ? () => callMember(callTargetSocketId) : null}
      />
    );
  }, [callMember, getTileVolume, handleTileFocus, handleTileVolumeChange, highlightSelfMuted]);

  const memberMenuVolume = memberMenu ? getTileVolume(`peer:${memberMenu.socketId}`) : 1;
  const incomingCallChannelName = incomingCall?.fromChannelId
    ? (incomingCall.fromChannelName || channels.find(channel => channel.id === incomingCall.fromChannelId)?.name || incomingCall.fromChannelId)
    : '';

  return (
    <div
      className={`main-layout with-sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      style={{ '--sidebar-w': `${sidebarCollapsed ? 54 : sidebarWidth}px` }}
    >
      <aside className="channel-sidebar">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed(value => !value)}
          title={sidebarCollapsed ? 'メニューを開く' : 'メニューを閉じる'}
          aria-label={sidebarCollapsed ? 'メニューを開く' : 'メニューを閉じる'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>

        {!sidebarCollapsed && (
          <>
            <div className="sidebar-brand">
              <div className="sidebar-mark">CH</div>
              <div>
                <div className="sidebar-title">CHECKHOUSE</div>
                <div className="sidebar-subtitle">Meeting System</div>
              </div>
            </div>

            <div className="active-channel-card">
              <Volume2 size={22} />
              <span>{activeChannel?.name || 'チャンネル'}</span>
              <button type="button" onClick={openSettingsPanel} title="設定" aria-label="設定">
                <Settings size={15} />
              </button>
            </div>

            <div className="channel-section-row voice">
              <button type="button" className="section-title">
                <span>ボイスチャンネル</span>
                <ChevronDown size={14} />
              </button>
              <button
                type="button"
                className="section-action"
                onClick={() => setChannelEditorOpen(value => !value)}
                title="チャンネルを編集"
                aria-label="チャンネルを編集"
              >
                <Pencil size={16} />
              </button>
            </div>

            {channelEditorOpen && (
              <div className="channel-editor-panel">
                <form className="channel-create-form" onSubmit={createChannel}>
                  <input
                    type="text"
                    value={newChannelName}
                    onChange={event => setNewChannelName(event.target.value)}
                    placeholder="新しいチャンネル名"
                    maxLength={48}
                    autoFocus
                  />
                  <button type="submit" title="追加" aria-label="追加" disabled={!newChannelName.trim()}>
                    <Plus size={15} />
                  </button>
                </form>
                <div className="channel-edit-list">
                  {registeredChannels.map(channel => {
                    const draft = channelDrafts[channel.id] ?? channel.name;
                    return (
                      <div className="channel-edit-row" key={channel.id}>
                        <input
                          type="text"
                          value={draft}
                          onChange={event => updateChannelDraft(channel.id, event.target.value)}
                          maxLength={48}
                        />
                        <button
                          type="button"
                          title="保存"
                          aria-label="保存"
                          disabled={!String(draft).trim() || String(draft).trim() === channel.name}
                          onClick={() => renameChannel(channel.id)}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          title="削除"
                          aria-label="削除"
                          disabled={registeredChannels.length <= 1}
                          onClick={() => deleteChannel(channel.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="channel-tree" aria-label="ボイスチャンネル">
              {channels.map(channel => {
                const members = channelMembers.get(channel.id) || [];
                const active = channel.id === activeChannelId;
                return (
                  <div key={channel.id} className={`voice-channel-node ${active ? 'active' : ''}`}>
                    <button
                      type="button"
                      className="voice-channel-row"
                      onClick={() => changeChannel(channel.id)}
                      title={channel.name}
                    >
                      <Volume2 size={18} />
                      <span>{channel.name}</span>
                      <strong>{members.length}</strong>
                    </button>
                    <div className="voice-member-list">
                      {members.map(member => (
                        <div
                          key={member.id}
                          className={`voice-member ${member.isSelf ? 'self' : ''}`}
                          onContextMenu={event => openMemberMenu(event, member, channel)}
                          title={member.isSelf ? member.name : `${member.name}を右クリックで操作`}
                        >
                          <span className="member-avatar">{memberInitials(member.name)}</span>
                          <span className="member-name">{member.name}{member.isSelf ? '（自拠点）' : ''}</span>
                          {/* 発信中の相手にはベルを鳴動アニメーションで表示し、クリックでキャンセルできる */}
                          {!member.isSelf && (
                            <button
                              type="button"
                              className={`member-call-btn ${outgoingCall?.targetSocketId === member.socketId ? 'ringing' : ''}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (outgoingCall?.targetSocketId === member.socketId) cancelOutgoingCall();
                                else callMember(member.socketId);
                              }}
                              title={outgoingCall?.targetSocketId === member.socketId ? '呼び出し中（クリックでキャンセル）' : '呼び出し'}
                              aria-label={outgoingCall?.targetSocketId === member.socketId ? `${member.name}を呼び出し中` : `${member.name}を呼び出し`}
                            >
                              {outgoingCall?.targetSocketId === member.socketId ? <BellRing size={13} /> : <Bell size={13} />}
                            </button>
                          )}
                          {member.muted && <MicOff size={15} />}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {sidebarCollapsed && (
          <div className="collapsed-channel-stack">
            {channels.map(channel => (
              <button
                key={channel.id}
                type="button"
                className={channel.id === activeChannelId ? 'active' : ''}
                onClick={() => changeChannel(channel.id)}
                title={channel.name}
              >
                <Volume2 size={17} />
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-footer">
          {updateAvailable && !sidebarCollapsed && (
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
          <div className="version-line">{sidebarCollapsed ? `v${APP_VERSION}` : `Client v${APP_VERSION}`}</div>
          {/* サーバー切り替えトグル（メイン⇄サブ）。到達不能時の自動切替も併用される */}
          {!!String(settingsDraft.subServerIp || '').trim() && (
            <div
              className={`server-switch ${sidebarCollapsed ? 'collapsed' : ''}`}
              title={settingsDraft.activeServer === 'sub'
                ? 'サブサーバー使用中（クリックでメインへ切り替え）。手動選択は10分間、自動選択より優先されます。アプリ再起動後は自動選択に戻ります'
                : 'メインサーバー使用中（クリックでサブへ切り替え）。手動選択は10分間、自動選択より優先されます。アプリ再起動後は自動選択に戻ります'}
            >
              {!sidebarCollapsed && (
                <span className={`server-switch-label ${settingsDraft.activeServer !== 'sub' ? 'on' : ''}`}>メイン</span>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={settingsDraft.activeServer === 'sub'}
                aria-label={settingsDraft.activeServer === 'sub' ? 'メインサーバーへ切り替え' : 'サブサーバーへ切り替え'}
                className={`server-switch-track ${settingsDraft.activeServer === 'sub' ? 'sub' : ''}`}
                onClick={() => switchActiveServer(settingsDraft.activeServer === 'sub' ? 'main' : 'sub')}
              >
                <span className="server-switch-knob" />
              </button>
              {!sidebarCollapsed && (
                <span className={`server-switch-label ${settingsDraft.activeServer === 'sub' ? 'on sub' : ''}`}>サブ</span>
              )}
            </div>
          )}
        </div>

        {!sidebarCollapsed && (
          <div
            className="sidebar-resize-handle"
            onMouseDown={startSidebarResize}
            role="separator"
            aria-orientation="vertical"
            title="メニュー幅を変更"
          />
        )}
      </aside>

      {memberMenu && (
        <div
          className="member-context-menu"
          style={{ left: `${memberMenu.x}px`, top: `${memberMenu.y}px` }}
          onClick={event => event.stopPropagation()}
        >
          <div className="member-context-title">{memberMenu.memberName}</div>
          <button
            type="button"
            onClick={() => {
              if (outgoingCall?.targetSocketId === memberMenu.socketId) cancelOutgoingCall();
              else callMember(memberMenu.socketId);
            }}
          >
            <BellRing size={15} className={outgoingCall?.targetSocketId === memberMenu.socketId ? 'bell-ringing' : ''} />
            <span>{outgoingCall?.targetSocketId === memberMenu.socketId ? '呼び出しをキャンセル' : '呼び出し'}</span>
          </button>
          <button type="button" onClick={() => toggleMemberSpeakerMute(memberMenu.socketId)}>
            {memberMenuVolume > 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            <span>{memberMenuVolume > 0 ? 'スピーカーミュート' : 'ミュート解除'}</span>
          </button>
          <label className="member-volume-control">
            <span>個別音量 {Math.round(memberMenuVolume * 100)}%</span>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={memberMenuVolume}
              onChange={event => handleTileVolumeChange(`peer:${memberMenu.socketId}`, Number(event.target.value))}
            />
          </label>
          <label className="member-channel-move">
            <span>チャンネル移動</span>
            <select
              value={memberMenu.channelId}
              onChange={event => moveMemberToChannel(memberMenu.socketId, event.target.value)}
            >
              {registeredChannels.map(channel => (
                <option key={channel.id} value={channel.id}>{channel.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="meeting-stage">
      {/* 帰宅モード: 映像エリアを黒くする（サイドバー・コントロールバー・
          着信画面などのボタン群は覆わない）。セッションは維持される。 */}
      {presenceMode === 'gohome' && (
        <div className="gohome-cover" role="status" aria-label="帰宅モード中">
          <Moon size={42} />
          <div className="gohome-title">帰宅モード</div>
          <div className="gohome-note">
            映像表示をオフにしています。{(settingsDraft.shortcuts?.goHomeMode || 'o').toUpperCase()} キーまたは下のボタンで解除できます。
          </div>
        </div>
      )}

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

      {/* サーバー再接続中オーバーレイ: 画面(GUI)はそのままに、映像エリア中央へ
          スピナーを重ねる。操作を妨げないよう pointer-events は透過する。 */}
      {sfuStatus !== 'connected' && (
        <div className="reconnect-overlay" role="status" aria-live="polite">
          <div className="reconnect-spinner" aria-hidden="true" />
          <div className="reconnect-text">サーバーと接続中...</div>
        </div>
      )}

      {/* ── カメラエラー表示 ── */}
      {camError && (
        <div className="cam-error-bar">⚠ {camError}</div>
      )}

      {/* ── アプリ内確認ダイアログ ── */}
      {confirmDialog && (
        <div className="confirm-overlay" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
          <div className="confirm-panel">
            <div className="confirm-icon">
              <BellRing size={26} />
            </div>
            <div id="confirm-dialog-title" className="confirm-title">{confirmDialog.title}</div>
            <div className="confirm-message">{confirmDialog.message}</div>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => setConfirmDialog(null)}>
                キャンセル（Esc）
              </button>
              <button
                type="button"
                className="confirm-primary"
                autoFocus
                onClick={() => {
                  const dialog = confirmDialog;
                  setConfirmDialog(null);
                  dialog.onConfirm?.();
                }}
              >
                {confirmDialog.confirmLabel || 'OK'}（Enter）
              </button>
            </div>
          </div>
        </div>
      )}

      {incomingCall && (
        <div className="incoming-call-screen" role="alertdialog" aria-modal="true" aria-labelledby="incoming-call-title">
          <div className="incoming-call-frame" aria-hidden="true" />
          <div className="incoming-call-panel">
            <div className="incoming-call-icon">
              <BellRing size={34} />
            </div>
            <div>
              <div id="incoming-call-title" className="incoming-call-title">呼び出し中</div>
              <div className="incoming-call-name">{incomingCall.callerName} から呼び出されています</div>
              <div className="incoming-call-note">応答するまで最大30秒鳴動します</div>
              {incomingCallChannelName && (
                <div className="incoming-call-channel">応答すると「{incomingCallChannelName}」へ移動します</div>
              )}
            </div>
            <div className="incoming-call-actions">
              <button type="button" className="incoming-call-answer" onClick={() => answerIncomingCall(incomingCall)}>
                応答{(settingsDraft.shortcuts?.callAnswer || 'Enter') === 'Enter' ? '（Enter）' : ''}
              </button>
              <button type="button" className="incoming-call-dismiss" onClick={() => dismissIncomingCall(incomingCall)} aria-label="呼び出し通知を停止">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ビデオグリッド ── */}
      {focusedTile ? (
        <div className="focus-video-layout">
          <div className="focus-main-tile">
            {renderVideoTile(focusedTile, { focused: true })}
          </div>
          {secondaryTiles.length > 0 && (
            <div className="focus-side-rail">
              {secondaryTiles.map(tile => renderVideoTile(tile, { compact: true }))}
            </div>
          )}
        </div>
      ) : (
        <div className={`stage-body ${otherChannelGroups.length ? 'with-rail' : ''}`}>
          <div className="stage-main">
            <div className="stage-channel-box">
              <div className="stage-channel-head">
                <Volume2 size={14} />
                <span>{activeChannel?.name || 'チャンネル'}</span>
                <strong>{mainTiles.length + camOffDockTiles.length}拠点</strong>
              </div>
              <div
                ref={gridRef}
                className="video-grid"
                style={{
                  gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, ${gridLayout.cellWidth || 1}px))`,
                  gridTemplateRows: `repeat(${gridLayout.rows}, minmax(0, ${gridLayout.cellHeight || 1}px))`,
                }}
              >
                {mainTiles.map(tile => renderVideoTile(tile))}
                {mainTiles.length === 0 && (
                  <div className="stage-empty">カメラONの拠点はありません</div>
                )}
              </div>
              {camOffDockTiles.length > 0 && (
                <div className="camoff-dock" aria-label="カメラOFFの拠点">
                  {camOffDockTiles.map(tile => renderVideoTile(tile, { mini: true }))}
                </div>
              )}
            </div>
          </div>

          {otherChannelGroups.length > 0 && (
            <aside className="channel-rail" aria-label="他チャンネルの拠点">
              {otherChannelGroups.map(group => (
                <div key={group.id} className="channel-rail-group">
                  <div className="channel-rail-head">
                    <Volume2 size={12} />
                    <span>{group.name}</span>
                    <strong>{group.tiles.length}</strong>
                  </div>
                  <div className="channel-rail-tiles">
                    {group.tiles.map(tile => renderVideoTile(tile, { compact: true }))}
                  </div>
                </div>
              ))}
            </aside>
          )}
        </div>
      )}

      {viewerPresenceActive && (
        <div className="viewer-presence-dot" aria-hidden="true" />
      )}

      {/* ── 画面共有中バー ── */}
      {screenShare && (
        <div className="share-bar">
          <span className={`share-bar-dot ${screenShare.paused ? 'paused' : ''}`} />
          <MonitorUp size={14} />
          <span className="share-bar-name">
            {screenShare.paused ? '共有を一時停止中' : `「${screenShare.sourceName}」を共有中`}
          </span>
          <button type="button" className="share-bar-btn" onClick={toggleSharePause} title={screenShare.paused ? '共有を再開' : '共有を一時停止'}>
            {screenShare.paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button type="button" className="share-bar-btn" onClick={() => setShareModalMode('change')} title="共有元を変更">
            <SwitchCamera size={14} />
          </button>
          {screenShare.hasAudio && (
            <button
              type="button"
              className={`share-bar-btn ${screenShare.audioEnabled ? '' : 'muted'}`}
              onClick={toggleShareAudio}
              title={screenShare.audioEnabled ? '共有音声をOFF' : '共有音声をON'}
            >
              {screenShare.audioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
          )}
          <button type="button" className="share-bar-btn stop" onClick={stopScreenShare} title="共有を停止">
            <Square size={12} /> 停止
          </button>
        </div>
      )}

      {/* ── 発信中バー / 呼び出し結果通知 ── */}
      {outgoingCall && (
        <div className="outgoing-call-bar">
          <BellRing size={14} className="bell-ringing" />
          <span>{outgoingCall.targetName} を呼び出し中…</span>
          <button type="button" onClick={cancelOutgoingCall}>キャンセル</button>
        </div>
      )}
      {!outgoingCall && callNotice && (
        <div className={`outgoing-call-bar notice ${callNotice.tone || 'info'}`}>
          <Bell size={13} />
          <span>{callNotice.text}</span>
        </div>
      )}

      {/* ── コントロールバー ──
          左: デバイス操作（マイク/カメラ/スピーカー/画面共有）を1ブロックに、
          右端: プレゼンスモード（商談中/不在/帰宅）と設定を別ブロックで棲み分け。 */}
      <div className="control-bar">
        <div className="ctrl-group device-group">
          {/* マイク */}
          <DeviceButton
            active={micEnabled}
            onToggle={toggleMic}
            Icon={Mic}
            IconOff={MicOff}
            devices={audioInDevices}
            selectedId={selectedAudioInId}
            onDeviceChange={(id) => changeMediaDevice('audioIn', id)}
            title={`マイク（${formatShortcutKey(settingsDraft.shortcuts?.micToggle || defaultShortcuts.micToggle)}）`}
            label="マイク"
            shortcutKey={formatShortcutKey(settingsDraft.shortcuts?.micToggle || defaultShortcuts.micToggle)}
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
            title={`カメラ（${formatShortcutKey(settingsDraft.shortcuts?.cameraToggle || defaultShortcuts.cameraToggle)}）`}
            label="カメラ"
            shortcutKey={formatShortcutKey(settingsDraft.shortcuts?.cameraToggle || defaultShortcuts.cameraToggle)}
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
            title={`スピーカー（${formatShortcutKey(settingsDraft.shortcuts?.speakerToggle || defaultShortcuts.speakerToggle)}）`}
            label="スピーカー"
            shortcutKey={formatShortcutKey(settingsDraft.shortcuts?.speakerToggle || defaultShortcuts.speakerToggle)}
          />

          {/* 画面共有 */}
          <button
            className={`ctrl-btn ${screenShare ? 'sharing' : ''}`}
            onClick={() => {
              if (screenShare) stopScreenShare();
              else setShareModalMode('start');
            }}
            title={screenShare ? '画面共有を停止' : '画面共有'}
            aria-label={screenShare ? '画面共有を停止' : '画面共有'}
          >
            <MonitorUp size={20} />
            <span className="ctrl-btn-label">画面共有</span>
          </button>
        </div>

        {privateCall && (
          <div className="ctrl-group private-call-center">
            <button
              type="button"
              className="ctrl-btn private-call-end-btn"
              onClick={endPrivateCall}
              title="個別通話を終了"
              aria-label="個別通話を終了"
            >
              <PhoneOff size={20} />
              <span className="ctrl-btn-label">通話終了</span>
            </button>
          </div>
        )}

        <div className="ctrl-group mode-group">
          {/* プレゼンスモード（商談中/不在/帰宅） */}
          <button
            className={`ctrl-btn mode-btn ${presenceMode === 'busy' ? 'mode-active busy' : ''}`}
            onClick={() => togglePresenceMode('busy')}
            title={`商談中モード（${(settingsDraft.shortcuts?.busyMode || 'u').toUpperCase()}）: 他拠点に商談中と表示・着信音50%`}
            aria-label="商談中モード"
            aria-pressed={presenceMode === 'busy'}
          >
            <Briefcase size={20} />
            <span className="ctrl-btn-label">商談中</span>
            <kbd className="ctrl-btn-kbd" aria-hidden="true">{formatShortcutKey(settingsDraft.shortcuts?.busyMode || defaultShortcuts.busyMode)}</kbd>
          </button>
          <button
            className={`ctrl-btn mode-btn ${presenceMode === 'away' ? 'mode-active away' : ''}`}
            onClick={() => togglePresenceMode('away')}
            title={`不在モード（${(settingsDraft.shortcuts?.awayMode || 'i').toUpperCase()}）: 他拠点に不在と表示`}
            aria-label="不在モード"
            aria-pressed={presenceMode === 'away'}
          >
            <Clock size={20} />
            <span className="ctrl-btn-label">不在</span>
            <kbd className="ctrl-btn-kbd" aria-hidden="true">{formatShortcutKey(settingsDraft.shortcuts?.awayMode || defaultShortcuts.awayMode)}</kbd>
          </button>
          <button
            className={`ctrl-btn mode-btn ${presenceMode === 'gohome' ? 'mode-active gohome' : ''}`}
            onClick={() => togglePresenceMode('gohome')}
            title={`帰宅モード（${(settingsDraft.shortcuts?.goHomeMode || 'o').toUpperCase()}）: 映像表示をオフにする`}
            aria-label="帰宅モード"
            aria-pressed={presenceMode === 'gohome'}
          >
            <Moon size={20} />
            <span className="ctrl-btn-label">帰宅</span>
            <kbd className="ctrl-btn-kbd" aria-hidden="true">{formatShortcutKey(settingsDraft.shortcuts?.goHomeMode || defaultShortcuts.goHomeMode)}</kbd>
          </button>

          <div className="ctrl-separator" aria-hidden="true" />

          {/* 設定 */}
          <button
            className="ctrl-btn settings-btn"
            onClick={openSettingsPanel}
            title="設定"
            aria-label="設定"
          >
            <Settings size={20} />
            <span className="ctrl-btn-label">設定</span>
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="接続設定"
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            const el = event.target;
            // ショートカットキー入力欄はEnterキー自体を割り当てる操作に使うため対象外。
            // textarea は改行との衝突を避けるため対象外(現状は無いが将来のため)。
            if (el?.classList?.contains('shortcut-key-input') || el?.tagName === 'TEXTAREA') return;
            event.preventDefault();
            saveSettingsDraft();
          }}
        >
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

            <div className="settings-body">
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
                <div className="field">
                  <label>音声チャンネル</label>
                  <select
                    value={settingsDraft.channelId}
                    onChange={e => updateSettingsDraft('channelId', e.target.value)}
                  >
                    {registeredChannels.map(channel => (
                      <option key={channel.id} value={channel.id}>{channel.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-section">
                <h2>SFUサーバー</h2>
                <div className="server-row">
                  <div className="field">
                    <label>メイン IPアドレス</label>
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
                <div className="server-row">
                  <div className="field">
                    <label>サブ（保険）IPアドレス</label>
                    <input
                      type="text"
                      value={settingsDraft.subServerIp || ''}
                      onChange={e => updateSettingsDraft('subServerIp', e.target.value)}
                      placeholder="例: cloud.example.jp / 203.0.113.10"
                    />
                  </div>
                  <div className="field">
                    <label>ポート</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={settingsDraft.subServerPort || '3000'}
                      onChange={e => updateSettingsDraft('subServerPort', e.target.value)}
                      placeholder="3000"
                    />
                  </div>
                </div>
                <div className="field">
                  <label>使用するサーバー</label>
                  <select
                    value={settingsDraft.activeServer === 'sub' ? 'sub' : 'main'}
                    onChange={e => updateSettingsDraft('activeServer', e.target.value)}
                  >
                    <option value="main">メインサーバー</option>
                    <option value="sub" disabled={!String(settingsDraft.subServerIp || '').trim()}>
                      サブ（保険）サーバー
                    </option>
                  </select>
                </div>
                <p className="field-hint">
                  現在のサーバーに約{Math.round(FAILOVER_AFTER_MS / 1000)}秒間接続できず、もう一方のサーバーが応答する場合は自動的に切り替えて再接続します。
                  再接続時は両サーバーの接続拠点数を確認し、他拠点が接続している方へ優先的に接続します（画面左下のトグルで手動切替も可能）。
                </p>
              </div>

              <div className="settings-section">
                <h2>キーボードショートカット</h2>
                <ShortcutKeyField
                  label="マイク ミュート切替"
                  value={settingsDraft.shortcuts?.micToggle}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, micToggle: key })}
                />
                <ShortcutKeyField
                  label="スピーカー ミュート切替"
                  value={settingsDraft.shortcuts?.speakerToggle}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, speakerToggle: key })}
                />
                <ShortcutKeyField
                  label="カメラ ON/OFF切替"
                  value={settingsDraft.shortcuts?.cameraToggle}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, cameraToggle: key })}
                />
                <ShortcutKeyField
                  label="着信に応答"
                  value={settingsDraft.shortcuts?.callAnswer}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, callAnswer: key })}
                />
                <ShortcutKeyField
                  label="商談中モード切替"
                  value={settingsDraft.shortcuts?.busyMode}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, busyMode: key })}
                />
                <ShortcutKeyField
                  label="不在モード切替"
                  value={settingsDraft.shortcuts?.awayMode}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, awayMode: key })}
                />
                <ShortcutKeyField
                  label="帰宅モード切替"
                  value={settingsDraft.shortcuts?.goHomeMode}
                  onChange={key => updateSettingsDraft('shortcuts', { ...settingsDraft.shortcuts, goHomeMode: key })}
                />
                <p className="field-hint">数字キー（1〜9）でチャンネル一覧の上から順に移動できます（固定）。</p>
              </div>

              <div className="settings-section">
                <h2>メディア品質</h2>
                <div className="server-row">
                  <div className="field">
                    <label>送信画質</label>
                    <select
                      value={settingsDraft.sendQuality || 'high'}
                      onChange={e => updateSettingsDraft('sendQuality', e.target.value)}
                    >
                      {QUALITY_OPTIONS.map(q => (
                        <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>受信画質</label>
                    <select
                      value={settingsDraft.recvQuality || 'high'}
                      onChange={e => updateSettingsDraft('recvQuality', e.target.value)}
                    >
                      {QUALITY_OPTIONS.map(q => (
                        <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="field-hint">回線が細い拠点では「中」「低」にすると安定します。送信画質の変更は保存時に再接続して反映されます。</p>
                <label className="field-toggle">
                  <input
                    type="checkbox"
                    checked={!!settingsDraft.forceTcp}
                    onChange={e => updateSettingsDraft('forceTcp', e.target.checked)}
                  />
                  <span>メディアをTCPで送受信する（UDPが不安定・遮断される場合のみ）</span>
                </label>
              </div>

              <div className="settings-section">
                <h2>音量</h2>
                <div className="field">
                  <label>通話音声: {settingsDraft.voiceVolume ?? 100}%</label>
                  <div className="ringtone-volume-row">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={settingsDraft.voiceVolume ?? 100}
                      onChange={e => updateSettingsDraft('voiceVolume', Number(e.target.value))}
                    />
                  </div>
                  <p className="field-hint">会議中に聞こえる相手拠点・画面共有音声の音量です。</p>
                </div>
                <div className="field">
                  <label>着信音: {settingsDraft.ringtoneVolume ?? settingsDraft.callVolume ?? 100}%</label>
                  <div className="ringtone-volume-row">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={settingsDraft.ringtoneVolume ?? settingsDraft.callVolume ?? 100}
                      onChange={e => updateSettingsDraft('ringtoneVolume', Number(e.target.value))}
                    />
                    <button type="button" className="btn-sub" onClick={() => previewCallTone(settingsDraft.ringtoneVolume ?? settingsDraft.callVolume ?? 100)}>
                      試聴
                    </button>
                  </div>
                  <p className="field-hint">商談中モード中は自動的に50%へ下がります。音量は「保存して反映」で確定します。</p>
                </div>
                <div className="field">
                  <label>効果音: {settingsDraft.effectsVolume ?? 100}%</label>
                  <div className="ringtone-volume-row">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={settingsDraft.effectsVolume ?? 100}
                      onChange={e => updateSettingsDraft('effectsVolume', Number(e.target.value))}
                    />
                    <button type="button" className="btn-sub" onClick={() => playSystemSound('notification', { volume: sanitizeVolumePercent(settingsDraft.effectsVolume ?? 100) / 100 })}>
                      試聴
                    </button>
                  </div>
                  <p className="field-hint">ミュート切替、チャンネル移動、画面共有などのシステム効果音です。</p>
                </div>
                <div className="field">
                  <label>着信音</label>
                  <div className="ringtone-current">
                    <Music size={14} />
                    <span>{customRingtone?.name || '既定の着信音'}</span>
                    {customRingtone && (
                      <button type="button" className="btn-sub" onClick={() => applyCustomRingtone(null)}>
                        既定に戻す
                      </button>
                    )}
                  </div>
                  <label className="btn-sub ringtone-file-btn">
                    ファイルから選択（mp3 / wav）
                    <input
                      type="file"
                      accept=".mp3,.wav,.ogg,.m4a,.aac,audio/*"
                      style={{ display: 'none' }}
                      onChange={e => { importRingtoneFile(e.target.files?.[0]); e.target.value = ''; }}
                    />
                  </label>
                </div>
                <div className="field">
                  <label>サーバーの通知音</label>
                  {serverRingtones === null && <p className="field-hint">読み込み中…</p>}
                  {Array.isArray(serverRingtones) && serverRingtones.length === 0 && (
                    <p className="field-hint">
                      サーバーに通知音がありません。サーバーの ringtones フォルダに mp3/wav を置くと、全拠点がここから取り込めます。
                    </p>
                  )}
                  {Array.isArray(serverRingtones) && serverRingtones.length > 0 && (
                    <ul className="ringtone-list">
                      {serverRingtones.map(file => (
                        <li key={file.name}>
                          <span className="ringtone-name">{file.name}</span>
                          <button type="button" className="btn-sub" onClick={() => importServerRingtone(file.name)}>
                            取り込む
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {ringtoneNotice && <p className="field-hint ringtone-notice">{ringtoneNotice}</p>}
                <p className="field-hint">取り込んだ着信音と音量はこの端末に保存され、アプリを更新しても引き継がれます。</p>
              </div>

              <div className="settings-section">
                <h2>通話</h2>
                <label className="field-toggle">
                  <input
                    type="checkbox"
                    checked={!!settingsDraft.autoUnmuteOnCallAnswer}
                    onChange={e => updateSettingsDraft('autoUnmuteOnCallAnswer', e.target.checked)}
                  />
                  <span>呼び出しに応答したら双方のミュートを自動解除する</span>
                </label>
                <label className="field-toggle">
                  <input
                    type="checkbox"
                    checked={!!settingsDraft.startMicMuted}
                    onChange={e => updateSettingsDraft('startMicMuted', e.target.checked)}
                  />
                  <span>起動時はマイクをミュートで開始する</span>
                </label>
              </div>

              <div className="settings-section">
                <h2>表示</h2>
                <label className="field-toggle">
                  <input
                    type="checkbox"
                    checked={!!settingsDraft.highlightSelfMuted}
                    onChange={e => updateSettingsDraft('highlightSelfMuted', e.target.checked)}
                  />
                  <span>自拠点がマイクミュート中は枠を赤色で強調する</span>
                </label>
              </div>
            </div>

            <button className="btn-join" onClick={saveSettingsDraft}>
              保存して反映
            </button>
          </div>
        </div>
      )}

      {/* ── 画面共有: 共有元選択モーダル ── */}
      <ScreenShareModal
        open={!!shareModalMode}
        isChanging={shareModalMode === 'change'}
        onClose={() => setShareModalMode(null)}
        onSelect={startScreenShareFromSource}
      />
      </div>
    </div>
  );
}
