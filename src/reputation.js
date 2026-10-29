'use strict';

// Checks each proxy's exit IP against ipquery.io's free reputation API and classifies the proxy as
// either clean or flagged. A proxy is flagged when ipquery reports is_proxy / is_vpn / is_tor /
// is_datacenter, when the risk_score is above FLAG_SCORE, or when the request fails outright (dead
// proxy / wrong auth / unreachable gateway — none of which belong in a working pool either).
//
// The check runs through a short-lived in-memory session with the proxy pinned to it, so the real
// browsing sessions are never touched. Concurrency is capped so a thousand-proxy pool doesn't open a
// thousand sockets at once.

const { session: electronSession } = require('electron');
const { randomUUID } = require('node:crypto');
const { proxyRule, proxyKey } = require('./proxy');

const CHECK_TIMEOUT_MS = 12000;
const CONCURRENCY = 10;
const FLAG_SCORE = 70;

function pLimit(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active++;
      task().then(resolve, reject).finally(() => { active--; drain(); });
    }
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
}

async function checkOneProxy(proxy) {
  const partition = `temp-check-${randomUUID()}`;
  const ses = electronSession.fromPartition(partition);
  try {
    await ses.setProxy({ proxyRules: proxyRule(proxy), proxyBypassRules: '<local>' });
    await ses.clearAuthCache();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    let response;
    try {
      response = await ses.fetch('https://api.ipquery.io/?format=json', {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { proxy, flagged: true, reason: `HTTP ${response.status}` };
    const data = await response.json();
    const risk = data.risk ?? {};
    const flags = [];
    if (risk.is_proxy) flags.push('proxy');
    if (risk.is_vpn) flags.push('vpn');
    if (risk.is_tor) flags.push('tor');
    if (risk.is_datacenter) flags.push('datacenter');
    const score = Number(risk.risk_score) || 0;
    if (score >= FLAG_SCORE) flags.push(`risk ${score}`);
    return {
      proxy,
      ip: data.ip ?? null,
      country: data.location?.country ?? null,
      isp: data.isp?.isp ?? null,
      score,
      flags,
      flagged: flags.length > 0,
      reason: flags.length > 0 ? flags.join(', ') : null,
    };
  } catch (error) {
    return { proxy, flagged: true, reason: error.name === 'AbortError' ? 'timeout' : (error.message || 'unreachable') };
  } finally {
    // Short-lived temp session — drop its storage so this check leaves no trace.
    ses.clearStorageData().catch(() => {});
    ses.closeAllConnections().catch(() => {});
  }
}

/** Checks every proxy; onProgress({done, total, lastResult}) fires after each one so the UI can tick. */
async function checkProxies(proxies, onProgress) {
  const limit = pLimit(CONCURRENCY);
  const results = new Array(proxies.length);
  let done = 0;
  await Promise.all(proxies.map((proxy, i) => limit(async () => {
    const result = await checkOneProxy(proxy);
    results[i] = result;
    done++;
    try { onProgress?.({ done, total: proxies.length, lastResult: result }); } catch {}
  })));
  return results;
}

module.exports = { checkProxies, proxyKey, FLAG_SCORE };
