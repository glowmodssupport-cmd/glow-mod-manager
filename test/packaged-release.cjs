const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { httpsUrl, validWindowsFeed } = require('../updates');
const { version: sourceVersion } = require('../package.json');

const output = path.resolve(process.argv[2] || 'dist');
const version = process.env.GLOW_RELEASE_VERSION || sourceVersion;
const resources = path.join(output, 'win-unpacked', 'resources');
const installer = path.join(output, 'GlowModManager-Setup-' + version + '.exe');
const archive = path.join(resources, 'app.asar');
const manifest = path.join(resources, 'app-update.yml');
const config = JSON.parse(asar.extractFile(archive, 'package.json'));
const optionalUrl = (value, label) => value ? httpsUrl(value, label) : '';
const expected = {
  modsUrl: optionalUrl(process.env.GLOW_MODS_URL, 'Mods URL'),
  updateUrl: optionalUrl(process.env.GLOW_UPDATE_URL, 'Update feed'),
  publisher: (process.env.GLOW_WINDOWS_PUBLISHER || '').trim(),
};

assert(fs.statSync(installer).isFile(), 'Expected a Windows installer.');
assert.equal(config.version, version);
assert.equal(config.name, 'glow-mod-manager');
assert.deepEqual(config.glowRelease, expected);
for (const file of ['main.js', 'index.html', 'preload.js', 'updates.js']) {
  assert(asar.extractFile(archive, file).length, 'Missing app file: ' + file);
}
if (expected.updateUrl) {
  assert(validWindowsFeed(fs.readFileSync(manifest, 'utf8'), expected), 'Windows publisher or update feed does not match.');
} else {
  assert(!fs.existsSync(manifest), 'A build without an update feed unexpectedly contains update metadata.');
}
console.log('Verified the Windows installer and bundled release configuration for ' + version + '.');
