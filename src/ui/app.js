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
        + '<span class="note-dot" hidden title="Has a note"></span><span class="timer" hidden></span>'
        + '<button class="close" aria-label="Close tab">×</button>';
    }
    existing.delete(tab.id);
    el.querySelector('.slot').textContent = tab.slot;
    el.querySelector('.title').textContent = tab.title;
    el.querySelector('.spinner').hidden = !tab.loading;
    el.querySelector('.note-dot').hidden = !tab.note;
    const timer = el.querySelector('.timer');
    timer.hidden = !tab.timerEndsAt && !tab.timerDone;
    timer.dataset.endsAt = tab.timerEndsAt ?? '';
    timer.textContent = tab.timerDone ? 'Check' : tab.timerEndsAt ? formatRemaining(tab.timerEndsAt) : '';
    el.title = `${tab.title}\n${tab.url}\n${tab.proxy ? `Proxy: ${tab.proxy}` : 'Local IP'}`;
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
window.fleet.onTogglePanel(() => setPanelOpen(panel.hidden));

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

Promise.all([window.fleet.getInitial(), window.fleet.getSnippets()]).then(([initial, savedSnippets]) => {
  palette = initial.palette;
  snippets = savedSnippets;
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
