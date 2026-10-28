'use strict';

/**
 * Ad, analytics and tracking hosts blocked in tab sessions ("Block ads & trackers" in Settings).
 *
 * Chosen from what ticket sites actually load (measured on Ticketmaster: roughly half of every page's
 * bytes and over 100 requests on a search page). Nothing a page needs to work is here: the sites'
 * own hosts, reCAPTCHA (www.google.com / www.gstatic.com), queue and bot-protection services, consent
 * managers and payment providers are all left alone.
 */
const BLOCKED_HOSTS = [
  // Google ads & analytics (not reCAPTCHA, which lives on www.google.com / www.gstatic.com)
  'googletagmanager.com', 'google-analytics.com', 'analytics.google.com', 'doubleclick.net',
  'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  // Social pixels
  'connect.facebook.net', 'analytics.tiktok.com', 'analytics-ipv6.tiktokw.us', 'tr.snapchat.com',
  'tr6.snapchat.com', 'sc-static.net', 'static.ads-twitter.com', 'analytics.twitter.com', 'ads-twitter.com',
  'alb.reddit.com', 'pixel-config.reddit.com', 'px.ads.linkedin.com', 'snap.licdn.com', 'ct.pinterest.com',
  // Ad exchanges and retargeting
  'bat.bing.com', 'amazon-adsystem.com', 'adsrvr.org', 'pubmatic.com', 'rubiconproject.com',
  'casalemedia.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'openx.net',
  '3lift.com', 'bidswitch.net', 'mathtag.com', 'demdex.net', 'everesttech.net', 'agkn.com', 'bluekai.com',
  'krxd.net', 'pippio.com', 'ad.gt', 'advanseads.com', 'xg4ken.com', 'yieldmo.com', 'teads.tv',
  'moatads.com', 'doubleverify.com', 'adsafeprotected.com', 'quantserve.com', 'quantcount.com',
  'scorecardresearch.com',
  // Session recording, heat-maps, surveys, customer-data pixels
  'contentsquare.net', 'hotjar.com', 'clarity.ms', 'usabilla.com', 'lytics.io', 'cdndex.io',
  'fullstory.com', 'mouseflow.com', 'nr-data.net', 'js-agent.newrelic.com',
];

// Paths on hosts that also serve real content.
const BLOCKED_PATHS = [
  '*://*.facebook.com/tr*',
  '*://*.redditstatic.com/ads/*',
];

/** Chromium match patterns; "*.host" also matches the host itself. Matched natively, so no per-request cost. */
function blockedURLPatterns() {
  return [...BLOCKED_HOSTS.map((host) => `*://*.${host}/*`), ...BLOCKED_PATHS];
}

module.exports = { BLOCKED_HOSTS, blockedURLPatterns };
