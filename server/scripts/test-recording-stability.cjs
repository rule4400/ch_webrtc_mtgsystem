'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  createRecordingManager,
  readJsonAsync,
  writeJsonAtomicAsync,
} = require('../recording');

const MAX_INDEX_FILE_BYTES = 10 * 1024 * 1024;

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function fakeDetectionChild({ closeAfterMs = null, code = 0, onKill = () => {} } = {}) {
  const child = new EventEmitter();
  child.pid = Math.floor(Math.random() * 100_000) + 1;
  child.exitCode = null;
  child.killed = false;
  let closeTimer = null;
  if (closeAfterMs != null) {
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (child.killed) return;
      child.exitCode = code;
      child.emit('close', code, null);
    }, closeAfterMs);
  }
  child.kill = signal => {
    child.killed = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    onKill(signal);
    return true;
  };
  return child;
}

function writeDetectionSettings(filePath, ffmpegPath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    enabled: false,
    ffmpegPath,
  }));
}

function createDetectionManager(settingsFile, ffmpegDetectSpawn, ffmpegDetectTimeoutMs) {
  return createRecordingManager({
    getRouter: () => null,
    log: () => {},
    settingsFile,
    ffmpegDetectSpawn,
    ffmpegDetectTimeoutMs,
  });
}

async function testAsyncFfmpegDetection(root) {
  // Constructorが起動する-version確認でevent loopが止まらず、
  // 同時の検出要求が同じPromise/childに集約されることを固定する。
  const nonBlockingSettings = path.join(root, 'detect-nonblocking', 'settings.json');
  writeDetectionSettings(nonBlockingSettings, 'fake-ffmpeg');
  let spawnCalls = 0;
  const nonBlocking = createDetectionManager(nonBlockingSettings, () => {
    spawnCalls += 1;
    return fakeDetectionChild({ closeAfterMs: 30, code: 0 });
  }, 500);
  let reconcileCalls = 0;
  nonBlocking._reconcile = async () => { reconcileCalls += 1; };
  const detection = nonBlocking._ffmpegDetectPromise;
  assert.ok(detection, '起動時のffmpeg検出Promiseがない');
  assert.strictEqual(nonBlocking._detectFfmpeg(), detection, '重複検出はsingle-flightにする');
  let detectionSettled = false;
  detection.then(() => { detectionSettled = true; });
  let eventLoopTicked = false;
  await new Promise(resolve => setTimeout(() => {
    eventLoopTicked = true;
    resolve();
  }, 0));
  assert.equal(eventLoopTicked, true);
  assert.equal(detectionSettled, false, '-version待ちがevent loopをblockしている');
  await detection;
  await nextTurn();
  assert.equal(nonBlocking.ffmpegPath, 'fake-ffmpeg');
  assert.equal(spawnCalls, 2, 'ffmpegとffprobeの1候補ずつだけ確認する');
  assert.equal(reconcileCalls, 1, '検出完了後にreconcileを再実行する');
  nonBlocking.shutdown();

  // 検出中にffmpegPathが変わったら古いchildをkillし、同じ
  // single-flight runnerが最新世代だけをcommitする。
  const generationSettings = path.join(root, 'detect-generation', 'settings.json');
  writeDetectionSettings(generationSettings, 'old-ffmpeg');
  let oldKills = 0;
  const generationSpawns = [];
  const generationManager = createDetectionManager(generationSettings, candidate => {
    generationSpawns.push(candidate);
    if (candidate === 'old-ffmpeg') {
      return fakeDetectionChild({ closeAfterMs: 200, code: 0, onKill: () => { oldKills += 1; } });
    }
    return fakeDetectionChild({ closeAfterMs: 5, code: 0 });
  }, 500);
  const generationDetection = generationManager._ffmpegDetectPromise;
  assert.equal(generationSpawns[0], 'old-ffmpeg');
  generationManager.applySettings({ ffmpegPath: 'new-ffmpeg' });
  assert.strictEqual(generationManager._ffmpegDetectPromise, generationDetection);
  await generationDetection;
  assert.ok(oldKills >= 1, '古い世代の検出childをkillする');
  assert.equal(generationManager.ffmpegPath, 'new-ffmpeg', '古い検出結果をcommitしない');
  assert.ok(generationSpawns.includes('new-ffmpeg'));
  generationManager.shutdown();

  // timeoutしたchildをkillして次候補へ進む。
  const timeoutSettings = path.join(root, 'detect-timeout', 'settings.json');
  writeDetectionSettings(timeoutSettings, 'hanging-ffmpeg');
  let timeoutSpawnCalls = 0;
  let timeoutKills = 0;
  const timeoutManager = createDetectionManager(timeoutSettings, () => {
    timeoutSpawnCalls += 1;
    if (timeoutSpawnCalls === 1) {
      return fakeDetectionChild({ onKill: () => { timeoutKills += 1; } });
    }
    return fakeDetectionChild({ closeAfterMs: 5, code: 0 });
  }, 25);
  await timeoutManager._ffmpegDetectPromise;
  assert.ok(timeoutKills >= 1, 'timeoutした-version childをkillする');
  assert.equal(timeoutManager._ffmpegDetectChild, null);
  assert.ok(timeoutManager.ffmpegPath && timeoutManager.ffmpegPath !== 'hanging-ffmpeg');
  timeoutManager.shutdown();

  // shutdownは長いtimeoutを待たず、検出中childとtimer/listenerを回収する。
  const stopSettings = path.join(root, 'detect-stop', 'settings.json');
  writeDetectionSettings(stopSettings, 'stop-hanging-ffmpeg');
  let stopKills = 0;
  const stopManager = createDetectionManager(stopSettings, () => (
    fakeDetectionChild({ onKill: () => { stopKills += 1; } })
  ), 5000);
  const stoppedDetection = stopManager._ffmpegDetectPromise;
  stopManager.shutdown();
  await Promise.race([
    stoppedDetection,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('shutdown後もffmpeg検出Promiseが残った')),
      250,
    )),
  ]);
  assert.ok(stopKills >= 1);
  assert.equal(stopManager._ffmpegDetectChild, null);
  assert.equal(stopManager._ffmpegDetectCancelCandidate, null);
  assert.equal(stopManager._ffmpegDetectPromise, null);
}

