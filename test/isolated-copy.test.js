const assert = require('node:assert/strict');
const executable = process.platform === 'win32' ? 'Sample.exe' : 'Sample';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { isIsolatedCopyName, prepareIsolatedCopy, removeIsolatedCopy } = require('../isolated-copy');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'glow-profile-test-'));
  t.after(async () => fs.rm(home, { recursive: true, force: true }));
  const source = path.join(home, 'original');
  const profiles = path.join(home, 'app', 'profiles');
  const exe = path.join(source, 'bin', executable);
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'original executable', { mode: 0o700 });
  await fs.mkdir(path.join(source, 'mods'));
  await fs.writeFile(path.join(source, 'mods', 'original.txt'), 'pre-existing data');
  return { home, source, profiles, exe };
}

test('isolated game is a complete independent copy with the same executable path and existing mods', async (t) => {
  const f = await fixture(t);
  const updates = [];
  const profile = await prepareIsolatedCopy(f.source, f.exe, f.profiles, { onProgress: (update) => updates.push(update) });
  assert.equal(path.dirname(profile.root), f.profiles);
  assert.ok(isIsolatedCopyName(path.basename(profile.root)));
  assert.equal(profile.exe, path.join(profile.root, 'bin', executable));
  assert.equal(await fs.readFile(profile.exe, 'utf8'), 'original executable');
  const copiedMod = path.join(profile.root, 'mods', 'original.txt');
  assert.equal(await fs.readFile(copiedMod, 'utf8'), 'pre-existing data');
  assert.equal(profile.bytes, Buffer.byteLength('original executablepre-existing data'));
  assert.deepEqual(updates.at(-1), { phase: 'copying', bytesCopied: profile.bytes, totalBytes: profile.bytes, filesCopied: 2, fileCount: 2 });

  await fs.writeFile(profile.exe, 'modified copy');
  await fs.writeFile(copiedMod, 'modified data');
  assert.equal(await fs.readFile(f.exe, 'utf8'), 'original executable');
  assert.equal(await fs.readFile(path.join(f.source, 'mods', 'original.txt'), 'utf8'), 'pre-existing data');

  await removeIsolatedCopy(f.profiles, profile.root);
  await assert.rejects(fs.lstat(profile.root), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.exe, 'utf8'), 'original executable');
});

test('a changed original or a cancelled copy leaves no partial profile', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareIsolatedCopy(f.source, f.exe, f.profiles, {
    onProgress: () => require('node:fs').appendFileSync(f.exe, '!'),
  }), /game changed|game file changed/i);
  assert.deepEqual(await fs.readdir(f.profiles), []);
  const controller = new AbortController();
  await assert.rejects(prepareIsolatedCopy(f.source, f.exe, f.profiles, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(f.profiles), []);
});

test('profile root overlap, redirected game directories, and unowned cleanup targets are refused', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareIsolatedCopy(f.source, f.exe, path.join(f.source, 'copies')), /separate folders/);
  await assert.rejects(fs.lstat(path.join(f.source, 'copies')), { code: 'ENOENT' });

  const upstream = path.join(f.home, 'elsewhere');
  await fs.mkdir(upstream);
  await fs.writeFile(path.join(upstream, 'keep.txt'), 'untouched');
  await fs.symlink(upstream, path.join(f.source, 'mods', 'redirected'), 'junction');
  await assert.rejects(prepareIsolatedCopy(f.source, f.exe, f.profiles), /redirected or unsupported/);
  assert.equal(await fs.readFile(path.join(upstream, 'keep.txt'), 'utf8'), 'untouched');

  const unowned = path.join(f.profiles, 'profile-' + '0'.repeat(32));
  await fs.mkdir(unowned, { recursive: true });
  await fs.writeFile(path.join(unowned, 'keep.txt'), 'unowned');
  await assert.rejects(removeIsolatedCopy(f.profiles, unowned), { code: 'ENOENT' });
  await assert.rejects(removeIsolatedCopy(f.profiles, f.source), /not a Glow isolated profile/);
  assert.equal(await fs.readFile(path.join(unowned, 'keep.txt'), 'utf8'), 'unowned');
});

test('copy checks local disk headroom for source and enabled mods before writing a profile', async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1n, bsize: 4096n }));
  await assert.rejects(prepareIsolatedCopy(f.source, f.exe, f.profiles, { extraBytes: 20 * 1024 ** 2 }), /not enough free space/);
  assert.deepEqual(await fs.readdir(f.profiles), []);
});
