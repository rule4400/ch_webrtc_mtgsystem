#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '..');
const targets = [
  { file: 'client/src/pages/MainView.jsx', enable: 'enabled: !isSelf && !videoPaused' },
  { file: 'viewer/src/pages/ViewerView.jsx', enable: 'enabled: !videoPaused' },
];
const required = [
  'const LAST_FRAME_HOLD_MS = 20 * 1000;',
  'const LAST_FRAME_SAMPLE_MS = 2000;',
  'const LAST_FRAME_STALL_GRACE_MS = 3000;',
  'document.hidden',
  'const snapshotCapturedAtRef = useRef(0);',
  'const lastProgressAtRef = useRef(0);',
  'const progressDecodedFramesRef = useRef(Number.NaN);',
  'snapshotCapturedAtRef.current = Number.isFinite(capturedAt)',
  'Math.min(observedCandidate, capturedAt)',
  'if (!outageStartedAtRef.current)',
  'video.srcObject !== currentStream',
  'video.srcObject !== expectedStream',
  'captureBeforeOutage(previous, lastFrameAt)',
  "const recoveryEvents = ['loadeddata'];",
  "video.addEventListener('timeupdate', noteProgress)",
  "video.removeEventListener('timeupdate', noteProgress)",
  "track.readyState !== 'live'",
  "updateStatus('fallback')",
  "statusRef.current === 'holding'",
  "document.addEventListener('visibilitychange', checkDeadline)",
  'canvas.width = 1;',
  'canvas.height = 1;',
  'removeRetryListeners();',
  '映像復旧待機中（最終映像）',
];

for (const target of targets) {
  const contents = fs.readFileSync(path.join(root, target.file), 'utf8');
  for (const expected of [...required, target.enable]) {
    if (!contents.includes(expected)) {
      throw new Error(`${target.file}: missing last-frame policy ${JSON.stringify(expected)}`);
    }
  }
  if (/toDataURL|createObjectURL/.test(contents.slice(
    contents.indexOf('function useLastFrameHold'),
    contents.indexOf('const VideoCell'),
  ))) {
    throw new Error(`${target.file}: last-frame hook must not allocate Data/Object URLs`);
  }

  const hook = contents.slice(
    contents.indexOf('function useLastFrameHold'),
    contents.indexOf('const VideoCell'),
  );
  if (/recoveryEvents\s*=\s*\[[^\]]*(?:canplay|playing|unmute)/s.test(hook)) {
    throw new Error(`${target.file}: readiness/playback notifications must not release the held frame`);
  }
  if (!/if \(!hasBaseline\) \{[\s\S]*?return;[\s\S]*?if \(progressed\)/.test(hook)) {
    throw new Error(`${target.file}: first frame-counter sample must be a baseline, not recovery`);
  }
  const replacementCapture = hook.indexOf('captureBeforeOutage(previous, lastFrameAt)');
  const reconnectHint = hook.indexOf('if (outageHint)');
  if (replacementCapture < 0 || reconnectHint < 0 || replacementCapture > reconnectHint) {
    throw new Error(`${target.file}: old stream must be captured before reconnect hint handling`);
  }
}

// 検出が遅れても、保存済み最終フレームから20秒を越えない期限計算を固定する。
const remainingMs = (capturedAt, observedAt, now) => {
  const outageStartedAt = Math.min(now, observedAt, capturedAt);
  return Math.max(0, 20_000 - (now - outageStartedAt));
};
assert.equal(remainingMs(1_000, 5_000, 19_000), 2_000);
assert.equal(remainingMs(1_000, 5_000, 21_000), 0);
assert.equal(remainingMs(5_000, 1_000, 19_000), 2_000);
const keepFirstOutageStart = (existing, candidate) => existing || candidate;
assert.equal(keepFirstOutageStart(5_000, 9_000), 5_000, 'later events must not extend a hold');
assert.equal(keepFirstOutageStart(5_000, 1_000), 5_000, 'later events must not shorten a hold');

console.log('last-frame hold policy ok (20 seconds)');
