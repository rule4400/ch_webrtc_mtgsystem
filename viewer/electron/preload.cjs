const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  restartApp: () => ipcRenderer.send('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onQuickRestartRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('quick-restart-request', listener);
    return () => ipcRenderer.removeListener('quick-restart-request', listener);
  },
  quickRestartResult: (payload) => ipcRenderer.send('quick-restart-result', payload),
});
