'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BLOCKED_HOSTS, blockedURLPatterns } = require('../src/blocklist');

// Chromium match-pattern semantics for "*://*.host/*": the host itself and any subdomain.
function blocked(url) {
  const { hostname, pathname, search } = new URL(url);
  return blockedURLPatterns().some((pattern) => {
    const [, hostPart, pathPart] = /^\*:\/\/([^/]+)(\/.*)$/.exec(pattern);
    const base = hostPart.replace(/^\*\./, '');
    const hostOK = hostname === base || hostname.endsWith(`.${base}`);
    const pathRe = new RegExp(`^${pathPart.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return hostOK && pathRe.test(pathname + search);
  });
}

test('blocks the ad and tracking hosts measured on Ticketmaster', () => {
  for (const url of [
    'https://www.googletagmanager.com/gtm.js?id=GTM-1', 'https://connect.facebook.net/en_US/fbevents.js',
    'https://analytics.tiktok.com/i18n/pixel/events.js', 'https://tr.snapchat.com/p', 'https://bat.bing.com/bat.js',
    'https://c.amazon-adsystem.com/aax2/apstag.js', 'https://t.contentsquare.net/uxa/x.js',
    'https://stats.g.doubleclick.net/g/collect', 'https://www.facebook.com/tr?id=1&ev=PageView',
  ]) assert.ok(blocked(url), url);
});

test('never blocks what pages need to work', () => {
  for (const url of [
    'https://www.ticketmaster.com/event/123', 'https://identity.ticketmaster.com/sign-in', 'https://uk.tmconst.com/app.js',
    'https://s1.ticketm.net/dam/a/1.jpg', 'https://www.google.com/recaptcha/api.js', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js',
    'https://www.google.com/maps', 'https://docs.google.com/spreadsheets/d/1', 'https://www.facebook.com/login',
    'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js', 'https://global.ketchcdn.com/web/v3/config.json',
    'https://ticketmaster.queue-it.net/', 'https://www.paypal.com/sdk/js', 'https://js.braintreegateway.com/web/3/js/client.min.js',
    'https://checkoutshopper-live.adyen.com/checkoutshopper/sdk.js', 'https://www.axs.com/', 'https://seatgeek.com/',
  ]) assert.ok(!blocked(url), url);
  assert.ok(!BLOCKED_HOSTS.some((h) => /(^|\.)(google|gstatic|ticketmaster|tmconst|ticketm|queue-it|cookielaw|onetrust|ketch)/.test(h) && !/analytics|tagmanager|syndication|adservice|doubleclick/.test(h)));
});
