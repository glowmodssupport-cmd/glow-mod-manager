const test = require('node:test');
const assert = require('node:assert/strict');
const executable = (name) => process.platform === 'win32' ? name + '.exe' : name;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { detectGames } = require('../discovery');

async function fixture(t) {
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, 'glow-discovery-'));
  t.after(async () => {
    const target = path.resolve(root);
    if (path.dirname(target) === tmp && path.basename(target).startsWith('glow-discovery-')) {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
  return root;
}

async function write(file, body = 'test executable file') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { mode: 0o700 });
  return file;
}

test('finds registered Steam, alternate libraries and conventional nested executables', async (t) => {
  const root = await fixture(t);
  const steam = path.join(root, 'Store');
  const extra = path.join(root, 'Other library');
  const winEscaped = (value) => value.replaceAll('\\', '\\\\');
  await write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), [
    '"libraryfolders"',
    '{',
    '  "0"',
    '  {',
    '    "path" "' + winEscaped(extra) + '"',
    '  }',
    '  "1" "' + winEscaped(extra) + '"',
    '}',
  ].join('\n'));
  const primary = path.join(steam, 'steamapps', 'common', 'Example');
  const alternate = path.join(extra, 'steamapps', 'common', 'OtherGame');
  const primaryExe = await write(path.join(primary, executable('Example')));
  await write(path.join(primary, executable('CrashReporter')));
  const alternateExe = await write(path.join(alternate, 'ExampleProject', 'Binaries', 'Win64', executable('OtherGame-Win64-Shipping')));
  await write(path.join(extra, 'steamapps', 'appmanifest_123.acf'), [
    '"AppState"',
    '{',
    '  "name" "A different game"',
    '  "installdir" "OtherGame"',
    '}',
  ].join('\n'));

  const registered = async () => [steam, steam];
  const config = { env: {}, getSteamPaths: registered, searchDefaults: false };
  const actual = await detectGames(config);
  assert.deepEqual(actual, [
    { exe: alternateExe, name: 'A different game', root: alternate, source: 'Steam' },
    { exe: primaryExe, name: 'Example', root: primary, source: 'Steam' },
  ]);
  assert.deepEqual(await detectGames(config), actual);
});

test('prefers Epic manifests, finds Rockstar installs and rejects traversal or linked launch candidates', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  const manifests = path.join(root, 'data', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const programFiles = path.join(root, 'program files');
  const epic = path.join(programFiles, 'Epic Games', 'Example');
  const rockstar = path.join(programFiles, 'Rockstar Games', 'Sample');
  const epicExe = await write(path.join(epic, 'Binaries', 'Win64', 'Epic-Shipping.exe'));
  const rockstarExe = await write(path.join(rockstar, 'Sample.exe'));
  await write(path.join(programFiles, 'Rockstar Games', 'Launcher', 'BackgroundService.exe'));
  await write(path.join(root, 'outside.exe'));
  const hidden = path.join(root, 'linked-target');
  await write(path.join(hidden, 'Bad.exe'));
  await fs.symlink(hidden, path.join(epic, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = (file, attrs) => write(path.join(manifests, file + '.item'), JSON.stringify({
    InstallLocation: epic, bIsApplication: true, ...attrs,
  }));
  await manifest('good', { DisplayName: 'Epic published name', LaunchExecutable: 'Binaries\\Win64\\Epic-Shipping.exe' });
  await manifest('traversal', { DisplayName: 'Should be hidden', LaunchExecutable: '..\\..\\..\\outside.exe' });
  await manifest('link', { DisplayName: 'Linked destination', LaunchExecutable: 'linked\\Bad.exe' });
  await manifest('absolute', { DisplayName: 'Absolute', LaunchExecutable: path.join(root, 'outside.exe') });
  await manifest('incomplete', { DisplayName: 'Incomplete', LaunchExecutable: 'Binaries\\Win64\\Epic-Shipping.exe', bIsIncompleteInstall: true });
  await write(path.join(manifests, 'stale.item'), '{');

  const actual = await detectGames({
    env: { ProgramFiles: programFiles, ProgramData: path.join(root, 'data') },
    getSteamPaths: async () => { throw new Error('Registry not available'); },
    searchDefaults: false,
  });
  assert.deepEqual(actual, [
    { exe: epicExe, name: 'Epic published name', root: epic, source: 'Epic Games' },
    { exe: rockstarExe, name: 'Sample', root: rockstar, source: 'Rockstar Games' },
  ]);
});
