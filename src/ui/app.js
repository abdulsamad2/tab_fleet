'use strict';

const $ = (selector) => document.querySelector(selector);

const launcher = $('#launcher');
const browser = $('#browser');
const form = $('#launch-form');
const launchError = $('#launch-error');
const tabsEl = $('#tabs');
const address = $('#address');
const panel = $('#panel');
const noteEl = $('#note');

const PANEL_WIDTH = 300;

let state = { mode: 'launcher', tabs: [], selectedId: null, perTabProxies: false, regions: [] };
let palette = [];
let snippets = [];
let editingSnippets = false;
let profiles = [];
const checkedProfiles = new Set();

const command = (name, tabId, arg) => window.fleet.command(name, tabId, arg);

// ---------- Launcher ----------

function fillForm(config) {
  for (const element of form.elements) {
    if (!element.name) continue;
    const value = element.name.split('.').reduce((object, key) => object?.[key], config);
    if (element.type === 'radio') element.checked = element.value === value;
    else if (element.type === 'checkbox') element.checked = Boolean(value);
    else if (value !== undefined) element.value = value;
  }
  applyTheme(config.theme);
  showProxyFields();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system';
}

function readForm() {
  const config = { rotating: {} };
  for (const element of form.elements) {
    if (!element.name || (element.type === 'radio' && !element.checked)) continue;
    let value = element.value;
    if (element.type === 'number') value = Number(value);
    if (element.type === 'checkbox') value = element.checked;
    const [key, subkey] = element.name.split('.');
    if (subkey) {
      config[key] ??= {};
      config[key][subkey] = value;
    }
    else config[key] = value;
  }
  return config;
}

function showProxyFields() {
  const source = form.elements.proxySource.value;
  for (const group of form.querySelectorAll('[data-source]')) {
    group.hidden = group.dataset.source !== source;
  }
  form.querySelector('[data-needs-proxy]').hidden = source === 'none';
}

function showLaunchError(message) {
  launchError.textContent = message ?? '';
  launchError.hidden = !message;
}

form.addEventListener('change', (event) => {
  if (event.target.name === 'proxySource') showProxyFields();
  if (event.target.name === 'theme') applyTheme(event.target.value);
  showLaunchError(null);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    showLaunchError(await window.fleet.launch(readForm()));
  } finally {
    button.disabled = false;
  }
});

// ---------- Tab strip & toolbar ----------

function selectedTab() {
  return state.tabs.find((tab) => tab.id === state.selectedId) ?? null;
}

