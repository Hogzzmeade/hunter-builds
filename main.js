// Hunter Builds — desktop app
// One window shows the builds page; a second (hidden) window runs DIM with your own sign-in.
// The app reads your inventory straight from DIM, so it needs nothing else to stay up to date.
const { app, BrowserWindow, ipcMain, shell, Notification, nativeImage, session, Tray, Menu } = require('electron');
const path = require('path');
let autoUpdater = null; try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* not bundled in dev */ }
const fs = require('fs');

const DIM_HOME = 'https://app.destinyitemmanager.com/';
const REFRESH_EVERY = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

let mainWin = null, dimWin = null, tray = null, refreshing = false, busy = Promise.resolve(), lastStatus = '';
const HIDDEN_START = process.argv.includes('--hidden');
let updateReady = null;
const DATA_DIR = () => app.getPath('userData');
const file = n => path.join(DATA_DIR(), n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return d; } };

if (process.env.HB_USERDATA) app.setPath('userData', process.env.HB_USERDATA); // used for testing
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

function status(msg) {
  lastStatus = msg;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('status', msg);
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
  dimWin.loadURL(DIM_HOME);
}
function showDim(url) { if (url) dimWin.loadURL(url); dimWin.show(); dimWin.focus(); }

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
    .replace('/*__HISTORY__*/null', history ? JSON.stringify(history) : 'null');
  fs.writeFileSync(file('page.html'), html);
  mainWin.loadFile(file('page.html'));
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
    fs.writeFileSync(file('data.json'), JSON.stringify(res.data));
    const added = addHistory(res.data);
    renderPage();
    status(`Updated ${new Date().toLocaleTimeString()} · ${res.data.items.length} items`);
    if (prev && added.length) {
      const full = id => res.data.items.find(i => i.id === id) || {};
      const gods = added.filter(a => { const i = full(a.id); return i.wl && i.wl[0] === 2; });
      const exo = added.filter(a => full(a.id).ex && !(prev.exotics || []).includes(a.n));
      if (gods.length) notify('God roll dropped!', gods.map(a => a.n).join(', '));
      if (exo.length) notify('New exotic', exo.map(a => a.n).join(', '));
      const rest = added.length - gods.length - exo.length;
      if (rest > 0) notify('Hunter Builds', `${added.length} new item${added.length > 1 ? 's' : ''}: ${added.slice(0, 4).map(a => a.n).join(', ')}`);
    }
    const v = res.data.vault; if (v && v.cap && v.n / v.cap >= 0.9 && (!prev || !prev.vault || prev.vault.n / prev.vault.cap < 0.9))
      notify('Vault almost full', `${v.n} of ${v.cap} slots used. Open Vault cleanup to see what you can dismantle.`);
  } catch (e) {
    status('Refresh failed: ' + (e && e.message ? e.message : e) + '. Press Refresh now to try again.');
  } finally { refreshing = false; }
}

function addHistory(data) {
  const hist = readJson('history.json', []);
  const last = hist[hist.length - 1];
  const cur = data.items.map(i => i.id), prevIds = new Set(last ? last.ids || [] : []);
  const added = last ? data.items.filter(i => !prevIds.has(i.id)).map(i => ({ id: i.id, n: i.n })) : [];
  const curSet = new Set(cur);
  const removed = last ? [...prevIds].filter(id => !curSet.has(id)).map(id => ({ id, n: (readJson('names-cache.json', {})[id]) || '' })) : [];
  hist.forEach(h => delete h.ids);
  hist.push({ t: data.updated, power: data.power, n: cur.length, ids: cur, added, removed });
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
async function equip(p) {
  return queue(async () => {
    try {
      const lo = { id: 'hb-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), name: 'HB: ' + p.name, classType: 1, clearSpace: false, notes: p.notes || '', equipped: p.items, unequipped: [] };
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
      if (msg === 'ok') return { ok: true };
      return { ok: false, msg: msg === 'timeout' ? 'DIM did not confirm in time. Check the DIM window.' : msg };
    } catch (e) { return { ok: false, msg: e.message || String(e) }; }
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
ipcMain.on('notify', (_e, t, b) => notify(t, b));
ipcMain.handle('settings', () => ({ startup: !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin, version: app.getVersion(), update: updateReady }));
ipcMain.on('set-startup', (_e, on) => setStartup(on));
ipcMain.on('refresh', () => refresh('button'));
ipcMain.on('open-dim', () => showDim());
ipcMain.handle('status', () => lastStatus);

app.on('before-quit', () => { app.isQuitting = true; });
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
});
app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); });
