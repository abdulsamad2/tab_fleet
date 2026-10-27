'use strict';

const {
  app, BrowserWindow, WebContentsView, Menu, Notification, clipboard, dialog, ipcMain, safeStorage, session,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeConfig, validateConfig, createPool, fetchRemoteProxyList, proxyRule, proxyLabel, toURL } = require('./proxy');

const SHARED_PARTITION = 'persist:shared';
const MAX_PROXY_AUTH_ATTEMPTS = 2;
const TIMER_PRESETS = [1, 2, 5, 10, 15, 30, 60];
const TAB_COLORS = [
  ['Red', '#e03131'], ['Orange', '#f76707'], ['Amber', '#f59f00'], ['Yellow', '#fcc419'], ['Lime', '#74b816'],
  ['Green', '#2f9e44'], ['Teal', '#0ca678'], ['Cyan', '#1098ad'], ['Sky', '#339af0'], ['Blue', '#1c7ed6'],
  ['Indigo', '#4263eb'], ['Violet', '#7048e8'], ['Purple', '#ae3ec9'], ['Pink', '#d6336c'], ['Rose', '#f06595'],
  ['Brown', '#8d5524'], ['Olive', '#82c91e'], ['Slate', '#495057'], ['Silver', '#adb5bd'], ['Black', '#111111'],
].map(([name, hex]) => ({ name, hex }));

let win = null;
let config = loadConfig();
let mode = 'launcher'; // 'launcher' | 'browser'
let insets = { top: 0, right: 0 };

// Browser session state; reset by startSession().
let pool = null;
let sharedProxy = null;
let tabs = [];
let selectedId = null;
let nextSlot = 1;

// ---------- Config & snippets ----------

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8')));
  } catch {
    return normalizeConfig();
  }
}

function writeData(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataPath(name), JSON.stringify(value, null, 2));
}

