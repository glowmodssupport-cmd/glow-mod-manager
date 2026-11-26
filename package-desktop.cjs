const { build, Platform, Arch } = require('electron-builder');
const { build: options, version: defaultVersion } = require('./package.json');
const { httpsUrl } = require('./updates');

const targets = { win: Platform.WINDOWS, mac: Platform.MAC, linux: Platform.LINUX };
const platform = process.argv[2];
const arch = process.argv[3] || (process.arch === 'arm64' ? 'arm64' : 'x64');
if (!targets[platform] || !['x64', 'arm64'].includes(arch)) throw Error('Choose win, mac, or linux and optionally x64 or arm64.');
const version = process.env.GLOW_RELEASE_VERSION || defaultVersion;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Use a stable version such as 1.0.1.');
const signPath = process.env.GLOW_SIGNPATH === '1';
const settings = {
  modsUrl: process.env.GLOW_MODS_URL ? httpsUrl(process.env.GLOW_MODS_URL, 'Mods URL') : '',
  updateUrl: process.env.GLOW_UPDATE_URL ? httpsUrl(process.env.GLOW_UPDATE_URL, 'Update feed') : '',
  publisher: (process.env.GLOW_WINDOWS_PUBLISHER || '').trim(),
};
if (signPath && (platform !== 'win' || !settings.updateUrl || !settings.publisher)) {
  throw Error('SignPath staging needs a Windows build, an HTTPS update feed and the SignPath certificate subject.');
}
const config = { ...options, extraMetadata: { version, glowRelease: settings } };
if (process.env.GLOW_BUILD_DIR) config.directories = { output: process.env.GLOW_BUILD_DIR };
if (arch === 'arm64' && platform === 'win') config.artifactName = 'GlowModManager-Setup-${version}-arm64.${ext}';
if (settings.updateUrl) {
  const feed = new URL(settings.updateUrl);
  if (feed.search || feed.hash) throw Error('The update feed URL cannot contain a query string or fragment.');
  config.publish = { provider: 'generic', url: settings.updateUrl };
  if (platform === 'win') {
    if (!settings.publisher || (!signPath && !(process.env.WIN_CSC_LINK || process.env.CSC_LINK))) {
      throw Error('Windows update builds need a signing route and GLOW_WINDOWS_PUBLISHER.');
    }
    config.win = { ...config.win, signExecutable: !signPath, signtoolOptions: { publisherName: settings.publisher } };
    config.nsis = { ...config.nsis, differentialPackage: false };
  }
  if (platform !== 'linux' && !signPath) config.forceCodeSigning = true;
}
build({ targets: targets[platform].createTarget(undefined, Arch[arch]), config, publish: 'never' })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
