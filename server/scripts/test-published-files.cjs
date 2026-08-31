#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PUBLISHED_FILE_LIST_MAX,
  PUBLISHED_FILE_SCAN_MAX,
  createDirectoryGenerationGuard,
  createPublishedFileListCache,
  listPublishedFiles,
  validatePublishedDirectory,
} = require('../published-files');

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'server-published-files-test-'));
  const updates = path.join(fixture, 'updates');
  const outside = path.join(fixture, 'outside-secret');
  fs.mkdirSync(updates);
  fs.writeFileSync(outside, 'outside');
  try {
    for (let index = 0; index < 300; index += 1) {
      fs.writeFileSync(path.join(updates, `package-${String(index).padStart(3, '0')}.zip`), 'fixture');
    }
    // The returned list is bounded, but scanning must continue after the first
    // 256 eligible entries so a newer package later in directory order wins.
    const lateNewestName = 'zz-late-newest.zip';
    const lateNewestPath = path.join(updates, lateNewestName);
    fs.writeFileSync(lateNewestPath, 'newest');
    const newestTime = new Date('2035-01-01T00:00:00.000Z');
    fs.utimesSync(lateNewestPath, newestTime, newestTime);
    fs.writeFileSync(path.join(updates, '.hidden.zip'), 'hidden');
    fs.mkdirSync(path.join(updates, 'directory.zip'));
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(updates, 'outside.zip'));
      linked = true;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
    }

    const listed = await listPublishedFiles(updates, /\.zip$/i);
    assert.equal(listed.length, PUBLISHED_FILE_LIST_MAX);
    assert.ok(listed.every(file => !file.name.startsWith('.') && file.name !== 'outside.zip'));
    assert.ok(listed.some(file => file.name === lateNewestName));
    assert.equal(listed[0].name, lateNewestName);
    assert.equal(PUBLISHED_FILE_SCAN_MAX, 4096);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');

    const validated = await validatePublishedDirectory(updates, /\.zip$/i);
    assert.equal(validated.rootIdentity.path, path.resolve(updates));

    if (linked) {
      const rootLink = path.join(fixture, 'updates-link');
      fs.symlinkSync(updates, rootLink);
      await assert.rejects(validatePublishedDirectory(rootLink, /\.zip$/i), /not a regular directory/);
    }

    // A configured pathname must remain bound to the directory that was
    // validated. Replacing it with another ordinary directory is rejected too.
    const originalUpdates = `${updates}.configured`;
    fs.renameSync(updates, originalUpdates);
    fs.mkdirSync(updates);
    fs.writeFileSync(path.join(updates, 'replacement.zip'), 'must-not-publish');
    try {
      await assert.rejects(
        listPublishedFiles(updates, /\.zip$/i, { expectedRootIdentity: validated.rootIdentity }),
        /published directory changed/,
      );
    } finally {
      fs.rmSync(updates, { recursive: true, force: true });
      fs.renameSync(originalUpdates, updates);
    }

    // An injected slow lstat must yield to the event loop, and scanMax must
    // cap an otherwise unbounded directory source.
    let readCount = 0;
    let releaseLstat;
    const lstatGate = new Promise(resolve => { releaseLstat = resolve; });
    const fakeDirectory = {
      async read() {
        readCount += 1;
        // DT_UNKNOWN on SMB/NFS commonly appears as isFile() === false. The
        // following lstat still identifies these entries as ordinary files.
        return { name: `slow-${readCount}.zip`, isFile: () => false };
      },
      async close() {},
    };
    const directoryStat = {
      dev: 7,
      ino: 11,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
    const regularStat = { size: 7, mtimeMs: 1, isFile: () => true, isSymbolicLink: () => false };
    let firstLstat = true;
    const fakeFsApi = {
      opendir: async () => fakeDirectory,
      realpath: async value => value,
      lstat: async value => {
        if (value === '/virtual') return directoryStat;
        if (firstLstat) {
          firstLstat = false;
          await lstatGate;
        }
        return regularStat;
      },
    };
    const pending = listPublishedFiles('/virtual', /\.zip$/i, {
      scanMax: 12,
      fileMax: 5,
      fsApi: fakeFsApi,
    });
    let timerFired = false;
    await new Promise(resolve => setImmediate(() => { timerFired = true; resolve(); }));
    assert.equal(timerFired, true);
    releaseLstat();
    const bounded = await pending;
    assert.equal(readCount, 12);
    assert.equal(bounded.length, 5);

    // Ten concurrent requests share one expensive scan. Returned values are
    // copies, and a failure clears the flight so the next request can retry.
    const cacheIdentity = Object.freeze({
      path: '/cache-root',
      realpath: '/cache-root',
      dev: 17,
      ino: 23,
    });
    const validateRoot = async (_root, expected) => expected;
    let scanCount = 0;
    let releaseScan;
    const scanGate = new Promise(resolve => { releaseScan = resolve; });
    const cache = createPublishedFileListCache(/\.zip$/i, {
      validateRoot,
      scan: async () => {
        scanCount += 1;
        await scanGate;
        return [{ name: 'shared.zip', size: 6, mtimeMs: 2 }];
      },
    });
    const concurrent = Array.from({ length: 10 }, () => cache.list('/cache-root', {
      expectedRootIdentity: cacheIdentity,
    }));
    await new Promise(resolve => setImmediate(resolve));
    releaseScan();
    const results = await Promise.all(concurrent);
    assert.equal(scanCount, 1);
    results[0][0].name = 'tampered.zip';
    const cachedCopy = await cache.list('/cache-root', { expectedRootIdentity: cacheIdentity });
    assert.equal(cachedCopy[0].name, 'shared.zip');
    cache.invalidate();
    await cache.list('/cache-root', { expectedRootIdentity: cacheIdentity });
    assert.equal(scanCount, 2);

    let attempts = 0;
    const retryCache = createPublishedFileListCache(/\.zip$/i, {
      validateRoot,
      scan: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('injected scan failure');
        return [{ name: 'recovered.zip', size: 1, mtimeMs: 1 }];
      },
    });
    await assert.rejects(
      retryCache.list('/cache-root', { expectedRootIdentity: cacheIdentity }),
      /injected scan failure/,
    );
    const recovered = await retryCache.list('/cache-root', { expectedRootIdentity: cacheIdentity });
    assert.equal(attempts, 2);
    assert.equal(recovered[0].name, 'recovered.zip');

    const guard = createDirectoryGenerationGuard();
    const slowTicket = guard.begin();
    const newTicket = guard.begin();
    assert.equal(guard.isCurrent(newTicket), true);
    assert.equal(guard.isCurrent(slowTicket), false);

    console.log('[server] async bounded published-file listing tests passed');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error(`[server] ${err.stack || err.message}`);
  process.exit(1);
});
