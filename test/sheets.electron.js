'use strict';

// Google Sheets import end-to-end check, run by test/run-electron-tests.js.
// A local HTTP server pretends to be the Google Sheets host; TabFleet opens the sheet in a tab
// and reads its CSV export via that tab's own session — no OAuth, no tokens.

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabfleet-sheets-'));
const outDir = process.env.E2E_OUT ?? userData;
app.setPath('userData', userData);

const SHEET_ID = 'test-sheet-id-abc-123-xyz-0123456789';
const SHEET_CSV = [
  'Profile,Name,Email,Password,Phone Number,Card Number,CVV',
  'Alpha,Ann Lee,ann@sheet.test,sheet-password,804-555-0100,4111111111111111,123',
  'Bravo,Bob Ray,bob@sheet.test,another-pass,518-555-0101,,',
].join('\n');

// Pretend to be docs.google.com. One route serves the sheet page, another serves the CSV export.
const sheetHost = http.createServer((req, res) => {
  if (req.url === `/spreadsheets/d/${SHEET_ID}/edit` || req.url.startsWith(`/spreadsheets/d/${SHEET_ID}/edit#`)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Sheet mock</title><p>Signed in</p>');
    return;
  }
  const exportMatch = /^\/spreadsheets\/d\/([^/]+)\/export\?format=csv/.exec(req.url);
  if (exportMatch && exportMatch[1] === SHEET_ID) {
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end(SHEET_CSV);
    return;
  }
  res.writeHead(404);
  res.end();
});

async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

sheetHost.listen(0, '127.0.0.1', () => {
  const { port } = sheetHost.address();
  process.env.TABFLEET_SHEETS_BASE = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    startURL: 'about:blank', tabCount: 1, isolation: 'perTab', proxySource: 'none',
  }));
  require('../src/main.js');
});

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => ui(`document.querySelector('#browser') && !document.querySelector('#browser').hidden`), 'browser mode');

    // Open the Google Sheets import form from the Tools panel.
    await ui(`document.querySelector('#panel-toggle').click()`);
    await ui(`document.querySelector('#profile-sheet').click()`);
    await waitFor(() => ui(`!document.querySelector('#sheet-import').hidden`), 'sheet form visible');

    // Submit the sheet URL; the mock host receives it and the sheet tab opens.
    const sheetUrl = `${process.env.TABFLEET_SHEETS_BASE}/spreadsheets/d/${SHEET_ID}/edit`;
    await ui(`(() => {
      const form = document.querySelector('#sheet-import');
      form.elements.url.value = ${JSON.stringify(sheetUrl)};
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);
    await waitFor(() => ui(`[...document.querySelectorAll('.tab')].some((el) => el.title.includes('/spreadsheets/d/${SHEET_ID}/'))`), 'sheet tab opened');

    // Click "Import this sheet" and verify profiles were added.
    await ui(`document.querySelector('#sheet-import-run').click()`);
    const imported = await waitFor(async () => {
      const list = await ui('window.fleet.listProfiles()');
      return list.length >= 2 && list;
    }, 'profiles imported from sheet');

    const alpha = imported.find((p) => p.profile === 'Alpha');
    const bravo = imported.find((p) => p.profile === 'Bravo');
    assert.equal(alpha.email, 'ann@sheet.test');
    assert.equal(alpha.phone, '8045550100');
    assert.equal(alpha.hasPassword, true, 'the sheet password is saved');
    assert.deepEqual(alpha.cards.map((c) => c.last4), ['1111']);
    assert.equal(bravo.email, 'bob@sheet.test');
    assert.equal(bravo.hasPassword, true);
    assert.ok(!JSON.stringify(imported).includes('sheet-password'), 'the window never receives the password');

    const storedProfiles = fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8');
    assert.ok(!storedProfiles.includes('sheet-password') && !storedProfiles.includes('4111'), 'imported profiles are encrypted on disk');

    fs.writeFileSync(path.join(outDir, 'sheet-import.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, imported: imported.map((p) => p.profile) }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    app.exit(1);
  }
});
