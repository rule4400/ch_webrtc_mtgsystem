#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packages = ['client', 'screen-share', 'viewer', 'recording-viewer', 'server', 'server-gui'];
const versions = {};

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requireText(relativePath, expected) {
  if (!source(relativePath).includes(expected)) {
    throw new Error(`${relativePath}: expected ${JSON.stringify(expected)}`);
  }
}

for (const packageDir of packages) {
  const manifest = readJson(`${packageDir}/package.json`);
  const lock = readJson(`${packageDir}/package-lock.json`);
  const lockVersion = lock.packages?.['']?.version || lock.version;
  if (manifest.version !== lockVersion) {
    throw new Error(`${packageDir}: package.json=${manifest.version} package-lock.json=${lockVersion}`);
  }
  versions[packageDir] = manifest.version;
}

// Rendererはpackage.jsonを単一のversion sourceとしてbundleする。
for (const relativePath of [
  'client/src/pages/MainView.jsx',
  'client/src/services/webrtc.js',
  'viewer/src/pages/ViewerView.jsx',
  'viewer/src/services/viewer-webrtc.js',
  'screen-share/src/App.jsx',
  'screen-share/src/services/screen-share-webrtc.js',
]) {
  requireText(relativePath, 'packageInfo.version');
}

// サーバーとServer GUIの新規設定fallbackも配布版と一致させる。
for (const relativePath of ['server/index.js', 'server-gui/main.cjs', 'server-gui/index.html']) {
  requireText(relativePath, `client: '${versions.client}'`);
  requireText(relativePath, `viewer: '${versions.viewer}'`);
  requireText(relativePath, `'screen-share': '${versions['screen-share']}'`);
}

console.log(`version consistency ok (${packages.length} packages)`);
