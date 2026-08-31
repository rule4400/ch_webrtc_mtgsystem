'use strict';

const fs = require('fs');
const path = require('path');

const PUBLISHED_FILE_LIST_MAX = 256;
const PUBLISHED_FILE_SCAN_MAX = 4096;
const PUBLISHED_FILE_CACHE_TTL_MS = 3000;

function createDirectoryGenerationGuard() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    isCurrent(ticket) {
      return ticket === generation;
    },
  };
}

function retainNewest(files, file, maxFiles) {
  if (files.length < maxFiles) {
    files.push(file);
    return;
  }
  let oldestIndex = 0;
  for (let index = 1; index < files.length; index += 1) {
    const candidate = files[index];
    const oldest = files[oldestIndex];
    if (candidate.mtimeMs < oldest.mtimeMs ||
        (candidate.mtimeMs === oldest.mtimeMs && candidate.name > oldest.name)) {
      oldestIndex = index;
    }
  }
  const oldest = files[oldestIndex];
  if (file.mtimeMs > oldest.mtimeMs ||
      (file.mtimeMs === oldest.mtimeMs && file.name < oldest.name)) {
    files[oldestIndex] = file;
  }
}

function rootError(rootDir, reason = 'changed') {
  const err = new Error(`published directory ${reason}: ${rootDir}`);
  err.code = 'PUBLISHED_ROOT_CHANGED';
  return err;
}

function sameRootIdentity(left, right) {
  return !!left && !!right &&
    left.path === right.path &&
    left.realpath === right.realpath &&
    left.dev === right.dev &&
    left.ino === right.ino;
}

/**
 * Inspect a configured publication root without following a final symlink.
 * The second lstat detects a replacement during realpath resolution.
 */
async function inspectPublishedDirectory(rawDir, { fsApi = fs.promises } = {}) {
  const value = String(rawDir || '');
  if (!value) throw rootError(value, 'is not a regular directory');
  const resolved = path.resolve(value);
  const before = await fsApi.lstat(resolved);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw rootError(resolved, 'is not a regular directory');
  }
  const realpath = await fsApi.realpath(resolved);
  const after = await fsApi.lstat(resolved);
  if (!after.isDirectory() || after.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino) {
    throw rootError(resolved);
  }
  return Object.freeze({
    path: resolved,
    realpath,
    dev: after.dev,
    ino: after.ino,
  });
}

async function assertPublishedDirectory(rawDir, expectedIdentity, options = {}) {
  const observed = await inspectPublishedDirectory(rawDir, options);
  if (expectedIdentity && !sameRootIdentity(observed, expectedIdentity)) {
    throw rootError(observed.path);
  }
  return observed;
}

/** Asynchronously scan a directory with bounded work and bounded output. */
async function listPublishedFiles(rootDir, extensionPattern, {
  scanMax = PUBLISHED_FILE_SCAN_MAX,
  fileMax = PUBLISHED_FILE_LIST_MAX,
  fsApi = fs.promises,
  expectedRootIdentity = null,
} = {}) {
  if (!rootDir) return [];
  const boundedScanMax = Math.max(1, Math.min(PUBLISHED_FILE_SCAN_MAX, Math.trunc(scanMax) || PUBLISHED_FILE_SCAN_MAX));
  const boundedFileMax = Math.max(1, Math.min(PUBLISHED_FILE_LIST_MAX, Math.trunc(fileMax) || PUBLISHED_FILE_LIST_MAX));
  const rootBefore = await assertPublishedDirectory(rootDir, expectedRootIdentity, { fsApi });
  let directory = null;
  const files = [];
  try {
    directory = await fsApi.opendir(rootBefore.path, { bufferSize: 64 });
    let scanned = 0;
    while (scanned < boundedScanMax) {
      const entry = await directory.read();
      if (!entry) break;
      scanned += 1;
      // SMB/NFS can report DT_UNKNOWN, in which case Dirent#isFile() is false
      // even for an ordinary file. lstat below is the authoritative no-follow
      // type check; use Dirent only for the cheap name filter.
      if (entry.name.startsWith('.') || !extensionPattern.test(entry.name)) continue;
      let stat;
      try { stat = await fsApi.lstat(path.join(rootBefore.path, entry.name)); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      retainNewest(files, { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs }, boundedFileMax);
    }
  } finally {
    try { await directory?.close(); } catch { /* already closed or failed to open */ }
  }
  // Do not publish metadata obtained while the configured root was being
  // swapped. This also rejects a root changed to another ordinary directory.
  const rootAfter = await assertPublishedDirectory(rootBefore.path, expectedRootIdentity || rootBefore, { fsApi });
  if (!sameRootIdentity(rootBefore, rootAfter)) throw rootError(rootBefore.path);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'ja'));
}

