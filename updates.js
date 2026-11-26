const { load } = require('js-yaml');

function httpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw Error(label + ' must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error(label + ' must be an HTTPS URL without credentials.');
  return url.href;
}

function validWindowsFeed(config, { publisher, updateUrl }) {
  try {
    const parsed = load(config);
    return parsed.provider === 'generic' && httpsUrl(parsed.url, 'Update feed') === updateUrl &&
      Array.isArray(parsed.publisherName) && parsed.publisherName.length === 1 &&
      parsed.publisherName[0] === publisher;
  } catch { return false; }
}

function createUpdates(updater, notify = () => {}) {
  let state = updater ? { phase: 'idle', message: '' }
    : { phase: 'unconfigured', message: '' };
  let busy = false;
  const set = (phase, message, details = {}) => {
    state = { phase, message, ...details };
    notify(state);
  };
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.on('update-available', ({ version }) => set('available', 'Version ' + version + ' is available.', { version }));
    updater.on('update-not-available', () => set('current', 'You’re up to date.'));
    updater.on('download-progress', ({ percent }) => {
      if (state.phase === 'downloading' && Number.isFinite(percent)) {
        const next = Math.round(Math.max(0, Math.min(100, percent)));
        if (next !== state.percent) set('downloading', 'Downloading update…', { percent: next });
      }
    });
    updater.on('update-downloaded', () => set('ready', 'Update downloaded. Restart Glow to install it.'));
    updater.on('error', () => set('error', 'The update could not be verified or downloaded. Try checking again later.'));
  }

  async function run(phase, message, action) {
    busy = true;
    set(phase, message);
    try {
      await action();
      if (state.phase === phase) set('error', 'The update service did not return a usable result.');
    } catch {
      if (state.phase !== 'error') set('error', 'The update check or download failed. Try again later.');
    } finally { busy = false; }
    return state;
  }

  return {
    state: () => state,
    check() {
      if (!updater || busy || ['available', 'ready', 'installing'].includes(state.phase)) return state;
      return run('checking', 'Checking for updates…', () => updater.checkForUpdates());
    },
    download() {
      if (!updater || busy || state.phase !== 'available') return state;
      return run('downloading', 'Downloading update…', () => updater.downloadUpdate());
    },
    install() {
      if (!updater || busy || state.phase !== 'ready') throw Error('Download an update before installing it.');
      set('installing', 'Restarting Glow Mod Manager…');
      try { updater.quitAndInstall(false, true); }
      catch {
        set('ready', 'Restart failed. Try installing the update again.');
        throw Error(state.message);
      }
      return state;
    },
  };
}

module.exports = { createUpdates, httpsUrl, validWindowsFeed };
