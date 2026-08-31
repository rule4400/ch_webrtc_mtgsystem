'use strict';

const fs = require('fs');
const path = require('path');

const UPDATE_FILE_EXT = /\.(dmg|pkg|zip|exe|msi|appimage|deb|7z)$/i;
const UPDATE_SCAN_MAX = 4096;
const UPDATE_FILE_MAX = 256;

function createScanGenerationGuard() {
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

function watchFolderForFreshScan(scanResult, folder, watch) {
  if (scanResult?.stale) return false;
  watch(folder || null);
  return true;
}

function detectAppTypeFromFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (/screen[-_ ]?share/.test(lower)) return 'screen-share';
  if (lower.includes('viewer')) return 'viewer';
  if (lower.includes('client')) return 'client';
  if (/server[-_ ]?gui/.test(lower)) return 'server-gui';
  if (lower.includes('server')) return 'server';
  return null;
}

function detectVersionFromFilename(name) {
  // Stop at the three-part application version. Packaging suffixes such as
  // -arm64.dmg / -x64.zip are target metadata, not a semver prerelease.
  const match = String(name || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

/**
 * Scan an update directory without blocking Electron's main thread. Both the
 * number of directory entries inspected and the number returned are bounded.
 */
async function scanUpdateFolder(dir, {
  scanMax = UPDATE_SCAN_MAX,
  fileMax = UPDATE_FILE_MAX,
} = {}) {
  const folder = String(dir || '');
  const result = { folder, files: [], packages: {} };
  if (!folder) return result;

  const boundedScanMax = Math.max(1, Math.min(UPDATE_SCAN_MAX, Math.trunc(scanMax) || UPDATE_SCAN_MAX));
  const boundedFileMax = Math.max(1, Math.min(UPDATE_FILE_MAX, Math.trunc(fileMax) || UPDATE_FILE_MAX));
  let directory = null;
  try {
    directory = await fs.promises.opendir(folder, { bufferSize: 64 });
    let scanned = 0;
    while (scanned < boundedScanMax) {
      const entry = await directory.read();
      if (!entry) break;
      scanned += 1;
      // SMB/NFS can report DT_UNKNOWN, so Dirent#isFile() is not authoritative.
      // lstat below filters directories, links and devices without following.
      if (entry.name.startsWith('.') || !UPDATE_FILE_EXT.test(entry.name)) continue;
      let stat;
      try {
        stat = await fs.promises.lstat(path.join(folder, entry.name));
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;

      const appType = detectAppTypeFromFilename(entry.name);
      const version = detectVersionFromFilename(entry.name);
      const file = { name: entry.name, appType, version, size: stat.size, mtimeMs: stat.mtimeMs };
      if (result.files.length < boundedFileMax) {
        result.files.push(file);
      } else {
        // Keep the newest bounded set for display, while continuing the full
        // bounded scan so package selection also sees later entries.
        let oldestIndex = 0;
        for (let index = 1; index < result.files.length; index += 1) {
          const candidate = result.files[index];
          const oldest = result.files[oldestIndex];
          if (candidate.mtimeMs < oldest.mtimeMs ||
              (candidate.mtimeMs === oldest.mtimeMs && candidate.name > oldest.name)) {
            oldestIndex = index;
          }
        }
        const oldest = result.files[oldestIndex];
        if (file.mtimeMs > oldest.mtimeMs ||
            (file.mtimeMs === oldest.mtimeMs && file.name < oldest.name)) {
          result.files[oldestIndex] = file;
        }
      }

      if (!appType || !version) continue;
      const existing = result.packages[appType];
      if (!existing || stat.mtimeMs > existing.mtimeMs) {
        result.packages[appType] = {
          version,
          url: `/updates/${encodeURIComponent(entry.name)}`,
          notes: `自動検出: ${entry.name}`,
          fileName: entry.name,
          mtimeMs: stat.mtimeMs,
        };
      }
    }
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR'].includes(err?.code)) throw err;
  } finally {
    try { await directory?.close(); } catch { /* already closed or failed to open */ }
  }
  result.files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'ja'));
  return result;
}

module.exports = {
  UPDATE_FILE_MAX,
  UPDATE_SCAN_MAX,
  createScanGenerationGuard,
  detectAppTypeFromFilename,
  detectVersionFromFilename,
  scanUpdateFolder,
  watchFolderForFreshScan,
};
