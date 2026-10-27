'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleet', {
  getInitial: () => ipcRenderer.invoke('get-initial'),
  validate: (config) => ipcRenderer.invoke('validate', config),
  launch: (config) => ipcRenderer.invoke('launch', config),
  getSnippets: () => ipcRenderer.invoke('snippets:get'),
  saveSnippets: (list) => ipcRenderer.invoke('snippets:save', list),
  command: (name, tabId, arg) => ipcRenderer.send('command', name, tabId, arg),
  setInsets: (insets) => ipcRenderer.send('layout-insets', insets),
  onState: (listener) => ipcRenderer.on('state', (_event, state) => listener(state)),
  onFocusAddress: (listener) => ipcRenderer.on('focus-address', () => listener()),
  onTogglePanel: (listener) => ipcRenderer.on('toggle-panel', () => listener()),
});
