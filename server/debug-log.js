const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const MAX_FIELD_LENGTH = 16_000;
const MAX_ARRAY_LENGTH = 64;

function logDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function defaultLogDir() {
  return process.env.DEBUG_LOG_DIR || path.join(process.cwd(), 'logs');
}

function logFilePath() {
  return path.join(defaultLogDir(), `sfu-debug-${logDate()}.jsonl`);
}

function sanitize(value, depth = 0) {
  if (depth > 8) return '[max-depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/fingerprint|credential|password|token|secret|authorization/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = sanitize(item, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}

function appendDebugLog(event, details = {}, severity = 'info') {
  if (String(process.env.DEBUG_LOG_DISABLED || '').toLowerCase() === 'true') return;
  const entry = {
    ts: new Date().toISOString(),
    sessionId: SESSION_ID,
    severity,
    event,
    pid: process.pid,
    hostname: os.hostname(),
    uptimeSec: Number(process.uptime().toFixed(3)),
    details: sanitize(details),
  };

  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFile(file, `${JSON.stringify(entry)}\n`, err => {
      if (err) console.error(`[DebugLog] append failed: ${err.message}`);
    });
  } catch (err) {
    console.error(`[DebugLog] write failed: ${err.message}`);
  }
}

function debugLogInfo() {
  const file = logFilePath();
  return {
    sessionId: SESSION_ID,
    dir: path.dirname(file),
    file,
    enabled: String(process.env.DEBUG_LOG_DISABLED || '').toLowerCase() !== 'true',
  };
}

module.exports = {
  appendDebugLog,
  debugLogInfo,
  sanitizeForDebugLog: sanitize,
};