async function testAsyncIndexIo(root) {
  const indexRoot = path.join(root, 'async-index');
  fs.mkdirSync(indexRoot, { recursive: true });
  const indexPath = path.join(indexRoot, 'day.json');
  await writeJsonAtomicAsync(indexPath, { segments: [{ id: 'safe' }] });
  assert.deepEqual(await readJsonAsync(indexPath, null), { segments: [{ id: 'safe' }] });
  assert.equal(fs.readdirSync(indexRoot).some(name => name.endsWith('.tmp')), false);

  const outsidePath = path.join(root, 'outside-index.json');
  fs.writeFileSync(outsidePath, JSON.stringify({ secret: 'outside' }));
  const symlinkPath = path.join(indexRoot, 'symlink.json');
  fs.symlinkSync(outsidePath, symlinkPath);
  assert.equal(await readJsonAsync(symlinkPath, 'rejected-symlink'), 'rejected-symlink');

  // open後にpathをroot外symlinkへ差し替えても、同じFDの元inodeだけを読む。
  const racePath = path.join(indexRoot, 'race.json');
  const movedRacePath = `${racePath}.opened`;
  fs.writeFileSync(racePath, JSON.stringify({ source: 'opened-inode' }));
  const originalOpen = fs.promises.open;
  let capturedHandle = null;
  fs.promises.open = async (filePath, ...args) => {
    const handle = await originalOpen(filePath, ...args);
    if (filePath === racePath && !capturedHandle) {
      capturedHandle = handle;
      fs.renameSync(racePath, movedRacePath);
      fs.symlinkSync(outsidePath, racePath);
    }
    return handle;
  };
  try {
    assert.deepEqual(await readJsonAsync(racePath, null), { source: 'opened-inode' });
  } finally {
    fs.promises.open = originalOpen;
    try { fs.unlinkSync(racePath); } catch { /* cleanup */ }
    if (fs.existsSync(movedRacePath)) fs.renameSync(movedRacePath, racePath);
  }
  assert.ok(capturedHandle);
  await assert.rejects(capturedHandle.stat(), undefined, 'JSON FileHandleがcloseされていない');

  // 同一inodeが読取中に書き換わった場合は、途中版を採用しない。
  const mutationPath = path.join(indexRoot, 'mutation.json');
  fs.writeFileSync(mutationPath, JSON.stringify({ stable: true }));
  let mutated = false;
  fs.promises.open = async (filePath, ...args) => {
    const handle = await originalOpen(filePath, ...args);
    if (filePath === mutationPath) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        if (!mutated && result.bytesRead > 0) {
          mutated = true;
          fs.appendFileSync(mutationPath, ' ');
        }
        return result;
      };
    }
    return handle;
  };
  try {
    assert.equal(await readJsonAsync(mutationPath, 'rejected-mutation'), 'rejected-mutation');
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.equal(mutated, true);

  const oversizedPath = path.join(indexRoot, 'oversized.json');
  fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_INDEX_FILE_BYTES + 1, 0x20));
  assert.equal(await readJsonAsync(oversizedPath, 'rejected-oversize'), 'rejected-oversize');
  await assert.rejects(
    writeJsonAtomicAsync(path.join(indexRoot, 'oversized-output.json'), {
      payload: 'x'.repeat(MAX_INDEX_FILE_BYTES),
    }),
    /exceeds/,
  );
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-recording-test-'));
  const settingsFile = path.join(root, 'recording-settings.json');
  const recordingsDir = path.join(root, 'recordings');
  const dbDir = path.join(root, 'recording-db');
  const stagingDir = path.join(root, 'staging');
  let reservedSlots = 0;
  let fakeRouter = null;
  let manager = null;

  try {
    await testAsyncFfmpegDetection(root);
    await testAsyncIndexIo(root);

    // schemaVersionのない旧設定。起動時に、録画の有効状態や保存先を保ったまま
    // 会議優先の安全設定へ一度だけ移行されることを確認する。
    fs.writeFileSync(settingsFile, JSON.stringify({
      enabled: false,
      recordingsDir,
      dbDir,
      stagingDir,
      compressionMode: 'standard',
      timestampOverlay: true,
      compressionConcurrency: 4,
    }));

    manager = createRecordingManager({
      getRouter: () => fakeRouter,
      log: () => {},
      settingsFile,
      reserveTransportSlots(count) {
        reservedSlots += count;
        return true;
      },
      releaseTransportSlots(count) {
        reservedSlots -= count;
      },
    });
    await manager._checkStorage();

    const migrated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(migrated.schemaVersion, 1);
    assert.equal(migrated.compressionMode, 'none');
    assert.equal(migrated.timestampOverlay, false);
    assert.equal(migrated.compressionConcurrency, 1);
    assert.equal(migrated.recordingsDir, recordingsDir);
    assert.equal(migrated.stagingDir, stagingDir);

    // createPlainTransport途中の失敗でも、開始前に予約した録画用slotを必ず返す。
    manager.settings.enabled = true;
    manager.storageOk = true;
    fakeRouter = {
      closed: false,
      async createPlainTransport() {
        throw new Error('synthetic transport failure');
      },
    };
    await assert.rejects(
      manager._startSession({
        producer: { id: 'video-producer', closed: false },
        socketId: 'socket-1',
        locationName: 'Tokyo',
        source: 'camera',
      }),
      /synthetic transport failure/,
    );
    assert.equal(reservedSlots, 0);
    assert.equal(manager.sessions.size, 0);

    // ライブ配信は検証済みの同一FileHandleを保持し、パスを
    // 外部symlink/別inodeに差し替えられても内容を混ぜない。
    const liveProducerId = 'live-producer';
    const liveTag = 'abc123';
    const liveRawRoot = manager.rawDir();
    const liveOutDir = path.join(liveRawRoot, 'live', 'camera');
    const liveName = `20260831-115959_${liveTag}.webm`;
    const livePath = path.join(liveOutDir, liveName);
    const liveBytes = Buffer.from('SAFE-LIVE-INODE');
    const outsideLivePath = path.join(root, 'outside-live.webm');
    fs.mkdirSync(liveOutDir, { recursive: true });
    fs.writeFileSync(livePath, liveBytes);
    fs.writeFileSync(outsideLivePath, 'MUST-NOT-MIX-INTO-LIVE');
    manager.sessions.set(liveProducerId, {
      producerId: liveProducerId,
      ffmpegExited: false,
      outDir: liveOutDir,
      sessionTag: liveTag,
      rawExt: 'webm',
      transports: [],
      reservedTransportSlots: 0,
    });
    const openedLive = await manager.openLiveFile(liveProducerId);
    assert.ok(openedLive?.handle);
    const originalLivePath = `${livePath}.opened`;
    fs.renameSync(livePath, originalLivePath);
    let liveReplacementLink = false;
    try {
      try {
        fs.symlinkSync(outsideLivePath, livePath);
        liveReplacementLink = true;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
        fs.writeFileSync(livePath, 'REPLACEMENT-INODE');
      }
      const liveRead = Buffer.alloc(liveBytes.length);
      const { bytesRead } = await openedLive.handle.read(liveRead, 0, liveRead.length, 0);
      assert.equal(bytesRead, liveBytes.length);
      assert.deepEqual(liveRead, liveBytes);
      const appendedLiveBytes = Buffer.from('-APPENDED');
      fs.appendFileSync(originalLivePath, appendedLiveBytes);
      const grownLiveStat = await openedLive.handle.stat();
      assert.equal(grownLiveStat.size, liveBytes.length + appendedLiveBytes.length);
      const appendedRead = Buffer.alloc(appendedLiveBytes.length);
      const appendedResult = await openedLive.handle.read(
        appendedRead,
        0,
        appendedRead.length,
        liveBytes.length,
      );
      assert.equal(appendedResult.bytesRead, appendedLiveBytes.length);
      assert.deepEqual(appendedRead, appendedLiveBytes);
    } finally {
      if (liveReplacementLink) fs.unlinkSync(livePath);
      else fs.rmSync(livePath, { force: true });
      fs.renameSync(originalLivePath, livePath);
      await openedLive.handle.close();
    }
    await assert.rejects(openedLive.handle.stat(), err =>
      err?.code === 'EBADF' || /closed/i.test(String(err?.message || '')),
    );

    // raw staging rootそのものを外部ディレクトリのsymlinkに
    // 置換した場合も、開く前に拒否する。
    const originalRawRoot = `${liveRawRoot}.configured`;
    const outsideRawRoot = path.join(root, 'outside-raw-root');
    const outsideRawOutDir = path.join(outsideRawRoot, 'live', 'camera');
    fs.mkdirSync(outsideRawOutDir, { recursive: true });
    fs.writeFileSync(path.join(outsideRawOutDir, liveName), 'OUTSIDE-RAW-ROOT');
    fs.renameSync(liveRawRoot, originalRawRoot);
    let rawRootLinked = false;
    try {
      try {
        fs.symlinkSync(outsideRawRoot, liveRawRoot, process.platform === 'win32' ? 'junction' : 'dir');
        rawRootLinked = true;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
      }
      if (rawRootLinked) {
        assert.equal(await manager.openLiveFile(liveProducerId), null);
      }
    } finally {
      if (rawRootLinked) fs.unlinkSync(liveRawRoot);
      fs.renameSync(originalRawRoot, liveRawRoot);
    }
    manager.sessions.delete(liveProducerId);

    // 同じrawを再投入しても、決定的ID/出力を再利用して再エンコードせず、
    // day indexも1件だけになることを確認する。
    const rawDir = path.join(manager.rawDir(), 'tokyo', 'camera');
    fs.mkdirSync(rawDir, { recursive: true });
    const rawPath = path.join(rawDir, '20260831-120000_abc123.webm');
    const rawBytes = Buffer.alloc(8192, 0x5a);
    fs.writeFileSync(rawPath, rawBytes);
    const meta = {
      locKey: 'tokyo',
      source: 'camera',
      startMs: new Date(2026, 7, 31, 12, 0, 0).getTime(),
      durationMs: 5000,
      size: rawBytes.length,
      sessionTag: 'abc123',
    };
    let encodeCalls = 0;
    manager._probeInfo = async () => ({ codec: 'vp8', hasAudio: false, durationMs: 5000 });
    manager._runFfmpeg = async args => {
      encodeCalls += 1;
      await fs.promises.copyFile(rawPath, args.at(-1));
      return true;
    };

    await manager._finalizeRaw(rawPath, { ...meta }, manager.settingsGeneration);
    assert.equal(encodeCalls, 1);
    assert.equal(fs.existsSync(rawPath), false);

    const date = '2026-08-31';
    const dayFile = path.join(dbDir, 'segments', 'tokyo__camera', `${date}.json`);
    let day = JSON.parse(fs.readFileSync(dayFile, 'utf8'));
    assert.equal(day.segments.length, 1);
    const firstEntry = day.segments[0];
    assert.match(firstEntry.id, /^tokyo~camera~2026-08-31~/);
    assert.equal(fs.existsSync(path.join(recordingsDir, firstEntry.file)), true);

    fs.writeFileSync(rawPath, rawBytes);
    await manager._finalizeRaw(rawPath, { ...meta }, manager.settingsGeneration);
    day = JSON.parse(fs.readFileSync(dayFile, 'utf8'));
    assert.equal(encodeCalls, 1, '再試行でffmpegを再実行してはいけない');
    assert.equal(day.segments.length, 1, '再試行でindexを重複させてはいけない');
    assert.equal(fs.existsSync(rawPath), false);

    // 24時間録画中でも保持期間掃除を延期し続けず、非同期に期限切れを削除する。
    // 同時に、indexがsymlinkを指していてもroot外の実ファイルは削除しない。
    const oldDate = '2020-01-01';
    const oldDir = path.join(recordingsDir, 'tokyo', 'camera', oldDate);
    fs.mkdirSync(oldDir, { recursive: true });
    const expiredMedia = path.join(oldDir, '000000_expired.webm');
    fs.writeFileSync(expiredMedia, Buffer.alloc(2048, 0x31));
    const outsideFile = path.join(root, 'outside-must-survive.webm');
    fs.writeFileSync(outsideFile, Buffer.alloc(2048, 0x32));
    const unsafeLink = path.join(oldDir, '000001_unsafe.webm');
    fs.symlinkSync(outsideFile, unsafeLink);
    const oldDayFile = path.join(dbDir, 'segments', 'tokyo__camera', `${oldDate}.json`);
    fs.writeFileSync(oldDayFile, JSON.stringify({
      locKey: 'tokyo',
      source: 'camera',
      date: oldDate,
      segments: [
        { id: 'expired-safe', startMs: Date.UTC(2020, 0, 1), file: path.relative(recordingsDir, expiredMedia), size: 2048 },
        { id: 'expired-unsafe', startMs: Date.UTC(2020, 0, 1) + 1000, file: path.relative(recordingsDir, unsafeLink), size: 2048 },
      ],
    }));
    manager.settings.retentionDays = 1;
    manager.sessions.set('synthetic-active', {
      producerId: 'synthetic-active',
      ffmpegExited: false,
      outDir: path.join(stagingDir, 'raw', 'active', 'camera'),
      transports: [],
      reservedTransportSlots: 0,
    });
    await manager.sweepRetention();
    assert.equal(fs.existsSync(expiredMedia), false, '録画中でも期限切れ通常ファイルを削除する');
    assert.equal(fs.existsSync(outsideFile), true, 'symlink先のroot外ファイルを削除してはいけない');
    const retainedUnsafe = JSON.parse(fs.readFileSync(oldDayFile, 'utf8'));
    assert.deepEqual(retainedUnsafe.segments.map(segment => segment.id), ['expired-unsafe']);
    manager.sessions.delete('synthetic-active');

    let childKilled = false;
    manager.compressionChildren.add({
      kill() { childKilled = true; },
    });
    manager.shutdown();
    assert.equal(childKilled, true);
    manager = null;

    console.log('recording stability tests passed');
  } finally {
    manager?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
