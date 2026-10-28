'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ordersURL, fetchOrders, eventSearchURL, eventSearchNote } = require('../src/sync');

test('builds the Get Orders URL from UI filters', () => {
  const url = ordersURL({ page: 3, limit: 500, status: 'delivered,bogus', marketplace: 'viagogo', search: 'Lakers', dateFrom: '2026-01-01', dateTo: 'nope', orderBy: 'occurs_at', direction: 'asc' });
  assert.equal(url.origin + url.pathname, 'https://app.seatscouts.com/sync/api/orders');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    limit: '100', page: '3', status: 'delivered', marketplace: 'viagogo', event_name: 'Lakers',
    order_date_from: '2026-01-01', order_by: 'occurs_at', order_by_direction: 'asc',
  });
  assert.equal(ordersURL({ search: '123456789' }).searchParams.get('order_id'), '123456789', 'a number searches order #');
  assert.equal(ordersURL({}).searchParams.get('limit'), '50');
});

test('fetches orders with Sync headers and reports failures without leaking the token', async () => {
  let seen;
  const ok = async (url, options) => {
    seen = { url, headers: options.headers };
    return { ok: true, status: 200, text: async () => JSON.stringify({ count: 2230, page: 1, data: [{ id: 1, order_id: '555' }] }) };
  };
  const result = await fetchOrders(ok, { companyId: '42', apiToken: 'tok' }, { limit: 1 });
  assert.deepEqual(result, { count: 2230, page: 1, limit: 1, orders: [{ id: 1, order_id: '555' }] });
  assert.equal(seen.headers['X-Company-Id'], '42');
  assert.equal(seen.headers['X-Api-Token'], 'tok');

  const denied = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad token tok"}' });
  const failure = await fetchOrders(denied, { companyId: '42', apiToken: 'tok' });
  assert.match(failure.error, /rejected the Company ID or API token/);
  assert.ok(!failure.error.includes('tok"'));

  assert.equal((await fetchOrders(ok, null)).needsSetup, true);
  const offline = async () => { throw new Error('getaddrinfo ENOTFOUND\nstack'); };
  assert.equal((await fetchOrders(offline, { companyId: '1', apiToken: 't' })).error, "Couldn't reach Automatiq: getaddrinfo ENOTFOUND");
});

test('event search goes to Ticketmaster with the event date', () => {
  const event = {
    eventName: 'Lakers vs Celtics', venueName: 'Crypto.com Arena', city: 'Los Angeles', occursAt: '2026-12-01T19:30:00',
    section: '112', row: 'F', quantity: 2, orderId: '700000001', marketplace: 'viagogo',
  };
  assert.equal(eventSearchURL(event), 'https://www.ticketmaster.com/search?q=Lakers+vs+Celtics&startDate=2026-12-01&endDate=2026-12-01');
  assert.equal(eventSearchURL({ eventName: 'Bad Bunny' }), 'https://www.ticketmaster.com/search?q=Bad+Bunny');
  assert.equal(eventSearchURL({ eventName: '  ' }), null);
  assert.equal(eventSearchNote(event), 'Lakers vs Celtics\nVenue: Crypto.com Arena, Los Angeles\nDate: 2026-12-01 7:30 PM\nSec 112 · Row F · Qty 2\nOrder #700000001 (viagogo)');
  assert.equal(ordersURL({ status: 'invoiced' }).searchParams.get('status'), 'invoiced');
});
