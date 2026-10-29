'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, parseProfilesCSV, buildProfile, publicProfile, searchProfiles, planAssignments, normalizePhone, chooseShownCard, normalizeCard, decodeTextFile, normalizeState, normalizeZip, withoutSecrets, buildAutofillScript } = require('../src/profiles');

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
  assert.ok(!shown.includes('4111111111111111') && !shown.includes('123"'));
  assert.equal(publicProfile(alpha).cards[0].last4, '1111');
  assert.equal(publicProfile(alpha).hasProxy, true);
  // Host/port/username are shown in the panel (the username was already in proxyLabel); the password never is.
  assert.deepEqual(publicProfile(alpha).proxyParts, { host: 'p.example', port: 8000, username: 'u', hasPassword: true });
  assert.ok(!shown.includes('"p"'));
});

test('searches and spreads profiles over tabs', () => {
  const { profiles } = parseProfilesCSV(CSV);
  assert.deepEqual(searchProfiles(profiles, 'west').map((p) => p.profile), ['Bravo']);
  assert.deepEqual(planAssignments(['t1', 't2', 't3'], ['a', 'b'], false), [['t1', 'a'], ['t2', 'b']]);
  assert.deepEqual(planAssignments(['t1', 't2', 't3'], ['a', 'b'], true), [['t1', 'a'], ['t2', 'b'], ['t3', 'a']]);
  assert.deepEqual(planAssignments(['t1'], [], true), []);
  assert.equal(normalizePhone('+1 (804) 555-0100'), '8045550100');
});

test('imports a login password column', () => {
  const { profiles } = parseProfilesCSV('Profile,Name,Email,Password\nAlpha,Ann Lee,ann@example.com,hunter2');
  assert.equal(profiles[0].password, 'hunter2');
});

test('builds a profile from the editor and validates it', () => {
  const { profile, errors } = buildProfile({
    profile: ' Alpha ', name: 'Ann Lee', email: 'ann@example.com', password: 'hunter2', state: 'va', phone: '(804) 555-0100',
    proxy: 'p.example:8000:u:p',
    newCards: [{ number: '4111 1111 1111 1111', expMonth: '3', expYear: '28', cvv: '123' }],
  });
  assert.deepEqual(errors, []);
  assert.equal(profile.profile, 'Alpha');
  assert.equal(profile.state, 'VA');
  assert.equal(profile.phone, '8045550100');
  assert.equal(profile.proxy.host, 'p.example');
  assert.deepEqual(profile.cards, [{ number: '4111111111111111', last4: '1111', name: 'Ann Lee', expMonth: '03', expYear: '2028', cvv: '123' }]);

  const bad = buildProfile({ profile: '', name: '', email: 'nope', proxy: 'bad', newCards: [{ number: '123', cvv: '1' }] });
  assert.equal(bad.errors.length, 5);
  assert.match(buildProfile({ profile: 'A', name: 'A', email: 'a@b.co', newCards: [{ number: '4111111111111111', cvv: '123', expMonth: '13' }] }).errors[0], /month/);
});

test('editing keeps saved secrets unless they are replaced or removed', () => {
  const { profile: saved } = buildProfile({
    profile: 'Alpha', name: 'Ann Lee', email: 'ann@example.com', password: 'hunter2', proxy: 'p.example:8000',
    newCards: [{ number: '4111111111111111', cvv: '123' }, { number: '5555555555554444', cvv: '999' }],
  });
  const kept = buildProfile({ profile: 'Alpha', name: 'Ann Lee', email: 'ann@example.com', password: '', keepCards: [0, 1] }, saved).profile;
  assert.equal(kept.id, saved.id);
  assert.equal(kept.password, 'hunter2');
  assert.equal(kept.proxy.host, 'p.example');
  assert.equal(kept.cards.length, 2);

  const changed = buildProfile({
    profile: 'Alpha', name: 'Ann Lee', email: 'ann@example.com', password: 'new-pass', clearProxy: true, keepCards: [1],
  }, saved).profile;
  assert.equal(changed.password, 'new-pass');
  assert.equal(changed.proxy, null);
  assert.deepEqual(changed.cards.map((c) => c.number), ['5555555555554444']);
  assert.equal(buildProfile({ profile: 'Alpha', name: 'A', email: 'a@b.co', clearPassword: true }, saved).profile.password, '');
});

