import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Monitor, MonitorUp, RefreshCw, Settings, Square, Volume2, X } from 'lucide-react';
import { ScreenShareWebRTCManager } from './services/screen-share-webrtc';

const APP_VERSION = '0.1.4';
const APP_TYPE = 'screen-share';
const DEFAULT_CONFIG = {
  serverIp: '127.0.0.1',
  serverPort: '3000',
  displayName: '画面共有',
};
const SCREEN_SHARE_INSTANCE_ID_KEY = 'sfu_screen_share_instance_id';
const DEFAULT_SYSTEM_STATE = {
  brand: 'CHECKHOUSE Meeting System',
  channels: [{ id: 'general', name: '一般' }],
  latestVersions: { [APP_TYPE]: APP_VERSION },
  updatePackages: {},
};

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

function sanitizeConfig(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const serverIp = String(raw.serverIp || DEFAULT_CONFIG.serverIp).trim() || DEFAULT_CONFIG.serverIp;
  const rawPort = String(raw.serverPort || DEFAULT_CONFIG.serverPort).trim();
  const serverPort = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535
    ? rawPort
    : DEFAULT_CONFIG.serverPort;
  const displayName = String(raw.displayName || DEFAULT_CONFIG.displayName).trim() || DEFAULT_CONFIG.displayName;
  return { ...raw, serverIp, serverPort, displayName };
}

function loadConfig() {
  try {
    return sanitizeConfig(JSON.parse(localStorage.getItem('sfu_screen_share_config') || '{}'));
  } catch {
    localStorage.removeItem('sfu_screen_share_config');
    return DEFAULT_CONFIG;
  }
}

function serverUrl(config) {
  const clean = sanitizeConfig(config);
  return `http://${clean.serverIp}:${clean.serverPort || 3000}`;
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

function isScreenPermissionGranted(status) {
  return status === 'granted';
}

function screenPermissionMessage(status, mode) {
  if (isScreenPermissionBlocked(status)) {
    return '画面収録権限が許可されていません。許可後はこのアプリを再起動してください。';
  }
  if (status === 'not-determined') {
    return '画面収録の許可がまだ確認されていません。共有元を読み込むと macOS の許可確認が表示されます。';
  }
  if (status === 'unknown') {
    return '権限状態を確認できません。共有元を読み込むボタンで画面またはアプリ一覧を取得してください。';
  }
  return mode === 'window'
    ? '共有したいアプリを開いてから共有元を読み込んでください。'
    : '共有元を読み込んで画面を選択してください。';
}

function notifySharingActive(active) {
  try {
    const result = window.electronAPI?.setSharingActive?.(active);
    result?.catch?.(() => {});
    return result;
  } catch {
    return null;
  }
}

async function getDisplayStream(source, withAudio) {
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
      frameRate: { ideal: 10, max: 10 },
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
    },
  });
}

