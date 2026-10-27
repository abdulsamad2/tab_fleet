'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, parseProfilesCSV, publicProfile, searchProfiles, planAssignments, normalizePhone } = require('../src/profiles');

const CSV = [
  'Profile,Name,Email,Address,City,State,Zip Code,Phone Number,Proxy,Card Number,Exp Month,Exp Year,CVV,Card Number 2,CVV 2,Group',
  'Alpha,Ann Lee,ann@example.com,"1 Main St, Apt 2",Richmond,va,23220,1-804-555-0100,us p.example:8000:u:p,4111 1111 1111 1111,3,28,123,5555555555554444,999,East',
  'Bravo,Bob Ray,bob@example.com,,,,,804.555.0101,,,,,,,,West',
  ',No Profile,x@example.com',
  'Alpha,Dup Entry,dup@example.com',
].join('\r\n');

test('parses quoted, delimited CSV', () => {
  assert.deepEqual(parseCSV('a,"b,""c"""\n1,2\n'), [['a', 'b,"c"'], ['1', '2']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('parses Jancy-style profile CSVs', () => {
  const { profiles, errors } = parseProfilesCSV(CSV);
  assert.equal(profiles.length, 2);
  const [alpha, bravo] = profiles;
  assert.equal(alpha.address1, '1 Main St, Apt 2');
  assert.equal(alpha.state, 'VA');
  assert.equal(alpha.phone, '8045550100');
  assert.equal(alpha.group, 'East');
  assert.equal(alpha.proxy.region, 'us');
  assert.deepEqual(alpha.cards.map((c) => [c.number, c.expMonth, c.expYear, c.cvv]), [
    ['4111111111111111', '03', '2028', '123'],
    ['5555555555554444', '', '', '999'],
  ]);
  assert.equal(bravo.cards.length, 0);
  assert.equal(bravo.proxy, null);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Line 4/);
  assert.match(errors[1], /duplicate/);
});

test('reports missing required columns', () => {
  assert.match(parseProfilesCSV('Name,Email\nA,b@c.d').errors[0], /Profile/);
});

test('public profiles never expose card numbers or CVVs', () => {
  const [alpha] = parseProfilesCSV(CSV).profiles;
  const shown = JSON.stringify(publicProfile(alpha));
  assert.ok(!shown.includes('4111111111111111') && !shown.includes('123"') && !shown.includes('"u"'));
  assert.equal(publicProfile(alpha).cards[0].last4, '1111');
  assert.equal(publicProfile(alpha).hasProxy, true);
});

test('searches and spreads profiles over tabs', () => {
  const { profiles } = parseProfilesCSV(CSV);
  assert.deepEqual(searchProfiles(profiles, 'west').map((p) => p.profile), ['Bravo']);
  assert.deepEqual(planAssignments(['t1', 't2', 't3'], ['a', 'b'], false), [['t1', 'a'], ['t2', 'b']]);
  assert.deepEqual(planAssignments(['t1', 't2', 't3'], ['a', 'b'], true), [['t1', 'a'], ['t2', 'b'], ['t3', 'a']]);
  assert.deepEqual(planAssignments(['t1'], [], true), []);
  assert.equal(normalizePhone('+1 (804) 555-0100'), '8045550100');
});