test('the window never receives passwords or proxy credentials', () => {
  const { profile } = buildProfile({ profile: 'Alpha', name: 'Ann Lee', email: 'ann@example.com', password: 'hunter2', proxy: 'p.example:8000:puser:ppass' });
  const shown = publicProfile(profile);
  assert.equal(shown.hasPassword, true);
  assert.equal(shown.password, undefined);
  assert.ok(!JSON.stringify(shown).includes('hunter2') && !JSON.stringify(shown).includes('ppass'));
  assert.equal(shown.proxyLabel, 'p.example:8000 · puser');
});

test('picks the profile card a page is showing', () => {
  const cards = [{ number: '4111111111111111' }, { number: '5555555555554444' }];
  assert.equal(chooseShownCard({ all: ['4444'], selected: [] }, cards), '4444');
  assert.equal(chooseShownCard({ all: ['1111', '4444'], selected: ['4444'] }, cards), '4444', 'the selected card wins');
  assert.equal(chooseShownCard({ all: ['1111', '4444'], selected: [] }, cards), '', 'ambiguous: no hint');
  assert.equal(chooseShownCard({ all: ['0005', '1111'], selected: [] }, cards), '1111', 'cards not on the profile are ignored');
  assert.equal(chooseShownCard({ all: [], selected: [] }, cards), '');
});

test('imports saved cards kept as "****1234" + CVV in Passcode columns (Jancy sheets)', () => {
  const csv = [
    'Profile,Name,Email,CC Number:Test 1,CC CVV:Test 1,Proxy,Passcode CC,Passcode2,Passcode3',
    'OS 1.1,Ann Lee,ann@example.com,,,,****4444,12,',
    'OS 1.2,Bob Ray,bob@example.com,,,,,,',
    ',,,,,,1.2.3.4:80,,',
  ].join('\n');
  const { profiles, errors, ignored } = parseProfilesCSV(csv);
  assert.deepEqual(errors, [], 'spare-proxy rows are skipped quietly');
  assert.deepEqual(ignored, []);
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles[0].cards.map((c) => [c.number, c.last4, c.cvv]), [['', '4444', '012']], 'Excel-stripped leading zero restored');
  const shown = publicProfile(profiles[0]).cards[0];
  assert.deepEqual([shown.last4, shown.hasNumber, shown.hasCvv], ['4444', false, true]);
  assert.ok(!JSON.stringify(publicProfile(profiles[0])).includes('012'), 'the CVV never reaches the window');
  assert.equal(profiles[1].cards.length, 0);
});

test('card CSV columns: more header names, combined expiry, optional CVV', () => {
  const { profiles } = parseProfilesCSV('Profile,Name,Email,CC Number,Exp Date,CVV2\nA,Ann Lee,a@example.com,4111 1111 1111 1111,3/28,321');
  assert.deepEqual(profiles[0].cards.map((c) => [c.last4, c.expMonth, c.expYear, c.cvv]), [['1111', '03', '2028', '321']]);
  assert.equal(normalizeCard({ number: '4111111111111111' }).card.cvv, '', 'a card without a CVV is kept');
  assert.equal(normalizeCard({ number: '378282246310005', cvv: '12' }).card.cvv, '0012', 'Amex CVVs are 4 digits');
  assert.equal(normalizeCard({ number: 'xxxx-xxxx-xxxx-1881', cvv: '7' }).card.last4, '1881');
});

