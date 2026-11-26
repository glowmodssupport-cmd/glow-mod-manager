const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const windows = process.platform === 'win32';
const samePathKey = (file) => windows ? file.toLowerCase() : file;
const executablePath = (file) => typeof file === 'string' && file.length > 0 &&
  (windows ? /\.exe$/i.test(file) : !/\.exe$/i.test(file));

async function requireExecutable(file) {
  if (!windows) await fs.access(file, constants.X_OK).catch(() => {
    throw Error('Choose a game executable you have permission to run.');
  });
}

async function macBundleExecutable(bundle) {
  const root = await fs.realpath(bundle);
  const contents = path.join(root, 'Contents');
  const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(contents, 'Info.plist')], {
    timeout: 3000, maxBuffer: 8192,
  });
  const name = stdout.trim();
  if (!name || name === '.' || name === '..' || /[\\/:\r\n]/.test(name)) throw Error('The app bundle has no valid executable.');
  const exe = path.join(contents, 'MacOS', name);
  return { exe, root, name: path.basename(root, path.extname(root)) };
}

async function unixProcesses() {
  if (process.platform === 'linux') {
    const pids = (await fs.readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
    const paths = await Promise.all(pids.map((pid) => fs.readlink('/proc/' + pid + '/exe').catch(() => '')));
    return paths.filter((file) => path.isAbsolute(file));
  }
  const { stdout } = await run('/bin/ps', ['-axww', '-o', 'comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.split('\n').map((line) => line.trim()).filter((file) => path.isAbsolute(file));
}

module.exports = { executablePath, requireExecutable, macBundleExecutable, unixProcesses, samePathKey };