function formatRemaining(endsAt) {
  const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderTabs() {
  const existing = new Map([...tabsEl.children].map((el) => [el.dataset.id, el]));
  state.tabs.forEach((tab, index) => {
    let el = existing.get(tab.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = tab.id;
      el.setAttribute('role', 'tab');
      el.innerHTML = '<span class="slot"></span><span class="spinner" hidden></span><span class="title"></span>'
        + '<span class="profile-tag" hidden></span>'
        + '<span class="note-dot" hidden title="Has a note"></span><span class="timer" hidden></span>'
        + '<button class="close" aria-label="Close tab">×</button>';
    }
    existing.delete(tab.id);
    el.querySelector('.slot').textContent = tab.slot;
    el.querySelector('.title').textContent = tab.title;
    el.querySelector('.spinner').hidden = !tab.loading;
    el.querySelector('.note-dot').hidden = !tab.note;
    const profileTag = el.querySelector('.profile-tag');
    profileTag.hidden = !tab.profileName;
    profileTag.textContent = tab.profileName ?? '';
    const timer = el.querySelector('.timer');
    timer.hidden = !tab.timerEndsAt && !tab.timerDone;
    timer.dataset.endsAt = tab.timerEndsAt ?? '';
    timer.textContent = tab.timerDone ? 'Check' : tab.timerEndsAt ? formatRemaining(tab.timerEndsAt) : '';
    el.title = `${tab.title}\n${tab.url}\n${tab.proxy ? `Proxy: ${tab.proxy}` : 'Local IP'}${tab.profileName ? `\nProfile: ${tab.profileName}` : ''}`;
    el.classList.toggle('has-error', Boolean(tab.error));
    el.classList.toggle('timer-done', tab.timerDone);
    if (tab.color) el.style.setProperty('--tab-color', tab.color);
    else el.style.removeProperty('--tab-color');
    el.setAttribute('aria-selected', String(tab.id === state.selectedId));
    if (tabsEl.children[index] !== el) tabsEl.insertBefore(el, tabsEl.children[index] ?? null);
  });
  for (const el of existing.values()) el.remove();
  tabsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderToolbar() {
  const tab = selectedTab();
  $('[data-cmd="back"]').disabled = !tab?.canGoBack;
  $('[data-cmd="forward"]').disabled = !tab?.canGoForward;
  const reload = $('#reload');
  reload.textContent = tab?.loading ? '×' : '↻';
  reload.title = tab?.loading ? 'Stop' : 'Reload (Ctrl/⌘ R)';
  for (const button of document.querySelectorAll('[data-cmd="burn"], [data-cmd="burnAll"]')) {
    button.disabled = !state.perTabProxies;
  }
  if (document.activeElement !== address) address.value = tab?.url ?? '';

  const toggle = $('#proxy-toggle');
  toggle.disabled = !state.perTabProxies;
  toggle.textContent = tab?.proxy ? `● ${tab.proxy}` : '○ Local IP';
  toggle.classList.toggle('direct', !tab?.proxy);
  toggle.title = state.perTabProxies
    ? `${tab?.proxy ? 'Switch this tab to your local IP' : 'Switch this tab to a proxy'} without losing its session (Ctrl/⌘ Shift P)`
    : 'Per-tab proxies need a proxy source and separate sessions';

  const region = $('#region');
  region.hidden = !state.perTabProxies || state.regions.length === 0;
  if (region.options.length !== state.regions.length) {
    region.replaceChildren(...state.regions.map((code) => new Option(code.toUpperCase(), code)));
  }
  region.value = tab?.region ?? '';

  $('#error-bar').hidden = !tab?.error;
  $('#error-text').textContent = tab?.error ?? '';
}

// ---------- Tools panel ----------

function setPanelOpen(open) {
  panel.hidden = !open;
  $('#panel-toggle').setAttribute('aria-pressed', String(open));
  try {
    localStorage.setItem('panelOpen', open ? '1' : '');
  } catch {}
  reportInsets();
}

function renderSwatches() {
  const container = $('#swatches');
  const none = document.createElement('button');
  none.className = 'swatch none';
  none.textContent = '∅';
  none.title = 'No color';
  none.dataset.color = '';
  container.replaceChildren(none, ...palette.map(({ name, hex }) => {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.title = name;
    button.dataset.color = hex;
    button.style.setProperty('--swatch', hex);
    return button;
  }));
  for (const button of container.children) button.setAttribute('role', 'radio');
}

function renderPanel() {
  const tab = selectedTab();
  if (!tab) return;
  $('#panel-slot').textContent = tab.slot;
  $('#panel-proxy').textContent = tab.proxy ? `Proxy: ${tab.proxy}` : 'Local IP';
  for (const swatch of $('#swatches').children) {
    swatch.setAttribute('aria-checked', String((swatch.dataset.color || null) === tab.color));
  }
  $('#timer-running').hidden = !tab.timerEndsAt;
  $('#timer-left').textContent = tab.timerEndsAt ? formatRemaining(tab.timerEndsAt) : '';
  renderProfilePanel(tab);
  if (noteEl.dataset.tabId !== tab.id) flushNote();
  if ((document.activeElement !== noteEl && !noteTimer) || noteEl.dataset.tabId !== tab.id) {
    noteEl.value = tab.note;
    noteEl.dataset.tabId = tab.id;
  }
}

function renderSnippets() {
  const list = $('#snippets');
  list.replaceChildren(...snippets.map((snippet) => {
    const item = document.createElement('li');
    const label = document.createElement('div');
    label.className = 'label';
    const name = document.createElement('strong');
    name.textContent = snippet.label;
    const value = document.createElement('span');
    value.textContent = snippet.secret ? '••••••' : snippet.value;
    label.append(name, value);
    item.append(label);
    const buttons = editingSnippets
      ? [['Remove', 'remove']]
      : [['Insert', 'insert'], ['Copy', 'copy']];
    for (const [text, action] of buttons) {
      const button = document.createElement('button');
      button.textContent = text;
      button.className = action;
      button.dataset.action = action;
      button.dataset.id = snippet.id;
      item.append(button);
    }
    return item;
  }));
  $('#snippet-form').hidden = !editingSnippets;
  $('#snippet-edit').textContent = editingSnippets ? 'Done' : 'Edit';
}

$('#panel-toggle').addEventListener('click', () => setPanelOpen(panel.hidden));
window.fleet.onTogglePanel((section) => {
  if (section === 'profiles') {
    setPanelOpen(true);
    $('#profile-search').focus();
  } else {
    setPanelOpen(panel.hidden);
  }
});

$('#swatches').addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (swatch) command('setColor', state.selectedId, swatch.dataset.color || null);
});