test('Jancy sheet with Passcode CC + separate EXP and CVV columns imports the CVV', () => {
  const csv = 'Profile,Name,Email,CC Number:Test 1,CC CVV:Test 1,Passcode CC,EXP,CVV,SMS Number\nOS 1.1,Gale Post,g@example.com,,,****6815,01/30,412,8045550100';
  const { profiles, errors, ignored } = parseProfilesCSV(csv);
  assert.deepEqual(errors, []);
  assert.deepEqual(ignored, []);
  assert.deepEqual(profiles[0].cards.map((c) => [c.last4, c.expMonth, c.expYear, c.cvv]), [['6815', '01', '2030', '412']]);
});

test('CSV files as Windows Excel saves them', () => {
  const csv = 'Profile,Name,Email,Passcode CC,EXP,CVV\r\nA,Ann Lee,a@example.com,****4444,28-Mar,="012"\r\n';
  const check = (text, label) => {
    const { profiles } = parseProfilesCSV(text);
    assert.deepEqual(profiles[0]?.cards.map((c) => [c.last4, c.expMonth, c.expYear, c.cvv]), [['4444', '03', '2028', '012']], label);
  };
  check(csv, 'Excel date expiry + ="012" text cell');
  check(decodeTextFile(Buffer.from(`\uFEFF${csv}`, 'utf8')), 'UTF-8 with BOM');
  check(decodeTextFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv.replace(/,/g, '\t'), 'utf16le')])), 'UTF-16 "Unicode Text"');
  check(decodeTextFile(Buffer.from(csv.replace(/,/g, ';'), 'latin1')), 'semicolons (European Excel)');
  assert.equal(decodeTextFile(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café', 'Windows-1252 text falls back to Latin-1');
  assert.match(normalizeCard({ number: '4.11111E+15', cvv: '123' }).error, /scientific notation/);
});

test('states are stored as 2-letter codes and ZIPs keep their leading zeros', () => {
  assert.equal(normalizeState('virginia'), 'VA');
  assert.equal(normalizeState('Va.'), 'VA');
  assert.equal(normalizeState('ma'), 'MA');
  assert.equal(normalizeState('Ontario', 'Canada'), 'ON');
  assert.equal(normalizeState('Bavaria', 'DE'), 'Bavaria', 'unknown regions are kept as typed');
  assert.equal(normalizeZip('2134'), '02134');
  assert.equal(normalizeZip('501', 'US'), '00501');
  assert.equal(normalizeZip('2134-1234'), '02134-1234');
  assert.equal(normalizeZip('2134', 'Australia'), '2134', 'only US ZIPs are padded');
  assert.equal(normalizeZip('K1A 0B1', 'CA'), 'K1A 0B1');
  const { profiles } = parseProfilesCSV('Profile,Name,Email,State,Zip Code\nA,Ann Lee,a@example.com,Massachusetts,2134');
  assert.deepEqual([profiles[0].state, profiles[0].zip], ['MA', '02134']);
});

test('rows without a Group get the sheet\'s name as their group', () => {
  const csv = 'Group,Profile,Name,Email\n,OS 1.1,Ann Lee,a@example.com\nNX SLOT 1,OS 1.2,Bob Ray,b@example.com';
  const { profiles } = parseProfilesCSV(csv, { defaultGroup: 'WiLL' });
  assert.deepEqual(profiles.map((p) => p.group), ['WiLL', 'NX SLOT 1']);
  assert.equal(parseProfilesCSV(csv).profiles[0].group, '', 'no default: empty');
});

test('the window never gets proxy passwords, backup proxies, pins or passcodes', () => {
  const { profiles } = parseProfilesCSV('Profile,Name,Email,Proxy,Proxy 2,Passcode,Passcode2\nA,Ann Lee,a@example.com,h:1:u:pw-main,h:2:u2:pw-backup,4111,987');
  const profile = { ...profiles[0], pinnedProxy: { proxy: { host: 'g', port: 3, username: 'x', password: 'pw-pinned' } } };
  const shown = JSON.stringify(publicProfile(profile));
  for (const secret of ['pw-main', 'pw-backup', 'pw-pinned', '987']) assert.ok(!shown.includes(secret), secret);
  assert.equal(publicProfile(profile).backupProxyCount, 1);
  assert.equal(publicProfile(profile).hasPinnedProxy, true);
});

