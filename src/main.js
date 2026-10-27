'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Load .env.local (and .env) before any module reads process.env. Supports KEY=value, KEY="value with
// spaces", comments starting with #, and skips blank lines. Existing env vars win; this never
// overwrites what the shell already set.
for (const file of ['.env.local', '.env']) {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || line.trimStart().startsWith('#')) continue;
      const [, key, rawValue] = match;
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2'); // strip paired quotes
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

const {
  app, BrowserWindow, WebContentsView, Menu, Notification, clipboard, dialog, ipcMain, net, safeStorage, session,
} = require('electron');
const { randomUUID } = require('node:crypto');
const { normalizeConfig, validateConfig, createPool, fetchRemoteProxyList, proxyRule, proxyLabel, toURL } = require('./proxy');
const { parseProfilesCSV, buildProfile, publicProfile, planAssignments, buildAutofillScript, buildSubmitScript } = require('./profiles');
const { resolveForTab } = require('./resolvers');
const { parseSheetURL, csvExportURL, viewURL, isSheetsURL } = require('./sheets');

const SHARED_PARTITION = 'persist:shared';
// A dedicated persistent session for Google Sheets import tabs: Google sign-in survives restarts and
// stays separate from the user's browsing sessions. Never routed through a proxy.
const SHEETS_PARTITION = 'persist:google-sheets';
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
let insets = { top: 0, right: 0, left: 0 };

// Browser session state; reset by startSession().
let pool = null;
let sharedProxy = null;
let tabs = [];
let selectedId = null;
let nextSlot = 1;

// Profiles outlive sessions; loaded at startup.
let profiles = [];
// Per-run network state of each profile's session (profile id -> { partition, proxy, region, ready }).
const profileSessions = new Map();

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

/**
 * Profiles hold card numbers, so they are stored only encrypted with the OS keychain. If encryption is
 * unavailable, everything but the cards is saved and the cards stay in memory for this run.
 */
async function loadProfiles() {
  try {
    const stored = JSON.parse(fs.readFileSync(dataPath('profiles.json'), 'utf8'));
    profiles = stored.encrypted
      ? JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(stored.encrypted, 'base64'))).result)
      : (stored.profiles ?? []);
  } catch {
    profiles = [];
  }
}

async function saveProfiles() {
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(profiles));
    writeData('profiles.json', { encrypted: encrypted.toString('base64') });
  } else {
    writeData('profiles.json', { profiles: profiles.map((profile) => ({ ...profile, cards: [] })) });
  }
  win?.webContents.send('profiles-changed');
}

/** Adds or updates profiles by their Profile name, keeping ids so tab assignments survive a re-import. */
async function importProfilesText(text) {
  const { profiles: imported, errors, recognised = {}, ignored = [] } = parseProfilesCSV(text);
  for (const profile of imported) {
    const index = profiles.findIndex((p) => p.profile.toLowerCase() === profile.profile.toLowerCase());
    if (index === -1) profiles.push(profile);
    else profiles[index] = { ...profile, id: profiles[index].id };
  }
  if (imported.length > 0) await saveProfiles();
  return {
    imported: imported.length, total: profiles.length,
    errors: errors.slice(0, 20),
    recognised: Object.entries(recognised).map(([header, field]) => `${header} → ${field}`),
    ignored,
  };
}

