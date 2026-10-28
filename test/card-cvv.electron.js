'use strict';

// Saved-card checkouts: the page shows "Visa ending in 4444" and asks only for its CVV. Autofill
// must fill the CVV of the profile card with those last digits — never another card's.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { buildAutofillScript, buildCardDigitsScript, chooseShownCard } = require('../src/profiles');

const profile = {
  name: 'Ann Lee', email: 'ann@example.com', password: '', phone: '', address1: '', address2: '',
  city: '', state: '', zip: '', country: '',
  cards: [
    { number: '4111111111111111', cvv: '123', expMonth: '03', expYear: '2028', name: '' },
    { number: '5555555555554444', cvv: '999', expMonth: '', expYear: '', name: '' },
  ],
};

const PAGES = {
  single: '<p>Pay with Visa ending in 4444</p><label>CVV <input name="cvv"></label>',
  masked: '<div class="card"><span>Mastercard **** **** **** 4444</span><input placeholder="Security code"></div>',
  list: `<ul>
      <li><label><input type="radio" name="c"> Visa •••• 1111</label></li>
      <li><label><input type="radio" name="c" checked> Mastercard •••• 4444</label></li>
    </ul><input name="cvv">`,
  unknown: '<p>Amex ending in 0005</p><input name="cvv">',
  newCard: '<p>Saved: Visa ending in 4444</p><input autocomplete="cc-number"><input name="cvv">',
  plain: '<input name="cvv">',
  camelCase: '<p>Visa ending in 4444</p><input name="creditCardCvv" maxlength="4">',
  verification: '<p>Card ****4444</p><label for="v">Card Verification Code</label><input id="v" type="password">',
  brand: '<div>Visa - 4444</div><input placeholder="CVV">',
  iframe: '<p>Visa ending in 4444</p><iframe srcdoc="<input name=cvv>"></iframe>',
};

async function load(win, html) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body>${html}</body>`)}`);
}

async function fill(win, frame = win.webContents.mainFrame) {
  const shown = await win.webContents.mainFrame.executeJavaScript(buildCardDigitsScript());
  const script = buildAutofillScript(profile, profile.cards[0], { cardHintLast4: chooseShownCard(shown, profile.cards) });
  const result = await frame.executeJavaScript(script);
  const cvv = await frame.executeJavaScript(`[...document.querySelectorAll('input:not([type=radio])')].pop().value`);
  return { result, cvv };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  try {
    for (const [page, last4, cvv] of [['single', '4444', '999'], ['masked', '4444', '999'], ['list', '4444', '999']]) {
      await load(win, PAGES[page]);
      const out = await fill(win);
      assert.equal(out.cvv, cvv, `${page}: CVV of the shown card`);
      assert.equal(out.result.cvvCard, last4, `${page}: reports the matched card`);
    }

    for (const page of ['camelCase', 'verification', 'brand']) {
      await load(win, PAGES[page]);
      const res = await fill(win);
      assert.equal(res.cvv, '999', `${page}: CVV field recognised and matched`);
    }

    // A card saved only as "****4444" + CVV (Jancy Passcode columns) works the same way.
    const savedCards = profile.cards;
    profile.cards = [{ number: '', last4: '4444', cvv: '777', expMonth: '', expYear: '', name: '' }];
    await load(win, PAGES.single);
    assert.equal((await fill(win)).cvv, '777', 'last-4-only card: CVV filled when the page shows it');
    await load(win, PAGES.newCard);
    assert.equal((await fill(win)).cvv, '', 'last-4-only card: never typed into a new-card form');
    profile.cards = savedCards;

    await load(win, PAGES.unknown);
    let out = await fill(win);
    assert.equal(out.cvv, '', 'a card that is not on the profile gets no CVV');
    assert.equal(out.result.cvvMismatch, '0005');

    await load(win, PAGES.newCard);
    out = await fill(win);
    assert.equal(out.cvv, '123', 'a new-card form uses the typed card\'s CVV');

    await load(win, PAGES.plain);
    out = await fill(win);
    assert.equal(out.cvv, '123', 'no card shown: the chosen card\'s CVV');

    await load(win, PAGES.iframe);
    await new Promise((resolve) => setTimeout(resolve, 200));
    out = await fill(win, win.webContents.mainFrame.frames[0]);
    assert.equal(out.cvv, '999', 'CVV box in a frame follows the card shown on the page');

    console.log('card CVV matching: ok');
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
});
