// Windows integration rehearsal. All data belongs to a disposable fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

async function eventually(check) {
  let err;
  for (let i = 0; i < 100; i++) {
    try { const value = await check(); if (value) return value; } catch (error) { err = error; }
    await wait(125);
  }
  throw err || Error('Desktop operation timed out.');
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map();
  let next = 0;
  ws.onmessage = ({ data }) => {
    const packet = JSON.parse(data);
    const handler = pending.get(packet.id);
    if (handler) { pending.delete(packet.id); handler(packet); }
  };
  return {
    ws,
    run(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out.')); }, 7000);
        pending.set(id, ({ result, error }) => {
          clearTimeout(timer);
          if (error) reject(Error(error.message)); else resolve(result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

(async () => {
  const parent = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(parent, 'glow-manager-smoke-'));
  assert.equal(path.dirname(fixture), parent);
  const profile = path.join(fixture, 'profile');
  fs.mkdirSync(profile);
  const appRoot = path.join(__dirname, '..');
  const binary = process.argv[2] || require('electron');
  const game = path.join(fixture, 'game');
  fs.mkdirSync(game);
  const cs = path.join(game, 'Example.cs');
  fs.writeFileSync(cs, 'class Example { static void Main() { System.IO.File.WriteAllText("launch-confirmed.txt", System.IO.Directory.Exists("mods") ? "modded" : "original"); } }');
  const exe = path.join(game, 'GlowSampleGame.exe');
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/out:' + exe, cs], { windowsHide: true });
  const zip = path.join(fixture, 'SampleMod.zip');
  const payload = path.join(fixture, 'sample');
  fs.mkdirSync(path.join(payload, 'files'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'glow-mod.json'), JSON.stringify({ format: 'glow-mod-v1', name: 'Sample lighting', category: 'Visuals' }));
  fs.writeFileSync(path.join(payload, 'files/lighting.ini'), 'brightness=15');
  execFileSync('tar.exe', ['-a', '-cf', zip, '-C', payload, 'glow-mod.json', 'files'], { windowsHide: true });

  const args = [...(process.argv[2] ? [] : [appRoot]), '--user-data-dir=' + profile, '--remote-debugging-port=0', '--disable-gpu'];
  const child = spawn(binary, args, { cwd: appRoot, windowsHide: true, stdio: 'ignore' });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  let browser;
  let page;
  let browserUrl;
  try {
    const port = await eventually(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error('Desktop app exited ' + child.exitCode);
      const [port, targetPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      if (!/^\d+$/.test(port)) return null;
      browserUrl = 'ws://127.0.0.1:' + port + targetPath;
      return port;
    });
    const target = await eventually(async () => (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json())
      .find((entry) => entry.type === 'page' && entry.url.endsWith('/index.html')));
    page = await connect(target.webSocketDebuggerUrl);
    async function evaluate(expression) {
      const result = await page.run('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    await eventually(() => evaluate('!!window.glow && document.readyState === "complete"'));
    const configured = await evaluate('glow.releaseFeatures()');
    const packaged = !!process.argv[2];
    assert.equal(configured.updates, packaged && !!process.env.GLOW_UPDATE_URL);
    assert.equal(configured.mods, !!process.env.GLOW_MODS_URL);
    await eventually(() => evaluate('document.querySelector("#checkUpdatesBtn").hidden === ' + !configured.updates));
    await eventually(() => evaluate('document.querySelector("#findModsBtn").hidden === ' + !configured.mods));
    assert.equal(await evaluate('document.querySelector("#updateBanner").hidden'), true);
    const initial = await evaluate('glow.state()');
    assert.equal(initial.game, null);
    assert.ok(path.relative(profile, initial.folder).split(path.sep)[0] !== '..');
    await evaluate('glow.selectGame(' + JSON.stringify(exe) + ')');
    await page.run('Page.reload');
    await eventually(() => evaluate('!!document.querySelector("#vanillaBtn") && !document.querySelector("#vanillaBtn").disabled'));

    await evaluate('document.body.append(Object.assign(document.createElement("input"),{type:"file",id:"smoke-file"}))');
    const { root } = await page.run('DOM.getDocument');
    const { nodeId } = await page.run('DOM.querySelector', { nodeId: root.nodeId, selector: '#smoke-file' });
    await page.run('DOM.setFileInputFiles', { nodeId, files: [zip] });
    await evaluate('(()=>{ const dt = new DataTransfer(); dt.items.add(document.querySelector("#smoke-file").files[0]); document.querySelector("#dropZone").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt})); })()');
    await eventually(() => evaluate('document.querySelector("#modList").textContent.includes("Sample lighting")'));
    const [{ id }] = (await evaluate('glow.state()')).mods;
    await evaluate('document.querySelector("#modList .switch").click()');
    await eventually(() => evaluate('document.querySelector("#confirmDialog").open'));
    await evaluate('document.querySelector("#confirmOk").click()');
    await eventually(() => evaluate('!document.querySelector("#playBtn").disabled'));
    assert.equal((await evaluate('glow.state()')).mods[0].enabled, true);
    assert.equal(fs.existsSync(path.join(game, 'mods')), false);

    const originalExe = fs.readFileSync(exe);
    await evaluate('document.querySelector("#playBtn").click()');
    const runningCopy = await eventually(async () => {
      const current = await evaluate('glow.state()');
      return current.profilePath && fs.existsSync(path.join(current.profilePath, 'launch-confirmed.txt')) ? current.profilePath : null;
    });
    assert.equal(fs.readFileSync(path.join(runningCopy, 'launch-confirmed.txt'), 'utf8'), 'modded');
    assert.equal(fs.readFileSync(path.join(runningCopy, 'mods', 'glow-' + id, 'lighting.ini'), 'utf8'), 'brightness=15');
    assert.equal(fs.existsSync(path.join(game, 'mods')), false);
    assert.equal(fs.existsSync(path.join(game, 'launch-confirmed.txt')), false);
    assert.deepEqual(fs.readFileSync(exe), originalExe);

    await eventually(() => evaluate('!document.querySelector("#vanillaBtn").disabled'));
    await evaluate('document.querySelector("#vanillaBtn").click()');
    await eventually(() => fs.existsSync(path.join(game, 'launch-confirmed.txt')));
    assert.equal(fs.readFileSync(path.join(game, 'launch-confirmed.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(game, 'mods')), false);
    assert.deepEqual(fs.readFileSync(exe), originalExe);
    await eventually(async () => !(await evaluate('glow.state()')).running);
    assert.equal((await evaluate('glow.toggle(' + JSON.stringify(id) + ',false)')).mods[0].enabled, false);
    assert.equal((await evaluate('glow.clearProfiles()')).profiles, 0);
    assert.equal(fs.existsSync(runningCopy), false);
    assert.equal((await evaluate('glow.remove(' + JSON.stringify(id) + ')')).mods.length, 0);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    for (let i = 0; i < 500; i++) {
      const id = i.toString(16).padStart(64, '0');
      const dir = path.join(initial.folder, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        id, name: 'Library fixture ' + String(i).padStart(3, '0'), category: 'Visuals',
        files: [{ relative: 'sample.ini', sha256: id }],
      }));
    }
    await evaluate('document.querySelector("#refreshBtn").click()');
    await eventually(() => evaluate('document.querySelector("#resultCount").textContent === "500 mods"'));
    assert.equal(await evaluate('document.querySelector("#modList").children.length'), 32);
    await evaluate('document.querySelector("#moreModsBtn").click()');
    assert.equal(await evaluate('document.querySelector("#modList").children.length'), 64);
    assert.equal(await evaluate('(() => { const main = document.querySelector("#main"); main.scrollTop = 600; return main.scrollTop > 0; })()'), true);
    await evaluate('(() => { const input = document.querySelector("#searchInput"); input.value = "fixture 499"; input.dispatchEvent(new Event("input")); })()');
    await eventually(() => evaluate('document.querySelector("#modList").children.length === 1 && document.querySelector("#modList").textContent.includes("fixture 499")'));
    console.log('Desktop smoke passed: release controls, 500-mod list and search, file drop, switch, automatic mods folder, isolated executable, original executable and copy cleanup.');
  } finally {
    page?.ws.close();
    if (browserUrl) {
      try {
        browser = await connect(browserUrl);
        browser.ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch {}
    }
    for (let i = 0; i < 15 && child.exitCode === null; i++) await wait(100);
    if (child.exitCode === null) child.kill();
    browser?.ws.close();
    if (path.dirname(fixture) === parent && path.basename(fixture).startsWith('glow-manager-smoke-')) {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
