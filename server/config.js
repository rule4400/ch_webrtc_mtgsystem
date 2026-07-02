require('dotenv').config();
const os = require('os');

/** LAN上の非内部 IPv4 アドレスを全て列挙する（多重ホーム/VPN仮想NIC対応） */
function localIpv4List() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // リンクローカル(APIPA 169.254/16)は拠点間で到達不能。ICE候補に入れると
      // 無駄な失敗ペアが増えて疎通確認が遅くなるだけなので除外する。
      if (iface.address.startsWith('169.254.')) continue;
      list.push(iface.address);
    }
  }
  return list;
}

/** LAN上のIPv4アドレスを自動検出する（先頭1件） */
function getLocalIp() {
  return localIpv4List()[0] || '127.0.0.1';
}

function parseIpList(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * クライアントの ICE 候補として広告するIPの集合を決める。
 *
 * 拠点間 VPN（RTX L2TP/IPsec・フレッツVPNワイド等）では L2/L3 が混在し、
 * サーバーの「正しい到達IP」が拠点ごとに異なる。1つの announcedIp だけだと
 * 一部拠点からメディアが届かない（シグナリングは通るのに映像が来ない）。
 *
 * そこで:
 *   - ANNOUNCED_IP / ANNOUNCED_IPS が明示されていればそれを使う（管理者が把握）
 *   - 未指定なら 非内部 IPv4 を全て広告して、ICE が到達可能なペアを選べるようにする
 * 複数候補は ICE が自動で疎通確認するため、不達候補は無視され、正しい経路が使われる。
 */
function buildAnnouncedIps() {
  const explicit = [
    ...parseIpList(process.env.ANNOUNCED_IP),
    ...parseIpList(process.env.ANNOUNCED_IPS),
  ];
  const addLocal = !explicit.length || /^(1|true|yes)$/i.test(process.env.ANNOUNCED_ADD_LOCAL || '');
  const merged = [...explicit];
  if (addLocal) merged.push(...localIpv4List());
  const deduped = Array.from(new Set(merged.filter(Boolean)));
  return deduped.length ? deduped : [getLocalIp()];
}

const announcedIps = buildAnnouncedIps();
const localIp = announcedIps[0]; // 一次広告IP（/health 表示・更新URL解決に使用）
const rawAnnouncedIp = (process.env.ANNOUNCED_IP || '').trim();
console.log(`[Config] Announced IPs: ${announcedIps.join(', ')}`);
if (!rawAnnouncedIp && !process.env.ANNOUNCED_IPS) {
  console.warn(`[Config] ANNOUNCED_IP 未設定: 非内部IPv4を全て広告します (${announcedIps.join(', ')})。拠点間接続では到達可能なVPN内IPを ANNOUNCED_IP に明示するのが確実です。`);
} else if (announcedIps.includes('10.0.0.10')) {
  console.warn('[Config] ANNOUNCED_IP にサンプル値 10.0.0.10 が含まれます。実際のVPN内IPか確認してください。');
}

const rtcMinPort = Number(process.env.RTC_MIN_PORT) || 10000;
const rtcMaxPort = Number(process.env.RTC_MAX_PORT) || 10200;

/**
 * メディア伝送のTCP設定。
 *   FORCE_TCP=1  … UDPを無効化し、全メディアをTCP(ICE-TCP)で送受信する
 *   PREFER_TCP=1 … UDPも有効なままTCP候補を優先する（UDPが不安定な環境向け）
 * どちらも未指定ならUDP優先（既定）。TCPはHoLブロッキングで遅延が増えるため、
 * UDPが通る環境ではUDP優先のままにすること。
 */
const forceTcp = /^(1|true|yes)$/i.test(process.env.FORCE_TCP || '');
const preferTcp = forceTcp || /^(1|true|yes)$/i.test(process.env.PREFER_TCP || '');
if (forceTcp) console.log('[Config] FORCE_TCP=1: メディアはTCPのみで伝送します');
else if (preferTcp) console.log('[Config] PREFER_TCP=1: TCP候補を優先します');

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * ビットレート設定（bps）。サーバー側の既定値で、getServerConfig 経由で
 * 全クライアントに配布される。クライアント側の画質設定(高/中/低)は
 * この値に対する倍率として適用される。
 *   VIDEO_MAX_BITRATE  … カメラ映像の最上位レイヤ上限（既定 1200000）
 *   SCREEN_MAX_BITRATE … 画面共有の最上位レイヤ上限（既定 1800000）
 *   AUDIO_MAX_BITRATE  … Opus音声の平均ビットレート上限（既定 0 = コーデック既定）
 */
const mediaSettings = {
  videoMaxBitrate: clampInt(process.env.VIDEO_MAX_BITRATE, 100_000, 8_000_000, 1_200_000),
  screenMaxBitrate: clampInt(process.env.SCREEN_MAX_BITRATE, 100_000, 10_000_000, 1_800_000),
  audioMaxBitrate: clampInt(process.env.AUDIO_MAX_BITRATE, 0, 510_000, 0),
};

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
  announcedIps,
  rtcPortRange: { min: rtcMinPort, max: rtcMaxPort },

  // クライアントへ配布する ICE サーバー
  iceServers: buildIceServers(),

  // メディア伝送設定（getServerConfig でクライアントへ配布）
  mediaTransport: { forceTcp, preferTcp },
  mediaSettings,

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
      // 各 announcedIp を ICE 候補として広告する。混在ネットワークでも
      // 到達可能な候補を ICE が選ぶ（不達候補は自動で除外される）。
      listenIps: announcedIps.map(ip => ({ ip: '0.0.0.0', announcedIp: ip })),
      initialAvailableOutgoingBitrate: 1_000_000,
      minimumAvailableOutgoingBitrate: 600_000,
      maxSctpMessageSize: 262144,
      enableUdp: !forceTcp,
      enableTcp: true,
      preferUdp: !preferTcp,
      preferTcp,
    },
  },
};
