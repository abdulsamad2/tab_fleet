'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSheetURL, csvExportURL, viewURL, isSheetsURL } = require('../src/sheets');

test('parses sheet URLs, edit links and bare ids', () => {
  const edit = parseSheetURL('https://docs.google.com/spreadsheets/d/1aB-cD_3xYz_zzzzzzzzzzzzzzzzzzzzzzzz/edit#gid=42');
  assert.deepEqual(edit, { id: '1aB-cD_3xYz_zzzzzzzzzzzzzzzzzzzzzzzz', gid: 42, published: false });
  assert.deepEqual(parseSheetURL('https://docs.google.com/spreadsheets/d/abc_DEF-123xyzxyzxyzxyzxyz/view'), { id: 'abc_DEF-123xyzxyzxyzxyzxyz', gid: null, published: false });
  assert.deepEqual(parseSheetURL('1aB_cDefGhiJklMnoPqrsTuvWxYz0'), { id: '1aB_cDefGhiJklMnoPqrsTuvWxYz0', gid: null, published: false });
  assert.equal(parseSheetURL(''), null);
  assert.equal(parseSheetURL('https://example.com/'), null);
  assert.equal(parseSheetURL('short'), null);
});

test('parses "Publish to the web" URLs', () => {
  const pub = parseSheetURL('https://docs.google.com/spreadsheets/d/e/2PACX-1vQmtn_J06qyG7ZApIKiWhVB8Wt61S3ZiyM9DMFaonc6MKM-VD8Kai7v9_AV1RYkG8JSugqUGi5NLT8a/pubhtml');
  assert.deepEqual(pub, { id: '2PACX-1vQmtn_J06qyG7ZApIKiWhVB8Wt61S3ZiyM9DMFaonc6MKM-VD8Kai7v9_AV1RYkG8JSugqUGi5NLT8a', gid: null, published: true });
  const pubWithGid = parseSheetURL('https://docs.google.com/spreadsheets/d/e/2PACX-PUBID/pubhtml?gid=12345&single=true');
  assert.deepEqual(pubWithGid, { id: '2PACX-PUBID', gid: 12345, published: true });
});

test('builds the CSV export URL', () => {
  const { SHEETS_BASE } = require('../src/sheets');
  assert.equal(csvExportURL({ id: 'abc', gid: 7, published: false }), `${SHEETS_BASE}/spreadsheets/d/abc/export?format=csv&gid=7`);
  assert.equal(csvExportURL({ id: 'abc', gid: null, published: false }), `${SHEETS_BASE}/spreadsheets/d/abc/export?format=csv`);
  assert.equal(csvExportURL({ id: 'PUB', gid: null, published: true }), `${SHEETS_BASE}/spreadsheets/d/e/PUB/pub?output=csv`);
  assert.equal(csvExportURL({ id: 'PUB', gid: 9, published: true }), `${SHEETS_BASE}/spreadsheets/d/e/PUB/pub?output=csv&gid=9&single=true`);
});

test('builds a view URL for the sheet', () => {
  const { SHEETS_BASE } = require('../src/sheets');
  assert.equal(viewURL({ id: 'abc', gid: 7, published: false }), `${SHEETS_BASE}/spreadsheets/d/abc/edit#gid=7`);
  assert.equal(viewURL({ id: 'abc', gid: null, published: false }), `${SHEETS_BASE}/spreadsheets/d/abc/edit`);
  assert.equal(viewURL({ id: 'PUB', gid: null, published: true }), `${SHEETS_BASE}/spreadsheets/d/e/PUB/pubhtml`);
  assert.equal(viewURL({ id: 'PUB', gid: 9, published: true }), `${SHEETS_BASE}/spreadsheets/d/e/PUB/pubhtml?gid=9&single=true`);
});

test('recognizes Google Sheets URLs', () => {
  assert.equal(isSheetsURL('https://docs.google.com/spreadsheets/d/abc/edit'), true);
  assert.equal(isSheetsURL('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml'), true);
  assert.equal(isSheetsURL('https://docs.google.com/document/d/abc/edit'), false);
  assert.equal(isSheetsURL('https://example.com/'), false);
  assert.equal(isSheetsURL('not a url'), false);
});
