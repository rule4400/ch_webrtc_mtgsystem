import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export default function SettingsView() {
  const navigate = useNavigate();
  const [config, setConfig] = useState(() => {
    const defaults = {
      serverIp: '127.0.0.1',
      serverPort: '3000',
      viewerName: '閲覧端末',
    };
    const saved = localStorage.getItem('sfu_viewer_config');
    if (!saved) return defaults;
    try {
      return { ...defaults, ...JSON.parse(saved) };
    } catch {
      return defaults;
    }
  });

  const set = (key, value) => setConfig(prev => ({ ...prev, [key]: value }));

  const handleSave = () => {
    localStorage.setItem('sfu_viewer_config', JSON.stringify(config));
    navigate('/viewer');
  };

  return (
    <div className="settings-layout" style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 60 }}>
      <div className="settings-form" style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <button
            className="ctrl-btn"
            style={{ width: 36, height: 36 }}
            onClick={() => navigate('/viewer')}
            title="戻る"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 style={{ fontSize: '1.4rem' }}>閲覧アプリ設定</h1>
        </div>

        <div className="settings-section">
          <h2>表示設定</h2>
          <div className="field">
            <label>閲覧端末名</label>
            <input
              type="text"
              value={config.viewerName}
              onChange={e => set('viewerName', e.target.value)}
              placeholder="例: 管理室モニター"
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
              placeholder="例: 10.0.0.10"
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
            SFUサーバーGUIの `.env` に設定した VPN 内 IP を入力してください
          </p>
        </div>

        <button className="btn-join" onClick={handleSave}>
          保存して閲覧開始
        </button>
      </div>
    </div>
  );
}
