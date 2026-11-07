'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('k4p', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openOnline: (input) => ipcRenderer.invoke('open-online', input),
  resolveWork: (input) => ipcRenderer.invoke('resolve-work', input),
  reload: () => ipcRenderer.invoke('reload-player'),
  closeProject: () => ipcRenderer.invoke('close-project'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  setChrome: (v) => ipcRenderer.invoke('set-chrome', v),
  minimize: () => ipcRenderer.invoke('win-minimize'),
  maximize: () => ipcRenderer.invoke('win-maximize'),
  closeWindow: () => ipcRenderer.invoke('win-close'),
  getState: () => ipcRenderer.invoke('get-state'),
  authState: () => ipcRenderer.invoke('auth-state'),
  login: (identity, password) => ipcRenderer.invoke('auth-login', { identity, password }),
  logout: () => ipcRenderer.invoke('auth-logout'),
  clearRecent: () => ipcRenderer.invoke('clear-recent'),
  removeRecent: (p) => ipcRenderer.invoke('remove-recent', p),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openInEditor: (p) => ipcRenderer.invoke('open-in-editor', p),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
  on: (channel, cb) => {
    const allowed = ['state', 'project-opened', 'project-closed', 'error', 'player-crashed', 'player-log', 'chrome-visible', 'not-playable', 'online-progress', 'goto-workid', 'auth-changed'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
