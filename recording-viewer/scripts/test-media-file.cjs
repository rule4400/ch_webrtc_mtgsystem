#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openVerifiedMediaFile,
  recordingFileResponse,
  serverMediaFetchOptions,
  validateServerMediaPath,
} = require('../media-file.cjs');
const {
  enforcePrivateFileModeSync,
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} = require('../private-file.cjs');

async function assertHandleClosed(handle, label) {
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(handle.stat(), undefined, `${label}: FileHandle remained open`);
}

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-viewer-media-test-'));
  const root = path.join(fixture, 'recordings');
  const mediaDir = path.join(root, 'tokyo', 'camera');
  const mediaPath = path.join(mediaDir, 'segment.webm');
  const outsidePath = path.join(fixture, 'outside-secret.webm');
  const bytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  const outsideBytes = Buffer.from('THIS-MUST-NEVER-BE-RETURNED');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(mediaPath, bytes);
  fs.writeFileSync(outsidePath, outsideBytes);
  const relative = path.relative(root, mediaPath);

  try {
    assert.equal(
      validateServerMediaPath('/recordings/media/tokyo~camera~2026-08-31~1~abc123', 'media'),
      '/recordings/media/tokyo~camera~2026-08-31~1~abc123',
    );
    assert.equal(validateServerMediaPath('/recordings/live/producer-id_1', 'live'),
      '/recordings/live/producer-id_1');
    assert.equal(validateServerMediaPath('/recordings/live/producer-id_1', 'media'), null);
    assert.equal(validateServerMediaPath('/recordings/media/%2e%2e%2fapi%2fstatus'), null);
    assert.equal(validateServerMediaPath('/recordings/media/id%2Foutside'), null);
    assert.equal(validateServerMediaPath(`/recordings/media/${'x'.repeat(257)}`), null);

    const legacySettings = path.join(fixture, 'viewer-settings.json');
    fs.writeFileSync(legacySettings, '{"accessToken":"legacy"}', { mode: 0o644 });
    assert.equal(enforcePrivateFileModeSync(legacySettings), true);
    assert.equal(readPrivateFileSync(legacySettings, 'utf8'), '{"accessToken":"legacy"}');
    if (process.platform !== 'win32') assert.equal(fs.statSync(legacySettings).mode & 0o777, 0o600);
    writePrivateFileAtomicSync(legacySettings, '{"accessToken":"replacement"}');
    assert.equal(readPrivateFileSync(legacySettings, 'utf8'), '{"accessToken":"replacement"}');
    if (process.platform !== 'win32') assert.equal(fs.statSync(legacySettings).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(fixture)
      .some(name => name.startsWith('.viewer-settings.json.') && name.endsWith('.tmp')), false);

    const privateVictim = path.join(fixture, 'private-victim.txt');
    const privateLink = path.join(fixture, 'private-link.json');
    fs.writeFileSync(privateVictim, 'victim-must-not-change');
    try {
      fs.symlinkSync(privateVictim, privateLink);
      assert.throws(() => writePrivateFileAtomicSync(privateLink, '{"changed":true}'),
        /not a regular file/);
      assert.equal(fs.readFileSync(privateVictim, 'utf8'), 'victim-must-not-change');
      assert.equal(fs.lstatSync(privateLink).isSymbolicLink(), true);
      assert.throws(() => readPrivateFileSync(privateLink, 'utf8'), /not a regular file/);
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
    }

    const oversizedPrivate = path.join(fixture, 'oversized-private.json');
    fs.writeFileSync(oversizedPrivate, Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => readPrivateFileSync(oversizedPrivate), /too large/);
    assert.throws(() => writePrivateFileAtomicSync(
      path.join(fixture, 'oversized-private-output.json'),
      Buffer.alloc(1024 * 1024 + 1),
    ), /too large/);

    const proxyHead = serverMediaFetchOptions(new Request('https://viewer.invalid/media', {
      method: 'HEAD',
      headers: {
        Range: 'bytes=10-19',
        Cookie: 'must-not-be-forwarded=1',
        Authorization: 'Bearer renderer-controlled-token',
        Origin: 'https://renderer.invalid',
      },
    }), 'recording-secret');
    assert.deepEqual(proxyHead, {
      method: 'HEAD',
      headers: {
        Authorization: 'Bearer recording-secret',
        Range: 'bytes=10-19',
      },
    });
    assert.equal(serverMediaFetchOptions(new Request('https://viewer.invalid/media', {
      method: 'POST',
      body: 'not allowed',
    }), 'recording-secret'), null);
    assert.deepEqual(serverMediaFetchOptions(
      new Request('https://viewer.invalid/media'),
      '',
    ), { method: 'GET', headers: {} });

    const fullOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(fullOpened, 'full GET fixture did not open');
    const full = await recordingFileResponse(fullOpened);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), String(bytes.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    await assertHandleClosed(fullOpened.handle, 'full GET');

    const headOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(headOpened, 'HEAD fixture did not open');
    const head = await recordingFileResponse(headOpened, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    await assertHandleClosed(headOpened.handle, 'HEAD');

    const rangeOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(rangeOpened, 'Range fixture did not open');
    const range = await recordingFileResponse(rangeOpened, { rangeHeader: 'bytes=10-19' });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 10-19/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(10, 20));
    await assertHandleClosed(rangeOpened.handle, 'Range GET');

    const suffixOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(suffixOpened, 'suffix Range fixture did not open');
    const suffix = await recordingFileResponse(suffixOpened, { rangeHeader: 'bytes=-5' });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'),
      `bytes ${bytes.length - 5}-${bytes.length - 1}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-5));
    await assertHandleClosed(suffixOpened.handle, 'suffix Range GET');

    const openEndedOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(openEndedOpened, 'open-ended Range fixture did not open');
    const openEnded = await recordingFileResponse(openEndedOpened, { rangeHeader: 'bytes=60-' });
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.headers.get('content-range'), `bytes 60-61/${bytes.length}`);
    assert.deepEqual(Buffer.from(await openEnded.arrayBuffer()), bytes.subarray(60));
    await assertHandleClosed(openEndedOpened.handle, 'open-ended Range GET');

    const rangeHeadOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(rangeHeadOpened, 'Range HEAD fixture did not open');
    const rangeHead = await recordingFileResponse(rangeHeadOpened, {
      method: 'HEAD',
      rangeHeader: 'bytes=10-19',
    });
    assert.equal(rangeHead.status, 206);
    assert.equal(rangeHead.headers.get('content-length'), '10');
    assert.equal(rangeHead.headers.get('content-range'), `bytes 10-19/${bytes.length}`);
    assert.equal((await rangeHead.arrayBuffer()).byteLength, 0);
    await assertHandleClosed(rangeHeadOpened.handle, 'Range HEAD');

    const invalidOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(invalidOpened, 'invalid Range fixture did not open');
    const invalid = await recordingFileResponse(invalidOpened, { rangeHeader: 'bytes=9999-' });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal((await invalid.arrayBuffer()).byteLength, 0);
    await assertHandleClosed(invalidOpened.handle, 'invalid Range');

    const emptyPath = path.join(mediaDir, 'empty.webm');
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const emptyOpened = await openVerifiedMediaFile(root, path.relative(root, emptyPath));
    assert.ok(emptyOpened, 'empty GET fixture did not open');
    const empty = await recordingFileResponse(emptyOpened);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-length'), '0');
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    await assertHandleClosed(emptyOpened.handle, 'empty GET');

    const emptyRangeOpened = await openVerifiedMediaFile(root, path.relative(root, emptyPath));
    assert.ok(emptyRangeOpened, 'empty Range fixture did not open');
    const emptyRange = await recordingFileResponse(emptyRangeOpened, { rangeHeader: 'bytes=0-' });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers.get('content-range'), 'bytes */0');
    await assertHandleClosed(emptyRangeOpened.handle, 'empty Range');

    const multipleRangeOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(multipleRangeOpened, 'multiple Range fixture did not open');
    const multipleRange = await recordingFileResponse(multipleRangeOpened, {
      rangeHeader: 'bytes=0-1,4-5',
    });
    assert.equal(multipleRange.status, 416);
    await assertHandleClosed(multipleRangeOpened.handle, 'multiple Range');

    const methodOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(methodOpened, 'unsupported method fixture did not open');
    const unsupportedMethod = await recordingFileResponse(methodOpened, { method: 'POST' });
    assert.equal(unsupportedMethod.status, 405);
    assert.equal(unsupportedMethod.headers.get('allow'), 'GET, HEAD');
    await assertHandleClosed(methodOpened.handle, 'unsupported method');

    assert.equal(await openVerifiedMediaFile(root, '../outside-secret.webm'), null);

    // Prove that response streaming does not reopen the validated path. After
    // open, replace that pathname with an outside symlink; the response must
    // still contain the original inode's bytes.
    const raceOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(raceOpened, 'TOCTOU fixture did not open');
    const movedPath = `${mediaPath}.opened`;
    let symlinkSupported = true;
    try {
      fs.renameSync(mediaPath, movedPath);
      fs.symlinkSync(outsidePath, mediaPath);
    } catch (err) {
      symlinkSupported = !['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code);
      if (fs.existsSync(movedPath) && !fs.existsSync(mediaPath)) fs.renameSync(movedPath, mediaPath);
      if (symlinkSupported) throw err;
    }
    if (symlinkSupported) {
      try {
        const race = await recordingFileResponse(raceOpened);
        assert.deepEqual(Buffer.from(await race.arrayBuffer()), bytes);
        await assertHandleClosed(raceOpened.handle, 'TOCTOU replacement');
      } finally {
        try { fs.unlinkSync(mediaPath); } catch { /* cleanup */ }
        if (fs.existsSync(movedPath)) fs.renameSync(movedPath, mediaPath);
      }
    } else {
      await raceOpened.handle.close().catch(() => {});
    }

    const linkPath = path.join(mediaDir, 'outside-link.webm');
    try {
      fs.symlinkSync(outsidePath, linkPath);
      assert.equal(await openVerifiedMediaFile(root, path.relative(root, linkPath)), null);
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
    }

    const outsideDirLink = path.join(root, 'outside-directory-link');
    try {
      fs.symlinkSync(fixture, outsideDirLink, 'dir');
      assert.equal(await openVerifiedMediaFile(root,
        path.join('outside-directory-link', path.basename(outsidePath))), null);
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err;
    }

    const abortOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(abortOpened, 'abort fixture did not open');
    const controller = new AbortController();
    const abortedResponse = await recordingFileResponse(abortOpened, { signal: controller.signal });
    controller.abort();
    await abortedResponse.body?.cancel().catch(() => {});
    await assertHandleClosed(abortOpened.handle, 'aborted GET');

    const preAbortOpened = await openVerifiedMediaFile(root, relative);
    assert.ok(preAbortOpened, 'pre-abort fixture did not open');
    const preAbortController = new AbortController();
    preAbortController.abort();
    const preAborted = await recordingFileResponse(preAbortOpened, {
      signal: preAbortController.signal,
    });
    assert.equal(preAborted.status, 499);
    await assertHandleClosed(preAbortOpened.handle, 'pre-aborted GET');

    const largeMediaPath = path.join(mediaDir, 'large.webm');
    fs.writeFileSync(largeMediaPath, Buffer.alloc(4 * 1024 * 1024, 0x5a));
    const cancelOpened = await openVerifiedMediaFile(root, path.relative(root, largeMediaPath));
    assert.ok(cancelOpened, 'body cancel fixture did not open');
    const cancelled = await recordingFileResponse(cancelOpened);
    await cancelled.body.cancel('test cancellation');
    await assertHandleClosed(cancelOpened.handle, 'cancelled response body');

    console.log('[recording-viewer] private settings, media path, GET/HEAD/Range/416, abort and handle-close tests passed');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error(`[recording-viewer] ${err.stack || err.message}`);
  process.exit(1);
});
