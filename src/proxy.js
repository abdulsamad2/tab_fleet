'use strict';

const { randomUUID } = require('node:crypto');

const SESSION_TOKEN = '{session}';
const COUNTRY_TOKEN = '{country}';

const DEFAULT_CONFIG = Object.freeze({
  startURL: 'https://www.google.com',
  tabCount: 4,
  isolation: 'perTab', // 'perTab' | 'shared'
  proxySource: 'none', // 'none' | 'list' | 'rotating' | 'remote'
  proxyList: '',
  startDirect: false, // start tabs on the local IP and switch them to a proxy later
  theme: 'system', // 'system' | 'light' | 'dark'
  rotating: { host: '', port: 8000, usernameTemplate: 'user-session-{session}', password: '', regions: 'us' },
  remote: { url: '', token: '' },
});

function normalizeConfig(raw = {}) {
  const theme = ['system', 'light', 'dark'].includes(raw.theme) ? raw.theme : DEFAULT_CONFIG.theme;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    tabCount: Math.min(50, Math.max(1, Number.parseInt(raw.tabCount ?? DEFAULT_CONFIG.tabCount, 10) || 1)),
    startDirect: Boolean(raw.startDirect),
    theme,
    rotating: { ...DEFAULT_CONFIG.rotating, ...(raw.rotating ?? {}) },
    remote: { ...DEFAULT_CONFIG.remote, ...(raw.remote ?? {}) },
  };
}

/** Splits a list like "us, ca gb" into lower-case region codes. */
function parseRegions(text) {
  return [...new Set(String(text ?? '').toLowerCase().split(/[\s,]+/).filter((code) => /^[a-z0-9_-]+$/.test(code)))];
}

/**
 * Parses `host:port`, `host:port:user:pass` or `user:pass@host:port`,
 * optionally prefixed with `http://` or `socks5://`, and optionally tagged
 * with a region first (`us host:port`).
 */
function parseProxy(raw) {
  let text = String(raw).trim();
  if (!text || text.startsWith('#')) return null;

  let region = null;
  const tagged = /^([a-z0-9_-]+)\s+(\S+)$/i.exec(text);
  if (tagged) {
    region = tagged[1].toLowerCase();
    text = tagged[2];
  }

  let kind = 'http';
  const scheme = /^(socks5?|https?):\/\//i.exec(text);
  if (scheme) {
    kind = scheme[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http';
    text = text.slice(scheme[0].length);
  }

  let username = null;
  let password = null;
  const at = text.lastIndexOf('@');
  if (at !== -1) {
    const credentials = text.slice(0, at);
    const colon = credentials.indexOf(':');
    if (colon === -1) return null;
    username = credentials.slice(0, colon);
    password = credentials.slice(colon + 1);
    text = text.slice(at + 1);
  }

  const parts = text.split(':');
  if (parts.length === 4 && username === null) {
    [, , username, password] = parts;
  } else if (parts.length > 4 && username === null) {
    // Password containing colons.
    username = parts[2];
    password = parts.slice(3).join(':');
  } else if (parts.length !== 2) {
    return null;
  }

  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind, host, port, username, password, region };
}

function parseProxyList(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(parseProxy)
    .filter(Boolean);
}

