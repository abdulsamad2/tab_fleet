'use strict';

const { randomUUID } = require('node:crypto');
const { parseProxy, proxyLabel } = require('./proxy');
const { parseResolverCell, sanitizeResolvers } = require('./resolvers');

/** RFC 4180 CSV: quoted fields, escaped quotes, CRLF or LF; also accepts tab- or semicolon-delimited files. */
function parseCSV(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = [',', '\t', ';'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

const normalizeHeader = (header) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

// Header aliases, matched after lower-casing and stripping spaces/punctuation.
const COLUMNS = {
  profile: ['profile', 'profilename', 'moniker'],
  name: ['name', 'fullname'],
  email: ['email', 'emailaddress'],
  password: ['password', 'loginpassword', 'accountpassword'],
  passwordUrl: ['passwordurl', 'passwordsync', 'passwordapi', 'passwordlink', 'passwordsyncurl'],
  passwordAuth: ['passwordauth', 'passwordauthorization', 'passwordtoken', 'passwordheader', 'passwordapikey'],
  otpUrl: ['otpurl', 'otpapi', 'otplink', 'otpsync', 'textchest', 'textchesturl'],
  otpAuth: ['otpauth', 'otpauthorization', 'otptoken', 'otpheader', 'otpapikey', 'textchestkey', 'textchesttoken', 'textchestapikey'],
  site: ['site', 'targetsite', 'website', 'domain', 'store'],
  group: ['group', 'profilegroup'],
  address1: ['address', 'address1', 'addressline1', 'street'],
  address2: ['address2', 'addressline2', 'apt', 'suite'],
  city: ['city'],
  state: ['state', 'province'],
  zip: ['zipcode', 'zip', 'postalcode', 'postcode'],
  country: ['country'],
  phone: ['phonenumber', 'phone', 'mobile'],
  smsNumber: ['smsnumber', 'sms', 'textchestnumber', 'number'],
  proxy: ['proxy'],
};
const CARD_COLUMNS = {
  number: ['cardnumber', 'ccnumber', 'creditcardnumber'],
  name: ['cardname', 'nameoncard', 'cardholder', 'cardholdername'],
  expMonth: ['expmonth', 'expirationmonth', 'cardexpmonth'],
  expYear: ['expyear', 'expirationyear', 'cardexpyear'],
  cvv: ['cvv', 'cvc', 'securitycode', 'cardcvv'],
};

/** Phone numbers are kept as 10 digits; a leading US country code is dropped. */
function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function normalizeMonth(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(2, '0').slice(-2) : '';
}

function normalizeYear(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 2 ? `20${digits}` : digits;
}

/** Validates one card; returns `{ card }` or `{ error }`. Expiry is optional, but must be real when given. */
function normalizeCard(raw, fallbackName = '') {
  const number = String(raw.number ?? '').replace(/\D/g, '');
  const cvv = String(raw.cvv ?? '').replace(/\D/g, '');
  if (number.length < 12 || number.length > 19) return { error: 'Card number must be 12–19 digits.' };
  if (cvv.length < 3 || cvv.length > 4) return { error: 'CVV must be 3 or 4 digits.' };
  const expMonth = normalizeMonth(raw.expMonth);
  const expYear = normalizeYear(raw.expYear);
  if (expMonth && (Number(expMonth) < 1 || Number(expMonth) > 12)) return { error: 'Expiry month must be 01–12.' };
  if (expYear && expYear.length !== 4) return { error: 'Expiry year must be YY or YYYY.' };
  return { card: { number, name: String(raw.name ?? '').trim() || fallbackName, expMonth, expYear, cvv } };
}

/**
 * Parses a profiles CSV (Jancy-compatible columns: Profile, Name, Email required; password, address,
 * phone, proxy and any number of cards as "Card Number", "Card Number 2", … optional).
 */
function parseProfilesCSV(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { profiles: [], errors: ['The file is empty.'] };

  const rawHeaders = rows[0].map((h) => String(h ?? '').trim());
  const headers = rawHeaders.map(normalizeHeader);
  const findColumn = (aliases, suffix = '') => headers.findIndex((h) => aliases.some((alias) => h === `${alias}${suffix}`));
  const columns = Object.fromEntries(Object.entries(COLUMNS).map(([key, aliases]) => [key, findColumn(aliases)]));
  // Jancy "Site:<pattern>" resolver columns are detected by their raw (pre-normalised) header.
  const siteColumns = rawHeaders
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /^site\s*:/i.test(header))
    .map(({ header, index }) => ({ site: header.replace(/^site\s*:\s*/i, '').trim(), index }));

  const missing = ['profile', 'name', 'email'].filter((key) => columns[key] === -1);
  if (missing.length > 0) {
    return { profiles: [], errors: [`Missing required column(s): ${missing.map((k) => k[0].toUpperCase() + k.slice(1)).join(', ')}.`] };
  }

  // Card columns may repeat with a numeric suffix: "Card Number", "Card Number 2", ...
  const cardSets = [];
  for (let n = 1; n <= 10; n++) {
    const suffix = n === 1 ? '' : String(n);
    const set = Object.fromEntries(Object.entries(CARD_COLUMNS).map(([key, aliases]) => [
      key,
      findColumn(aliases, suffix) !== -1 || n !== 1 ? findColumn(aliases, suffix) : findColumn(aliases, '1'),
    ]));
    if (set.number !== -1) cardSets.push(set);
  }

  const profiles = [];
  const errors = [];
  const seen = new Set();
  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const get = (column) => (column === -1 ? '' : String(row[column] ?? '').trim());
    const profileName = get(columns.profile);
    if (!profileName || !get(columns.name) || !get(columns.email)) {
      errors.push(`Line ${line}: Profile, Name and Email are required.`);
      return;
    }
    if (seen.has(profileName.toLowerCase())) {
      errors.push(`Line ${line}: duplicate profile "${profileName}" skipped.`);
      return;
    }
    seen.add(profileName.toLowerCase());

    const proxyText = get(columns.proxy);
    const proxy = proxyText ? parseProxy(proxyText) : null;
    if (proxyText && !proxy) errors.push(`Line ${line}: proxy "${proxyText}" is not valid and was ignored.`);

    const cards = [];
    for (const set of cardSets) {
      if (!get(set.number)) continue;
      const { card, error } = normalizeCard({
        number: get(set.number), name: get(set.name), expMonth: get(set.expMonth), expYear: get(set.expYear), cvv: get(set.cvv),
      }, get(columns.name));
      if (error) errors.push(`Line ${line}: ${error} The card was skipped.`);
      else cards.push(card);
    }

    const resolvers = [];
    for (const sc of siteColumns) {
      const cell = String(row[sc.index] ?? '').trim();
      if (!cell) continue;
      const { entries, errors: rErrors } = parseResolverCell(cell);
      for (const err of rErrors) errors.push(`Line ${line}: ${err}`);
      if (entries.length > 0) resolvers.push({ site: sc.site, entries });
    }

    profiles.push({
      id: randomUUID(),
      profile: profileName,
      name: get(columns.name),
      email: get(columns.email),
      password: get(columns.password),
      passwordUrl: get(columns.passwordUrl),
      passwordAuth: get(columns.passwordAuth),
      otpUrl: get(columns.otpUrl),
      otpAuth: get(columns.otpAuth),
      site: get(columns.site),
      smsNumber: get(columns.smsNumber),
      resolvers,
      group: get(columns.group),
      address1: get(columns.address1),
      address2: get(columns.address2),
      city: get(columns.city),
      state: get(columns.state).toUpperCase(),
      zip: get(columns.zip),
      country: get(columns.country),
      phone: normalizePhone(get(columns.phone)),
      proxy,
      cards,
    });
  });
  return { profiles, errors };
}

