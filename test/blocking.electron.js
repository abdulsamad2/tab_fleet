'use strict';

// Ad & tracker blocking: a tracker host is never requested while blocking is on; turning it off in
// Settings lets it through on the tabs that are already open.
const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabfleet-block-'));
app.setPath('userData', userData);
const seen = [];
const server = http.createServer((req, res) => {
  seen.push(`${req.headers.host.split(':')[0]}${req.url}`);
  res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
  res.end('<title>page</title>ok');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // Point a tracker host and a normal host at the local server instead of the internet.
  app.commandLine.appendSwitch('host-resolver-rules', `MAP www.googletagmanager.com 127.0.0.1:${port}, MAP tickets.example 127.0.0.1:${port}`);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ startURL: `http://tickets.example/`, tabCount: 1, isolation: 'perTab', proxySource: 'none' }));
  process.env.SEATSCOUTS_COMPANY_ID = '';
  process.env.SEATSCOUTS_API_TOKEN = '';
  require('../src/main.js');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    await sleep(200);
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    const page = await waitFor(() => webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http://tickets.example') && !wc.isLoading()), 'page');
    const fetchFrom = (url) => page.executeJavaScript(`fetch(${JSON.stringify(url)}, { mode: 'no-cors' }).then(() => 'ok', () => 'failed')`);

    assert.equal(await fetchFrom('http://www.googletagmanager.com/gtm.js'), 'failed', 'tracker request is blocked');
    assert.equal(await fetchFrom('http://tickets.example/api'), 'ok');
    await sleep(200);
    assert.ok(!seen.some((s) => s.startsWith('www.googletagmanager.com')), 'blocked request never left the browser');
    assert.ok(seen.includes('tickets.example/api'));
    const settings = await ui('window.fleet.getUpdateInfo()');
    assert.equal(settings.settings.blockTrackers, true, 'on by default');
    assert.ok(settings.blockedRequests >= 1, 'blocked requests are counted');

    // Off in Settings: the same open tab now reaches the tracker host.
    await ui(`window.fleet.saveSettings({ blockTrackers: false })`);
    assert.equal(await fetchFrom('http://www.googletagmanager.com/gtm.js'), 'ok');
    assert.ok(seen.includes('www.googletagmanager.com/gtm.js'), 'unblocked request goes through');
    console.log(JSON.stringify({ ok: true }));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, seen }));
    app.exit(1);
  }
});
