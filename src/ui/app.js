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

const PANEL_WIDTH = 320;

let state = { mode: 'launcher', tabs: [], selectedId: null, perTabProxies: false, regions: [] };
let palette = [];
let snippets = [];
let editingSnippets = false;
let profiles = [];
let selectedPreviewId = null; // which profile is shown in the preview area (independent of the tab)
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
  // Multi-line reports (import, test sync) need pre-wrap and a longer window to read.
  const multiline = typeof text === 'string' && text.includes('\n');
  notice.style.whiteSpace = multiline ? 'pre-wrap' : '';
  clearTimeout(showNotice.timer);
  const timeout = multiline ? 30000 : 5000;
  if (text) showNotice.timer = setTimeout(() => { notice.hidden = true; notice.style.whiteSpace = ''; }, timeout);
}

function describeImport(result) {
  if (!result) return '';
  const lines = [`Imported ${result.imported} profile(s); ${result.total} saved.`];
  if (result.recognised?.length) lines.push(`Recognised columns: ${result.recognised.join('; ')}`);
  if (result.ignored?.length) lines.push(`Ignored columns (unrecognised): ${result.ignored.join(', ')}`);
  if (result.errors?.length) lines.push(`Problems (${result.errors.length}): ${result.errors.slice(0, 3).join(' · ')}`);
  return lines.join('\n');
}

async function refreshProfiles() {
  profiles = await window.fleet.listProfiles();
  for (const id of [...checkedProfiles]) if (!profiles.some((p) => p.id === id)) checkedProfiles.delete(id);
  render();
}

