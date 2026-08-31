#!/usr/bin/env node
/**
 * パッケージ用 ffmpeg/ffprobe 同梱バイナリの準備。
 * (mediasoup-worker の prepare-bundled-server.cjs と同じ方式)
 *
 *   resources/ffmpeg/<platform>-<arch>/ffmpeg(.exe)
 *   resources/ffmpeg/<platform>-<arch>/ffprobe(.exe)
 *
 * - ffprobe: ffprobe-static パッケージが全プラットフォームのバイナリを同梱しているためコピーするだけ
 * - ffmpeg : 現在のプラットフォームは server/node_modules/ffmpeg-static からコピー、
 *            他プラットフォームは ffmpeg-static の GitHub リリースからダウンロード
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const rootDir = path.resolve(__dirname, '..');
const serverModules = path.resolve(rootDir, '..', 'server', 'node_modules');
const outRoot = path.join(rootDir, 'resources', 'ffmpeg');

const ffmpegStaticPkg = require(path.join(serverModules, 'ffmpeg-static', 'package.json'));
const releaseTag = ffmpegStaticPkg['ffmpeg-static']['binary-release-tag']; // 例: b6.1.1

const targets = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        download(response.headers.location, dest).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed ${response.statusCode}: ${url}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function prepareTarget(target) {
  const dir = path.join(outRoot, `${target.platform}-${target.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  const exeSuffix = target.platform === 'win32' ? '.exe' : '';

  // ffprobe: ffprobe-static は全プラットフォーム同梱
  const probeSrc = path.join(serverModules, 'ffprobe-static', 'bin', target.platform, target.arch, `ffprobe${exeSuffix}`);
  const probeDest = path.join(dir, `ffprobe${exeSuffix}`);
  if (fs.existsSync(probeSrc)) {
    fs.copyFileSync(probeSrc, probeDest);
    fs.chmodSync(probeDest, 0o755);
    console.log(`[prepare-ffmpeg] ffprobe ${target.platform}-${target.arch}: copied from ffprobe-static`);
  } else {
    console.warn(`[prepare-ffmpeg] WARN: ffprobe not found for ${target.platform}-${target.arch}: ${probeSrc}`);
  }

  // ffmpeg
  const dest = path.join(dir, `ffmpeg${exeSuffix}`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000_000) {
    console.log(`[prepare-ffmpeg] ffmpeg ${target.platform}-${target.arch}: already prepared`);
    return;
  }
  if (target.platform === process.platform && target.arch === process.arch) {
    const src = require(path.join(serverModules, 'ffmpeg-static'));
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`[prepare-ffmpeg] ffmpeg ${target.platform}-${target.arch}: copied from local ffmpeg-static`);
    return;
  }
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${releaseTag}/ffmpeg-${target.platform}-${target.arch}`;
  console.log(`[prepare-ffmpeg] downloading ${url}`);
  await download(url, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`[prepare-ffmpeg] ffmpeg ${target.platform}-${target.arch}: downloaded (${Math.round(fs.statSync(dest).size / 1024 / 1024)}MB)`);
}

(async () => {
  for (const target of targets) {
    await prepareTarget(target);
  }
  console.log('[prepare-ffmpeg] done');
})().catch(err => {
  console.error('[prepare-ffmpeg] failed:', err.message);
  process.exit(1);
});