/** Downloads a plain-text, one-proxy-per-line list from an optional bearer-authenticated endpoint. */
async function fetchRemoteProxyList(remote, fetchImpl = globalThis.fetch) {
  const url = new URL(String(remote?.url ?? ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Proxy-list URL must use HTTP or HTTPS.');
  if (typeof fetchImpl !== 'function') throw new Error('Remote proxy lists are unavailable in this runtime.');
  const token = String(remote?.token ?? '').trim();
  const response = await fetchImpl(url, {
    headers: {
      accept: 'text/plain',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`Proxy-list request failed (${response.status}).`);
  const text = await response.text();
  if (parseProxyList(text).length === 0) throw new Error('The proxy-list endpoint returned no valid proxies.');
  return text;
}

/** Returns a user-facing problem with the config, or null when it can launch. */
function validateConfig(config) {
  if (!toURL(config.startURL)) return 'Enter a start address.';
  if (config.proxySource === 'list') {
    const proxies = parseProxyList(config.proxyList);
    if (proxies.length === 0) return 'Add at least one proxy (host:port or host:port:user:pass).';
    if (proxies.some((p) => p.kind === 'socks5' && p.username)) {
      return 'Chromium cannot authenticate to SOCKS5 proxies. Use HTTP proxies for user:pass lists.';
    }
  }
  if (config.proxySource === 'rotating') {
    const { host, port, usernameTemplate } = config.rotating;
    if (!String(host).trim()) return 'Enter the gateway host.';
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return 'Port must be between 1 and 65535.';
    if (!String(usernameTemplate).includes(SESSION_TOKEN)) return `Username template must contain ${SESSION_TOKEN}.`;
    if (String(usernameTemplate).includes(COUNTRY_TOKEN) && parseRegions(config.rotating.regions).length === 0) {
      return `List at least one region code to fill ${COUNTRY_TOKEN}.`;
    }
  }
  if (config.proxySource === 'remote') {
    try {
      const url = new URL(String(config.remote.url));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      return 'Enter an HTTP or HTTPS proxy-list URL.';
    }
  }
  return null;
}

/**
 * Hands out proxies to sessions: list entries in round-robin order (per region when tagged),
 * or a fresh sticky session on a rotating gateway (each new session id is a new exit IP).
 */
function createPool(config) {
  const list = config.proxySource === 'list' ? parseProxyList(config.proxyList) : [];
  const template = config.rotating;
  const rotatingRegions = config.proxySource === 'rotating' && String(template.usernameTemplate).includes(COUNTRY_TOKEN)
    ? parseRegions(template.regions)
    : [];
  const nextIndex = new Map(); // region (or '' for all) -> position in its candidate list

  return {
    enabled: config.proxySource === 'rotating' || list.length > 0,
    regions: config.proxySource === 'list' ? [...new Set(list.map((p) => p.region).filter(Boolean))] : rotatingRegions,
    next(region = null) {
      if (config.proxySource === 'list') {
        const candidates = region ? list.filter((p) => p.region === region) : list;
        if (candidates.length === 0) return null;
        const key = region ?? '';
        const index = (nextIndex.get(key) ?? 0) % candidates.length;
        nextIndex.set(key, index + 1);
        return candidates[index];
      }
      if (config.proxySource === 'rotating') {
        const chosen = rotatingRegions.includes(region) ? region : (rotatingRegions[0] ?? null);
        const session = randomUUID().replaceAll('-', '').slice(0, 10);
        return {
          kind: 'http',
          host: String(template.host).trim(),
          port: Number(template.port),
          username: template.usernameTemplate.replaceAll(SESSION_TOKEN, session).replaceAll(COUNTRY_TOKEN, chosen ?? ''),
          password: template.password || null,
          region: chosen,
        };
      }
      return null;
    },
  };
}

function proxyRule(proxy) {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.kind === 'socks5' ? 'socks5' : 'http'}://${host}:${proxy.port}`;
}

/** Display text; never includes the password. */
function proxyLabel(proxy) {
  if (!proxy) return null;
  const address = `${proxy.kind === 'socks5' ? 'socks5://' : ''}${proxy.host}:${proxy.port}`;
  const label = proxy.username ? `${address} · ${proxy.username}` : address;
  return proxy.region ? `${proxy.region.toUpperCase()} · ${label}` : label;
}

/** Turns address-bar input into a URL: full URLs pass through, bare hosts get a scheme, anything else is a search. */
function toURL(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^(https?|about|file):/i.test(text)) return text;
  if (!/\s/.test(text)) {
    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
    if (text.includes('.')) return `https://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseProxy,
  parseProxyList,
  fetchRemoteProxyList,
  parseRegions,
  validateConfig,
  createPool,
  proxyRule,
  proxyLabel,
  toURL,
};