/**
 * Creates or updates a profile from the editor. Secrets the window never sees are kept unless replaced:
 * an empty `password` keeps the saved one (`clearPassword` removes it), an empty `proxy` keeps the saved
 * proxy (`clearProxy` removes it), and `keepCards` lists the indexes of saved cards to keep.
 */
function buildProfile(input, existing = null) {
  const text = (value) => String(value ?? '').trim();
  const errors = [];
  const profileName = text(input.profile);
  const name = text(input.name);
  const email = text(input.email);
  if (!profileName) errors.push('Profile name is required.');
  if (!name) errors.push('Full name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address.');

  let proxy = existing?.proxy ?? null;
  if (input.clearProxy) proxy = null;
  if (text(input.proxy)) {
    proxy = parseProxy(text(input.proxy));
    if (!proxy) errors.push('Proxy must look like host:port or host:port:user:pass.');
  }

  const keep = new Set(input.keepCards ?? []);
  const cards = (existing?.cards ?? []).filter((_, index) => keep.has(index));
  for (const raw of input.newCards ?? []) {
    const { card, error } = normalizeCard(raw, name);
    if (error) errors.push(`Card ending ${String(raw.number ?? '').replace(/\D/g, '').slice(-4) || '????'}: ${error}`);
    else cards.push(card);
  }

  let password = existing?.password ?? '';
  if (input.clearPassword) password = '';
  if (typeof input.password === 'string' && input.password !== '') password = input.password;

  // Sync URLs and their auth headers follow the same keep-unless-replaced rule as password/proxy.
  const keepSecret = (name) => {
    let value = existing?.[name] ?? '';
    if (input[`clear${name[0].toUpperCase()}${name.slice(1)}`]) value = '';
    if (typeof input[name] === 'string' && input[name] !== '') value = input[name];
    return value;
  };
  const passwordUrl = keepSecret('passwordUrl');
  const passwordAuth = keepSecret('passwordAuth');
  const otpUrl = keepSecret('otpUrl');
  const otpAuth = keepSecret('otpAuth');

  const profile = {
    id: existing?.id ?? randomUUID(),
    profile: profileName,
    name,
    email,
    password,
    passwordUrl,
    passwordAuth,
    otpUrl,
    otpAuth,
    site: text(input.site),
    smsNumber: text(input.smsNumber) || (existing?.smsNumber ?? ''),
    resolvers: existing?.resolvers ?? [], // Resolver columns only come from CSV/Sheet import.
    group: text(input.group),
    address1: text(input.address1),
    address2: text(input.address2),
    city: text(input.city),
    state: text(input.state).toUpperCase(),
    zip: text(input.zip),
    country: text(input.country),
    phone: normalizePhone(input.phone),
    proxy,
    cards,
  };
  return { profile, errors };
}

