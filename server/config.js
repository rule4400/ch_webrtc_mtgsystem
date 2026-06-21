require('dotenv').config();
const os = require('os');

/** LAN上のIPv4アドレスを自動検出する */
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// 環境変数 ANNOUNCED_IP で上書き可能（VPN・パブリックIP対応）
// 拠点間（インターネット/VPN越し）で使う場合は、クライアントから到達可能な
// グローバルIP または VPN内IP を必ず ANNOUNCED_IP に指定すること。
const rawAnnouncedIp = (process.env.ANNOUNCED_IP || '').trim();
const localIp = rawAnnouncedIp || getLocalIp();
console.log(`[Config] Announced IP: ${localIp}`);
if (!rawAnnouncedIp) {
  console.warn('[Config] ANNOUNCED_IP 未設定: LAN IP を自動使用します。拠点間接続では到達可能なIPを ANNOUNCED_IP に設定してください。');
} else if (rawAnnouncedIp === '10.0.0.10') {
  console.warn('[Config] ANNOUNCED_IP がサンプル値 10.0.0.10 のままです。実際のVPN内IPか確認してください。');
}

const rtcMinPort = Number(process.env.RTC_MIN_PORT) || 10000;
const rtcMaxPort = Number(process.env.RTC_MAX_PORT) || 10200;

function envFlag(name, defaultValue = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

const forceTcpMedia = envFlag('FORCE_TCP_MEDIA', false);
if (forceTcpMedia) {
  console.warn('[Config] FORCE_TCP_MEDIA=true: WebRTC media transports will use TCP only.');
}

/**
 * クライアントへ渡す ICE サーバー（STUN/TURN）。
 * 拠点間で UDP がブロックされる環境では TURN を設定すると到達性が上がる。
 * 環境変数:
 *   STUN_URLS   例: "stun:stun.l.google.com:19302"（カンマ区切り可）
 *   TURN_URLS   例: "turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp"
 *   TURN_USER / TURN_PASS
 */
function buildIceServers() {
  const servers = [];
  const stun = process.env.STUN_URLS || '';
  for (const u of stun.split(',').map(s => s.trim()).filter(Boolean)) {
    servers.push({ urls: u });
  }
  if (process.env.TURN_URLS) {
    const urls = process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean);
    servers.push({
      urls,
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return servers;
}

module.exports = {
  listenIp: '0.0.0.0',
  listenPort: Number(process.env.PORT) || 3000,
  announcedIp: localIp,
  rtcPortRange: { min: rtcMinPort, max: rtcMaxPort },
  forceTcpMedia,

  // クライアントへ配布する ICE サーバー
  iceServers: buildIceServers(),

  mediasoup: {
    numWorkers: Math.min(os.cpus().length, 4),
    worker: {
      rtcMinPort,
      rtcMaxPort,
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: { 'x-google-start-bitrate': 1000 },
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: localIp, // LAN IPを自動検出
        },
      ],
      initialAvailableOutgoingBitrate: 600_000,
      minimumAvailableOutgoingBitrate: 150_000,
      maxSctpMessageSize: 262144,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    },
  },
};
