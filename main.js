// Hunter Builds — desktop app
// One window shows the builds page; a second (hidden) window runs DIM with your own sign-in.
// The app reads your inventory straight from DIM, so it needs nothing else to stay up to date.
const { app, BrowserWindow, ipcMain, shell, Notification, nativeImage, session, Tray, Menu, clipboard, net, globalShortcut, screen } = require('electron');
const os = require('os');
const path = require('path');
let autoUpdater = null; try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* not bundled in dev */ }
const fs = require('fs');

const DIM_HOME = 'https://app.destinyitemmanager.com/';
const REFRESH_EVERY = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

let compactWin = null, overlayWin = null, overlayInteract = false, hotkeys = [], lastActivity = null;
let mainWin = null, dimWin = null, tray = null, refreshing = false, busy = Promise.resolve(), lastStatus = '';
const HIDDEN_START = process.argv.includes('--hidden');
let updateReady = null;
const DATA_DIR = () => app.getPath('userData');
const file = n => path.join(DATA_DIR(), n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return d; } };

if (process.env.HB_USERDATA) app.setPath('userData', process.env.HB_USERDATA); // used for testing
if (!app.requestSingleInstanceLock()) app.quit();
// Jump List tasks start a second instance with --hb=<task>
function handleArgs(argv) {
  const a = (argv || []).find(x => /^--hb=/.test(x)); if (!a) return false; const t = a.slice(5);
  if (t === 'refresh') refresh('jumplist'); else if (t === 'compact') openCompact(); else if (/^equip:\d$/.test(t)) { const h = hotkeys[+t.slice(6)]; if (h) equip(h.payload).then(r => notify('Hunter Builds', r.ok ? `Equipped ${h.name}.` : `Could not equip: ${r.msg}`)); }
  return true;
}
app.on('second-instance', (_e, argv) => { if (handleArgs(argv)) return; if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); } });
function jumpList() {
  if (process.platform !== 'win32') return;
  try { app.setUserTasks([
    { program: process.execPath, arguments: '--hb=refresh', iconPath: process.execPath, iconIndex: 0, title: 'Refresh from DIM', description: 'Read your inventory from DIM now' },
    { program: process.execPath, arguments: '--hb=compact', iconPath: process.execPath, iconIndex: 0, title: 'Compact window', description: 'Small always-on-top window' },
    ...hotkeys.map((h, i) => ({ program: process.execPath, arguments: `--hb=equip:${i}`, iconPath: process.execPath, iconIndex: 0, title: `Equip: ${h.name}`.slice(0, 60), description: `Ctrl+Alt+${i + 1}` }))]); } catch (e) { log('jump list failed: ' + e.message); }
}