test('withoutSecrets keeps an unencrypted save free of cards, passwords and proxy passwords', () => {
  const { profiles: [alpha] } = parseProfilesCSV(CSV);
  const full = {
    ...alpha, password: 'S3cret', passwordUrl: 'https://otp.example/?key=k', passwordAuth: 'Bearer a', otpUrl: 'https://otp.example/?k=1',
    otpAuth: 'Bearer b', textChestKey: 'tc-key', passcode: '123', passcodes: ['999'],
    extraProxies: [{ host: 'b.example', port: 9000, username: 'bu', password: 'bp' }],
    pinnedProxy: { host: 'pool.example', port: 8000, username: 'pu', password: 'pool-pw' },
  };
  const bare = withoutSecrets(full);
  const text = JSON.stringify(bare);
  for (const secret of ['4111111111111111', '123', 'S3cret', 'Bearer', 'tc-key', '999', '"bp"', 'otp.example']) {
    assert.ok(!text.includes(secret), `${secret} is not written`);
  }
  assert.deepEqual([bare.proxy.host, bare.proxy.port, bare.proxy.username, bare.proxy.password], ['p.example', 8000, 'u', null]);
  assert.equal(bare.extraProxies[0].host, 'b.example');
  assert.equal(bare.pinnedProxy.password, 'pool-pw', 'the pinned pool proxy keeps the pool login');
  assert.equal(bare.email, 'ann@example.com');
  assert.equal(full.cards.length, 2, 'the profile in memory is untouched');
});

test('a sheet row with only a CVV keeps it as the account saved card; expiry and last 4 when given', () => {
  const csv = [
    'Group,Profile,Name,Email,CC Number:Test 1,CC Exp Date:Test 1,CC CVV:Test 1,Passcode CC,EXP,CVV',
    'NX,Alpha,Nia Xu,nia@x.test,,,,,,456',
    'NX,Bravo,Bo Lee,bo@x.test,,,,****1926,01/30,789',
    'NX,Charlie,Cy Ray,cy@x.test,,,,,,',
    'NX,Delta,Di Fox,di@x.test,,,,,,12345',
  ].join('\n');
  const { profiles, errors } = parseProfilesCSV(csv);
  const cards = Object.fromEntries(profiles.map((p) => [p.profile, p.cards.map((c) => [c.last4, c.expMonth, c.expYear, c.cvv])]));
  assert.deepEqual(cards, {
    Alpha: [['', '', '', '456']], Bravo: [['1926', '01', '2030', '789']], Charlie: [], Delta: [],
  });
  assert.match(errors.join(' '), /Line 5: CVV must be 3 or 4 digits\. The CVV was skipped\./);
  // At checkout the CVV-only card's CVV goes to the saved card's CVV box.
  const script = buildAutofillScript(profiles[0], profiles[0].cards[0]);
  const values = JSON.parse(script.slice(script.lastIndexOf(')({') + 2, -1));
  assert.equal(values.ccCsc, '456');
  assert.deepEqual(values.cvvByLast4, {});
  assert.equal(values.cardHasNumber, false, 'never typed into a new-card form');
  assert.deepEqual(publicProfile(profiles[0]).cards, [{ last4: '', expMonth: '', expYear: '', name: 'Nia Xu', hasNumber: false, hasCvv: true }]);
});

test('resolver typos are fixed and summarised without echoing the API key', () => {
  const csv = ['Profile,Name,Email,Site:Ticketmaster', 'A,Ann Lee,a@x.test,smscode=textchestABCDEF0123456789:tm', 'B,Bo Lee,b@x.test,smscode=textchestABCDEF0123456789:tm'].join('\n');
  const { profiles, errors } = parseProfilesCSV(csv);
  assert.deepEqual(profiles[0].resolvers[0].entries, [{ field: 'smscode', resolver: 'textchest', args: ['ABCDEF0123456789', 'tm'] }]);
  assert.deepEqual(errors, ['Fixed automatically: 2 "textchest" resolvers were missing the colon after "textchest" (textchest:KEY).']);
});
