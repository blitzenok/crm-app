'use strict';
// One-shot: try existing Sheets access token files, never print secrets.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { emptyLead } = require('./leads-store.cjs');

function parseEnv(p) {
  const o = {};
  if (!fs.existsSync(p)) return o;
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) o[m[1]] = m[2].trim();
    else if (t.startsWith('ya29.') || t.startsWith('ya29')) o.RAW = t;
  }
  return o;
}

function pickToken() {
  const files = ['/opt/crm-api/sheets-token.env', '/root/sheets-token.env'];
  for (const f of files) {
    const env = parseEnv(f);
    const token = env.SHEETS_TOKEN || env.GOOGLESHEETS_ACCESS_TOKEN || env.RAW || '';
    if (token) return { file: f, token, keys: Object.keys(env) };
  }
  return null;
}

function getJson(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'sheets.googleapis.com',
      path: urlPath,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch { j = { parse_error: true }; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const picked = pickToken();
  if (!picked) {
    console.log(JSON.stringify({ ok: false, error: 'no_existing_token_file' }));
    process.exit(2);
  }
  const SHEET_ID = '12M-Xxdb8ORpQyAcTODaeHEat_BketXbso-RPq1isosI';
  const RANGE = 'Untitled!A1:L1100';
  const apiPath = `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
  const { status, json } = await getJson(apiPath, picked.token);
  if (status !== 200 || !json.values) {
    const gerr = json.error && json.error.status ? json.error.status : (json.error || 'fetch_failed');
    console.log(JSON.stringify({
      ok: false,
      error: 'existing_token_fetch_failed',
      http: status,
      google_status: gerr,
      source_keys: picked.keys,
    }));
    process.exit(2);
  }
  const rows = json.values;
  const leads = [];
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const g = (i) => String((r && r[i]) || '').trim();
    const company = g(2);
    if (!company) continue;
    let phone = g(8);
    if (phone.includes('#ERROR')) phone = '';
    const email = g(7);
    const key = (email || company + '|' + g(3)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push(emptyLead({
      status: g(0) || 'Not Contacted',
      priority: g(1),
      company,
      country: g(3),
      city: g(4),
      email,
      phone,
      notes: g(9),
      coupon: g(10),
    }));
  }
  const file = path.join('/opt/crm-api/data/leads.json');
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(leads, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  console.log(JSON.stringify({ ok: true, imported: leads.length, rows_in_sheet: rows.length - 1, source: 'existing_access_token' }));
})().catch(e => {
  console.error('import_failed', e.message);
  process.exit(1);
});
