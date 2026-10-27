'use strict';

// resolvers.js lazy-requires Electron; parser functions here never trigger the require.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResolverCell, matchesSite, pickResolver, FIELDS } = require('../src/resolvers');

test('exposes the Jancy field names', () => {
  assert.deepEqual(FIELDS, ['password', 'smscode', 'emailcode', 'othercode']);
});

test('parses a resolver cell with multiple entries', () => {
  const { entries, errors } = parseResolverCell('password=automatiq:TOKEN:92, smscode=textchest:APIKEY');
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { field: 'password', resolver: 'automatiq', args: ['TOKEN', '92'] },
    { field: 'smscode', resolver: 'textchest', args: ['APIKEY'] },
  ]);
});

test('parses TextChest with and without a parser', () => {
  assert.deepEqual(parseResolverCell('smscode=textchest:KEY').entries, [
    { field: 'smscode', resolver: 'textchest', args: ['KEY'] },
  ]);
  assert.deepEqual(parseResolverCell('smscode=textchest:KEY:axs').entries, [
    { field: 'smscode', resolver: 'textchest', args: ['KEY', 'axs'] },
  ]);
});

test('parses Automatiq with and without a SITE-ID', () => {
  assert.deepEqual(parseResolverCell('password=automatiq:TOKEN:42').entries, [
    { field: 'password', resolver: 'automatiq', args: ['TOKEN', '42'] },
  ]);
  assert.deepEqual(parseResolverCell('password=automatiq:TOKEN:42:-999').entries, [
    { field: 'password', resolver: 'automatiq', args: ['TOKEN', '42', '-999'] },
  ]);
});

test('parses static ($-prefixed) literal values', () => {
  assert.deepEqual(parseResolverCell('password=$hunter2').entries, [
    { field: 'password', resolver: 'static', value: 'hunter2' },
  ]);
});

test('rejects unknown fields and malformed cells', () => {
  const { entries, errors } = parseResolverCell('foo=bar:baz, password');
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 2);
});

test('matchesSite handles *, hostname, and profile.site label', () => {
  assert.equal(matchesSite('*', 'https://example.com', ''), true);
  assert.equal(matchesSite('ticketmaster', 'https://www.ticketmaster.com/x', ''), true);
  assert.equal(matchesSite('ticketmaster.com', 'https://presale.ticketmaster.com', ''), true);
  assert.equal(matchesSite('AXS', 'https://nowhere.example', 'axs'), true);
  assert.equal(matchesSite('AXS', 'https://nowhere.example', ''), false);
});

test('pickResolver picks the first matching Site column for the field', () => {
  const profile = {
    site: 'Ticketmaster',
    resolvers: [
      { site: 'AXS', entries: [{ field: 'smscode', resolver: 'textchest', args: ['K1'] }] },
      { site: 'Ticketmaster', entries: [{ field: 'smscode', resolver: 'textchest', args: ['K2'] }] },
    ],
  };
  const entry = pickResolver(profile, 'smscode', 'https://www.ticketmaster.com/event');
  assert.deepEqual(entry, { field: 'smscode', resolver: 'textchest', args: ['K2'] });
  assert.equal(pickResolver(profile, 'password', 'https://www.ticketmaster.com'), null);
});