// Jancy-style search: free text across profile/name/email/group/site/buyer/notes, plus operators
// group:X, site:X, has:password|proxy|resolver|card, and the bare word "favorite" / "fav".
function searchProfiles(query) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return profiles;
  const terms = [];
  const requires = [];
  for (const token of tokens) {
    const colon = token.indexOf(':');
    const key = colon === -1 ? null : token.slice(0, colon);
    const value = colon === -1 ? token : token.slice(colon + 1);
    if (!key) {
      if (token === 'favorite' || token === 'fav' || token === 'starred') requires.push((p) => p.favorite);
      else terms.push(token);
      continue;
    }
    if (key === 'group') requires.push((p) => (p.group ?? '').toLowerCase().includes(value));
    else if (key === 'site') requires.push((p) => (p.site ?? '').toLowerCase().includes(value)
      || (p.resolvers ?? []).some((c) => c.site.toLowerCase().includes(value)));
    else if (key === 'has') {
      if (value === 'password') requires.push((p) => p.hasPassword || p.hasPasswordUrl);
      else if (value === 'proxy') requires.push((p) => p.hasProxy);
      else if (value === 'resolver') requires.push((p) => (p.resolvers ?? []).length > 0);
      else if (value === 'card') requires.push((p) => (p.cards ?? []).length > 0);
    } else terms.push(token);
  }
  return profiles.filter((p) => {
    const haystack = `${p.profile} ${p.name} ${p.email} ${p.group ?? ''} ${p.site ?? ''} ${p.buyer ?? ''} ${p.notes ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term)) && requires.every((check) => check(p));
  });
}

/** Renders the Jancy-style detail view for whichever profile the user has selected in the list. */
function renderProfilePreview(profile, tab) {
  const preview = $('#profile-preview');
  if (!profile) { preview.hidden = true; return; }
  preview.hidden = false;
  const section = (title) => {
    const header = document.createElement('div');
    header.className = 'preview-section';
    header.textContent = title;
    return header;
  };
  const line = (icon, text) => {
    if (!text) return null;
    const el = document.createElement('span');
    el.textContent = icon ? `${icon} ${text}` : text;
    return el;
  };
  const inUseOn = state.tabs.filter((t) => t.profileId === profile.id).map((t) => t.slot);

  // Identity header.
  const identity = document.createElement('div');
  identity.className = 'preview-identity';
  const header = document.createElement('div');
  header.className = 'preview-header';
  const name = document.createElement('strong');
  name.append(profile.favorite ? '★ ' : '', profile.profile);
  if (profile.site) name.append(Object.assign(document.createElement('span'), { className: 'site-tag', textContent: profile.site }));
  const star = Object.assign(document.createElement('button'), {
    className: `preview-fav${profile.favorite ? ' on' : ''}`,
    textContent: profile.favorite ? '★' : '☆',
    title: profile.favorite ? 'Unstar' : 'Favorite',
  });
  star.dataset.action = 'favorite';
  header.append(name, star);
  identity.append(header, line(null, profile.name), line(null, profile.email));
  if (inUseOn.length) {
    identity.append(Object.assign(document.createElement('span'), {
      className: 'in-use-note',
      textContent: `In use on tab${inUseOn.length > 1 ? 's' : ''} ${inUseOn.join(', ')}`,
    }));
  }
  preview.replaceChildren(identity);

  // Address.
  const addressLines = [
    [profile.address1, profile.address2].filter(Boolean).join(', '),
    [profile.city, profile.state, profile.zip].filter(Boolean).join(' '),
    profile.country,
  ].filter(Boolean);
  if (addressLines.length) {
    preview.append(section('Address'));
    for (const addr of addressLines) preview.append(line(null, addr));
  }

  // Contact.
  const contactLines = [
    profile.phone && line('☎', profile.phone),
    profile.smsNumber && line('📱', `SMS ${profile.smsNumber}`),
    profile.dob && line('🎂', profile.dob),
    profile.buyer && line('👤', profile.buyer),
    profile.url && line('🌐', profile.url),
  ].filter(Boolean);
  if (contactLines.length) {
    preview.append(section('Contact'));
    for (const l of contactLines) preview.append(l);
  }

  // Credentials & sync.
  const credsLines = [
    profile.hasPasswordUrl ? line('🔗', `Password synced from ${profile.passwordUrlHost}`) : (profile.hasPassword && line('🔑', 'Login password saved')),
    profile.hasTextChestKey && line('📲', 'TextChest key saved'),
    profile.hasOtpUrl && line('📱', `OTP endpoint ${profile.otpUrlHost}`),
    ...(profile.resolvers ?? []).map((col) =>
      line('🧩', `Site:${col.site} → ${col.entries.map((e) => `${e.field}=${e.resolver}`).join(', ')}`)),
  ].filter(Boolean);
  if (credsLines.length) {
    preview.append(section('Credentials & sync'));
    for (const l of credsLines) preview.append(l);
  }

  // Cards.
  if (profile.cards.length) {
    preview.append(section('Cards'));
    for (const card of profile.cards) {
      preview.append(line('💳', `•••• ${card.last4}${card.expMonth ? `  ${card.expMonth}/${String(card.expYear).slice(-2)}` : ''}${card.name ? `  ${card.name}` : ''}`));
    }
  }

  // Proxy (shown only when present, as Jancy does).
  if (profile.hasProxy) {
    preview.append(section('Proxy'));
    preview.append(line(null, profile.proxyLabel));
  }

  // Notes.
  if (profile.notes) {
    preview.append(section('Notes'));
    preview.append(line('📝', profile.notes));
  }

  // Action row.
  const actions = document.createElement('div');
  actions.className = 'preview-actions';
  const onThisTab = profile.id === tab.profileId;
  actions.append(
    Object.assign(document.createElement('button'), {
      className: 'primary-soft', textContent: onThisTab ? `In use on tab ${tab.slot}` : `Use on tab ${tab.slot}`,
      disabled: onThisTab,
    }),
    Object.assign(document.createElement('button'), { textContent: 'Edit' }),
    Object.assign(document.createElement('button'), {
      className: 'danger', textContent: 'Clear cookies',
      title: "Log this profile out of every tab that uses it",
    }),
  );
  actions.children[0].dataset.action = 'use';
  actions.children[1].dataset.action = 'edit';
  actions.children[2].dataset.action = 'clear-cookies';
  preview.append(actions);
}

function renderProfilePanel(tab) {
  const tabProfile = profiles.find((p) => p.id === tab.profileId);
  // Strip at the top: "Tab 2 → Bravo" so the user knows what the current tab has, without taking much space.
  const strip = $('#tab-current-profile');
  if (tabProfile) {
    strip.hidden = false;
    strip.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'strip-label', textContent: `Tab ${tab.slot} →` }),
      Object.assign(document.createElement('strong'), { textContent: tabProfile.profile }),
      Object.assign(document.createElement('button'), {
        className: 'link', textContent: 'Remove', id: 'strip-clear', title: 'Remove this profile from the current tab',
      }),
    );
  } else {
    strip.hidden = true;
  }

  // The preview shows whichever profile the user clicked in the list (not necessarily the tab's).
  // Default to the tab's profile when nothing has been clicked yet in this session.
  const previewId = selectedPreviewId && profiles.some((p) => p.id === selectedPreviewId) ? selectedPreviewId : tab.profileId;
  const previewProfile = profiles.find((p) => p.id === previewId) ?? null;
  renderProfilePreview(previewProfile, tab);

  // Autofill row only makes sense when the tab has a profile assigned.
  const cardSelect = $('#autofill-card');
  $('#autofill-row').hidden = !tabProfile;
  const hasSmsResolver = (tabProfile?.resolvers ?? []).some((col) =>
    col.entries.some((e) => ['smscode', 'emailcode', 'othercode'].includes(e.field)));
  $('#fetch-otp').hidden = !(tabProfile && (tabProfile.hasOtpUrl || tabProfile.hasTextChestKey || hasSmsResolver));
  if (cardSelect.dataset.profileId !== (tabProfile?.id ?? '')) {
    cardSelect.replaceChildren(...(tabProfile?.cards.length
      ? tabProfile.cards.map((card, i) => new Option(`Card •••• ${card.last4}${card.expMonth ? ` (${card.expMonth}/${card.expYear.slice(-2)})` : ''}`, i))
      : [new Option('No card', 0)]));
    cardSelect.dataset.profileId = tabProfile?.id ?? '';
  }

  // Keep the group filter in sync with whatever groups are present.
  const groups = [...new Set(profiles.map((p) => p.group).filter(Boolean))].sort();
  const groupFilter = $('#profile-group-filter');
  const currentGroup = groupFilter.value;
  groupFilter.replaceChildren(
    new Option('All groups', ''),
    ...groups.map((g) => new Option(g, g)),
  );
  groupFilter.value = groups.includes(currentGroup) ? currentGroup : '';

  const favOnly = $('#profile-fav-only').checked;
  const groupPick = groupFilter.value;
  const matches = searchProfiles($('#profile-search').value)
    .filter((p) => !favOnly || p.favorite)
    .filter((p) => !groupPick || p.group === groupPick)
    .slice(0, 20);

  // Which tab slots use each profile — so the row can show "On tabs 1, 3".
  const slotsByProfile = new Map();
  for (const t of state.tabs) {
    if (!t.profileId) continue;
    if (!slotsByProfile.has(t.profileId)) slotsByProfile.set(t.profileId, []);
    slotsByProfile.get(t.profileId).push(t.slot);
  }

  $('#profile-results').replaceChildren(...matches.map((p) => {
    const slots = slotsByProfile.get(p.id) ?? [];
    const inUseHere = p.id === tab.profileId;
    const item = document.createElement('li');
    item.dataset.id = p.id;
    item.classList.toggle('active', inUseHere);
    item.classList.toggle('in-use', slots.length > 0);
    item.classList.toggle('selected', p.id === selectedPreviewId);
    const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: checkedProfiles.has(p.id), title: 'Include in "Assign to all tabs"' });
    const star = Object.assign(document.createElement('button'), {
      className: `fav${p.favorite ? ' on' : ''}`,
      textContent: p.favorite ? '★' : '☆',
      title: p.favorite ? 'Unstar' : 'Favorite',
    });
    star.dataset.action = 'favorite';
    const label = document.createElement('div');
    label.className = 'label';
    const name = Object.assign(document.createElement('strong'), { textContent: p.profile });
    if (p.site) name.append(Object.assign(document.createElement('span'), { className: 'site-tag', textContent: p.site }));
    if (slots.length > 0) {
      name.append(Object.assign(document.createElement('span'), {
        className: 'in-use-tag', textContent: slots.length === 1 ? `On tab ${slots[0]}` : `On ${slots.length} tabs`,
        title: `Assigned to tab${slots.length === 1 ? '' : 's'} ${slots.join(', ')}`,
      }));
    }
    label.append(
      name,
      Object.assign(document.createElement('span'), { textContent: [p.email, p.group].filter(Boolean).join(' · ') }),
    );
    const use = Object.assign(document.createElement('button'), { textContent: inUseHere ? 'In use' : 'Use', disabled: inUseHere });
    use.dataset.action = 'use';
    const more = Object.assign(document.createElement('button'), { className: 'more', textContent: '⋮', title: 'More actions' });
    more.dataset.action = 'menu';
    item.append(check, star, label, use, more);
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
$('#profile-group-filter').addEventListener('change', () => renderPanel());
$('#profile-fav-only').addEventListener('change', () => renderPanel());

const profileMenu = $('#profile-menu');
function openProfileMenu(profile, anchor) {
  const rect = anchor.getBoundingClientRect();
  profileMenu.replaceChildren(
    ...(profile.url ? [menuButton('🌐 Open homepage in a new tab', 'open-url')] : []),
    menuButton('✏ Edit', 'edit'),
    menuButton(profile.favorite ? '☆ Unstar' : '★ Favorite', 'favorite'),
    menuButton('👯 Duplicate as new profile', 'duplicate'),
    menuButton('🗑 Delete', 'delete', true),
  );
  profileMenu.dataset.id = profile.id;
  profileMenu.hidden = false;
  profileMenu.style.top = `${rect.bottom + 2}px`;
  // Panel is now on the left; align the menu's right edge to the button so it stays inside the panel.
  profileMenu.style.left = `${Math.max(8, rect.right - 200)}px`;
  profileMenu.style.right = '';
}
function menuButton(label, action, danger = false) {
  const button = Object.assign(document.createElement('button'), { textContent: label });
  button.dataset.action = action;
  button.className = danger ? 'danger' : '';
  return button;
}
function closeProfileMenu() { profileMenu.hidden = true; }
document.addEventListener('click', (event) => {
  if (!profileMenu.hidden && !event.target.closest('#profile-menu') && event.target.dataset.action !== 'menu') closeProfileMenu();
});

$('#profile-results').addEventListener('click', async (event) => {
  const item = event.target.closest('li[data-id]');
  if (!item) return;
  const profile = profiles.find((p) => p.id === item.dataset.id);
  if (!profile) return;
  const action = event.target.dataset.action;
  if (event.target.matches('input[type="checkbox"]')) {
    if (event.target.checked) checkedProfiles.add(profile.id);
    else checkedProfiles.delete(profile.id);
  } else if (action === 'use') command('setProfile', state.selectedId, profile.id);
  else if (action === 'edit') openEditor(profile);
  else if (action === 'favorite') {
    await window.fleet.saveProfile({ id: profile.id, favorite: !profile.favorite });
  } else if (action === 'menu') {
    openProfileMenu(profile, event.target);
  } else {
    // Plain-row click = Jancy-style select-for-preview.
    selectedPreviewId = profile.id;
    renderPanel();
  }
});
$('#profile-results').addEventListener('contextmenu', (event) => {
  const item = event.target.closest('li[data-id]');
  if (!item) return;
  event.preventDefault();
  const profile = profiles.find((p) => p.id === item.dataset.id);
  if (profile) openProfileMenu(profile, event.target.closest('.more') ?? item);
});
profileMenu.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const profile = profiles.find((p) => p.id === profileMenu.dataset.id);
  if (!profile) return closeProfileMenu();
  closeProfileMenu();
  const action = button.dataset.action;
  if (action === 'edit') openEditor(profile);
  else if (action === 'favorite') await window.fleet.saveProfile({ id: profile.id, favorite: !profile.favorite });
  else if (action === 'open-url' && profile.url) {
    command('setProfile', state.selectedId, profile.id);
    command('navigate', state.selectedId, profile.url);
  } else if (action === 'duplicate') {
    await window.fleet.saveProfile({
      profile: `${profile.profile} copy`, site: profile.site, group: profile.group, name: profile.name,
      email: profile.email, phone: profile.phone, smsNumber: profile.smsNumber,
      address1: profile.address1, address2: profile.address2, city: profile.city, state: profile.state,
      zip: profile.zip, country: profile.country, url: profile.url, favorite: profile.favorite, notes: profile.notes,
    });
    showNotice(`Duplicated ${profile.profile}.`);
  } else if (action === 'delete' && confirm(`Delete profile "${profile.profile}"? Its logins and site data are deleted too.`)) {
    await window.fleet.deleteProfiles([profile.id]);
    showNotice(`Deleted ${profile.profile}.`);
  }
});

// Jancy-compatible shortcuts.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyP') {
    event.preventDefault();
    setPanelOpen(true);
    $('#profile-search').focus();
    $('#profile-search').select();
  }
  // Ctrl/Cmd + Shift + Enter — one-shot Fill & next (autofill the form, click the primary button).
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Enter') {
    event.preventDefault();
    $('#autofill-submit')?.click();
  }
});
$('#profile-preview').addEventListener('click', async (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  const profile = profiles.find((p) => p.id === (selectedPreviewId ?? selectedTab()?.profileId));
  if (!profile) return;
  if (action === 'use') command('setProfile', state.selectedId, profile.id);
  else if (action === 'edit') openEditor(profile);
  else if (action === 'favorite') await window.fleet.saveProfile({ id: profile.id, favorite: !profile.favorite });
  else if (action === 'clear-cookies' && confirm(`Clear "${profile.profile}"'s cookies? It will be logged out of every site in all its tabs.`)) {
    // Clear by first assigning the profile to this tab so main has a tab context, then clear.
    if (selectedTab()?.profileId !== profile.id) command('setProfile', state.selectedId, profile.id);
    command('clearProfileCookies', state.selectedId);
  }
});
$('#tab-current-profile').addEventListener('click', (event) => {
  if (event.target.id === 'strip-clear') command('setProfile', state.selectedId, null);
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
// ---------- Profile editor ----------

const editor = $('#profile-editor');
// What's being edited: saved cards are referenced by index (the window never has their numbers).
let editing = null; // { id, savedCards, keepCards: Set<number>, newCards: [] }

// Which section of the profile UI is in view: the list, the editor, or the Google Sheet form.
// Hides the siblings via CSS so the panel stays focused on one thing at a time.
function setProfileMode(mode) {
  $('#profile-section').dataset.mode = mode;
}

function openEditor(profile = null) {
  editor.reset();
  sheetForm.hidden = true;
  editing = { id: profile?.id ?? null, savedCards: profile?.cards ?? [], keepCards: new Set((profile?.cards ?? []).map((_, i) => i)), newCards: [] };
  $('#editor-title').textContent = profile ? `Edit ${profile.profile}` : 'New profile';
  for (const key of ['profile', 'group', 'site', 'name', 'email', 'phone', 'smsNumber', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'passwordUrl', 'otpUrl', 'url', 'dob', 'buyer', 'notes']) {
    editor.elements[key].value = profile?.[key] ?? '';
  }
  editor.elements.favorite.checked = Boolean(profile?.favorite);
  editor.elements.password.placeholder = profile?.hasPassword ? 'Saved — type to replace' : '';
  editor.elements.proxy.placeholder = profile?.hasProxy ? `Saved: ${profile.proxyLabel} — type to replace` : 'host:port:user:pass';
  editor.elements.passwordAuth.placeholder = profile?.hasPasswordAuth ? 'Saved — type to replace' : 'Bearer secret-token';
  editor.elements.otpAuth.placeholder = profile?.hasOtpAuth ? 'Saved — type to replace' : 'Bearer secret-token';
  editor.elements.textChestKey.placeholder = profile?.hasTextChestKey ? 'Saved — type to replace' : 'From api.textchest.com → API keys';
  editor.querySelector('[data-when-saved="password"]').hidden = !profile?.hasPassword;
  editor.querySelector('[data-when-saved="proxy"]').hidden = !profile?.hasProxy;
  editor.querySelector('[data-when-saved="passwordUrl"]').hidden = !profile?.hasPasswordUrl;
  editor.querySelector('[data-when-saved="passwordAuth"]').hidden = !profile?.hasPasswordAuth;
  editor.querySelector('[data-when-saved="otpUrl"]').hidden = !profile?.hasOtpUrl;
  editor.querySelector('[data-when-saved="otpAuth"]').hidden = !profile?.hasOtpAuth;
  editor.querySelector('[data-when-saved="textChestKey"]').hidden = !profile?.hasTextChestKey;
  editor.querySelector('.editor-sync').open = Boolean(profile?.hasPasswordUrl || profile?.hasOtpUrl || profile?.hasTextChestKey);
  $('#editor-delete').hidden = !profile;
  showEditorErrors([]);
  renderEditorCards();
  editor.hidden = false;
  setProfileMode('editor');
  editor.elements.profile.focus();
}

function closeEditor() {
  editor.reset();
  editing = null;
  editor.hidden = true;
  setProfileMode('list');
}

function showEditorErrors(errors) {
  $('#editor-errors').textContent = errors.join(' ');
  $('#editor-errors').hidden = errors.length === 0;
}

function renderEditorCards() {
  const describeCard = (card) => `•••• ${card.last4 ?? card.number.slice(-4)}${card.expMonth ? `  ${card.expMonth}/${String(card.expYear).slice(-2)}` : ''}`;
  $('#editor-cards').replaceChildren(
    ...editing.savedCards.map((card, index) => {
      const kept = editing.keepCards.has(index);
      const item = document.createElement('li');
      item.classList.toggle('removed', !kept);
      item.append(
        Object.assign(document.createElement('span'), { textContent: describeCard(card) }),
        Object.assign(document.createElement('button'), { type: 'button', textContent: kept ? 'Remove' : 'Undo', className: kept ? 'danger' : '' }),
      );
      item.lastChild.dataset.saved = index;
      return item;
    }),
    ...editing.newCards.map((card, index) => {
      const item = document.createElement('li');
      item.append(
        Object.assign(document.createElement('span'), { textContent: `${describeCard(card)}  (new)` }),
        Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove', className: 'danger' }),
      );
      item.lastChild.dataset.added = index;
      return item;
    }),
  );
}

/** Moves the card fields into the pending list; returns false if they're empty. */
function takeCardFields() {
  const f = editor.elements;
  if (!f.cardNumber.value.trim() && !f.cardCvv.value.trim()) return false;
  editing.newCards.push({
    number: f.cardNumber.value.replace(/\D/g, ''),
    name: f.cardName.value.trim(),
    expMonth: f.cardMonth.value.trim(),
    expYear: f.cardYear.value.trim(),
    cvv: f.cardCvv.value.trim(),
  });
  for (const key of ['cardNumber', 'cardName', 'cardMonth', 'cardYear', 'cardCvv']) f[key].value = '';
  return true;
}

$('#profile-new').addEventListener('click', () => openEditor(null));

// ---------- Google Sheets import ----------

const sheetForm = $('#sheet-import');
function openSheetForm() {
  editor.hidden = true;
  editing = null;
  sheetForm.hidden = false;
  setProfileMode('sheet');
  sheetForm.elements.url.focus();
}
function closeSheetForm() {
  sheetForm.hidden = true;
  sheetForm.reset();
  setProfileMode('list');
}
$('#profile-sheet').addEventListener('click', openSheetForm);
window.fleet.onOpenSheetImport(openSheetForm);
$('#sheet-import-cancel').addEventListener('click', closeSheetForm);

sheetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = sheetForm.elements.url.value.trim();
  if (!url) return showNotice('Paste a Google Sheets link first.');
  const result = await window.fleet.openGoogleSheet(url);
  showNotice(result.error ?? 'Sheet opened. Sign in to Google if the sheet is private, then click Import this sheet.');
});
$('#sheet-import-run').addEventListener('click', async () => {
  const url = sheetForm.elements.url.value.trim();
  if (!url) return showNotice('Paste a Google Sheets link first.');
  const result = await window.fleet.importFromSheet(url);
  if (result.error) {
    showNotice(result.error);
    if (result.needsSignIn && result.sheetUrl) await window.fleet.openGoogleSheet(result.sheetUrl);
    return;
  }
  showNotice(describeImport(result));
  closeSheetForm();
});
$('#editor-cancel').addEventListener('click', closeEditor);
$('#card-add').addEventListener('click', () => {
  if (takeCardFields()) renderEditorCards();
});
$('#editor-cards').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.saved !== undefined) {
    const index = Number(button.dataset.saved);
    if (editing.keepCards.has(index)) editing.keepCards.delete(index);
    else editing.keepCards.add(index);
  } else if (button.dataset.added !== undefined) {
    editing.newCards.splice(Number(button.dataset.added), 1);
  }
  renderEditorCards();
});
editor.addEventListener('submit', async (event) => {
  event.preventDefault();
  takeCardFields(); // a card typed but not "added" is still saved
  const f = editor.elements;
  const input = {
    id: editing.id,
    ...Object.fromEntries(['profile', 'group', 'site', 'name', 'email', 'phone', 'smsNumber', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'proxy', 'passwordUrl', 'otpUrl', 'url', 'dob', 'buyer', 'notes']
      .map((key) => [key, f[key].value])),
    favorite: f.favorite.checked,
    password: f.password.value,
    passwordAuth: f.passwordAuth.value,
    otpAuth: f.otpAuth.value,
    textChestKey: f.textChestKey.value,
    clearPassword: f.clearPassword.checked,
    clearProxy: f.clearProxy.checked,
    clearPasswordUrl: f.clearPasswordUrl.checked,
    clearPasswordAuth: f.clearPasswordAuth.checked,
    clearOtpUrl: f.clearOtpUrl.checked,
    clearOtpAuth: f.clearOtpAuth.checked,
    clearTextChestKey: f.clearTextChestKey.checked,
    keepCards: [...editing.keepCards],
    newCards: editing.newCards,
  };
  const result = await window.fleet.saveProfile(input);
  if (result.errors.length > 0) {
    showEditorErrors(result.errors);
    renderEditorCards();
    return;
  }
  const created = !editing.id;
  closeEditor();
  showNotice(created ? 'Profile created. Click Use to put it on this tab.' : 'Profile saved.');
});
$('#editor-delete').addEventListener('click', async () => {
  const profile = profiles.find((p) => p.id === editing?.id);
  if (!profile || !confirm(`Delete profile "${profile.profile}"? Its saved logins and site data are deleted too.`)) return;
  await window.fleet.deleteProfiles([profile.id]);
  closeEditor();
  showNotice(`Deleted ${profile.profile}.`);
});

