'use strict';

/** Lazy — profiles.js imports the parser pieces from here under Node (no Electron) too. */
const electronNet = () => require('electron').net;

/**
 * Jancy-compatible profile resolvers. A profile can carry one or more `Site:<pattern>` columns, each
 * holding a resolver string like `password=automatiq:TOKEN:92, smscode=textchest:APIKEY`. When
 * autofill runs on a page whose host matches the pattern (or whose main site label is the pattern),
 * the resolver is executed and its value fills the matching field.
 *
 * Reference: https://docs.jancy.io/docs/resolver-columns
 */

const FIELDS = ['password', 'smscode', 'emailcode', 'othercode'];
const DEFAULT_PARSER = 'ticketmaster';

/** Parses one `Site:X` cell: `field=name:arg1:arg2, field=$literal, ...`. */
function parseResolverCell(cell) {
  const entries = [];
  const errors = [];
  const text = String(cell ?? '').trim();
  if (!text) return { entries, errors };
  for (const chunk of text.split(/\s*,\s*/)) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq === -1) { errors.push(`Resolver "${chunk}" has no field (expected field=resolver:args).`); continue; }
    const field = chunk.slice(0, eq).trim().toLowerCase();
    const value = chunk.slice(eq + 1).trim();
    if (!FIELDS.includes(field)) { errors.push(`Resolver field "${field}" is not one of ${FIELDS.join(', ')}.`); continue; }
    if (value.startsWith('$')) {
      entries.push({ field, resolver: 'static', value: value.slice(1) });
      continue;
    }
    const colon = value.indexOf(':');
    const name = (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
    const argsText = colon === -1 ? '' : value.slice(colon + 1);
    entries.push({ field, resolver: name, args: argsText ? argsText.split(':') : [] });
  }
  return { entries, errors };
}

/** True if `sitePattern` applies to the given tab URL or the profile's own site label. */
function matchesSite(sitePattern, tabUrl, profileSite) {
  const pattern = String(sitePattern ?? '').trim().toLowerCase();
  if (!pattern || pattern === '*') return true;
  if ((profileSite ?? '').trim().toLowerCase() === pattern) return true;
  try {
    const host = new URL(tabUrl).host.toLowerCase();
    if (host === pattern) return true;
    if (host.endsWith(`.${pattern}`) || host.endsWith(`.${pattern}.com`)) return true;
    if (host.includes(pattern)) return true;
  } catch {}
  return false;
}

/** First resolver entry whose Site column applies to this URL, for the given field. */
function pickResolver(profile, field, tabUrl) {
  for (const column of profile.resolvers ?? []) {
    if (!matchesSite(column.site, tabUrl, profile.site)) continue;
    const entry = column.entries.find((e) => e.field === field);
    if (entry) return entry;
  }
  return null;
}

// Jancy-documented site IDs for Automatiq.
const AUTOMATIQ_SITE_IDS = { ticketmaster: 92, axs: 276, seatgeek: 9 };
const AUTOMATIQ_HOST_TO_SITE = [
  ['ticketmaster.com', 92], ['ticketmaster.ca', 92], ['livenation.com', 92],
  ['axs.com', 276], ['axs.co.uk', 276],
  ['seatgeek.com', 9],
];

/** Runs a resolver entry. Returns { value } or { error } (never throws). */
async function runResolver(entry, profile, tabUrl) {
  try {
    if (entry.resolver === 'static') return { value: entry.value };
    if (entry.resolver === 'textchest' || entry.resolver === 'textchest-async') {
      return fetchTextChest(entry, profile);
    }
    if (entry.resolver === 'automatiq') {
      return fetchAutomatiq(entry, profile, tabUrl);
    }
    // Other Jancy resolvers (lysted, 1ticket, texttrove, wired, quick-text, smsgateway,
    // seatheroes, victorylive1, ticketsuite, gmail, imap) are recognised in the schema but have
    // provider-specific APIs; they return a clear "not wired up" error so autofill still runs.
    return { error: `#UNSUPPORTED resolver "${entry.resolver}"` };
  } catch (error) {
    return { error: `#RESOLVER ERROR: ${error.message}` };
  }
}

async function fetchTextChest(entry, profile) {
  const [apiKey, parser = DEFAULT_PARSER] = entry.args ?? [];
  if (!apiKey) return { error: '#NO API KEY' };
  const number = String(profile.smsNumber ?? '').replace(/\D/g, '');
  if (!number) return { error: '#NO SMS NUMBER' };
  // TextChest's base URL is https://api.textchest.com (confirmed from their Developer docs).
  // /messages is the real route (returns 401 unauth, 404 everywhere else), and the webhook payload
  // documents the recipient/message field names. Override with TABFLEET_TEXTCHEST_URL if TextChest
  // changes the route; placeholders: {key} (seldom used — key goes in the Authorization header),
  // {number}, {parser}, {endpoint} (which is "messages" for textchest, "async_messages" for the
  // async variant — follow TextChest's "Regular Lines" / "Async Lines" docs sections).
  const endpoint = entry.resolver === 'textchest-async' ? 'async_messages' : 'messages';
  const template = process.env.TABFLEET_TEXTCHEST_URL
    || 'https://api.textchest.com/{endpoint}?recipient={number}';
  const url = template
    .replace('{endpoint}', encodeURIComponent(endpoint))
    .replace('{key}', encodeURIComponent(apiKey))
    .replace('{number}', encodeURIComponent(number))
    .replace('{parser}', encodeURIComponent(parser));
  let host = '';
  try { host = new URL(url).host; } catch {}
  const response = await electronNet().fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'follow',
  });
  if (response.status === 401 || response.status === 403) {
    return { error: `#API ERROR (HTTP ${response.status} from ${host} — check your API key)` };
  }
  if (!response.ok) return { error: `#API ERROR (HTTP ${response.status} from ${host})` };
  const text = (await response.text()).trim();
  if (!text) return { error: `#NO MSG (empty response from ${host})` };
  let data = null;
  try { data = JSON.parse(text); } catch {}
  // Walk the response for the message body, then extract a code from it. The webhook payload uses
  // `message` as the SMS body field, so prefer that; fall back to `body`, `text`, `sms`, or the
  // raw text.
  const body = pickMessageBody(data) ?? text;
  const code = extractCode(null, body);
  if (code) return { value: code };
  const preview = String(body).slice(0, 80).replace(/\s+/g, ' ');
  return { error: `#NO MSG (no digits in response: ${preview})` };
}

