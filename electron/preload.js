'use strict';
// The only bridge between the UI and the main process: a fixed list of calls, no raw ipcRenderer.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const EVENTS = ['state', 'log', 'toast', 'test', 'test-result', 'test-start', 'test-progress', 'stats', 'connections', 'progress'];

contextBridge.exposeInMainWorld('best', {
  getState: invoke('state:get'),
  getLogs: invoke('logs:get'),
  clearLogs: invoke('logs:clear'),
  connect: invoke('core:connect'),
  disconnect: invoke('core:disconnect'),
  toggle: invoke('core:toggle'),
  toggleProxy: invoke('proxy:toggle'),
  versions: invoke('core:versions'),
  setProxyMode: invoke('proxy:set'),
  setRouting: invoke('routing:set'),
  setSettings: invoke('settings:set'),
  selectServer: invoke('server:select'),
  getServer: invoke('server:get'),
  saveServer: invoke('server:save'),
  removeServers: invoke('server:remove'),
  duplicateServer: invoke('server:duplicate'),
  removeDuplicates: invoke('server:removeDuplicates'),
  removeFailed: invoke('server:removeFailed'),
  moveServer: invoke('server:move'),
  importText: invoke('server:importText'),
  importClipboard: invoke('server:importClipboard'),
  scanScreen: invoke('server:scanScreen'),
  openConfigFile: invoke('server:openFile'),
  getLink: invoke('server:link'),
  copyLinks: invoke('server:copyLinks'),
  getQr: invoke('server:qr'),
  clearResults: invoke('server:clearResults'),
  parseLink: invoke('server:parse'),
  previewServer: invoke('server:preview'),
  makeQr: invoke('qr:make'),
  readConfigFile: invoke('sys:readConfigFile'),
  checkExitIp: invoke('net:exitIp'),
  watchConnections: invoke('conn:watch'),
  closeConnection: invoke('conn:close'),
  davUpload: invoke('dav:upload'),
  davList: invoke('dav:list'),
  davRestore: invoke('dav:restore'),
  installAppUpdate: invoke('upd:app'),
  listStoreApps: invoke('uwp:list'),
  setStoreApps: invoke('uwp:set'),
  runTest: invoke('test:run'),
  cancelTest: invoke('test:cancel'),
  saveSub: invoke('sub:save'),
  removeSub: invoke('sub:remove'),
  updateSubs: invoke('sub:update'),
  openSubLink: invoke('sub:open'),
  relaunchAdmin: invoke('sys:relaunchAdmin'),
  openDataFolder: invoke('sys:openDataFolder'),
  copy: invoke('sys:copy'),
  quit: invoke('sys:quit'),
  showMain: invoke('sys:showMain'),
  hideTray: invoke('sys:hideTray'),
  exportBackup: invoke('sys:exportBackup'),
  importBackup: invoke('sys:importBackup'),
  importRules: invoke('routing:import'),
  exportRules: invoke('routing:export'),
  checkUpdates: invoke('upd:check'),
  applyUpdate: invoke('upd:apply'),
  applyAllUpdates: invoke('upd:applyAll'),
  resetUpdate: invoke('upd:reset'),
  cancelUpdate: invoke('upd:cancel'),
  on(event, cb) {
    if (!EVENTS.includes(event) || typeof cb !== 'function') return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
