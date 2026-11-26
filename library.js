const { executablePath, requireExecutable } = require('./game-paths');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants, createReadStream, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { prepareIsolatedCopy, removeIsolatedCopy, isIsolatedCopyName, fingerprintIsolatedSource, readIsolatedCopy } = require('./isolated-copy');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const marker = '.glow-manager.json';
const categories = ['Gameplay', 'Visuals', 'Vehicles', 'Audio', 'Tools', 'Other'];
const dataTypes = new Set(['.cfg', '.csv', '.dds', '.ini', '.jpeg', '.jpg', '.json', '.ogg', '.png', '.txt', '.wav', '.webp', '.xml']);
const MIB = 1024 * 1024;
const maxBytes = 256 * MIB;
const safeId = /^[a-f0-9]{64}$/;

function parts(value) {
  if (typeof value !== 'string' || value.length > 190) throw Error('Use a short folder path relative to the game.');
  const names = value.replaceAll('\\', '/').split('/');
  if (names.some((n) => !/^[\p{L}\p{N}_. -]{1,90}$/u.test(n) || /^[. ]|[. ]$/.test(n) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n))) throw Error('That path is unsupported.');
  return names;
}

function isChild(root, file) {
  const relative = path.relative(root, file);
  return !!relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}

async function stat(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function normal(file, kind) {
  const info = await stat(file);
  if (!info || (kind === 'dir' ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() ||
      path.relative(file, await fs.realpath(file)) !== '') throw Error('A required file or folder is missing or redirected.');
  return info;
}

async function folderUnder(root, relative, create) {
  await normal(root, 'dir');
  let current = root;
  for (const name of parts(relative)) {
    current = path.join(current, name);
    if (create) {
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await normal(current, 'dir');
  }
  return current;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(file) {
  const info = await normal(file, 'file');
  if (info.size > 512 * 1024) throw Error('Package metadata is too large.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function removeOwned(root, directory) {
  if (!isChild(root, directory) || path.dirname(directory) !== root) throw Error('Could not verify the cleanup location.');
  await normal(directory, 'dir');
  await fs.rm(directory, { recursive: true, maxRetries: 2 });
}

async function unpack(zip, temporary) {
  let manifest;
  let count = 0;
  let total = 0;
  const files = [];
  const used = new Set();
  const pool = path.join(temporary, 'files');
  await fs.mkdir(pool);
  const reader = await yauzl.openPromise(zip, { strictFileNames: true });
  try {
    for await (const entry of reader.eachEntry()) {
      if (++count > 1500) throw Error('This ZIP contains more than 1,500 entries.');
      if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw Error('Linked files are unsupported.');
      const name = entry.fileName;
      if (name.endsWith('/')) {
        parts(name.slice(0, -1));
        continue;
      }
      const size = entry.uncompressedSize;
      total += size;
      if (!Number.isSafeInteger(size) || total > maxBytes) throw Error('This package expands beyond 256 MB.');
      if (name === 'glow-mod.json') {
        if (size > 64 * 1024) throw Error('The package manifest is too large.');
        if (manifest) throw Error('The package has more than one manifest.');
        const metadata = path.join(temporary, 'source.json');
        await pipeline(await reader.openReadStreamPromise(entry), createWriteStream(metadata, { flags: 'wx' }));
        manifest = await readJson(metadata);
        await fs.unlink(metadata);
        continue;
      }
      if (!name.startsWith('files/')) throw Error('Place package data inside the files folder.');
      const relative = parts(name.slice('files/'.length)).join('/');
      if (!dataTypes.has(path.extname(relative).toLowerCase())) throw Error('Unsupported package file type: ' + relative);
      const key = relative.toLowerCase();
      if (used.has(key)) throw Error('Two package files use the same path.');
      used.add(key);
      const dest = path.join(pool, relative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(await reader.openReadStreamPromise(entry), createWriteStream(dest, { flags: 'wx' }));
      files.push({ relative, sha256: await hashFile(dest) });
    }
  } finally { reader.close(); }
  if (manifest?.format !== 'glow-mod-v1' || typeof manifest.name !== 'string' ||
      !manifest.name.trim() || manifest.name.length > 80 || !categories.includes(manifest.category) || !files.length) {
    throw Error('Add a valid glow-mod.json manifest and at least one supported data file.');
  }
  return { name: manifest.name.trim(), category: manifest.category, files };
}

class Library {
  constructor(folder, { profilesRoot } = {}) {
    this.folder = folder;
    this.packages = path.join(folder, 'library');
    this.settingsPath = path.join(folder, 'game.json');
    this.choicesPath = path.join(folder, 'selections.json');
    this.profilesRoot = profilesRoot ?? path.join(folder, 'game-profiles');
    this.profilesIndex = path.join(folder, 'game-profiles.json');
  }

  async init() {
    await fs.mkdir(this.folder, { recursive: true });
    await fs.mkdir(this.packages, { recursive: true });
    await normal(this.packages, 'dir');
    await fs.mkdir(this.profilesRoot, { recursive: true });
    await normal(this.profilesRoot, 'dir');
  }

  async game() {
    if (!await stat(this.settingsPath)) return null;
    const saved = await readJson(this.settingsPath);
    if (!saved || typeof saved.exe !== 'string' || !path.isAbsolute(saved.exe) ||
        !executablePath(saved.exe) || typeof saved.name !== 'string') {
      throw Error('Game settings are invalid. Restore the saved game settings before continuing.');
    }
    const root = saved.root ?? path.dirname(saved.exe);
    if (typeof root !== 'string' || !path.isAbsolute(root) || !isChild(root, saved.exe) ||
        path.relative(root, path.parse(root).root) === '' || [this.folder, this.profilesRoot].some((owned) => path.relative(root, owned) === '' || isChild(root, owned) || isChild(owned, root))) {
      throw Error('Game settings point outside the installation or overlap the private library.');
    }
    return { exe: saved.exe, name: saved.name, root, modsFolder: parts(saved.modsFolder || 'mods').join('/') };
  }

  async saveJson(file, value) {
    const staged = path.join(this.folder, '.settings-' + randomUUID() + '.tmp');
    await fs.writeFile(staged, JSON.stringify(value), { flag: 'wx' });
    try { await fs.rename(staged, file); } finally { if (await stat(staged)) await fs.unlink(staged); }
  }

  async selections() {
    const value = (await stat(this.choicesPath)) ? await readJson(this.choicesPath) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, ids]) =>
      !safeId.test(key) || !Array.isArray(ids) || ids.length > 256 || ids.some((id) => typeof id !== 'string' || !safeId.test(id)))) {
      throw Error('Saved mod selections are invalid.');
    }
    return value;
  }

  gameKey(game) {
    return createHash('sha256').update(process.platform === 'win32' ? path.normalize(game.exe).toLowerCase() : game.exe).digest('hex');
  }

  async selected(game) {
    return new Set(game ? (await this.selections())[this.gameKey(game)] ?? [] : []);
  }

  async mod(id) {
    if (typeof id !== 'string' || !safeId.test(id)) throw Error('Choose a mod from your library.');
    const root = path.join(this.packages, id);
    await normal(root, 'dir');
    const record = await readJson(path.join(root, 'package.json'));
    if (record.id !== id || typeof record.name !== 'string' || !categories.includes(record.category) ||
        !Array.isArray(record.files) || !record.files.length || record.files.length > 1500 ||
        record.files.some((file) => !safeId.test(file?.sha256) ||
          !dataTypes.has(path.extname(parts(file.relative).join('/')).toLowerCase()))) throw Error('The library entry is damaged.');
    return { root, record };
  }

  async legacyTargets(game) {
    if (!game) return [];
    let current = game.root;
    await normal(current, 'dir');
    for (const name of parts(game.modsFolder)) {
      current = path.join(current, name);
      if (!await stat(current)) return [];
      await normal(current, 'dir');
    }
    return (await fs.readdir(current)).filter((name) => /^glow-[a-f0-9]{64}$/i.test(name))
      .map((name) => ({ id: name.slice(5).toLowerCase(), target: path.join(current, name) }));
  }

  async profiles() {
    const records = (await stat(this.profilesIndex)) ? await readJson(this.profilesIndex) : {};
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw Error('Game copy history is invalid.');
    const entries = await fs.readdir(this.profilesRoot, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
      if (!isIsolatedCopyName(entry.name)) continue;
      const root = path.join(this.profilesRoot, entry.name);
      const record = records[entry.name];
      let exeRelative = '';
      try {
        const marker = await readIsolatedCopy(this.profilesRoot, root);
        exeRelative = marker.exeRelative;
      } catch { /* Clear copies still verifies ownership before removing anything. */ }
      profiles.push({ root, exeRelative, signature: typeof record?.signature === 'string' ? record.signature : '' });
    }
    return profiles;
  }

  async state() {
    const game = await this.game();
    let gameUnavailable = false;
    let legacyEnabled = 0;
    if (game) {
      try { await normal(game.exe, 'file'); legacyEnabled = (await this.legacyTargets(game)).length; }
      catch { gameUnavailable = true; }
    }
    const chosen = await this.selected(game);
    const mods = [];
    let unreadable = 0;
    const entries = (await fs.readdir(this.packages, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeId.test(entry.name));
    for (let offset = 0; offset < entries.length; offset += 24) {
      const records = await Promise.all(entries.slice(offset, offset + 24)
        .map((entry) => this.mod(entry.name).catch(() => null)));
      for (const item of records) {
        if (!item) { unreadable++; continue; }
        const { record } = item;
        mods.push({ id: record.id, name: record.name, category: record.category,
          files: record.files.map((file) => file.relative), enabled: chosen.has(record.id) });
      }
    }
    mods.sort((a, b) => a.name.localeCompare(b.name));
    const profiles = await this.profiles();
    const available = [];
    for (const record of profiles) {
      const entry = await stat(record.root);
      if (entry?.isDirectory() && !entry.isSymbolicLink()) available.push({ ...record, created: entry.birthtimeMs });
    }
    available.sort((a, b) => b.created - a.created);
    return { game, mods, folder: this.packages, gameUnavailable, legacyEnabled, unreadable,
      profilePath: available[0]?.root ?? '', profiles: profiles.length };
  }

  async selectGame(exe, hint) {
    const rootHint = hint?.root;
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || !executablePath(exe)) {
      throw Error('Choose a game executable for this operating system.');
    }
    await normal(exe, 'file');
    await requireExecutable(exe);
    exe = await fs.realpath(exe);
    const current = await this.game();
    if (current?.exe === exe && (!rootHint || path.relative(current.root, rootHint) === '')) return;
    if (current && await stat(current.root) && (await this.legacyTargets(current)).length) throw Error('Restore files deployed by the previous Glow version before changing your game.');
    let root = rootHint ?? path.dirname(exe);
    if (!rootHint) {
      const leaf = path.basename(root).toLowerCase();
      const parent = path.basename(path.dirname(root)).toLowerCase();
      const grandparent = path.dirname(path.dirname(root));
      if (process.platform === 'darwin' && leaf === 'macos' && parent === 'contents' && /\.app$/i.test(grandparent)) root = grandparent;
      if (['win64', 'win32', 'x64'].includes(leaf) && ['binaries', 'bin'].includes(parent)) root = path.dirname(path.dirname(root));
    }
    await normal(root, 'dir');
    if (!isChild(root, exe) || path.relative(root, path.parse(root).root) === '' || [this.folder, this.profilesRoot].some((owned) => path.relative(root, owned) === '' || isChild(root, owned) || isChild(owned, root))) {
      throw Error('Choose a game installation outside the Glow Mod Manager folders.');
    }
    await this.saveJson(this.settingsPath, {
      exe, root, name: hint?.name || path.basename(exe, path.extname(exe)), modsFolder: current?.exe === exe ? current.modsFolder : 'mods',
    });
  }

  async setModsFolder(relative) {
    const game = await this.game();
    if (!game) throw Error('Select a game first.');
    const normalized = parts(relative || 'mods').join('/');
    if (/^glow-|^\.glow-/i.test(normalized.split('/')[0])) throw Error('Choose the game’s normal mods folder.');
    if (normalized === game.modsFolder) return;
    if ((await this.legacyTargets(game)).length) throw Error('Restore files deployed by the previous Glow version before changing the mods folder.');
    const updated = { ...game, modsFolder: normalized };
    await this.legacyTargets(updated); // refuses redirected folders before saving
    await this.saveJson(this.settingsPath, updated);
  }

  async importZip(archive) {
    if (typeof archive !== 'string' || !path.isAbsolute(archive) || path.extname(archive).toLowerCase() !== '.zip') throw Error('Choose a Glow Mods ZIP package.');
    const info = await normal(archive, 'file');
    if (info.size > maxBytes || !info.size) throw Error('Choose a ZIP between 1 byte and 256 MB.');
    const storage = await fs.statfs(this.packages);
    if (storage.bavail * storage.bsize < info.size + 2 * maxBytes) throw Error('Free some disk space before importing this package.');
    const existing = await fs.readdir(this.packages);
    if (existing.filter((name) => safeId.test(name)).length >= 500) throw Error('Remove an unused mod before importing more than 500 packages.');
    const temporary = await fs.mkdtemp(path.join(this.packages, '.import-'));
    try {
      const input = path.join(temporary, 'package.zip');
      await fs.copyFile(archive, input);
      if ((await stat(input)).size !== info.size) throw Error('The ZIP changed during import.');
      const id = await hashFile(input);
      const target = path.join(this.packages, id);
      if (await stat(target)) throw Error('That ZIP is already in your library.');
      const infoFromZip = await unpack(input, temporary);
      await fs.unlink(input);
      await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify({ id, ...infoFromZip }), { flag: 'wx' });
      await fs.rename(temporary, target);
    } finally { if (await stat(temporary)) await removeOwned(this.packages, temporary); }
  }

  async toggle(id, enabled) {
    if (typeof enabled !== 'boolean') throw Error('Choose Enable or Disable.');
    await this.mod(id);
    const game = await this.game();
    if (!game) throw Error('Select a game first.');
    const values = await this.selections();
    const key = this.gameKey(game);
    const current = new Set(values[key] ?? []);
    if (enabled) current.add(id); else current.delete(id);
    if (current.size > 256) throw Error('Select up to 256 mods per game.');
    values[key] = [...current];
    await this.saveJson(this.choicesPath, values);
  }

  async originalGame() {
    const game = await this.game();
    if (!game) throw Error('Select a game executable first.');
    await normal(game.exe, 'file');
    await requireExecutable(game.exe);
    if ((await this.legacyTargets(game)).length) {
      throw Error('Restore files deployed by the previous Glow version first.');
    }
    return game;
  }

  async prepareGame(options) {
    const game = await this.originalGame();
    const selection = await this.selected(game);
    if (!selection.size) throw Error('Enable a mod before launching a modded game.');
    const packages = [];
    const paths = new Map();
    let extraBytes = 0;
    for (const id of selection) {
      const entry = await this.mod(id);
      for (const file of entry.record.files) {
        const relative = parts(file.relative).join('/');
        const source = path.join(entry.root, 'files', relative);
        const info = await normal(source, 'file');
        extraBytes += info.size;
        const key = relative.toLowerCase();
        const previous = paths.get(key);
        if (previous && previous.sha256 !== file.sha256 && !/(^|\/)(readme|license)[^.]*\.txt$/i.test(key)) {
          throw Error('Both ' + previous.name + ' and ' + entry.record.name + ' change ' + relative + '. Turn one off before launching.');
        }
        paths.set(key, { name: entry.record.name, sha256: file.sha256 });
      }
      packages.push(entry);
    }
    const profiles = await this.profiles();
    const sourceKey = await fingerprintIsolatedSource(game.root, options?.signal);
    const signatureFor = (source) => createHash('sha256').update(JSON.stringify([
      this.gameKey(game), game.modsFolder, [...selection].sort(), source,
    ])).digest('hex');
    const signature = signatureFor(sourceKey);
    for (const profile of profiles) {
      if (profile.signature !== signature || !profile.exeRelative) continue;
      try {
        const exe = path.join(profile.root, profile.exeRelative);
        if (!isChild(profile.root, exe)) continue;
        await normal(exe, 'file');
        if (await hashFile(exe) !== await hashFile(game.exe)) continue;
        const deploy = await folderUnder(profile.root, game.modsFolder, false);
        const expected = new Set([...selection].map((id) => 'glow-' + id));
        const deployed = (await fs.readdir(deploy)).filter((name) => /^glow-[a-f0-9]{64}$/i.test(name));
        if (deployed.some((name) => !expected.has(name.toLowerCase()))) continue;
        for (const id of selection) await this.verifyLegacy(path.join(deploy, 'glow-' + id), id);
        options?.signal?.throwIfAborted();
        return { root: profile.root, exe, reused: true };
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        // Keep altered copies intact. Build a new copy from the original if another slot is available.
      }
    }
    if (profiles.length >= 2) throw Error('Two game copies are saved. Open Safety & settings to review and clear old copies.');
    const profile = await prepareIsolatedCopy(game.root, game.exe, this.profilesRoot, { ...options, extraBytes });
    try {
      const deploy = await folderUnder(profile.root, game.modsFolder, true);
      for (const entry of packages) {
        options?.signal?.throwIfAborted();
        const target = path.join(deploy, 'glow-' + entry.record.id);
        await fs.mkdir(target);
        for (const file of entry.record.files) {
          options?.signal?.throwIfAborted();
          const relative = parts(file.relative).join('/');
          const from = path.join(entry.root, 'files', relative);
          const to = path.join(target, relative);
          await normal(from, 'file');
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(from, to, constants.COPYFILE_EXCL);
          if (await hashFile(to) !== file.sha256) throw Error('An imported mod changed. Import a fresh copy.');
        }
        await fs.writeFile(path.join(target, marker), JSON.stringify({ id: entry.record.id }), { flag: 'wx' });
      }
      options?.signal?.throwIfAborted();
      const current = Object.fromEntries(profiles.filter((item) => item.signature)
        .map((item) => [path.basename(item.root), { signature: item.signature }]));
      current[path.basename(profile.root)] = { signature: signatureFor(profile.fingerprint) };
      await this.saveJson(this.profilesIndex, current);
      return profile;
    } catch (error) {
      await removeIsolatedCopy(this.profilesRoot, profile.root);
      throw error;
    }
  }

  async verifyLegacy(target, id) {
    const { record } = await this.mod(id);
    await normal(target, 'dir');
    if ((await readJson(path.join(target, marker))).id !== id) throw Error('A legacy folder is missing its Glow ownership marker.');
    const files = new Map(record.files.map(({ relative, sha256 }) => [parts(relative).join('/'), sha256]));
    const directories = new Set();
    for (const relative of files.keys()) {
      const names = relative.split('/');
      for (let i = 1; i < names.length; i++) directories.add(names.slice(0, i).join('/'));
    }
    const walk = async (folder, prefix = '') => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory() && directories.delete(relative)) {
          await normal(file, 'dir');
          await walk(file, relative + '/');
        } else if (relative !== marker) {
          const match = files.get(relative);
          if (!match) throw Error('A legacy mod folder contains extra or renamed files. Save your changes before restoring.');
          await normal(file, 'file');
          if (await hashFile(file) !== match) throw Error('A legacy mod file changed. Save your changes before restoring.');
          files.delete(relative);
        }
      }
    };
    await walk(target);
    if (files.size || directories.size) throw Error('A legacy mod folder is incomplete; it was left in place.');
  }

  async restoreOriginal() {
    const game = await this.game();
    if (!game) throw Error('Select the game containing the old deployment.');
    const targets = await this.legacyTargets(game);
    if (!targets.length) return;
    for (const { id, target } of targets) await this.verifyLegacy(target, id);
    // Retain the same selections for the new isolated profile. Move the exact old copies as a group before cleaning up.
    const values = await this.selections();
    const key = this.gameKey(game);
    values[key] = [...new Set([...(values[key] ?? []), ...targets.map(({ id }) => id)])];
    if (values[key].length > 256) throw Error('Deselect some mods before restoring the old deployment.');
    const retired = await fs.mkdtemp(path.join(game.root, '.glow-restore-'));
    const moved = [];
    try {
      for (const { id, target } of targets) {
        const backup = path.join(retired, 'glow-' + id);
        await fs.rename(target, backup);
        moved.push({ target, backup });
      }
      for (const { backup } of moved) await this.verifyLegacy(backup, path.basename(backup).slice(5));
      await this.saveJson(this.choicesPath, values);
    } catch (error) {
      try {
        for (const { target, backup } of moved.reverse()) await fs.rename(backup, target);
      } catch {
        throw Error('Legacy restoration was interrupted. The remaining files are preserved in ' + retired);
      }
      await removeOwned(game.root, retired);
      throw error;
    }
    await removeOwned(game.root, retired);
  }

  async discardProfile(profile) {
    if (profile.reused) return;
    await removeIsolatedCopy(this.profilesRoot, profile.root);
    if (await stat(this.profilesIndex)) {
      const current = await readJson(this.profilesIndex);
      delete current[path.basename(profile.root)];
      await this.saveJson(this.profilesIndex, current);
    }
  }

  async clearProfiles(profiles) {
    for (const { root } of profiles) await removeIsolatedCopy(this.profilesRoot, root);
    await this.saveJson(this.profilesIndex, {});
  }

  async remove(id) {
    const { root } = await this.mod(id);
    const game = await this.game();
    if (game && await stat(game.root) && (await this.legacyTargets(game)).some((entry) => entry.id === id)) {
      throw Error('Restore the previous deployment before removing this mod.');
    }
    const choices = await this.selections();
    for (const key of Object.keys(choices)) choices[key] = choices[key].filter((entry) => entry !== id);
    await this.saveJson(this.choicesPath, choices);
    await removeOwned(this.packages, root);
  }
}

module.exports = { Library, normal };