async function importProfilesFile() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import profiles',
    properties: ['openFile'],
    filters: [{ name: 'Profiles (CSV)', extensions: ['csv', 'tsv', 'txt'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return importProfilesText(await fs.promises.readFile(filePaths[0], 'utf8'));
}

/** Creates or updates a profile from the editor; returns `{ errors }` or `{ errors: [], id }`. */
async function saveProfileFromEditor(input) {
  const existing = input?.id ? findProfile(input.id) : null;
  if (input?.id && !existing) return { errors: ['That profile no longer exists.'] };
  const { profile, errors } = buildProfile(input ?? {}, existing);
  if (profiles.some((p) => p.id !== profile.id && p.profile.toLowerCase() === profile.profile.toLowerCase())) {
    errors.push(`A profile named "${profile.profile}" already exists.`);
  }
  if (errors.length > 0) return { errors };

  if (existing) profiles[profiles.indexOf(existing)] = profile;
  else profiles.push(profile);
  await saveProfiles();

  // A changed proxy applies to the profile's open tabs straight away.
  if (existing && JSON.stringify(existing.proxy) !== JSON.stringify(profile.proxy)) {
    const entry = profileSessions.get(profile.id);
    const tab = tabs.find((t) => t.profileId === profile.id);
    if (entry && tab && mode === 'browser') {
      const fallback = config.startDirect || !pool.enabled ? null : pool.next(entry.region);
      await setSessionProxy(tab, profile.proxy ?? fallback, { reload: false });
    } else {
      profileSessions.delete(profile.id);
    }
  }
  sendState();
  return { errors: [], id: profile.id };
}

async function deleteProfiles(ids) {
  const remove = new Set(ids ?? profiles.map((p) => p.id));
  for (const tab of tabs.filter((t) => remove.has(t.profileId))) await setProfile(tab, null);
  for (const id of remove) {
    profileSessions.delete(id);
    // Deleting a profile also deletes its logins and site data.
    await session.fromPartition(profilePartition(id)).clearStorageData().catch(() => {});
  }
  profiles = profiles.filter((p) => !remove.has(p.id));
  await saveProfiles();
  sendState();
}

function findProfile(id) {
  return profiles.find((p) => p.id === id) ?? null;
}

/** Each profile has its own persistent session (cookies, logins, storage), shared by all of its tabs. */
function profilePartition(profileId) {
  return `persist:profile-${profileId}`;
}

/** The profile's session for this run, created on first use with the profile's own proxy or one from the pool. */
function ensureProfileSession(profile) {
  let entry = profileSessions.get(profile.id);
  if (!entry) {
    const region = profile.proxy?.region ?? pool.regions[0] ?? null;
    const proxy = profile.proxy ?? (config.startDirect ? null : pool.next(region));
    const partition = profilePartition(profile.id);
    entry = { partition, proxy, region, ready: applyProxy(session.fromPartition(partition), proxy) };
    profileSessions.set(profile.id, entry);
  }
  return entry;
}

function profileSessionFor(partition) {
  return [...profileSessions.values()].find((entry) => entry.partition === partition) ?? null;
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
  profileSessions.clear();
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

/** Clears a private tab session once no tab uses it; persistent sessions (shared, profiles) are kept. */
function releasePartition(partition) {
  if (partition.startsWith('persist:') || tabs.some((t) => t.partition === partition)) return;
  session.fromPartition(partition).clearStorageData().catch(() => {});
}

// ---------- Tabs ----------

function createTab({ url = config.startURL, opener = null, after = null, select = true, profileId = null, fixedPartition = null } = {}) {
  const tab = {
    id: randomUUID(),
    slot: 0,
    partition: SHARED_PARTITION,
    proxy: null,
    region: pool.regions[0] ?? null,
    view: null,
    error: null,
    lastURL: toURL(url),
    pendingURL: null,
    authAttempts: 0,
    color: null,
    note: '',
    timer: null,
    timerDone: false,
    profileId: findProfile(profileId)?.id ?? null,
  };
  let ready = Promise.resolve();
  const profile = opener || fixedPartition ? null : findProfile(tab.profileId);
  if (fixedPartition) {
    // Dedicated persistent session (currently used by Google Sheets import tabs); always direct.
    Object.assign(tab, { partition: fixedPartition, proxy: null, region: null, slot: nextSlot++ });
    ready = applyProxy(session.fromPartition(fixedPartition), null);
  } else if (profile) {
    const entry = ensureProfileSession(profile);
    Object.assign(tab, { partition: entry.partition, proxy: entry.proxy, region: entry.region, slot: nextSlot++ });
    ready = entry.ready;
  } else if (opener) {
    // Popups stay in their opener's session so logins, the IP and the profile carry over.
    Object.assign(tab, {
      partition: opener.partition, proxy: opener.proxy, region: opener.region, slot: opener.slot, color: opener.color,
      profileId: opener.profileId,
    });
  } else if (config.isolation === 'shared') {
    Object.assign(tab, { proxy: sharedProxy, slot: nextSlot++ });
  } else {
    Object.assign(tab, { partition: newPartition(), slot: nextSlot++ });
    tab.proxy = config.startDirect ? null : pool.next(tab.region);
  }

  tab.view = createView(tab);
  if (!opener && !profile && !fixedPartition && config.isolation === 'perTab') ready = applyProxy(tab.view.webContents.session, tab.proxy);

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
  // Remember where a main-frame navigation is heading, so a reload during it (e.g. after a proxy switch
  // drops connections) goes to that page rather than the last one that finished loading.
  contents.on('did-start-navigation', (details) => {
    if (current() && details.isMainFrame && !details.isSameDocument) tab.pendingURL = details.url;
  });
  contents.on('did-navigate', () => {
    if (current()) tab.pendingURL = null;
  });
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
  const contents = tab.view.webContents;
  if (tab.pendingURL) loadInTab(tab, tab.pendingURL);
  else if (contents.getURL()) contents.reload();
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

/** Copies get their own session but keep the page, color and profile (and so the profile's proxy). */
function duplicateTab(tab) {
  const copy = createTab({ url: tab.view.webContents.getURL() || tab.lastURL, after: tab, select: false, profileId: tab.profileId });
  copy.color = tab.color;
  selectTab(copy.id);
}

/** Gives every tab that shares this tab's session (popups, or all tabs of a profile) a new proxy; cookies are kept. */
async function setSessionProxy(tab, proxy, { reload }) {
  for (const t of tabs) {
    if (t.partition === tab.partition) {
      t.proxy = proxy;
      t.authAttempts = 0;
    }
  }
  const entry = profileSessionFor(tab.partition);
  if (entry) entry.proxy = proxy;
  try {
    await applyProxy(tab.view.webContents.session, proxy);
    if (reload) reloadTab(tab);
  } catch (error) {
    tab.error = `Proxy switch failed: ${error.message}`;
  }
  sendState();
}

/**
 * Burn: a brand-new session (fresh cookies) on the pool's next IP, reloading the same page. A profile's
 * session is the profile's identity, so burning a profile tab only moves that session to a new IP.
 */
async function burnIP(tab) {
  if (!perTabProxies() || !tabs.includes(tab)) return;
  if (profileSessionFor(tab.partition)) return setSessionProxy(tab, pool.next(tab.region), { reload: true });
  const url = tab.pendingURL || tab.view.webContents.getURL() || tab.lastURL;
  tab.pendingURL = null;
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
  const entry = profileSessionFor(tab.partition);
  if (entry) entry.region = region;
  if (!tab.proxy) return sendState();
  return setSessionProxy(tab, pool.next(region), { reload: true });
}

/** Moves a tab into another session by swapping its view, then reloads the page it was on there. */
async function moveTabToSession(tab, { partition, proxy, region, ready }) {
  const url = tab.pendingURL || tab.view.webContents.getURL() || tab.lastURL;
  const oldView = tab.view;
  const oldPartition = tab.partition;
  Object.assign(tab, { partition, proxy, region, pendingURL: null, authAttempts: 0, error: null });
  tab.view = createView(tab);
  if (tab.id === selectedId) showSelected();
  destroyView(oldView);
  releasePartition(oldPartition);
  try {
    await ready;
    loadInTab(tab, url);
  } catch (error) {
    tab.error = `Proxy setup failed: ${error.message}`;
  }
  sendState();
}

/**
 * Assigns a profile to a tab by moving the tab into that profile's own session, so it sees the profile's
 * cookies and logins and uses its IP. Removing the profile gives the tab a fresh private session.
 */
function setProfile(tab, profileId) {
  const profile = findProfile(profileId);
  if ((profile?.id ?? null) === tab.profileId || mode !== 'browser') return;
  tab.profileId = profile?.id ?? null;
  if (profile) return moveTabToSession(tab, ensureProfileSession(profile));
  if (config.isolation === 'shared') {
    return moveTabToSession(tab, { partition: SHARED_PARTITION, proxy: sharedProxy, region: tab.region, ready: Promise.resolve() });
  }
  const partition = newPartition();
  const proxy = config.startDirect ? null : pool.next(tab.region);
  return moveTabToSession(tab, { partition, proxy, region: tab.region, ready: applyProxy(session.fromPartition(partition), proxy) });
}

/** Logs a profile out everywhere: clears its session's cookies and storage and reloads its tabs. */
async function clearProfileCookies(tab) {
  if (!profileSessionFor(tab.partition)) return;
  await tab.view.webContents.session.clearStorageData();
  for (const t of tabs) if (t.partition === tab.partition) reloadTab(t);
  sendState();
}

/** Spreads the chosen profiles over all tabs in order; `repeat` cycles them until every tab has one. */
function assignProfiles({ profileIds = [], repeat = false } = {}) {
  const valid = profileIds.filter((id) => findProfile(id));
  return Promise.all(planAssignments(tabs.map((t) => t.id), valid, repeat).map(([tabId, profileId]) => {
    const tab = tabs.find((t) => t.id === tabId);
    return tab && setProfile(tab, profileId);
  }));
}

/**
 * Opens the given Google Sheets URL in a dedicated persistent tab (no proxy), where the user signs in to
 * Google the way they would in any browser. Reuses the existing sheets tab when one is already open.
 */
function openSheetTab(input) {
  if (mode !== 'browser') return { error: 'Start a browsing session first.' };
  const info = parseSheetURL(input);
  if (!info) return { error: 'That does not look like a Google Sheets URL.' };
  const existing = tabs.find((t) => t.partition === SHEETS_PARTITION);
  if (existing) {
    loadInTab(existing, viewURL(info));
    selectTab(existing.id);
    return { ok: true, tabId: existing.id };
  }
  const tab = createTab({ url: viewURL(info), fixedPartition: SHEETS_PARTITION, select: true });
  return { ok: true, tabId: tab.id };
}

/**
 * Reads a Google Sheet and imports it as profiles. The fetch runs in the main process using the sheet
 * session's cookies, so a private sheet works as long as the user has signed in to Google in the sheet
 * tab at any point; a published sheet needs no sign-in at all.
 */
async function importFromSheetURL(input) {
  const info = parseSheetURL(input);
  if (!info) return { error: 'That does not look like a Google Sheets URL.' };
  const exportUrl = csvExportURL(info);
  const sheetUrl = viewURL(info);
  const sheetSession = session.fromPartition(SHEETS_PARTITION);
  try {
    const response = await sheetSession.fetch(exportUrl, { credentials: 'include', redirect: 'follow' });
    if (!info.published && /accounts\.google\.com/.test(response.url)) {
      return { error: 'Sign in to Google in the sheet tab, then click Import again.', needsSignIn: true, sheetUrl };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        error: info.published
          ? 'The sheet is not published to the web, or publication was turned off.'
          : 'Google refused the request. Share the sheet with the account signed in to the sheet tab.',
        needsSignIn: !info.published, sheetUrl,
      };
    }
    if (!response.ok) return { error: `Google returned HTTP ${response.status}.` };
    const csv = await response.text();
    if (!csv || !csv.trim()) return { error: 'The sheet is empty.' };
    // Google returns a sign-in HTML page in some private-sheet cases without a redirect; detect that.
    if (/^\s*<!doctype html/i.test(csv) || csv.includes('<html')) {
      return { error: 'Sign in to Google in the sheet tab, then click Import again.', needsSignIn: true, sheetUrl };
    }
    const result = await importProfilesText(csv);
    return { ...result, error: result.imported === 0 ? (result.errors[0] ?? 'No profiles found in the sheet.') : null };
  } catch (error) {
    return { error: `Could not read the sheet: ${error.message}.` };
  }
}

/**
 * Fills the visible form in every frame of the tab from its profile. Runs only when the user asks for it
 * and never submits anything.
 */
/** Walks a JSON structure looking for the first string/number value whose key matches `keys`. */
function pickStringFromJSON(data, keys) {
  const lowered = keys.map((k) => k.toLowerCase());
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) { const found = walk(item); if (found) return found; }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (lowered.includes(key.toLowerCase()) && (typeof nested === 'string' || typeof nested === 'number')) {
          const str = String(nested).trim();
          if (str) return str;
        }
      }
      for (const nested of Object.values(value)) { const found = walk(nested); if (found) return found; }
    }
    return null;
  };
  return walk(data);
}

