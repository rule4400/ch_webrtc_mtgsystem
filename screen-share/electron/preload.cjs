const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getScreenCaptureStatus: () => ipcRenderer.invoke('get-screen-capture-status'),
  listDesktopSources: (options) => ipcRenderer.invoke('list-desktop-sources', options),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openScreenCaptureSettings: () => ipcRenderer.invoke('open-screen-capture-settings'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  selectDisplaySource: (source) => ipcRenderer.invoke('select-display-source', source),
  setSharingActive: (active) => ipcRenderer.invoke('set-sharing-active', active),
});
