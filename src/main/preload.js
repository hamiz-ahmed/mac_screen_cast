const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  setDisplay: (id) => ipcRenderer.invoke('set-display', id),
  setWantAudio: (v) => ipcRenderer.invoke('set-want-audio', v),
  setSystemMute: (v) => ipcRenderer.invoke('set-system-mute', v),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
});
