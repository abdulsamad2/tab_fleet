'use strict';

// Override for tests; always points at docs.google.com in production.
const SHEETS_BASE = process.env.TABFLEET_SHEETS_BASE || 'https://docs.google.com';
const BASE_HOST = new URL(SHEETS_BASE).host;

/** Accepts any Google Sheets URL (view/edit, with or without #gid=…) or a bare spreadsheet id. */
function parseSheetURL(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(text)?.[1]
    ?? (/^[a-zA-Z0-9_-]{25,}$/.test(text) ? text : null);
  if (!id) return null;
  const gid = /[#&?]gid=(\d+)/.exec(text)?.[1];
  return { id, gid: gid === undefined ? null : Number(gid) };
}

/** The sheet's own CSV export endpoint; works with whatever credentials the request carries. */
function csvExportURL({ id, gid }) {
  const params = new URLSearchParams({ format: 'csv' });
  if (gid !== null && gid !== undefined) params.set('gid', String(gid));
  return `${SHEETS_BASE}/spreadsheets/d/${id}/export?${params}`;
}

/** The user-facing view URL for a sheet, so the window can open the right page. */
function viewURL({ id, gid }) {
  return `${SHEETS_BASE}/spreadsheets/d/${id}/edit${gid !== null && gid !== undefined ? `#gid=${gid}` : ''}`;
}

/** True when the URL points at a Google Sheets page (ignoring query strings and fragments). */
function isSheetsURL(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.host === BASE_HOST && /\/spreadsheets\/d\/[a-zA-Z0-9_-]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

module.exports = { parseSheetURL, csvExportURL, viewURL, isSheetsURL, SHEETS_BASE };