/** Validate a selected root without following a directory symlink, then scan. */
async function validatePublishedDirectory(rawDir, extensionPattern, options = {}) {
  const fsApi = options.fsApi || fs.promises;
  const rootIdentity = await inspectPublishedDirectory(rawDir, { fsApi });
  const files = await listPublishedFiles(rootIdentity.path, extensionPattern, {
    ...options,
    fsApi,
    expectedRootIdentity: rootIdentity,
  });
  return { directory: rootIdentity.path, rootIdentity, files };
}

function cloneFiles(files) {
  return files.map(file => ({ ...file }));
}

function immutableFiles(files) {
  return Object.freeze(files.map(file => Object.freeze({ ...file })));
}

function identityCacheKey(identity) {
  if (!identity) return '';
  return `${identity.path}\0${identity.realpath}\0${identity.dev}\0${identity.ino}`;
}

/**
 * Short-lived, single-flight listing cache. Root identity is still checked on
 * every request; only the expensive bounded directory walk is cached/shared.
 */
function createPublishedFileListCache(extensionPattern, {
  ttlMs = PUBLISHED_FILE_CACHE_TTL_MS,
  scan = listPublishedFiles,
  validateRoot = assertPublishedDirectory,
  now = Date.now,
} = {}) {
  const boundedTtlMs = Math.max(250, Math.min(30_000, Math.trunc(ttlMs) || PUBLISHED_FILE_CACHE_TTL_MS));
  let generation = 0;
  let cached = null;
  let inFlight = null;
  let rootValidationFlight = null;

  function invalidate() {
    generation += 1;
    cached = null;
    inFlight = null;
    rootValidationFlight = null;
  }

  function prime(rootDir, files, expectedRootIdentity) {
    generation += 1;
    inFlight = null;
    rootValidationFlight = null;
    const root = String(rootDir || '');
    cached = root ? {
      generation,
      root,
      identityKey: identityCacheKey(expectedRootIdentity),
      expiresAt: now() + boundedTtlMs,
      files: immutableFiles(files),
    } : null;
  }

  async function validateCurrentRoot(root, expectedRootIdentity, ticket) {
    const validationKey = `${ticket}\0${root}\0${identityCacheKey(expectedRootIdentity)}`;
    if (rootValidationFlight?.key === validationKey) return rootValidationFlight.promise;
    const flight = { key: validationKey, promise: null };
    flight.promise = Promise.resolve()
      .then(() => validateRoot(root, expectedRootIdentity))
      .finally(() => {
        if (rootValidationFlight === flight) rootValidationFlight = null;
      });
    rootValidationFlight = flight;
    return flight.promise;
  }

  async function list(rootDir, options = {}) {
    if (!rootDir) return [];
    const root = String(rootDir);
    const ticket = generation;
    const expectedRootIdentity = options.expectedRootIdentity || null;
    const identityKey = identityCacheKey(expectedRootIdentity);
    await validateCurrentRoot(root, expectedRootIdentity, ticket);

    if (cached && cached.generation === ticket && cached.root === root &&
        cached.identityKey === identityKey && cached.expiresAt > now()) {
      return cloneFiles(cached.files);
    }
    if (inFlight && inFlight.generation === ticket && inFlight.root === root &&
        inFlight.identityKey === identityKey) {
      return cloneFiles(await inFlight.promise);
    }

    const flight = {
      generation: ticket,
      root,
      identityKey,
      promise: null,
    };
    flight.promise = Promise.resolve()
      .then(() => scan(root, extensionPattern, { ...options, expectedRootIdentity }))
      .then(files => {
        const result = immutableFiles(files);
        if (generation === ticket && inFlight === flight) {
          cached = {
            generation: ticket,
            root,
            identityKey,
            expiresAt: now() + boundedTtlMs,
            files: result,
          };
        }
        return result;
      })
      .finally(() => {
        if (inFlight === flight) inFlight = null;
      });
    inFlight = flight;
    return cloneFiles(await flight.promise);
  }

  return { invalidate, list, prime };
}

module.exports = {
  PUBLISHED_FILE_LIST_MAX,
  PUBLISHED_FILE_SCAN_MAX,
  PUBLISHED_FILE_CACHE_TTL_MS,
  assertPublishedDirectory,
  createDirectoryGenerationGuard,
  createPublishedFileListCache,
  inspectPublishedDirectory,
  listPublishedFiles,
  sameRootIdentity,
  validatePublishedDirectory,
};
