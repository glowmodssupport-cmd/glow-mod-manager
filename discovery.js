const fs = require('node:fs/promises');
const path = require('node:path');
const { executablePath, requireExecutable, macBundleExecutable } = require('./game-paths');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const MAX_METADATA_BYTES = 512 * 1024;
const MAX_LIBRARY_FOLDERS = 16;
const MAX_GAMES_PER_ROOT = 160;
const MAX_GAME_FOLDERS = 320;
const MAX_RESULTS = 72;
const runFile = promisify(execFile);
const sortText = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
const pathKey = (value) => path.resolve(value).toLowerCase();

function localPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 1000 || /[\x00-\x1f<>|?*"]/u.test(value)) return false;
  return process.platform === 'win32' ? /^[A-Za-z]:[/\\]/.test(value) && !value.slice(2).includes(':') : path.isAbsolute(value);
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length > 400) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[\x00-\x1f:<>|?*"]|[. ]$/u.test(part))) return null;
  return parts;
}

async function canonicalItem(candidate, kind) {
  if (!localPath(candidate)) return null;
  try {
    const info = await fs.lstat(candidate);
    if (info.isSymbolicLink() || (kind === 'dir' ? !info.isDirectory() : !info.isFile())) return null;
    const resolved = await fs.realpath(candidate);
    return pathKey(resolved) === pathKey(candidate) ? { resolved, info } : null;
  } catch {
    return null;
  }
}

async function listDirectory(dir, maxEntries) {
  if (!await canonicalItem(dir, 'dir')) return [];
  try {
    const entries = [];
    for await (const entry of await fs.opendir(dir)) {
      if (entries.length === maxEntries) break;
      entries.push(entry);
    }
    return entries.sort((left, right) => sortText(left.name, right.name));
  } catch {
    return [];
  }
}

