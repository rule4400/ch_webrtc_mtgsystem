const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  startServer: (serverPath) => ipcRenderer.send('start-server', serverPath),
  stopServer: () => ipcRenderer.send('stop-server'),
  kickClient: (socketId) => ipcRenderer.send('kick-client', socketId),
  restartAll: () => ipcRenderer.send('restart-all'),
  restartClient: (socketId) => ipcRenderer.send('restart-client', socketId),
  setClientDevice: (socketId, kind, deviceId) => ipcRenderer.send('set-client-device', { socketId, kind, deviceId }),
  refreshClientDevices: (socketId) => ipcRenderer.send('refresh-client-devices', socketId),
  onServerStatus: (callback) => ipcRenderer.on('server-status', (event, status) => callback(status)),
  onServerLog: (callback) => ipcRenderer.on('server-log', (event, log) => callback(log)),
  onServerStats: (callback) => ipcRenderer.on('server-stats', (event, stats) => callback(stats))
});