/** Quick-fill snippets; values are encrypted with the OS keychain (macOS Keychain / Windows DPAPI) when available. */
async function loadSnippets() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(dataPath('snippets.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = [];
  for (const snippet of stored) {
    try {
      const value = snippet.encrypted
        ? (await safeStorage.decryptStringAsync(Buffer.from(snippet.encrypted, 'base64'))).result
        : (snippet.value ?? '');
      list.push({ id: snippet.id, label: snippet.label, secret: Boolean(snippet.secret), value });
    } catch {
      // Unreadable on this machine (e.g. copied from another computer); drop it.
    }
  }
  return list;
}

async function saveSnippets(list) {
  const canEncrypt = await safeStorage.isAsyncEncryptionAvailable();
  const stored = [];
  for (const snippet of list) {
    const value = String(snippet.value ?? '');
    stored.push({
      id: snippet.id || randomUUID(),
      label: String(snippet.label ?? '').slice(0, 60),
      secret: Boolean(snippet.secret),
      ...(canEncrypt ? { encrypted: (await safeStorage.encryptStringAsync(value)).toString('base64') } : { value }),
    });
  }
  writeData('snippets.json', stored);
}

// ---------- Sessions & proxies ----------

/**
 * Points a session at a proxy and drops pooled connections so the next request uses the new exit IP.
 * The auth cache is cleared too: rotating gateways keep the same host, and Chromium would otherwise
 * keep sending the previous session's username.
 */
async function applyProxy(ses, proxy) {
  await ses.setProxy(proxy ? { proxyRules: proxyRule(proxy), proxyBypassRules: '<local>' } : { mode: 'direct' });
  await ses.clearAuthCache();
  await ses.closeAllConnections();
}

async function startSession(newConfig) {
  config = newConfig;
  writeData('config.json', config);
  const runtimeConfig = config.proxySource === 'remote'
    ? { ...config, proxySource: 'list', proxyList: await fetchRemoteProxyList(config.remote) }
    : config;
  pool = createPool(runtimeConfig);
  tabs = [];
  selectedId = null;
  nextSlot = 1;
  sharedProxy = null;
  if (config.isolation === 'shared') {
    sharedProxy = config.startDirect ? null : pool.next();
    await applyProxy(session.fromPartition(SHARED_PARTITION), sharedProxy);
  }
  mode = 'browser';
  for (let i = 0; i < config.tabCount; i++) createTab({ select: i === 0 });
  sendState();
}

function endSession() {
  for (const tab of tabs) destroyTab(tab);
  tabs = [];
  selectedId = null;
  mode = 'launcher';
  sendState();
}

/** Per-tab proxy features need each tab to own its session. */
function perTabProxies() {
  return mode === 'browser' && config.isolation === 'perTab' && Boolean(pool?.enabled);
}

function newPartition() {
  // No "persist:" prefix: an in-memory session that disappears when the app quits.
  return `tab-${randomUUID()}`;
}

function releasePartition(partition) {
  if (partition === SHARED_PARTITION || tabs.some((t) => t.partition === partition)) return;
  session.fromPartition(partition).clearStorageData().catch(() => {});
}

// ---------- Tabs ----------

function createTab({ url = config.startURL, opener = null, after = null, select = true } = {}) {
  const tab = {
    id: randomUUID(),
    slot: 0,
    partition: SHARED_PARTITION,
    proxy: null,
    region: pool.regions[0] ?? null,
    view: null,
    error: null,
    lastURL: toURL(url),
    authAttempts: 0,
    color: null,
    note: '',
    timer: null,
    timerDone: false,
  };
  let ready = Promise.resolve();
  if (opener) {
    // Popups stay in their opener's session so logins and the IP carry over.
    Object.assign(tab, { partition: opener.partition, proxy: opener.proxy, region: opener.region, slot: opener.slot, color: opener.color });
  } else if (config.isolation === 'shared') {
    Object.assign(tab, { proxy: sharedProxy, slot: nextSlot++ });
  } else {
    Object.assign(tab, { partition: newPartition(), slot: nextSlot++ });
    tab.proxy = config.startDirect ? null : pool.next(tab.region);
  }

  tab.view = createView(tab);
  if (!opener && config.isolation === 'perTab') ready = applyProxy(tab.view.webContents.session, tab.proxy);

  const anchor = after ? tabs.indexOf(after) : -1;
  if (anchor === -1) tabs.push(tab);
  else tabs.splice(anchor + 1, 0, tab);

  ready
    .then(() => loadInTab(tab, url))
    .catch((error) => {
      tab.error = `Proxy setup failed: ${error.message}`;
      sendState();
    });
  if (select) selectTab(tab.id);
  else sendState();
  return tab;
}

function createView(tab) {
  const view = new WebContentsView({
    webPreferences: { partition: tab.partition, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const contents = view.webContents;
  // Burn swaps a tab's view; events still arriving from the old one must not touch the tab.
  const current = () => tab.view === view;
  const update = () => current() && sendState();
  for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading']) {
    contents.on(event, update);
  }
  contents.on('did-start-loading', () => {
    if (!current()) return;
    tab.error = null;
    sendState();
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!current() || !isMainFrame || code === -3) return; // -3: aborted (navigated away / download)
    tab.error = `${description || 'Load failed'} (${code})`;
    sendState();
  });
  contents.on('render-process-gone', (_event, details) => {
    if (!current()) return;
    tab.error = `Page stopped (${details.reason}). Reload to try again.`;
    sendState();
  });
  contents.setWindowOpenHandler(({ url }) => {
    createTab({ url, opener: tab, after: tab });
    return { action: 'deny' };
  });
  contents.on('before-input-event', (event, input) => {
    // Electron menus don't see Ctrl+Tab while a page has focus on Windows.
    if (input.type === 'keyDown' && input.control && input.key === 'Tab') {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
    }
  });
  return view;
}

function loadInTab(tab, input) {
  const url = toURL(input);
  if (!url) return;
  tab.lastURL = url;
  tab.error = null;
  tab.view.webContents.loadURL(url).catch(() => {}); // failures are reported through did-fail-load
}

function reloadTab(tab) {
  tab.error = null;
  if (tab.view.webContents.getURL()) tab.view.webContents.reload();
  else loadInTab(tab, tab.lastURL);
}

function destroyView(view) {
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function destroyTab(tab) {
  clearTimer(tab);
  destroyView(tab.view);
}

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index === -1) return;
  tabs.splice(index, 1);
  destroyTab(tab);
  releasePartition(tab.partition);
  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (selectedId === tab.id) selectTab((tabs[index] ?? tabs[tabs.length - 1]).id);
  else sendState();
}

function duplicateTab(tab) {
  const copy = createTab({ url: tab.view.webContents.getURL() || tab.lastURL, after: tab, select: false });
  copy.color = tab.color;
  selectTab(copy.id);
}

/** Gives every tab that shares this tab's session a new proxy; cookies are kept. */
async function setSessionProxy(tab, proxy, { reload }) {
  for (const t of tabs) {
    if (t.partition === tab.partition) {
      t.proxy = proxy;
      t.authAttempts = 0;
    }
  }
  try {
    await applyProxy(tab.view.webContents.session, proxy);
    if (reload) reloadTab(tab);
  } catch (error) {
    tab.error = `Proxy switch failed: ${error.message}`;
  }
  sendState();
}

/** Burn: a brand-new session (fresh cookies) on the pool's next IP, reloading the same page. */
async function burnIP(tab) {
  if (!perTabProxies() || !tabs.includes(tab)) return;
  const url = tab.view.webContents.getURL() || tab.lastURL;
  const oldView = tab.view;
  const oldPartition = tab.partition;

  tab.partition = newPartition();
  tab.proxy = pool.next(tab.region);
  tab.authAttempts = 0;
  tab.error = null;
  tab.view = createView(tab);
  if (tab.id === selectedId) showSelected();
  destroyView(oldView);
  releasePartition(oldPartition);
  try {
    await applyProxy(tab.view.webContents.session, tab.proxy);
    loadInTab(tab, url);
  } catch (error) {
    tab.error = `Proxy setup failed: ${error.message}`;
  }
  sendState();
}

function burnAll() {
  return Promise.all(tabs.filter((t, i) => tabs.findIndex((o) => o.partition === t.partition) === i).map(burnIP));
}

/** Switch To Proxy: moves a tab between the local IP and a proxy without reloading or losing its session. */
function toggleProxy(tab) {
  if (!perTabProxies()) return;
  return setSessionProxy(tab, tab.proxy ? null : pool.next(tab.region), { reload: false });
}

/** Switch Between Regions: picks a proxy in the region and reloads; tabs on the local IP just remember it. */
function setRegion(tab, region) {
  if (!perTabProxies() || !pool.regions.includes(region)) return;
  for (const t of tabs) if (t.partition === tab.partition) t.region = region;
  if (!tab.proxy) return sendState();
  return setSessionProxy(tab, pool.next(region), { reload: true });
}

function setColor(tab, hex) {
  tab.color = TAB_COLORS.some((c) => c.hex === hex) ? hex : null;
  sendState();
}

function setNote(tab, text) {
  tab.note = String(text ?? '').slice(0, 5000);
  sendState();
}

function clearTimer(tab) {
  if (tab.timer) clearTimeout(tab.timer.handle);
  tab.timer = null;
}

function setTimer(tab, minutes) {
  clearTimer(tab);
  tab.timerDone = false;
  const ms = Number(minutes) * 60_000;
  if (ms > 0 && ms <= 24 * 3_600_000) {
    tab.timer = { endsAt: Date.now() + ms, handle: setTimeout(() => fireTimer(tab), ms) };
  }
  sendState();
}

function fireTimer(tab) {
  tab.timer = null;
  if (!tabs.includes(tab)) return;
  tab.timerDone = true;
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: `Tab ${tab.slot}: time to check back`,
      body: tab.view.webContents.getTitle() || tab.lastURL || '',
    });
    notification.on('click', () => {
      if (!win) return;
      win.show();
      if (tabs.includes(tab)) selectTab(tab.id);
    });
    notification.show();
  }
  win?.flashFrame(true);
  sendState();
}

