'use strict';

const { randomUUID } = require('node:crypto');
const { parseProxy, proxyLabel } = require('./proxy');
const { parseResolverCell, sanitizeResolvers, resolversFromText } = require('./resolvers');

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
  otpUrl: ['otpurl', 'otpapi', 'otplink', 'otpsync', 'otpendpoint'],
  otpAuth: ['otpauth', 'otpauthorization', 'otptoken', 'otpheader', 'otpapikey'],
  textChestKey: ['textchest', 'textchestkey', 'textchesttoken', 'textchestapikey', 'textchestapi'],
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
  // Jancy-compatible optional columns.
  favorite: ['favorite', 'favorites', 'star'],
  notes: ['notes', 'note'],
  url: ['url', 'homepage', 'targeturl'],
  dob: ['dob', 'dateofbirth', 'birthday', 'birthdate'],
  timeZone: ['timezone', 'tz'],
  buyer: ['buyer', 'buyers'],
  tabColor: ['tabcolor', 'color'],
  passcode: ['passcode', 'passcode1'],
  persistCookies: ['persistcookies'],
  persistSessions: ['persistsessions'],
};
const CARD_COLUMNS = {
  number: ['cardnumber', 'ccnumber', 'creditcardnumber'],
  name: ['cardname', 'nameoncard', 'cardholder', 'cardholdername'],
  expMonth: ['expmonth', 'expirationmonth', 'cardexpmonth'],
  expYear: ['expyear', 'expirationyear', 'cardexpyear'],
  cvv: ['cvv', 'cvc', 'securitycode', 'cardcvv'],
};

// Jancy's CC columns use "<field>:<set>" so one profile can carry several named cards.
// Headers are matched against the raw (pre-normalise) text so the ": <set>" survives.
const JANCY_CARD_FIELDS = {
  number: /^cc\s*number$/i,
  cvv: /^cc\s*cvv$/i,
  expDate: /^cc\s*exp\s*date$/i,
  name: /^cc\s*name$/i,
  address1: /^cc\s*address$/i,
  address2: /^cc\s*address\s*2$/i,
  city: /^cc\s*city$/i,
  state: /^cc\s*state$/i,
  zip: /^cc\s*zip$/i,
  note: /^cc\s*note$/i,
};

