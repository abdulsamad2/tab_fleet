'use strict';

const { randomUUID } = require('node:crypto');
const { parseProxy } = require('./proxy');

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
  group: ['group', 'profilegroup'],
  address1: ['address', 'address1', 'addressline1', 'street'],
  address2: ['address2', 'addressline2', 'apt', 'suite'],
  city: ['city'],
  state: ['state', 'province'],
  zip: ['zipcode', 'zip', 'postalcode', 'postcode'],
  country: ['country'],
  phone: ['phonenumber', 'phone', 'mobile'],
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

/**
 * Parses a profiles CSV (Jancy-compatible columns: Profile, Name, Email required; address, phone, proxy
 * and any number of cards as "Card Number", "Card Number 2", … optional).
 */
function parseProfilesCSV(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { profiles: [], errors: ['The file is empty.'] };

  const headers = rows[0].map(normalizeHeader);
  const findColumn = (aliases, suffix = '') => headers.findIndex((h) => aliases.some((alias) => h === `${alias}${suffix}`));
  const columns = Object.fromEntries(Object.entries(COLUMNS).map(([key, aliases]) => [key, findColumn(aliases)]));

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
      const number = get(set.number).replace(/\D/g, '');
      if (!number) continue;
      const cvv = get(set.cvv).replace(/\D/g, '');
      if (number.length < 12 || number.length > 19 || !cvv) {
        errors.push(`Line ${line}: a card needs a 12–19 digit number and a CVV; it was skipped.`);
        continue;
      }
      cards.push({
        number,
        name: get(set.name) || get(columns.name),
        expMonth: normalizeMonth(get(set.expMonth)),
        expYear: normalizeYear(get(set.expYear)),
        cvv,
      });
    }

    profiles.push({
      id: randomUUID(),
      profile: profileName,
      name: get(columns.name),
      email: get(columns.email),
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

/** What the window UI gets: everything except full card numbers and CVVs. */
function publicProfile(profile) {
  const { cards, proxy, ...rest } = profile;
  return {
    ...rest,
    hasProxy: Boolean(proxy),
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
function buildAutofillScript(profile, card) {
  const [first, ...rest] = profile.name.split(/\s+/);
  const values = {
    email: profile.email,
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
    ['ccNumber', ['cc-number'], /card.?num|cc.?num|cardnumber|credit.?card/],
    ['ccCsc', ['cc-csc'], /cvv|cvc|csc|security.?code|card.?code/],
    ['ccExpMonth', ['cc-exp-month'], /exp\w*.?(month|mm\b)|cc.?month/],
    ['ccExpYear', ['cc-exp-year'], /exp\w*.?(year|yy)|cc.?year/],
    ['ccExp', ['cc-exp'], /exp(iry|iration)?.?(date)?|mm.?\/?.?yy/],
    ['ccName', ['cc-name'], /card.?holder|name.?on.?card|cc.?name|card.?name/],
    ['email', ['email', 'username'], /e-?mail/],
    ['givenName', ['given-name'], /first.?name|fname|given/],
    ['familyName', ['family-name'], /last.?name|lname|surname|family/],
    ['tel', ['tel', 'tel-national'], /phone|tel\b|mobile|cell/],
    ['address2', ['address-line2'], /address.?(line)?.?2|apt|suite|unit/],
    ['address1', ['address-line1', 'street-address'], /address|street/],
    ['city', ['address-level2'], /city|town|locality/],
    ['state', ['address-level1'], /state|province|region/],
    ['zip', ['postal-code'], /zip|postal|postcode/],
    ['country', ['country', 'country-name'], /country/],
    ['fullName', ['name'], /full.?name|^name$|your.?name/],
  ];

  const describe = (el) => {
    const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)
      || el.closest('label')?.textContent || '';
    return [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), label].join(' ').toLowerCase();
  };

  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const setValue = (el, value) => {
    if (el instanceof HTMLSelectElement) {
      const wanted = String(value).toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted)
        || [...el.options].find((o) => /^\d+$/.test(wanted) && Number(o.value) === Number(wanted))
        || [...el.options].find((o) => wanted.length === 4 && o.text.trim() === wanted.slice(-2));
      if (!option) return false;
      el.value = option.value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  };

  const fields = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'password'].includes(type) && visible(el);
  });
  const hasSplitName = fields.some((el) => /given-name|family-name/.test(el.autocomplete) || /first.?name|last.?name/.test(describe(el)));

  let filled = 0;
  for (const el of fields) {
    if (el.value && !(el instanceof HTMLSelectElement)) continue;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).pop();
    const text = describe(el);
    const rule = RULES.find(([, tokens]) => tokens.includes(autocomplete))
      || RULES.find(([, , pattern]) => pattern.test(text));
    if (!rule) continue;
    const [key] = rule;
    if (key === 'fullName' && hasSplitName) continue;
    if (key === 'email' && autocomplete === 'username' && !/@/.test(values.email)) continue;
    const value = values[key];
    if (value && setValue(el, value)) filled++;
  }
  return filled;
}

module.exports = { parseCSV, parseProfilesCSV, publicProfile, searchProfiles, planAssignments, buildAutofillScript, normalizePhone };
