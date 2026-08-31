'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const SHA256_RE = /^[a-f0-9]{64}$/;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

function validateSpec(spec, label = 'binary') {
  if (!spec || !Number.isSafeInteger(spec.size) || spec.size <= 0 ||
      !SHA256_RE.test(String(spec.sha256 || ''))) {
    throw new Error(`${label}: invalid integrity manifest entry`);
  }
}

async function inspectFile(filePath, spec, label = filePath) {
  validateSpec(spec, label);
  let handle = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== spec.size) {
      throw new Error(`${label}: size mismatch (expected ${spec.size}, got ${stat.size})`);
    }
    const digest = crypto.createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    await new Promise((resolve, reject) => {
      stream.on('data', chunk => digest.update(chunk));
      stream.once('end', resolve);
      stream.once('error', reject);
    });
    const actual = digest.digest('hex');
    if (actual !== spec.sha256) {
      throw new Error(`${label}: SHA-256 mismatch (expected ${spec.sha256}, got ${actual})`);
    }
    return { size: stat.size, sha256: actual };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function isVerifiedFile(filePath, spec) {
  try {
    await inspectFile(filePath, spec);
    return true;
  } catch {
    return false;
  }
}

function tempSibling(filePath, tag = 'tmp') {
  const suffix = crypto.randomBytes(8).toString('hex');
  return `${filePath}.${process.pid}.${suffix}.${tag}`;
}

async function atomicReplace(tempPath, targetPath) {
  try {
    await fs.promises.rename(tempPath, targetPath);
    return;
  } catch (err) {
    // POSIX rename replaces an existing file atomically. Windows can reject
    // that form, so move the old (already rejected) file aside first.
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err;
  }

  const rejectedPath = tempSibling(targetPath, 'rejected');
  let movedExisting = false;
  try {
    try {
      await fs.promises.rename(targetPath, rejectedPath);
      movedExisting = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    await fs.promises.rename(tempPath, targetPath);
  } catch (err) {
    if (movedExisting) {
      await fs.promises.rename(rejectedPath, targetPath).catch(() => {});
    }
    throw err;
  }
  if (movedExisting) await fs.promises.unlink(rejectedPath).catch(() => {});
}

async function installVerifiedFile(sourcePath, targetPath, spec, { mode = 0o755 } = {}) {
  validateSpec(spec, targetPath);
  if (await isVerifiedFile(targetPath, spec)) {
    await fs.promises.chmod(targetPath, mode).catch(() => {});
    return { reused: true };
  }

  // Verify the source, copy to a sibling temporary file, then verify the copy.
  // The second verification also closes a source-path replacement race.
  await inspectFile(sourcePath, spec, sourcePath);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = tempSibling(targetPath, 'copy');
  try {
    await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    await inspectFile(tempPath, spec, `${targetPath} temporary copy`);
    await fs.promises.chmod(tempPath, mode).catch(() => {});
    await atomicReplace(tempPath, targetPath);
    await inspectFile(targetPath, spec, targetPath);
    return { reused: false };
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

function checkedHttpsUrl(rawUrl, allowedHosts, baseUrl = undefined) {
  let url;
  try {
    url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    throw new Error(`invalid download URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname)) {
    throw new Error(`download URL is not allowlisted: ${url.toString()}`);
  }
  return url;
}

function requestDownload(rawUrl, allowedHosts, redirectsRemaining = DEFAULT_MAX_REDIRECTS) {
  const url = checkedHttpsUrl(rawUrl, allowedHosts);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'checkhouse-release-integrity/1' },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirectsRemaining <= 0) {
          reject(new Error(`download redirect limit exceeded: ${url.toString()}`));
          return;
        }
        let next;
        try {
          next = checkedHttpsUrl(location, allowedHosts, url);
        } catch (err) {
          reject(err);
          return;
        }
        requestDownload(next, allowedHosts, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed ${response.statusCode}: ${url.toString()}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(DEFAULT_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`download timed out: ${url.toString()}`));
    });
    request.once('error', reject);
  });
}

async function downloadVerified(rawUrl, targetPath, spec, {
  allowedHosts,
  mode = 0o600,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
} = {}) {
  validateSpec(spec, targetPath);
  const hostSet = new Set(allowedHosts || []);
  if (!hostSet.size) throw new Error('download host allowlist is empty');
  checkedHttpsUrl(rawUrl, hostSet);

  if (await isVerifiedFile(targetPath, spec)) return { reused: true };
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = tempSibling(targetPath, 'download');
  try {
    const response = await requestDownload(rawUrl, hostSet, maxRedirects);
    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength !== spec.size) {
      response.destroy();
      throw new Error(`${targetPath}: Content-Length mismatch (expected ${spec.size}, got ${declaredLength})`);
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > spec.size) {
          callback(new Error(`${targetPath}: download exceeds pinned size ${spec.size}`));
          return;
        }
        callback(null, chunk);
      },
    });
    const output = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    await pipeline(response, limiter, output);
    if (received !== spec.size) {
      throw new Error(`${targetPath}: downloaded size mismatch (expected ${spec.size}, got ${received})`);
    }
    await inspectFile(tempPath, spec, `${targetPath} download`);
    await fs.promises.chmod(tempPath, mode).catch(() => {});
    await atomicReplace(tempPath, targetPath);
    await inspectFile(targetPath, spec, targetPath);
    return { reused: false };
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

module.exports = {
  downloadVerified,
  inspectFile,
  installVerifiedFile,
  isVerifiedFile,
  tempSibling,
};
