/**
 * 画面共有専用アプリ
 *
 * 設計:
 *   - クライアントと同一の基本UI（左: チャンネル選択サイドバー / 下: コントロールバー）
 *   - チャンネルを選択し、そのチャンネル内の拠点へ画面を配信する（通話機能なし）
 *   - 共有モードは3つ:
 *       全画面        … ボタンを押すと即座にメイン画面全体を共有
 *       アプリケーション … モーダルでアプリを選んで共有
 *       画面ごと       … モーダルでディスプレイを選んで共有
 *   - 共有解像度は設定で選択（送信ビットレートも連動）
 *   - サーバー設定（メイン/サブ・自動フェイルオーバー）はクライアントを踏襲
 *   - アプリ内の共有開始確認は初回のみ（以降は確認せず即共有）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow, Download, Monitor, MonitorUp, RefreshCw, Settings,
  Square, Volume2, VolumeX, X, ChevronDown,
} from 'lucide-react';
import { ScreenShareWebRTCManager } from './services/screen-share-webrtc';
import { playSystemSound } from './services/system-sounds';

const APP_VERSION = '0.2.0';
const APP_TYPE = 'screen-share';
const CONFIG_STORAGE_KEY = 'sfu_screen_share_config';

// 共有解像度の選択肢（設定画面で選択。ビットレートは送信上限）
const RESOLUTION_OPTIONS = [
  { id: '720p',  label: 'HD (1280×720)',       width: 1280, height: 720,  bitrate: 1_200_000 },
  { id: '1080p', label: 'フルHD (1920×1080)',   width: 1920, height: 1080, bitrate: 2_500_000 },
  { id: '1440p', label: 'WQHD (2560×1440)',     width: 2560, height: 1440, bitrate: 4_000_000 },
  { id: '2160p', label: '4K (3840×2160)',       width: 3840, height: 2160, bitrate: 8_000_000 },
];

const DEFAULT_CONFIG = {
  serverIp: '127.0.0.1',
  serverPort: '3000',
  // 保険用サブサーバー（クライアントと同じ考え方。到達不能が続くと自動切替）
  subServerIp: '',
  subServerPort: '3000',
  activeServer: 'main',      // 'main' | 'sub'
  displayName: '画面共有',
  channelId: 'general',
  shareResolution: '1080p',
  shareAudio: false,
  effectsVolume: 100,
  shareConfirmed: false,     // 共有開始の確認は初回のみ（trueなら確認せず即共有）
};

const DEFAULT_SYSTEM_STATE = {
  brand: 'CHECKHOUSE Meeting System',
  channels: [{ id: 'general', name: '一般' }],
  latestVersions: { [APP_TYPE]: APP_VERSION },
  updatePackages: {},
};

// メイン到達不能がこの時間続き、もう一方が応答するなら自動切替（クライアント踏襲）
const FAILOVER_AFTER_MS = 12000;
const FAILOVER_COOLDOWN_MS = 30000;
// 設定画面でサーバーを選び直した後、この時間は占有数ベースの自動選択で上書きしない
const MANUAL_SERVER_STICKY_MS = 10 * 60 * 1000;

function sanitizeVolumePercent(value, fallback = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function sanitizeConfig(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const port = (value, fallback) => {
    const text = String(value ?? fallback).trim();
    return /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535 ? text : fallback;
  };
  const serverIp = String(raw.serverIp || DEFAULT_CONFIG.serverIp).trim() || DEFAULT_CONFIG.serverIp;
  const subServerIp = String(raw.subServerIp || '').trim();
  return {
    ...raw,
    serverIp,
    serverPort: port(raw.serverPort, DEFAULT_CONFIG.serverPort),
    subServerIp,
    subServerPort: port(raw.subServerPort, DEFAULT_CONFIG.subServerPort),
    // サブ未登録なら必ずメインに戻す（クライアントと同じ）
    activeServer: raw.activeServer === 'sub' && subServerIp ? 'sub' : 'main',
    displayName: String(raw.displayName || DEFAULT_CONFIG.displayName).trim() || DEFAULT_CONFIG.displayName,
    channelId: String(raw.channelId || DEFAULT_CONFIG.channelId).trim() || DEFAULT_CONFIG.channelId,
    shareResolution: RESOLUTION_OPTIONS.some(option => option.id === raw.shareResolution)
      ? raw.shareResolution
      : DEFAULT_CONFIG.shareResolution,
    shareAudio: raw.shareAudio === true,
    effectsVolume: sanitizeVolumePercent(raw.effectsVolume, DEFAULT_CONFIG.effectsVolume),
    shareConfirmed: raw.shareConfirmed === true,
  };
}

function loadConfig() {
  try {
    return sanitizeConfig(JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || '{}'));
  } catch {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
}

/** 現在使用するサーバー（メイン/サブ）のURL（クライアント踏襲） */
function serverUrlFromConfig(config) {
  const clean = sanitizeConfig(config);
  if (clean.activeServer === 'sub' && clean.subServerIp) {
    return `http://${clean.subServerIp}:${clean.subServerPort || 3000}`;
  }
  return `http://${clean.serverIp}:${clean.serverPort || 3000}`;
}