$('#autofill').addEventListener('click', async () => {
  const result = await window.fleet.invoke('autofill', state.selectedId, Number($('#autofill-card').value) || 0);
  if (result) showNotice(result.error ?? `Filled ${result.filled} field(s). Review the form before submitting.`);
});
$('#autofill-submit').addEventListener('click', async () => {
  const result = await window.fleet.invoke('autofillSubmit', state.selectedId, Number($('#autofill-card').value) || 0);
  if (!result) return;
  if (result.error) showNotice(result.error);
  else if (result.expanded) showNotice(result.note ?? `Clicked "${result.expanded}".`);
  else showNotice(`Filled ${result.filled} field(s), clicked "${result.submitted}". Watch the page.`);
});
$('#fetch-otp').addEventListener('click', async () => {
  const result = await window.fleet.invoke('fetchOTP', state.selectedId);
  if (!result) return;
  if (result.error) showNotice(result.error);
  else showNotice(`OTP ${result.code} copied to clipboard.`);
});
$('#test-sync').addEventListener('click', async () => {
  const result = await window.fleet.invoke('diagnoseSync', state.selectedId);
  if (!result) return;
  if (result.error) return showNotice(result.error);
  // Multi-line result goes into the notice as monospace-ish readable text.
  const notice = $('#notice');
  notice.textContent = result.report;
  notice.hidden = false;
  notice.style.whiteSpace = 'pre-wrap';
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; notice.style.whiteSpace = ''; }, 20000);
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
    left: panel.hidden ? 0 : PANEL_WIDTH,
    right: 0,
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
