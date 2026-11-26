const assert = require('node:assert/strict');
const executable = (name) => process.platform === 'win32' ? name + '.exe' : name;
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { crc32 } = require('node:zlib');
const test = require('node:test');
const { Library } = require('../library');

// Small stored ZIP fixture. No unpacking tool or real game files are needed.
function zip(entries) {
  const local = [];
  const directory = [];
  let offset = 0;
  for (const [file, text] of entries) {
    const name = Buffer.from(file);
    const data = Buffer.from(text);
    const lh = Buffer.alloc(30);
    const cd = Buffer.alloc(46);
    lh.writeUInt32LE(0x04034b50);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(20, 4);
    lh.copy(cd, 6, 4, 28);
    cd.writeUInt32LE(offset, 42);
    local.push(lh, name, data);
    directory.push(cd, name);
    offset += lh.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  const index = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'glow-manager-test-'));
  assert.equal(path.dirname(root), parent);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = new Library(path.join(root, 'app-data'));
  await library.init();
  const game = path.join(root, 'game');
  await fs.mkdir(game);
  const exe = path.join(game, executable('Sample'));
  await fs.writeFile(exe, 'fake executable used for path selection only', { mode: 0o700 });
  const manifest = JSON.stringify({ format: 'glow-mod-v1', name: 'Coast lighting', category: 'Visuals' });
  const source = (name, entries) => fs.writeFile(path.join(root, name), zip([['glow-mod.json', manifest], ...entries]));
  return { root, library, game, exe, source };
}

test('imports, remembers choices, auto-creates the mods folder in a copy, and leaves the original alone', async (t) => {
  const f = await fixture(t);
  await f.source('coast.zip', [['files/looks/coast.ini', 'brightness=15']]);
  const file = path.join(f.root, 'coast.zip');
  await f.library.importZip(file);
  await assert.rejects(f.library.importZip(file), /already in/);
  const [{ id, category, enabled }] = (await f.library.state()).mods;
  assert.equal(category, 'Visuals');
  assert.equal(enabled, false);
  await assert.rejects(f.library.toggle(id, true), /Select a game/);
  await f.library.selectGame(f.exe);
  assert.equal((await f.library.game()).modsFolder, 'mods');
  await f.library.toggle(id, true);
  await assert.rejects(fs.stat(path.join(f.game, 'mods')), { code: 'ENOENT' });
  const loaded = new Library(f.library.folder);
  await loaded.init();
  assert.equal((await loaded.state()).mods[0].enabled, true);
  const profile = await loaded.prepareGame();
  assert.equal(path.dirname(profile.exe), profile.root);
  const deployed = path.join(profile.root, 'mods', 'glow-' + id, 'looks', 'coast.ini');
  assert.equal(await fs.readFile(deployed, 'utf8'), 'brightness=15');
  assert.equal((await loaded.originalGame()).exe, f.exe);
  await fs.writeFile(profile.exe, 'changed in the copy');
  assert.equal(await fs.readFile(f.exe, 'utf8'), 'fake executable used for path selection only');
  await loaded.toggle(id, false);
  await assert.rejects(loaded.prepareGame(), /Enable a mod/);
  await loaded.clearProfiles(await loaded.profiles());
  await assert.rejects(fs.stat(profile.root), { code: 'ENOENT' });
  await loaded.remove(id);
  assert.equal((await loaded.state()).mods.length, 0);
  await assert.rejects(fs.stat(path.join(f.game, 'mods')), { code: 'ENOENT' });
});

test('invalid ZIP paths, aliases and executable files are refused without leaving a package', async (t) => {
  const f = await fixture(t);
  for (const entries of [
    [['files/../outside.txt', 'invalid']],
    [['files/plug.dll', 'invalid']],
    [['files/Case.ini', 'a'], ['files/case.ini', 'b']],
    [['files/NUL.txt', 'invalid']],
    [['files/runner.js', 'invalid']],
  ]) {
    await f.source('broken.zip', entries);
    await assert.rejects(f.library.importZip(path.join(f.root, 'broken.zip')));
    assert.deepEqual(await fs.readdir(f.library.packages), []);
  }
});

