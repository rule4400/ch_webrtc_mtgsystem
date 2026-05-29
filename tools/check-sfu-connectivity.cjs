#!/usr/bin/env node

const net = require('net');
const os = require('os');

const rawUrl = process.argv[2];
if (!rawUrl) {
  console.error('Usage: node tools/check-sfu-connectivity.cjs http://<SFU_VPN_IP>:3000');
  process.exit(2);
}

const baseUrl = new URL(rawUrl.startsWith('http') ? rawUrl : `http://${rawUrl}`);
const timeoutMs = Number(process.env.CHECK_TIMEOUT_MS) || 5000;

function localIpv4List() {
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push(`${name}: ${addr.address}`);
      }
    }
  }
  return result;
}

function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const startedAt = Date.now();
    const done = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, ms: Date.now() - startedAt, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, 'connected'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', err => done(false, err.message));
  });
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - startedAt, text };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - startedAt, text: err.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const host = baseUrl.hostname;
  const port = Number(baseUrl.port || 80);
  console.log(`SFU target: ${baseUrl.origin}`);
  console.log(`Local IPv4: ${localIpv4List().join(', ') || 'none'}`);

  const tcp = await tcpCheck(host, port);
  console.log(`TCP ${host}:${port}: ${tcp.ok ? 'OK' : 'NG'} (${tcp.ms}ms) ${tcp.detail}`);

  const health = await fetchText(new URL('/health', baseUrl));
  console.log(`HTTP /health: ${health.ok ? 'OK' : 'NG'} (${health.ms}ms) status=${health.status}`);

  let healthJson = null;
  if (health.ok) {
    try {
      healthJson = JSON.parse(health.text);
      console.log(`announcedIp=${healthJson.announcedIp || 'unknown'} rtcPortRange=${JSON.stringify(healthJson.rtcPortRange || null)} peers=${healthJson.peerCount}`);
      if (healthJson.announcedIp && healthJson.announcedIp !== host) {
        console.log(`WARN: 接続先ホスト(${host})とサーバー announcedIp(${healthJson.announcedIp}) が違います。VPN内で全拠点から announcedIp に到達できるか確認してください。`);
      }
    } catch {
      console.log('WARN: /health response is not JSON');
    }
  } else {
    console.log(health.text);
  }

  const socketIo = await fetchText(new URL(`/socket.io/?EIO=4&transport=polling&t=${Date.now()}`, baseUrl));
  const socketOk = socketIo.ok && socketIo.text.startsWith('0');
  console.log(`Socket.IO handshake: ${socketOk ? 'OK' : 'NG'} (${socketIo.ms}ms) status=${socketIo.status}`);

  if (healthJson?.rtcPortRange) {
    console.log(`RTP/RTCP media ports: ${healthJson.rtcPortRange.min}-${healthJson.rtcPortRange.max} UDP/TCP must be allowed through VPN/firewall.`);
  }

  if (!tcp.ok || !health.ok || !socketOk) process.exit(1);
})();
