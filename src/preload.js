'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleet', {
  getInitial: () => ipcRenderer.invoke('get-initial'),
  validate: (config) => ipcRenderer.invoke('validate', config),
  launch: (config) => ipcRenderer.invoke('launch', config),
  getSnippets: () => ipcRenderer.invoke('snippets:get'),
  saveSnippets: (list) => ipcRenderer.invoke('snippets:save', list),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  importProfilesFile: () => ipcRenderer.invoke('profiles:import-file'),
  importProfilesText: (text) => ipcRenderer.invoke('profiles:import-text', text),
  deleteProfiles: (ids) => ipcRenderer.invoke('profiles:delete', ids),
  command: (name, tabId, arg) => ipcRenderer.send('command', name, tabId, arg),
  invoke: (name, tabId, arg) => ipcRenderer.invoke('invoke', name, tabId, arg),
  setInsets: (insets) => ipcRenderer.send('layout-insets', insets),
  onState: (listener) => ipcRenderer.on('state', (_event, state) => listener(state)),
  onFocusAddress: (listener) => ipcRenderer.on('focus-address', () => listener()),
  onTogglePanel: (listener) => ipcRenderer.on('toggle-panel', (_event, section) => listener(section)),
  onProfilesChanged: (listener) => ipcRenderer.on('profiles-changed', () => listener()),
  onProfilesImported: (listener) => ipcRenderer.on('profiles-imported', (_event, result) => listener(result)),
});
