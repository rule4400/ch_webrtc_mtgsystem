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
 * メディア固定ポート(WebRtcServer)。RTC_PORT を指定すると、全クライアントの
 * メディア(UDP/TCP)がこの1ポートに集約される。
 *
 * UTM/ファイアウォール設置拠点では「動的な高ポート範囲のUDP」がIPS/アプリ制御で
 * 遮断されやすく、transportごとにポートが変わる従来方式は「たまたま通る/通らない」
 * を生む。固定ポートなら UTM 側の許可設定が「サーバーIPの UDP/TCP 1ポート」で
 * 済み、挙動も決定的になる。未指定なら従来どおり RTC_MIN/MAX_PORT の範囲を使う。
 */
const rtcPort = Number(process.env.RTC_PORT) || 0;

/**
 * 追加TCP待受ポート（カンマ区切り、例: "443"）。RTC_PORT 固定ポートモード時のみ有効。
 * UTM/FWが「外向きTCP 443しか通さない」拠点でも、mediasoup が443で直接
 * ICE-TCP を待ち受けることで、TURN中継なしにメディア経路を確立できる。
 * ※1024未満のポートは root/管理者権限が必要。バインドできない場合は
 *   追加ポート無しで自動的に縮退起動する。
 */
const rtcExtraTcpPorts = parseIpList(process.env.RTC_EXTRA_TCP_PORTS)
  .map(value => Number(value))
  .filter(port => Number.isInteger(port) && port >= 1 && port <= 65535 && port !== rtcPort);

/**
 * WebRtcServer 用の listenInfos を構築する。
 * announced IP がこのマシンのローカルIPなら、そのIPに直接 bind する
 * （同一ポートに複数のワイルドカードbindはできないため）。
 * NAT越し等でローカルに存在しないIPを広告する場合は 0.0.0.0 に1本だけ bind し、
 * そのIPを announcedAddress として広告する。
 */
function buildRtcListenInfos(port, extraTcpPorts = []) {
  const locals = new Set(localIpv4List());
  const localAnnounced = announcedIps.filter(ip => locals.has(ip));
  const nonLocalAnnounced = announcedIps.filter(ip => !locals.has(ip));
  const infos = [];

  const pushFor = (ip, announcedAddress) => {
    infos.push({ protocol: 'udp', ip, announcedAddress, port });
    infos.push({ protocol: 'tcp', ip, announcedAddress, port });
    // 追加TCP待受（443等）。UTMが443しか通さない拠点向けのICE-TCP直接経路
    for (const extraPort of extraTcpPorts) {
      infos.push({ protocol: 'tcp', ip, announcedAddress, port: extraPort });
    }
  };

  if (localAnnounced.length) {
    for (const ip of localAnnounced) pushFor(ip, ip);
    if (nonLocalAnnounced.length) {
      console.warn(`[Config] RTC_PORT 固定ポートモードではローカルに存在しないIP (${nonLocalAnnounced.join(', ')}) は広告できません。NAT配下で使う場合は ANNOUNCED_IP にローカルIPを指定してください。`);
    }
  } else if (nonLocalAnnounced.length) {
    pushFor('0.0.0.0', nonLocalAnnounced[0]);
    if (nonLocalAnnounced.length > 1) {
      console.warn(`[Config] RTC_PORT 固定ポートモードで広告できるNAT越しIPは1つだけです (${nonLocalAnnounced[0]} を使用)`);
    }
  }
  return infos;
}

if (rtcPort) {
  const extra = rtcExtraTcpPorts.length ? ` + 追加TCP待受 ${rtcExtraTcpPorts.join(', ')}` : '';
  console.log(`[Config] RTC_PORT=${rtcPort}: メディアを固定ポート(UDP/TCP ${rtcPort})に集約します${extra}`);
} else if (rtcExtraTcpPorts.length) {
  console.warn('[Config] RTC_EXTRA_TCP_PORTS は RTC_PORT(固定ポートモード)と併用したときのみ有効です');
}

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
 *   TURN_URLS   例: "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp"
 *   TURN_USER / TURN_PASS
 */
function buildIceServers() {
  const servers = [];
  const stun = process.env.STUN_URLS || '';
  const validIceUrl = (url, schemes) => {
    const match = /^(stuns?|turns?):(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url);
    return !!match && schemes.includes(match[1].toLowerCase()) && (!match[2] || Number(match[2]) <= 65535);
  };
  for (const u of stun.split(',').map(s => s.trim()).filter(u => validIceUrl(u, ['stun', 'stuns']))) {
    servers.push({ urls: u });
  }
  if (process.env.TURN_URLS) {
    const urls = process.env.TURN_URLS.split(',')
      .map(s => s.trim())
      .filter(u => validIceUrl(u, ['turn', 'turns']));
    if (urls.length) {
      servers.push({
        urls,
        username: process.env.TURN_USER || '',
        credential: process.env.TURN_PASS || '',
      });
    }
  }
  return servers;
}

const iceServers = buildIceServers();
const turnConfigured = iceServers.some(server => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some(url => /^turns?:/i.test(String(url || '')));
});
if (!turnConfigured) {
  console.warn('[Config] TURN_URLS 未設定: SFUへ直接到達できないUTM/NAT拠点にはメディアを中継できません。');
} else {
  const turnServer = iceServers.find(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => /^turns?:/i.test(String(url || '')));
  });
  if (!turnServer?.username || !turnServer?.credential) {
    console.warn('[Config] TURN_URLS は設定されていますが TURN_USER / TURN_PASS が空です。認証必須のTURNでは接続できません。');
  }
}

module.exports = {
  listenIp: '0.0.0.0',
  listenPort: Number(process.env.PORT) || 3000,
  announcedIp: localIp,
  announcedIps,
  rtcPortRange: { min: rtcMinPort, max: rtcMaxPort },
  rtcPort,
  rtcExtraTcpPorts,
  buildRtcListenInfos,

  // クライアントへ配布する ICE サーバー
  iceServers,
  turnConfigured,

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