/** /ready → /health の順でサーバー到達確認（クライアント踏襲） */
async function probeServerReady(config, timeoutMs = 800) {
  const baseUrl = serverUrlFromConfig(config);
  for (const endpoint of ['/ready', '/health']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${endpoint}`, { signal: controller.signal, cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      // 次のエンドポイントを試す
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/** サーバーの接続拠点数を問い合わせる（サーバー選択用。クライアント踏襲） */
async function probeServerPresence(config, timeoutMs = 1200) {
  const baseUrl = serverUrlFromConfig(config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/presence`, { signal: controller.signal, cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const clientCount = Number(data.clientCount) || 0;
      // clientAppCount: 会議アプリ(client)のみの数。旧サーバーは合算値へフォールバック。
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
 * メイン/サブの接続拠点数を確認して接続すべきサーバーを返す（null=変更不要/判定不能）。
 * 画面共有は「会議アプリ(client)が居る方」へ寄せる。クライアント群だけが
 * フェイルオーバー/手動切替で移動すると、共有映像が誰にも届かなくなるため。
 */
async function chooseServerByOccupancy(config, { manualSelectionAt = 0 } = {}) {
  const conf = sanitizeConfig(config);
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
  // ルーティン再起動などの数秒のダウンで空のサーバーへ散らばるのを防ぐ
  // （本当の障害は自動フェイルオーバーの継続監視が拾う）。
  if (!info[current].reachable) {
    return info[other].reachable && info[other].clientAppCount > 0 ? other : null;
  }
  if (!info[other].reachable) return current;
  return info.main.clientAppCount >= info.sub.clientAppCount ? 'main' : 'sub';
}

function resolutionOf(config) {
  return RESOLUTION_OPTIONS.find(option => option.id === config.shareResolution) || RESOLUTION_OPTIONS[1];
}

/**
 * latest が current より新しいときだけ true（クライアントと同じ数値比較）。
 * 数値として解釈できない形式は従来どおり不一致で更新扱い。
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

function isScreenPermissionBlocked(status) {
  return ['denied', 'restricted'].includes(status);
}

function notifySharingActive(active) {
  try {
    const result = window.electronAPI?.setSharingActive?.(active);
    result?.catch?.(() => {});
  } catch {
    // Electron外（ブラウザ開発時）は無視
  }
}

/** Electron main 側に共有元を伝えてから getDisplayMedia で取得する */
async function getDisplayStream(source, withAudio, resolution) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('この環境では画面共有APIが利用できません。');
  }
  const selection = await window.electronAPI?.selectDisplaySource?.({
    id: source.id,
    name: source.name,
    kind: source.kind,
    includeAudio: withAudio,
  });
  if (selection && selection.ok === false) {
    throw new Error('共有元を選択できませんでした。');
  }

  return navigator.mediaDevices.getDisplayMedia({
    audio: !!withAudio,
    video: {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: resolution.width, max: resolution.width },
      height: { ideal: resolution.height, max: resolution.height },
    },
  });
}

/** 共有元一覧を取得（mode: 'screen' | 'window'） */
async function listSources(mode) {
  if (!window.electronAPI?.listDesktopSources) {
    throw new Error('Electronアプリとして起動してください。');
  }
  const result = await window.electronAPI.listDesktopSources({ mode });
  const sources = Array.isArray(result) ? result : (Array.isArray(result?.sources) ? result.sources : []);
  const permissionStatus = Array.isArray(result) ? 'unknown' : (result?.permissionStatus || 'unknown');
  const error = !Array.isArray(result) && result?.error ? result.error : '';
  return { sources, permissionStatus, error };
}

// ─── 共有元選択モーダル（アプリケーション / 画面ごと） ───────────

