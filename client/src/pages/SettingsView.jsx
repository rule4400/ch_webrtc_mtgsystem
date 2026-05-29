/**
 * SettingsView.jsx – 接続設定（メイン画面からアクセス）
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export default function SettingsView() {
  const navigate = useNavigate();
  const [config, setConfig] = useState(() => {
    const defaults = {
      serverIp:   '192.168.1.1',
      serverPort: '3000',
      locationName: '自拠点',
    };
    const saved = localStorage.getItem('sfu_config');
    if (!saved) return defaults;
    try {
      return { ...defaults, ...JSON.parse(saved) };
    } catch {
      return defaults;
    }
  });

  const set = (key, val) => setConfig(prev => ({ ...prev, [key]: val }));

  const handleSave = () => {
    localStorage.setItem('sfu_config', JSON.stringify(config));
    navigate('/main');
  };

  return (
    <div className="settings-layout" style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 60 }}>
      <div className="settings-form" style={{ maxWidth: 440, width: '100%' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <button
            className="ctrl-btn"
            style={{ width: 36, height: 36 }}
            onClick={() => navigate('/main')}
          >
            <ArrowLeft size={18} />
          </button>
          <h1 style={{ fontSize: '1.4rem' }}>接続設定</h1>
        </div>

        <div className="settings-section">
          <h2>基本設定</h2>
          <div className="field">
            <label>拠点名（自分の表示名）</label>
            <input
              type="text"
              value={config.locationName}
              onChange={e => set('locationName', e.target.value)}
              placeholder="例: 東京本社"
            />
          </div>
        </div>

        <div className="settings-section">
          <h2>SFUサーバー</h2>
          <div className="field">
            <label>IPアドレス</label>
            <input
              type="text"
              value={config.serverIp}
              onChange={e => set('serverIp', e.target.value)}
              placeholder="例: 192.168.1.100"
            />
          </div>
          <div className="field">
            <label>ポート番号</label>
            <input
              type="text"
              value={config.serverPort}
              onChange={e => set('serverPort', e.target.value)}
              placeholder="3000"
            />
          </div>
          <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
            ※ サーバー起動時に表示される「Announced IP」を入力してください
          </p>
        </div>

        <button className="btn-join" onClick={handleSave}>
          保存して接続
        </button>
      </div>
    </div>
  );
}
