'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRIVATE_FILE_MAX_BYTES = 1024 * 1024;

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
    try {
      warn(`[Security] fchmod 0600 is unavailable; relying on Windows ACL: ${filePath} (${err.message})`);
    } catch { /* logging only */ }
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

/** Migrate an existing settings file to owner-only mode without following links. */
function enforcePrivateFileModeSync(filePath, { warn = console.warn } = {}) {
  let descriptor = null;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(`private file is not a regular file: ${filePath}`);
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const openedStat = fs.fstatSync(descriptor);
    assertSameRegularFile(pathStat, openedStat, filePath);
  } catch (err) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  try {
    return applyPrivateModeSync(descriptor, filePath, warn);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Read and migrate through one no-follow descriptor to close the read race. */
function readPrivateFileSync(filePath, encoding = null, {
  warn = console.warn,
  maxBytes = PRIVATE_FILE_MAX_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PRIVATE_FILE_MAX_BYTES) {
    throw new Error('invalid private file byte limit');
  }
  let descriptor = null;
  const pathStat = fs.lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`private file is not a regular file: ${filePath}`);
  }
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const openedStat = fs.fstatSync(descriptor);
    assertSameRegularFile(pathStat, openedStat, filePath);
    if (!Number.isSafeInteger(openedStat.size) || openedStat.size < 0 ||
        openedStat.size > maxBytes) {
      throw new Error(`private file is too large: ${filePath}`);
    }
    applyPrivateModeSync(descriptor, filePath, warn);
    const readStat = fs.fstatSync(descriptor);
    const buffer = Buffer.alloc(maxBytes + 1);
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
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

/**
 * Write a private file through a new same-directory descriptor and atomically
 * replace the destination.  Permissions are applied to that descriptor before
 * rename, so a post-rename pathname swap cannot redirect chmod to another file.
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

  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeExistingTargetSync(filePath);

  let descriptor = null;
  let tempPath = '';
  let openedTempStat = null;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      tempPath = path.join(
        directory,
        `.${baseName}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
      );
      try {
        descriptor = fs.openSync(
          tempPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST' || attempt === 7) throw err;
      }
    }
    if (descriptor == null) throw new Error('failed to create private temporary file');
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

    // Reject a pre-existing or newly substituted link before replacement.
    // rename itself never follows the destination link, closing the remaining
    // check-to-replace race without chmodding through the pathname afterwards.
    const currentTempStat = fs.lstatSync(tempPath);
    if (currentTempStat.isSymbolicLink() || !currentTempStat.isFile()) {
      throw new Error(`private temporary file was replaced: ${tempPath}`);
    }
    assertSameRegularFile(openedTempStat, currentTempStat, tempPath);
    if (currentTempStat.size !== payloadBytes) {
      throw new Error(`private temporary file size changed: ${tempPath}`);
    }
    assertSafeExistingTargetSync(filePath);
    fs.renameSync(tempPath, filePath);
    tempPath = '';

    // Best-effort directory fsync makes the rename durable on POSIX.  Some NAS
    // and Windows filesystems do not permit opening/fsyncing directories.
    let directoryDescriptor = null;
    try {
      directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
    } catch { /* platform/filesystem does not support directory fsync */ }
    finally {
      if (directoryDescriptor != null) {
        try { fs.closeSync(directoryDescriptor); } catch { /* best effort */ }
      }
    }
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* already renamed or cleanup failure */ }
    }
  }
}

module.exports = {
  enforcePrivateFileModeSync,
  readPrivateFileSync,
  writePrivateFileAtomicSync,
};
