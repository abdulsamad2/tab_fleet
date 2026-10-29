'use strict';

// What a tab tells sites about where its user is. A page sees the IP's location next to the browser's
// timezone and languages, and a US proxy with a Korean timezone/language reads as a bot behind a proxy.
// So a proxied tab reports a timezone that fits the account (its TimeZone column, else its address's
// state, else the proxy's region), and every tab reports the same plain US English languages.

const LANGUAGES = 'en-US,en';

const STATE_ZONES = {
  'America/New_York': ['CT', 'DE', 'DC', 'FL', 'GA', 'KY', 'ME', 'MD', 'MA', 'NH', 'NJ', 'NY', 'NC', 'OH', 'PA', 'RI', 'SC', 'VT', 'VA', 'WV'],
  'America/Detroit': ['MI'],
  'America/Indiana/Indianapolis': ['IN'],
  'America/Chicago': ['AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI'],
  'America/Denver': ['CO', 'MT', 'NM', 'UT', 'WY', 'ID'],
  'America/Phoenix': ['AZ'],
  'America/Los_Angeles': ['CA', 'NV', 'OR', 'WA'],
  'America/Anchorage': ['AK'],
  'Pacific/Honolulu': ['HI'],
  'America/Puerto_Rico': ['PR'],
  'America/Toronto': ['ON', 'QC'],
  'America/Vancouver': ['BC'],
  'America/Edmonton': ['AB'],
  'America/Winnipeg': ['MB'],
  'America/Regina': ['SK'],
  'America/Halifax': ['NS', 'NB', 'PE'],
  'America/St_Johns': ['NL'],
};
const ZONE_BY_STATE = Object.fromEntries(Object.entries(STATE_ZONES).flatMap(([zone, states]) => states.map((s) => [s, zone])));

const REGION_ZONES = {
  us: 'America/New_York', ca: 'America/Toronto', gb: 'Europe/London', uk: 'Europe/London', ie: 'Europe/Dublin',
  au: 'Australia/Sydney', nz: 'Pacific/Auckland', de: 'Europe/Berlin', fr: 'Europe/Paris', es: 'Europe/Madrid',
  it: 'Europe/Rome', nl: 'Europe/Amsterdam', be: 'Europe/Brussels', se: 'Europe/Stockholm', mx: 'America/Mexico_City',
};
const DEFAULT_ZONE = 'America/New_York';

function validZone(zone) {
  const text = String(zone ?? '').trim();
  if (!text) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The timezone a proxied tab reports: the account's TimeZone column, its state, the proxy's region, else US Eastern. */
function timeZoneFor({ profile = null, region = null } = {}) {
  return validZone(profile?.timeZone)
    || ZONE_BY_STATE[String(profile?.state ?? '').trim().toUpperCase()]
    || REGION_ZONES[String(region ?? '').trim().toLowerCase()]
    || DEFAULT_ZONE;
}

/** Electron's user agent names the app and Electron (and changes with every release); a browser's doesn't. */
function cleanUserAgent(userAgent) {
  return String(userAgent).replace(/ (?!Chrome\/|Safari\/|AppleWebKit\/|Mozilla\/)[\w.-]+\/[\d.]+(?= )/g, '').replace(/ Electron\/[\d.]+/, '');
}

module.exports = { LANGUAGES, timeZoneFor, cleanUserAgent, validZone };