/**
 * Fetches a value from a user-configured URL. Returns { value, error } so callers can either take the
 * value (autofill) or show the error (Get OTP button). For password mode: looks for a password-like
 * key in JSON, else returns the first non-blank line. For OTP mode: extracts a 4–8 digit sequence.
 */
async function fetchSyncValue(url, authHeader, mode) {
  if (!url) return { value: '' };
  let host = '';
  try { host = new URL(url).host; } catch {}
  try {
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (authHeader) headers.Authorization = authHeader;
    const response = await net.fetch(url, { headers, redirect: 'follow' });
    if (!response.ok) return { value: '', error: `HTTP ${response.status} from ${host}` };
    const text = (await response.text()).trim();
    if (!text) return { value: '', error: `${host} returned an empty body` };
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (mode === 'otp') {
      const haystack = data ? JSON.stringify(data) : text;
      const contextual = haystack.match(/(?:code|otp|pin|password)[^0-9]{0,8}(\d{4,8})/i);
      if (contextual) return { value: contextual[1] };
      const six = haystack.match(/\b\d{6}\b/);
      if (six) return { value: six[0] };
      const any = haystack.match(/\b\d{4,8}\b/);
      if (any) return { value: any[0] };
      return { value: '', error: `No digits found in response (preview: ${text.slice(0, 80).replace(/\s+/g, ' ')})` };
    }
    if (data) {
      const picked = pickStringFromJSON(data, ['password', 'pass', 'pwd', 'secret', 'value']);
      if (picked) return { value: picked };
    }
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return firstLine ? { value: firstLine } : { value: '', error: `No usable value in response from ${host}` };
  } catch (error) {
    return { value: '', error: `${host || 'request'} failed: ${error.message}` };
  }
}