$('#timer-presets').addEventListener('click', (event) => {
  const minutes = event.target.dataset?.minutes;
  if (minutes) command('setTimer', state.selectedId, Number(minutes));
});
$('#timer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const minutes = Number($('#timer-minutes').value);
  if (minutes > 0) command('setTimer', state.selectedId, minutes);
  $('#timer-minutes').value = '';
});
$('#timer-clear').addEventListener('click', () => command('setTimer', state.selectedId, 0));

// Notes save shortly after typing stops; until then renderPanel must not overwrite the textarea.
let noteTimer = null;
function flushNote() {
  if (!noteTimer) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  command('setNote', noteEl.dataset.tabId, noteEl.value);
}
noteEl.addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 300);
});
noteEl.addEventListener('blur', flushNote);
$('#note-copy').addEventListener('click', () => command('copy', undefined, noteEl.value));
$('#note-insert').addEventListener('click', () => command('insertText', state.selectedId, noteEl.value));

$('#snippet-edit').addEventListener('click', () => {
  editingSnippets = !editingSnippets;
  renderSnippets();
});
$('#snippets').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const snippet = snippets.find((s) => s.id === button.dataset.id);
  if (!snippet) return;
  if (button.dataset.action === 'insert') command('insertText', state.selectedId, snippet.value);
  if (button.dataset.action === 'copy') command('copy', undefined, snippet.value);
  if (button.dataset.action === 'remove') {
    snippets = snippets.filter((s) => s !== snippet);
    await window.fleet.saveSnippets(snippets);
    renderSnippets();
  }
});
$('#snippet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = event.target.elements;
  snippets.push({
    id: crypto.randomUUID(),
    label: fields.label.value.trim(),
    value: fields.value.value,
    secret: fields.secret.checked,
  });
  await window.fleet.saveSnippets(snippets);
  event.target.reset();
  renderSnippets();
});

// ---------- Profiles ----------