function parseExpDate(text) {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{2,4})\s*$/.exec(String(text ?? ''));
  if (!match) return { expMonth: '', expYear: '' };
  const expMonth = match[1].padStart(2, '0');
  const expYear = match[2].length === 2 ? `20${match[2]}` : match[2];
  return { expMonth, expYear };
}

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

  // Jancy-style CC columns: "CC Number:<set>", "CC CVV:<set>", "CC Exp Date:<set>", etc. Each
  // unique <set> becomes a card. Headers are matched case-insensitively on the raw text so the
  // "<field>:<set>" structure survives (normaliser strips the colon).
  const jancyCardSets = new Map(); // setName -> { field -> index }
  for (let i = 0; i < rawHeaders.length; i++) {
    const colon = rawHeaders[i].indexOf(':');
    if (colon === -1) continue;
    const left = rawHeaders[i].slice(0, colon).trim();
    const setName = rawHeaders[i].slice(colon + 1).trim();
    if (!setName) continue;
    for (const [field, re] of Object.entries(JANCY_CARD_FIELDS)) {
      if (!re.test(left)) continue;
      if (!jancyCardSets.has(setName)) jancyCardSets.set(setName, {});
      jancyCardSets.get(setName)[field] = i;
      break;
    }
  }

  // Jancy-style repeating columns: Proxy / Proxy 2 / Proxy 3, Passcode / Passcode 2 / Passcode 3.
  const extraProxyIndexes = []; // additional proxy columns beyond the primary one
  const passcodeIndexes = [];
  if (columns.passcode !== -1) passcodeIndexes.push(columns.passcode);
  for (let n = 2; n <= 10; n++) {
    const p = findColumn(COLUMNS.proxy, String(n));
    if (p !== -1) extraProxyIndexes.push(p);
    const pc = findColumn(['passcode'], String(n));
    if (pc !== -1) passcodeIndexes.push(pc);
  }

  // Build a map of recognised columns + a list of ignored ones so the import report can show
  // "Recognised: Profile, Name, Email, TextChest … Ignored: My Mystery Column".
  const recognised = {};
  for (const [field, index] of Object.entries(columns)) {
    if (index !== -1) recognised[rawHeaders[index]] = field;
  }
  for (const sc of siteColumns) recognised[rawHeaders[sc.index]] = `Site:${sc.site}`;
  for (const [setName, byField] of jancyCardSets) {
    for (const [field, index] of Object.entries(byField)) recognised[rawHeaders[index]] = `card[${setName}].${field}`;
  }
  for (const i of extraProxyIndexes) recognised[rawHeaders[i]] = 'proxy (additional)';
  for (const i of passcodeIndexes.slice(1)) recognised[rawHeaders[i]] = 'passcode (additional)';
  // Repeated card columns in our older format (Card Number 2, …) also count.
  for (let n = 2; n <= 10; n++) {
    for (const [field, aliases] of Object.entries(CARD_COLUMNS)) {
      const i = findColumn(aliases, String(n));
      if (i !== -1) recognised[rawHeaders[i]] = `card${n}.${field}`;
    }
  }
  const ignored = rawHeaders.filter((h) => h && !(h in recognised));

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
    // Our existing "Card Number", "Card Number 2" format.
    for (const set of cardSets) {
      if (!get(set.number)) continue;
      const { card, error } = normalizeCard({
        number: get(set.number), name: get(set.name), expMonth: get(set.expMonth), expYear: get(set.expYear), cvv: get(set.cvv),
      }, get(columns.name));
      if (error) errors.push(`Line ${line}: ${error} The card was skipped.`);
      else cards.push(card);
    }
    // Jancy's "CC Number:<set>" format: build one card per named set.
    for (const [setName, byField] of jancyCardSets) {
      const number = byField.number !== undefined ? String(row[byField.number] ?? '').trim() : '';
      if (!number) continue;
      const { expMonth, expYear } = parseExpDate(byField.expDate !== undefined ? row[byField.expDate] : '');
      const cvv = byField.cvv !== undefined ? String(row[byField.cvv] ?? '').trim() : '';
      const name = byField.name !== undefined ? String(row[byField.name] ?? '').trim() : '';
      const { card, error } = normalizeCard({ number, cvv, expMonth, expYear, name }, get(columns.name));
      if (error) errors.push(`Line ${line}: ${error} The card "${setName}" was skipped.`);
      else cards.push(card);
    }

    // Jancy's repeating Proxy / Passcode columns.
    const extraProxyTexts = extraProxyIndexes.map((i) => String(row[i] ?? '').trim()).filter(Boolean);
    const passcodes = passcodeIndexes.map((i) => String(row[i] ?? '').trim()).filter(Boolean);

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
      textChestKey: get(columns.textChestKey),
      resolvers,
      extraProxies: extraProxyTexts,
      passcodes,
      favorite: /^(1|true|yes|y)$/i.test(get(columns.favorite)),
      notes: String(row[columns.notes] ?? '').replace(/\\n/g, '\n').trim(),
      url: get(columns.url),
      dob: get(columns.dob),
      timeZone: get(columns.timeZone),
      buyer: get(columns.buyer),
      tabColor: get(columns.tabColor),
      passcode: get(columns.passcode),
      persistCookies: /^(1|true|yes|y)$/i.test(get(columns.persistCookies)),
      persistSessions: /^(1|true|yes|y)$/i.test(get(columns.persistSessions)),
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
  return { profiles, errors, recognised, ignored };
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
  const textChestKey = keepSecret('textChestKey');

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
    textChestKey,
    // Resolvers come from CSV/Sheet import by default; the editor can override via resolversText.
    resolvers: typeof input.resolversText === 'string'
      ? resolversFromText(input.resolversText, existing?.resolvers)
      : (existing?.resolvers ?? []),
    extraProxies: existing?.extraProxies ?? [],
    passcodes: existing?.passcodes ?? [],
    favorite: input.favorite !== undefined ? Boolean(input.favorite) : Boolean(existing?.favorite),
    notes: typeof input.notes === 'string' ? input.notes : (existing?.notes ?? ''),
    url: text(input.url) || (existing?.url ?? ''),
    dob: text(input.dob) || (existing?.dob ?? ''),
    timeZone: text(input.timeZone) || (existing?.timeZone ?? ''),
    buyer: text(input.buyer) || (existing?.buyer ?? ''),
    tabColor: text(input.tabColor) || (existing?.tabColor ?? ''),
    passcode: text(input.passcode) || (existing?.passcode ?? ''),
    persistCookies: input.persistCookies !== undefined ? Boolean(input.persistCookies) : Boolean(existing?.persistCookies),
    persistSessions: input.persistSessions !== undefined ? Boolean(input.persistSessions) : Boolean(existing?.persistSessions),
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
  const { cards, proxy, password, passwordAuth, otpAuth, textChestKey, resolvers, ...rest } = profile;
  const host = (url) => { try { return new URL(url).host; } catch { return url || ''; } };
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasProxy: Boolean(proxy),
    hasPasswordUrl: Boolean(profile.passwordUrl),
    hasOtpUrl: Boolean(profile.otpUrl),
    hasPasswordAuth: Boolean(passwordAuth),
    hasOtpAuth: Boolean(otpAuth),
    hasTextChestKey: Boolean(textChestKey),
    passwordUrlHost: host(profile.passwordUrl),
    otpUrlHost: host(profile.otpUrl),
    proxyLabel: proxyLabel(proxy),
    resolvers: sanitizeResolvers(resolvers),
    cards: cards.map((card) => ({ last4: card.number.slice(-4), expMonth: card.expMonth, expYear: card.expYear, name: card.name })),
  };
}

