const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  restartApp: () => ipcRenderer.send('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  downloadUpdatePackage: (packageInfo) => ipcRenderer.invoke('download-update-package', packageInfo),
  installUpdatePackage: (payload) => ipcRenderer.invoke('install-update-package', payload),
  openDownloadedUpdate: (filePath) => ipcRenderer.invoke('open-downloaded-update', filePath),
  writeDebugLog: (payload) => ipcRenderer.invoke('write-debug-log', payload || {}),
  getDebugLogInfo: () => ipcRenderer.invoke('get-debug-log-info'),
  getClientAppSettings: () => ipcRenderer.invoke('get-client-app-settings'),
  saveClientAppSettings: (settings) => ipcRenderer.invoke('save-client-app-settings', settings || {}),
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
