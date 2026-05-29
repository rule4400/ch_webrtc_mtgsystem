const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  restartApp: () => ipcRenderer.send('restart-app')
});
