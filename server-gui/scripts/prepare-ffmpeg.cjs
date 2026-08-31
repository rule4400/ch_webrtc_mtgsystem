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

const integrityManifest = require('./binary-integrity-manifest.cjs');
const {
  downloadVerified,
  installVerifiedFile,
  isVerifiedFile,
} = require('./binary-integrity.cjs');

const rootDir = path.resolve(__dirname, '..');
const serverModules = path.resolve(rootDir, '..', 'server', 'node_modules');
const outRoot = path.join(rootDir, 'resources', 'ffmpeg');

const ffmpegStaticPkg = require(path.join(serverModules, 'ffmpeg-static', 'package.json'));
const ffprobeStaticPkg = require(path.join(serverModules, 'ffprobe-static', 'package.json'));
const releaseTag = ffmpegStaticPkg['ffmpeg-static']['binary-release-tag']; // 例: b6.1.1
const allowedHosts = integrityManifest.allowedDownloadHosts;

if (ffmpegStaticPkg.version !== integrityManifest.ffmpegStatic.packageVersion ||
    releaseTag !== integrityManifest.ffmpegStatic.releaseTag) {
  throw new Error(
    `ffmpeg-static ${ffmpegStaticPkg.version}/${releaseTag} does not match pinned manifest ` +
    `${integrityManifest.ffmpegStatic.packageVersion}/${integrityManifest.ffmpegStatic.releaseTag}`,
  );
}
if (ffprobeStaticPkg.version !== integrityManifest.ffprobeStatic.packageVersion) {
  throw new Error(
    `ffprobe-static ${ffprobeStaticPkg.version} does not match pinned manifest ` +
    integrityManifest.ffprobeStatic.packageVersion,
  );
}

const targets = [
  { platform: 'darwin', arch: 'arm64', key: 'darwin-arm64' },
  { platform: 'win32', arch: 'x64', key: 'win32-x64' },
].map(target => ({
  ...target,
  ffmpeg: integrityManifest.ffmpegStatic.targets[target.key],
  ffprobe: integrityManifest.ffprobeStatic.targets[target.key],
}));

async function prepareTarget(target) {
  const dir = path.join(outRoot, target.key);
  fs.mkdirSync(dir, { recursive: true });

  // ffprobe-static includes both target binaries in the locked npm package.
  const probeSrc = path.join(
    serverModules,
    'ffprobe-static',
    'bin',
    target.platform,
    target.arch,
    target.ffprobe.binaryName,
  );
  const probeDest = path.join(dir, target.ffprobe.binaryName);
  if (!fs.existsSync(probeSrc)) throw new Error(`ffprobe not found: ${probeSrc}`);
  const probeInstall = await installVerifiedFile(
    probeSrc,
    probeDest,
    target.ffprobe.binary,
    { mode: 0o755 },
  );
  console.log(
    `[prepare-ffmpeg] ffprobe ${target.key}: ` +
    (probeInstall.reused ? 'existing SHA-256 verified' : 'copied and SHA-256 verified'),
  );

  const dest = path.join(dir, target.ffmpeg.binaryName);
  if (await isVerifiedFile(dest, target.ffmpeg.binary)) {
    await fs.promises.chmod(dest, 0o755).catch(() => {});
    console.log(`[prepare-ffmpeg] ffmpeg ${target.key}: existing SHA-256 verified`);
    return;
  }
  if (fs.existsSync(dest)) {
    console.warn(`[prepare-ffmpeg] existing ffmpeg ${target.key} failed integrity verification; replacing it`);
  }
  if (target.platform === process.platform && target.arch === process.arch) {
    const src = require(path.join(serverModules, 'ffmpeg-static'));
    await installVerifiedFile(src, dest, target.ffmpeg.binary, { mode: 0o755 });
    console.log(`[prepare-ffmpeg] ffmpeg ${target.key}: copied and SHA-256 verified`);
    return;
  }
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${releaseTag}/ffmpeg-${target.key}`;
  console.log(`[prepare-ffmpeg] downloading pinned ${url}`);
  await downloadVerified(url, dest, target.ffmpeg.binary, {
    allowedHosts,
    mode: 0o755,
  });
  console.log(`[prepare-ffmpeg] ffmpeg ${target.key}: downloaded and SHA-256 verified`);
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
