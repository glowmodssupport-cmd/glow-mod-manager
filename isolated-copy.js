const { executablePath, requireExecutable } = require('./game-paths');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const PROFILE_MARKER = '.glow-isolated-profile.json';
const MAX_BYTES = 500 * 1024 ** 3;
const MAX_ENTRIES = 250_000;
const MAX_DEPTH = 48;
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function isIsolatedCopyName(name) {
  return typeof name === 'string' && /^profile-[a-f0-9]{32}$/.test(name);
}

function samePath(left, right) {
  return path.relative(left, right) === '';
}

function isChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return !!relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}

function within(root, candidate) {
  return samePath(root, candidate) || isChild(root, candidate);
}

function absoluteLocal(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) {
    throw Error('Choose a local folder or file for ' + label + '.');
  }
  return path.resolve(value);
}

async function physical(target, kind) {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink() || (kind === 'dir' ? !info.isDirectory() : !info.isFile()) ||
      !samePath(target, await fs.realpath(target))) {
    throw Error('The game or profile contains a redirected or unsupported ' + (kind === 'dir' ? 'folder' : 'file') + ': ' + target);
  }
  return info;
}

async function prepareProfilesRoot(target) {
  // Check the nearest existing directory before creating anything. A junction in any ancestor is refused.
  let ancestor = target;
  while (true) {
    try { await physical(ancestor, 'dir'); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (samePath(ancestor, parent)) throw error;
      ancestor = parent;
    }
  }
  await fs.mkdir(target, { recursive: true });
  await physical(target, 'dir');
}

function validateName(name) {
  if (!name || name.length > 255 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
      /[. ]$/u.test(name) || RESERVED.test(name)) {
    throw Error('Unsupported Windows name in the game folder: ' + name);
  }
}

function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function preflight(source, signal) {
  const directories = [];
  const files = [];
  let bytes = 0;
  let entries = 0;
  async function walk(relative, depth) {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH) throw Error('The game folder exceeds the maximum supported folder depth.');
    const folder = path.join(source, relative);
    const info = await physical(folder, 'dir');
    directories.push({ relative, info });
    const names = new Set();
    const handles = await fs.opendir(folder);
    for await (const entry of handles) {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES) throw Error('The game folder contains too many files or folders for an isolated launch.');
      validateName(entry.name);
      const folded = entry.name.normalize('NFC').toLowerCase();
      if (names.has(folded) || (!relative && folded === PROFILE_MARKER)) {
        throw Error('Ambiguous or reserved name in the game folder: ' + entry.name);
      }
      names.add(folded);
      const child = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(child, depth + 1);
      } else {
        const item = await physical(path.join(source, child), 'file');
        bytes += item.size;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw Error('The game exceeds the 500 GiB isolated copy limit.');
        files.push({ relative: child, info: item });
      }
    }
  }
  await walk('', 0);
  return { directories, files, bytes };
}

async function copyUnchangedFile(source, target, expected, signal) {
  const initial = await physical(source, 'file');
  if (!unchanged(expected, initial)) throw Error('The original game changed while the copy was being prepared. Close its launcher or updater and retry.');
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!unchanged(expected, await handle.stat())) throw Error('An original game file changed before it could be copied.');
    if (expected.size === 0) {
      await fs.writeFile(target, '', { flag: 'wx', mode: expected.mode & 0o777 });
    } else {
      await pipeline(
        handle.createReadStream({ autoClose: false, start: 0, end: expected.size - 1 }),
        createWriteStream(target, { flags: 'wx', mode: expected.mode & 0o777 }),
        { signal },
      );
    }
    const copied = await physical(target, 'file');
    if (copied.size !== expected.size || !unchanged(expected, await handle.stat())) {
      throw Error('An original game file changed during copying.');
    }
  } finally {
    await handle.close();
  }
}

