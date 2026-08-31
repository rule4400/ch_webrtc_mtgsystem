#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const integrityManifest = require('./binary-integrity-manifest.cjs');
const {
  downloadVerified,
  inspectFile,
  installVerifiedFile,
  isVerifiedFile,
  tempSibling,
} = require('./binary-integrity.cjs');

const mediasoupPkg = require('../node_modules/mediasoup/package.json');
const version = mediasoupPkg.version;
const rootDir = path.resolve(__dirname, '..');
const workerRoot = path.join(rootDir, 'resources', 'mediasoup-workers');
const releaseBase = `https://github.com/versatica/mediasoup/releases/download/${version}`;
const allowedHosts = integrityManifest.allowedDownloadHosts;

if (version !== integrityManifest.mediasoup.packageVersion) {
  throw new Error(
    `mediasoup ${version} does not match pinned manifest ${integrityManifest.mediasoup.packageVersion}; ` +
    'review and update binary-integrity-manifest.cjs first',
  );
}

const targets = [
  { platform: 'darwin', arch: 'arm64', key: 'darwin-arm64' },
  { platform: 'win32', arch: 'x64', key: 'win32-x64' },
].map(target => ({
  ...target,
  ...integrityManifest.mediasoup.targets[target.key],
}));

async function copyCurrentWorker(target, destination) {
  const source = path.join(
    rootDir,
    'node_modules',
    'mediasoup',
    'worker',
    'out',
    'Release',
    target.binaryName,
  );
  if (!fs.existsSync(source)) return false;
  try {
    await inspectFile(source, target.binary, `installed mediasoup worker ${target.key}`);
  } catch (err) {
    // A locally compiled or stale worker is not trusted for a release. Falling
    // back to the pinned upstream archive is deterministic and still safe.
    console.warn(`[prepare] local ${target.key} worker rejected: ${err.message}`);
    return false;
  }
  await installVerifiedFile(source, destination, target.binary, { mode: 0o755 });
  console.log(`[prepare] copied and verified ${target.key} worker from locked package`);
  return true;
}

async function downloadWorker(target, destination) {
  const destinationDir = path.dirname(destination);
  fs.mkdirSync(destinationDir, { recursive: true });
  const archivePath = tempSibling(path.join(destinationDir, target.archiveName), 'archive');
  const extractDir = fs.mkdtempSync(path.join(destinationDir, '.worker-extract-'));
  const url = `${releaseBase}/${target.archiveName}`;
  try {
    console.log(`[prepare] downloading pinned ${url}`);
    await downloadVerified(url, archivePath, target.archive, {
      allowedHosts,
      mode: 0o600,
    });

    // The pinned archive is expected to contain one flat executable only.
    // Reject unexpected paths before extraction as an additional containment
    // check, then validate the extracted executable independently.
    const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
    if (entries.length !== 1 || entries[0] !== target.binaryName) {
      throw new Error(`${target.archiveName}: unexpected archive entries: ${entries.join(', ')}`);
    }
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir, target.binaryName], {
      stdio: 'inherit',
    });
    const extracted = path.join(extractDir, target.binaryName);
    await inspectFile(extracted, target.binary, `extracted ${target.key} worker`);
    await installVerifiedFile(extracted, destination, target.binary, { mode: 0o755 });
    console.log(`[prepare] verified worker ready ${destination}`);
  } finally {
    await fs.promises.unlink(archivePath).catch(() => {});
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

async function prepareTarget(target) {
  const destination = path.join(workerRoot, target.key, target.binaryName);
  if (await isVerifiedFile(destination, target.binary)) {
    await fs.promises.chmod(destination, 0o755).catch(() => {});
    console.log(`[prepare] ${target.key} worker already matches pinned SHA-256`);
    return;
  }
  if (fs.existsSync(destination)) {
    console.warn(`[prepare] existing ${target.key} worker failed integrity verification; replacing it`);
  }
  if (process.platform === target.platform && process.arch === target.arch &&
      await copyCurrentWorker(target, destination)) return;
  await downloadWorker(target, destination);
}

(async () => {
  for (const target of targets) await prepareTarget(target);
})().catch(error => {
  console.error(`[prepare] ${error.stack || error.message}`);
  process.exit(1);
});