/** Types text into whatever field is focused in the page, as if pasted. */
function insertText(tab, text) {
  const contents = tab.view.webContents;
  contents.focus();
  contents.insertText(String(text ?? ''));
}

function selectedTab() {
  return tabs.find((t) => t.id === selectedId) ?? null;
}

function selectTab(id) {
  selectedId = id;
  const tab = selectedTab();
  if (tab) tab.timerDone = false;
  showSelected();
  sendState();
}

function cycleTab(offset) {
  if (tabs.length === 0) return;
  const index = tabs.indexOf(selectedTab());
  selectTab(tabs[(index + offset + tabs.length) % tabs.length].id);
}

/** Only the selected tab's view is attached; background tabs keep running detached. */
function showSelected() {
  if (!win || win.isDestroyed()) return;
  for (const child of win.contentView.children) {
    if (child !== selectedTab()?.view) win.contentView.removeChildView(child);
  }
  const tab = selectedTab();
  if (mode === 'browser' && tab) {
    win.contentView.addChildView(tab.view);
    layout();
  }
}

function layout() {
  const tab = selectedTab();
  if (!win || !tab) return;
  const [width, height] = win.getContentSize();
  tab.view.setBounds({
    x: 0,
    y: insets.top,
    width: Math.max(0, width - insets.right),
    height: Math.max(0, height - insets.top),
  });
}