/* ---------- log file (userData/hb.log) ---------- */
function log(msg) {
  try {
    const f = file('hb.log'); const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { if (fs.statSync(f).size > 1024 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').slice(-256 * 1024)); } catch (e) {}
    fs.appendFileSync(f, line);
  } catch (e) {}
}
process.on('uncaughtException', e => log('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', e => log('unhandled: ' + (e && e.stack || e)));
function diagnostics() {
  const d = readJson('data.json', null); let tail = '';
  try { tail = fs.readFileSync(file('hb.log'), 'utf8').split('\n').slice(-80).join('\n'); } catch (e) {}
  return [`Hunter Builds ${app.getVersion()}`, `Electron ${process.versions.electron} · ${os.type()} ${os.release()} ${process.arch}`,
    `Online: ${net.isOnline()} · DIM page: ${dimWin ? dimWin.webContents.getURL().replace(/\?.*$/, '') : '-'}`,
    `Data: ${d ? `${d.items.length} items, updated ${d.updated}, subclasses ${(d.subs || []).length}, postmaster ${d.postmaster ? d.postmaster.n : '-'}` : 'none yet'}`,
    `Status: ${lastStatus}`, `Update ready: ${updateReady || 'no'}`, '', '--- last log lines ---', tail].join('\n');
}
function status(msg) {
  lastStatus = msg; log('status: ' + msg);
  for (const w of [mainWin, compactWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send('status', msg);
}

/* ---------- windows ---------- */
function createMain() {
  mainWin = new BrowserWindow({
    width: 1360, height: 900, minWidth: 420, minHeight: 500, backgroundColor: '#141a2e', show: !HIDDEN_START,
    title: 'Hunter Builds', icon: path.join(__dirname, 'app', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  // links: DIM loadouts open in the app's DIM window, everything else in the normal browser
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(DIM_HOME)) { showDim(url); return { action: 'deny' }; }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (url.startsWith(DIM_HOME)) showDim(url); else shell.openExternal(url); } });
  mainWin.on('close', e => { if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); trayHint(); } });
  mainWin.on('closed', () => { mainWin = null; });
  if (process.env.HB_SCREENSHOT) mainWin.webContents.once('did-finish-load', () => setTimeout(async () => {
    const img = await mainWin.webContents.capturePage(); fs.writeFileSync(process.env.HB_SCREENSHOT, img.toPNG());
    const r = await mainWin.webContents.executeJavaScript(`({ app: !!window.hunterApp, items: document.querySelectorAll('button.ico').length, upd: document.getElementById('m-upd') && document.getElementById('m-upd').textContent })`);
    console.log('HBTEST', JSON.stringify(r)); app.isQuitting = true; app.quit(); }, 2500));
  renderPage();
}

function createDim() {
  dimWin = new BrowserWindow({
    width: 1280, height: 860, show: false, title: 'DIM — Hunter Builds', backgroundColor: '#1b1b26',
    icon: path.join(__dirname, 'app', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { partition: 'persist:dim', contextIsolation: true, backgroundThrottling: false }
  });
  dimWin.webContents.setUserAgent(UA);
  // Bungie / platform sign-in popups stay inside the same signed-in session
  dimWin.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: 'persist:dim' } } }));
  dimWin.on('close', e => { if (!app.isQuitting) { e.preventDefault(); dimWin.hide(); } });
  dimWin.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { if (!isMain || code === -3) return; log(`DIM load failed ${code} ${desc} ${url}`);
    status(net.isOnline() ? `Could not reach DIM (${desc}). It will try again at the next refresh.` : 'Offline: no internet connection. Showing your last saved data; it refreshes when you are back online.'); });
  dimWin.loadURL(DIM_HOME);
}
function showDim(url) { if (url) dimWin.loadURL(url); dimWin.show(); dimWin.focus(); }
/* ---------- in-game overlay: transparent, always on top, click-through; no hooks into the game ---------- */
function overlayCfg() { return Object.assign({ corner: 'tr', scale: 1, opacity: 0.92 }, readJson('settings.json', {}).overlay || {}); }
function placeOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return; const c = overlayCfg(); const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.round(340 * c.scale), h = Math.round(640 * c.scale), m = 16;
  const x = c.corner.includes('l') ? wa.x + m : wa.x + wa.width - w - m, y = c.corner.includes('t') ? wa.y + m + 30 : wa.y + wa.height - h - m;
  overlayWin.setBounds({ x, y, width: w, height: h }); overlayWin.setOpacity(Math.max(0.3, Math.min(1, c.opacity)));
  overlayWin.webContents.setZoomFactor(c.scale);
}
function setOverlayInteract(on) {
  overlayInteract = !!on; if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(!overlayInteract, { forward: true }); overlayWin.setFocusable(overlayInteract);
  if (overlayInteract) overlayWin.focus(); overlayWin.webContents.send('overlay-mode', { interact: overlayInteract, cfg: overlayCfg() });
}
function toggleOverlay(force) {
  if (overlayWin && !overlayWin.isDestroyed()) { const show = force != null ? force : !overlayWin.isVisible(); if (show) { overlayWin.showInactive(); placeOverlay(); } else overlayWin.hide(); saveSettings({ overlayOn: show }); return; }
  if (force === false || !fs.existsSync(file('page.html'))) return;
  overlayWin = new BrowserWindow({ width: 340, height: 560, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false, alwaysOnTop: true, title: 'Hunter Builds overlay',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  overlayWin.setAlwaysOnTop(true, 'screen-saver'); overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith(DIM_HOME)) showDim(url); else if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  overlayWin.loadFile(file('page.html'), { hash: 'overlay' });
  overlayWin.once('ready-to-show', () => { placeOverlay(); overlayWin.showInactive(); });
  overlayWin.webContents.on('did-finish-load', () => overlayWin.webContents.send('overlay-mode', { interact: overlayInteract, cfg: overlayCfg() }));
  overlayWin.on('closed', () => { overlayWin = null; overlayInteract = false; });
  saveSettings({ overlayOn: true });
}
// small always-on-top window with the current build and an Equip button
function openCompact() {
  if (compactWin && !compactWin.isDestroyed()) { compactWin.show(); compactWin.focus(); return; }
  if (!fs.existsSync(file('page.html'))) return;
  compactWin = new BrowserWindow({ width: 380, height: 600, minWidth: 320, minHeight: 360, alwaysOnTop: true, title: 'Hunter Builds — compact', backgroundColor: '#141a2e',
    icon: path.join(__dirname, 'app', 'icon.png'), autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false } });
  compactWin.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith(DIM_HOME)) showDim(url); else if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  compactWin.loadFile(file('page.html'), { hash: 'compact' });
  compactWin.on('closed', () => { compactWin = null; });
}

