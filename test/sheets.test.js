'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSheetURL, csvExportURL, viewURL, isSheetsURL } = require('../src/sheets');

test('parses sheet URLs, edit links and bare ids', () => {
  const edit = parseSheetURL('https://docs.google.com/spreadsheets/d/1aB-cD_3xYz_zzzzzzzzzzzzzzzzzzzzzzzz/edit#gid=42');
  assert.deepEqual(edit, { id: '1aB-cD_3xYz_zzzzzzzzzzzzzzzzzzzzzzzz', gid: 42 });
  assert.deepEqual(parseSheetURL('https://docs.google.com/spreadsheets/d/abc_DEF-123xyzxyzxyzxyzxyz/view'), { id: 'abc_DEF-123xyzxyzxyzxyzxyz', gid: null });
  assert.deepEqual(parseSheetURL('1aB_cDefGhiJklMnoPqrsTuvWxYz0'), { id: '1aB_cDefGhiJklMnoPqrsTuvWxYz0', gid: null });
  assert.equal(parseSheetURL(''), null);
  assert.equal(parseSheetURL('https://example.com/'), null);
  assert.equal(parseSheetURL('short'), null);
});

test('builds the CSV export URL', () => {
  const { SHEETS_BASE } = require('../src/sheets');
  assert.equal(csvExportURL({ id: 'abc', gid: 7 }), `${SHEETS_BASE}/spreadsheets/d/abc/export?format=csv&gid=7`);
  assert.equal(csvExportURL({ id: 'abc', gid: null }), `${SHEETS_BASE}/spreadsheets/d/abc/export?format=csv`);
});

test('builds a view URL for the sheet', () => {
  const { SHEETS_BASE } = require('../src/sheets');
  assert.equal(viewURL({ id: 'abc', gid: 7 }), `${SHEETS_BASE}/spreadsheets/d/abc/edit#gid=7`);
  assert.equal(viewURL({ id: 'abc', gid: null }), `${SHEETS_BASE}/spreadsheets/d/abc/edit`);
});

test('recognizes Google Sheets URLs', () => {
  assert.equal(isSheetsURL('https://docs.google.com/spreadsheets/d/abc/edit'), true);
  assert.equal(isSheetsURL('https://docs.google.com/document/d/abc/edit'), false);
  assert.equal(isSheetsURL('https://example.com/'), false);
  assert.equal(isSheetsURL('not a url'), false);
});
