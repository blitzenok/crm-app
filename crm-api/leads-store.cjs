'use strict';

/**
 * BioFirest CRM — JSON lead store (replaces Google Sheets for the UI).
 * Mounted from server_v14.cjs. Never logs tokens or secrets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = [
  'Not Contacted',
  'Sent',
  'Email Sent',
  'Replied',
  'Interested',
  'Qualified',
  'Closed',
  'Bounced',
];

const UPDATABLE = [
  'status', 'priority', 'company', 'country', 'city', 'email', 'phone',
  'notes', 'coupon', 'last_email_sent_at', 'last_open_at', 'last_click_at',
  'unsubscribed', 'cio_person_id', 'status_manual_override',
];

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return 'lead_' + crypto.randomBytes(6).toString('hex');
}

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function normalizeStatus(s) {
  const raw = String(s || '').trim();
  if (!raw) return 'Not Contacted';
  const hit = STATUSES.find(x => x.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  const aliases = {
    contacted: 'Sent',
    pending: 'Not Contacted',
    new: 'Not Contacted',
    bounce: 'Bounced',
    reply: 'Replied',
  };
  return aliases[raw.toLowerCase()] || raw;
}

function emptyLead(partial) {
  const ts = nowIso();
  return {
    id: partial.id || newId(),
    status: normalizeStatus(partial.status),
    priority: String(partial.priority || '').trim(),
    company: String(partial.company || '').trim(),
    country: String(partial.country || '').trim(),
    city: String(partial.city || '').trim(),
    email: String(partial.email || '').trim(),
    phone: String(partial.phone || '').trim(),
    notes: String(partial.notes || '').trim(),
    coupon: String(partial.coupon || '').trim(),
    last_email_sent_at: partial.last_email_sent_at || null,
    last_open_at: partial.last_open_at || null,
    last_click_at: partial.last_click_at || null,
    unsubscribed: !!partial.unsubscribed,
    cio_person_id: partial.cio_person_id || null,
    status_manual_override: !!partial.status_manual_override,
    created_at: partial.created_at || ts,
    updated_at: partial.updated_at || ts,
  };
}

function mapImportRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (Array.isArray(row)) {
    return emptyLead({
      status: row[0],
      priority: row[1],
      company: row[2],
      country: row[3],
      city: row[4],
      email: row[7],
      phone: row[8],
      notes: row[9],
      coupon: row[10],
    });
  }
  const lower = {};
  for (const [k, v] of Object.entries(row)) lower[String(k).toLowerCase().trim()] = v;
  const pick = (...names) => {
    for (const n of names) {
      if (lower[n] != null && String(lower[n]).trim() !== '') return lower[n];
    }
    return '';
  };
  const company = pick('company', 'business', 'name', 'clinic');
  if (!company && !pick('email')) return null;
  return emptyLead({
    id: lower.id || undefined,
    status: pick('status'),
    priority: pick('priority'),
    company,
    country: pick('country', 'region'),
    city: pick('city'),
    email: pick('email', 'e-mail'),
    phone: String(pick('phone', 'tel', 'telephone')).replace(/#ERROR!/g, ''),
    notes: pick('notes', 'note', 'comment'),
    coupon: pick('coupon', 'promo', 'code'),
    unsubscribed: /^(1|true|yes)$/i.test(String(pick('unsubscribed', 'unsub'))),
    cio_person_id: pick('cio_person_id', 'cio_id') || null,
  });
}

module.exports = function mountLeadsStore({ app, requireAuth, requireAdmin, DATA_DIR }) {
  if (!app || !requireAuth) throw new Error('leads-store: app and requireAuth required');
  const file = path.join(DATA_DIR, 'leads.json');

  let writeQueue = Promise.resolve();
  function enqueue(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.catch(() => {});
    return run;
  }

  function readLeads() {
    try {
      if (!fs.existsSync(file)) return [];
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error('[leads-store] read error:', e.message);
      return [];
    }
  }

  function writeLeads(leads) {
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(leads, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  if (!fs.existsSync(file)) {
    try { writeLeads([]); } catch (e) { console.warn('[leads-store] init file failed:', e.message); }
  }

  function filterLeads(leads, { status, q } = {}) {
    let out = leads;
    if (status) {
      const s = String(status).trim().toLowerCase();
      out = out.filter(l => String(l.status || '').toLowerCase() === s);
    }
    if (q) {
      const needle = String(q).trim().toLowerCase();
      out = out.filter(l => {
        const hay = [l.company, l.email, l.city, l.country, l.phone, l.notes, l.coupon, l.priority]
          .map(v => String(v || '').toLowerCase()).join(' ');
        return hay.includes(needle);
      });
    }
    return out;
  }

  app.get('/api/leads', requireAuth, (req, res) => {
    try {
      const leads = filterLeads(readLeads(), { status: req.query.status, q: req.query.q });
      res.json({ ok: true, count: leads.length, leads });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/leads/:id', requireAuth, (req, res) => {
    const lead = readLeads().find(l => l.id === req.params.id);
    if (!lead) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, lead });
  });

  app.post('/api/leads', requireAuth, (req, res) => {
    const body = req.body || {};
    const company = String(body.company || '').trim();
    if (!company) return res.status(400).json({ ok: false, error: 'company_required' });
    const lead = emptyLead(body);
    return enqueue(() => {
      const leads = readLeads();
      leads.push(lead);
      writeLeads(leads);
      res.json({ ok: true, lead });
    }).catch(e => res.status(500).json({ ok: false, error: e.message }));
  });

  app.patch('/api/leads/:id', requireAuth, (req, res) => {
    const body = req.body || {};
    return enqueue(() => {
      const leads = readLeads();
      const idx = leads.findIndex(l => l.id === req.params.id);
      if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
      const next = { ...leads[idx] };
      for (const key of UPDATABLE) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          if (key === 'status') next.status = normalizeStatus(body.status);
          else if (key === 'unsubscribed' || key === 'status_manual_override') next[key] = !!body[key];
          else next[key] = body[key];
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'status')) {
        next.status_manual_override = body.status_manual_override !== false;
      }
      next.updated_at = nowIso();
      leads[idx] = next;
      writeLeads(leads);
      res.json({ ok: true, lead: next });
    }).catch(e => res.status(500).json({ ok: false, error: e.message }));
  });

  app.post('/api/leads/import', requireAuth, (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
    if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows_array_required' });
    return enqueue(() => {
      const existing = readLeads();
      const byEmail = new Map();
      const byCompanyCountry = new Map();
      for (const l of existing) {
        if (l.email) byEmail.set(String(l.email).toLowerCase(), l);
        byCompanyCountry.set(`${String(l.company).toLowerCase()}|${String(l.country).toLowerCase()}`, l);
      }
      let added = 0, skipped = 0, updated = 0;
      for (const row of rows) {
        const mapped = mapImportRow(row);
        if (!mapped || !mapped.company) { skipped++; continue; }
        const emailKey = mapped.email ? mapped.email.toLowerCase() : '';
        let hit = emailKey ? byEmail.get(emailKey) : null;
        if (!hit) hit = byCompanyCountry.get(`${mapped.company.toLowerCase()}|${mapped.country.toLowerCase()}`);
        if (hit) {
          if (req.body && req.body.update_existing) {
            Object.assign(hit, {
              status: mapped.status || hit.status,
              priority: mapped.priority || hit.priority,
              city: mapped.city || hit.city,
              phone: mapped.phone || hit.phone,
              notes: mapped.notes || hit.notes,
              coupon: mapped.coupon || hit.coupon,
              updated_at: nowIso(),
            });
            updated++;
          } else {
            skipped++;
          }
          continue;
        }
        existing.push(mapped);
        if (emailKey) byEmail.set(emailKey, mapped);
        byCompanyCountry.set(`${mapped.company.toLowerCase()}|${mapped.country.toLowerCase()}`, mapped);
        added++;
      }
      writeLeads(existing);
      res.json({ ok: true, added, updated, skipped, total: existing.length });
    }).catch(e => res.status(500).json({ ok: false, error: e.message }));
  });

  // One-time sheets pull helper (admin). Runs on the server so tokens never leave it.
  app.post('/api/leads/import-from-sheets', requireAdmin, async (req, res) => {
    try {
      const result = await importFromSheets({ DATA_DIR, file, writeLeads, readLeads, enqueue });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: 'import_failed', detail: e.message });
    }
  });

  return { readLeads, writeLeads, emptyLead, STATUSES, filterUnsubscribed };
};

function filterUnsubscribed(leads) {
  return (leads || []).filter(l => !l.unsubscribed);
}

async function importFromSheets({ DATA_DIR, file, writeLeads, readLeads }) {
  const https = require('https');
  const SHEET_ID = '12M-Xxdb8ORpQyAcTODaeHEat_BketXbso-RPq1isosI';
  const RANGE = 'Untitled!A1:L1100';

  function httpJson(opts, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(opts, r => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch { j = { raw: d.slice(0, 200) }; }
          resolve({ status: r.statusCode, json: j });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function refreshAccessToken() {
    const env = parseEnvFile('/opt/crm-api/sheets-oauth.env');
    const id = env.GOOGLE_CLIENT_ID;
    const sec = env.GOOGLE_CLIENT_SECRET;
    const rt = env.GOOGLE_REFRESH_TOKEN;
    if (!id || !sec || !rt) return Promise.resolve({ ok: false, error: 'oauth_env_incomplete' });
    const body = new URLSearchParams({
      client_id: id,
      client_secret: sec,
      refresh_token: rt,
      grant_type: 'refresh_token',
    }).toString();
    return httpJson({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body).then(({ status, json }) => {
      if (status !== 200 || !json.access_token) {
        return { ok: false, error: json.error || 'refresh_failed', status };
      }
      const token = json.access_token;
      const stamp = new Date().toISOString();
      try {
        fs.writeFileSync(
          '/opt/crm-api/sheets-token.env',
          `SHEETS_TOKEN=${token}\nGOOGLESHEETS_ACCESS_TOKEN=${token}\nSHEETS_TOKEN_UPDATED=${stamp}\n`,
          { mode: 0o600 }
        );
      } catch (e) {
        console.warn('[leads-store] could not write sheets-token.env:', e.message);
      }
      return { ok: true, token, expires_in: json.expires_in };
    });
  }

  const refreshed = await refreshAccessToken();
  if (!refreshed.ok) {
    return { ok: false, error: 'sheets_refresh_failed', imported: 0 };
  }
  const token = refreshed.token;
  const pathQ = `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
  const { status, json } = await httpJson({
    hostname: 'sheets.googleapis.com',
    path: pathQ,
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token },
  });
  if (status !== 200 || !json.values) {
    return { ok: false, error: 'sheets_fetch_failed', status, imported: 0 };
  }
  const rows = json.values;
  if (rows.length < 2) {
    if (!fs.existsSync(file)) writeLeads([]);
    return { ok: true, imported: 0, total: readLeads().length, note: 'sheet_empty' };
  }
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
  writeLeads(leads);
  console.log('[leads-store] imported', leads.length, 'leads from sheets');
  return { ok: true, imported: leads.length, total: leads.length };
}

module.exports.STATUSES = STATUSES;
module.exports.emptyLead = emptyLead;
module.exports.filterUnsubscribed = filterUnsubscribed;
module.exports.importFromSheets = importFromSheets;
