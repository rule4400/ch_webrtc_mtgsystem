#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const mediasoupPkg = require('../node_modules/mediasoup/package.json');
const version = mediasoupPkg.version;
const rootDir = path.resolve(__dirname, '..');
const workerRoot = path.join(rootDir, 'resources', 'mediasoup-workers');
const releaseBase = `https://github.com/versatica/mediasoup/releases/download/${version}`;

const targets = [
  { platform: 'darwin', arch: 'arm64', bin: 'mediasoup-worker' },
  { platform: 'win32', arch: 'x64', bin: 'mediasoup-worker.exe' },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyCurrentWorker(target) {
  const src = path.join(rootDir, 'node_modules', 'mediasoup', 'worker', 'out', 'Release', target.bin);
  const destDir = path.join(workerRoot, `${target.platform}-${target.arch}`);
  const dest = path.join(destDir, target.bin);

  if (!fs.existsSync(src)) return false;
  ensureDir(destDir);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o775);
  console.log(`[prepare] copied ${target.platform}-${target.arch} worker from local install`);
  return true;
}

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
      out.on('finish', () => {
        out.close(resolve);
      });
      out.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function downloadWorker(target) {
  const destDir = path.join(workerRoot, `${target.platform}-${target.arch}`);
  const dest = path.join(destDir, target.bin);
  if (fs.existsSync(dest)) {
    console.log(`[prepare] ${target.platform}-${target.arch} worker already exists`);
    return;
  }

  ensureDir(destDir);
  const tarName = `mediasoup-worker-${version}-${target.platform}-${target.arch}.tgz`;
  const tarPath = path.join(destDir, tarName);
  const url = `${releaseBase}/${tarName}`;

  console.log(`[prepare] downloading ${url}`);
  await download(url, tarPath);
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'inherit' });
  fs.unlinkSync(tarPath);
  fs.chmodSync(dest, 0o775);
  console.log(`[prepare] ready ${dest}`);
}

(async () => {
  for (const target of targets) {
    if (process.platform === target.platform && process.arch === target.arch && copyCurrentWorker(target)) {
      continue;
    }
    await downloadWorker(target);
  }
})().catch(error => {
  console.error(`[prepare] ${error.stack || error.message}`);
  process.exit(1);
});
