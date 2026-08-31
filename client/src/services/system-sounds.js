import notificationUrl from '../../../sounds/通知音.mp3';
import speakerMuteUrl from '../../../sounds/スピーカーミュート.mp3';
import speakerUnmuteUrl from '../../../sounds/スピーカーミュート解除.mp3';
import micMuteUrl from '../../../sounds/マイクミュート.mp3';
import micUnmuteUrl from '../../../sounds/マイクミュート解除.mp3';
import audioDisconnectUrl from '../../../sounds/音声切断.mp3';
import channelJoinUrl from '../../../sounds/チャンネル参加.mp3';
import channelLeaveUrl from '../../../sounds/チャンネル退出.mp3';
import channelMoveUrl from '../../../sounds/チャンネル移動.mp3';
import outgoingCallUrl from '../../../sounds/呼び出し音.mp3';
import incomingCallUrl from '../../../sounds/着信音.mp3';
import audioDeviceChangeUrl from '../../../sounds/オーディオデバイスの変更.mp3';
import screenShareStopUrl from '../../../sounds/画面共有の終了.mp3';
import screenShareStartUrl from '../../../sounds/画面共有の開始.mp3';
import screenViewStartUrl from '../../../sounds/画面共有の閲覧開始.mp3';
import screenViewStopUrl from '../../../sounds/画面共有の閲覧終了.mp3';

export const SYSTEM_SOUND_URLS = {
  notification: notificationUrl,
  speakerMute: speakerMuteUrl,
  speakerUnmute: speakerUnmuteUrl,
  micMute: micMuteUrl,
  micUnmute: micUnmuteUrl,
  audioDisconnect: audioDisconnectUrl,
  channelJoin: channelJoinUrl,
  channelLeave: channelLeaveUrl,
  channelMove: channelMoveUrl,
  outgoingCall: outgoingCallUrl,
  incomingCall: incomingCallUrl,
  audioDeviceChange: audioDeviceChangeUrl,
  screenShareStop: screenShareStopUrl,
  screenShareStart: screenShareStartUrl,
  screenViewStart: screenViewStartUrl,
  screenViewStop: screenViewStopUrl,
};

const loopPlayers = new Map();

function clampVolume(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value)) return 0.86;
  return Math.min(1, Math.max(0, value));
}

export function systemSoundUrl(key) {
  return SYSTEM_SOUND_URLS[key] || '';
}

export function playSystemSound(key, options = {}) {
  const url = systemSoundUrl(key);
  if (!url || typeof Audio === 'undefined') return null;

  try {
    const audio = new Audio(url);
    audio.volume = clampVolume(options.volume);
    const promise = audio.play();
    promise?.catch?.(err => console.warn(`[systemSound:${key}]`, err.message));
    return audio;
  } catch (err) {
    console.warn(`[systemSound:${key}]`, err.message);
    return null;
  }
}

export function startLoopingSystemSound(key, options = {}) {
  const url = systemSoundUrl(key);
  if (!url || typeof Audio === 'undefined') return null;

  try {
    const existing = loopPlayers.get(key);
    const audio = existing || new Audio(url);
    audio.loop = true;
    audio.volume = clampVolume(options.volume);
    if (audio.paused || audio.ended) {
      try { audio.currentTime = 0; } catch { /* ignore unsupported seek */ }
      const promise = audio.play();
      promise?.catch?.(err => console.warn(`[systemSound:${key}]`, err.message));
    }
    loopPlayers.set(key, audio);
    return audio;
  } catch (err) {
    console.warn(`[systemSound:${key}]`, err.message);
    return null;
  }
}

export function stopLoopingSystemSound(key) {
  const audio = loopPlayers.get(key);
  if (!audio) return;
  try { audio.pause(); } catch { /* ignore */ }
  try { audio.currentTime = 0; } catch { /* ignore unsupported seek */ }
  loopPlayers.delete(key);
}

export function stopAllSystemSounds() {
  for (const key of Array.from(loopPlayers.keys())) stopLoopingSystemSound(key);
}