async function screenshot(tab) {
  const image = await tab.view.webContents.capturePage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('pictures'), `Tab ${tab.slot} ${stamp}.png`),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!canceled && filePath) await fs.promises.writeFile(filePath, image.toPNG());
}

function showTabMenu(tab) {
  const can = perTabProxies();
  Menu.buildFromTemplate([
    { label: 'Duplicate Tab', click: () => duplicateTab(tab) },
    { label: 'Burn IP and Reload', enabled: can, click: () => burnIP(tab) },
    { label: tab.proxy ? 'Switch to Local IP' : 'Switch to Proxy', enabled: can, click: () => toggleProxy(tab) },
    {
      label: 'Region',
      enabled: can && pool.regions.length > 0,
      submenu: pool.regions.map((region) => ({
        label: region.toUpperCase(), type: 'radio', checked: tab.region === region, click: () => setRegion(tab, region),
      })),
    },
    { type: 'separator' },
    {
      label: 'Color',
      submenu: [
        { label: 'None', type: 'radio', checked: !tab.color, click: () => setColor(tab, null) },
        ...TAB_COLORS.map((c) => ({ label: c.name, type: 'radio', checked: tab.color === c.hex, click: () => setColor(tab, c.hex) })),
      ],
    },
    {
      label: 'Timer',
      submenu: [
        ...TIMER_PRESETS.map((minutes) => ({ label: `${minutes} min`, click: () => setTimer(tab, minutes) })),
        { type: 'separator' },
        { label: 'Clear Timer', enabled: Boolean(tab.timer), click: () => setTimer(tab, 0) },
      ],
    },
    { type: 'separator' },
    { label: 'Close Tab', click: () => closeTab(tab) },
  ]).popup({ window: win });
}

// ---------- UI bridge ----------

let statePending = false;

/** Coalesces bursts of page events into one state message per tick. */
function sendState() {
  if (statePending) return;
  statePending = true;
  setImmediate(() => {
    statePending = false;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('state', snapshot());
    updateMenu();
  });
}

function snapshot() {
  return {
    mode,
    perTabProxies: perTabProxies(),
    regions: pool?.regions ?? [],
    selectedId,
    tabs: tabs.map((tab) => {
      const contents = tab.view.webContents;
      const url = contents.getURL();
      let host = '';
      try {
        host = new URL(url || tab.lastURL).host;
      } catch {}
      return {
        id: tab.id,
        slot: tab.slot,
        title: contents.getTitle() || host || 'New Tab',
        url: url || tab.lastURL || '',
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        proxy: proxyLabel(tab.proxy),
        region: tab.region,
        error: tab.error,
        color: tab.color,
        note: tab.note,
        timerEndsAt: tab.timer?.endsAt ?? null,
        timerDone: tab.timerDone,
      };
    }),
  };
}

const commands = {
  newTab: () => createTab(),
  refreshAll: () => tabs.forEach(reloadTab),
  burnAll: () => burnAll(),
  nextTab: () => cycleTab(1),
  previousTab: () => cycleTab(-1),
  endSession: () => endSession(),
  copy: (_tab, text) => clipboard.writeText(String(text ?? '')),
  selectTab: (tab) => selectTab(tab.id),
  closeTab: (tab) => closeTab(tab),
  duplicate: (tab) => duplicateTab(tab),
  burn: (tab) => burnIP(tab),
  toggleProxy: (tab) => toggleProxy(tab),
  setRegion: (tab, region) => setRegion(tab, region),
  setColor: (tab, hex) => setColor(tab, hex),
  setNote: (tab, text) => setNote(tab, text),
  setTimer: (tab, minutes) => setTimer(tab, minutes),
  insertText: (tab, text) => insertText(tab, text),
  tabMenu: (tab) => showTabMenu(tab),
  reload: (tab) => reloadTab(tab),
  stop: (tab) => tab.view.webContents.stop(),
  back: (tab) => tab.view.webContents.navigationHistory.goBack(),
  forward: (tab) => tab.view.webContents.navigationHistory.goForward(),
  navigate: (tab, input) => loadInTab(tab, input),
  screenshot: (tab) => screenshot(tab).catch((error) => dialog.showErrorBox('Screenshot failed', error.message)),
};

const TABLESS = new Set(['newTab', 'refreshAll', 'burnAll', 'nextTab', 'previousTab', 'endSession']);

