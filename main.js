const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { Library } = require('./library');
const { detectGames } = require('./discovery');
const { createUpdates, httpsUrl, validWindowsFeed } = require('./updates');
const { macBundleExecutable, unixProcesses, samePathKey } = require('./game-paths');

const release = require('./package.json').glowRelease ?? {};
const windows = process.platform === 'win32';
const catalog = release.modsUrl || (!app.isPackaged ? process.env.GLOW_MODS_URL : '');
const modsUrl = catalog ? httpsUrl(catalog, 'Mods URL') : null;
let updates;


const page = path.join(__dirname, 'index.html');
const pageUrl = pathToFileURL(page).href;
let mainWindow;
let library;
let runningGame;
let preparing;
let progress = null;
let quitAfterPreparation = false;
let queue = Promise.resolve();
const discovered = new Map();

function expose(name, handler, serial = true) {
  ipcMain.handle('glow:' + name, (event, ...args) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame?.parent || event.senderFrame?.url !== pageUrl) {
      throw Error('This command is only available in Glow Mod Manager.');
    }
    if (!serial) return handler(...args);
    const result = queue.then(() => handler(...args));
    queue = result.catch(() => {});
    return result;
  });
}

function sessionState() {
  return { running: preparing ? 'preparing' : runningGame?.mode ?? null, progress };
}

async function currentState() {
  return { ...await library.state(), ...sessionState() };
}

function initializeUpdates() {
  let updater = null;
  if (app.isPackaged && release.updateUrl && (process.platform !== 'linux' || process.env.APPIMAGE)) {
    let trusted = !windows;
    if (windows && release.publisher) {
      try {
        const config = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
        trusted = validWindowsFeed(config, release);
      } catch (error) { console.error('Cannot read the Windows update configuration:', error.code); }
    }
    if (trusted) {
      updater = require('electron-updater').autoUpdater;
      updater.setFeedURL({ provider: 'generic', url: httpsUrl(release.updateUrl, 'Update feed') });
      if (windows) updater.disableDifferentialDownload = true;
    }
  }
  return createUpdates(updater, (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('glow:update-state', state);
  });
}