/**
 * Searches profiles by free text (profile/name/email/group/site/buyer/notes) with Jancy-style filter
 * operators: group:X, site:X, has:password, has:proxy, has:resolver, favorite (or fav).
 */
function searchProfiles(profiles, query) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return profiles;
  const terms = [];
  const requires = [];
  for (const token of tokens) {
    const [key, value] = token.includes(':') ? [token.slice(0, token.indexOf(':')), token.slice(token.indexOf(':') + 1)] : [null, token];
    if (!key) {
      if (token === 'favorite' || token === 'fav' || token === 'starred') {
        requires.push((p) => p.favorite);
      } else {
        terms.push(token);
      }
      continue;
    }
    if (key === 'group') requires.push((p) => (p.group ?? '').toLowerCase().includes(value));
    else if (key === 'site') requires.push((p) => (p.site ?? '').toLowerCase().includes(value)
      || (p.resolvers ?? []).some((c) => c.site.toLowerCase().includes(value)));
    else if (key === 'has') {
      if (value === 'password') requires.push((p) => p.hasPassword || Boolean(p.password));
      else if (value === 'proxy') requires.push((p) => p.hasProxy || Boolean(p.proxy));
      else if (value === 'resolver') requires.push((p) => (p.resolvers ?? []).length > 0);
      else if (value === 'card') requires.push((p) => (p.cards ?? []).length > 0);
    } else {
      terms.push(token); // Unknown operator: fall back to plain term.
    }
  }
  return profiles.filter((p) => {
    const haystack = `${p.profile} ${p.name} ${p.email} ${p.group ?? ''} ${p.site ?? ''} ${p.buyer ?? ''} ${p.notes ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term)) && requires.every((check) => check(p));
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
    ['ccNumber', ['cc-number'], /card.?num|card.?no\b|cc.?num|cc.?no\b|cardnumber|credit.?card|debit.?card|\bpan\b|primary.?account/],
    ['ccCsc', ['cc-csc'], /\bcvv\d?\b|\bcvc\d?\b|\bcsc\b|security.?code|card.?security|card.?code|verification.?(value|code|number)/],
    ['ccExpMonth', ['cc-exp-month'], /exp\w*.?(month|mm\b)|cc.?month|\bmm\b/],
    ['ccExpYear', ['cc-exp-year'], /exp\w*.?(year|yy)|cc.?year|\byy(yy)?\b/],
    ['ccExp', ['cc-exp'], /exp(iry|iration)?.?(date)?|mm.?\/?.?yy/],
    ['ccName', ['cc-name'], /card.?holder|name.?on.?card|cc.?name|card.?name|holder.?name/],
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

  const result = { filled: 0, matched: 0, visible: fields.length, skipped: 0, iframes: document.querySelectorAll('iframe').length };

  // Pre-pass: card number split across short-maxlength inputs (common in older checkouts). Fill one
  // slice per input so the main loop then skips them (they're no longer empty).
  const ccDigits = String(values.ccNumber || '').replace(/\D/g, '');
  if (ccDigits.length >= 12) {
    const run = [];
    for (const el of fields) {
      if (el instanceof HTMLSelectElement) continue;
      const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).pop();
      const text = describe(el);
      const isCcNum = autocomplete === 'cc-number'
        || /card.?num|card.?no\b|cc.?num|cc.?no\b|cardnumber|credit.?card|debit.?card|\bpan\b/.test(text);
      const maxLen = Number(el.getAttribute('maxlength')) || 0;
      if (isCcNum && maxLen >= 3 && maxLen <= 6) run.push({ el, maxLen });
    }
    if (run.length >= 3) {
      let offset = 0;
      for (const { el, maxLen } of run) {
        if (el.value) { offset += el.value.length; continue; }
        const chunk = ccDigits.slice(offset, offset + maxLen);
        if (chunk && setValue(el, chunk)) { offset += chunk.length; result.filled++; result.matched++; }
      }
    }
  }
  for (const el of fields) {
    if (el.value && !(el instanceof HTMLSelectElement)) { result.skipped++; continue; }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).pop();
    const text = describe(el);
    let key;
    if (el.type === 'password') {
      if (autocomplete === 'one-time-code' || /\botp\b|one.?time|verif(y|ication).?code|sms.?code|\bauth.?code\b|two.?factor|2fa/.test(text)) {
        key = 'otp'; // some sites mask the one-time code as a password field
      } else if (autocomplete === 'cc-csc' || /\bcvv\d?\b|\bcvc\d?\b|\bcsc\b|security.?code|card.?security|card.?code/.test(text)) {
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

/** Script to run in-page: finds the best primary-action button and clicks it. */
function pageSubmit() {
  const EXPAND = /^\s*(\+\s*)?(add(\s+(new|another))?\s+(address|card|payment|contact)|new\s+(address|card))\s*$/i;
  const PRIMARY = /^(continue|next|save|submit|confirm|proceed|place\s+order|checkout|book|buy|pay|update|add|done)$/i;
  const LOGIN = /^(log\s*in|sign\s*in|signin|login)$/i;

  const visible = (el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (el) => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
  const allClickable = () => [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]')].filter(visible);

  // Any editable inputs visible? If not, try to expand an "Add new address" style section.
  const fields = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type) && visible(el);
  });
  if (fields.length === 0) {
    const expand = allClickable().find((el) => EXPAND.test(textOf(el)));
    if (expand) { expand.click(); return { expanded: textOf(expand) }; }
    return { expanded: null, submitted: null, reason: 'No form and no "Add new…" trigger found.' };
  }

  const score = (el) => {
    const text = textOf(el).toLowerCase();
    let s = 0;
    if (el.type === 'submit') s += 15;
    if (LOGIN.test(text)) s += 25;
    if (PRIMARY.test(text)) s += 20;
    if (/primary|cta|btn[-_ ]?primary|submit/i.test(el.className || '')) s += 5;
    if (/cancel|back|reset|close|skip/i.test(text)) s -= 50;
    // Nearest form's own submit beats a page-level one.
    if (el.form && el.form === fields[0]?.form) s += 8;
    return s;
  };
  const best = allClickable().filter((el) => score(el) > 0).sort((a, b) => score(b) - score(a))[0];
  if (!best) return { expanded: null, submitted: null, reason: `No primary action button among ${allClickable().length} visible buttons.` };
  best.click();
  return { expanded: null, submitted: textOf(best).slice(0, 40) };
}

/** Returns an IIFE script string that executes `pageSubmit` in the page. */
function buildSubmitScript() { return `(${pageSubmit.toString()})()`; }

module.exports = {
  parseCSV, parseProfilesCSV, buildProfile, normalizeCard, publicProfile, searchProfiles, planAssignments,
  buildAutofillScript, buildSubmitScript, normalizePhone,
};