/** Diagnoses every sync source for the tab's profile — reports what was tried and what came back. */
async function diagnoseSync(tab) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  const tabUrl = tab.view.webContents.getURL();
  const lines = [`Profile: ${profile.profile}`];
  lines.push(`Tab URL: ${tabUrl || '(blank)'}`);

  // Report what the profile actually has — makes it obvious when a required field is missing.
  const have = [];
  if (profile.textChestKey) have.push(`TextChest key (${profile.textChestKey.length} chars)`);
  if (profile.smsNumber) have.push(`SMS Number ${profile.smsNumber.replace(/\D/g, '')}`);
  if (profile.passwordUrl) have.push(`password URL ${new URL(profile.passwordUrl).host}`);
  if (profile.otpUrl) have.push(`OTP URL ${new URL(profile.otpUrl).host}`);
  for (const col of (profile.resolvers ?? [])) {
    have.push(`Site:${col.site} → ${col.entries.map((e) => `${e.field}=${e.resolver}`).join(', ')}`);
  }
  lines.push(`Profile has: ${have.length ? have.join('; ') : '(nothing sync-related)'}`);

  if (profile.textChestKey && !profile.smsNumber) {
    lines.push('  ✗ TextChest key is saved but SMS Number is missing — add an SMS Number column.');
  }

  const resolved = await resolveForTab(profile, tabUrl);
  for (const [field, value] of Object.entries(resolved.values)) {
    const masked = String(value).length > 2 ? `${value[0]}${'•'.repeat(Math.max(0, String(value).length - 2))}${value[String(value).length - 1]}` : '••';
    lines.push(`  ✓ ${field}: ${masked}`);
  }
  // Full error text (now carrying the exact URL the TextChest fetch hit).
  for (const err of resolved.errors) lines.push(`  ✗ ${err}`);
  if (profile.passwordUrl) {
    const r = await fetchSyncValue(profile.passwordUrl, profile.passwordAuth, 'password');
    lines.push(r.value ? `  ✓ password URL: got a value` : `  ✗ password URL: ${r.error}`);
  }
  if (profile.otpUrl) {
    const r = await fetchSyncValue(profile.otpUrl, profile.otpAuth, 'otp');
    lines.push(r.value ? `  ✓ OTP URL: ${r.value}` : `  ✗ OTP URL: ${r.error}`);
  }
  if (have.length === 0) lines.push('  (This profile has no resolvers and no sync URLs.)');
  return { report: lines.join('\n') };
}