async function assertStopped(exe) {
  if (!exe) return;
  if (!windows) {
    if ((await unixProcesses()).includes(exe)) throw Error('Close the game first. Its executable is still running.');
    return;
  }
  const name = path.basename(exe);
  const tasklist = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/tasklist.exe');
  const { stdout } = await promisify(execFile)(tasklist, ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'],
    { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
  if (stdout.split(/\r?\n/).some((line) => line.toLowerCase().startsWith('"' + name.toLowerCase() + '",'))) {
    throw Error('Close the game first. Windows reports an executable with that name is still running.');
  }
}

async function gameClosed() {
  if (runningGame || preparing) throw Error('Wait for the current launch to finish or close the game first.');
  const game = await library.game();
  await assertStopped(game?.exe);
}

async function checkProfileProcesses(profiles) {
  if (!profiles.length) return;
  let processes;
  if (windows) {
    const powerShell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(powerShell, [
      '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Property ExecutablePath | ForEach-Object { $_.ExecutablePath }',
    ], { windowsHide: true, timeout: 12_000, maxBuffer: 1024 * 1024 });
    processes = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => path.isAbsolute(line));
  } else {
    processes = await unixProcesses();
  }
  for (const processPath of processes) {
    if (profiles.some(({ root }) => {
      const relative = path.relative(root, processPath);
      return !!relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
    })) throw Error('A process is still running from a managed game copy. Close it before clearing the copies.');
  }
  if (windows) for (const { exeRelative } of profiles) if (exeRelative) await assertStopped(exeRelative);
}

async function launch(mode) {
  if (updates.state().phase === 'installing') throw Error('Wait for Glow to finish updating.');
  await gameClosed();
  let target;
  let started = false;
  const control = mode === 'modded' ? new AbortController() : null;
  if (control) {
    preparing = control;
    progress = { label: 'Checking game files…', done: 0, total: 0 };
  }
  try {
    target = control
      ? await library.prepareGame({
          signal: control.signal,
          onProgress: ({ bytesCopied, totalBytes }) => {
            progress = { label: 'Preparing the isolated game copy…', done: bytesCopied, total: totalBytes };
          },
        })
      : await library.originalGame();
    await assertStopped(target.exe);
    control?.signal.throwIfAborted();
    const child = spawn(target.exe, [], { cwd: path.dirname(target.exe), shell: false, stdio: 'ignore', windowsHide: false });
    runningGame = { child, mode };
    const clear = () => { if (runningGame?.child === child) runningGame = null; };
    child.once('exit', clear);
    await new Promise((resolve, reject) => {
      child.once('error', (error) => { clear(); reject(error); });
      child.once('spawn', () => { started = true; resolve(); });
    });
  } catch (error) {
    if (control && target && !started) await library.discardProfile(target);
    throw error;
  } finally {
    if (control) {
      preparing = null;
      progress = null;
      if (quitAfterPreparation) setImmediate(() => app.quit());
    }
  }
  return currentState();
}

function registerActions() {
  expose('state', currentState, false);
  expose('sessionState', sessionState, false);
  expose('releaseFeatures', () => ({ updates: updates.state().phase !== 'unconfigured', mods: !!modsUrl }), false);
  expose('checkUpdate', updates.check, false);
  expose('downloadUpdate', updates.download, false);
  expose('installUpdate', async () => { await gameClosed(); return updates.install(); });
  expose('openMods', () => { if (modsUrl) return shell.openExternal(modsUrl); }, false);
  expose('detect', async () => {
    const results = await detectGames();
    discovered.clear();
    for (const game of results) discovered.set(samePathKey(game.exe), { root: game.root, name: game.name });
    return results;
  });
  expose('browse', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the game executable',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: windows ? [{ name: 'Windows executable', extensions: ['exe'] }] : [],
    });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    if (process.platform !== 'darwin' || !/\.app$/i.test(selected)) return selected;
    const game = await macBundleExecutable(selected);
    discovered.set(samePathKey(game.exe), game);
    return game.exe;
  });
  expose('selectGame', async (exe) => {
    await gameClosed();
    await library.selectGame(exe, typeof exe === 'string' ? discovered.get(samePathKey(exe)) : undefined);
    return currentState();
  });
  expose('setModsFolder', async (relative) => { await gameClosed(); await library.setModsFolder(relative); return currentState(); });
  expose('restoreOriginal', async () => {
    await gameClosed();
    const game = await library.game();
    if (game) await checkProfileProcesses([{ root: game.root }]);
    await library.restoreOriginal();
    return currentState();
  });
  expose('clearProfiles', async () => {
    await gameClosed();
    const profiles = await library.profiles();
    await checkProfileProcesses(profiles);
    await library.clearProfiles(profiles);
    return currentState();
  });
  expose('chooseImport', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Glow Mods ZIP packages', properties: ['openFile', 'multiSelections'], filters: [{ name: 'ZIP mod packages', extensions: ['zip'] }],
    });
    return result.canceled ? currentState() : importPaths(result.filePaths);
  });
  expose('importPaths', importPaths);
  expose('toggle', async (id, enabled) => { await gameClosed(); await library.toggle(id, enabled); return currentState(); });
  expose('remove', async (id) => { await gameClosed(); await library.remove(id); return currentState(); });
  expose('openFolder', async () => {
    const error = await shell.openPath(library.packages);
    if (error) throw Error(error);
  });
  expose('launch', () => launch('modded'));
  expose('launchVanilla', () => launch('vanilla'));
  expose('cancelLaunch', () => { preparing?.abort(new Error('Preparing the game copy was cancelled.')); }, false);
}

async function importPaths(files) {
  if (!Array.isArray(files) || !files.length || files.length > 12) throw Error('Import up to 12 ZIP packages at a time.');
  const importErrors = [];
  for (const file of files) {
    try { await library.importZip(file); }
    catch (error) {
      const label = typeof file === 'string' ? path.basename(file) : 'Invalid file';
      importErrors.push({ name: label, message: error.message });
    }
  }
  if (importErrors.length === files.length) throw Error(importErrors.map((e) => e.name + ': ' + e.message).join('\n'));
  return { ...await currentState(), importErrors };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    const profileBase = !app.commandLine.hasSwitch('user-data-dir') && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'GlowModManager', 'game-profiles')
      : undefined;
    library = new Library(app.getPath('userData'), { profilesRoot: profileBase });
    await library.init();
    updates = initializeUpdates();
    registerActions();
    mainWindow = new BrowserWindow({
      title: 'Glow Mod Manager', icon: path.join(__dirname, 'build', 'icon.png'),
      width: 1180, height: 800, minWidth: 840, minHeight: 580,
      autoHideMenuBar: true, backgroundColor: '#101024', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadFile(page);
  }).catch((error) => {
    dialog.showErrorBox('Glow Mod Manager could not start', error.message);
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (!preparing) return;
    event.preventDefault();
    quitAfterPreparation = true;
    preparing.abort(new Error('Preparing the game copy was cancelled.'));
  });
  app.on('window-all-closed', () => app.quit());
}
