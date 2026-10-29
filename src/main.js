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
const { normalizeConfig, validateConfig, createPool, fetchRemoteProxyList, proxyRule, proxyLabel, proxyKey, parseProxy, toURL } = require('./proxy');
const { withoutSecrets, mergeImported, decodeTextFile, parseProfilesCSV, buildProfile, publicProfile, planAssignments, buildAutofillScript, buildSubmitScript, buildCardDigitsScript, chooseShownCard, profilesToCSV } = require('./profiles');
const { resolveForTab } = require('./resolvers');
const { parseSheetURL, csvExportURL, viewURL, isSheetsURL, sheetListURL, parseSheetList } = require('./sheets');
const sync = require('./sync');
const { LANGUAGES, timeZoneFor, cleanUserAgent } = require('./identity');

// Pages see a plain Chromium user agent: Electron's names the app and Electron, and changes with every release.
app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

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
let overlayOpen = false;
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

// ---------- Automatiq Sync credentials ----------

// Each user enters their own Company ID + API token in Settings; the token is encrypted with the OS
// keychain and never sent to the window. SEATSCOUTS_COMPANY_ID / SEATSCOUTS_API_TOKEN (e.g. from
// .env.local) are a development fallback — .env.local is not packaged into release builds.
let syncCredentials = null; // { companyId, apiToken } from Settings

async function loadSyncCredentials() {
  try {
    const stored = JSON.parse(fs.readFileSync(dataPath('sync.json'), 'utf8'));
    const apiToken = stored.token
      ? (await safeStorage.decryptStringAsync(Buffer.from(stored.token, 'base64'))).result
      : '';
    syncCredentials = { companyId: String(stored.companyId ?? ''), apiToken };
  } catch {
    syncCredentials = null;
  }
}

function activeSyncCredentials() {
  if (syncCredentials?.companyId && syncCredentials?.apiToken) return { ...syncCredentials, source: 'settings' };
  const companyId = process.env.SEATSCOUTS_COMPANY_ID;
  const apiToken = process.env.SEATSCOUTS_API_TOKEN;
  if (companyId && apiToken) return { companyId, apiToken, source: 'env' };
  return null;
}

function syncSettingsInfo() {
  const active = activeSyncCredentials();
  return {
    companyId: syncCredentials?.companyId ?? '',
    hasToken: Boolean(syncCredentials?.apiToken),
    source: active?.source ?? 'none',
  };
}

async function saveSyncCredentials(input) {
  const companyId = String(input?.companyId ?? '').trim();
  if (companyId && !/^\d{1,12}$/.test(companyId)) return { error: 'Company ID should be a number (Sync → Settings).' };
  let apiToken = syncCredentials?.apiToken ?? '';
  if (input?.clearToken) apiToken = '';
  if (typeof input?.apiToken === 'string' && input.apiToken.trim()) apiToken = input.apiToken.trim();
  syncCredentials = { companyId, apiToken };
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    writeData('sync.json', { companyId });
    return { ...syncSettingsInfo(), warning: 'Your system keychain is unavailable, so the API token is kept only until TabFleet quits.' };
  }
  writeData('sync.json', {
    companyId,
    token: apiToken ? (await safeStorage.encryptStringAsync(apiToken)).toString('base64') : '',
  });
  return syncSettingsInfo();
}

function listSyncOrders(params) {
  const baseURL = process.env.TABFLEET_SYNC_URL || sync.SYNC_BASE_URL;
  return sync.fetchOrders((url, options) => net.fetch(url, options), activeSyncCredentials(), params, baseURL);
}

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
      // Without encryption a secret snippet's value isn't written to disk at all.
      ...(canEncrypt
        ? { encrypted: (await safeStorage.encryptStringAsync(value)).toString('base64') }
        : { value: snippet.secret ? '' : value }),
    });
  }
  writeData('snippets.json', stored);
}

/**
 * Profiles hold card numbers and passwords, so they are stored only encrypted with the OS keychain. If
 * encryption is unavailable, the profiles are saved without their secrets (see withoutSecrets), which stay
 * in memory for this run.
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

// Saves run one after another, each writing the profiles as they are when it starts: encryption is
// async, so overlapping saves could otherwise finish out of order and an older one overwrite a newer one.
let profileSaves = Promise.resolve();

function saveProfiles() {
  profileSaves = profileSaves.then(writeProfiles, writeProfiles);
  return profileSaves;
}

async function writeProfiles() {
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(profiles));
    writeData('profiles.json', { encrypted: encrypted.toString('base64') });
  } else {
    writeData('profiles.json', { profiles: profiles.map(withoutSecrets) });
    if (!writeProfiles.warned) {
      writeProfiles.warned = true;
      notify("Your system keychain is unavailable, so cards, passwords and proxy passwords are kept only until TabFleet quits. Re-import your profiles after restarting.");
    }
  }
  win?.webContents.send('profiles-changed');
  if (settings) ensureActiveGroup();
}

/**
 * Adds imported profiles, updating ones that already exist. A profile is identified by its group and
 * name, so two groups (sheets) can each have an "OS 1.1"; an older copy saved without a group is
 * updated in place rather than duplicated.
 */
const profileKey = (p) => `${String(p.group ?? '').toLowerCase()}\u0000${p.profile.toLowerCase()}`;

function mergeProfiles(imported) {
  const merged = mergeImported(profiles, imported);
  profiles = merged.profiles;
  return merged.notes;
}

