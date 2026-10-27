'use strict';

// End-to-end check: run with `npx electron test/e2e.electron.js` (unset ELECTRON_RUN_AS_NODE first).
// Launches TabFleet against a local authenticating proxy, drives the real UI, and checks per-tab
// sessions, Burn IP (new IP + fresh cookies), regions, Switch To Proxy, colors, notes, timers and quick fill.

const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabfleet-e2e-'));
const outDir = process.env.E2E_OUT ?? userData;
app.setPath('userData', userData);

/** Every authenticated request the proxy served: which session username, and which visitor cookie it carried. */
const requests = [];
const proxy = http.createServer((req, res) => {
  const auth = req.headers['proxy-authorization'];
  if (!auth) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="e2e"' });
    res.end();
    return;
  }
  const [user, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (password !== 'pw') {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.url.endsWith('/favicon.ico')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const cookie = /visitor=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
  requests.push({ user, cookie });
  res.writeHead(200, {
    'content-type': 'text/html',
    ...(cookie ? {} : { 'set-cookie': `visitor=${crypto.randomUUID().slice(0, 8)}; Path=/` }),
  });
  res.end(`<title>${user}</title><input id="field" autofocus>`);
});

const users = () => new Set(requests.map((r) => r.user));

async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

proxy.listen(0, '127.0.0.1', () => {
  const { port } = proxy.address();
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    startURL: 'http://fleet-e2e.example/',
    tabCount: 2,
    isolation: 'perTab',
    proxySource: 'rotating',
    rotating: { host: '127.0.0.1', port, usernameTemplate: 'u-{country}-{session}', password: 'pw', regions: 'us, ca' },
  }));
  require('../src/main.js');
});

app.whenReady().then(async () => {
  const results = {};
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    const state = () => ui(`(${() => ({
      tabs: [...document.querySelectorAll('.tab')].map((el) => ({
        title: el.querySelector('.title').textContent,
        color: el.style.getPropertyValue('--tab-color'),
        timer: el.querySelector('.timer').textContent,
        timerDone: el.classList.contains('timer-done'),
        hasNote: !el.querySelector('.note-dot').hidden,
      })),
      toggle: document.querySelector('#proxy-toggle').textContent,
      region: document.querySelector('#region').value,
    })})()`);
    const run = (name, arg) => ui(`window.fleet.command(${JSON.stringify(name)}, undefined, ${JSON.stringify(arg)})`);

    await waitFor(() => ui(`document.querySelector('[name="rotating.host"]').value === '127.0.0.1'`), 'saved config in form');
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);

    // Multiple sessions: each tab authenticates with its own US session.
    await waitFor(() => users().size >= 2, 'two tab sessions');
    assert.ok([...users()].every((u) => u.startsWith('u-us-')), 'tabs start in the first region');
    results.sessions = [...users()];

    // Burn IP: the reload carries the old cookie; the burn arrives on a new session with no cookie.
    const firstUser = (await state()).tabs[0].title;
    await run('reload');
    const withCookie = await waitFor(() => requests.find((r) => r.user === firstUser && r.cookie), 'reload with cookie');
    await ui(`document.querySelector('#toolbar [data-cmd="burn"]').click()`);
    const burned = await waitFor(() => requests.find((r) => !results.sessions.includes(r.user)), 'burned request');
    assert.equal(burned.cookie, null, 'burned tab starts with fresh cookies');
    results.burn = { before: withCookie, after: burned };

    // Regions: switching the tab to CA reloads through a CA session.
    await ui(`(() => { const s = document.querySelector('#region'); s.value = 'ca'; s.dispatchEvent(new Event('change')); })()`);
    results.region = (await waitFor(() => requests.find((r) => r.user.startsWith('u-ca-')), 'CA request')).user;
    await waitFor(async () => (await state()).region === 'ca', 'region select shows CA');

    // Switch To Proxy: off to the local IP and back, without reloading.
    const before = requests.length;
    await ui(`document.querySelector('#proxy-toggle').click()`);
    await waitFor(async () => (await state()).toggle.includes('Local IP'), 'toggle to local IP');
    await ui(`document.querySelector('#proxy-toggle').click()`);
    results.toggle = await waitFor(async () => {
      const { toggle } = await state();
      return toggle.includes('CA · 127.0.0.1') && toggle;
    }, 'toggle back to a CA proxy');
    assert.equal(requests.length, before, 'switching proxy does not reload the page');

    // Colors, notes, timers via the Tools panel.
    await ui(`document.querySelector('#panel-toggle').click()`);
    await ui(`document.querySelectorAll('#swatches .swatch')[5].click()`);
    await ui(`(() => { const n = document.querySelector('#note'); n.value = 'Section 104 row F'; n.dispatchEvent(new Event('input')); })()`);
    await run('setTimer', 0.02);
    const tabState = await waitFor(async () => {
      const tab = (await state()).tabs[0];
      return tab.color && tab.hasNote && tab.timerDone && tab;
    }, 'color, note and finished timer on tab 1').catch(async (error) => { console.error(JSON.stringify(await state()), JSON.stringify(requests.slice(-3))); throw error; });
    results.tab = tabState;

    // Quick fill: snippets round-trip encrypted, and Insert types into the page's focused field.
    await ui(`window.fleet.saveSnippets([{ id: 'e', label: 'Email', value: 'fan@example.com', secret: false }, { id: 'p', label: 'Card last 4', value: '4242', secret: true }])`);
    const saved = fs.readFileSync(path.join(userData, 'snippets.json'), 'utf8');
    assert.ok(!saved.includes('4242') && !saved.includes('fan@example.com'), 'snippet values are encrypted on disk');
    assert.deepEqual((await ui('window.fleet.getSnippets()')).map((s) => s.value), ['fan@example.com', '4242']);
    await run('insertText', 'fan@example.com');
    results.inserted = await waitFor(async () => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.getURL().includes('fleet-e2e')) continue;
        const value = await wc.executeJavaScript(`document.querySelector('#field')?.value`).catch(() => null);
        if (value) return value;
      }
      return null;
    }, 'inserted text in page');
    assert.equal(results.inserted, 'fan@example.com');

    await ui(`document.querySelector('#snippet-edit').click(); document.querySelector('#snippet-edit').click();`);
    await ui(`window.fleet.getSnippets().then((list) => { snippets = list; renderSnippets(); })`);
    fs.writeFileSync(path.join(outDir, 'tools-panel.png'), (await win.webContents.capturePage()).toPNG());

    console.log(JSON.stringify({ ok: true, ...results }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, results, requests }, null, 2));
    app.exit(1);
  }
});