/** Fetches the latest OTP for the tab's profile (via Jancy resolver or the simpler OTP URL) and copies it. */
async function fetchOTPForTab(tab) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  const resolved = await resolveForTab(profile, tab.view.webContents.getURL());
  const resolverCode = resolved.values.smscode || resolved.values.emailcode || resolved.values.othercode;
  if (resolverCode) { clipboard.writeText(resolverCode); return { code: resolverCode }; }
  const urlResult = await fetchSyncValue(profile.otpUrl, profile.otpAuth, 'otp');
  if (urlResult.value) { clipboard.writeText(urlResult.value); return { code: urlResult.value }; }
  // Nothing worked — stitch together everything we know so the user can act on it.
  const parts = [];
  if (resolved.errors.length) parts.push(...resolved.errors);
  if (profile.otpUrl && urlResult.error) parts.push(`OTP URL: ${urlResult.error}`);
  if (!profile.otpUrl && !(profile.resolvers ?? []).length) {
    return { error: 'This profile has no OTP source. Add a Site:X smscode resolver or an OTP URL in the editor.' };
  }
  if (parts.length === 0) parts.push('No code arrived yet — trigger the SMS again and retry.');
  return { error: `OTP failed. ${parts.join(' · ')}` };
}

async function autofill(tab, cardIndex = 0) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { filled: 0, error: 'Assign a profile to this tab first.' };
  const tabUrl = tab.view.webContents.getURL();
  // Resolve Jancy-style Site:X columns, and (as a fallback) the simpler passwordUrl / otpUrl sync.
  const [resolved, syncPassword, syncOtp] = await Promise.all([
    resolveForTab(profile, tabUrl),
    fetchSyncValue(profile.passwordUrl, profile.passwordAuth, 'password'),
    fetchSyncValue(profile.otpUrl, profile.otpAuth, 'otp'),
  ]);
  // Collect every sync error so autofill can surface them in one place if nothing filled.
  const syncErrors = [...resolved.errors];
  if (profile.passwordUrl && !syncPassword.value && syncPassword.error) syncErrors.push(`password: ${syncPassword.error}`);
  if (profile.otpUrl && !syncOtp.value && syncOtp.error) syncErrors.push(`otp: ${syncOtp.error}`);
  const extras = {
    password: resolved.values.password || syncPassword.value || profile.password,
    otp: resolved.values.smscode || resolved.values.emailcode || resolved.values.othercode || syncOtp.value,
  };
  const script = buildAutofillScript(profile, profile.cards[Number(cardIndex) || 0] ?? null, extras);
  const totals = { filled: 0, matched: 0, visible: 0, skipped: 0 };
  for (const frame of tab.view.webContents.mainFrame.framesInSubtree) {
    try {
      const part = await frame.executeJavaScript(script);
      if (part && typeof part === 'object') {
        totals.filled += Number(part.filled) || 0;
        totals.matched += Number(part.matched) || 0;
        totals.visible += Number(part.visible) || 0;
        totals.skipped += Number(part.skipped) || 0;
      } else {
        totals.filled += Number(part) || 0;
      }
    } catch {
      // Frame navigated away or is not scriptable.
    }
  }
  let error = null;
  if (totals.filled === 0) {
    if (syncErrors.length > 0) error = `Sync issues: ${syncErrors.join('; ')}.`;
    else if (totals.visible === 0) error = 'No form fields are visible on this page.';
    else if (totals.matched === 0) error = `None of the ${totals.visible} fields matched a profile value — check the fields' names/labels.`;
    else if (totals.skipped > 0) error = `${totals.skipped} field(s) were already filled; nothing new to fill.`;
    else error = 'No profile value was available for the matching fields.';
  } else if (syncErrors.length > 0) {
    error = `Filled ${totals.filled}, but: ${syncErrors.join('; ')}.`;
  }
  return { filled: totals.filled, error };
}

