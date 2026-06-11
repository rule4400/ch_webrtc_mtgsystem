const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  restartApp: () => ipcRenderer.send('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onQuickRestartRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('quick-restart-request', listener);
    return () => ipcRenderer.removeListener('quick-restart-request', listener);
  },
  quickRestartResult: (payload) => ipcRenderer.send('quick-restart-result', payload),

  // 画面共有（Client内蔵）
  getScreenCaptureStatus: () => ipcRenderer.invoke('get-screen-capture-status'),
  listDesktopSources: (options) => ipcRenderer.invoke('list-desktop-sources', options || {}),
  openScreenCaptureSettings: () => ipcRenderer.invoke('open-screen-capture-settings'),
});
