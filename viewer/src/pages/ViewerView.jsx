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

  const managerRef = useRef(null);
  const configRef = useRef({});

  const refreshAudioOutputs = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(device => device.kind === 'audiooutput');
      setAudioOutDevices(outputs);
      if (!selectedAudioOutId && outputs[0]?.deviceId) {
        setSelectedAudioOutId(outputs[0].deviceId);
      }
    } catch {
      // setSinkId/audiooutput enumeration is not available on every platform.
    }
  }, [selectedAudioOutId]);

  useEffect(() => {
    let manager = null;

    const init = async () => {
      const saved = localStorage.getItem('sfu_viewer_config');
      const config = saved
        ? JSON.parse(saved)
        : { serverIp: '127.0.0.1', serverPort: '3000', viewerName: '閲覧端末' };
      configRef.current = config;
      setSelectedAudioOutId(config.selectedAudioOutId || '');

      await refreshAudioOutputs();

      manager = new ViewerWebRTCManager();
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
      manager.onRestartCommand = () => window.electronAPI?.restartApp?.();

      try {
        const serverUrl = `http://${config.serverIp}:${config.serverPort || 3000}`;
        await manager.connect(serverUrl, config.viewerName);
        setStatus('connected');
        setError(null);
      } catch (err) {
        console.error('[Viewer]', err);
        setStatus('error');
        setError(err.message);
      }
    };

    init();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioOutputs);

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshAudioOutputs);
      manager?.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => managerRef.current?.syncPeers(), 1000);
    return () => clearInterval(id);
  }, []);

  const changeSpeaker = useCallback((deviceId) => {
    setSelectedAudioOutId(deviceId);
    const config = { ...configRef.current, selectedAudioOutId: deviceId };
    configRef.current = config;
    localStorage.setItem('sfu_viewer_config', JSON.stringify(config));
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
                  status === 'error' ? '#ef4444' : '#facc15',
              }}
            />
            {status === 'connected' ? `受信中 ${peerList.length}拠点` :
             status === 'error' ? 'サーバー未接続' : '接続中...'}
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
              key={socketId}
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
