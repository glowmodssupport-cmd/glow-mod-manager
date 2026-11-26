const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke('glow:' + name, ...args);
contextBridge.exposeInMainWorld('glow', {
  state: call('state'),
  sessionState: call('sessionState'),
  releaseFeatures: call('releaseFeatures'),
  checkUpdate: call('checkUpdate'),
  downloadUpdate: call('downloadUpdate'),
  installUpdate: call('installUpdate'),
  openMods: call('openMods'),
  onUpdate(listener) {
    ipcRenderer.on('glow:update-state', (_event, state) => listener(state));
  },
  detect: call('detect'),
  browse: call('browse'),
  selectGame: call('selectGame'),
  setModsFolder: call('setModsFolder'),
  chooseImport: call('chooseImport'),
  importPaths: (files) => call('importPaths')(Array.from(files, (file) => webUtils.getPathForFile(file))),
  toggle: call('toggle'),
  remove: call('remove'),
  launch: call('launch'),
  launchVanilla: call('launchVanilla'),
  restoreOriginal: call('restoreOriginal'),
  clearProfiles: call('clearProfiles'),
  cancelLaunch: call('cancelLaunch'),
  openFolder: call('openFolder'),
});