function fingerprintSnapshot({ directories, files }) {
  const hash = createHash('sha256');
  for (const [kind, entries] of [['directory', directories], ['file', files]]) {
    for (const { relative, info } of entries.toSorted((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)) {
      hash.update(JSON.stringify([kind, relative.split(path.sep).join('/'), info.dev, info.ino,
        info.size, info.mtimeMs, info.ctimeMs, info.mode]) + '\n');
    }
  }
  return hash.digest('hex');
}

async function fingerprintIsolatedSource(sourceRoot, signal) {
  const source = absoluteLocal(sourceRoot, 'the original game');
  if (samePath(source, path.parse(source).root)) throw Error('Choose a game folder inside the drive.');
  return fingerprintSnapshot(await preflight(source, signal));
}

async function ownedProfile(profilesRoot, profileRoot) {
  const workspace = absoluteLocal(profilesRoot, 'the profile workspace');
  const profile = absoluteLocal(profileRoot, 'the isolated profile');
  const name = path.basename(profile);
  if (!isChild(workspace, profile) || !samePath(path.dirname(profile), workspace) || !isIsolatedCopyName(name)) {
    throw Error('This location is not a Glow isolated profile.');
  }
  await physical(workspace, 'dir');
  await physical(profile, 'dir');
  const marker = path.join(profile, PROFILE_MARKER);
  if ((await physical(marker, 'file')).size > 16 * 1024) throw Error('The profile ownership marker is invalid.');
  const record = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (!record || record.version !== 1 || record.name !== name) throw Error('The profile ownership marker is invalid.');
  return { root: profile, record };
}

async function readIsolatedCopy(profilesRoot, profileRoot) {
  const { root, record } = await ownedProfile(profilesRoot, profileRoot);
  const source = absoluteLocal(record.source, 'the original game');
  const relative = record.executable;
  if (typeof relative !== 'string' || path.isAbsolute(relative) || !executablePath(relative)) {
    throw Error('The isolated profile has an invalid executable path.');
  }
  for (const segment of relative.split(/[\\/]/u)) validateName(segment);
  const exe = path.join(root, relative);
  if (!isChild(root, exe) || within(root, source) || within(source, root)) {
    throw Error('The isolated profile paths overlap or escape their folders.');
  }
  const complete = record.complete === true;
  const fingerprint = record.fingerprint ?? null;
  const bytes = record.bytes ?? null;
  if (complete && (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES)) {
    throw Error('The completed profile has an invalid fingerprint or file size.');
  }
  if (complete) {
    await physical(exe, 'file');
    await requireExecutable(exe);
  }
  return { root, exe, exeRelative: relative, source, complete, fingerprint, bytes, createdAt: record.createdAt };
}

async function removeIsolatedCopy(profilesRoot, profileRoot) {
  const { root } = await ownedProfile(profilesRoot, profileRoot);
  // Reconfirm the recursive deletion target after reading the marker.
  await physical(root, 'dir');
  await fs.rm(root, { recursive: true, maxRetries: 2 });
}

async function prepareIsolatedCopy(sourceRoot, executable, profilesRoot, options = {}) {
  const source = absoluteLocal(sourceRoot, 'the original game');
  const exe = absoluteLocal(executable, 'the game executable');
  const workspace = absoluteLocal(profilesRoot, 'the profile workspace');
  const { signal, onProgress, extraBytes = 0 } = options;
  signal?.throwIfAborted();
  if (samePath(source, path.parse(source).root) || within(source, workspace) || within(workspace, source)) {
    throw Error('The original game and isolated profiles must use separate folders.');
  }
  if (!isChild(source, exe) || !executablePath(exe)) {
    throw Error('Choose an executable inside the original game folder.');
  }
  if (!Number.isSafeInteger(extraBytes) || extraBytes < 0 || extraBytes > MAX_BYTES) throw Error('Invalid additional profile size.');
  await physical(exe, 'file');
  await requireExecutable(exe);
  const snapshot = await preflight(source, signal);
  const { directories, files, bytes } = snapshot;
  const fingerprint = fingerprintSnapshot(snapshot);
  const relativeExe = path.relative(source, exe);
  if (!files.some((file) => samePath(file.relative, relativeExe))) throw Error('The game executable changed during folder inspection.');
  await prepareProfilesRoot(workspace);
  const space = await fs.statfs(workspace, { bigint: true });
  const headroom = 128 * 1024 ** 2 + (files.length + directories.length) * 4096;
  if (space.bavail * space.bsize < BigInt(bytes + extraBytes + headroom)) {
    throw Error('There is not enough free space for an independent copy of this game and its enabled mods.');
  }

  signal?.throwIfAborted();
  const name = 'profile-' + randomUUID().replaceAll('-', '');
  const root = path.join(workspace, name);
  await fs.mkdir(root, { mode: 0o700 });
  let marked = false;
  try {
    const markerPath = path.join(root, PROFILE_MARKER);
    const marker = { version: 1, name, source, executable: relativeExe, createdAt: new Date().toISOString(),
      fingerprint, bytes, complete: false };
    await fs.writeFile(markerPath, JSON.stringify(marker), { flag: 'wx' });
    marked = true;
    for (const folder of directories) {
      signal?.throwIfAborted();
      if (folder.relative) await fs.mkdir(path.join(root, folder.relative), { mode: 0o700 });
    }
    let bytesCopied = 0;
    let filesCopied = 0;
    let lastProgress = 0;
    const progress = () => {
      lastProgress = Date.now();
      onProgress?.({ phase: 'copying', bytesCopied, totalBytes: bytes, filesCopied, fileCount: files.length });
    };
    for (const file of files) {
      signal?.throwIfAborted();
      if (onProgress && Date.now() - lastProgress >= 250) progress();
      await copyUnchangedFile(path.join(source, file.relative), path.join(root, file.relative), file.info, signal);
      bytesCopied += file.info.size;
      filesCopied++;
    }
    for (const [entries, kind] of [[directories, 'dir'], [files, 'file']]) {
      for (const entry of entries) {
        signal?.throwIfAborted();
        const original = await physical(path.join(source, entry.relative), kind);
        if (!unchanged(entry.info, original)) {
          throw Error('The original game changed during copying. Close its launcher or updater and retry.');
        }
      }
    }
    const copiedExe = path.join(root, relativeExe);
    await physical(copiedExe, 'file');
    const completeMarker = path.join(root, '.glow-' + randomUUID() + '.tmp');
    await fs.writeFile(completeMarker, JSON.stringify({ ...marker, complete: true }), { flag: 'wx' });
    await fs.rename(completeMarker, markerPath);
    progress();
    signal?.throwIfAborted();
    return { root, exe: copiedExe, bytes, fingerprint };
  } catch (error) {
    try {
      if (marked) await removeIsolatedCopy(workspace, root);
      else {
        // Before writing the marker, this freshly created directory can contain at most the incomplete marker.
        const marker = path.join(root, PROFILE_MARKER);
        await physical(root, 'dir');
        try { await fs.unlink(marker); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
        await fs.rmdir(root);
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'The isolated copy failed and its incomplete profile could not be removed.');
    }
    throw error;
  }
}

module.exports = { prepareIsolatedCopy, removeIsolatedCopy, isIsolatedCopyName, fingerprintIsolatedSource, readIsolatedCopy };