/** Expands an "Add new address/card" collapse OR clicks the primary action button on this page. */
async function submitForm(tab) {
  const script = buildSubmitScript();
  for (const frame of tab.view.webContents.mainFrame.framesInSubtree) {
    try {
      const result = await frame.executeJavaScript(script);
      if (!result) continue;
      if (result.expanded) return { expanded: result.expanded };
      if (result.submitted) return { submitted: result.submitted };
    } catch {
      // Frame navigated away or not scriptable.
    }
  }
  return { error: 'No primary action button found on this page.' };
}

/** Fills the form, waits briefly for the page to react, then clicks the primary action. One click → one page. */
/** Assigns a profile, navigates to the configured URL, waits for load, then autofills + submits. */
async function autoLogin(tab, cardIndex = 0) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  if (!profile.url) return { error: 'This profile has no Homepage URL set — add one in the editor so Auto Login knows where to go.' };
  // Navigate to the login/homepage URL.
  loadInTab(tab, profile.url);
  // Wait for the page to settle (did-stop-loading, with a safety cap).
  await new Promise((resolve) => {
    const wc = tab.view.webContents;
    const done = () => { wc.off('did-stop-loading', done); resolve(); };
    wc.on('did-stop-loading', done);
    setTimeout(done, 8000);
  });
  // Small grace so late-rendered scripts attach their fields.
  await new Promise((r) => setTimeout(r, 400));
  // Fill, pause, then click the primary action.
  const fillResult = await autofill(tab, cardIndex);
  if (fillResult.filled === 0) {
    return { filled: 0, error: fillResult.error ?? 'Nothing to fill — login form may not be on this page.' };
  }
  await new Promise((r) => setTimeout(r, 400));
  const submit = await submitForm(tab);
  if (submit.error) return { filled: fillResult.filled, error: `Filled ${fillResult.filled} field(s), but: ${submit.error}` };
  return { filled: fillResult.filled, submitted: submit.submitted };
}