/** What the window UI gets: everything except passwords, full card numbers, CVVs, proxy and sync credentials. */
function publicProfile(profile) {
  const { cards, proxy, password, passwordAuth, otpAuth, resolvers, ...rest } = profile;
  const host = (url) => { try { return new URL(url).host; } catch { return url || ''; } };
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasProxy: Boolean(proxy),
    hasPasswordUrl: Boolean(profile.passwordUrl),
    hasOtpUrl: Boolean(profile.otpUrl),
    hasPasswordAuth: Boolean(passwordAuth),
    hasOtpAuth: Boolean(otpAuth),
    passwordUrlHost: host(profile.passwordUrl),
    otpUrlHost: host(profile.otpUrl),
    proxyLabel: proxyLabel(proxy),
    resolvers: sanitizeResolvers(resolvers),
    cards: cards.map((card) => ({ last4: card.number.slice(-4), expMonth: card.expMonth, expYear: card.expYear, name: card.name })),
  };
}

function searchProfiles(profiles, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return profiles;
  return profiles.filter((p) => {
    const haystack = `${p.profile} ${p.name} ${p.email} ${p.group}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Spreads profiles over tabs in order; with `repeat`, cycles them until every tab has one. */
function planAssignments(tabIds, profileIds, repeat) {
  if (profileIds.length === 0) return [];
  const count = repeat ? tabIds.length : Math.min(tabIds.length, profileIds.length);
  return tabIds.slice(0, count).map((tabId, i) => [tabId, profileIds[i % profileIds.length]]);
}

/**
 * Builds the page script that fills the visible form from a profile. It matches fields by their
 * `autocomplete` token first, then by name/id/placeholder/label text, and fires input/change events
 * so framework-driven forms (React, Vue, Angular) register the values. Returns the number of fields filled.
 */
function buildAutofillScript(profile, card, extras = {}) {
  const [first, ...rest] = profile.name.split(/\s+/);
  const values = {
    email: profile.email,
    password: extras.password ?? profile.password ?? '',
    otp: extras.otp ?? '',
    givenName: first ?? '',
    familyName: rest.join(' '),
    fullName: profile.name,
    tel: profile.phone,
    address1: profile.address1,
    address2: profile.address2,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    country: profile.country,
    ccName: card?.name ?? '',
    ccNumber: card?.number ?? '',
    ccExp: card ? `${card.expMonth}/${card.expYear.slice(-2)}` : '',
    ccExpMonth: card?.expMonth ?? '',
    ccExpYear: card?.expYear ?? '',
    ccCsc: card?.cvv ?? '',
  };
  return `(${pageAutofill.toString()})(${JSON.stringify(values)})`;
}

/* Runs inside the page; must be self-contained. */
function pageAutofill(values) {
  const RULES = [
    ['otp', ['one-time-code'], /\botp\b|one.?time.?(code|password|pin)|\bverif(y|ication).?code\b|sms.?code|\bauth.?code\b|two.?factor|2fa|\bmfa\b|\btoken\b|confirmation.?code/],
    ['ccNumber', ['cc-number'], /card.?num|cc.?num|cardnumber|credit.?card|debit.?card/],
    ['ccCsc', ['cc-csc'], /cvv|cvc|csc|card.?security|card.?code|^security.?code$/],
    ['ccExpMonth', ['cc-exp-month'], /exp\w*.?(month|mm\b)|cc.?month|\bmm\b/],
    ['ccExpYear', ['cc-exp-year'], /exp\w*.?(year|yy)|cc.?year|\byy(yy)?\b/],
    ['ccExp', ['cc-exp'], /exp(iry|iration)?.?(date)?|mm.?\/?.?yy/],
    ['ccName', ['cc-name'], /card.?holder|name.?on.?card|cc.?name|card.?name/],
    ['email', ['email', 'username'], /e-?mail|user.?name|\blog.?in(.?id)?\b|\baccount\b/],
    ['givenName', ['given-name'], /first.?name|fname|given|forename/],
    ['familyName', ['family-name'], /last.?name|lname|surname|family/],
    ['tel', ['tel', 'tel-national'], /phone|tel\b|mobile|cell/],
    ['address2', ['address-line2'], /address.?(line)?.?2|apt|suite|unit\b|floor/],
    ['address1', ['address-line1', 'street-address'], /address|street/],
    ['city', ['address-level2'], /city|town|locality|suburb/],
    ['state', ['address-level1'], /\bstate\b|province|region\b|county/],
    ['zip', ['postal-code'], /zip|postal|postcode/],
    ['country', ['country', 'country-name'], /country|\bnation\b/],
    ['fullName', ['name'], /full.?name|^name$|your.?name|^name[-_ ]?input$/],
  ];

  /** Reads every input, select and textarea in the document AND any open shadow roots. */
  const collectFields = (root) => {
    const out = [];
    const walk = (node) => {
      out.push(...node.querySelectorAll('input, select, textarea'));
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root);
    return out;
  };

  const describe = (el) => {
    const forLabel = el.id && (el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '');
    const wrapLabel = el.closest('label')?.textContent ?? '';
    const nearLabel = el.previousElementSibling?.tagName === 'LABEL' ? el.previousElementSibling.textContent : '';
    const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('title'),
      el.getAttribute('data-testid'), el.getAttribute('data-qa'), el.getAttribute('autocomplete'),
      forLabel, wrapLabel, nearLabel];
    return parts.filter(Boolean).join(' ').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  };

  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  /** Sets a value in a way React/Vue controlled inputs accept, then fires the events a form expects. */
  const setValue = (el, value) => {
    if (el instanceof HTMLSelectElement) {
      const wanted = String(value).toLowerCase().trim();
      const option = [...el.options].find((o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted)
        || [...el.options].find((o) => /^\d+$/.test(wanted) && Number(o.value) === Number(wanted))
        || [...el.options].find((o) => wanted.length === 4 && o.text.trim() === wanted.slice(-2));
      if (!option) return false;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    try { el.focus(); } catch {}
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  };

  const fields = collectFields(document).filter((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type) && visible(el);
  });
  const hasSplitName = fields.some((el) => /given-name|family-name/.test(el.autocomplete) || /first.?name|last.?name/.test(describe(el)));

  const result = { filled: 0, matched: 0, visible: fields.length, skipped: 0 };
  for (const el of fields) {
    if (el.value && !(el instanceof HTMLSelectElement)) { result.skipped++; continue; }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).pop();
    const text = describe(el);
    let key;
    if (el.type === 'password') {
      if (autocomplete === 'one-time-code' || /\botp\b|one.?time|verif(y|ication).?code|sms.?code|\bauth.?code\b|two.?factor|2fa/.test(text)) {
        key = 'otp'; // some sites mask the one-time code as a password field
      } else if (autocomplete === 'cc-csc' || /cvv|cvc|csc|card.?security|card.?code|^security.?code$/.test(text)) {
        key = 'ccCsc'; // some checkouts mask the CVV as a password field
      } else if (autocomplete === 'new-password' || /\bnew\b|confirm|repeat|retype/.test(text)) {
        continue; // login forms only: never fill a sign-up or change-password field
      } else {
        key = 'password';
      }
    } else {
      const rule = RULES.find(([, tokens]) => tokens.includes(autocomplete))
        || RULES.find(([, , pattern]) => pattern.test(text));
      if (!rule) continue;
      [key] = rule;
    }
    if (key === 'fullName' && hasSplitName) continue;
    if (key === 'email' && autocomplete === 'username' && !/@/.test(values.email)) continue;
    result.matched++;
    const value = values[key];
    if (value && setValue(el, value)) result.filled++;
  }
  return result;
}

module.exports = {
  parseCSV, parseProfilesCSV, buildProfile, normalizeCard, publicProfile, searchProfiles, planAssignments, buildAutofillScript, normalizePhone,
};
