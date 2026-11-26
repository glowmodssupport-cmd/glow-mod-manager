const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates, httpsUrl, validWindowsFeed } = require('../updates');

test('keeps updates inactive without a feed and rejects insecure release URLs', () => {
  const updates = createUpdates(null);
  assert.deepEqual(updates.check(), { phase: 'unconfigured', message: '' });
  assert.equal(updates.download().phase, 'unconfigured');
  assert.throws(() => updates.install(), /Download an update/);
  assert.throws(() => httpsUrl('http://example.com', 'Feed'), /HTTPS/);
  assert.throws(() => httpsUrl('https://example-user:example-value@localhost', 'Feed'), /credentials/);
  assert.equal(httpsUrl('https://example.com/release', 'Feed'), 'https://example.com/release');
});

test('reports availability and progress and waits for explicit installation', async () => {
  const updater = new EventEmitter();
  const changes = [];
  let installed = 0;
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.4.0' });
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 42.2 });
    updater.emit('update-downloaded');
  };
  updater.quitAndInstall = () => installed++;
  const updates = createUpdates(updater, (state) => changes.push(state));
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal((await updates.check()).version, '0.4.0');
  assert.equal(installed, 0);
  assert.equal((await updates.download()).phase, 'ready');
  assert.equal(changes.find((state) => state.percent != null).percent, 42);
  assert.equal(installed, 0);
  assert.equal(updates.install().phase, 'installing');
  assert.equal(installed, 1);
});

test('reports a failed check and lets the user retry', async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { throw Error('Network unavailable'); };
  const updates = createUpdates(updater);
  assert.equal((await updates.check()).phase, 'error');
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await updates.check()).phase, 'current');
});

test('Windows ignores missing, mismatched or unsigned feed configuration', () => {
  const settings = { updateUrl: 'https://example.test/windows/', publisher: 'CN=Example Publisher' };
  const config = { provider: 'generic', url: settings.updateUrl, publisherName: [settings.publisher] };
  assert.equal(validWindowsFeed(JSON.stringify(config), settings), true);
  for (const bad of ['', '[]', 'publisherName: null', ...[
    { url: 'http://example.test/windows/' }, { url: 'https://other.test/windows/' },
    { publisherName: [] }, { publisherName: ['CN=Different Publisher'] },
    { publisherName: [settings.publisher, 'CN=Another Publisher'] },
  ].map((change) => JSON.stringify({ ...config, ...change }))]) {
    assert.equal(validWindowsFeed(bad, settings), false);
  }
});