function SourcePickerModal({ mode, onPick, onClose }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [permission, setPermission] = useState('unknown');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listSources(mode);
      setSources(result.sources);
      setPermission(result.permissionStatus);
      if (!result.sources.length) {
        if (isScreenPermissionBlocked(result.permissionStatus)) {
          setError('画面収録権限が許可されていません。macOSのシステム設定で許可し、アプリを再起動してください。');
        } else if (result.error) {
          setError(`共有元を取得できませんでした: ${result.error}`);
        } else {
          setError(mode === 'window'
            ? '選択できるアプリウィンドウが見つかりません。共有したいアプリを開いてから再読み込みしてください。'
            : '選択できる画面が見つかりません。');
        }
      }
    } catch (err) {
      setSources([]);
      setError(err.message || '共有元を取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    // モーダルを開いた時点で共有元一覧を取得する（外部システム=desktopCapturerとの同期）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={mode === 'window' ? 'アプリケーションを選択' : '画面を選択'}>
      <div className="modal-panel source-picker">
        <div className="modal-head">
          <h1>{mode === 'window' ? '共有するアプリケーションを選択' : '共有する画面を選択'}</h1>
          <div className="modal-head-actions">
            <button type="button" className="icon-btn" onClick={refresh} disabled={loading} title="再読み込み" aria-label="再読み込み">
              <RefreshCw size={16} className={loading ? 'spinning' : ''} />
            </button>
            <button type="button" className="icon-btn" onClick={onClose} title="閉じる" aria-label="閉じる">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="source-grid">
          {sources.map(source => (
            <button key={source.id} type="button" className="source-card" onClick={() => onPick(source)}>
              <div className="thumb-wrap">
                {source.thumbnail
                  ? <img src={source.thumbnail} alt="" />
                  : <div className="thumb-empty">{mode === 'window' ? <AppWindow size={26} /> : <Monitor size={26} />}</div>}
                {source.appIcon && <img className="app-icon" src={source.appIcon} alt="" />}
              </div>
              <span title={source.name}>{source.name}</span>
            </button>
          ))}
          {!sources.length && (
            <div className="source-empty">
              <MonitorUp size={38} />
              <span>{loading ? '共有元を読み込み中…' : error}</span>
              {!loading && isScreenPermissionBlocked(permission) && (
                <div className="source-empty-actions">
                  <button type="button" onClick={() => window.electronAPI?.openScreenCaptureSettings?.()}>画面収録設定を開く</button>
                  <button type="button" onClick={() => window.electronAPI?.restartApp?.()}>アプリを再起動</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 本体 ─────────────────────────────────────────────

export default function App() {
  const [config, setConfig] = useState(() => loadConfig());
  const [settingsDraft, setSettingsDraft] = useState(() => loadConfig());
  const [settingsOpen, setSettingsOpen] = useState(() => !localStorage.getItem(CONFIG_STORAGE_KEY));
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [systemState, setSystemState] = useState(DEFAULT_SYSTEM_STATE);
  const [peers, setPeers] = useState([]);
  const [pickerMode, setPickerMode] = useState(null);          // null | 'window' | 'screen'
  const [confirmSource, setConfirmSource] = useState(null);    // 初回のみの共有確認対象
  const [sharing, setSharing] = useState(null);                // { sourceName, hasAudio }
  const [stream, setStream] = useState(null);
  const [updateNotice, setUpdateNotice] = useState(null);

  const managerRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const configRef = useRef(config);
  const stateRef = useRef({});
  const failoverRef = useRef({ downSince: null, lastSwitchAt: 0 });
  const probeInFlightRef = useRef(false);
  const connectSeqRef = useRef(0);
  const noticeTimerRef = useRef(null);
  // 設定画面でサーバーを手動選択した時刻（占有数ベースの自動選択より優先する期間の起点）
  const manualServerSelectAtRef = useRef(0);
  // 占有数の再収束チェック（自分だけ別サーバーに取り残された状態の自己修復）
  const reconvergeStrikesRef = useRef(0);

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => {
    stateRef.current = { status, error, sharing, stream, channelId: config.channelId };
  }, [status, error, sharing, stream, config.channelId]);

  const channels = useMemo(() => (
    Array.isArray(systemState.channels) && systemState.channels.length
      ? systemState.channels
      : DEFAULT_SYSTEM_STATE.channels
  ), [systemState.channels]);
  const activeChannel = channels.find(channel => channel.id === config.channelId) || channels[0];

  const channelMembers = useMemo(() => {
    const map = new Map();
    for (const peer of peers) {
      const list = map.get(peer.channelId) || [];
      list.push(peer);
      map.set(peer.channelId, list);
    }
    return map;
  }, [peers]);

  const updatePackage = systemState.updatePackages?.[APP_TYPE] || null;
  const latestVersion = systemState.latestVersions?.[APP_TYPE] || APP_VERSION;
  const updateAvailable = isNewerVersion(latestVersion, APP_VERSION);

  const effectsVolumeScale = useCallback(() => (
    sanitizeVolumePercent(configRef.current?.effectsVolume ?? 100) / 100
  ), []);

  const playEffectSound = useCallback((key, options = {}) => (
    playSystemSound(key, {
      ...options,
      volume: options.volume ?? effectsVolumeScale(),
    })
  ), [effectsVolumeScale]);

  const showNotice = useCallback((text) => {
    clearTimeout(noticeTimerRef.current);
    playEffectSound('notification');
    setNotice(text);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 5000);
  }, [playEffectSound]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream || null;
    if (stream) video.play().catch(() => {});
  }, [stream]);

  useEffect(() => { notifySharingActive(!!sharing); }, [sharing]);

  const stopLocalStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const stopShare = useCallback(async () => {
    const wasSharing = !!stateRef.current.sharing;
    await managerRef.current?.stopScreenShare().catch(() => {});
    stopLocalStream();
    notifySharingActive(false);
    setSharing(null);
    if (wasSharing) playEffectSound('screenShareStop');
  }, [playEffectSound, stopLocalStream]);

  /**
   * サーバーへ接続する。共有中に呼ばれた場合（フェイルオーバー・設定変更）は
   * ローカルの共有ストリームを止めずに、新しい接続へ produce し直して共有を継続する。
   */
  const connect = useCallback(async (nextConfig) => {
    const seq = connectSeqRef.current + 1;
    connectSeqRef.current = seq;
    managerRef.current?.disconnect({ stopTracks: false });

    setStatus('connecting');
    setError('');

    const clean = sanitizeConfig(nextConfig);
    const manager = new ScreenShareWebRTCManager();
    managerRef.current = manager;
    manager.setMaxBitrate(resolutionOf(clean).bitrate);
    manager.onConnectionChange = ok => {
      if (connectSeqRef.current !== seq) return;
      if (!ok && stateRef.current.status === 'connected') playEffectSound('audioDisconnect');
      setStatus(ok ? 'connected' : 'error');
    };
    manager.onSystemStateUpdated = state => {
      if (connectSeqRef.current !== seq) return;
      setSystemState({ ...DEFAULT_SYSTEM_STATE, ...state });
    };
    manager.onUpdateCommand = payload => setUpdateNotice(payload);
    // 同じ端末の別プロセスが接続中のため拒否された。manager側が再試行を
    // 抑制する(バックオフ)ので、UIで原因を知らせて待機する。
    manager.onSessionRejected = payload => {
      if (connectSeqRef.current !== seq) return;
      setStatus('error');
      setError(`「${payload?.locationName || clean.displayName}」の別の端末が接続中のため待機しています。別端末のアプリを終了してください。`);
    };

    await manager.connect(serverUrlFromConfig(clean), clean.displayName, {
      appVersion: APP_VERSION,
      channelId: clean.channelId,
    });
    if (connectSeqRef.current !== seq) return;
    setStatus('connected');
    playEffectSound('channelJoin');

    // 共有中の再接続なら、生きているトラックを新しい接続へ produce し直す
    const liveTrack = streamRef.current?.getVideoTracks().find(track => track.readyState === 'live');
    if (liveTrack && stateRef.current.sharing) {
      const audioTrack = streamRef.current?.getAudioTracks().find(track => track.readyState === 'live') || null;
      await manager.startScreenShare(liveTrack, stateRef.current.sharing.sourceName, audioTrack).catch(err => {
        console.warn('[ScreenShare] reshare after reconnect failed', err);
      });
    }
  }, [playEffectSound]);

  // 起動時に接続。接続前に他拠点がどちらのサーバーに集まっているかを確認して寄せる
  // （再起動タイミングの差で共有だけ別サーバーへ繋がり、誰にも届かないのを防ぐ）。
  useEffect(() => {
    (async () => {
      let target = sanitizeConfig(configRef.current);
      try {
        const choice = await chooseServerByOccupancy(target, {
          manualSelectionAt: manualServerSelectAtRef.current,
        });
        const current = target.activeServer === 'sub' ? 'sub' : 'main';
        if (choice && choice !== current) {
          target = sanitizeConfig({ ...target, activeServer: choice });
          saveConfig(target);
          setConfig(target);
          setSettingsDraft(target);
          console.warn(`[ServerSelect] 他拠点が接続している${choice === 'sub' ? 'サブ' : 'メイン'}サーバーへ接続します`);
        }
      } catch (err) {
        console.warn('[ServerSelect]', err.message);
      }
      await connect(target);
    })().catch(err => {
      setStatus('error');
      setError(err.message || 'サーバーに接続できません。');
    });
    return () => {
      connectSeqRef.current += 1;
      managerRef.current?.disconnect();
      streamRef.current?.getTracks().forEach(track => track.stop());
      notifySharingActive(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── サーバー到達確認 + 自動フェイルオーバー（クライアント踏襲） ───
  useEffect(() => {
    const id = setInterval(async () => {
      if (probeInFlightRef.current) return;
      const manager = managerRef.current;
      if (manager?.isSocketConnected() && manager?.isInitialized()) {
        failoverRef.current.downSince = null;
        return;
      }
      // 重複セッション拒否の待機中: サーバーは正常なので到達確認・フェイルオーバー・
      // 再接続促進はすべて不要（managerが待機明けに自動で再試行する）
      if (manager?.isSessionRejected?.()) {
        failoverRef.current.downSince = null;
        return;
      }

      probeInFlightRef.current = true;
      try {
        const conf = sanitizeConfig(configRef.current);
        const failover = failoverRef.current;
        const reachable = await probeServerReady(conf);
        if (reachable) {
          const wasDownFor = failover.downSince == null ? 0 : Date.now() - failover.downSince;
          failover.downSince = null;

          // 長い断のあとの復帰: その間に他拠点が別サーバーへ移っている可能性が
          // あるため、繋ぎ直す前に占有数を確認して同じサーバーへ寄せる（クライアント踏襲）
          if (manager && wasDownFor >= FAILOVER_AFTER_MS) {
            const choice = await chooseServerByOccupancy(conf, {
              manualSelectionAt: manualServerSelectAtRef.current,
            });
            const current = conf.activeServer === 'sub' ? 'sub' : 'main';
            if (choice && choice !== current) {
              failover.lastSwitchAt = Date.now();
              const switched = sanitizeConfig({ ...conf, activeServer: choice });
              saveConfig(switched);
              setConfig(switched);
              setSettingsDraft(switched);
              showNotice(choice === 'sub'
                ? '他拠点が接続しているサブサーバーへ切り替えます'
                : '他拠点が接続しているメインサーバーへ切り替えます');
              console.warn(`[Failover] occupancy-based switch to ${choice}`);
              await connect(switched).catch(err => console.warn('[Failover]', err.message));
              return;
            }
          }

          manager?.requestReconnect();
          return;
        }

        const now = Date.now();
        if (failover.downSince == null) failover.downSince = now;
        const otherServer = conf.activeServer === 'sub' ? 'main' : 'sub';
        const otherConfigured = otherServer === 'sub' ? !!conf.subServerIp : !!conf.serverIp;
        if (
          otherConfigured &&
          now - failover.downSince >= FAILOVER_AFTER_MS &&
          now - failover.lastSwitchAt >= FAILOVER_COOLDOWN_MS
        ) {
          const candidate = sanitizeConfig({ ...conf, activeServer: otherServer });
          if (await probeServerReady(candidate)) {
            failover.lastSwitchAt = Date.now();
            failover.downSince = null;
            saveConfig(candidate);
            setConfig(candidate);
            setSettingsDraft(candidate);
            showNotice(otherServer === 'sub'
              ? 'メインサーバーに接続できないため、サブサーバーへ切り替えます'
              : 'サブサーバーに接続できないため、メインサーバーへ切り替えます');
            await connect(candidate).catch(err => console.warn('[Failover]', err.message));
          }
        }
      } catch (err) {
        console.warn('[serverProbe]', err.message);
      } finally {
        probeInFlightRef.current = false;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [connect, showNotice]);

  // ─── 占有数の再収束: 「共有だけ別サーバー」の分裂を自己修復（クライアント踏襲） ───
  // 会議アプリ(client)が誰も居ないサーバーで共有し続けても映像は誰にも届かない。
  // 「現サーバーに会議アプリ0・もう一方には居る」が3回(約3分)続いた時だけ移動する。
  // サブ→メインは1拠点でも寄り、メイン→サブは2拠点以上で寄る片方向ルール。
  useEffect(() => {
    const id = setInterval(async () => {
      if (probeInFlightRef.current) return;
      const manager = managerRef.current;
      if (!manager?.isSocketConnected() || !manager?.isInitialized() || manager.isSessionRejected?.()) {
        reconvergeStrikesRef.current = 0;
        return;
      }
      const conf = sanitizeConfig(configRef.current);
      if (!conf.subServerIp) return;
      if (Date.now() - manualServerSelectAtRef.current < MANUAL_SERVER_STICKY_MS) {
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
      // 自分は screen-share なので clientAppCount はそのまま「他の会議アプリ数」
      const othersHere = cur.clientAppCount;
      const there = oth.clientAppCount;
      const shouldMove = othersHere === 0 && (other === 'main' ? there >= 1 : there >= 2);
      if (!shouldMove) {
        reconvergeStrikesRef.current = 0;
        return;
      }
      reconvergeStrikesRef.current += 1;
      if (reconvergeStrikesRef.current < 3) return;
      reconvergeStrikesRef.current = 0;

      failoverRef.current.lastSwitchAt = Date.now();
      const switched = sanitizeConfig({ ...conf, activeServer: other });
      saveConfig(switched);
      setConfig(switched);
      setSettingsDraft(switched);
      showNotice(other === 'sub'
        ? '他拠点が接続しているサブサーバーへ移動します'
        : '他拠点が接続しているメインサーバーへ移動します');
      console.warn(`[ServerSelect] occupancy reconverge to ${other} (clients here=${othersHere}, there=${there})`);
      await connect(switched).catch(err => console.warn('[ServerSelect]', err.message));
    }, 60000);
    return () => clearInterval(id);
  }, [connect, showNotice]);

  // ─── ピア一覧ポーリング（チャンネルのメンバー表示用） ───
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      const manager = managerRef.current;
      if (!manager?.isSocketConnected()) return;
      try {
        const list = await manager.getPeers();
        if (!stopped && Array.isArray(list)) setPeers(list);
      } catch {
        // 接続断のときは次の周期で再試行
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // ─── テレメトリ（サーバーGUIの監視表示用） ───
  useEffect(() => {
    const send = () => {
      const manager = managerRef.current;
      if (!manager) return;
      const state = stateRef.current;
      const videoTrack = state.stream?.getVideoTracks()[0] || null;
      manager.sendTelemetry({
        status: state.status,
        localMedia: {
          cameraEnabled: false,
          micEnabled: false,
          speakerMuted: true,
          screenSharing: !!state.sharing,
          screenSource: state.sharing?.sourceName || '',
          screen: trackReport(videoTrack),
          error: state.error || null,
        },
        remoteMonitor: { peerCount: 0, receivingVideoCount: 0, receivingAudioCount: 0, peers: [] },
        connection: { appStatus: state.status },
      });
    };
    send();
    const id = setInterval(send, 2000);
    return () => clearInterval(id);
  }, []);

  // ─── チャンネル変更 ───
  const changeChannel = useCallback(async (channelId) => {
    const previousChannelId = configRef.current.channelId || 'general';
    const next = sanitizeConfig({ ...configRef.current, channelId });
    saveConfig(next);
    setConfig(next);
    setSettingsDraft(prev => ({ ...prev, channelId }));
    try {
      await managerRef.current?.setChannel(channelId);
    } catch (err) {
      console.warn('[setChannel]', err.message);
    }
    if (previousChannelId !== next.channelId) playEffectSound('channelMove');
  }, [playEffectSound]);

  // ─── 共有開始 ───
  const beginShare = useCallback(async (source) => {
    setError('');
    const conf = sanitizeConfig(configRef.current);
    const resolution = resolutionOf(conf);
    let mediaStream = null;
    try {
      try {
        mediaStream = await getDisplayStream(source, conf.shareAudio, resolution);
      } catch (err) {
        if (!conf.shareAudio) throw err;
        console.warn('[ScreenShare] audio capture failed, retrying video only', err);
        showNotice('音声付き共有に失敗したため、映像のみで共有します');
        mediaStream = await getDisplayStream(source, false, resolution);
      }

      const track = mediaStream.getVideoTracks()[0];
      const audioTrack = mediaStream.getAudioTracks()[0] || null;
      if (!track) throw new Error('画面映像トラックを取得できませんでした。');
      if (conf.shareAudio && !audioTrack) {
        showNotice('この共有元から音声を取得できません。映像のみ共有します');
      }

      track.addEventListener('ended', () => {
        managerRef.current?.stopScreenShare().catch(() => {});
        notifySharingActive(false);
        setSharing(null);
        setStream(null);
        streamRef.current = null;
        playEffectSound('screenShareStop');
      }, { once: true });

      await managerRef.current?.startScreenShare(track, source.name, audioTrack);
      streamRef.current?.getTracks().forEach(item => item.stop());
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setSharing({ sourceName: source.name, hasAudio: !!audioTrack });
      setPickerMode(null);
      playEffectSound('screenShareStart');
    } catch (err) {
      mediaStream?.getTracks().forEach(item => item.stop());
      setError(err.message || '共有開始に失敗しました。');
    }
  }, [playEffectSound, showNotice]);

  /** 共有確認は初回のみ。確認済みなら即共有を開始する */
  const requestShare = useCallback((source) => {
    if (!configRef.current.shareConfirmed) {
      setConfirmSource(source);
      return;
    }
    beginShare(source);
  }, [beginShare]);

  const approveFirstShare = useCallback(() => {
    const source = confirmSource;
    setConfirmSource(null);
    const next = sanitizeConfig({ ...configRef.current, shareConfirmed: true });
    saveConfig(next);
    setConfig(next);
    setSettingsDraft(prev => ({ ...prev, shareConfirmed: true }));
    if (source) beginShare(source);
  }, [beginShare, confirmSource]);

  /** 全画面ボタン: メイン画面を即共有 */
  const shareFullScreen = useCallback(async () => {
    setError('');
    try {
      const { sources, permissionStatus, error: listError } = await listSources('screen');
      const source = sources[0];
      if (!source) {
        if (isScreenPermissionBlocked(permissionStatus)) {
          setError('画面収録権限が許可されていません。macOSのシステム設定で許可し、アプリを再起動してください。');
          window.electronAPI?.openScreenCaptureSettings?.();
        } else {
          setError(listError || '共有できる画面が見つかりません。');
        }
        return;
      }
      requestShare(source);
    } catch (err) {
      setError(err.message || '共有開始に失敗しました。');
    }
  }, [requestShare]);

  const toggleShareAudio = useCallback(() => {
    const next = sanitizeConfig({ ...configRef.current, shareAudio: !configRef.current.shareAudio });
    saveConfig(next);
    setConfig(next);
    setSettingsDraft(prev => ({ ...prev, shareAudio: next.shareAudio }));
    if (stateRef.current.sharing) {
      showNotice('音声設定は次回の共有開始時から適用されます');
    }
  }, [showNotice]);

  // ─── 設定保存 ───
  const updateSettingsDraft = useCallback((key, value) => {
    setSettingsDraft(prev => ({ ...prev, [key]: value }));
  }, []);

  const saveSettings = useCallback(async () => {
    const previous = sanitizeConfig(configRef.current);
    const next = sanitizeConfig({ ...previous, ...settingsDraft });
    // サーバーを選び直した場合は手動選択として記録し、占有数ベースの
    // 自動選択がしばらく上書きしないようにする（クライアントと同じ挙動）
    if (previous.activeServer !== next.activeServer) {
      manualServerSelectAtRef.current = Date.now();
    }
    saveConfig(next);
    setConfig(next);
    setSettingsDraft(next);
    setSettingsOpen(false);

    managerRef.current?.setMaxBitrate(resolutionOf(next).bitrate);

    const serverChanged =
      serverUrlFromConfig(previous) !== serverUrlFromConfig(next) ||
      previous.displayName !== next.displayName;
    if (serverChanged) {
      await connect(next).catch(err => {
        setStatus('error');
        setError(err.message || 'サーバーに接続できません。');
      });
    } else if (previous.channelId !== next.channelId) {
      await managerRef.current?.setChannel(next.channelId).catch(() => {});
    }
  }, [connect, settingsDraft]);

  const openUpdate = useCallback(() => {
    const url = updateNotice?.packageInfo?.url || updatePackage?.url;
    if (!url) return;
    window.electronAPI?.openExternal?.(url);
  }, [updateNotice, updatePackage]);

  const statusText = status === 'connected' ? '接続中' : status === 'error' ? 'サーバー未接続' : '接続中…';

  return (
    <div className="main-layout with-sidebar">
      {/* ── 左サイドバー（クライアントと同一構成: ブランド / チャンネル選択） ── */}
      <aside className="channel-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-mark">CH</div>
          <div>
            <div className="sidebar-title">CHECKHOUSE</div>
            <div className="sidebar-subtitle">Screen Share</div>
          </div>
        </div>

        <div className="active-channel-card">
          <Volume2 size={22} />
          <span>{activeChannel?.name || 'チャンネル'}</span>
          <button type="button" onClick={() => { setSettingsDraft(sanitizeConfig(config)); setSettingsOpen(true); }} title="設定" aria-label="設定">
            <Settings size={15} />
          </button>
        </div>

        <div className="channel-section-row">
          <span className="section-title">
            <span>ボイスチャンネル</span>
            <ChevronDown size={14} />
          </span>
        </div>

        <div className="channel-tree" aria-label="ボイスチャンネル">
          {channels.map(channel => {
            const members = channelMembers.get(channel.id) || [];
            const active = channel.id === config.channelId;
            return (
              <div key={channel.id} className={`voice-channel-node ${active ? 'active' : ''}`}>
                <button
                  type="button"
                  className="voice-channel-row"
                  onClick={() => changeChannel(channel.id)}
                  title={active ? channel.name : `${channel.name} に配信先を変更`}
                >
                  <Volume2 size={18} />
                  <span>{channel.name}</span>
                  <strong>{members.length}</strong>
                </button>
                <div className="voice-member-list">
                  {members.map(member => (
                    <div key={member.socketId} className={`voice-member ${member.isSelf ? 'self' : ''}`}>
                      <span className="member-avatar">{String(member.locationName || '?').slice(0, 2)}</span>
                      <span className="member-name">
                        {member.locationName || '拠点'}
                        {member.isSelf ? '（このアプリ）' : ''}
                        {member.appType === 'screen-share' && !member.isSelf ? '（画面共有）' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="sidebar-footer">
          {updateAvailable && (
            <button
              type="button"
              className="update-btn"
              onClick={openUpdate}
              disabled={!updatePackage?.url && !updateNotice?.packageInfo?.url}
            >
              <Download size={15} />
              <span>v{latestVersion} に更新</span>
            </button>
          )}
          <div className="version-line">Screen Share v{APP_VERSION}</div>
          {config.activeServer === 'sub' && <div className="sub-server-line">サブサーバー接続中</div>}
        </div>
      </aside>

      {/* ── メインステージ ── */}
      <div className="meeting-stage">
        <header className="stage-header">
          <div className="stage-channel">
            <Volume2 size={15} />
            <span>{activeChannel?.name || 'チャンネル'}</span>
            <em>へ配信{sharing ? '中' : '準備OK'}</em>
          </div>
          <div className={`conn-pill ${status}`}>
            <span className="conn-dot" />
            {statusText}
          </div>
        </header>

        {error && <div className="error-bar" role="alert">{error}</div>}
        {!error && notice && <div className="notice-bar">{notice}</div>}

        {sharing && (
          <div className="share-active-bar">
            <MonitorUp size={14} />
            <span className="share-bar-name">「{sharing.sourceName}」を共有中</span>
            {sharing.hasAudio && <span className="share-bar-audio"><Volume2 size={13} /> 音声あり</span>}
            <button type="button" className="share-bar-stop" onClick={stopShare}>
              <Square size={12} /> 停止
            </button>
          </div>
        )}

        <main className="stage-body">
          {stream ? (
            <div className="preview-wrap">
              <video ref={videoRef} autoPlay playsInline muted />
              <div className="preview-caption">送信中のプレビュー（{resolutionOf(config).label}）</div>
            </div>
          ) : (
            <div className="stage-empty">
              <MonitorUp size={52} />
              <h2>画面共有の準備ができました</h2>
              <p>
                下のボタンから共有を開始すると、<strong>{activeChannel?.name || 'チャンネル'}</strong> の拠点へ配信されます。<br />
                「全画面」はすぐに画面全体を共有します。
              </p>
            </div>
          )}
        </main>

        {/* ── コントロールバー（クライアントと同一デザイン） ── */}
        <div className="control-bar">
          <div className="ctrl-group">
            <button
              type="button"
              className={`ctrl-btn ${sharing ? '' : 'primary'}`}
              onClick={shareFullScreen}
              disabled={status !== 'connected'}
              title="画面全体をすぐに共有"
            >
              <Monitor size={20} />
              <span className="ctrl-btn-label">全画面</span>
            </button>
            <button
              type="button"
              className="ctrl-btn"
              onClick={() => setPickerMode('window')}
              disabled={status !== 'connected'}
              title="アプリケーションを選んで共有"
            >
              <AppWindow size={20} />
              <span className="ctrl-btn-label">アプリケーション</span>
            </button>
            <button
              type="button"
              className="ctrl-btn"
              onClick={() => setPickerMode('screen')}
              disabled={status !== 'connected'}
              title="ディスプレイを選んで共有"
            >
              <MonitorUp size={20} />
              <span className="ctrl-btn-label">画面ごと</span>
            </button>

            <div className="ctrl-separator" aria-hidden="true" />

            <button
              type="button"
              className={`ctrl-btn ${config.shareAudio ? '' : 'danger'}`}
              onClick={toggleShareAudio}
              title={config.shareAudio ? '共有音声をOFFにする' : '共有音声をONにする'}
              aria-pressed={config.shareAudio}
            >
              {config.shareAudio ? <Volume2 size={20} /> : <VolumeX size={20} />}
              <span className="ctrl-btn-label">音声共有</span>
            </button>
          </div>

          <div className="ctrl-group">
            {sharing && (
              <button type="button" className="ctrl-btn danger" onClick={stopShare} title="共有を停止">
                <Square size={20} />
                <span className="ctrl-btn-label">共有停止</span>
              </button>
            )}
            <button type="button" className="ctrl-btn" onClick={() => { setSettingsDraft(sanitizeConfig(config)); setSettingsOpen(true); }} title="設定">
              <Settings size={20} />
              <span className="ctrl-btn-label">設定</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── 共有元選択モーダル ── */}
      {pickerMode && (
        <SourcePickerModal
          mode={pickerMode}
          onPick={source => { setPickerMode(null); requestShare(source); }}
          onClose={() => setPickerMode(null)}
        />
      )}

      {/* ── 初回のみの共有確認 ── */}
      {confirmSource && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="画面共有の確認">
          <div className="modal-panel confirm-panel">
            <h1>画面共有を開始しますか？</h1>
            <p>
              「{confirmSource.name}」を <strong>{activeChannel?.name || 'チャンネル'}</strong> の拠点へ配信します。<br />
              この確認は初回のみ表示され、次回からはすぐに共有を開始します。
            </p>
            <div className="confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirmSource(null)}>キャンセル</button>
              <button type="button" className="primary" onClick={approveFirstShare}>共有を開始</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 設定モーダル（クライアントの接続設定を踏襲） ── */}
      {settingsOpen && (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="接続設定"
          onKeyDown={(event) => { if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') { event.preventDefault(); saveSettings(); } }}
        >
          <div className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <h1>接続設定</h1>
                <p>この画面を開いている間も共有は継続します</p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="閉じる">
                <X size={18} />
              </button>
            </div>

            <div className="settings-body">
              <div className="settings-section">
                <h2>基本設定</h2>
                <div className="field">
                  <label>表示名</label>
                  <input
                    type="text"
                    value={settingsDraft.displayName}
                    onChange={e => updateSettingsDraft('displayName', e.target.value)}
                    placeholder="例: 佐藤のPC"
                  />
                </div>
                <div className="field">
                  <label>配信先チャンネル</label>
                  <select
                    value={settingsDraft.channelId}
                    onChange={e => updateSettingsDraft('channelId', e.target.value)}
                  >
                    {channels.map(channel => (
                      <option key={channel.id} value={channel.id}>{channel.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>共有解像度</label>
                  <select
                    value={settingsDraft.shareResolution}
                    onChange={e => updateSettingsDraft('shareResolution', e.target.value)}
                  >
                    {RESOLUTION_OPTIONS.map(option => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  <p className="field-help">解像度を上げると細かい文字が読みやすくなりますが、回線負荷が上がります。</p>
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
                    <button type="button" className="ghost" onClick={() => playSystemSound('notification', { volume: sanitizeVolumePercent(settingsDraft.effectsVolume ?? 100) / 100 })}>
                      試聴
                    </button>
                  </div>
                  <p className="field-help">通知、チャンネル移動、共有開始・終了などの効果音です。</p>
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
                      placeholder="例: 192.168.10.5"
                    />
                  </div>
                  <div className="field port">
                    <label>ポート</label>
                    <input
                      type="text"
                      value={settingsDraft.serverPort}
                      onChange={e => updateSettingsDraft('serverPort', e.target.value)}
                    />
                  </div>
                </div>
                <div className="server-row">
                  <div className="field">
                    <label>サブ（保険）IPアドレス</label>
                    <input
                      type="text"
                      value={settingsDraft.subServerIp}
                      onChange={e => updateSettingsDraft('subServerIp', e.target.value)}
                      placeholder="例: cloud.example.jp / 203.0.113.10"
                    />
                  </div>
                  <div className="field port">
                    <label>ポート</label>
                    <input
                      type="text"
                      value={settingsDraft.subServerPort}
                      onChange={e => updateSettingsDraft('subServerPort', e.target.value)}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>使用するサーバー</label>
                  <select
                    value={settingsDraft.activeServer === 'sub' ? 'sub' : 'main'}
                    onChange={e => updateSettingsDraft('activeServer', e.target.value)}
                    disabled={!String(settingsDraft.subServerIp || '').trim()}
                  >
                    <option value="main">メインサーバー</option>
                    <option value="sub">サブサーバー</option>
                  </select>
                  <p className="field-help">
                    現在のサーバーに約{Math.round(FAILOVER_AFTER_MS / 1000)}秒間接続できず、
                    もう一方のサーバーが応答する場合は自動的に切り替えて再接続します。
                  </p>
                </div>
              </div>
            </div>

            <div className="settings-foot">
              <button type="button" className="save-btn" onClick={saveSettings}>保存して接続</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
