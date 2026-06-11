/**
 * window-state.cjs – ウィンドウ位置・サイズ・最大化/全画面状態の保存と復元
 *
 * アプリ再起動（手動・アップデート・遠隔再起動）後も、終了時と同じ
 * ウィンドウ状態（最大化していたら最大化のまま等）で立ち上がるようにする。
 */

const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 500;

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState(defaults = { width: 1280, height: 800 }) {
  let state = { ...defaults };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (saved && typeof saved === 'object') state = { ...state, ...saved };
  } catch { /* 初回起動 */ }

  // 保存座標がどのディスプレイにも乗っていない場合は位置指定を捨てる
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    const visible = screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return (
        state.x < area.x + area.width &&
        state.x + (state.width || 0) > area.x &&
        state.y < area.y + area.height &&
        state.y + (state.height || 0) > area.y
      );
    });
    if (!visible) {
      delete state.x;
      delete state.y;
    }
  }
  return state;
}

function trackWindowState(win) {
  let saveTimer = null;

  const capture = () => {
    if (!win || win.isDestroyed()) return null;
    const bounds = win.isMaximized() || win.isFullScreen()
      ? (win.getNormalBounds?.() || win.getBounds())
      : win.getBounds();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    };
  };

  const persist = () => {
    const state = capture();
    if (!state) return;
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[WindowState] save failed:', err.message);
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
  };

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, scheduleSave);
  }
  win.on('close', () => {
    clearTimeout(saveTimer);
    persist();
  });
}

function applyWindowState(win, state) {
  if (state.maximized) win.maximize();
  if (state.fullScreen) win.setFullScreen(true);
}

module.exports = { readWindowState, trackWindowState, applyWindowState };
