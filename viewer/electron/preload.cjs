const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  restartApp: () => ipcRenderer.send('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  downloadUpdatePackage: (packageInfo) => ipcRenderer.invoke('download-update-package', packageInfo),
  installUpdatePackage: (payload) => ipcRenderer.invoke('install-update-package', payload),
  openDownloadedUpdate: (filePath) => ipcRenderer.invoke('open-downloaded-update', filePath),
  onQuickRestartRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('quick-restart-request', listener);
    return () => ipcRenderer.removeListener('quick-restart-request', listener);
  },
  quickRestartResult: (payload) => ipcRenderer.send('quick-restart-result', payload),
});