async function metadata(file) {
  const item = await canonicalItem(file, 'file');
  if (!item || item.info.size > MAX_METADATA_BYTES) return '';
  try {
    const handle = await fs.open(item.resolved, 'r');
    try {
      // A size-limited read also covers metadata rewritten by a running storefront.
      const buf = Buffer.alloc(item.info.size + 1);
      let length = 0;
      while (length < buf.length) {
        const { bytesRead } = await handle.read(buf, length, buf.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return length === buf.length ? '' : buf.toString('utf8', 0, length).replace(/^\uFEFF/u, '');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

// Read quoted scalar pairs from Valve's VDF/ACF metadata. Braced sections and comment lines are ignored.
function valvePairs(source) {
  return [...source.matchAll(/^[\t ]*"([^"\r\n]+)"[\t ]+"((?:\\["\\]|[^"\r\n])*)"/gmu)]
    .map(([, key, value]) => [key.toLowerCase(), value.replace(/\\(["\\])/gu, '$1')]);
}

async function registrySteamPaths(env) {
  if (process.platform !== 'win32') return [];
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (!localPath(systemRoot)) return [];
  const reg = path.join(systemRoot, 'System32', 'reg.exe');
  const locations = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  const paths = await Promise.all(locations.map(async ([key, value]) => {
    try {
      const { stdout } = await runFile(reg, ['query', key, '/v', value], {
        windowsHide: true, timeout: 1800, maxBuffer: 16 * 1024,
      });
      const candidate = stdout.match(/^[\t ]*(?:InstallPath|SteamPath)[\t ]+REG_SZ[\t ]+(.+?)\s*$/imu)?.[1];
      return localPath(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }));
  return paths.filter(Boolean);
}

function distinctPaths(items) {
  const found = new Map();
  for (const item of items) {
    if (localPath(item)) found.set(pathKey(item), path.resolve(item));
  }
  return [...found.values()];
}

async function steamLibraries(installs) {
  const libraries = new Set(installs);
  for (const install of installs) {
    const source = await metadata(path.join(install, 'steamapps', 'libraryfolders.vdf'));
    for (const [key, value] of valvePairs(source)) {
      if (libraries.size >= MAX_LIBRARY_FOLDERS) break;
      // Steam also used top-level numeric keys with a path string in older layouts.
      if ((key === 'path' || /^\d{1,3}$/.test(key)) && localPath(value)) libraries.add(value);
    }
  }
  return distinctPaths([...libraries]).slice(0, MAX_LIBRARY_FOLDERS);
}

async function steamNames(library) {
  const apps = path.join(library, 'steamapps');
  const names = new Map();
  for (const entry of await listDirectory(apps, MAX_GAMES_PER_ROOT * 2)) {
    if (!entry.isFile() || !/^appmanifest_\d+\.acf$/i.test(entry.name)) continue;
    const info = new Map(valvePairs(await metadata(path.join(apps, entry.name))));
    const [directory, ...rest] = safeRelative(info.get('installdir')) || [];
    const name = info.get('name')?.trim();
    if (directory && !rest.length && name && name.length <= 150) names.set(directory.toLowerCase(), name);
  }
  return names;
}

async function epicGames(programData) {
  if (!localPath(programData)) return [];
  const dir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const games = [];
  for (const entry of await listDirectory(dir, MAX_GAMES_PER_ROOT)) {
    if (!entry.isFile() || !/\.item$/i.test(entry.name)) continue;
    try {
      const item = JSON.parse(await metadata(path.join(dir, entry.name)));
      if (item.bIsIncompleteInstall || item.bIsApplication === false || !localPath(item.InstallLocation)) continue;
      const launch = safeRelative(item.LaunchExecutable);
      if (!launch || !/\.exe$/i.test(launch.at(-1))) continue;
      const root = await canonicalItem(item.InstallLocation, 'dir');
      if (!root) continue;
      const exe = await canonicalItem(path.join(root.resolved, ...launch), 'file');
      if (!exe || !exe.info.size) continue;
      const name = typeof item.DisplayName === 'string' && item.DisplayName.trim() && item.DisplayName.length <= 150
        ? item.DisplayName.trim()
        : path.basename(root.resolved);
      games.push({ exe: exe.resolved, name, root: root.resolved, source: 'Epic Games' });
    } catch { /* Ignore stale or partially written storefront metadata. */ }
  }
  return games;
}

const helperName = /(?:unins|uninstall|setup|redist|launcher|launchhelper|update|repair|crash|reporter|benchmark|diagnostic|bootstrap|easyanticheat|battleye|vcredist|directx|steamwebhelper|steamservice|dxsetup)/i;
const supportFolder = /^(?:launcher|social club|_commonredist|redist|tools|support|installers)$/i;

async function gameExecutables(candidate, name, source) {
  const root = await canonicalItem(candidate, 'dir');
  if (!root) return [];
  if (process.platform === 'darwin' && /\.app$/i.test(root.resolved)) {
    try {
      const game = await macBundleExecutable(root.resolved);
      const exe = await canonicalItem(game.exe, 'file');
      if (!exe?.info.size) return [];
      await requireExecutable(exe.resolved);
      return [{ ...game, name, source }];
    } catch { return []; }
  }
  const nested = [
    path.join(root.resolved, 'bin'), path.join(root.resolved, 'bin', 'win64'),
    path.join(root.resolved, 'Binaries', 'Win64'), path.join(root.resolved, 'Binaries', 'Win32'),
  ];
  const rootEntries = await listDirectory(root.resolved, 400);
  for (const entry of rootEntries.filter((found) => found.isDirectory() && !supportFolder.test(found.name)).slice(0, 20)) {
    nested.push(path.join(root.resolved, entry.name, 'Binaries', 'Win64'));
  }
  if (process.platform === 'darwin') {
    const bundles = rootEntries.filter((entry) => entry.isDirectory() && /\.app$/i.test(entry.name)).slice(0, 3);
    if (bundles.length) {
      return (await Promise.all(bundles.map((entry) => gameExecutables(path.join(root.resolved, entry.name), name, source)))).flat();
    }
  }
  const hits = [];
  const baseName = name.toLowerCase().replace(/\W/gu, '');
  for (const [dir, entries] of [[root.resolved, rootEntries], ...await Promise.all(nested.map(async (directory) =>
    [directory, await listDirectory(directory, 250)]))]) {
    for (const entry of entries) {
      if (!entry.isFile() || !executablePath(entry.name) || helperName.test(entry.name)) continue;
      const stem = entry.name.replace(/\.exe$/i, '').toLowerCase().replace(/\W/gu, '');
      const rank = stem === baseName ? 0 : /-shipping\.exe$/i.test(entry.name) ? 1 : dir === root.resolved ? 2 : 3;
      hits.push({ location: path.join(dir, entry.name), rank });
    }
  }
  hits.sort((a, b) => a.rank - b.rank || sortText(a.location, b.location));
  const valid = [];
  for (const hit of hits.slice(0, 12)) {
    const exe = await canonicalItem(hit.location, 'file');
    if (exe?.info.size) {
      try {
        await requireExecutable(exe.resolved);
        valid.push(exe.resolved);
      } catch { continue; }
    }
    if (valid.length === 3) break;
  }
  return valid.map((exe) => ({
    exe, name: valid.length > 1 ? name + ' — ' + path.basename(exe) : name, root: root.resolved, source,
  }));
}

async function libraryGames(dir, source, names = new Map(), budget) {
  const games = [];
  for (const entry of await listDirectory(dir, MAX_GAMES_PER_ROOT)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || supportFolder.test(entry.name)) continue;
    if (budget.remaining === 0) break;
    budget.remaining--;
    const name = names.get(entry.name.toLowerCase()) || entry.name;
    games.push(...await gameExecutables(path.join(dir, entry.name), name, source));
    if (games.length >= MAX_RESULTS) break;
  }
  return games;
}

/** Find local executable candidates. Discovery only reads metadata, and it never launches an executable. */
async function detectGames({ env = process.env, getSteamPaths = registrySteamPaths, searchDefaults = true } = {}) {
  const drive = /^[A-Z]:$/i.test(env.SystemDrive || '') ? env.SystemDrive : 'C:';
  const programDirs = distinctPaths([
    env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'],
    ...(searchDefaults && process.platform === 'win32' ? [drive + '/Program Files', drive + '/Program Files (x86)'] : []),
  ]);
  let registered = [];
  try { registered = await getSteamPaths(env); } catch { /* A registry error does not disable folder discovery. */ }
  const home = env.HOME || env.USERPROFILE;
  const nativeSteam = !searchDefaults || !home ? [] : (
    process.platform === 'darwin' ? ['Library/Application Support/Steam'] :
      process.platform === 'linux' ? ['.local/share/Steam', '.steam/steam', '.var/app/com.valvesoftware.Steam/.local/share/Steam'] : []
  ).map((folder) => path.join(home, folder));
  const installs = distinctPaths([...registered, ...programDirs.map((dir) => path.join(dir, 'Steam')), ...nativeSteam]).slice(0, MAX_LIBRARY_FOLDERS);
  const libraries = await steamLibraries(installs);
  const explicit = await epicGames(env.ProgramData || env.ALLUSERSPROFILE || (searchDefaults ? drive + '/ProgramData' : ''));
  const known = new Map(explicit.map((game) => [pathKey(game.exe), game]));
  const sources = [
    ...libraries.map((library) => ({ dir: path.join(library, 'steamapps', 'common'), source: 'Steam', library })),
    ...programDirs.flatMap((dir) => [
      { dir: path.join(dir, 'Rockstar Games'), source: 'Rockstar Games' },
      { dir: path.join(dir, 'Epic Games'), source: 'Epic Games' },
    ]),
    ...(searchDefaults && process.platform === 'win32' ? [{ dir: drive + '/Games', source: 'Local games' }] : []),
    ...(searchDefaults && home && process.platform !== 'win32' ? [{ dir: path.join(home, 'Games'), source: 'Local games' }] : []),
  ];
  const budget = { remaining: MAX_GAME_FOLDERS };
  for (const { dir, source, library } of sources) {
    const names = library ? await steamNames(library) : undefined;
    for (const game of await libraryGames(dir, source, names, budget)) {
      if (!known.has(pathKey(game.exe))) known.set(pathKey(game.exe), game);
    }
    if (known.size >= MAX_RESULTS || budget.remaining === 0) break;
  }
  return [...known.values()].sort((a, b) => sortText(a.name, b.name) || sortText(a.exe, b.exe)).slice(0, MAX_RESULTS);
}

module.exports = { detectGames };
