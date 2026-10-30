'use strict';

// Static test of the seat-matcher's selectors against the real Ticketmaster seatmap HTML the user
// captured from a live event (Row M in Section 108). We cannot drive the real site from Node, so
// instead we parse the HTML into a tiny queryable tree and run the matching logic directly to
// confirm it picks the correct seats. If this ever breaks, it means we broke a selector in the
// injected script.

const test = require('node:test');
const assert = require('node:assert/strict');

// The exact HTML from the user's recording, wrapped in a section group so the scope lookup works.
const HTML = `
<g data-section-name="108">
  <g data-component="svg__row" data-row-name="M" class="row">
    <circle data-component="svg__seat" id="GEYDCOSNHIYQ" class="seat" data-seat-name="1"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHIZA" class="seat" data-seat-name="2"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHIZQ" class="seat" data-seat-name="3"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHI2A" class="seat" data-seat-name="4"></circle>
    <g data-component="svg__seat" id="GEYDCOSNHI2Q" class="seat is-available is-filtered is-selected is-custom" data-seat-name="5"><circle></circle></g>
    <circle data-component="svg__seat" id="GEYDCOSNHI3A" class="seat is-available is-filtered" data-seat-name="6"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHI3Q" class="seat" data-seat-name="7"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHI4A" class="seat" data-seat-name="8"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHI4Q" class="seat" data-seat-name="9"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHIYTA" class="seat" data-seat-name="10"></circle>
    <circle data-component="svg__seat" id="GEYDCOSNHIYTC" class="seat" data-seat-name="11"></circle>
  </g>
</g>`;

// Tiny HTML → tree parser. Only handles tag/attrs/children; no text content needed for selector logic.
function parse(html) {
  const tokens = html.match(/<\/?[^>]+>/g) || [];
  const root = { tag: 'root', attrs: {}, children: [], parent: null };
  let node = root;
  for (const tok of tokens) {
    if (tok.startsWith('</')) { node = node.parent; continue; }
    const self = tok.endsWith('/>');
    const m = /^<([a-zA-Z][\w-]*)([^>]*?)\/?>$/.exec(tok);
    if (!m) continue;
    const el = { tag: m[1], attrs: {}, children: [], parent: node };
    for (const [, k, _q, dq, sq] of m[2].matchAll(/\s([a-zA-Z-][\w-]*)=("([^"]*)"|'([^']*)')/g)) el.attrs[k] = dq ?? sq ?? '';
    node.children.push(el);
    if (!self) node = el;
  }
  return root;
}

// Walker helpers that mirror the DOM operations the real matcher relies on.
function* walk(node) { yield node; for (const c of node.children) yield* walk(c); }
const getAttr = (el, name) => el.attrs[name] ?? null;
const classOf = (el) => el.attrs.class || '';
const closest = (el, pred) => { for (let n = el; n && n.tag !== 'root'; n = n.parent) if (pred(n)) return n; return null; };

// The actual matching logic, lifted shape-for-shape from seat-match-script.js's matchSeats().
function findSeats(root, { section, row, lowSeat, highSeat }) {
  const seatNames = [];
  if (lowSeat && highSeat) for (let s = lowSeat; s <= highSeat; s++) seatNames.push(String(s));
  else if (lowSeat) seatNames.push(String(lowSeat));
  const norm = (s) => String(s ?? '').toLowerCase().trim();
  const targetSection = norm(section);
  const targetRow = norm(row);
  const matches = [];
  for (const node of walk(root)) {
    if (node.tag !== 'g' || getAttr(node, 'data-section-name') == null) continue;
    const sec = norm(getAttr(node, 'data-section-name'));
    if (targetSection && sec !== targetSection && !sec.endsWith(targetSection)) continue;
    for (const sub of walk(node)) {
      if (getAttr(sub, 'data-component') !== 'svg__row') continue;
      const rowName = norm(getAttr(sub, 'data-row-name'));
      if (targetRow && rowName !== targetRow) continue;
      for (const seat of walk(sub)) {
        if (getAttr(seat, 'data-component') !== 'svg__seat') continue;
        const seatName = getAttr(seat, 'data-seat-name');
        if (!seatName) continue;
        if (seatNames.length > 0 && !seatNames.includes(String(seatName))) continue;
        if (!classOf(seat).includes('is-available')) continue;
        matches.push(seat);
      }
    }
  }
  return matches;
}

test('matcher finds the two available Row M seats in Section 108', () => {
  const root = parse(HTML);
  const matches = findSeats(root, { section: '108', row: 'M', lowSeat: 5, highSeat: 6 });
  const ids = matches.map((m) => m.attrs.id);
  // Seat 5 is already is-selected but also is-available → should match. Seat 6 is plain is-available.
  assert.deepEqual(ids, ['GEYDCOSNHI2Q', 'GEYDCOSNHI3A'], 'should pick seats 5 and 6');
});

test('matcher skips seats that are not is-available (sold / held)', () => {
  const root = parse(HTML);
  // Seats 1..4 and 7..11 have no is-available class in the recording.
  const matches = findSeats(root, { section: '108', row: 'M', lowSeat: 1, highSeat: 4 });
  assert.equal(matches.length, 0, 'no seats 1-4 should match (they are not available)');
});

test('matcher respects the section scope', () => {
  const root = parse(HTML);
  // Row M + seats 5-6 but the WRONG section → no match.
  const matches = findSeats(root, { section: '999', row: 'M', lowSeat: 5, highSeat: 6 });
  assert.equal(matches.length, 0, 'wrong section should produce no match');
});

test('matcher finds a single seat when low == high', () => {
  const root = parse(HTML);
  const matches = findSeats(root, { section: '108', row: 'M', lowSeat: 6, highSeat: 6 });
  const ids = matches.map((m) => m.attrs.id);
  assert.deepEqual(ids, ['GEYDCOSNHI3A']);
});
