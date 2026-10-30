'use strict';

// Local status layered on top of Automatiq orders. Automatiq doesn't tell us whether a rep has
// touched an order yet — that bookkeeping lives here. Three states:
//   - new:     fetched from Automatiq, nothing done on this machine
//   - working: the rep clicked Search / auto-opened the event tab for it
//   - handled: the rep marked it done (toggle from the Orders panel)
//
// Persisted as a plain `{ orderId: { status, updatedAt } }` map in order-status.json. Shape kept
// forward-compatible — new fields can be added without breaking older installs.

const fs = require('node:fs');
const path = require('node:path');

const VALID = new Set(['new', 'working', 'handled']);

function createOrderStatusStore(filePath) {
  let map = loadStore(filePath);

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
    } catch {}
  };

  return {
    get(id) { return map[String(id)]?.status ?? 'new'; },
    all() { return { ...map }; },
    set(id, status) {
      if (!id || !VALID.has(status)) return;
      map[String(id)] = { status, updatedAt: Date.now() };
      save();
    },
    /** Only promotes new → working. Explicit set() wins over this. Used by the auto-open watcher. */
    touch(id) {
      if (!id) return;
      const existing = map[String(id)];
      if (existing && existing.status !== 'new') return;
      map[String(id)] = { status: 'working', updatedAt: Date.now() };
      save();
    },
    forget(ids) {
      if (!Array.isArray(ids)) return;
      let changed = false;
      for (const id of ids) if (map[String(id)]) { delete map[String(id)]; changed = true; }
      if (changed) save();
    },
  };
}

function loadStore(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const out = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      const status = VALID.has(entry.status) ? entry.status : 'new';
      const updatedAt = Number(entry.updatedAt) || 0;
      out[String(id)] = { status, updatedAt };
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = { createOrderStatusStore };