async function importProfilesText(text, options = {}) {
  const { profiles: imported, errors, recognised = {}, ignored = [] } = parseProfilesCSV(text, options);
  const notes = mergeProfiles(imported);
  if (imported.length > 0) await saveProfiles();
  return {
    imported: imported.length, total: profiles.length, notes,
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
  return importProfilesText(decodeTextFile(await fs.promises.readFile(filePaths[0])));
}


/** Creates or updates a profile from the editor; returns `{ errors }` or `{ errors: [], id }`. */
const PROFILE_FIELDS = [
  'profile', 'group', 'site', 'name', 'email', 'phone', 'smsNumber', 'address1', 'address2', 'city', 'state',
  'zip', 'country', 'url', 'dob', 'buyer', 'notes', 'favorite',
];

async function saveProfileFromEditor(input) {
  const existing = input?.id ? findProfile(input.id) : null;
  if (input?.id && !existing) return { errors: ['That profile no longer exists.'] };
  // A partial update (e.g. starring a profile) keeps every field and card it doesn't mention.
  if (existing) {
    input = {
      ...Object.fromEntries(PROFILE_FIELDS.map((key) => [key, existing[key]])),
      keepCards: existing.cards.map((_, index) => index),
      ...input,
    };
  }
  const { profile, errors } = buildProfile(input ?? {}, existing);
  // Names are unique within a group (as on import), so two groups can each have an "OS 1.1".
  if (profiles.some((p) => p.id !== profile.id && profileKey(p) === profileKey(profile))) {
    errors.push(`${groupName(profile.group ?? '')} already has a profile named "${profile.profile}".`);
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

// ---------- Groups ----------
//
// The browser works in one group of accounts at a time (settings.activeGroup, the profiles' Group
// value; '' = ungrouped). Only that group's accounts can be put on tabs, so groups never mix. Changing
// group is explicit: the window asks twice (impact, then typing the group's name) and the name is
// checked here too. Display names (settings.groupNames) are separate from the sheet's Group value,
// so renaming survives re-imports.

const GROUP_COLORS = ['#4c6ef5', '#12b886', '#f76707', '#e64980', '#7950f2', '#15aabf', '#fab005', '#82c91e'];
const groupKeyOf = (profile) => profile?.group ?? '';

function groupName(key) {
  return settings.groupNames?.[key] || key || 'Ungrouped';
}

function groupColor(key) {
  let hash = 0;
  for (const ch of String(key)) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}

function groupList() {
  const counts = new Map();
  for (const p of profiles) counts.set(groupKeyOf(p), (counts.get(groupKeyOf(p)) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, count]) => ({ key, name: groupName(key), count, color: groupColor(key) }));
}

const hasActiveGroup = () => typeof settings.activeGroup === 'string' && profiles.some((p) => groupKeyOf(p) === settings.activeGroup);
const inActiveGroup = (profile) => Boolean(profile) && hasActiveGroup() && groupKeyOf(profile) === settings.activeGroup;

function persistSettings() {
  writeData('settings.json', settings);
}

function updateWindowTitle() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(hasActiveGroup() ? `TabFleet — ${groupName(settings.activeGroup)}` : 'TabFleet');
}

/** Keeps the active group valid: with a single group it's chosen automatically; otherwise the user picks. */
function ensureActiveGroup() {
  if (!hasActiveGroup()) {
    const keys = [...new Set(profiles.map(groupKeyOf))];
    const next = keys.length === 1 ? keys[0] : null;
    if (settings.activeGroup !== next) {
      settings.activeGroup = next;
      persistSettings();
    }
  }
  // An account edited or re-imported into another group mustn't stay on a tab: groups never mix.
  const strays = tabs.filter((t) => t.profileId && !inActiveGroup(findProfile(t.profileId)));
  for (const tab of strays) setProfile(tab, null, { force: true });
  if (strays.length > 0) {
    notify(`${strays.length} tab${strays.length === 1 ? ' was' : 's were'} signed out: ${strays.length === 1 ? 'its account moved' : 'their accounts moved'} out of the group you're working in.`);
  }
  updateWindowTitle();
  sendState();
}

/**
 * The group is chosen on the start screen and stays for the whole session: accounts of different groups
 * never share a run. To work in another group the user restarts TabFleet (restartForGroup).
 */
const GROUP_LOCKED = 'TabFleet works in one group per session. To use another group, restart TabFleet and choose it on the start screen.';

function setActiveGroup(key) {
  settings.activeGroup = key;
  persistSettings();
  updateWindowTitle();
  sendState();
}

/** Only for a session that has no group yet (e.g. a sheet with several groups was imported during it). */
function switchGroup({ group } = {}) {
  const key = String(group ?? '');
  if (!profiles.some((p) => groupKeyOf(p) === key)) return { error: 'That group no longer exists.' };
  if (hasActiveGroup() && settings.activeGroup === key) return { ok: true };
  if (mode === 'browser' && hasActiveGroup()) return { error: GROUP_LOCKED };
  setActiveGroup(key);
  return { ok: true };
}

/** Closes everything and starts TabFleet again, at the start screen where the group is chosen. */
function restartForGroup() {
  app.relaunch();
  app.quit();
}

function renameGroup({ group, name } = {}) {
  const key = String(group ?? '');
  if (!profiles.some((p) => groupKeyOf(p) === key)) return { error: 'That group no longer exists.' };
  const text = String(name ?? '').trim().slice(0, 40);
  // Switching is confirmed by typing the group's name, so two groups must never share one.
  const taken = groupList().find((g) => g.key !== key && g.name.trim().toLowerCase() === (text || key).toLowerCase());
  if (taken) return { error: `Another group is already called "${taken.name}".` };
  settings.groupNames = { ...(settings.groupNames ?? {}) };
  if (!text || text === key) delete settings.groupNames[key];
  else settings.groupNames[key] = text;
  persistSettings();
  updateWindowTitle();
  sendState();
  return { ok: true, name: groupName(key) };
}

// ---------- Account proxies ----------
//
// Bot protection trusts an account that keeps the same cookies, device and IP, so an account's IP is
// kept stable:
//  - Its own proxies (sheet "Proxy", then "Proxy 2", "Proxy 3"… as backups) always win; `proxyIndex`
//    remembers which one is in use, across restarts.
//  - Without its own, the account gets a launch-pool proxy pinned to it (`pinnedProxy`) and keeps it on
//    every launch: on a list, one no other account is pinned to; on a rotating gateway, a sticky session
//    of its own. A pin is redone only if it no longer belongs to the current pool.
//  - New IP moves the account to its next backup, or to a fresh pin; with a single own proxy it refuses
//    rather than putting the account on a random IP.

/** The account's own proxies: the profile's proxy, then its backups. */
function ownProxies(profile) {
  return [profile.proxy, ...(profile.extraProxies ?? []).map((text) => parseProxy(text))].filter(Boolean);
}

function pinBelongsToPool(pin) {
  if (!pin?.proxy || !pool?.enabled) return false;
  if (pool.kind === 'rotating') return pin.gateway === pool.gatewayKey;
  return pool.list.some((p) => proxyKey(p) === proxyKey(pin.proxy));
}

/** Pins a pool proxy to the account (avoiding other accounts' pins and `avoid`) and saves it. */
function pinPoolProxy(profile, region, avoid = null) {
  const taken = new Set(profiles.filter((p) => p.id !== profile.id && p.pinnedProxy).map((p) => proxyKey(p.pinnedProxy.proxy)));
  if (avoid) taken.add(proxyKey(avoid));
  const proxy = pool.pick(region, taken);
  if (!proxy || proxyKey(proxy) === proxyKey(avoid)) return null;
  profile.pinnedProxy = { proxy, gateway: pool.gatewayKey };
  saveProfiles();
  return proxy;
}

/** The proxy an account uses now: { proxy, kind: 'account' | 'backup' | 'pinned' | 'direct', index, count }. */
function accountProxy(profile, region) {
  const own = ownProxies(profile);
  if (own.length > 0) {
    const index = (profile.proxyIndex ?? 0) % own.length;
    return { proxy: own[index], kind: index === 0 ? 'account' : 'backup', index, count: own.length };
  }
  if (config.startDirect || !pool?.enabled) return { proxy: null, kind: 'direct' };
  if (pinBelongsToPool(profile.pinnedProxy)) return { proxy: profile.pinnedProxy.proxy, kind: 'pinned' };
  const proxy = pinPoolProxy(profile, region);
  return proxy ? { proxy, kind: 'pinned' } : { proxy: null, kind: 'direct' };
}

/** New IP for an account: its next own proxy, or a fresh pin; { error } when it has nothing to switch to. */
function nextAccountProxy(profile, current, region) {
  const own = ownProxies(profile);
  if (own.length === 1) {
    return { error: `${profile.profile} has one proxy, so its IP is kept (changing it while signed in can trigger bot checks). Add a "Proxy 2" column in the sheet as a backup to switch.` };
  }
  if (own.length > 1) {
    profile.proxyIndex = ((profile.proxyIndex ?? 0) + 1) % own.length;
    saveProfiles();
    return { proxy: own[profile.proxyIndex], kind: profile.proxyIndex === 0 ? 'account' : 'backup', index: profile.proxyIndex, count: own.length };
  }
  if (!pool?.enabled) return { error: 'There is no launch-screen proxy pool to take a new IP from.' };
  const proxy = pinPoolProxy(profile, region, current);
  return proxy ? { proxy, kind: 'pinned' } : { error: 'Every proxy in the launch pool is already pinned to an account.' };
}

function notify(text) {
  win?.webContents.send('notice', text);
}

/** The profile's session for this run, created on first use with the account's proxy (see above). */
function ensureProfileSession(profile) {
  let entry = profileSessions.get(profile.id);
  if (!entry) {
    const region = profile.proxy?.region ?? profile.pinnedProxy?.proxy?.region ?? pool.regions[0] ?? null;
    const chosen = accountProxy(profile, region);
    const partition = profilePartition(profile.id);
    entry = {
      partition, proxy: chosen.proxy, proxyInfo: chosen, region, profileId: profile.id,
      ready: applyProxy(session.fromPartition(partition), chosen.proxy),
    };
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
    profileId: inActiveGroup(findProfile(profileId)) ? profileId : null,
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

  loadWhenReady(tab, ready, url);
  if (select) selectTab(tab.id);
  else sendState();
  return tab;
}

function createView(tab) {
  const view = new WebContentsView({
    webPreferences: { partition: tab.partition, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const contents = view.webContents;
  // WebRTC would otherwise reach STUN servers over UDP outside the proxy, showing sites the real public
  // and LAN IP next to the proxy's.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  tab.viewReady = prepareView(tab, view);
  // Burn swaps a tab's view; events still arriving from the old one must not touch the tab.
  const current = () => tab.view === view;
  const update = () => current() && sendState();
  for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading']) {
    contents.on(event, update);
  }
  // The page itself has loaded (ads and trackers may keep going): its load slot is free for the next tab.
  // Events from the blank page a view is prepared on (see prepareView) can arrive after the real load began.
  const loaded = () => current() && !contents.priming && releaseLoadSlot(tab);
  contents.on('did-finish-load', loaded);
  contents.on('did-stop-loading', loaded);
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
    if (current() && isMainFrame && !contents.priming) releaseLoadSlot(tab);
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
    // Pages may only open web pages: a popup loads through the main process, which would otherwise let
    // a site open file: or other local URLs it can't navigate to itself.
    if (/^(https?:|about:blank$)/i.test(url)) createTab({ url, opener: tab, after: tab });
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

// ---------- Tab identity ----------
//
// Each tab tells sites the same languages (also in workers and frames) and, behind a proxy, a timezone
// that fits the account (see identity.js); on the local IP it keeps the computer's own. These are set
// through the tab's DevTools protocol, before any site loads, as Chromium only applies them per page.

// The browser's own client hints (brands, platform…), passed through unchanged with the language override.
let resolveUAMetadata;
const uaMetadata = new Promise((resolve) => { resolveUAMetadata = resolve; }).then((hints) => (hints ? {
  brands: hints.brands, fullVersionList: hints.fullVersionList, platform: hints.platform, platformVersion: hints.platformVersion,
  architecture: hints.architecture, model: hints.model, mobile: hints.mobile, bitness: hints.bitness, wow64: hints.wow64,
  formFactors: hints.formFactors,
} : null));

function tabTimeZone(tab) {
  if (!tab.proxy) return '';
  return timeZoneFor({ profile: findProfile(tab.profileId), region: tab.proxy.region || tab.region });
}

/** Points the tab's page and its cross-site frames at the timezone for its current proxy ('' = the computer's). */
function applyTimeZone(tab) {
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return Promise.resolve();
  const timezoneId = tabTimeZone(tab);
  return Promise.all([undefined, ...(contents.frameSessions ?? [])].map((sessionId) =>
    contents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId }, sessionId).catch(() => {})));
}

/**
 * Prepares a new view before any site loads in it: a blank page gives it a renderer to configure, then
 * the languages and timezone are set and every worker and cross-site frame it starts gets them too.
 */
async function prepareView(tab, view) {
  const contents = view.webContents;
  try {
    const metadata = await Promise.race([uaMetadata, sleep(5000).then(() => null)]);
    contents.priming = true;
    await contents.loadURL('about:blank');
    if (contents.isDestroyed()) return;
    const ua = metadata ? { userAgent: app.userAgentFallback, acceptLanguage: LANGUAGES, userAgentMetadata: metadata } : null;
    const cdp = contents.debugger;
    cdp.attach('1.3');
    contents.frameSessions = new Set();
    cdp.on('message', async (_event, method, params) => {
      if (method === 'Target.detachedFromTarget') return contents.frameSessions.delete(params.sessionId);
      if (method !== 'Target.attachedToTarget') return;
      const { sessionId, targetInfo } = params;
      // Workers and frames start paused until they're configured; they must be resumed whatever happens.
      try {
        if (ua) await cdp.sendCommand('Emulation.setUserAgentOverride', ua, sessionId);
        if (targetInfo.type === 'iframe') {
          contents.frameSessions.add(sessionId);
          const timezoneId = tabTimeZone(tab);
          if (timezoneId) await cdp.sendCommand('Emulation.setTimezoneOverride', { timezoneId }, sessionId);
          await cdp.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
        }
      } catch {
        // The target went away.
      } finally {
        cdp.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
    });
    if (ua) await cdp.sendCommand('Emulation.setUserAgentOverride', ua);
    await cdp.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await applyTimeZone(tab);
    // The blank page isn't part of the tab's history.
    contents.once('did-navigate', () => {
      contents.priming = false;
      contents.navigationHistory.clear();
    });
  } catch {
    // The tab still works with the browser's defaults.
    if (!contents.isDestroyed()) contents.priming = false;
  }
}

// ---------- Load scheduling ----------

// Loading every tab at once (launch, Refresh all, New IPs: all, assigning profiles) makes the tab on
// screen compete with dozens of others for CPU and bandwidth (measured: 15 Ticketmaster tabs made the
// visible one take 20 s instead of ~5 s; far worse on a slower PC through proxies). So the selected tab
// loads immediately and alone, and background tabs queue, loading BACKGROUND_LOADS at a time once it's done.
// A load holds its slot until the page has loaded, failed, or LOAD_SLOT_MS passed (a stuck proxy
// mustn't block the queue). Selecting a waiting tab loads it straight away.
const BACKGROUND_LOADS = 4;
const LOAD_SLOT_MS = 15000;
const loadQueue = [];
const loadSlots = new Map(); // tab -> timeout

function loadInTab(tab, input) {
  const url = toURL(input);
  if (!url) return;
  tab.lastURL = url;
  tab.error = null;
  // The tab's session is still getting its proxy: loading now could reach the site from the wrong IP.
  if (tab.gate) {
    tab.gate.url = url;
    return;
  }
  // Failures are reported through did-fail-load.
  scheduleLoad(tab, () => tab.view.webContents.loadURL(url).catch(() => {}));
}

/**
 * Loads `url` in the tab once `ready` (its session's proxy setup) settles. Navigations asked for
 * meanwhile replace `url` instead of loading early; a newer gate on the tab supersedes this one.
 */
function loadWhenReady(tab, ready, url) {
  const gate = { url };
  tab.gate = gate;
  return Promise.all([ready, tab.viewReady]).then(() => {
    if (tab.gate !== gate) return;
    tab.gate = null;
    loadInTab(tab, gate.url);
  }, (error) => {
    if (tab.gate !== gate) return;
    tab.gate = null;
    tab.error = `Proxy setup failed: ${error.message}`;
    pumpLoads();
  }).finally(sendState);
}

/** The page a tab is on or heading to: a load waiting for the tab to be ready, one under way, else the current page. */
function intendedURL(tab) {
  const contents = tab.view.webContents;
  return tab.gate?.url || tab.pendingURL || (contents.priming ? '' : contents.getURL()) || tab.lastURL;
}

function reloadTab(tab) {
  tab.error = null;
  // Its page loads as soon as the tab is ready.
  if (tab.gate) return;
  const contents = tab.view.webContents;
  if (tab.pendingURL) loadInTab(tab, tab.pendingURL);
  else if (contents.getURL()) scheduleLoad(tab, () => tab.view.webContents.reload());
  else loadInTab(tab, tab.lastURL);
}

function scheduleLoad(tab, start) {
  tab.queuedLoad = start;
  if (tab.id === selectedId) return startQueuedLoad(tab);
  if (!loadQueue.includes(tab)) loadQueue.push(tab);
  pumpLoads();
  sendState();
}

function startQueuedLoad(tab) {
  const start = tab.queuedLoad;
  const queued = loadQueue.indexOf(tab);
  if (queued !== -1) loadQueue.splice(queued, 1);
  tab.queuedLoad = null;
  if (!start || !tabs.includes(tab) || tab.view.webContents.isDestroyed()) return;
  releaseLoadSlot(tab, false);
  loadSlots.set(tab, setTimeout(() => releaseLoadSlot(tab), LOAD_SLOT_MS));
  start();
}

function releaseLoadSlot(tab, pump = true) {
  const timeout = loadSlots.get(tab);
  if (timeout === undefined) return;
  clearTimeout(timeout);
  loadSlots.delete(tab);
  if (pump) pumpLoads();
}

function pumpLoads() {
  const selected = selectedTab();
  // The selected tab goes first, including while it's still being prepared to load.
  const limit = selected && (loadSlots.has(selected) || selected.gate) ? 0 : BACKGROUND_LOADS;
  let background = [...loadSlots.keys()].filter((t) => t !== selected).length;
  while (loadQueue.length > 0 && background < limit) {
    startQueuedLoad(loadQueue[0]);
    background++;
  }
  sendState();
}

/** Drops a closed tab from the load queue and frees its slot. */
function forgetLoads(tab) {
  const queued = loadQueue.indexOf(tab);
  if (queued !== -1) loadQueue.splice(queued, 1);
  tab.queuedLoad = null;
  releaseLoadSlot(tab);
}

function destroyView(view) {
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function destroyTab(tab) {
  clearTimer(tab);
  forgetLoads(tab);
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
  const copy = createTab({ url: intendedURL(tab), after: tab, select: false, profileId: tab.profileId });
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
  for (const t of tabs) if (t.partition === tab.partition) applyTimeZone(t);
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
  const accountEntry = profileSessionFor(tab.partition);
  if (accountEntry) {
    const profile = findProfile(accountEntry.profileId);
    if (!profile) return;
    const next = nextAccountProxy(profile, accountEntry.proxy, tab.region);
    if (next.error) return notify(next.error);
    accountEntry.proxyInfo = next;
    return setSessionProxy(tab, next.proxy, { reload: true });
  }
  const url = intendedURL(tab);
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
  await loadWhenReady(tab, applyProxy(tab.view.webContents.session, tab.proxy), url);
}

function burnAll() {
  return Promise.all(tabs.filter((t, i) => tabs.findIndex((o) => o.partition === t.partition) === i).map(burnIP));
}

/** Switch To Proxy: moves a tab between the local IP and a proxy without reloading or losing its session. */
function toggleProxy(tab) {
  if (!perTabProxies()) return;
  const entry = profileSessionFor(tab.partition);
  const profile = entry && findProfile(entry.profileId);
  if (profile) {
    entry.proxyInfo = tab.proxy ? { proxy: null, kind: 'direct' } : accountProxy(profile, tab.region);
    return setSessionProxy(tab, entry.proxyInfo.proxy, { reload: false });
  }
  return setSessionProxy(tab, tab.proxy ? null : pool.next(tab.region), { reload: false });
}

/** Switch Between Regions: picks a proxy in the region and reloads; tabs on the local IP just remember it. */
function setRegion(tab, region) {
  if (!perTabProxies() || !pool.regions.includes(region)) return;
  for (const t of tabs) if (t.partition === tab.partition) t.region = region;
  const entry = profileSessionFor(tab.partition);
  if (entry) entry.region = region;
  if (!tab.proxy) return sendState();
  const profile = entry && findProfile(entry.profileId);
  if (profile) {
    if (ownProxies(profile).length > 0) return notify(`${profile.profile} uses its own proxy; its region can't be changed here.`);
    const proxy = pinPoolProxy(profile, region);
    if (!proxy) return notify(`No proxy in ${region.toUpperCase()} is free for ${profile.profile}.`);
    entry.proxyInfo = { proxy, kind: 'pinned' };
    return setSessionProxy(tab, proxy, { reload: true });
  }
  return setSessionProxy(tab, pool.next(region), { reload: true });
}

/** Moves a tab into another session by swapping its view, then loads `url` (default: the page it was on) there. */
async function moveTabToSession(tab, { partition, proxy, region, ready }, url = null) {
  url ??= intendedURL(tab);
  const oldView = tab.view;
  const oldPartition = tab.partition;
  Object.assign(tab, { partition, proxy, region, pendingURL: null, authAttempts: 0, error: null });
  tab.view = createView(tab);
  if (tab.id === selectedId) showSelected();
  destroyView(oldView);
  releasePartition(oldPartition);
  await loadWhenReady(tab, ready, url);
}

/**
 * Assigns a profile to a tab by moving the tab into that profile's own session, so it sees the profile's
 * cookies and logins and uses its IP. Removing the profile gives the tab a fresh private session.
 */
function setProfile(tab, profileId, { force = false, url = null } = {}) {
  const profile = findProfile(profileId);
  if ((profile?.id ?? null) === tab.profileId || mode !== 'browser') {
    if (url && mode === 'browser') loadInTab(tab, url);
    return;
  }
  // Groups never mix: only the active group's accounts go on tabs.
  if (profile && !force && !inActiveGroup(profile)) {
    notify(hasActiveGroup()
      ? `${profile.profile} is in ${groupName(groupKeyOf(profile))}; this session works in ${groupName(settings.activeGroup)}. Restart TabFleet to use another group.`
      : 'Choose the group you are working in first (the group button in the toolbar).');
    return;
  }
  tab.profileId = profile?.id ?? null;
  if (profile) return moveTabToSession(tab, ensureProfileSession(profile), url);
  if (config.isolation === 'shared') {
    return moveTabToSession(tab, { partition: SHARED_PARTITION, proxy: sharedProxy, region: tab.region, ready: Promise.resolve() }, url);
  }
  const partition = newPartition();
  const proxy = config.startDirect ? null : pool.next(tab.region);
  return moveTabToSession(tab, { partition, proxy, region: tab.region, ready: applyProxy(session.fromPartition(partition), proxy) }, url);
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
  const valid = profileIds.filter((id) => inActiveGroup(findProfile(id)));
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
  const sheetUrl = viewURL(info);
  const sheetSession = session.fromPartition(SHEETS_PARTITION);
  const signIn = { error: 'Sign in to Google in the sheet tab, then click Import again.', needsSignIn: true, sheetUrl };

  /** One sheet's CSV, or { error }. */
  const readCSV = async (gid) => {
    const response = await sheetSession.fetch(csvExportURL({ ...info, gid }), { credentials: 'include', redirect: 'follow' });
    if (!info.published && /accounts\.google\.com/.test(response.url)) return signIn;
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
    if (!csv || !csv.trim()) return { csv: '' };
    // Google returns a sign-in HTML page in some private-sheet cases without a redirect; detect that.
    if (/^\s*<!doctype html/i.test(csv) || csv.includes('<html')) return signIn;
    return { csv };
  };

  try {
    // Every sheet in the workbook is imported; each one is a group (its Group column, else the sheet's name).
    let sheets = [];
    try {
      const page = await sheetSession.fetch(sheetListURL(info), { credentials: 'include', redirect: 'follow' });
      if (page.ok && !/accounts\.google\.com/.test(page.url)) sheets = parseSheetList(await page.text());
    } catch {
      // Fall back to the single sheet the link points at.
    }
    if (sheets.length <= 1) {
      const one = await readCSV(info.gid);
      if (one.error) return one;
      if (!one.csv) return { error: 'The sheet is empty.' };
      const result = await importProfilesText(one.csv);
      return { ...result, error: result.imported === 0 ? (result.errors[0] ?? 'No profiles found in the sheet.') : null };
    }

    const imported = [];
    const errors = [];
    const summary = [];
    const recognised = {};
    for (const sheet of sheets) {
      const one = await readCSV(sheet.gid);
      if (one.error) return one;
      const parsed = one.csv ? parseProfilesCSV(one.csv, { defaultGroup: sheet.name }) : { profiles: [], errors: [] };
      imported.push(...parsed.profiles);
      errors.push(...parsed.errors.map((e) => `${sheet.name}: ${e}`));
      Object.assign(recognised, parsed.recognised ?? {});
      const groups = [...new Set(parsed.profiles.map((p) => p.group).filter((g) => g && g !== sheet.name))];
      const skipped = parsed.errors.filter((e) => /are required/.test(e)).length;
      const withCvv = parsed.profiles.filter((p) => p.cards.some((c) => c.cvv)).length;
      summary.push(`${sheet.name}${groups.length ? ` → ${groups.join(', ')}` : ''}: ${parsed.profiles.length} account(s), ${withCvv} with a card/CVV${skipped ? `; ${skipped} empty slot(s) skipped (no Name/Email yet)` : ''}`);
    }
    const notes = mergeProfiles(imported);
    if (imported.length > 0) await saveProfiles();
    return {
      imported: imported.length, total: profiles.length, sheets: summary, notes,
      errors: errors.filter((e) => !/are required/.test(e)).slice(0, 20),
      recognised: Object.entries(recognised).map(([header, field]) => `${header} → ${field}`),
      ignored: [],
      error: imported.length === 0 ? 'No profiles found in any sheet.' : null,
    };
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

/**
 * Copies one secret of the tab's profile (password, proxy password, card number / CVV) straight
 * to the clipboard, so the value itself never reaches the window.
 */
async function copySecret(tab, field) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  const key = String(field ?? '');
  let value = '';
  if (key === 'password') {
    const resolved = await resolveForTab(profile, tab.view.webContents.getURL());
    value = resolved.values.password
      || (await fetchSyncValue(profile.passwordUrl, profile.passwordAuth, 'password')).value
      || profile.password;
  } else if (key === 'proxyPassword') {
    value = (tab.proxy ?? profile.proxy)?.password; // the proxy in use: own, backup or pinned
  } else if (/^card\.\d+\.(number|cvv)$/.test(key)) {
    const [, index, part] = key.split('.');
    value = profile.cards[Number(index)]?.[part];
  } else {
    return { error: `Unknown field ${key}.` };
  }
  if (!value) return { error: 'Nothing saved for that field.' };
  clipboard.writeText(String(value));
  return { ok: true };
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
  // Which of the profile's cards the page is showing (e.g. "Visa ending in 4242" above a CVV box
  // that lives in a payment iframe), so the CVV that gets filled belongs to that card.
  if (profile.cards.length > 0) {
    try {
      const shown = await tab.view.webContents.mainFrame.executeJavaScript(buildCardDigitsScript());
      extras.cardHintLast4 = chooseShownCard(shown, profile.cards);
    } catch {}
  }
  const script = buildAutofillScript(profile, profile.cards[Number(cardIndex) || 0] ?? null, extras);
  const totals = { filled: 0, matched: 0, visible: 0, skipped: 0, iframes: 0, unreachableFrames: 0 };
  const frames = [...tab.view.webContents.mainFrame.framesInSubtree];
  for (const frame of frames) {
    try {
      const part = await frame.executeJavaScript(script);
      if (part && typeof part === 'object') {
        totals.filled += Number(part.filled) || 0;
        totals.matched += Number(part.matched) || 0;
        totals.visible += Number(part.visible) || 0;
        totals.skipped += Number(part.skipped) || 0;
        totals.iframes += Number(part.iframes) || 0;
        if (part.cvvCard) totals.cvvCard = part.cvvCard;
        if (part.cvvMismatch) totals.cvvMismatch = part.cvvMismatch;
      } else {
        totals.filled += Number(part) || 0;
      }
    } catch {
      // Frame refused the script — most commonly a cross-origin iframe (payment widgets, OAuth,
      // CAPTCHA). We can't fill those; just note the count so we can tell the user why.
      totals.unreachableFrames++;
    }
  }
  let error = null;
  if (totals.filled === 0) {
    if (syncErrors.length > 0) error = `Sync issues: ${syncErrors.join('; ')}.`;
    else if (totals.unreachableFrames > 0 || totals.iframes > 0) {
      error = `This page's form appears to be inside an embedded frame (${totals.iframes + totals.unreachableFrames} on this page) — payment widgets like Stripe and 3-D-Secure gateways don't allow autofill from outside. Fill it by hand this time.`;
    }
    else if (totals.visible === 0) error = 'No form fields are visible on this page.';
    else if (totals.matched === 0) error = `None of the ${totals.visible} fields matched a profile value — check the fields' names/labels.`;
    else if (totals.skipped > 0) error = `${totals.skipped} field(s) were already filled; nothing new to fill.`;
    else error = 'No profile value was available for the matching fields.';
  } else if (syncErrors.length > 0) {
    error = `Filled ${totals.filled}, but: ${syncErrors.join('; ')}.`;
  }
  if (totals.cvvMismatch && !totals.cvvCard) {
    const note = `The page shows card •••• ${totals.cvvMismatch}, which isn't on this profile, so the CVV was left empty.`;
    error = error ? `${error} ${note}` : `Filled ${totals.filled} field(s). ${note}`;
  }
  return { filled: totals.filled, error, cvvCard: totals.cvvCard ?? null, cvvMismatch: totals.cvvCard ? null : (totals.cvvMismatch ?? null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (min, max) => min + Math.random() * (max - min);

/**
 * Clicks a point of the page with real mouse input (trusted events with coordinates, a short approach,
 * press and release), as bot protection expects from a person rather than a script's element.click().
 */
async function humanClick(contents, { x, y }) {
  const zoom = contents.getZoomFactor();
  const at = (px, py) => ({ x: Math.round(px * zoom), y: Math.round(py * zoom) });
  const from = { x: x + between(-140, 140), y: y + between(60, 160) };
  const steps = Math.round(between(6, 11));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    contents.sendInputEvent({ type: 'mouseMove', ...at(from.x + (x - from.x) * ease, from.y + (y - from.y) * ease) });
    await sleep(between(8, 22));
  }
  await sleep(between(40, 110));
  contents.sendInputEvent({ type: 'mouseDown', ...at(x, y), button: 'left', clickCount: 1 });
  await sleep(between(50, 120));
  contents.sendInputEvent({ type: 'mouseUp', ...at(x, y), button: 'left', clickCount: 1 });
}

/** Expands an "Add new address/card" collapse OR clicks the primary action button on this page. */
async function submitForm(tab) {
  const contents = tab.view.webContents;
  for (const frame of contents.mainFrame.framesInSubtree) {
    // Points are only known in the top page's coordinates; buttons inside frames are clicked by script.
    const top = frame === contents.mainFrame;
    try {
      const result = await frame.executeJavaScript(buildSubmitScript({ locate: top }));
      if (!result || !(result.expanded || result.submitted)) continue;
      if (result.point) await humanClick(contents, result.point);
      return result.expanded ? { expanded: result.expanded } : { submitted: result.submitted };
    } catch {
      // Frame navigated away or not scriptable.
    }
  }
  return { error: 'No primary action button found on this page.' };
}


/** Returns true if the current page has at least one visible OTP / 2FA field. */
async function pageHasOTPField(tab) {
  try {
    const script = `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      return inputs.some((el) => {
        if (!visible(el) || el.disabled || el.readOnly) return false;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (ac === 'one-time-code') return true;
        const t = [el.name, el.id, el.placeholder, el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
        return /\\botp\\b|one.?time|verif(y|ication).?code|sms.?code|\\bauth.?code\\b|two.?factor|2fa|confirmation.?code/.test(t);
      });
    })()`;
    return Boolean(await tab.view.webContents.executeJavaScript(script));
  } catch { return false; }
}

/** Waits until the page is loaded (did-stop-loading) with a safety cap. */
function waitForLoad(tab, ms = 8000) {
  return new Promise((resolve) => {
    const wc = tab.view.webContents;
    const done = () => { wc.off('did-stop-loading', done); resolve(); };
    wc.on('did-stop-loading', done);
    setTimeout(done, ms);
  });
}

/**
 * Multi-step auto login:
 *   1. Navigate to the profile's homepage.
 *   2. For up to 5 steps: wait for page settle → fill → submit. Handles email-then-password-then-
 *      everything-else flows without any site-specific knowledge.
 *   3. On a step that fills 0 fields but shows an OTP field, poll TextChest/OTP source for 30s
 *      and fill the moment a code arrives.
 */
async function autoLogin(tab, cardIndex = 0) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  if (!profile.url) return { error: 'This profile has no Homepage URL set — add one in the editor so Auto Login knows where to go.' };
  loadInTab(tab, profile.url);

  const steps = [];
  for (let step = 0; step < 5; step++) {
    await waitForLoad(tab, step === 0 ? 8000 : 6000);
    await sleep(step === 0 ? 400 : 600); // let late-rendered scripts attach their fields
    const fill = await autofill(tab, cardIndex);
    if (fill.filled === 0) {
      // Nothing matched. Either we're done, or we're parked on an OTP page waiting for the SMS.
      if (step > 0 && await pageHasOTPField(tab)) {
        const otp = await pollForOTP(tab, cardIndex);
        steps.push(otp);
        if (otp.error) break;
      }
      break;
    }
    await sleep(400);
    const submit = await submitForm(tab);
    steps.push({ filled: fill.filled, submitted: submit.submitted, error: submit.error });
    if (submit.error) break;
    await sleep(1200); // let the next page's URL start loading before we re-check
  }

  const totalFilled = steps.reduce((n, s) => n + (s.filled ?? 0), 0);
  const otpStep = steps.find((s) => s.otpFilled);
  const errorStep = steps.find((s) => s.error);
  if (errorStep) return { filled: totalFilled, error: errorStep.error };
  if (steps.length === 0) return { filled: 0, error: 'Nothing to fill — login form may not be on this page.' };
  return {
    filled: totalFilled,
    submitted: steps.map((s) => s.submitted).filter(Boolean).join(' → '),
    otpFilled: otpStep?.otpFilled ?? 0,
    stepCount: steps.length,
  };
}

/** Poll loop for an OTP page — tries autofill (which pulls the latest code) every 3s for 30s. */
async function pollForOTP(tab, cardIndex) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const otpFill = await autofill(tab, cardIndex);
    if (otpFill.filled > 0) {
      await sleep(300);
      const otpSubmit = await submitForm(tab);
      return { otpFilled: otpFill.filled, submitted: otpSubmit.submitted };
    }
    await sleep(3000);
  }
  return { otpFilled: 0, error: 'Logged in, but no OTP arrived in 30 seconds. Enter it by hand.' };
}

/** Fills the form, waits briefly for the page to react, then clicks the primary action. One click → one page. */
async function autofillAndSubmit(tab, cardIndex = 0) {
  const fillResult = await autofill(tab, cardIndex);
  // If autofill expanded nothing (empty page), submit will try to click "Add new address" instead.
  if (fillResult.filled === 0) {
    const expand = await submitForm(tab);
    if (expand.expanded) return { filled: 0, expanded: expand.expanded, note: `Clicked "${expand.expanded}" — try Autofill & Submit again when the form loads.` };
    return { filled: 0, error: fillResult.error ?? expand.error };
  }
  // Don't press Pay/Continue without a CVV for the card the page is showing.
  if (fillResult.cvvMismatch) return { filled: fillResult.filled, error: fillResult.error };
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
  if (tab?.queuedLoad) startQueuedLoad(tab);
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
  // Page views are drawn above the window UI, so hide the page while a dialog (Settings…) is open.
  if (tab.view.getVisible() === overlayOpen) tab.view.setVisible(!overlayOpen);
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

/** The toolbar's ⋯ menu. Native, so it opens above the page instead of behind it. */
function showMoreMenu() {
  Menu.buildFromTemplate([
    { label: 'Reload Every Tab', click: () => tabs.forEach(reloadTab) },
    { label: 'Save a Screenshot', enabled: Boolean(selectedTab()), click: () => runCommand('screenshot') },
    { type: 'separator' },
    { label: 'Close All Tabs and Start Over', click: () => endSession() },
  ]).popup({ window: win });
}

function showTabMenu(tab) {
  const can = perTabProxies();
  const groupProfiles = profiles.filter(inActiveGroup);
  const profileItems = groupProfiles.slice(0, 40).map((profile) => ({
    label: profile.profile,
    type: 'radio',
    checked: tab.profileId === profile.id,
    click: () => setProfile(tab, profile.id),
  }));
  Menu.buildFromTemplate([
    { label: 'Duplicate Tab', click: () => duplicateTab(tab) },
    {
      label: hasActiveGroup() ? `Set Profile (${groupName(settings.activeGroup)})` : 'Set Profile',
      enabled: groupProfiles.length > 0,
      submenu: [
        { label: 'None', type: 'radio', checked: !tab.profileId, click: () => setProfile(tab, null) },
        ...profileItems,
        ...(groupProfiles.length > 40 ? [{ label: 'More in the Tools panel…', enabled: false }] : []),
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

// Busy pages (single-page apps, queues) fire navigation and title events many times a second in every
// tab. Each state message re-renders the window, so they're coalesced to at most one every
// STATE_INTERVAL_MS and skipped entirely when nothing visible changed.
const STATE_INTERVAL_MS = 100;
let stateTimer = null;
let lastStateAt = 0;
let lastStateJSON = '';

function sendState() {
  if (stateTimer) return;
  const wait = Math.max(0, lastStateAt + STATE_INTERVAL_MS - Date.now());
  stateTimer = setTimeout(flushState, wait);
}

function flushState() {
  stateTimer = null;
  lastStateAt = Date.now();
  if (!win || win.isDestroyed()) return;
  const next = snapshot();
  const json = JSON.stringify(next);
  if (json !== lastStateJSON) {
    lastStateJSON = json;
    win.webContents.send('state', next);
  }
  updateMenu();
}

function snapshot() {
  return {
    mode,
    groups: groupList(),
    activeGroup: hasActiveGroup() ? settings.activeGroup : null,
    perTabProxies: perTabProxies(),
    regions: pool?.regions ?? [],
    selectedId,
    tabs: tabs.map((tab) => {
      const contents = tab.view.webContents;
      // A new view briefly shows the blank page it's prepared on (see prepareView).
      const priming = Boolean(contents.priming) && contents.getURL() === 'about:blank';
      const url = priming ? '' : contents.getURL();
      const profile = findProfile(tab.profileId);
      const onSheet = isSheetsURL(url);
      let host = '';
      try {
        host = new URL(url || tab.lastURL).host;
      } catch {}
      return {
        id: tab.id,
        slot: tab.slot,
        title: (priming ? '' : contents.getTitle()) || (tab.queuedLoad ? 'Waiting to load…' : host || 'New Tab'),
        url: url || tab.lastURL || '',
        // Ads and trackers keep frames loading long after the page is usable; spin for the page only.
        loading: contents.isLoadingMainFrame(),
        queued: Boolean(tab.queuedLoad),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        proxy: proxyLabel(tab.proxy),
        proxyParts: tab.proxy
          ? { host: tab.proxy.host, port: tab.proxy.port, username: tab.proxy.username ?? '', hasPassword: Boolean(tab.proxy.password) }
          : null,
        // For account tabs: 'account' | 'backup' | 'pinned' | 'direct', plus "backup n of m".
        proxyKind: profileSessionFor(tab.partition)?.proxyInfo?.kind ?? null,
        proxyBackup: profileSessionFor(tab.partition)?.proxyInfo?.count > 1
          ? { index: profileSessionFor(tab.partition).proxyInfo.index, count: profileSessionFor(tab.partition).proxyInfo.count }
          : null,
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
  moreMenu: () => showMoreMenu(),
  // Opens the event's Ticketmaster search in a new tab.
  searchEvent: (_tab, event) => {
    const url = sync.eventSearchURL(event);
    if (!url) return;
    // The window asks for the profile first; the tab opens straight in that profile's session.
    const tab = createTab({ url, profileId: event?.profileId ?? null });
    setNote(tab, sync.eventSearchNote(event));
  },
  newTab: () => {
    const tab = createTab();
    // A tab the user opens starts without a profile, so open the picker straight away.
    if (!tab.profileId && profiles.length > 0) win?.webContents.send('toggle-panel', 'pick-profile');
  },
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
  setProfile: (tab, arg) => (arg && typeof arg === 'object'
    ? setProfile(tab, arg.profileId ?? null, { url: typeof arg.url === 'string' ? arg.url : null })
    : setProfile(tab, arg)),
  clearProfileCookies: (tab) => clearProfileCookies(tab),
  autofill: (tab, cardIndex) => autofill(tab, cardIndex),
  autofillSubmit: (tab, cardIndex) => autofillAndSubmit(tab, cardIndex),
  autoLogin: (tab, cardIndex) => autoLogin(tab, cardIndex),
  submitForm: (tab) => submitForm(tab),
  fetchOTP: (tab) => fetchOTPForTab(tab),
  copySecret: (tab, field) => copySecret(tab, field),
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
  // Home: the tab's profile homepage when it has one, otherwise the launch screen's start page.
  home: (tab) => loadInTab(tab, findProfile(tab.profileId)?.url || config.startURL),
  stop: (tab) => tab.view.webContents.stop(),
  back: (tab) => tab.view.webContents.navigationHistory.goBack(),
  forward: (tab) => tab.view.webContents.navigationHistory.goForward(),
  navigate: (tab, input) => loadInTab(tab, input),
  screenshot: (tab) => screenshot(tab).catch((error) => dialog.showErrorBox('Screenshot failed', error.message)),
};

const TABLESS = new Set(['searchEvent', 'moreMenu', 'newTab', 'assignProfiles', 'refreshAll', 'burnAll', 'nextTab', 'previousTab', 'endSession']);

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
  const { group: _group, ...settingsForm } = raw ?? {};
  const next = normalizeConfig(settingsForm);
  const error = validateConfig(next);
  if (error) return error;
  // With several groups the user picks one for this session; it can't change until TabFleet restarts.
  const groups = groupList();
  if (groups.length > 1) {
    const key = typeof raw?.group === 'string' ? raw.group : null;
    if (!groups.some((g) => g.key === key)) return 'Choose the group of accounts to work in.';
    setActiveGroup(key);
  }
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
ipcMain.handle('profiles:export-file', async () => {
  if (profiles.length === 0) return { error: 'No profiles to export yet.' };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export profiles',
    defaultPath: `tabfleet-profiles-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, profilesToCSV(profiles), 'utf8');
  return { exported: profiles.length, path: filePath };
});
ipcMain.handle('profiles:import-text', (_event, text) => importProfilesText(String(text ?? '')));
ipcMain.handle('profiles:delete', (_event, ids) => deleteProfiles(Array.isArray(ids) ? ids : null));
ipcMain.handle('profiles:save', (_event, input) => saveProfileFromEditor(input));
ipcMain.handle('profiles:open-sheet', (_event, url) => openSheetTab(url));
ipcMain.handle('profiles:import-sheet', (_event, url) => importFromSheetURL(url));
ipcMain.handle('groups:switch', (_event, input) => switchGroup(input));
ipcMain.handle('groups:restart', () => restartForGroup());
ipcMain.handle('groups:rename', (_event, input) => renameGroup(input));
ipcMain.handle('sync:get-settings', () => syncSettingsInfo());
ipcMain.handle('sync:save-settings', (_event, input) => saveSyncCredentials(input));
ipcMain.handle('sync:test', async () => {
  const result = await listSyncOrders({ limit: 1 });
  return result.error ? { error: result.error } : { ok: true, count: result.count };
});
ipcMain.handle('orders:list', (_event, params) => listSyncOrders(params ?? {}));
ipcMain.on('overlay', (_event, open) => {
  overlayOpen = Boolean(open);
  layout();
});
ipcMain.on('layout-insets', (_event, next) => {
  insets = {
    top: Math.max(0, Math.round(Number(next?.top) || 0)),
    right: Math.max(0, Math.round(Number(next?.right) || 0)),
    left: Math.max(0, Math.round(Number(next?.left) || 0)),
  };
  layout();
});

// Electron grants every permission a page asks for unless told otherwise, so any site or ad on a page
// could silently use the microphone, camera, location or attached devices. Those are refused; the rest
// (notifications, storage, fullscreen, clipboard writes…) keep Electron's default, so pages see the same
// permission state as before (it's also part of what bot protection fingerprints).
const BLOCKED_PERMISSIONS = new Set([
  'media', 'geolocation', 'clipboard-read', 'hid', 'serial', 'usb', 'midiSysex', 'display-capture',
  'idle-detection', 'window-management', 'openExternal',
]);
const BLOCKED_CHECKS = new Set([...BLOCKED_PERMISSIONS, 'camera', 'microphone', 'audioCapture', 'videoCapture']);
app.on('session-created', (ses) => {
  ses.setUserAgent(app.userAgentFallback, LANGUAGES);
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(!BLOCKED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => !BLOCKED_CHECKS.has(permission));
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

function openSettings() {
  if (!win) return;
  win.webContents.focus();
  win.webContents.send('open-settings');
}

function checkForUpdatesFromMenu() {
  openSettings();
  checkForUpdates({ manual: true });
}

let menuKey = '';

/** Rebuilds the application menu only when something it shows changed (rebuilding it is slow on Windows). */
function updateMenu() {
  const inBrowser = mode === 'browser';
  const can = perTabProxies();
  const key = `${inBrowser}|${can}|${Boolean(selectedTab()?.proxy)}`;
  if (key === menuKey) return;
  menuKey = key;
  const send = (name) => () => runCommand(name);
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        { label: 'Check for Updates…', click: checkForUpdatesFromMenu },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
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
        ...(process.platform === 'darwin' ? [] : [
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings },
          { label: 'Check for Updates…', click: checkForUpdatesFromMenu },
        ]),
        process.platform === 'darwin' ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: inBrowser, click: send('reload') },
        { label: 'Home', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+H' : 'Alt+Home', enabled: inBrowser, click: send('home') },
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
        { label: 'Orders', accelerator: 'CmdOrCtrl+Shift+U', click: () => { win?.webContents.focus(); win?.webContents.send('open-orders'); } },
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
  lastStateJSON = '';
  menuKey = '';
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    title: 'TabFleet',
    backgroundColor: '#0a0a0b',
    frame: true,                  // explicit so Windows draws its standard min / max / close controls
    autoHideMenuBar: false,       // keep the menu bar visible on Windows so File / Window menus are reachable
    minimizable: true,
    maximizable: true,
    closable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.once('did-finish-load', () => {
    updateWindowTitle();
    resolveUAMetadata(win.webContents.executeJavaScript(`navigator.userAgentData?.getHighEntropyValues(
      ['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64', 'formFactors'])`).catch(() => null));
  });
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
  await Promise.all([loadProfiles(), loadSyncCredentials()]);
  createWindow();
  startAutoUpdater();
  ensureActiveGroup();
});

/**
 * Auto-update from GitHub Releases. User data (profiles, snippets, session partitions) lives in the
 * userData directory, which the installer never touches — nothing is deleted on update. Only packaged
 * builds talk to the update server; a dev `electron .` run reports "unsupported" instead.
 *
 * The latest status is kept here (not only pushed to the window) so Settings can show it whenever it
 * opens, including a check that finished before the window had loaded.
 */
const UPDATE_CHECK_INTERVAL = 2 * 60 * 60 * 1000;
const SETTINGS_DEFAULTS = { autoDownload: true, notifyUpdates: true };
let settings = { ...SETTINGS_DEFAULTS };
let autoUpdater = null;
let updateStatus = { kind: 'idle' };
let lastChecked = null;
let manualCheck = false;
let notifiedVersion = null;

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataPath('settings.json'), 'utf8'));
    settings = Object.fromEntries(Object.entries(SETTINGS_DEFAULTS)
      .map(([key, fallback]) => [key, typeof saved[key] === 'boolean' ? saved[key] : fallback]));
    settings.activeGroup = typeof saved.activeGroup === 'string' ? saved.activeGroup : null;
    settings.groupNames = saved.groupNames && typeof saved.groupNames === 'object'
      ? Object.fromEntries(Object.entries(saved.groupNames).filter(([, v]) => typeof v === 'string'))
      : {};
  } catch {
    settings = { ...SETTINGS_DEFAULTS, activeGroup: null, groupNames: {} };
  }
}

function saveSettings(input) {
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (typeof input?.[key] === 'boolean') settings[key] = input[key];
  }
  writeData('settings.json', settings);
  if (autoUpdater) {
    autoUpdater.autoDownload = settings.autoDownload;
    // Turning auto-download on while an update is waiting: fetch it now.
    if (settings.autoDownload && updateStatus.kind === 'available') autoUpdater.downloadUpdate().catch(() => {});
  }
  return updateInfo();
}

function updateInfo() {
  return { version: app.getVersion(), supported: Boolean(autoUpdater), settings: { ...settings }, status: updateStatus, lastChecked };
}

/** First line of an updater error, without the HTTP headers / stack electron-updater appends. */
function shortError(error) {
  return String(error?.message ?? error ?? 'Unknown error').split('\n')[0].slice(0, 200);
}

function setUpdateStatus(status) {
  updateStatus = { ...status, manual: manualCheck };
  if (['up-to-date', 'error', 'available', 'downloaded'].includes(status.kind)) lastChecked = Date.now();
  if (['up-to-date', 'error', 'downloaded'].includes(status.kind)) manualCheck = false;
  win?.webContents.send('update-status', updateInfo());
  const ready = status.kind === 'downloaded' || (status.kind === 'available' && !settings.autoDownload);
  if (ready && settings.notifyUpdates && Notification.isSupported() && notifiedVersion !== `${status.kind}:${status.version}`) {
    notifiedVersion = `${status.kind}:${status.version}`;
    const notice = new Notification({
      title: status.kind === 'downloaded' ? `TabFleet ${status.version} is ready` : `TabFleet ${status.version} is available`,
      body: status.kind === 'downloaded'
        ? 'Restart TabFleet to install it. Your profiles and tabs are kept.'
        : 'Open Settings to download it.',
    });
    notice.on('click', () => {
      if (!win) return;
      win.show();
      win.focus();
      win.webContents.send('open-settings');
    });
    notice.show();
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (!autoUpdater) return updateInfo();
  if (['checking', 'progress'].includes(updateStatus.kind)) return updateInfo();
  if (updateStatus.kind === 'downloaded') return updateInfo();
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({ kind: 'error', message: shortError(error) });
  }
  return updateInfo();
}

function startAutoUpdater() {
  loadSettings();
  ipcMain.handle('update:get-info', () => updateInfo());
  ipcMain.handle('update:check-now', () => checkForUpdates({ manual: true }));
  ipcMain.handle('update:download', () => {
    if (autoUpdater && updateStatus.kind === 'available') {
      autoUpdater.downloadUpdate().catch((error) => setUpdateStatus({ kind: 'error', message: shortError(error) }));
    }
    return updateInfo();
  });
  ipcMain.handle('update:install-now', () => {
    if (autoUpdater && updateStatus.kind === 'downloaded') setImmediate(() => autoUpdater.quitAndInstall());
  });
  ipcMain.handle('settings:save', (_event, input) => saveSettings(input));

  if (!app.isPackaged) {
    updateStatus = { kind: 'unsupported' };
    return;
  }
  try { autoUpdater = require('electron-updater').autoUpdater; }
  catch {
    updateStatus = { kind: 'unsupported' };
    return;
  }
  // Fully offline-friendly: an unreachable update server does not break the app.
  autoUpdater.autoDownload = settings.autoDownload;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => setUpdateStatus({ kind: 'error', message: shortError(error) }));
  autoUpdater.on('checking-for-update', () => setUpdateStatus({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) => setUpdateStatus({ kind: 'available', version: info.version, downloading: settings.autoDownload }));
  autoUpdater.on('update-not-available', () => setUpdateStatus({ kind: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => setUpdateStatus({ kind: 'progress', version: updateStatus.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateStatus({ kind: 'downloaded', version: info.version }));
  // Initial check on startup, then every 2 hours.
  checkForUpdates();
  setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL);
}

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
