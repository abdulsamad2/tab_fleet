'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timeZoneFor, cleanUserAgent, validZone, LANGUAGES } = require('../src/identity');

test('a proxied tab gets the account TimeZone, else its state, else the proxy region, else US Eastern', () => {
  assert.equal(timeZoneFor({ profile: { timeZone: 'America/Denver', state: 'TX' }, region: 'ca' }), 'America/Denver');
  assert.equal(timeZoneFor({ profile: { timeZone: 'Not/AZone', state: 'tx' }, region: 'ca' }), 'America/Chicago');
  assert.equal(timeZoneFor({ profile: { state: 'CA' } }), 'America/Los_Angeles');
  assert.equal(timeZoneFor({ profile: { state: 'AZ' } }), 'America/Phoenix');
  assert.equal(timeZoneFor({ profile: { state: 'BC' } }), 'America/Vancouver');
  assert.equal(timeZoneFor({ profile: { state: '' }, region: 'CA' }), 'America/Toronto');
  assert.equal(timeZoneFor({ region: 'gb' }), 'Europe/London');
  assert.equal(timeZoneFor({ region: 'zz' }), 'America/New_York');
  assert.equal(timeZoneFor(), 'America/New_York');
});

test('every state and province maps to a real timezone', () => {
  for (const state of ['NY', 'MI', 'IN', 'TX', 'CO', 'AZ', 'CA', 'AK', 'HI', 'PR', 'ON', 'AB', 'MB', 'SK', 'NS', 'NL']) {
    assert.ok(validZone(timeZoneFor({ profile: { state } })), state);
  }
  assert.equal(validZone('america/chicago'), 'America/Chicago');
  assert.equal(validZone(''), null);
});

test('the user agent loses the app and Electron tokens and nothing else', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TabFleet/1.3.5 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36';
  assert.equal(cleanUserAgent(mac), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.48 Safari/537.36');
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tabfleet/1.3.6 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36';
  assert.equal(cleanUserAgent(win), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.48 Safari/537.36');
  assert.equal(cleanUserAgent(cleanUserAgent(mac)), cleanUserAgent(mac));
  assert.equal(LANGUAGES, 'en-US,en');
});
