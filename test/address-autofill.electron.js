'use strict';

// Address autofill on the kinds of checkout forms that used to get state / postal code wrong.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { buildAutofillScript } = require('../src/profiles');

const profile = {
  name: 'Ann Lee', email: 'ann@example.com', password: '', phone: '8045550100',
  address1: '12 Main St', address2: 'Apt 4', city: 'Boston', state: 'MA', zip: '2134', country: 'US', cards: [],
};
const STATE_OPTIONS = '<option value="">Select</option><option value="MA">Massachusetts</option><option value="VA">Virginia</option>';
const STATE_NAME_OPTIONS = '<option value="">Select</option><option>Massachusetts</option><option>Virginia</option>';
const COUNTRY_OPTIONS = '<option value="">Select</option><option value="CA">Canada</option><option value="USA">United States</option>';

const FORMS = {
  // Dotted names that all contain "address" (used to fill the street into state and postal code).
  dotted: `<input name="address.line1"><input name="address.line2"><input name="address.city">
    <select name="address.region">${STATE_NAME_OPTIONS}</select><input name="address.postalCode">
    <select name="address.country">${COUNTRY_OPTIONS}</select>`,
  camelCase: `<input id="billingAddressLine1"><input id="billingAddressCity"><input id="billingAddressState" maxlength="2">
    <input id="billingAddressZip">`,
  hyphenated: `<input id="billing-address-street"><input id="billing-address-city"><input id="billing-address-state">
    <input id="billing-address-zip-code">`,
  labelsOnly: `<label>Street address<input></label><label>Apartment, suite, etc.<input></label><label>Town / City<input></label>
    <label>State / Province<select>${STATE_OPTIONS}</select></label><label>ZIP / Postal code<input></label>
    <label>Country/Region<select>${COUNTRY_OPTIONS}</select></label>`,
  autocomplete: `<input autocomplete="shipping address-line1"><input autocomplete="shipping address-level2">
    <select autocomplete="shipping address-level1">${STATE_NAME_OPTIONS}</select><input autocomplete="shipping postal-code">`,
};

async function fill(win, html) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><form>${html}</form>`)}`);
  await win.webContents.executeJavaScript(buildAutofillScript(profile, null));
  return win.webContents.executeJavaScript(`[...document.querySelectorAll('input, select')].map((el) => el.value)`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  try {
    assert.deepEqual(await fill(win, FORMS.dotted), ['12 Main St', 'Apt 4', 'Boston', 'Massachusetts', '02134', 'USA']);
    assert.deepEqual(await fill(win, FORMS.camelCase), ['12 Main St', 'Boston', 'MA', '02134']);
    assert.deepEqual(await fill(win, FORMS.hyphenated), ['12 Main St', 'Boston', 'MA', '02134']);
    assert.deepEqual(await fill(win, FORMS.labelsOnly), ['12 Main St', 'Apt 4', 'Boston', 'MA', '02134', 'USA']);
    assert.deepEqual(await fill(win, FORMS.autocomplete), ['12 Main St', 'Boston', 'Massachusetts', '02134']);
    console.log('address autofill: ok');
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
});
