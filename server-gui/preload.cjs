const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  startServer: (serverPath) => ipcRenderer.send('start-server', serverPath),
  stopServer: () => ipcRenderer.send('stop-server'),
  kickClient: (socketId) => ipcRenderer.send('kick-client', socketId),
  restartAll: () => ipcRenderer.send('restart-all'),
  onServerStatus: (callback) => ipcRenderer.on('server-status', (event, status) => callback(status)),
  onServerLog: (callback) => ipcRenderer.on('server-log', (event, log) => callback(log)),
  onServerStats: (callback) => ipcRenderer.on('server-stats', (event, stats) => callback(stats))
});
