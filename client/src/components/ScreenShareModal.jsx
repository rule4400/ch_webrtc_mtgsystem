/**
 * ScreenShareModal.jsx – 画面共有の共有元選択モーダル
 *
 * 「画面全体」「アプリ」「ウィンドウ」をタブで切り替え、サムネイル付きで選択する。
 * - アプリタブ: ウィンドウをアプリ単位にまとめて表示（選択するとそのアプリの先頭ウィンドウを共有）
 * - 音声共有は Windows のみ対応（macOSはOSのループバック制約）
 * - macOS の画面収録権限は繰り返しダイアログを出さず、状態表示と設定画面への案内で対応する
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Monitor, AppWindow, LayoutGrid, RefreshCw, X, Volume2 } from 'lucide-react';

const TABS = [
  { id: 'screen', label: '画面全体', Icon: Monitor },
  { id: 'app', label: 'アプリ', Icon: LayoutGrid },
  { id: 'window', label: 'ウィンドウ', Icon: AppWindow },
];

/** ウィンドウ一覧をアプリ単位にまとめる（アイコンの一致を優先、なければ名前） */
function groupByApp(windowSources) {
  const groups = new Map();
  for (const source of windowSources) {
    const key = source.appIcon || source.name;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...source, windowCount: 1 });
    } else {
      existing.windowCount += 1;
    }
  }
  return Array.from(groups.values());
}

export default function ScreenShareModal({ open, isChanging, onClose, onSelect }) {
  const [tab, setTab] = useState('screen');
  const [screens, setScreens] = useState([]);
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [withAudio, setWithAudio] = useState(false);
  const [permission, setPermission] = useState('granted');
  const [loadError, setLoadError] = useState('');

  const platform = window.electronAPI?.platform || 'unknown';
  const audioSupported = platform === 'win32';

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.listDesktopSources) {
      setLoadError('この環境では画面共有を利用できません（Electron専用機能）');
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const [screenResult, windowResult] = await Promise.all([
        window.electronAPI.listDesktopSources({ mode: 'screen' }),
        window.electronAPI.listDesktopSources({ mode: 'window' }),
      ]);
      setScreens(screenResult?.sources || []);
      setWindows(windowResult?.sources || []);
      setPermission(screenResult?.permissionStatus || windowResult?.permissionStatus || 'granted');
      const error = screenResult?.error || windowResult?.error;
      if (error) setLoadError(error);
    } catch (err) {
      console.error('[ScreenShareModal]', err);
      setLoadError(err.message || '共有元一覧を取得できませんでした');
      setScreens([]);
      setWindows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [open, refresh]);

  const items = useMemo(() => {
    if (tab === 'screen') return screens;
    if (tab === 'window') return windows;
    return groupByApp(windows);
  }, [screens, windows, tab]);

  if (!open) return null;

  const permissionDenied = platform === 'darwin' && permission !== 'granted';

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="画面共有の共有元選択">
      <div className="settings-panel share-modal">
        <div className="settings-panel-head">
          <div>
            <h1>{isChanging ? '共有元を変更' : '画面共有'}</h1>
            <p>共有する画面・アプリ・ウィンドウを選択してください</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
        </div>

        {permissionDenied && (
          <div className="share-permission-bar">
            <span>
              macOSの画面収録権限が許可されていません（状態: {permission}）。
              システム設定で許可後、アプリの再起動が必要です。
            </span>
            <button
              type="button"
              className="mini-btn-like"
              onClick={() => window.electronAPI?.openScreenCaptureSettings?.()}
            >
              システム設定を開く
            </button>
          </div>
        )}

        {loadError && !permissionDenied && (
          <div className="share-permission-bar">{loadError}</div>
        )}

        <div className="share-tabs">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`share-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
          <button type="button" className="share-refresh-btn" title="一覧を更新" onClick={refresh}>
            <RefreshCw size={14} className={loading ? 'share-spin' : ''} />
          </button>
        </div>

        <div className="share-grid">
          {items.length === 0 && (
            <div className="share-empty">{loading ? '取得中…' : '選択できる共有元がありません'}</div>
          )}
          {items.map(source => (
            <button
              key={source.id}
              type="button"
              className="share-source"
              onClick={() => onSelect(source, withAudio && audioSupported)}
              disabled={permissionDenied}
            >
              <div className="share-thumb">
                {source.thumbnail
                  ? <img src={source.thumbnail} alt="" />
                  : <Monitor size={28} color="rgba(255,255,255,0.3)" />}
              </div>
              <div className="share-source-label">
                {source.appIcon && <img className="share-app-icon" src={source.appIcon} alt="" />}
                <span>{source.name}</span>
                {source.windowCount > 1 && <span className="share-window-count">({source.windowCount})</span>}
              </div>
            </button>
          ))}
        </div>

        <label className={`share-audio-toggle ${audioSupported ? '' : 'disabled'}`}>
          <input
            type="checkbox"
            checked={withAudio && audioSupported}
            disabled={!audioSupported}
            onChange={event => setWithAudio(event.target.checked)}
          />
          <Volume2 size={14} />
          音声も共有する
          {!audioSupported && <span className="share-audio-note">（Windowsのみ対応）</span>}
        </label>
      </div>
    </div>
  );
}