function showNotice(text) {
  const notice = $('#notice');
  notice.textContent = text;
  notice.hidden = !text;
  clearTimeout(showNotice.timer);
  if (text) showNotice.timer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function describeImport(result) {
  if (!result) return '';
  const problems = result.errors.length ? ` ${result.errors.length} problem(s): ${result.errors[0]}` : '';
  return `Imported ${result.imported} profile(s); ${result.total} saved.${problems}`;
}

async function refreshProfiles() {
  profiles = await window.fleet.listProfiles();
  for (const id of [...checkedProfiles]) if (!profiles.some((p) => p.id === id)) checkedProfiles.delete(id);
  render();
}

function searchProfiles(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return profiles.filter((p) => {
    const haystack = `${p.profile} ${p.name} ${p.email} ${p.group}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function renderProfilePanel(tab) {
  const profile = profiles.find((p) => p.id === tab.profileId);
  const current = $('#profile-current');
  current.hidden = !profile;
  if (profile) {
    const lines = [
      profile.name,
      profile.email,
      [profile.address1, profile.address2].filter(Boolean).join(', '),
      [profile.city, profile.state, profile.zip].filter(Boolean).join(' '),
      profile.phone && `☎ ${profile.phone}`,
      profile.hasProxy && 'Uses its own proxy',
    ].filter(Boolean);
    current.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: profile.profile }),
      ...lines.map((line) => Object.assign(document.createElement('span'), { textContent: line })),
      Object.assign(document.createElement('div'), { className: 'profile-actions' }),
    );
    current.lastChild.append(
      Object.assign(document.createElement('button'), { className: 'link', textContent: 'Remove from tab', id: 'profile-clear' }),
      Object.assign(document.createElement('button'), {
        className: 'link danger', textContent: 'Clear cookies', id: 'profile-clear-cookies',
        title: "Log this profile out: clears its cookies and site data in every tab that uses it",
      }),
    );
  }
  const cardSelect = $('#autofill-card');
  $('#autofill-row').hidden = !profile;
  if (cardSelect.dataset.profileId !== (profile?.id ?? '')) {
    cardSelect.replaceChildren(...(profile?.cards.length
      ? profile.cards.map((card, i) => new Option(`Card •••• ${card.last4}${card.expMonth ? ` (${card.expMonth}/${card.expYear.slice(-2)})` : ''}`, i))
      : [new Option('No card', 0)]));
    cardSelect.dataset.profileId = profile?.id ?? '';
  }

  const matches = searchProfiles($('#profile-search').value).slice(0, 12);
  $('#profile-results').replaceChildren(...matches.map((p) => {
    const item = document.createElement('li');
    item.dataset.id = p.id;
    item.classList.toggle('active', p.id === tab.profileId);
    const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: checkedProfiles.has(p.id), title: 'Include in "Assign to all tabs"' });
    const label = document.createElement('div');
    label.className = 'label';
    label.append(
      Object.assign(document.createElement('strong'), { textContent: p.profile }),
      Object.assign(document.createElement('span'), { textContent: [p.email, p.group].filter(Boolean).join(' · ') }),
    );
    const use = Object.assign(document.createElement('button'), { textContent: p.id === tab.profileId ? 'In use' : 'Use', disabled: p.id === tab.profileId });
    use.dataset.action = 'use';
    item.append(check, label, use);
    return item;
  }));
  if (profiles.length === 0) {
    $('#profile-results').replaceChildren(Object.assign(document.createElement('li'), {
      className: 'hint',
      textContent: 'No profiles yet. Import a CSV with Profile, Name and Email columns (plus address, phone, proxy and card columns).',
    }));
  }
  $('#profile-bulk').hidden = profiles.length === 0;
}

$('#profile-search').addEventListener('input', () => renderPanel());
$('#profile-results').addEventListener('click', (event) => {
  const item = event.target.closest('li[data-id]');
  if (!item) return;
  if (event.target.matches('input[type="checkbox"]')) {
    if (event.target.checked) checkedProfiles.add(item.dataset.id);
    else checkedProfiles.delete(item.dataset.id);
  } else if (event.target.dataset.action === 'use') {
    command('setProfile', state.selectedId, item.dataset.id);
  }
});
$('#profile-current').addEventListener('click', (event) => {
  if (event.target.id === 'profile-clear') command('setProfile', state.selectedId, null);
  if (event.target.id === 'profile-clear-cookies' && confirm('Clear this profile\'s cookies? It will be logged out of every site in all its tabs.')) {
    command('clearProfileCookies', state.selectedId);
  }
});
$('#profile-import').addEventListener('click', async () => {
  showNotice(describeImport(await window.fleet.importProfilesFile()));
});
window.fleet.onProfilesImported((result) => showNotice(describeImport(result)));
window.fleet.onProfilesChanged(refreshProfiles);
$('#profile-assign-all').addEventListener('click', async () => {
  const ordered = profiles.filter((p) => checkedProfiles.has(p.id)).map((p) => p.id);
  if (ordered.length === 0) return showNotice('Tick at least one profile first.');
  await window.fleet.invoke('assignProfiles', undefined, { profileIds: ordered, repeat: $('#profile-repeat').checked });
  showNotice(`Assigned ${ordered.length} profile(s) across tabs.`);
});
$('#profile-delete-all').addEventListener('click', async () => {
  if (!confirm(`Delete all ${profiles.length} saved profiles? This can't be undone.`)) return;
  await window.fleet.deleteProfiles(null);
});
$('#autofill').addEventListener('click', async () => {
  const result = await window.fleet.invoke('autofill', state.selectedId, Number($('#autofill-card').value) || 0);
  if (result) showNotice(result.error ?? `Filled ${result.filled} field(s). Review the form before submitting.`);
});

// ---------- Rendering ----------

function render() {
  const inBrowser = state.mode === 'browser';
  launcher.hidden = inBrowser;
  browser.hidden = !inBrowser;
  if (!inBrowser) return;
  renderTabs();
  renderToolbar();
  renderPanel();
}

// Countdowns tick locally between state updates.
setInterval(() => {
  for (const timer of tabsEl.querySelectorAll('.timer[data-ends-at]:not([data-ends-at=""])')) {
    timer.textContent = formatRemaining(Number(timer.dataset.endsAt));
  }
  const tab = selectedTab();
  if (tab?.timerEndsAt) $('#timer-left').textContent = formatRemaining(tab.timerEndsAt);
}, 1000);

tabsEl.addEventListener('click', (event) => {
  const el = event.target.closest('.tab');
  if (!el) return;
  if (event.target.closest('.close')) command('closeTab', el.dataset.id);
  else command('selectTab', el.dataset.id);
});
tabsEl.addEventListener('auxclick', (event) => {
  const el = event.target.closest('.tab');
  if (el && event.button === 1) command('closeTab', el.dataset.id);
});
tabsEl.addEventListener('contextmenu', (event) => {
  const el = event.target.closest('.tab');
  if (!el) return;
  event.preventDefault();
  command('tabMenu', el.dataset.id);
});

$('#new-tab').addEventListener('click', () => command('newTab'));
$('#reload').addEventListener('click', () => command(selectedTab()?.loading ? 'stop' : 'reload'));
for (const button of document.querySelectorAll('[data-cmd]')) {
  button.addEventListener('click', () => command(button.dataset.cmd));
}
$('#region').addEventListener('change', (event) => command('setRegion', state.selectedId, event.target.value));

$('#address-form').addEventListener('submit', (event) => {
  event.preventDefault();
  command('navigate', undefined, address.value);
  address.blur();
});
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    address.value = selectedTab()?.url ?? '';
    address.blur();
  }
});