/** Finds the SMS body in a TextChest-style response. Walks arrays and wrappers like {data: [...]}. */
function pickMessageBody(data) {
  if (!data) return null;
  const candidates = ['message', 'body', 'text', 'sms', 'content'];
  const walk = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) { for (const item of value) { const found = walk(item); if (found) return found; } return null; }
    if (value && typeof value === 'object') {
      for (const key of candidates) if (typeof value[key] === 'string' && value[key]) return value[key];
      for (const nested of Object.values(value)) { const found = walk(nested); if (found) return found; }
    }
    return null;
  };
  return walk(data);
}

/**
 * Fetches a site-specific password for `profile.email` from Automatiq. The exact endpoint is not
 * documented publicly; override with TABFLEET_AUTOMATIQ_URL (placeholders: {token}, {email},
 * {company}, {site}). The default is a reasonable guess — users seeing "#API ERROR" should set
 * this to the URL from their Automatiq onboarding.
 */
async function fetchAutomatiq(entry, profile, tabUrl) {
  const [token, company, siteArg] = entry.args ?? [];
  if (!token) return { error: '#NO API TOKEN' };
  if (!company) return { error: '#NO COMPANY ID' };
  if (!profile.email) return { error: '#NO EMAIL' };
  // SITE-ID: -999 means "match by tab URL"; a known host maps to its documented id.
  let siteId = siteArg === undefined || siteArg === '' ? null : Number(siteArg);
  const byUrl = siteId === -999 || siteId === null;
  if (byUrl) {
    try {
      const host = new URL(tabUrl).host.toLowerCase();
      const match = AUTOMATIQ_HOST_TO_SITE.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
      if (!match) return { error: siteId === -999 ? '#NO ACCOUNT FOR URL' : '#NO SITE ID' };
      siteId = match[1];
    } catch {
      return { error: '#NO ACCOUNT FOR URL' };
    }
  }
  const template = process.env.TABFLEET_AUTOMATIQ_URL
    || 'https://api.automatiq.com/v1/accounts?email={email}&company_id={company}&site_id={site}';
  const url = template
    .replace('{token}', encodeURIComponent(token))
    .replace('{email}', encodeURIComponent(profile.email))
    .replace('{company}', encodeURIComponent(company))
    .replace('{site}', encodeURIComponent(String(siteId)));
  const response = await electronNet().fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!response.ok) return { error: '#API ERROR' };
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { return { error: '#API ERROR' }; }
  // Walk the response looking for an account whose site matches, then its password.
  const accounts = Array.isArray(data) ? data : (data.accounts ?? data.data ?? data.results ?? []);
  if (!Array.isArray(accounts) || accounts.length === 0) return { error: '#NO PASSWORD' };
  const matching = accounts.find((a) => Number(a.site_id ?? a.siteId ?? a.site) === siteId) ?? accounts[0];
  const password = matching?.password ?? matching?.pass ?? matching?.secret;
  if (!password) return { error: '#NO ACCOUNT' };
  return { value: String(password) };
}

function extractCode(data, raw) {
  const haystack = data ? JSON.stringify(data) : raw;
  const contextual = haystack.match(/(?:code|otp|pin|password)[^0-9]{0,8}(\d{4,8})/i);
  if (contextual) return contextual[1];
  const six = haystack.match(/\b\d{6}\b/);
  if (six) return six[0];
  const any = haystack.match(/\b\d{4,8}\b/);
  return any ? any[0] : '';
}

/** Returns { field: value } for every resolver that matches this tab URL. Errors are collected. */
async function resolveForTab(profile, tabUrl) {
  const values = {};
  const errors = [];
  for (const field of FIELDS) {
    const entry = pickResolver(profile, field, tabUrl);
    if (!entry) continue;
    const result = await runResolver(entry, profile, tabUrl);
    if (result.value) values[field] = result.value;
    else errors.push(`${field}: ${result.error}`);
  }
  return { values, errors };
}

/** Removes resolver secrets before sending the profile to the renderer. */
function sanitizeResolvers(resolvers) {
  return (resolvers ?? []).map((col) => ({
    site: col.site,
    entries: col.entries.map((e) => ({ field: e.field, resolver: e.resolver })),
  }));
}

module.exports = {
  parseResolverCell, matchesSite, pickResolver, runResolver, resolveForTab, sanitizeResolvers,
  FIELDS, AUTOMATIQ_SITE_IDS,
};