/** Runs a command against `tabId`, or the selected tab when omitted. */
function runCommand(name, tabId, arg) {
  const command = commands[name];
  if (!command || mode !== 'browser') return;
  if (TABLESS.has(name)) return command();
  const tab = tabs.find((t) => t.id === tabId) ?? selectedTab();
  if (tab) return command(tab, arg);
}

ipcMain.handle('get-initial', () => ({ config, state: snapshot(), palette: TAB_COLORS, timerPresets: TIMER_PRESETS }));
ipcMain.handle('validate', (_event, raw) => validateConfig(normalizeConfig(raw)));
ipcMain.handle('launch', async (_event, raw) => {
  const next = normalizeConfig(raw);
  const error = validateConfig(next);
  if (error) return error;
  try {
    await startSession(next);
    return null;
  } catch (startError) {
    return startError.message || 'Could not load the proxy list.';
  }
});
ipcMain.handle('snippets:get', () => loadSnippets());
ipcMain.handle('snippets:save', (_event, list) => saveSnippets(Array.isArray(list) ? list : []));
ipcMain.on('command', (_event, name, tabId, arg) => runCommand(name, tabId, arg));
ipcMain.on('layout-insets', (_event, next) => {
  insets = { top: Math.max(0, Math.round(Number(next?.top) || 0)), right: Math.max(0, Math.round(Number(next?.right) || 0)) };
  layout();
});

// Proxy credentials can't go in Chromium's proxy rules, so they're answered here.
app.on('login', (event, webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy) return;
  const tab = webContents ? tabs.find((t) => t.view.webContents === webContents) : null;
  const proxy = tab ? tab.proxy : sharedProxy;
  if (!proxy?.username) return;
  if (tab && ++tab.authAttempts > MAX_PROXY_AUTH_ATTEMPTS) return; // wrong credentials: let the load fail
  event.preventDefault();
  callback(proxy.username, proxy.password ?? '');
});

// ---------- Window & menu ----------

function updateMenu() {
  const inBrowser = mode === 'browser';
  const can = perTabProxies();
  const send = (name) => () => runCommand(name);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', enabled: inBrowser, click: send('newTab') },
        { label: 'Duplicate Tab', accelerator: 'CmdOrCtrl+D', enabled: inBrowser, click: send('duplicate') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: inBrowser, click: send('closeTab') },
        { type: 'separator' },
        { label: 'Screenshot', accelerator: 'CmdOrCtrl+Shift+S', enabled: inBrowser, click: send('screenshot') },
        { type: 'separator' },
        { label: 'End Session', accelerator: 'CmdOrCtrl+Shift+E', enabled: inBrowser, click: send('endSession') },
        process.platform === 'darwin' ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: inBrowser, click: send('reload') },
        { label: 'Refresh All Tabs', accelerator: 'CmdOrCtrl+Shift+R', enabled: inBrowser, click: send('refreshAll') },
        { type: 'separator' },
        {
          label: 'Open Location',
          accelerator: 'CmdOrCtrl+L',
          enabled: inBrowser,
          click: () => {
            win.webContents.focus();
            win.webContents.send('focus-address');
          },
        },
        {
          label: 'Tools Panel',
          accelerator: 'CmdOrCtrl+\\',
          enabled: inBrowser,
          click: () => win.webContents.send('toggle-panel'),
        },
        { label: 'Back', accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left', enabled: inBrowser, click: send('back') },
        { label: 'Forward', accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right', enabled: inBrowser, click: send('forward') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', enabled: inBrowser, click: send('nextTab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', enabled: inBrowser, click: send('previousTab') },
        { type: 'separator' },
        {
          label: 'Page Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          enabled: inBrowser,
          click: () => selectedTab()?.view.webContents.openDevTools({ mode: 'detach' }),
        },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Proxy',
      submenu: [
        { label: 'Burn IP and Reload', accelerator: 'CmdOrCtrl+B', enabled: can, click: send('burn') },
        { label: 'Burn IP on All Tabs', accelerator: 'CmdOrCtrl+Alt+B', enabled: can, click: send('burnAll') },
        {
          label: selectedTab()?.proxy ? 'Switch to Local IP' : 'Switch to Proxy',
          accelerator: 'CmdOrCtrl+Shift+P',
          enabled: can,
          click: send('toggleProxy'),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    title: 'TabFleet',
    backgroundColor: '#1b1d22',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => {
    win = null;
  });
  // The chrome UI is local and never navigates or opens windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  updateMenu();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  endSession();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) {
    mode = 'launcher';
    createWindow();
  }
});
