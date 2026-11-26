/* Glow Mod Manager — renderer.
 * Talks only to window.glow (preload bridge). Never uses the network, never
 * builds HTML from strings: all user/game supplied values go through textContent
 * or attribute setters.
 */
'use strict';

(() => {
  const glow = window.glow;
  const $ = (id) => document.getElementById(id);

  const el = {
    shell: $('shell'),
    vanillaBtn: $('vanillaBtn'),
    vanillaBtn2: $('vanillaBtn2'),
    totalMods: $('totalMods'),
    selectedMods: $('selectedMods'),
    sessionStatus: $('sessionStatus'),
    recoveryNotice: $('recoveryNotice'),
    recoveryText: $('recoveryText'),
    restoreBtn: $('restoreBtn'),
    launchProgress: $('launchProgress'),
    progressBar: $('progressBar'),
    progressLabel: $('progressLabel'),
    cancelLaunchBtn: $('cancelLaunchBtn'),
    sortSelect: $('sortSelect'),
    resetFiltersBtn: $('resetFiltersBtn'),
    refreshBtn: $('refreshBtn'),
    factProfile: $('factProfile'),
    folderDefaultBtn: $('folderDefaultBtn'),
    profileFolder: $('profileFolder'),
    profileCount: $('profileCount'),
    clearProfilesBtn: $('clearProfilesBtn'),

    main: $('main'),
    navToggle: $('navToggle'),
    navItems: Array.from(document.querySelectorAll('.nav-item[data-view]')),
    navCount: $('navCount'),
    navSetupFlag: $('navSetupFlag'),
    titleGame: $('titleGame'),
    titleDot: $('titleDot'),
    errorBanner: $('errorBanner'),
    errorText: $('errorText'),
    errorDismiss: $('errorDismiss'),
    views: Array.from(document.querySelectorAll('.view[data-panel]')),
    librarySummary: $('librarySummary'),
    playBtn: $('playBtn'),
    playBtn2: $('playBtn2'),
    playHint: $('playHint'),
    setupNotice: $('setupNotice'),
    setupTitle: $('setupTitle'),
    setupLead: $('setupLead'),
    gotoSetupBtn: $('gotoSetupBtn'),
    dropZone: $('dropZone'),
    importBtn: $('importBtn'),
    searchInput: $('searchInput'),
    categorySelect: $('categorySelect'),
    statusSelect: $('statusSelect'),
    resultCount: $('resultCount'),
    modList: $('modList'),
    moreModsBtn: $('moreModsBtn'),
    findModsBtn: $('findModsBtn'),
    checkUpdatesBtn: $('checkUpdatesBtn'),
    updateBanner: $('updateBanner'),
    updateMessage: $('updateMessage'),
    updateNowBtn: $('updateNowBtn'),
    dismissUpdateBtn: $('dismissUpdateBtn'),
    emptyLibrary: $('emptyLibrary'),
    emptyFilter: $('emptyFilter'),
    clearFiltersBtn: $('clearFiltersBtn'),
    noGame: $('noGame'),
    gameFacts: $('gameFacts'),
    factName: $('factName'),
    factExe: $('factExe'),
    factFolder: $('factFolder'),
    detectBtn: $('detectBtn'),
    browseBtn: $('browseBtn'),
    detectResults: $('detectResults'),
    detectList: $('detectList'),
    detectEmpty: $('detectEmpty'),
    folderInput: $('folderInput'),
    folderSaveBtn: $('folderSaveBtn'),
    folderError: $('folderError'),
    libraryFolder: $('libraryFolder'),
    motionSelect: $('motionSelect'),
    confirmDeployCheck: $('confirmDeployCheck'),
    spinner: $('busySpinner'),
    statusText: $('statusText'),
    statusMeta: $('statusMeta'),
    dialog: $('confirmDialog'),
    dTitle: $('confirmTitle'),
    dBody: $('confirmBody'),
    dOk: $('confirmOk'),
    dCancel: $('confirmCancel'),
    modTpl: $('modRowTpl'),
    detectTpl: $('detectRowTpl'),
  };

  /* ------------------------------------------------------------------ state */

  let state = { game: null, mods: [], folder: '' };
  let busy = false;
  let bridgeOk = !!glow && typeof glow === 'object';
  let currentView = 'library';
  let detected = null; // null = not searched yet, [] = none found
  let folderDirty = false;
  let pendingFocus = null;
  let preparing = false;
  let cancelling = false;
  let polling = false;
  let updatePhase = 'idle';
  let matchesOnScreen = [];
  let visibleLimit = 0;
  const pageSize = 32;
  const nameOrder = new Intl.Collator(undefined, { sensitivity: 'base' });
  let searchTimer;
  const openDetails = new Set();
  const filters = { q: '', category: 'all', status: 'all', sort: 'name' };
  const prefs = loadPrefs();

  const str = (v) => (v == null ? '' : String(v));

  function normalizeState(s) {
    if (!s || typeof s !== 'object') throw new Error('Glow returned an unexpected library state.');
    const game = s.game && typeof s.game === 'object'
      ? { exe: str(s.game.exe), name: str(s.game.name) || 'Unnamed game', modsFolder: str(s.game.modsFolder).trim() }
      : null;
    const mods = Array.isArray(s.mods)
      ? s.mods
          .filter((m) => m && typeof m === 'object' && m.id != null)
          .map((m) => ({
            id: String(m.id),
            name: str(m.name).trim() || String(m.id),
            category: str(m.category).trim() || 'Uncategorized',
            enabled: m.enabled === true,
            files: m.files,
          }))
      : [];
    const count = (n) => Number.isSafeInteger(n) && n > 0 ? n : 0;
    const progress = s.progress && typeof s.progress === 'object'
      ? { label: str(s.progress.label), done: count(s.progress.done), total: count(s.progress.total) }
      : null;
    return {
      game, mods, folder: str(s.folder), profilePath: str(s.profilePath),
      gameUnavailable: s.gameUnavailable === true, legacyEnabled: count(s.legacyEnabled), profiles: count(s.profiles),
      running: typeof s.running === 'string' ? s.running : null, progress,
    };
  }

  function applyState(s) {
    state = normalizeState(s);
    // Drop details state for mods that no longer exist.
    for (const id of openDetails) if (!state.mods.some((m) => m.id === id)) openDetails.delete(id);
  }

  const hasGame = () => !!state.game;
  const setupReady = () => hasGame() && !state.gameUnavailable;
  const selectedCount = () => state.mods.filter((m) => m.enabled).length;
  const findMod = (id) => state.mods.find((m) => m.id === id);

  function setupMessage() {
    if (state.gameUnavailable) return 'Browse to the current location of your game executable.';
    return 'Choose a game in Game setup.';
  }

  function fileInfo(files) {
    if (Array.isArray(files)) return { count: files.length, list: files.map(str) };
    const n = Number(files);
    return { count: Number.isFinite(n) && n >= 0 ? Math.floor(n) : null, list: [] };
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

  function errMsg(e) {
    if (!e) return 'Something went wrong.';
    let m = typeof e === 'string' ? e : (e.message ? String(e.message) : String(e));
    // Strip Electron IPC wrapper text so users see the readable reason.
    m = m.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(Error|TypeError):\s*/, '');
    return m.trim() || 'Something went wrong.';
  }

  /* ------------------------------------------------------------ preferences */

  function loadPrefs() {
    const p = { motion: 'system', confirmDeploy: true };
    try {
      const raw = window.localStorage.getItem('glow.prefs');
      if (raw) {
        const v = JSON.parse(raw);
        if (['system', 'reduce', 'full'].includes(v.motion)) p.motion = v.motion;
        if (typeof v.confirmDeploy === 'boolean') p.confirmDeploy = v.confirmDeploy;
      }
    } catch (_) { /* storage unavailable: use defaults */ }
    return p;
  }

  function savePrefs() {
    try { window.localStorage.setItem('glow.prefs', JSON.stringify(prefs)); } catch (_) { /* ignore */ }
  }

  function applyPrefs() {
    document.documentElement.dataset.motion = prefs.motion;
    el.motionSelect.value = prefs.motion;
    el.confirmDeployCheck.checked = prefs.confirmDeploy;
  }

  /* -------------------------------------------------------- status & errors */

  function announce(msg) {
    // Clear first so an identical message is re-announced.
    el.statusText.textContent = '';
    window.requestAnimationFrame(() => { el.statusText.textContent = msg; });
  }

  function showError(msg) {
    el.errorText.textContent = msg;
    el.errorBanner.hidden = false;
    el.statusText.textContent = 'Something needs attention.';
  }

  function hideError() {
    el.errorBanner.hidden = true;
    el.errorText.textContent = '';
  }

  function focusSelector(node) {
    if (!node || node === document.body || !(node instanceof HTMLElement)) return null;
    if (node.dataset.key) return `[data-key="${CSS.escape(node.dataset.key)}"]`;
    if (node.id) return `#${CSS.escape(node.id)}`;
    return null;
  }

  function restoreFocus(selector) {
    if (!selector) return;
    const target = document.querySelector(selector);
    if (target && !target.disabled && target.offsetParent !== null) target.focus({ preventScroll: false });
  }

  function setBusy(on, label) {
    busy = on;
    document.body.classList.toggle('is-busy', on);
    el.main.setAttribute('aria-busy', on ? 'true' : 'false');
    el.spinner.hidden = !on;
    if (on && label) el.statusText.textContent = `${label}…`;
    render();
  }

  /** Runs one bridge task at a time with busy state, error reporting and focus restore. */
  async function run(label, task) {
    if (busy || !bridgeOk) return;
    const prevFocus = focusSelector(document.activeElement);
    pendingFocus = null;
    hideError();
    setBusy(true, label);
    try {
      await task();
    } catch (e) {
      showError(errMsg(e));
    } finally {
      setBusy(false);
      restoreFocus(pendingFocus || prevFocus);
      pendingFocus = null;
    }
  }

  /* --------------------------------------------------------- confirmations */

  function confirmDialog({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const d = el.dialog;
      const opener = document.activeElement;
      el.dTitle.textContent = title;
      el.dBody.textContent = body;
      el.dOk.textContent = confirmLabel;
      el.dOk.classList.toggle('btn-danger', !!danger);
      el.dOk.classList.toggle('btn-primary', !danger);

      const finish = (value) => {
        el.dOk.removeEventListener('click', onOk);
        el.dCancel.removeEventListener('click', onCancel);
        d.removeEventListener('cancel', onEsc);
        d.removeEventListener('click', onBackdrop);
        if (d.open) d.close();
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onEsc = (e) => { e.preventDefault(); finish(false); };
      const onBackdrop = (e) => { if (e.target === d) finish(false); };

      el.dOk.addEventListener('click', onOk);
      el.dCancel.addEventListener('click', onCancel);
      d.addEventListener('cancel', onEsc);
      d.addEventListener('click', onBackdrop);
      d.showModal();
      el.dCancel.focus(); // safe default
    });
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    renderChrome();
    renderLibrary();
    renderGame();
  }

  function renderChrome() {
    const g = state.game;
    const selected = selectedCount();
    const legacy = state.legacyEnabled || 0;
    const gameRunning = !!state.running;
    el.titleGame.textContent = g ? g.name : 'No game selected';
    el.titleDot.classList.toggle('is-ready', setupReady());
    el.titleDot.classList.toggle('is-partial', hasGame() && !setupReady());
    el.navCount.textContent = String(state.mods.length);
    el.navSetupFlag.hidden = setupReady();
    el.statusMeta.textContent = g ? 'Game: ' + g.name : '';
    el.libraryFolder.textContent = state.folder || 'No library folder selected';
    el.profileFolder.textContent = state.profilePath || 'Created on modded launch';
    el.profileCount.textContent = String(state.profiles || 0);
    el.clearProfilesBtn.disabled = !bridgeOk || busy || gameRunning || !state.profiles;
    el.totalMods.textContent = String(state.mods.length);
    el.selectedMods.textContent = String(selected);
    el.sessionStatus.textContent = gameRunning ? 'Running' : preparing ? 'Preparing copy' : setupReady() ? (legacy ? 'Restore needed' : 'Ready') : 'Setup needed';
    el.recoveryNotice.hidden = !legacy;
    el.restoreBtn.disabled = busy || gameRunning || !bridgeOk;
    el.recoveryText.textContent = legacy
      ? plural(legacy, 'deployment') + ' from an older Glow version found. Restore the original folder before launching either way.'
      : '';
    el.refreshBtn.disabled = busy || !bridgeOk;

    const canPlay = bridgeOk && setupReady() && !busy && !gameRunning && !legacy;
    el.playBtn.disabled = el.playBtn2.disabled = !canPlay || !selected;
    el.vanillaBtn.disabled = el.vanillaBtn2.disabled = !canPlay;
    if (!setupReady()) el.playHint.textContent = setupMessage();
    else if (legacy) el.playHint.textContent = 'Restore the original folder to unlock launch.';
    else if (gameRunning) el.playHint.textContent = 'Close the running game to launch again.';
    else if (!selected) el.playHint.textContent = 'Select a mod to prepare a separate game copy.';
    else el.playHint.textContent = 'Modded uses a separate copy. Original opens the selected executable directly.';
    renderProgress();
  }

  function renderProgress() {
    const progress = state.progress;
    const visible = preparing || !!progress;
    el.launchProgress.hidden = !visible;
    el.cancelLaunchBtn.hidden = !visible || typeof glow?.cancelLaunch !== 'function';
    el.cancelLaunchBtn.disabled = cancelling;
    el.progressLabel.textContent = cancelling ? 'Stopping preparation' : progress?.label || 'Preparing the game copy';
    if (progress?.total) {
      el.progressBar.max = progress.total;
      el.progressBar.value = Math.min(progress.done, progress.total);
      el.progressLabel.textContent += ' (' + Math.floor(el.progressBar.value / progress.total * 100) + '%)';
    } else {
      el.progressBar.removeAttribute('value');
    }
  }

  function matches(m) {
    if (filters.category !== 'all' && m.category !== filters.category) return false;
    if (filters.status === 'enabled' && !m.enabled) return false;
    if (filters.status === 'disabled' && m.enabled) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!m.name.toLowerCase().includes(q) && !m.category.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function hueFor(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return `hue-${h % 6}`;
  }

  function renderCategories() {
    const cats = Array.from(new Set(state.mods.map((m) => m.category))).sort((a, b) => a.localeCompare(b));
    if (filters.category !== 'all' && !cats.includes(filters.category)) filters.category = 'all';
    const sel = el.categorySelect;
    const wanted = ['all', ...cats];
    const current = Array.from(sel.options).map((o) => o.value);
    if (current.length !== wanted.length || current.some((v, i) => v !== wanted[i])) {
      const all = document.createElement('option');
      all.value = 'all';
      all.textContent = 'All categories';
      const opts = cats.map((c) => {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        return o;
      });
      sel.replaceChildren(all, ...opts);
    }
    sel.value = filters.category;
  }

  function renderLibrary() {
    const ready = setupReady();
    const total = state.mods.length;

    el.librarySummary.textContent = total
      ? 'Choose the mods to include in your next modded launch.'
      : 'Import Glow Mods ZIP packages to build your library.';

    el.setupNotice.hidden = ready;
    if (!ready) {
      el.setupTitle.textContent = state.gameUnavailable ? 'Game location changed' : 'Pick a game';
      el.setupLead.textContent = state.gameUnavailable
        ? setupMessage()
        : 'Choose the game once. Glow prepares its own copy when you launch modded.';
    }

    // Import controls
    el.importBtn.disabled = busy || !bridgeOk;
    el.dropZone.classList.toggle('is-disabled', busy || !bridgeOk);

    // Filters
    renderCategories();
    el.statusSelect.value = filters.status;
    el.sortSelect.value = filters.sort;
    el.resetFiltersBtn.hidden = !filters.q && filters.category === 'all' && filters.status === 'all' && filters.sort === 'name';
    const filterDisabled = total === 0;
    el.searchInput.disabled = filterDisabled;
    el.categorySelect.disabled = filterDisabled;
    el.statusSelect.disabled = filterDisabled;
    el.sortSelect.disabled = filterDisabled;

    const byName = (a, b) => nameOrder.compare(a.name, b.name);
    const order = {
      name: byName,
      selected: (a, b) => Number(b.enabled) - Number(a.enabled) || byName(a, b),
      category: (a, b) => a.category.localeCompare(b.category) || byName(a, b),
    };
    const visible = state.mods.filter(matches).sort(order[filters.sort]);
    el.resultCount.textContent = total ? (visible.length === total ? plural(total, 'mod') : `${visible.length} of ${total} mods`) : '';
    el.emptyLibrary.hidden = total !== 0;
    el.emptyFilter.hidden = !(total > 0 && visible.length === 0);

    matchesOnScreen = visible;
    const limit = Math.max(pageSize, visibleLimit);
    visibleLimit = 0;
    el.modList.replaceChildren();
    el.modList.hidden = visible.length === 0;
    showMoreMods(limit);
  }

  function showMoreMods(count = pageSize) {
    const next = matchesOnScreen.slice(visibleLimit, visibleLimit + count);
    el.modList.append(...next.map(buildModRow));
    visibleLimit += next.length;
    el.moreModsBtn.hidden = visibleLimit >= matchesOnScreen.length;
  }

  function renderUpdate(update) {
    updatePhase = update.phase;
    const available = updatePhase === 'available';
    const ready = updatePhase === 'ready';
    const pending = ['checking', 'downloading', 'installing'].includes(updatePhase);
    el.checkUpdatesBtn.disabled = pending;
    el.updateBanner.hidden = updatePhase === 'idle';
    el.updateMessage.textContent = update.percent == null ? update.message : update.message + ' ' + update.percent + '%';
    el.updateNowBtn.textContent = ready ? 'Restart to update' : 'Update now';
    el.updateNowBtn.hidden = !available && !ready;
    el.dismissUpdateBtn.hidden = pending;
  }

  async function updateAction(action) {
    try { renderUpdate(await action()); }
    catch (error) { showError(errMsg(error)); }
  }

  function buildModRow(m) {
    const li = el.modTpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = m.id;
    li.classList.toggle('is-enabled', m.enabled);

    const glyph = li.querySelector('.mod-glyph');
    glyph.textContent = (Array.from(m.name)[0] || '?').toUpperCase();
    glyph.classList.add(hueFor(m.category + m.name));

    li.querySelector('.mod-name').textContent = m.name;
    li.querySelector('.mod-category').textContent = m.category;

    const info = fileInfo(m.files);
    li.querySelector('.mod-files').textContent = info.count == null ? '' : plural(info.count, 'file');

    const stateEl = li.querySelector('.mod-state');
    stateEl.textContent = m.enabled ? 'Selected' : 'In library';
    stateEl.classList.toggle('is-on', m.enabled);

    if (info.list.length) {
      const details = li.querySelector('.mod-details');
      details.hidden = false;
      details.open = openDetails.has(m.id);
      details.dataset.id = m.id;
      const ul = details.querySelector('.file-list');
      const max = 200;
      const items = info.list.slice(0, max).map((f) => {
        const item = document.createElement('li');
        item.textContent = f;
        return item;
      });
      if (info.list.length > max) {
        const more = document.createElement('li');
        more.textContent = `…and ${info.list.length - max} more`;
        items.push(more);
      }
      ul.replaceChildren(...items);
      const summary = details.querySelector('summary');
      summary.dataset.key = `details:${m.id}`;
      summary.textContent = `Show files (${info.list.length})`;
    }

    const sw = li.querySelector('.switch');
    sw.dataset.id = m.id;
    sw.dataset.key = `toggle:${m.id}`;
    sw.setAttribute('aria-checked', m.enabled ? 'true' : 'false');
    sw.setAttribute('aria-label', 'Select ' + m.name + ' for modded launch');
    sw.querySelector('.switch-text').textContent = m.enabled ? 'On' : 'Off';
    sw.disabled = busy || !bridgeOk || !setupReady() || !!state.running;
    if (!setupReady()) {
      sw.setAttribute('aria-describedby', 'setupTitle setupLead');
      sw.title = setupMessage();
    } else if (state.running) sw.title = 'Close the game before changing the selection.';

    const rm = li.querySelector('.mod-remove');
    rm.dataset.id = m.id;
    rm.dataset.key = `remove:${m.id}`;
    rm.setAttribute('aria-label', `Remove ${m.name}`);
    rm.disabled = busy || !bridgeOk || !!state.running;

    return li;
  }

  function renderGame() {
    const g = state.game;
    el.noGame.hidden = !!g;
    el.gameFacts.hidden = !g;
    if (g) {
      el.factName.textContent = g.name;
      el.factExe.textContent = g.exe || '—';
      el.factFolder.textContent = g.modsFolder || 'mods (automatic)';
      el.factProfile.textContent = state.profilePath || 'Created on modded launch';
    }

    el.detectBtn.disabled = busy || !bridgeOk || !!state.running || !!state.legacyEnabled;
    el.browseBtn.disabled = el.detectBtn.disabled;

    // Detection results
    el.detectResults.hidden = detected === null;
    if (detected !== null) {
      el.detectEmpty.hidden = detected.length > 0;
      const rows = detected.map((d) => {
        const li = el.detectTpl.content.firstElementChild.cloneNode(true);
        li.querySelector('.detect-name').textContent = d.name;
        li.querySelector('.detect-exe').textContent = d.exe;
        const btn = li.querySelector('.detect-select');
        const isCurrent = !!g && g.exe === d.exe;
        li.classList.toggle('is-current', isCurrent);
        btn.dataset.exe = d.exe;
        btn.dataset.key = `detect:${d.exe}`;
        btn.textContent = isCurrent ? 'Selected' : 'Use this game';
        btn.setAttribute('aria-label', isCurrent ? `${d.name} is selected` : `Use ${d.name}`);
        btn.disabled = el.detectBtn.disabled || isCurrent;
        return li;
      });
      el.detectList.replaceChildren(...rows);
      el.detectList.hidden = detected.length === 0;
    }

    // Data folder form
    const folderEnabled = !!g && !busy && bridgeOk && !state.running && !state.legacyEnabled;
    el.folderInput.disabled = !folderEnabled;
    el.folderSaveBtn.disabled = !folderEnabled;
    el.folderDefaultBtn.disabled = !folderEnabled;
    if (!folderDirty) el.folderInput.value = g ? g.modsFolder : '';
    el.folderInput.placeholder = g ? 'e.g. mods' : 'Select a game first';
  }

  /* ---------------------------------------------------------------- views */

  function showView(name, moveFocus) {
    currentView = name;
    el.views.forEach((v) => { v.hidden = v.dataset.panel !== name; });
    el.navItems.forEach((b) => {
      if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    el.main.scrollTop = 0;
    if (moveFocus) {
      const h = document.querySelector(`#view-${CSS.escape(name)} h1`);
      if (h) h.focus();
    }
  }

  function setNavCollapsed(collapsed) {
    el.shell.classList.toggle('nav-collapsed', collapsed);
    el.navToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    el.navToggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
  }

  /* --------------------------------------------------------------- actions */

  function loadState() {
    return run('Loading library', async () => {
      applyState(await glow.state());
      announce(state.mods.length ? `Library loaded · ${plural(state.mods.length, 'mod')}.` : 'Ready. Your library is empty.');
    });
  }

  async function handleToggle(id) {
    const mod = findMod(id);
    if (!mod || busy || !setupReady() || state.running) return;
    const enable = !mod.enabled;
    if (enable && prefs.confirmDeploy) {
      const ok = await confirmDialog({
        title: 'Select ' + mod.name + '?',
        body: 'Glow will include it in the next modded game copy. Your original game files stay in place.',
        confirmLabel: 'Select mod',
      });
      if (!ok) return;
    }
    await run(enable ? 'Selecting ' + mod.name : 'Unselecting ' + mod.name, async () => {
      applyState(await glow.toggle(id, enable));
      announce(mod.name + (findMod(id)?.enabled ? ' selected for modded launch.' : ' unselected.'));
    });
  }

  async function handleRemove(id) {
    const mod = findMod(id);
    if (!mod || busy) return;
    const ok = await confirmDialog({
      title: `Remove ${mod.name}?`,
      body: mod.enabled
        ? `This mod is selected for modded launch. Removing it also takes it out of your Glow library. This can't be undone.`
        : `This removes the mod from your Glow library. This can't be undone.`,
      confirmLabel: 'Remove mod',
      danger: true,
    });
    if (!ok) { announce('Removal cancelled.'); return; }

    // Decide where focus lands once the row disappears.
    const removeButtons = Array.from(el.modList.querySelectorAll('.mod-remove'));
    const idx = removeButtons.findIndex((b) => b.dataset.id === id);
    const neighbour = removeButtons[idx + 1] || removeButtons[idx - 1];

    await run(`Removing ${mod.name}`, async () => {
      applyState(await glow.remove(id));
      announce(`${mod.name} removed from the library.`);
      pendingFocus = neighbour ? `[data-key="${CSS.escape(neighbour.dataset.key)}"]` : '#importBtn';
    });
  }

  function importWithDialog() {
    return run('Choosing ZIP files', async () => {
      const before = state.mods.length;
      const imported = await glow.chooseImport();
      applyState(imported);
      if (imported.importErrors?.length) showError(imported.importErrors.map((entry) => entry.name + ': ' + entry.message).join(' '));
      const added = state.mods.length - before;
      announce(added > 0 ? `Imported ${plural(added, 'mod')}.` : 'No new mods were imported.');
    });
  }

  function importDropped(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const zips = files.filter((f) => f && typeof f.name === 'string' && /\.zip$/i.test(f.name));
    const skipped = files.length - zips.length;
    if (!zips.length) {
      showError(`Only local .zip files can be imported. ${plural(skipped, 'item was', 'items were')} skipped.`);
      return;
    }
    return run(`Importing ${plural(zips.length, 'ZIP')}`, async () => {
      const before = state.mods.length;
      const imported = await glow.importPaths(zips);
      applyState(imported);
      if (imported.importErrors?.length) showError(imported.importErrors.map((entry) => entry.name + ': ' + entry.message).join(' '));
      const added = state.mods.length - before;
      let msg = added > 0 ? `Imported ${plural(added, 'mod')}.` : 'No new mods were imported.';
      if (skipped) msg += ` Skipped ${plural(skipped, 'non-ZIP item')}.`;
      announce(msg);
    });
  }

  function detectGames() {
    return run('Looking for game executables', async () => {
      const result = await glow.detect();
      detected = (Array.isArray(result) ? result : [])
        .filter((d) => d && typeof d === 'object' && d.exe)
        .map((d) => ({ exe: str(d.exe), name: str(d.name) || str(d.exe) }));
      announce(detected.length ? `Found ${plural(detected.length, 'game executable')}.` : 'No game executables found. Try Browse.');
      if (detected.length) pendingFocus = `[data-key="${CSS.escape(`detect:${detected[0].exe}`)}"]`;
    });
  }

  function selectGame(exe) {
    return run('Selecting game', async () => {
      applyState(await glow.selectGame(exe));
      folderDirty = false;
      clearFolderError();
      announce(state.game
        ? (state.game.name + ' selected. Glow will prepare the mods folder.')
        : 'Game selection cleared.');
    });
  }

  function browseGame() {
    return run('Waiting for you to choose an executable', async () => {
      const exe = await glow.browse();
      if (!exe) { announce('Browse cancelled.'); return; }
      el.statusText.textContent = 'Selecting game…';
      applyState(await glow.selectGame(String(exe)));
      folderDirty = false;
      clearFolderError();
      announce(state.game
        ? (state.game.name + ' selected. Glow will prepare the mods folder.')
        : 'No game selected.');
    });
  }

  function validateRelative(raw) {
    const v = raw.trim();
    if (!v) return 'Enter the data folder, relative to the game folder.';
    const norm = v.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('/') || norm.startsWith('//')) {
      return 'Use a path relative to the game folder, not an absolute path.';
    }
    if (norm.split('/').some((seg) => seg.trim() === '..')) return 'The data folder must stay inside the game folder (no “..”).';
    if (/[<>:"|?*\u0000-\u001f]/.test(norm)) return 'The path contains characters that are unsafe in cross-platform folder names.';
    return null;
  }

  function setFolderError(msg) {
    el.folderError.textContent = msg;
    el.folderError.hidden = false;
    el.folderInput.setAttribute('aria-invalid', 'true');
  }

  function clearFolderError() {
    el.folderError.hidden = true;
    el.folderError.textContent = '';
    el.folderInput.removeAttribute('aria-invalid');
  }

  function saveFolder(value = el.folderInput.value.trim()) {
    if (!state.game || busy) return;
    const problem = validateRelative(value);
    if (problem) { setFolderError(problem); el.folderInput.focus(); return; }
    clearFolderError();
    return run('Saving data folder', async () => {
      try {
        applyState(await glow.setModsFolder(value));
      } catch (e) {
        setFolderError(errMsg(e));
        pendingFocus = '#folderInput';
        throw e;
      }
      folderDirty = false;
      announce(`Data folder set to “${state.game ? state.game.modsFolder : value}”. The next modded copy will use it.`);
    });
  }

  function launchGame(modded) {
    if (!setupReady() || state.legacyEnabled || state.running) return;
    const name = state.game.name;
    return run(modded ? 'Preparing ' + name : 'Starting ' + name, async () => {
      preparing = modded;
      renderChrome();
      try {
        const after = modded ? await glow.launch() : await glow.launchVanilla();
        applyState(after?.mods ? after : await glow.state());
        announce(state.running ? name + (modded ? ' started from the modded copy.' : ' started from the original executable.') : 'Launch preparation ended.');
      } finally {
        preparing = false;
        cancelling = false;
        state.progress = null;
      }
    });
  }

  async function restoreOriginal() {
    const confirmed = await confirmDialog({
      title: 'Restore the original game folder?',
      body: 'Glow checks the files left by older versions and removes only unchanged files it owns.',
      confirmLabel: 'Restore original',
    });
    if (!confirmed) return;
    return run('Restoring original game folder', async () => {
      const next = await glow.restoreOriginal();
      applyState(next?.mods ? next : await glow.state());
      announce('Original game folder restored.');
      pendingFocus = '#view-' + currentView + ' h1';
    });
  }

  async function clearProfiles() {
    const confirmed = await confirmDialog({
      title: 'Remove saved game copies?',
      body: 'Glow removes its saved game copies. Back up any saves stored inside them first. Your original installation and mod library stay in place.',
      confirmLabel: 'Clear saved copies',
      danger: true,
    });
    if (!confirmed) return;
    return run('Removing saved copies', async () => {
      const next = await glow.clearProfiles();
      applyState(next?.mods ? next : await glow.state());
      announce('Saved game copies removed.');
      pendingFocus = '#aboutHeading';
    });
  }

  async function pollSession() {
    if (!bridgeOk || document.hidden || polling || (!preparing && (!state.running || busy))) return;
    polling = true;
    try {
      const next = await glow.sessionState();
      if (busy && preparing) {
        state.progress = next.progress;
        renderProgress();
      } else if (!busy && state.running && !next.running) {
        applyState(await glow.state());
        render();
        announce('Game session ended.');
      }
    } catch (_) {
      // Launch reports its own errors. A later poll or Refresh can recover status.
    } finally {
      polling = false;
    }
  }

  /* --------------------------------------------------------------- events */

  function bindEvents() {
    el.navItems.forEach((b) => b.addEventListener('click', () => showView(b.dataset.view, true)));
    el.navToggle.addEventListener('click', () => setNavCollapsed(!el.shell.classList.contains('nav-collapsed')));
    el.gotoSetupBtn.addEventListener('click', () => showView('game', true));
    el.errorDismiss.addEventListener('click', () => { hideError(); el.main.focus(); });

    for (const button of [el.playBtn, el.playBtn2]) button.addEventListener('click', () => launchGame(true));
    for (const button of [el.vanillaBtn, el.vanillaBtn2]) button.addEventListener('click', () => launchGame(false));
    el.restoreBtn.addEventListener('click', restoreOriginal);
    el.clearProfilesBtn.addEventListener('click', clearProfiles);
    el.refreshBtn.addEventListener('click', loadState);
    el.moreModsBtn.addEventListener('click', () => {
      const previousCount = visibleLimit;
      showMoreMods();
      el.modList.children[previousCount]?.querySelector('summary')?.focus();
    });
    el.findModsBtn.addEventListener('click', async () => {
      try { await glow.openMods(); }
      catch (error) { showError(errMsg(error)); }
    });
    el.checkUpdatesBtn.addEventListener('click', () => updateAction(glow.checkUpdate));
    el.updateNowBtn.addEventListener('click', () =>
      updateAction(updatePhase === 'ready' ? glow.installUpdate : glow.downloadUpdate));
    el.dismissUpdateBtn.addEventListener('click', () => {
      el.updateBanner.hidden = true;
      el.checkUpdatesBtn.focus();
    });
    el.cancelLaunchBtn.addEventListener('click', async () => {
      if (cancelling || typeof glow.cancelLaunch !== 'function') return;
      cancelling = true;
      renderProgress();
      try { await glow.cancelLaunch(); }
      catch (error) { cancelling = false; showError(errMsg(error)); renderProgress(); }
    });
    el.importBtn.addEventListener('click', importWithDialog);

    const renderFilteredLibrary = () => {
      clearTimeout(searchTimer);
      visibleLimit = 0;
      renderLibrary();
    };
    el.searchInput.addEventListener('input', () => {
      filters.q = el.searchInput.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderFilteredLibrary, 100);
    });
    el.categorySelect.addEventListener('change', () => { filters.category = el.categorySelect.value; renderFilteredLibrary(); });
    el.statusSelect.addEventListener('change', () => { filters.status = el.statusSelect.value; renderFilteredLibrary(); });
    el.sortSelect.addEventListener('change', () => { filters.sort = el.sortSelect.value; renderFilteredLibrary(); });
    const resetFilters = () => {
      filters.q = ''; filters.category = 'all'; filters.status = 'all'; filters.sort = 'name';
      el.searchInput.value = '';
      renderFilteredLibrary();
      el.searchInput.focus();
      announce('Filters cleared.');
    };
    el.clearFiltersBtn.addEventListener('click', resetFilters);
    el.resetFiltersBtn.addEventListener('click', resetFilters);

    el.modList.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const sw = target.closest('.switch');
      if (sw && !sw.disabled) { handleToggle(sw.dataset.id); return; }
      const rm = target.closest('.mod-remove');
      if (rm && !rm.disabled) handleRemove(rm.dataset.id);
    });
    el.modList.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.dataset.id) return;
      if (d.open) openDetails.add(d.dataset.id); else openDetails.delete(d.dataset.id);
    }, true);

    el.detectBtn.addEventListener('click', detectGames);
    el.browseBtn.addEventListener('click', browseGame);
    el.detectList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('.detect-select') : null;
      if (btn && !btn.disabled) selectGame(btn.dataset.exe);
    });

    el.folderInput.addEventListener('input', () => { folderDirty = true; if (!el.folderError.hidden) clearFolderError(); });
    el.folderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveFolder(); } });
    el.folderSaveBtn.addEventListener('click', () => saveFolder());
    el.folderDefaultBtn.addEventListener('click', () => saveFolder('mods'));

    el.motionSelect.addEventListener('change', () => { prefs.motion = el.motionSelect.value; savePrefs(); applyPrefs(); announce('Motion preference saved.'); });
    el.confirmDeployCheck.addEventListener('change', () => { prefs.confirmDeploy = el.confirmDeployCheck.checked; savePrefs(); announce('Preference saved.'); });

    bindDragAndDrop();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F5' && !el.dialog.open && bridgeOk) {
        e.preventDefault();
        if (!busy) loadState();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && currentView === 'library' && !el.searchInput.disabled) {
        e.preventDefault();
        el.searchInput.focus();
        el.searchInput.select();
      }
    });
  }

  function hasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.from(types).includes('Files');
  }

  function bindDragAndDrop() {
    // Never let a dropped file navigate the window.
    window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (hasFiles(e) && !el.dropZone.contains(e.target)) {
        announce('Drop ZIP files onto the import area in the Library.');
      }
    });

    let depth = 0;
    const zone = el.dropZone;
    const clear = () => { depth = 0; zone.classList.remove('is-dragover'); };

    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (!busy && bridgeOk) zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = busy || !bridgeOk ? 'none' : 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('is-dragover');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clear();
      if (busy) { announce('Glow is busy. Try again in a moment.'); return; }
      if (!bridgeOk) return;
      importDropped(e.dataTransfer ? e.dataTransfer.files : null);
    });
    window.addEventListener('dragend', clear);
  }

  /* ----------------------------------------------------------------- init */

  function init() {
    applyPrefs();
    setNavCollapsed(window.matchMedia('(max-width: 1000px)').matches);
    bindEvents();

    const required = ['state', 'detect', 'browse', 'selectGame', 'setModsFolder', 'chooseImport', 'importPaths', 'toggle', 'remove', 'launch', 'launchVanilla', 'restoreOriginal', 'clearProfiles', 'sessionState',
      'releaseFeatures', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'openMods', 'onUpdate'];
    if (!bridgeOk || required.some((k) => typeof glow[k] !== 'function')) {
      bridgeOk = false;
      render();
      showError('Glow’s desktop bridge is unavailable, so nothing can be loaded or changed. Start Glow from its desktop app.');
      el.statusText.textContent = 'Desktop bridge unavailable.';
      return;
    }

    render();
    loadState();
    glow.onUpdate(renderUpdate);
    glow.releaseFeatures().then(({ updates, mods }) => {
      el.checkUpdatesBtn.hidden = !updates;
      el.findModsBtn.hidden = !mods;
    }).catch((error) => showError(errMsg(error)));
    window.setInterval(pollSession, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
