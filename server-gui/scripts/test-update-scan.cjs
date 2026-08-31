#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  UPDATE_FILE_MAX,
  UPDATE_SCAN_MAX,
  createScanGenerationGuard,
  scanUpdateFolder,
  watchFolderForFreshScan,
} = require('../update-folder.cjs');

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'server-gui-update-scan-test-'));
  const outside = path.join(fixture, 'outside-secret');
  const updates = path.join(fixture, 'updates');
  fs.mkdirSync(updates);
  fs.writeFileSync(outside, 'must-not-be-scanned');
  try {
    const oldClient = path.join(updates, 'CHECKHOUSE-Meeting-Client-1.0.0.zip');
    const newClient = path.join(updates, 'CHECKHOUSE-Meeting-Client-2.0.0.zip');
    fs.writeFileSync(oldClient, 'old');
    fs.writeFileSync(newClient, 'new');
    fs.utimesSync(oldClient, new Date(1_000), new Date(1_000));
    fs.utimesSync(newClient, new Date(2_000), new Date(2_000));
    fs.writeFileSync(path.join(updates, 'CHECKHOUSE-Viewer-3.0.0.dmg'), 'viewer');
    fs.writeFileSync(path.join(updates, 'ignored.txt'), 'ignored');
    fs.writeFileSync(path.join(updates, '._CHECKHOUSE-Meeting-Client-99.0.0.zip'), 'appledouble');
    fs.mkdirSync(path.join(updates, 'directory-4.0.0.zip'));

    let symlinkCreated = false;
    const linked = path.join(updates, 'CHECKHOUSE-Meeting-Client-99.0.0.zip');
    try {
      fs.symlinkSync(outside, linked);
      symlinkCreated = true;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
    }

    const base = await scanUpdateFolder(updates);
    assert.equal(base.packages.client.version, '2.0.0');
    assert.equal(base.packages.viewer.version, '3.0.0');
    assert.ok(base.files.every(file => !file.name.startsWith('.') && file.name !== path.basename(linked)));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must-not-be-scanned');

    // A directory with more eligible entries than the public result ceiling
    // is returned in bounded form. Smaller injected limits exercise the same
    // scan loop without requiring thousands of CI fixture files.
    for (let index = 0; index < 300; index += 1) {
      fs.writeFileSync(path.join(updates, `bundle-${String(index).padStart(3, '0')}.zip`), 'fixture');
    }
    const newestClientName = 'CHECKHOUSE-Meeting-Client-9.0.0.zip';
    const newestClient = path.join(updates, newestClientName);
    fs.writeFileSync(newestClient, 'newest');
    const newestAt = new Date(Date.now() + 60_000);
    fs.utimesSync(newestClient, newestAt, newestAt);

    // Force a deterministic directory order with the newest client after 256
    // eligible entries. Package selection must continue through scanMax even
    // after the returned file list reaches fileMax.
    const originalOpendir = fs.promises.opendir;
    const orderedEntries = fs.readdirSync(updates, { withFileTypes: true })
      .sort((left, right) => {
        if (left.name === newestClientName) return 1;
        if (right.name === newestClientName) return -1;
        return left.name.localeCompare(right.name);
      })
      .map(entry => entry.name === newestClientName
        // DT_UNKNOWN on SMB/NFS is observed as isFile() === false. lstat of
        // the actual path must still admit this ordinary package file.
        ? { name: entry.name, isFile: () => false }
        : entry);
    fs.promises.opendir = async () => ({
      read: async () => orderedEntries.shift() || null,
      close: async () => {},
    });
    let capped;
    try {
      capped = await scanUpdateFolder(updates);
    } finally {
      fs.promises.opendir = originalOpendir;
    }
    assert.equal(capped.files.length, UPDATE_FILE_MAX);
    assert.equal(capped.packages.client.version, '9.0.0');
    assert.ok(capped.files.some(file => file.name === newestClientName));
    const tightlyCapped = await scanUpdateFolder(updates, { scanMax: 16, fileMax: 7 });
    assert.ok(tightlyCapped.files.length <= 7);
    assert.equal(UPDATE_SCAN_MAX, 4096);
    assert.equal(UPDATE_FILE_MAX, 256);

    // Model A(slow) -> B(fast) -> A completion. Only B may install a watcher;
    // stale A must not roll the watcher back after the newer selection wins.
    const guard = createScanGenerationGuard();
    const ticketA = guard.begin();
    const ticketB = guard.begin();
    const watched = [];
    const resultB = { stale: !guard.isCurrent(ticketB) };
    assert.equal(watchFolderForFreshScan(resultB, '/updates/B', folder => watched.push(folder)), true);
    const resultA = { stale: !guard.isCurrent(ticketA) };
    assert.equal(watchFolderForFreshScan(resultA, '/updates/A', folder => watched.push(folder)), false);
    assert.deepEqual(watched, ['/updates/B']);
    assert.equal(watchFolderForFreshScan({ stale: false }, '', folder => watched.push(folder)), true);
    assert.deepEqual(watched, ['/updates/B', null]);

    if (symlinkCreated) fs.unlinkSync(linked);
    console.log('[server-gui] async bounded update-folder scan tests passed');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error(`[server-gui] ${err.stack || err.message}`);
  process.exit(1);
});
