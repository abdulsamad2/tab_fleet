'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsZoneFor, majorityZone } = require('../src/clock');

test('US, Canadian and common zones map to their Windows timezone ids', () => {
  assert.equal(windowsZoneFor('America/New_York'), 'Eastern Standard Time');
  assert.equal(windowsZoneFor('America/Chicago'), 'Central Standard Time');
  assert.equal(windowsZoneFor('America/Denver'), 'Mountain Standard Time');
  assert.equal(windowsZoneFor('America/Phoenix'), 'US Mountain Standard Time');
  assert.equal(windowsZoneFor('America/Los_Angeles'), 'Pacific Standard Time');
  assert.equal(windowsZoneFor('America/Indiana/Indianapolis'), 'US Eastern Standard Time');
  assert.equal(windowsZoneFor('America/Toronto'), 'Eastern Standard Time');
  assert.equal(windowsZoneFor('Pacific/Honolulu'), 'Hawaiian Standard Time');
  assert.equal(windowsZoneFor('Europe/London'), 'GMT Standard Time');
  assert.equal(windowsZoneFor('Asia/Seoul'), 'Korea Standard Time');
  assert.equal(windowsZoneFor('Mars/Olympus'), null);
});

test('the clock follows where most proxies are; the first seen wins a tie', () => {
  assert.equal(majorityZone(['America/Chicago', 'America/New_York', 'America/Chicago', null]), 'America/Chicago');
  assert.equal(majorityZone(['America/Denver', 'America/Chicago']), 'America/Denver');
  assert.equal(majorityZone([null, null]), null);
  assert.equal(majorityZone([]), null);
});
