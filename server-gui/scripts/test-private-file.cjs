#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  enforcePrivateFileModeSync,
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} = require('../private-file.cjs');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'server-gui-private-file-test-'));
try {
  const target = path.join(fixture, 'registered-clients.json');
  writePrivateFileAtomicSync(target, '{"generation":1}\n');
  assert.equal(readPrivateFileSync(target, 'utf8'), '{"generation":1}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  fs.chmodSync(target, 0o644);
  assert.equal(enforcePrivateFileModeSync(target), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  writePrivateFileAtomicSync(target, '{"generation":2}\n');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"generation":2}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(fixture), ['registered-clients.json']);

  const outside = path.join(fixture, 'outside');
  const linked = path.join(fixture, 'system-settings.json');
  fs.writeFileSync(outside, 'outside');
  fs.chmodSync(outside, 0o644);
  const outsideMode = fs.statSync(outside).mode & 0o777;
  let symlinkSupported = false;
  try {
    fs.symlinkSync(outside, linked);
    symlinkSupported = true;
    assert.throws(() => enforcePrivateFileModeSync(linked), /not a regular file/);
    assert.throws(() => readPrivateFileSync(linked, 'utf8'), /not a regular file/);
    assert.throws(() => writePrivateFileAtomicSync(linked, 'replacement'), /not a regular file/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    if (process.platform !== 'win32') assert.equal(fs.statSync(outside).mode & 0o777, outsideMode);
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
  }

  // Deterministically replace the pathname after lstat but before open. The
  // helper must reject it and must never chmod/read the symlink destination.
  const raceTarget = path.join(fixture, 'race-settings.json');
  const raceOriginal = `${raceTarget}.original`;
  fs.writeFileSync(raceTarget, 'original', { mode: 0o600 });
  const originalOpenSync = fs.openSync;
  let replaced = false;
  fs.openSync = function patchedOpenSync(filePath, ...args) {
    if (!replaced && filePath === raceTarget) {
      replaced = true;
      fs.renameSync(raceTarget, raceOriginal);
      fs.symlinkSync(outside, raceTarget);
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };
  try {
    assert.throws(() => readPrivateFileSync(raceTarget, 'utf8'));
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  if (process.platform !== 'win32') assert.equal(fs.statSync(outside).mode & 0o777, outsideMode);

  const oversized = Buffer.alloc(1024 * 1024 + 1);
  assert.throws(
    () => writePrivateFileAtomicSync(path.join(fixture, 'oversized-write.json'), oversized),
    /payload is too large/,
  );
  const oversizedRead = path.join(fixture, 'oversized-read.json');
  fs.writeFileSync(oversizedRead, oversized, { mode: 0o600 });
  assert.throws(() => readPrivateFileSync(oversizedRead), /file is too large/);

  // Replace the random temp pathname after its FD has been closed but before
  // rename. Inode revalidation must reject it and leave the outside target
  // untouched instead of installing/chmodding through the substituted link.
  const writeRaceTarget = path.join(fixture, 'write-race-settings.json');
  if (symlinkSupported) {
    const writeRaceBase = `.${path.basename(writeRaceTarget)}.`;
    const originalLstatSync = fs.lstatSync;
    let swappedTempPath = '';
    fs.lstatSync = function patchedLstatSync(filePath, ...args) {
      if (!swappedTempPath && typeof filePath === 'string' &&
          path.basename(filePath).startsWith(writeRaceBase) && filePath.endsWith('.tmp')) {
        swappedTempPath = filePath;
        fs.renameSync(filePath, `${filePath}.original`);
        fs.symlinkSync(outside, filePath);
      }
      return originalLstatSync.call(fs, filePath, ...args);
    };
    try {
      assert.throws(
        () => writePrivateFileAtomicSync(writeRaceTarget, 'private-payload'),
        /temporary file was replaced|changed while opening/,
      );
    } finally {
      fs.lstatSync = originalLstatSync;
    }
    assert.equal(fs.existsSync(writeRaceTarget), false);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  if (process.platform !== 'win32') assert.equal(fs.statSync(outside).mode & 0o777, outsideMode);

  console.log('[server-gui] private file atomic-write and mode-migration tests passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
