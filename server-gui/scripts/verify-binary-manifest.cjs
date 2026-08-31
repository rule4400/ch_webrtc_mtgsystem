#!/usr/bin/env node
'use strict';

/** Offline consistency check used by CI. No package install or network needed. */

const fs = require('fs');
const path = require('path');
const manifest = require('./binary-integrity-manifest.cjs');

const rootDir = path.resolve(__dirname, '..', '..');
const failures = [];
const SHA256_RE = /^[a-f0-9]{64}$/;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function fail(message) {
  failures.push(message);
}

function lockedVersion(lockFile, packageName) {
  const lock = readJson(lockFile);
  return lock.packages?.[`node_modules/${packageName}`]?.version || '';
}

function declaredVersion(packageFile, packageName) {
  const pkg = readJson(packageFile);
  return pkg.dependencies?.[packageName] || pkg.devDependencies?.[packageName] || '';
}

function checkPackage(label, packageFile, lockFile, packageName, expectedVersion) {
  const declared = declaredVersion(packageFile, packageName);
  const expectedRange = new RegExp(`^[~^]?${expectedVersion.replace(/\./g, '\\.')}$`);
  if (!expectedRange.test(declared)) {
    fail(`${label}: ${packageName} declaration ${JSON.stringify(declared)} does not match ${expectedVersion}`);
  }
  const locked = lockedVersion(lockFile, packageName);
  if (locked !== expectedVersion) {
    fail(`${label}: ${packageName} lock ${JSON.stringify(locked)} does not match ${expectedVersion}`);
  }
}

function checkIntegritySpec(label, spec) {
  if (!Number.isSafeInteger(spec?.size) || spec.size <= 0) fail(`${label}: invalid size`);
  if (!SHA256_RE.test(String(spec?.sha256 || ''))) fail(`${label}: invalid SHA-256`);
}

function checkTargets(label, targets, expectedNames, { archive = false } = {}) {
  const keys = Object.keys(targets || {}).sort();
  const expectedKeys = Object.keys(expectedNames).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    fail(`${label}: unexpected target set ${keys.join(', ')}`);
    return;
  }
  for (const [target, binaryName] of Object.entries(expectedNames)) {
    const entry = targets[target];
    if (entry.binaryName !== binaryName) fail(`${label}/${target}: unexpected binary name`);
    checkIntegritySpec(`${label}/${target}/binary`, entry.binary);
    if (archive) {
      const expectedArchive = `mediasoup-worker-${manifest.mediasoup.packageVersion}-${target}.tgz`;
      if (entry.archiveName !== expectedArchive) fail(`${label}/${target}: unexpected archive name`);
      checkIntegritySpec(`${label}/${target}/archive`, entry.archive);
    }
  }
}

if (manifest.schemaVersion !== 1) fail('unsupported manifest schemaVersion');
const allowedHosts = manifest.allowedDownloadHosts || [];
if (!Array.isArray(allowedHosts) || !allowedHosts.includes('github.com') ||
    !allowedHosts.includes('release-assets.githubusercontent.com') ||
    allowedHosts.some(host => typeof host !== 'string' || !host || host.includes('/'))) {
  fail('invalid download host allowlist');
}

checkPackage(
  'server-gui',
  'server-gui/package.json',
  'server-gui/package-lock.json',
  'mediasoup',
  manifest.mediasoup.packageVersion,
);
checkPackage(
  'server',
  'server/package.json',
  'server/package-lock.json',
  'mediasoup',
  manifest.mediasoup.packageVersion,
);
checkPackage(
  'server',
  'server/package.json',
  'server/package-lock.json',
  'ffmpeg-static',
  manifest.ffmpegStatic.packageVersion,
);
checkPackage(
  'server',
  'server/package.json',
  'server/package-lock.json',
  'ffprobe-static',
  manifest.ffprobeStatic.packageVersion,
);

if (!/^b[0-9A-Za-z._-]+$/.test(manifest.ffmpegStatic.releaseTag || '')) {
  fail('ffmpeg-static: invalid release tag');
}
const expectedNames = { 'darwin-arm64': 'mediasoup-worker', 'win32-x64': 'mediasoup-worker.exe' };
checkTargets('mediasoup', manifest.mediasoup.targets, expectedNames, { archive: true });
checkTargets('ffmpeg-static', manifest.ffmpegStatic.targets, {
  'darwin-arm64': 'ffmpeg',
  'win32-x64': 'ffmpeg.exe',
});
checkTargets('ffprobe-static', manifest.ffprobeStatic.targets, {
  'darwin-arm64': 'ffprobe',
  'win32-x64': 'ffprobe.exe',
});

if (failures.length) {
  for (const failure of failures) console.error(`[binary-manifest] ${failure}`);
  process.exit(1);
}
console.log('[binary-manifest] package versions, targets, sizes and SHA-256 pins are consistent');