async function autofillAndSubmit(tab, cardIndex = 0) {
  const fillResult = await autofill(tab, cardIndex);
  // If autofill expanded nothing (empty page), submit will try to click "Add new address" instead.
  if (fillResult.filled === 0) {
    const expand = await submitForm(tab);
    if (expand.expanded) return { filled: 0, expanded: expand.expanded, note: `Clicked "${expand.expanded}" — try Autofill & Submit again when the form loads.` };
    return { filled: 0, error: fillResult.error ?? expand.error };
  }
  // Small pause so sites that validate on blur settle before we click.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const submit = await submitForm(tab);
  if (submit.error) return { filled: fillResult.filled, error: `Filled ${fillResult.filled} field(s), but: ${submit.error}` };
  return { filled: fillResult.filled, submitted: submit.submitted };
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

/**
 * Types text into whatever field is focused in the page, as if pasted. If nothing in the page is focused
 * (e.g. the user just clicked something in the Tools panel), re-focuses the most likely candidate: the
 * currently active element in the page, falling back to the first visible, editable field.
 */
async function insertText(tab, text) {
  const contents = tab.view.webContents;
  contents.focus();
  const value = String(text ?? '');
  // Ask the page which field should receive this: the one the user picked (document.activeElement when
  // it is editable) wins; otherwise fall back to the first visible editable field.
  await contents.executeJavaScript(`(() => {
    const editable = (el) => el && (
      (el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes((el.type || 'text').toLowerCase()))
      || el.tagName === 'TEXTAREA'
      || el.isContentEditable
    );
    const active = document.activeElement;
    if (editable(active)) return;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const target = [...document.querySelectorAll('input, textarea, [contenteditable]')].find((el) => editable(el) && visible(el));
    target?.focus();
  })()`).catch(() => {});
  contents.insertText(value);
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
    x: insets.left,
    y: insets.top,
    width: Math.max(0, width - insets.right - insets.left),
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
  const profileItems = profiles.slice(0, 40).map((profile) => ({
    label: profile.group ? `${profile.profile}  (${profile.group})` : profile.profile,
    type: 'radio',
    checked: tab.profileId === profile.id,
    click: () => setProfile(tab, profile.id),
  }));
  Menu.buildFromTemplate([
    { label: 'Duplicate Tab', click: () => duplicateTab(tab) },
    {
      label: 'Set Profile',
      enabled: profiles.length > 0,
      submenu: [
        { label: 'None', type: 'radio', checked: !tab.profileId, click: () => setProfile(tab, null) },
        ...profileItems,
        ...(profiles.length > 40 ? [{ label: 'More in the Tools panel…', enabled: false }] : []),
      ],
    },
    { label: 'Autofill From Profile', enabled: Boolean(tab.profileId), click: () => autofill(tab) },
    { label: 'Clear Profile Cookies', enabled: Boolean(tab.profileId), click: () => clearProfileCookies(tab) },
    { type: 'separator' },
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
      const profile = findProfile(tab.profileId);
      const onSheet = isSheetsURL(url);
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
        profileId: profile?.id ?? null,
        profileName: profile?.profile ?? null,
        onSheet,
      };
    }),
  };
}