// Tab views sit below the chrome and left of the panel, so main needs both whenever they change.
function reportInsets() {
  window.fleet.setInsets({
    top: Math.ceil($('#chrome').getBoundingClientRect().height),
    right: panel.hidden ? 0 : PANEL_WIDTH,
  });
  panel.style.top = `${Math.ceil($('#chrome').getBoundingClientRect().height)}px`;
}
new ResizeObserver(reportInsets).observe($('#chrome'));

window.fleet.onState((next) => {
  state = next;
  render();
});
window.fleet.onFocusAddress(() => address.focus());

Promise.all([window.fleet.getInitial(), window.fleet.getSnippets(), window.fleet.listProfiles()]).then(([initial, savedSnippets, savedProfiles]) => {
  palette = initial.palette;
  snippets = savedSnippets;
  profiles = savedProfiles;
  $('#timer-presets').replaceChildren(...initial.timerPresets.map((minutes) => {
    const button = document.createElement('button');
    button.textContent = `${minutes}m`;
    button.dataset.minutes = minutes;
    return button;
  }));
  renderSwatches();
  renderSnippets();
  fillForm(initial.config);
  let panelOpen = false;
  try {
    panelOpen = localStorage.getItem('panelOpen') === '1';
  } catch {}
  setPanelOpen(panelOpen);
  state = initial.state;
  render();
});
