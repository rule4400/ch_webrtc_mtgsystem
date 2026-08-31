const { contextBridge, ipcRenderer } = require('electron');

// recordings.html (共有タイムラインUI) が参照するデータソースブリッジ。
// これが存在すると UI は HTTP ではなくこのブリッジ経由でデータを取得し、
// ヘッダーに「⚙ データソース」設定ボタンを表示する。
contextBridge.exposeInMainWorld('recviewer', {
  mode: () => ipcRenderer.invoke('rv-get-config'),
  getConfig: () => ipcRenderer.invoke('rv-get-config'),
  setConfig: (config) => ipcRenderer.invoke('rv-set-config', config),
  chooseFolder: (title) => ipcRenderer.invoke('rv-choose-folder', title),
  status: () => ipcRenderer.invoke('rv-status'),
  locations: () => ipcRenderer.invoke('rv-locations'),
  segments: (query) => ipcRenderer.invoke('rv-segments', query),
  live: () => ipcRenderer.invoke('rv-live'),
});
