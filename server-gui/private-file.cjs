'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRIVATE_FILE_MAX_BYTES = 1024 * 1024;

function privateFileWarning(warn, message) {
  try { (warn || console.warn)(message); } catch { /* logging must not break startup */ }
}

function hasStableFileIdentity(stat) {
  return Number(stat?.dev) !== 0 && Number(stat?.ino) !== 0;
}

function assertSameRegularFile(pathStat, openedStat, filePath) {
  if (!openedStat.isFile() ||
      (hasStableFileIdentity(pathStat) && hasStableFileIdentity(openedStat) &&
        (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino))) {
    throw new Error(`private file changed while opening: ${filePath}`);
  }
}

function applyPrivateModeSync(descriptor, filePath, warn) {
  try {
    fs.fchmodSync(descriptor, 0o600);
    return true;
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    privateFileWarning(
      warn,
      `[Security] fchmod 0600 is unavailable; relying on Windows ACL: ${filePath} (${err.message})`,
    );
    return false;
  }
}

function assertSafeExistingTargetSync(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`private file is not a regular file: ${filePath}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function openVerifiedPrivateFileSync(filePath) {
  const pathStat = fs.lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`private file is not a regular file: ${filePath}`);
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    assertSameRegularFile(pathStat, fs.fstatSync(descriptor), filePath);
    return descriptor;
  } catch (err) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    throw err;
  }
}

/** Migrate an existing private file through the verified descriptor. */
function enforcePrivateFileModeSync(filePath, { warn = console.warn } = {}) {
  let descriptor = null;
  try {
    descriptor = openVerifiedPrivateFileSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  try {
    return applyPrivateModeSync(descriptor, filePath, warn);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Read, size-bound and permission-migrate through one no-follow descriptor. */
function readPrivateFileSync(filePath, encoding = null, {
  warn = console.warn,
  maxBytes = PRIVATE_FILE_MAX_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PRIVATE_FILE_MAX_BYTES) {
    throw new Error('invalid private file byte limit');
  }
  const descriptor = openVerifiedPrivateFileSync(filePath);
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (!Number.isSafeInteger(openedStat.size) || openedStat.size < 0 || openedStat.size > maxBytes) {
      throw new Error(`private file is too large: ${filePath}`);
    }
    applyPrivateModeSync(descriptor, filePath, warn);
    const readStat = fs.fstatSync(descriptor);
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, openedStat.size + 1));
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`private file is too large: ${filePath}`);
    const finalStat = fs.fstatSync(descriptor);
    assertSameRegularFile(readStat, finalStat, filePath);
    if (readStat.size !== finalStat.size || readStat.mtimeMs !== finalStat.mtimeMs ||
        readStat.ctimeMs !== finalStat.ctimeMs || total !== finalStat.size) {
      throw new Error(`private file changed while reading: ${filePath}`);
    }
    const result = buffer.subarray(0, total);
    return encoding == null ? result : result.toString(encoding);
  } finally {
    fs.closeSync(descriptor);
  }
}

function renamePrivateTempSync(tempPath, targetPath, backupPath) {
  try {
    fs.renameSync(tempPath, targetPath);
    return false;
  } catch (err) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err;
  }

  let movedExisting = false;
  try {
    try {
      fs.renameSync(targetPath, backupPath);
      movedExisting = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    fs.renameSync(tempPath, targetPath);
    return movedExisting;
  } catch (err) {
    if (movedExisting) {
      try { fs.renameSync(backupPath, targetPath); } catch { /* keep recoverable backup */ }
    }
    throw err;
  }
}

/**
 * Write through a new same-directory no-follow descriptor and atomically
 * replace the destination. No chmod/read operation reopens the pathname.
 */
function writePrivateFileAtomicSync(filePath, data, {
  encoding = 'utf8',
  warn = console.warn,
  maxBytes = PRIVATE_FILE_MAX_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PRIVATE_FILE_MAX_BYTES) {
    throw new Error('invalid private file byte limit');
  }
  const payloadBytes = Buffer.isBuffer(data) || ArrayBuffer.isView(data)
    ? data.byteLength
    : Buffer.byteLength(String(data), encoding);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > maxBytes) {
    throw new Error(`private file payload is too large: ${filePath}`);
  }

  const target = path.resolve(String(filePath || ''));
  const directory = path.dirname(target);
  const baseName = path.basename(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeExistingTargetSync(target);

  const suffix = `${process.pid}.${crypto.randomBytes(12).toString('hex')}`;
  let tempPath = path.join(directory, `.${baseName}.${suffix}.tmp`);
  const backupPath = path.join(directory, `.${baseName}.${suffix}.previous`);
  let descriptor = null;
  let openedTempStat = null;
  let backupCreated = false;
  try {
    descriptor = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    openedTempStat = fs.fstatSync(descriptor);
    if (!openedTempStat.isFile()) throw new Error(`private temporary file is invalid: ${tempPath}`);
    applyPrivateModeSync(descriptor, tempPath, warn);
    fs.writeFileSync(descriptor, data, { encoding });
    const writtenStat = fs.fstatSync(descriptor);
    if (!writtenStat.isFile() || writtenStat.size !== payloadBytes) {
      throw new Error(`private temporary file write was incomplete: ${tempPath}`);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    // Recheck the closed pathname against the inode we actually wrote before
    // rename; this detects a replaced temp path without following a link.
    const currentTempStat = fs.lstatSync(tempPath);
    if (!currentTempStat.isFile() || currentTempStat.isSymbolicLink()) {
      throw new Error(`private temporary file was replaced: ${tempPath}`);
    }
    assertSameRegularFile(openedTempStat, currentTempStat, tempPath);
    if (currentTempStat.size !== payloadBytes) {
      throw new Error(`private temporary file size changed: ${tempPath}`);
    }
    assertSafeExistingTargetSync(target);
    backupCreated = renamePrivateTempSync(tempPath, target, backupPath);
    tempPath = '';

    let directoryDescriptor = null;
    try {
      directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
    } catch { /* directory fsync is unavailable on some NAS/Windows filesystems */ }
    finally {
      if (directoryDescriptor != null) {
        try { fs.closeSync(directoryDescriptor); } catch { /* best effort */ }
      }
    }
    if (backupCreated) {
      fs.unlinkSync(backupPath);
      backupCreated = false;
    }
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* renamed or cleanup failure */ }
    }
    if (backupCreated && fs.existsSync(target)) {
      try { fs.unlinkSync(backupPath); } catch { /* private recoverable backup remains */ }
    }
  }
}

module.exports = {
  enforcePrivateFileModeSync,
  readPrivateFileSync,
  writePrivateFileAtomicSync,
};
