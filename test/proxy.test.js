'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProxy, parseProxyList, fetchRemoteProxyList, validateConfig, createPool, normalizeConfig, proxyRule, proxyLabel, toURL } = require('../src/proxy');

test('parses the common proxy formats', () => {
  assert.deepEqual(parseProxy('1.2.3.4:8080'), { kind: 'http', host: '1.2.3.4', port: 8080, username: null, password: null, region: null });
  assert.deepEqual(parseProxy('host.com:3128:bob:s3cret'), { kind: 'http', host: 'host.com', port: 3128, username: 'bob', password: 's3cret', region: null });
  assert.deepEqual(parseProxy('bob:pa:ss@host.com:3128'), { kind: 'http', host: 'host.com', port: 3128, username: 'bob', password: 'pa:ss', region: null });
  assert.deepEqual(parseProxy('http://bob:pw@host.com:80'), { kind: 'http', host: 'host.com', port: 80, username: 'bob', password: 'pw', region: null });
  assert.deepEqual(parseProxy('socks5://10.0.0.1:1080'), { kind: 'socks5', host: '10.0.0.1', port: 1080, username: null, password: null, region: null });
  assert.equal(parseProxy('host.com:3128:bob:pa:ss').password, 'pa:ss');
});

test('rejects malformed lines', () => {
  for (const line of ['', '# comment', 'host.com', 'host.com:0', 'host.com:70000', ':8080', 'host:port', 'a:b:c']) {
    assert.equal(parseProxy(line), null, line);
  }
  assert.equal(parseProxyList('a.com:1\r\n\nbad\nb.com:2').length, 2);
});

test('validates launch configs', () => {
  assert.equal(validateConfig(normalizeConfig()), null);
  assert.match(validateConfig(normalizeConfig({ startURL: '  ' })), /start address/);
  assert.match(validateConfig(normalizeConfig({ proxySource: 'list', proxyList: 'nope' })), /at least one proxy/);
  assert.match(validateConfig(normalizeConfig({ proxySource: 'list', proxyList: 'socks5://u:p@h.com:1080' })), /SOCKS5/);
  assert.match(validateConfig(normalizeConfig({ proxySource: 'rotating' })), /gateway host/);
  assert.match(
    validateConfig(normalizeConfig({ proxySource: 'rotating', rotating: { host: 'g.com', usernameTemplate: 'fixed' } })),
    /\{session\}/,
  );
  assert.equal(normalizeConfig({ tabCount: 500 }).tabCount, 50);
  assert.equal(normalizeConfig({ tabCount: 'x' }).tabCount, 1);
  assert.equal(normalizeConfig({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeConfig({ theme: 'invalid' }).theme, 'system');
  assert.match(validateConfig(normalizeConfig({ proxySource: 'remote' })), /proxy-list URL/);
  assert.equal(validateConfig(normalizeConfig({ proxySource: 'remote', remote: { url: 'https://proxies.example/list' } })), null);
});

test('downloads a remote proxy list with optional bearer authentication', async () => {
  let request;
  const text = await fetchRemoteProxyList(
    { url: 'https://proxies.example/list', token: 'secret' },
    async (url, options) => {
      request = { url, options };
      return { ok: true, text: async () => 'us proxy.example:3128:user:pass' };
    },
  );
  assert.equal(text, 'us proxy.example:3128:user:pass');
  assert.equal(request.url.href, 'https://proxies.example/list');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  await assert.rejects(
    fetchRemoteProxyList({ url: 'https://proxies.example/list' }, async () => ({ ok: true, text: async () => 'invalid' })),
    /no valid proxies/,
  );
});

test('list pool hands out proxies round-robin', () => {
  const pool = createPool(normalizeConfig({ proxySource: 'list', proxyList: 'a.com:1\nb.com:2' }));
  assert.equal(pool.enabled, true);
  assert.deepEqual([pool.next(), pool.next(), pool.next()].map((p) => p.host), ['a.com', 'b.com', 'a.com']);
});

test('rotating pool draws a new session id each time', () => {
  const pool = createPool(normalizeConfig({
    proxySource: 'rotating',
    rotating: { host: ' gate.example.com ', port: 7000, usernameTemplate: 'cust-{session}-cc-us', password: 'pw', region: null },
  }));
  const first = pool.next();
  const second = pool.next();
  assert.match(first.username, /^cust-[0-9a-f]{10}-cc-us$/);
  assert.notEqual(first.username, second.username);
  assert.equal(first.host, 'gate.example.com');
  assert.equal(proxyRule(first), 'http://gate.example.com:7000');
});

test('direct pool is disabled', () => {
  const pool = createPool(normalizeConfig());
  assert.equal(pool.enabled, false);
  assert.equal(pool.next(), null);
});

test('labels never include the password', () => {
  assert.equal(proxyLabel(parseProxy('h.com:1:bob:secret')), 'h.com:1 · bob');
  assert.equal(proxyRule(parseProxy('socks5://h.com:1080')), 'socks5://h.com:1080');
});

test('turns address-bar input into URLs', () => {
  assert.equal(toURL('example.com/path'), 'https://example.com/path');
  assert.equal(toURL('http://x.com'), 'http://x.com');
  assert.equal(toURL('localhost:3000'), 'http://localhost:3000');
  assert.equal(toURL('concert tickets'), 'https://www.google.com/search?q=concert%20tickets');
  assert.equal(toURL(''), null);
});

test('region tags on list entries pick proxies per region', () => {
  assert.equal(parseProxy('US host.com:1:u:p').region, 'us');
  const pool = createPool(normalizeConfig({ proxySource: 'list', proxyList: 'us a.com:1\nca b.com:2\nus c.com:3\nd.com:4' }));
  assert.deepEqual(pool.regions, ['us', 'ca']);
  assert.deepEqual([pool.next('us'), pool.next('us'), pool.next('us')].map((p) => p.host), ['a.com', 'c.com', 'a.com']);
  assert.equal(pool.next('ca').host, 'b.com');
  assert.equal(pool.next('gb'), null);
});

test('rotating pool fills {country} from the chosen region', () => {
  const config = normalizeConfig({
    proxySource: 'rotating',
    rotating: { host: 'g.com', port: 1, usernameTemplate: 'c-{country}-s-{session}', regions: 'us, CA' },
  });
  const pool = createPool(config);
  assert.deepEqual(pool.regions, ['us', 'ca']);
  assert.match(pool.next().username, /^c-us-s-/);
  assert.match(pool.next('ca').username, /^c-ca-s-/);
  assert.equal(pool.next('ca').region, 'ca');
  assert.match(proxyLabel(pool.next('ca')), /^CA · g\.com:1 · c-ca-s-/);
  assert.match(validateConfig({ ...config, rotating: { ...config.rotating, regions: '' } }), /region code/);
  assert.deepEqual(createPool(normalizeConfig({ proxySource: 'rotating', rotating: { host: 'g.com' } })).regions, []);
});