/* ---------- page ---------- */
function renderPage() {
  const data = readJson('data.json', null);
  if (!data) {
    mainWin.loadFile(path.join(__dirname, 'app', 'welcome.html'));
    return;
  }
  const tpl = fs.readFileSync(path.join(__dirname, 'app', 'template.html'), 'utf8');
  const history = readJson('history.json', null);
  const html = tpl
    .replace('/*__DATA__*/', JSON.stringify(data).replace(/<\//g, '<\\/'))
    .replace('/*__SPR_ITEMS__*/', fs.readFileSync(file('items.url'), 'utf8'))
    .replace('/*__SPR_PLUGS__*/', fs.readFileSync(file('plugs.url'), 'utf8'))
    .replace('/*__HISTORY__*/null', history ? JSON.stringify(history) : 'null')
  fs.writeFileSync(file('page.html'), html);
  mainWin.loadFile(file('page.html'));
  if (compactWin && !compactWin.isDestroyed()) compactWin.loadFile(file('page.html'), { hash: 'compact' });
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.loadFile(file('page.html'), { hash: 'overlay' });
}

/* ---------- export from DIM ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROBE = `(() => {
  if (/\\/login/.test(location.pathname) || /Authorize with Bungie/i.test(document.body ? document.body.innerText : '')) return 'login';
  for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (!k) continue;
    let r = e[k]; while (r.return) r = r.return; const q = [r]; let c = 0;
    while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps;
      if (p && p.store && p.store.getState) { const s = p.store.getState(); return s.inventory && s.inventory.stores && s.inventory.stores.length && s.manifest ? 'ready' : 'loading'; }
      if (x.child) q.push(x.child); if (x.sibling) q.push(x.sibling); }
    return 'loading'; }
  return 'loading'; })()`;

async function waitForDim(maxMs) {
  const t0 = Date.now(); let shownForLogin = false;
  while (Date.now() - t0 < maxMs) {
    let st = 'loading';
    try { st = await dimWin.webContents.executeJavaScript(PROBE, true); } catch (e) {}
    if (st === 'ready') return true;
    if (st === 'login' && !shownForLogin) { shownForLogin = true; status('Signing in: use the DIM window to sign in with Bungie.net.'); showDim(); }
    await sleep(2000);
  }
  return false;
}

async function refresh(reason) { return queue(() => doRefresh(reason)); }
async function doRefresh(reason) {
  if (refreshing) return; refreshing = true;
  try {
    log('refresh: ' + reason); if (mainWin) mainWin.setProgressBar(2);
    if (!net.isOnline()) { status('Offline: no internet connection. Showing your last saved data; it refreshes when you are back online.'); return; }
    status('Refreshing from DIM…');
    const url = dimWin.webContents.getURL();
    if (!/\/d2\/inventory/.test(url)) {
      const acct = (url.match(/destinyitemmanager\.com\/(\d+)\/d2/) || [])[1] || readJson('account.json', {}).id;
      dimWin.loadURL(acct ? `${DIM_HOME}${acct}/d2/inventory` : DIM_HOME);
      await sleep(1500);
    }
    if (!(await waitForDim(10 * 60 * 1000))) { status('Waiting for DIM: sign in or check your connection, then press Refresh now.'); return; }
    const acct = (dimWin.webContents.getURL().match(/destinyitemmanager\.com\/(\d+)\/d2/) || [])[1];
    if (acct) fs.writeFileSync(file('account.json'), JSON.stringify({ id: acct }));
    // let DIM pull a fresh profile from Bungie first
    try { await dimWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('[title*="Refresh"], [aria-label*="Refresh"]'); if (b) b.click(); return !!b; })()`, true); } catch (e) {}
    await sleep(6000);
    const src = fs.readFileSync(path.join(__dirname, 'app', 'dimexport.js'), 'utf8');
    const names = fs.readFileSync(path.join(__dirname, 'app', 'names.json'), 'utf8');
    const res = await dimWin.webContents.executeJavaScript(`(async () => { ${src}\n return await dimExport('app', ${names}); })()`, true);
    if (!res || !res.data || !Array.isArray(res.data.items)) throw new Error('DIM returned no data');
    if (acct) res.data.account = acct;
    const prev = readJson('data.json', null);
    fs.writeFileSync(file('data.json'), JSON.stringify(res.data));
    fs.writeFileSync(file('items.url'), res.items);
    fs.writeFileSync(file('plugs.url'), res.plugs);
    // weekly milestones + Xûr: open DIM's vendors page so DIM loads vendor data, then read it
    try {
      const acct2 = acct || readJson('account.json', {}).id;
      if (acct2) { dimWin.loadURL(`${DIM_HOME}${acct2}/d2/vendors`); await sleep(2000); await waitForDim(90 * 1000); await sleep(8000); }
      res.data.weekly = await dimWin.webContents.executeJavaScript(`(async () => { ${src}\n return await dimWeekly(); })()`, true);
      if (acct2) dimWin.loadURL(`${DIM_HOME}${acct2}/d2/inventory`);
    } catch (e) { res.data.weekly = prev && prev.weekly ? prev.weekly : null; }
    const wk = res.data.weekly && res.data.weekly.xur && res.data.weekly.xur.items && res.data.weekly.xur.items.length ? weekKey(new Date()) : null;
    if (wk && readJson('settings.json', {}).xurWeek !== wk) { saveSettings({ xurWeek: wk }); notify('Xûr is here', res.data.weekly.xur.items.filter(i => i.ex).map(i => i.n).join(', ') || 'Open This week to see what he sells.'); }
    fs.writeFileSync(file('data.json'), JSON.stringify(res.data));
    const added = addHistory(res.data);
    renderPage();
    status(`Updated ${new Date().toLocaleTimeString()} · ${res.data.items.length} items`);
    if (prev && added.length) {
      const full = id => res.data.items.find(i => i.id === id) || {};
      const gods = added.filter(a => { const i = full(a.id); return i.wl && i.wl[0] === 2; });
      const exo = added.filter(a => full(a.id).ex && !(prev.exotics || []).includes(a.n));
      if (gods.length) notify('God roll dropped!', gods.map(a => a.n).join(', '));
      const trash = added.filter(a => { const i = full(a.id); return i.w && i.wl && i.wl[0] === -1; });
      if (trash.length) notify('Trash roll' + (trash.length > 1 ? 's' : ''), `${trash.map(a => a.n).join(', ')}. Open Hunter Builds to tag ${trash.length > 1 ? 'them' : 'it'} as Junk.`);
      if (exo.length) notify('New exotic', exo.map(a => a.n).join(', '));
      const rest = added.length - gods.length - exo.length;
      if (rest > 0) notify('Hunter Builds', `${added.length} new item${added.length > 1 ? 's' : ''}: ${added.slice(0, 4).map(a => a.n).join(', ')}`);
    }
    // vendors selling a weapon your builds recommend (once per week per item)
    try { const wk = weekKey(new Date()); const seen = readJson('settings.json', {}).vendorSeen || {}; const sk = seen.w === wk ? seen.items : []; const rec = readJson('recweapons.json', []);
      const hits = ((res.data.weekly && res.data.weekly.vendors) || []).flatMap(v => v.items.filter(i => i.w && rec.includes(i.n) && !sk.includes(i.n)).map(i => `${i.n} (${v.v})`));
      if (hits.length) { notify('Vendor has a weapon for your builds', hits.join(', ')); saveSettings({ vendorSeen: { w: wk, items: [...sk, ...hits.map(h => h.replace(/ \(.*$/, ''))] } }); } } catch (e) { log('vendor check: ' + e.message); }
    const v = res.data.vault; if (v && v.cap && v.n / v.cap >= 0.9 && (!prev || !prev.vault || prev.vault.n / prev.vault.cap < 0.9))
      notify('Vault almost full', `${v.n} of ${v.cap} slots used. Open Vault cleanup to see what you can dismantle.`);
    const pm = res.data.postmaster; if (pm && pm.n >= pm.cap - 3 && (!prev || !prev.postmaster || prev.postmaster.n < pm.cap - 3))
      notify('Postmaster almost full', `${pm.n} of ${pm.cap}: ${pm.items.slice(0, 3).map(i => i[0]).join(', ')}. Pull them before new drops are lost.`);
    if (mainWin) { mainWin.setProgressBar(1); setTimeout(() => mainWin && mainWin.setProgressBar(-1), 1500); }
  } catch (e) {
    if (mainWin) { mainWin.setProgressBar(1, { mode: 'error' }); setTimeout(() => mainWin && mainWin.setProgressBar(-1), 4000); }
    log('refresh error: ' + (e && e.stack || e));
    status('Refresh failed: ' + (e && e.message ? e.message : e) + '. Press Refresh now to try again.');
  } finally { refreshing = false; }
}

// week number counted from the Tuesday 17:00 UTC reset
function weekKey(d) { return Math.floor((d.getTime() - Date.UTC(2020, 0, 7, 17)) / (7 * 864e5)); }
/* ---------- activity: which build fits what you are playing ---------- */
async function pollActivity() {
  if (refreshing || !dimWin || !/\/d2\//.test(dimWin.webContents.getURL())) return;
  try {
    await dimWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('[title*="Refresh"], [aria-label*="Refresh"]'); if (b) b.click(); })()`, true);
    await sleep(5000);
    const src = fs.readFileSync(path.join(__dirname, 'app', 'dimexport.js'), 'utf8');
    const a = await dimWin.webContents.executeJavaScript(`(() => { ${src}\n return dimActivity(); })()`, true);
    if (!a) return;
    try { const t = await dimWin.webContents.executeJavaScript(`(async () => { ${src}\n return await dimTasks(); })()`, true);
      if (t && t.tasks) { const prevT = readJson('tasks.json', null); fs.writeFileSync(file('tasks.json'), JSON.stringify(t)); for (const w of [mainWin, compactWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send('tasks', t);
        if (prevT && prevT.tasks) { const was = new Set(prevT.tasks.filter(x => x.done).map(x => x.n)); const now = t.tasks.filter(x => x.done && !was.has(x.n)); if (now.length) notify('Weekly done ✓', now.map(x => x.n).join(', ')); } } } catch (e) { log('tasks poll: ' + e.message); }
    const kind = !a.in ? 'none' : a.opp > 0 ? 'PvP' : a.players >= 4 ? 'Raid' : a.players >= 2 ? 'GM' : 'Solo';
    const act = Object.assign({ kind, t: Date.now() }, a);
    const changed = !lastActivity || lastActivity.kind !== kind; lastActivity = act;
    if (changed) { log('activity: ' + kind); for (const w of [mainWin, compactWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send('activity', act); }
  } catch (e) { log('activity poll failed: ' + e.message); }
}
/* ---------- global hotkeys: Ctrl+Alt+1..3 equip pinned builds ---------- */
function setHotkeys(list) {
  hotkeys = (list || []).slice(0, 3);
  globalShortcut.unregisterAll();
  jumpList();
  try { globalShortcut.register('CommandOrControl+Alt+O', () => toggleOverlay()); globalShortcut.register('CommandOrControl+Alt+I', () => { if (!overlayWin || !overlayWin.isVisible()) toggleOverlay(true); setOverlayInteract(!overlayInteract); }); } catch (e) { log('overlay keys: ' + e.message); }
  hotkeys.forEach((h, i) => { try { globalShortcut.register(`CommandOrControl+Alt+${i + 1}`, () => { notify('Hunter Builds', `Equipping ${h.name}…`); equip(h.payload).then(r => notify('Hunter Builds', r.ok ? `Equipped ${h.name}.` : `Could not equip: ${r.msg}`)); }); } catch (e) { log('hotkey failed: ' + e.message); } });
}
/* ---------- backup of DIM loadouts, tags and saved builds ---------- */
async function backup(pageData) {
  return queue(async () => {
    try {
      let dim = null;
      try { dim = await dimWin.webContents.executeJavaScript(`(() => { for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (!k) continue;
        let r = e[k]; while (r.return) r = r.return; const q = [r]; let c = 0;
        while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps;
          if (p && p.store && p.store.getState) { const s = p.store.getState(); return { profiles: s.dimApi.profiles, itemHashTags: s.dimApi.itemHashTags, searches: s.dimApi.searches }; }
          if (x.child) q.push(x.child); if (x.sibling) q.push(x.sibling); } return null; } return null; })()`, true); } catch (e) { log('backup dim read failed: ' + e.message); }
      const dir = path.join(app.getPath('documents'), 'Hunter Builds backups'); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
      const out = { made: new Date().toISOString(), app: app.getVersion(), dim, page: pageData || null, settings: readJson('settings.json', {}), history: readJson('history.json', []) };
      fs.writeFileSync(f, JSON.stringify(out, null, 1)); shell.showItemInFolder(f); log('backup: ' + f);
      const n = dim && dim.profiles ? Object.values(dim.profiles).reduce((t, pr) => t + Object.keys(pr.loadouts || {}).length, 0) : 0;
      return { ok: true, file: f, loadouts: n };
    } catch (e) { return { ok: false, msg: e.message }; }
  });
}
function addHistory(data) {
  const hist = readJson('history.json', []);
  const last = hist[hist.length - 1];
  const cur = data.items.map(i => i.id), prevIds = new Set(last ? last.ids || [] : []);
  const added = last ? data.items.filter(i => !prevIds.has(i.id)).map(i => ({ id: i.id, n: i.n })) : [];
  const curSet = new Set(cur);
  const removed = last ? [...prevIds].filter(id => !curSet.has(id)).map(id => ({ id, n: (readJson('names-cache.json', {})[id]) || '' })) : [];
  hist.forEach(h => delete h.ids);
  hist.push({ t: data.updated, power: data.power, n: cur.length, vn: data.vault ? data.vault.n : null, ids: cur, added, removed });
  fs.writeFileSync(file('history.json'), JSON.stringify(hist.slice(-400)));
  const cache = readJson('names-cache.json', {}); data.items.forEach(i => { cache[i.id] = i.n; }); fs.writeFileSync(file('names-cache.json'), JSON.stringify(cache));
  return added;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: nativeImage.createFromPath(path.join(__dirname, 'app', 'icon.png')) });
  n.on('click', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } }); n.show();
}
let hinted = false;
function trayHint() { if (hinted || readJson('settings.json', {}).hinted) return; hinted = true; notify('Hunter Builds is still running', 'It keeps refreshing in the tray. Right-click the tray icon to quit.'); saveSettings({ hinted: true }); }
function saveSettings(p) { fs.writeFileSync(file('settings.json'), JSON.stringify(Object.assign(readJson('settings.json', {}), p))); }
function setStartup(on) { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); saveSettings({ startup: !!on }); buildTrayMenu(); }
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Hunter Builds', click: () => { mainWin.show(); mainWin.focus(); } },
    ...(updateReady ? [{ label: `Restart to update to ${updateReady}`, click: () => installUpdate() }] : []),
    { label: 'Refresh now', click: () => refresh('tray') },
    { label: 'Open DIM', click: () => showDim() },
    { label: 'Compact window', click: () => openCompact() },
    { label: 'In-game overlay (Ctrl+Alt+O)', click: () => toggleOverlay() },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin, click: m => setStartup(m.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'app', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Hunter Builds');
  tray.on('click', () => { if (mainWin.isVisible() && mainWin.isFocused()) mainWin.hide(); else { mainWin.show(); mainWin.focus(); } });
  buildTrayMenu();
}

/* DIM actions run one at a time in the DIM window */
function queue(job) { const p = busy.then(job, job); busy = p.catch(() => {}); return p; }
const js = code => dimWin.webContents.executeJavaScript(code, true);
const FIND_BTN = `(label) => [...document.querySelectorAll('button')].filter(b => b.offsetParent).find(b => b.innerText.trim() === label)`;
async function dimGo(pathPart) {
  const acct = readJson('account.json', {}).id; if (!acct) throw new Error('Sign in to DIM first');
  dimWin.loadURL(`${DIM_HOME}${acct}/d2/${pathPart}`); await sleep(1500);
  if (!(await waitForDim(120 * 1000))) throw new Error('DIM did not load');
  await sleep(2500);
}
// what the Hunter wears right now (with subclass setup), so the last equip can be undone
const SNAPSHOT = `(() => {
  for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (!k) continue;
    let r = e[k]; while (r.return) r = r.return; const q = [r]; let c = 0;
    while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps;
      if (p && p.store && p.store.getState) { const s = p.store.getState(); const h = (s.inventory.stores || []).find(z => z.classType === 1 && !z.isVault); if (!h) return null;
        return h.items.filter(i => i.equipped && (['Weapons', 'Armor'].includes(i.bucket.sort) || i.bucket.name === 'Subclass')).map(i => {
          const o = { id: i.id, hash: i.hash };
          if (i.bucket.name === 'Subclass' && i.sockets) { o.socketOverrides = {}; i.sockets.allSockets.forEach(sk => { if (sk.plugged) o.socketOverrides[sk.socketIndex] = sk.plugged.plugDef.hash; }); }
          return o; }); }
      if (x.child) q.push(x.child); if (x.sibling) q.push(x.sibling); }
    return null; }
  return null; })()`;
async function equip(p) {
  return queue(async () => {
    try {
      log(`equip: ${p.name} (${p.items.length} items, ${(p.mods || []).length} mods)`);
      if (!p.undo) { try { await dimGo('inventory'); const snap = await js(SNAPSHOT); if (snap && snap.length) fs.writeFileSync(file('undo.json'), JSON.stringify({ t: Date.now(), from: p.name, items: snap })); } catch (e) { log('snapshot failed: ' + e.message); } }
      const lo = { id: 'hb-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), name: 'HB: ' + p.name, classType: 1, clearSpace: false, notes: p.notes || '', equipped: p.items, unequipped: [] };
      if (p.mods && p.mods.length) lo.parameters = { mods: p.mods };
      if (p.look && Object.keys(p.look).length) lo.parameters = Object.assign(lo.parameters || {}, { modsByBucket: p.look });
      await dimGo('loadouts?loadout=' + encodeURIComponent(JSON.stringify(lo)));
      // save the loadout from DIM's editor (new: "Save", existing: "Save Changes")
      const saved = await js(`(async () => { for (let i = 0; i < 20; i++) { const f = [...document.querySelectorAll('form button[type=submit]')].find(b => b.offsetParent && !b.disabled); if (f) { f.click(); return true; } await new Promise(r => setTimeout(r, 500)); } return false; })()`);
      if (!saved) throw new Error('DIM loadout editor did not open');
      await sleep(2500);
      const name = JSON.stringify(lo.name);
      const clicked = await js(`(async () => { for (let i = 0; i < 20; i++) {
        const hit = [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === 'Apply').map(b => { let el = b; for (let k = 0; k < 6 && el; k++) { if (el.innerText.startsWith(${name} + '\\n')) return b; el = el.parentElement; } return null; }).find(Boolean);
        if (hit) { hit.click(); return true; } await new Promise(r => setTimeout(r, 500)); } return false; })()`);
      if (!clicked) throw new Error('Saved loadout not found in DIM');
      const msg = await js(`(async () => { for (let i = 0; i < 120; i++) { const n = [...document.querySelectorAll('[class*=otification]')].map(x => x.innerText).join(' | ');
        if (/succeeded/i.test(n)) return 'ok'; if (/fail|error|couldn|unable/i.test(n)) return n.replace(/\\s+/g, ' ').slice(0, 220); await new Promise(r => setTimeout(r, 500)); } return 'timeout'; })()`);
      setTimeout(() => refresh('after-equip'), 3000);
      log('equip result: ' + msg);
      if (msg === 'ok') return { ok: true };
      return { ok: false, msg: msg === 'timeout' ? 'DIM did not confirm in time. Check the DIM window.' : msg };
    } catch (e) { log('equip error: ' + (e.stack || e)); return { ok: false, msg: e.message || String(e) }; }
  });
}
async function bulk(p) {
  return queue(async () => {
    try {
      await dimGo('inventory');
      const ids = p.ids.filter(x => /^\d+$/.test(x));
      for (let i = 0; i < ids.length; i += 40) {
        const query = ids.slice(i, i + 40).map(id => 'id:' + id).join(' or ');
        const ok = await js(`(async () => {
          const inp = document.querySelector('input[placeholder*="Search"]'); if (!inp) return 'no search box';
          inp.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, ${JSON.stringify(query)}); inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 1500));
          const menu = [...document.querySelectorAll('button')].find(b => (b.title || b.getAttribute('aria-label') || '') === 'Open Search Actions'); if (!menu) return 'no actions menu';
          menu.click(); await new Promise(r => setTimeout(r, 700));
          const opt = [...document.querySelectorAll('[role=option], [role=menuitem], li')].filter(e => e.offsetParent).find(e => e.innerText.trim() === ${JSON.stringify(p.action)});
          if (!opt) return 'action not found'; opt.click(); await new Promise(r => setTimeout(r, 4000));
          const cl = [...document.querySelectorAll('button')].find(b => (b.title || b.getAttribute('aria-label') || '') === 'Clear search filter'); if (cl) cl.click();
          return 'ok'; })()`);
        if (ok !== 'ok') throw new Error(ok);
      }
      setTimeout(() => refresh('after-bulk'), 2000);
      return { ok: true };
    } catch (e) { return { ok: false, msg: e.message || String(e) }; }
  });
}

/* ---------- automatic updates from GitHub Releases ---------- */
function sendUpdate() { if (mainWin && !mainWin.isDestroyed() && updateReady) mainWin.webContents.send('update', updateReady); }
function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => status(`Downloading update ${i.version}…`));
  autoUpdater.on('update-downloaded', i => { updateReady = i.version; notify('Update ready', `Hunter Builds ${i.version} is downloaded. Restart the app to install it.`); sendUpdate(); buildTrayMenu(); });
  autoUpdater.on('error', () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000); setInterval(check, REFRESH_EVERY);
}
function installUpdate() { if (!updateReady || !autoUpdater) return; app.isQuitting = true; autoUpdater.quitAndInstall(true, true); }

/* ---------- ipc ---------- */
ipcMain.on('install-update', () => installUpdate());
ipcMain.handle('equip', (_e, p) => equip(p));
ipcMain.handle('bulk', (_e, p) => bulk(p));
ipcMain.on('compact', () => openCompact());
ipcMain.on('overlay-toggle', () => toggleOverlay());
ipcMain.on('overlay-interact', (_e, on) => setOverlayInteract(on));
ipcMain.on('overlay-cfg', (_e, c) => { const cur = overlayCfg(); saveSettings({ overlay: Object.assign(cur, c || {}) }); placeOverlay(); if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay-mode', { interact: overlayInteract, cfg: overlayCfg() }); });
ipcMain.on('open-main', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
ipcMain.on('set-hotkeys', (_e, list) => setHotkeys(list));
ipcMain.on('rec-weapons', (_e, list) => { try { fs.writeFileSync(file('recweapons.json'), JSON.stringify(list || [])); } catch (e) {} });
ipcMain.handle('activity', () => lastActivity);
ipcMain.handle('tasks', () => readJson('tasks.json', null));
ipcMain.handle('backup', (_e, d) => backup(d));
ipcMain.handle('copy-image', (_e, url) => { try { clipboard.writeImage(nativeImage.createFromDataURL(url)); return true; } catch (e) { return false; } });
// the shaders and ornaments you wear now, per armor bucket, for DIM's modsByBucket
ipcMain.handle('get-look', () => queue(async () => { try { await dimGo('inventory'); return await js(`(() => {
  for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (!k) continue;
    let r = e[k]; while (r.return) r = r.return; const q = [r]; let c = 0;
    while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps;
      if (p && p.store && p.store.getState) { const h = p.store.getState().inventory.stores.find(z => z.classType === 1 && !z.isVault); const out = {};
        for (const i of h.items.filter(i => i.equipped && i.bucket.sort === 'Armor')) { const cat = (i.sockets && i.sockets.categories || []).find(c => /COSMETIC/i.test(c.category.displayProperties.name));
          if (!cat) continue; out[i.bucket.hash] = cat.socketIndexes.map(ix => i.sockets.allSockets.find(z => z.socketIndex === ix)).filter(sk => sk && sk.plugged && !/^Default|^Empty/.test(sk.plugged.plugDef.displayProperties.name)).map(sk => sk.plugged.plugDef.hash); }
        return out; }
      if (x.child) q.push(x.child); if (x.sibling) q.push(x.sibling); }
    return null; }
  return null; })()`); } catch (e) { log('get-look: ' + e.message); return null; } }));
// Monday evening reminder if the weekly checklist isn't done
let weekStatus = null;
ipcMain.on('week-status', (_e, s) => { weekStatus = s; });
setInterval(() => { const n = new Date(); if (n.getDay() !== 1 || n.getHours() < 19 || !weekStatus) return; const wk = weekKey(n); const st = readJson('settings.json', {});
  if (st.remindWeek === wk || weekStatus.done >= weekStatus.total) return; saveSettings({ remindWeek: wk });
  notify('Weekly reset tomorrow', `${weekStatus.total - weekStatus.done} of ${weekStatus.total} weekly activities are still open: ${(weekStatus.open || []).slice(0, 3).join(', ')}.`); }, 15 * 60 * 1000);
ipcMain.handle('undo', () => { const u = readJson('undo.json', null); if (!u || !u.items) return { ok: false, msg: 'Nothing to undo yet.' }; return equip({ name: 'Previous gear', notes: `Gear before "${u.from}"`, items: u.items, undo: true }); });
ipcMain.handle('diagnostics', () => { const t = diagnostics(); clipboard.writeText(t); return t; });
ipcMain.on('notify', (_e, t, b) => notify(t, b));
ipcMain.handle('settings', () => ({ startup: !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin, version: app.getVersion(), update: updateReady }));
ipcMain.on('set-startup', (_e, on) => setStartup(on));
ipcMain.on('refresh', () => refresh('button'));
ipcMain.on('open-dim', () => showDim());
ipcMain.handle('status', () => lastStatus);

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.whenReady().then(() => {
  session.fromPartition('persist:dim').setUserAgent(UA);
  createDim();
  createMain();
  createTray();
  setupUpdates();
  mainWin.webContents.on('did-finish-load', sendUpdate);
  const data = readJson('data.json', null);
  const age = data ? Date.now() - new Date(data.updated).getTime() : Infinity;
  if (age > 30 * 60 * 1000) setTimeout(() => refresh('startup'), 1500);
  setInterval(() => refresh('timer'), REFRESH_EVERY);
  let wasOnline = net.isOnline(); setInterval(() => { const on = net.isOnline(); if (on && !wasOnline) { log('back online'); refresh('online'); } wasOnline = on; }, 30 * 1000);
  setInterval(pollActivity, 3 * 60 * 1000);
  jumpList(); handleArgs(process.argv);
  setHotkeys(hotkeys);
  if (readJson('settings.json', {}).overlayOn) setTimeout(() => toggleOverlay(true), 4000);
  screen.on('display-metrics-changed', placeOverlay);
  // Xûr arrives Friday 17:00 UTC: refresh soon after so the notification comes on time
  setInterval(() => { const n = new Date(); if (n.getUTCDay() === 5 && n.getUTCHours() === 17 && n.getUTCMinutes() >= 10 && n.getUTCMinutes() < 20) refresh('xur'); }, 10 * 60 * 1000);
  log(`start ${app.getVersion()}`);
});
app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); });