export default function App() {
  const [config, setConfig] = useState(() => loadConfig());
  const [settingsDraft, setSettingsDraft] = useState(() => loadConfig());
  const [settingsOpen, setSettingsOpen] = useState(() => !localStorage.getItem('sfu_screen_share_config'));
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState('');
  const [mode, setMode] = useState('screen');
  const [sources, setSources] = useState([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [sourcePermission, setSourcePermission] = useState('unknown');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [stream, setStream] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [systemState, setSystemState] = useState(DEFAULT_SYSTEM_STATE);
  const [updateNotice, setUpdateNotice] = useState(null);
  const [updateDownload, setUpdateDownload] = useState(null);

  const managerRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const stateRef = useRef({});
  const refreshInFlightRef = useRef(null);
  const updateDownloadKeyRef = useRef('');

  const currentPlatform = window.electronAPI?.platform || '';
  const rawUpdatePackage = systemState.updatePackages?.[APP_TYPE] || null;
  const updatePackage = rawUpdatePackage?.platforms?.[currentPlatform] || rawUpdatePackage;
  const latestVersion = updatePackage?.version || systemState.latestVersions?.[APP_TYPE] || APP_VERSION;
  const updateAvailable = latestVersion && latestVersion !== APP_VERSION;
  const selectedSource = useMemo(() => sources.find(source => source.id === selectedSourceId) || sources[0] || null, [sources, selectedSourceId]);

  useEffect(() => {
    stateRef.current = { config, status, error, stream, sharing, selectedSource, mode, includeAudio };
  }, [config, status, error, stream, sharing, selectedSource, mode, includeAudio]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream || null;
    if (stream) video.play().catch(() => {});
  }, [stream]);

  useEffect(() => {
    notifySharingActive(sharing);
  }, [sharing]);

  useEffect(() => () => {
    notifySharingActive(false);
  }, []);

  const refreshSources = useCallback(async (nextMode = mode, options = {}) => {
    if (!options.force && isScreenPermissionBlocked(sourcePermission)) {
      setSources([]);
      setSelectedSourceId('');
      setSourceError(screenPermissionMessage(sourcePermission, nextMode));
      setSourceLoading(false);
      return [];
    }

    if (refreshInFlightRef.current?.mode === nextMode) {
      return refreshInFlightRef.current.request;
    }

    setSourceLoading(true);
    setSourceError('');
    const request = (async () => {
      if (!window.electronAPI?.listDesktopSources) {
        throw new Error('Electronアプリとして起動してください。');
      }
      const result = await window.electronAPI.listDesktopSources({ mode: nextMode });
      const next = Array.isArray(result) ? result : (Array.isArray(result?.sources) ? result.sources : []);
      const permissionStatus = Array.isArray(result) ? 'unknown' : (result?.permissionStatus || 'unknown');
      setSourcePermission(permissionStatus);
      setSources(next);
      setSelectedSourceId(current => (next.some(source => source.id === current) ? current : next[0]?.id || ''));

      if (!next.length) {
        if (isScreenPermissionBlocked(permissionStatus)) {
          setSourceError('画面収録権限が許可されていません。設定で許可してから再読み込みしてください。');
        } else if (!Array.isArray(result) && result?.error) {
          setSourceError(`共有元を取得できませんでした: ${result.error}`);
        } else {
          setSourceError(nextMode === 'window'
            ? '選択できるアプリウィンドウが見つかりません。共有したいアプリを開いてから再読み込みしてください。'
            : '選択できる画面が見つかりません。');
        }
      }

      return next;
    })();

    refreshInFlightRef.current = { mode: nextMode, request };
    try {
      return await request;
    } catch (err) {
      setSources([]);
      setSelectedSourceId('');
      setSourceError(err.message || '共有元を取得できませんでした。');
      return [];
    } finally {
      if (refreshInFlightRef.current?.request === request) {
        refreshInFlightRef.current = null;
      }
      setSourceLoading(false);
    }
  }, [mode, sourcePermission]);

  const checkScreenCaptureStatus = useCallback(async ({ autoLoad = false } = {}) => {
    try {
      if (!window.electronAPI?.getScreenCaptureStatus) {
        setSourcePermission('unknown');
        setSourceError(screenPermissionMessage('unknown', mode));
        return { permissionStatus: 'unknown' };
      }

      const result = await window.electronAPI.getScreenCaptureStatus();
      const permissionStatus = result?.permissionStatus || 'unknown';
      setSourcePermission(permissionStatus);

      if (isScreenPermissionBlocked(permissionStatus)) {
        setSources([]);
        setSelectedSourceId('');
        setSourceError(screenPermissionMessage(permissionStatus, mode));
      } else if (!sources.length) {
        setSourceError(screenPermissionMessage(permissionStatus, mode));
      }

      if (autoLoad && isScreenPermissionGranted(permissionStatus)) {
        await refreshSources(mode, { force: true });
      }

      return result;
    } catch (err) {
      setSourcePermission('unknown');
      setSourceError(err.message || screenPermissionMessage('unknown', mode));
      return { permissionStatus: 'unknown' };
    }
  }, [mode, refreshSources, sources.length]);

  const changeMode = useCallback((nextMode) => {
    setMode(nextMode);
    setSources([]);
    setSelectedSourceId('');
    setSourceError(screenPermissionMessage(sourcePermission, nextMode));
  }, [sourcePermission]);

  const openScreenCaptureSettings = useCallback(async () => {
    await window.electronAPI?.openScreenCaptureSettings?.();
    setSourceError('画面収録の許可を変更した場合は、このアプリを再起動してから共有元を読み込んでください。');
  }, []);

  const releaseRuntime = useCallback(() => {
    const manager = managerRef.current;
    managerRef.current = null;
    manager?.disconnect();
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    notifySharingActive(false);
    setStream(null);
    setSharing(false);
  }, []);

  const connect = useCallback(async (nextConfig = config) => {
    releaseRuntime();
    setStatus('connecting');
    setError('');

    const manager = new ScreenShareWebRTCManager();
    managerRef.current = manager;
    manager.onConnectionChange = ok => setStatus(ok ? 'connected' : 'error');
    manager.onSystemStateUpdated = state => setSystemState({ ...DEFAULT_SYSTEM_STATE, ...state });
    manager.onUpdateCommand = payload => setUpdateNotice(payload);

    await manager.connect(serverUrl(nextConfig), nextConfig.displayName, {
      appVersion: APP_VERSION,
      clientInstanceId: getOrCreateInstanceId(SCREEN_SHARE_INSTANCE_ID_KEY, APP_TYPE),
      platform: window.electronAPI?.platform || '',
    });
    setStatus('connected');
  }, [config, releaseRuntime]);

  useEffect(() => {
    // Initial connection is the Electron app startup handshake with the SFU server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect(config).catch(err => {
      setStatus('error');
      setError(err.message);
    });
    checkScreenCaptureStatus({ autoLoad: true }).catch(() => {});
    return () => releaseRuntime();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startShare = useCallback(async () => {
    setError('');
    const currentSources = sources.length ? sources : await refreshSources(mode);
    const source = currentSources.find(item => item.id === selectedSourceId) || currentSources[0];
    if (!source) {
      setError(sourceError || '共有元が見つかりません。');
      return;
    }

    let mediaStream = null;
    try {
      try {
        mediaStream = await getDisplayStream(source, includeAudio);
      } catch (err) {
        if (!includeAudio) throw err;
        console.warn('[ScreenShare] audio capture failed, retrying video only', err);
        setError('音声付き共有に失敗したため、映像のみで共有を開始しました。');
        mediaStream = await getDisplayStream(source, false);
      }

      const track = mediaStream.getVideoTracks()[0];
      const audioTrack = mediaStream.getAudioTracks()[0] || null;
      if (!track) throw new Error('画面映像トラックを取得できませんでした。');
      if (includeAudio && !audioTrack) {
        setError('この共有元から音声トラックを取得できませんでした。映像のみ共有します。');
      }

      track.addEventListener('ended', () => {
        managerRef.current?.stopScreenShare().catch(() => {});
        notifySharingActive(false);
        setSharing(false);
        setStream(null);
        streamRef.current = null;
      }, { once: true });

      await managerRef.current?.startScreenShare(track, source.name, audioTrack);
      streamRef.current?.getTracks().forEach(item => item.stop());
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setSharing(true);
    } catch (err) {
      mediaStream?.getTracks().forEach(track => track.stop());
      setError(err.message || '共有開始に失敗しました。');
    }
  }, [includeAudio, mode, refreshSources, selectedSourceId, sourceError, sources]);

  const stopShare = useCallback(async () => {
    await managerRef.current?.stopScreenShare();
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    await notifySharingActive(false);
    setStream(null);
    setSharing(false);
  }, []);

  const saveSettings = useCallback(async () => {
    const next = sanitizeConfig(settingsDraft);
    localStorage.setItem('sfu_screen_share_config', JSON.stringify(next));
    setConfig(next);
    setSettingsDraft(next);
    setSettingsOpen(false);
    await connect(next);
  }, [connect, settingsDraft]);

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
    const sendTelemetry = () => {
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
          screenSource: state.selectedSource?.name || '',
          screen: trackReport(videoTrack),
          error: state.error || null,
        },
        remoteMonitor: {
          peerCount: 0,
          receivingVideoCount: 0,
          receivingAudioCount: 0,
          peers: [],
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

  return (
    <div className="share-shell">
      <aside className="share-sidebar">
        <div className="brand">
          <div className="brand-mark">CH</div>
          <div>
            <div className="brand-title">CHECKHOUSE</div>
            <div className="brand-sub">Screen Share</div>
          </div>
        </div>

        <div className="status-card">
          <span className={`status-dot ${status}`} />
          <span>
            {status === 'connected' ? '接続中' : status === 'error' ? 'サーバー未接続' : '接続中...'}
          </span>
        </div>

        <div className="source-mode">
          <button className={mode === 'screen' ? 'active' : ''} onClick={() => changeMode('screen')}>
            画面全体
          </button>
          <button className={mode === 'window' ? 'active' : ''} onClick={() => changeMode('window')}>
            アプリ
          </button>
        </div>

        <button className="side-btn" onClick={() => refreshSources(mode)} disabled={sourceLoading}>
          <RefreshCw size={16} />
          <span>{sourceLoading ? '読み込み中' : '共有元を読み込む'}</span>
        </button>
        <button
          className={`audio-toggle ${includeAudio ? 'active' : ''}`}
          onClick={() => setIncludeAudio(value => !value)}
          aria-pressed={includeAudio}
          disabled={sharing}
        >
          <Volume2 size={16} />
          <span>音声共有</span>
          <strong>{includeAudio ? 'ON' : 'OFF'}</strong>
        </button>
        <button className="side-btn" onClick={() => setSettingsOpen(true)}>
          <Settings size={16} />
          <span>設定</span>
        </button>

        <div className="sidebar-bottom">
          {updateAvailable && (
            <button
              className="update-btn"
              onClick={openUpdate}
              disabled={!updatePackage?.url && !updateNotice?.packageInfo?.url && updateDownload?.status !== 'ready'}
              title={updateDownload?.status === 'ready' ? 'ダウンロード済みアップデートを開く' : 'アップデート'}
            >
              <Download size={15} />
              <span>v{latestVersion}</span>
            </button>
          )}
          <div>Screen Share v{APP_VERSION}</div>
        </div>
      </aside>

      <main className="share-main">
        {error && <div className="error-bar">{error}</div>}

        <section className="source-grid">
          {sources.map(source => (
            <button
              key={source.id}
              type="button"
              className={`source-card ${source.id === selectedSource?.id ? 'active' : ''}`}
              onClick={() => setSelectedSourceId(source.id)}
            >
              <div className="thumb-wrap">
                {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <div className="thumb-empty"><Monitor size={28} /></div>}
                {source.appIcon && <img className="app-icon" src={source.appIcon} alt="" />}
              </div>
              <span>{source.name}</span>
              <small>{source.kind === 'window' ? 'アプリ' : '画面全体'}</small>
            </button>
          ))}
          {!sources.length && (
            <div className="empty-state">
              <MonitorUp size={44} />
              <span>{sourceLoading ? '共有元を読み込み中' : (sourceError || '共有元がありません')}</span>
              {!sourceLoading && (
                <div className="empty-actions">
                  <button className="inline-btn" onClick={() => refreshSources(mode)}>
                    共有元を読み込む
                  </button>
                  <button className="ghost-btn" onClick={() => checkScreenCaptureStatus()}>
                    状態を再確認
                  </button>
                  {(isScreenPermissionBlocked(sourcePermission) || sourcePermission === 'not-determined') && (
                    <button className="ghost-btn" onClick={openScreenCaptureSettings}>
                      画面収録設定
                    </button>
                  )}
                  {isScreenPermissionBlocked(sourcePermission) && (
                    <button className="ghost-btn" onClick={() => window.electronAPI?.restartApp?.()}>
                      アプリ再起動
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="preview-panel">
          {stream ? (
            <video ref={videoRef} autoPlay playsInline muted />
          ) : (
            <div className="preview-empty">
              <MonitorUp size={46} />
              <span>{selectedSource?.name || '共有元未選択'}</span>
            </div>
          )}
        </section>

        <div className="bottom-bar">
          <div className="share-target">{config.displayName} / {selectedSource?.name || '-'} / 音声 {includeAudio ? 'ON' : 'OFF'}</div>
          {sharing ? (
            <button className="stop-btn" onClick={stopShare}>
              <Square size={17} />
              <span>共有停止</span>
            </button>
          ) : (
            <button className="start-btn" onClick={startShare} disabled={status !== 'connected' || !selectedSource}>
              <MonitorUp size={18} />
              <span>共有開始</span>
            </button>
          )}
        </div>
      </main>

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <div className="settings-panel">
            <div className="settings-head">
              <div>
                <h1>接続設定</h1>
                <p>画面共有アプリは他拠点映像を受信しません</p>
              </div>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="閉じる">
                <X size={18} />
              </button>
            </div>
            <div className="field">
              <label>表示名</label>
              <input value={settingsDraft.displayName} onChange={event => setSettingsDraft(prev => ({ ...prev, displayName: event.target.value }))} />
            </div>
            <div className="server-row">
              <div className="field">
                <label>サーバーIP</label>
                <input value={settingsDraft.serverIp} onChange={event => setSettingsDraft(prev => ({ ...prev, serverIp: event.target.value }))} />
              </div>
              <div className="field">
                <label>ポート</label>
                <input value={settingsDraft.serverPort} onChange={event => setSettingsDraft(prev => ({ ...prev, serverPort: event.target.value }))} />
              </div>
            </div>
            <button className="save-btn" onClick={saveSettings}>保存して接続</button>
          </div>
        </div>
      )}
    </div>
  );
}