test('existing mods are copied intact, conflicts block a launch, and saved copies have a cap', async (t) => {
  const f = await fixture(t);
  const thirdParty = path.join(f.game, 'mods', 'vendor-mod');
  await fs.mkdir(thirdParty, { recursive: true });
  await fs.writeFile(path.join(thirdParty, 'example.ini'), 'preserve');
  await f.source('coast.zip', [['files/coast.ini', 'brightness=15']]);
  await f.source('dark.zip', [['files/coast.ini', 'brightness=3']]);
  await f.library.importZip(path.join(f.root, 'coast.zip'));
  await f.library.importZip(path.join(f.root, 'dark.zip'));
  const [{ id }, second] = (await f.library.state()).mods;
  await f.library.selectGame(f.exe);
  await f.library.toggle(id, true);
  await f.library.toggle(second.id, true);
  await assert.rejects(f.library.prepareGame(), /Both .* change coast.ini/);
  assert.equal((await f.library.profiles()).length, 0);
  await f.library.toggle(second.id, false);
  const one = await f.library.prepareGame();
  assert.equal(await fs.readFile(path.join(one.root, 'mods', 'vendor-mod', 'example.ini'), 'utf8'), 'preserve');
  assert.equal(await fs.readFile(path.join(thirdParty, 'example.ini'), 'utf8'), 'preserve');
  assert.deepEqual(await fs.readdir(path.join(f.game, 'mods')), ['vendor-mod']);
  const reused = await f.library.prepareGame();
  assert.equal(reused.root, one.root);
  assert.equal(reused.reused, true);
  await fs.writeFile(path.join(f.game, 'updated.txt'), 'new game build');
  const two = await f.library.prepareGame();
  assert.notEqual(two.root, one.root);
  await fs.writeFile(path.join(f.game, 'one-more-update.txt'), 'newer game build');
  await assert.rejects(f.library.prepareGame(), /Two game copies/);
  assert.equal((await f.library.state()).profiles, 2);
});

test('legacy cleanup refuses changes, then restores only verified Glow folders', async (t) => {
  const f = await fixture(t);
  await f.source('coast.zip', [['files/looks/coast.ini', 'brightness=15']]);
  await f.library.importZip(path.join(f.root, 'coast.zip'));
  const [{ id }] = (await f.library.state()).mods;
  await f.library.selectGame(f.exe);
  const deployed = path.join(f.game, 'mods', 'glow-' + id);
  await fs.mkdir(path.join(deployed, 'looks'), { recursive: true });
  await fs.writeFile(path.join(deployed, '.glow-manager.json'), JSON.stringify({ id }));
  const data = path.join(deployed, 'looks', 'coast.ini');
  await fs.writeFile(data, 'your change');
  assert.equal((await f.library.state()).legacyEnabled, 1);
  await assert.rejects(f.library.originalGame(), /Restore files/);
  await assert.rejects(f.library.restoreOriginal(), /legacy mod file changed/);
  assert.equal(await fs.readFile(data, 'utf8'), 'your change');
  await fs.writeFile(data, 'brightness=15');
  await fs.mkdir(path.join(deployed, 'user-folder'));
  await assert.rejects(f.library.restoreOriginal(), /extra or renamed/);
  await fs.rmdir(path.join(deployed, 'user-folder'));
  const unrelated = path.join(f.game, 'mods', 'unrelated.ini');
  await fs.writeFile(unrelated, 'leave alone');
  await f.library.restoreOriginal();
  assert.equal((await f.library.state()).legacyEnabled, 0);
  assert.equal((await f.library.state()).mods[0].enabled, true);
  assert.equal((await f.library.originalGame()).exe, f.exe);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'leave alone');
  await assert.rejects(fs.stat(deployed), { code: 'ENOENT' });
});

test('choices are kept per game and redirected game folders are refused', async (t) => {
  const f = await fixture(t);
  await f.source('coast.zip', [['files/coast.ini', 'brightness=15']]);
  await f.library.importZip(path.join(f.root, 'coast.zip'));
  const [{ id }] = (await f.library.state()).mods;
  await f.library.selectGame(f.exe);
  await assert.rejects(f.library.setModsFolder('../elsewhere'), /unsupported/);
  const other = path.join(f.root, 'other');
  await fs.mkdir(other);
  await fs.symlink(other, path.join(f.game, 'redirect'), 'junction');
  await assert.rejects(f.library.setModsFolder('redirect'), /redirected/);
  await fs.unlink(path.join(f.game, 'redirect'));
  await f.library.toggle(id, true);
  const second = path.join(other, executable('Second'));
  await fs.writeFile(second, 'path fixture', { mode: 0o700 });
  await f.library.selectGame(second);
  assert.equal((await f.library.state()).mods[0].enabled, false);
  await f.library.selectGame(f.exe);
  assert.equal((await f.library.state()).mods[0].enabled, true);
});

test('uses the full install root for a nested executable and keeps unrelated original files', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.game, 'Product', 'Binaries', 'Win64');
  await fs.mkdir(bin, { recursive: true });
  const exe = path.join(bin, executable('Nested'));
  await fs.writeFile(exe, 'nested exe', { mode: 0o700 });
  await fs.writeFile(path.join(f.game, 'original.dat'), 'base install');
  await f.source('coast.zip', [['files/coast.ini', 'brightness=15']]);
  await f.library.importZip(path.join(f.root, 'coast.zip'));
  await f.library.selectGame(exe, { root: f.game, name: 'Store title' });
  assert.equal((await f.library.game()).name, 'Store title');
  await f.library.toggle((await f.library.state()).mods[0].id, true);
  const profile = await f.library.prepareGame();
  assert.equal(path.relative(profile.root, profile.exe), path.relative(f.game, exe));
  assert.equal(await fs.readFile(path.join(profile.root, 'original.dat'), 'utf8'), 'base install');
  assert.equal((await fs.readdir(path.join(profile.root, 'mods'))).length, 1);
  await assert.rejects(fs.stat(path.join(f.game, 'mods')), { code: 'ENOENT' });
});