const commands = {
  newTab: () => createTab(),
  assignProfiles: (_tab, options) => assignProfiles(options),
  refreshAll: () => tabs.forEach(reloadTab),
  burnAll: () => burnAll(),
  nextTab: () => cycleTab(1),
  previousTab: () => cycleTab(-1),
  endSession: () => endSession(),
  copy: (_tab, text) => clipboard.writeText(String(text ?? '')),
  selectTab: (tab) => selectTab(tab.id),
  closeTab: (tab) => closeTab(tab),
  duplicate: (tab) => duplicateTab(tab),
  setProfile: (tab, profileId) => setProfile(tab, profileId),
  clearProfileCookies: (tab) => clearProfileCookies(tab),
  autofill: (tab, cardIndex) => autofill(tab, cardIndex),
  autofillSubmit: (tab, cardIndex) => autofillAndSubmit(tab, cardIndex),
  autoLogin: (tab, cardIndex) => autoLogin(tab, cardIndex),
  submitForm: (tab) => submitForm(tab),
  fetchOTP: (tab) => fetchOTPForTab(tab),
  diagnoseSync: (tab) => diagnoseSync(tab),
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

const TABLESS = new Set(['newTab', 'assignProfiles', 'refreshAll', 'burnAll', 'nextTab', 'previousTab', 'endSession']);

/** Runs a command against `tabId`, or the selected tab when omitted. */
function runCommand(name, tabId, arg) {
  const command = commands[name];
  if (!command || mode !== 'browser') return;
  if (TABLESS.has(name)) return command(null, arg);
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
ipcMain.handle('invoke', (_event, name, tabId, arg) => runCommand(name, tabId, arg));
ipcMain.handle('profiles:list', () => profiles.map(publicProfile));
ipcMain.handle('profiles:import-file', () => importProfilesFile());
ipcMain.handle('profiles:import-text', (_event, text) => importProfilesText(String(text ?? '')));
ipcMain.handle('profiles:delete', (_event, ids) => deleteProfiles(Array.isArray(ids) ? ids : null));
ipcMain.handle('profiles:save', (_event, input) => saveProfileFromEditor(input));
ipcMain.handle('profiles:open-sheet', (_event, url) => openSheetTab(url));
ipcMain.handle('profiles:import-sheet', (_event, url) => importFromSheetURL(url));
ipcMain.on('layout-insets', (_event, next) => {
  insets = {
    top: Math.max(0, Math.round(Number(next?.top) || 0)),
    right: Math.max(0, Math.round(Number(next?.right) || 0)),
    left: Math.max(0, Math.round(Number(next?.left) || 0)),
  };
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
    {
      label: 'Profiles',
      submenu: [
        { label: 'Autofill From Profile', accelerator: 'CmdOrCtrl+Shift+F', enabled: inBrowser, click: send('autofill') },
        {
          label: 'Profiles Panel',
          accelerator: 'CmdOrCtrl+Shift+O',
          enabled: inBrowser,
          click: () => win.webContents.send('toggle-panel', 'profiles'),
        },
        { type: 'separator' },
        { label: 'Import Profiles (CSV)…', click: () => importProfilesFile().then((result) => result && win?.webContents.send('profiles-imported', result)) },
        { label: 'Import From Google Sheet…', enabled: inBrowser, click: () => win.webContents.send('open-sheet-import') },
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

app.whenReady().then(async () => {
  await loadProfiles();
  createWindow();
});

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
