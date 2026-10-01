/**
 * marketing-spend.cjs (2026-10-01) - ad spend entries for the "Ad spend & ROAS" section of Finance Reports.
 *
 *   GET    /api/marketing/spend?from=YYYY-MM-DD&to=YYYY-MM-DD   entries of the period (both ends optional, inclusive)
 *   POST   /api/marketing/spend   { date, source, campaign?, amount, note? }   -> 201 { entry }
 *   PUT    /api/marketing/spend/<id>   { date, source, campaign?, amount, note? }   -> 200 { entry }
 *   DELETE /api/marketing/spend/<id>                                            -> 200 { ok: true, id }
 *
 * Mounted in server_v14.cjs behind requireAuth:
 *     app.use('/api/marketing/spend', requireAuth, require('./marketing-spend.cjs')({ lockedUpdate, DATA_DIR }));
 * Role is not checked (STAFF_WRITES = all, the owner's decision of 2026-09-05): everyone signed in may add and delete.
 *
 * Data: data/marketing-spend.json, one array, written only through lockedUpdate (the same queue and atomic write as the
 * other tables). A deleted entry is NOT removed from the array: it gets deleted: { by, at } and stops showing in GET. That is
 * the "deleted" journal of the brief, in the same file and the same atomic write, so a crash cannot leave an entry gone and
 * its journal line missing; lockedUpdate only takes arrays, so a second file would be a second write. Every change also goes
 * to the audit log (table marketing-spend) through lockedUpdate's meta argument. An edit (PUT) keeps what the entry was in
 * its own edits: [{ by, at, was }] list, for the same reason and in the same write.
 *
 * Money is integer cents in the file (amountCents); the API takes dollars with at most two decimals, > 0 and <= 100000.
 *
 * The source is stored as a key that matches what the orders report calls the same source: the orders carry
 * attribution.source (a lower-case slug made by products-api attributionSource) and finance-model sourceOf() turns it into
 * a label. A spend key is a known name (google, instagram, facebook, meta, tiktok, newsletter) or other:<slug of the text>,
 * the slug by the same rule as products-api attrSlug and NOTHING else: there is no synonym table here (products-api owns
 * that one and it changes), so "other:fb" is the key other:fb and does not meet orders that products-api turned into
 * facebook. The page offers the real names, which is how an ad spend reaches its orders; the report (adspend-model.js) also
 * puts facebook, instagram and meta orders into one Meta group. "direct" is not a source one pays for and is refused.
 *
 * The file is READ by this module itself, not through readJSON(): readJSON answers an unreadable file with the fallback it
 * is given ([]), and the next write would then replace every entry. Unreadable is 503 here, a missing file is [] (first use).
 * Plain (req, res, next) handler with no express dependency, so it is testable with node:http.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'marketing-spend.json';
const MAX_AMOUNT_CENTS = 100000 * 100;
const MAX_BODY_BYTES = 16 * 1024;
const KNOWN = ['google', 'instagram', 'facebook', 'meta', 'tiktok', 'newsletter'];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// products-api.cjs attrSlug, character for character.
function slug(v) {
  return String(typeof v === 'string' ? v : '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

// The key the spend is stored under, or null when the input is not a source we accept.
function normalizeSource(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const other = /^other:/i.test(raw);
  const s = slug(other ? raw.slice(6) : raw);
  if (!s || s === 'direct') return null;
  if (KNOWN.indexOf(s) !== -1) return s;   // a known name, typed as a label ("Facebook") or as other:Facebook
  return other ? 'other:' + s : null;      // a bare unknown name must say "other:" on purpose
}

function ymdValid(s) {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Dollars -> cents. A number or a plain decimal string with at most two decimals; nothing else (no 1e3, no 12.345).
function parseAmountCents(v) {
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === 'string') s = v.trim();
  else return null;
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const c = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
  return c > 0 && c <= MAX_AMOUNT_CENTS ? c : null;
}

function cleanText(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

module.exports = function marketingSpend(opts) {
  const o = opts || {};
  if (typeof o.lockedUpdate !== 'function' || !o.DATA_DIR) throw new Error('marketing-spend.cjs needs { lockedUpdate, DATA_DIR } from server_v14.cjs');
  const lockedUpdate = o.lockedUpdate;
  const filePath = path.join(String(o.DATA_DIR), FILE);
  const clock = typeof o.now === 'function' ? o.now : Date.now;

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  function loadAll() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw httpError(503, FILE + ' cannot be read (' + ((e && e.code) || 'error') + '), restore it by hand before saving anything');
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw httpError(503, FILE + ' is not readable JSON, restore it by hand before saving anything'); }
    if (!Array.isArray(parsed)) throw httpError(503, FILE + ' is not a list, restore it by hand before saving anything');
    return parsed;
  }

  // express.json has already parsed a real request into req.body. No req.body means the request was not JSON (or the parser is not
  // in front of this mount): 415. Reading the stream here is for the tests only and must be asked for (readRawBody).
  function readBody(req) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
    if (!o.readRawBody) return Promise.reject(httpError(415, 'A JSON body is required'));
    return new Promise((resolve, reject) => {
      let size = 0, over = false; const chunks = [];
      req.on('data', c => { size += c.length; if (over) return; if (size > MAX_BODY_BYTES) { over = true; reject(httpError(413, 'Body too large')); } else chunks.push(c); });
      req.on('end', () => {
        if (over) return;
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
        catch (e) { reject(httpError(400, 'Body is not valid JSON')); }
      });
      req.on('error', () => reject(httpError(400, 'Body could not be read')));
    });
  }

  function whoami(req) { return String((req.userSession && req.userSession.email) || '').trim() || 'unknown'; }

  function validate(body) {
    const date = typeof body.date === 'string' ? body.date.trim() : '';
    if (!ymdValid(date)) throw httpError(400, 'date must be a real calendar day, YYYY-MM-DD');
    // A day ahead of the server's UTC date is allowed (a manager east of Greenwich enters "today"); more is a typo.
    if (date < '2020-01-01' || date > isoDay(clock() + 86400000)) throw httpError(400, 'date is out of range');
    const source = normalizeSource(body.source);
    if (!source) throw httpError(400, 'source must be one of ' + KNOWN.join(', ') + ' or other:<name>');
    const amountCents = parseAmountCents(body.amount);
    if (amountCents === null) throw httpError(400, 'amount must be a USD number above 0 and up to 100000 with at most 2 decimals');
    const campaign = cleanText(body.campaign, 80);
    const note = cleanText(body.note, 200);
    if (campaign === null || note === null) throw httpError(400, 'campaign and note must be text');
    return { date, source, campaign, amountCents, note };
  }

  function publicEntry(e) {
    const out = { id: e.id, date: e.date, source: e.source, campaign: e.campaign || '', amountCents: e.amountCents, note: e.note || '',
      createdBy: e.createdBy || '', createdAt: e.createdAt || '' };
    if (e.updatedBy) { out.updatedBy = e.updatedBy; out.updatedAt = e.updatedAt || ''; }
    return out;
  }

  function list(req, res, query) {
    const from = query.get('from') || '', to = query.get('to') || '';
    if ((from && !ymdValid(from)) || (to && !ymdValid(to))) return send(res, 400, { error: 'from and to must be YYYY-MM-DD' });
    const entries = loadAll()
      .filter(e => e && !e.deleted && typeof e.date === 'string' && (!from || e.date >= from) && (!to || e.date <= to))
      .map(publicEntry)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    send(res, 200, { entries, totalCents: entries.reduce((s, e) => s + e.amountCents, 0) });
  }

  async function create(req, res) {
    const v = validate(await readBody(req));
    const entry = Object.assign({ id: 'sp_' + crypto.randomBytes(6).toString('hex') }, v,
      { createdBy: whoami(req), createdAt: new Date(clock()).toISOString() });
    const r = await lockedUpdate(FILE, () => loadAll().concat([entry]),
      { action: 'create', user: entry.createdBy, details: entry.id + ' ' + entry.date + ' ' + entry.source + ' ' + (entry.amountCents / 100).toFixed(2) });
    if (!r || !r.ok) return send(res, 500, { error: 'Could not save the entry' });
    send(res, 201, { entry: publicEntry(entry) });
  }

  // The whole entry is sent again (the same fields and the same checks as POST). What it was goes into the entry's edits list;
  // a save that changes nothing writes nothing.
  async function update(req, res, id) {
    const v = validate(await readBody(req));
    const by = whoami(req);
    let found = null, changed = false, line = '';
    const brief = e => e.date + ' ' + e.source + ' ' + (e.amountCents / 100).toFixed(2);
    const r = await lockedUpdate(FILE, () => {
      const all = loadAll();
      const i = all.findIndex(e => e && e.id === id && !e.deleted);
      if (i === -1) return null;               // nothing to write
      const cur = all[i];
      const was = { date: cur.date, source: cur.source, campaign: cur.campaign || '', amountCents: cur.amountCents, note: cur.note || '' };
      found = cur;
      if (Object.keys(was).every(k => was[k] === v[k])) return null;
      changed = true;
      const at = new Date(clock()).toISOString();
      found = Object.assign({}, cur, v, { updatedBy: by, updatedAt: at, edits: (Array.isArray(cur.edits) ? cur.edits : []).concat([{ by, at, was }]) });
      line = id + ' ' + brief(was) + ' -> ' + brief(v);
      const next = all.slice();
      next[i] = found;
      return next;
    }, () => ({ action: 'update', user: by, details: line }));   // lockedUpdate asks for the meta after the write: the line exists by then
    if (!found) return send(res, 404, { error: 'No such entry' });
    if (changed && (!r || !r.ok)) return send(res, 500, { error: 'Could not save the change' });
    send(res, 200, { entry: publicEntry(found) });
  }

  async function remove(req, res, id) {
    const by = whoami(req);
    let found = false;
    const r = await lockedUpdate(FILE, () => {
      const all = loadAll();
      const i = all.findIndex(e => e && e.id === id && !e.deleted);
      if (i === -1) return null;               // nothing to write
      found = true;
      const next = all.slice();
      next[i] = Object.assign({}, all[i], { deleted: { by, at: new Date(clock()).toISOString() } });
      return next;
    }, { action: 'delete', user: by, details: id });
    if (!found) return send(res, 404, { error: 'No such entry' });
    if (!r || !r.ok) return send(res, 500, { error: 'Could not save the change' });
    send(res, 200, { ok: true, id });
  }

  return function marketingSpendHandler(req, res, next) {
    const u = new URL(String(req.url || '/'), 'http://x');
    const rest = u.pathname.replace(/^\/+|\/+$/g, '');
    let run;
    if (rest === '') {
      if (req.method === 'GET') run = () => list(req, res, u.searchParams);
      else if (req.method === 'POST') run = () => create(req, res);
    } else if (/^sp_[0-9a-f]{12}$/.test(rest)) {
      if (req.method === 'DELETE') run = () => remove(req, res, rest);
      else if (req.method === 'PUT') run = () => update(req, res, rest);
    }
    if (!run) return next();
    Promise.resolve().then(run).catch(e => {
      if (res.headersSent) return;
      const status = e && Number.isInteger(e.status) ? e.status : 500;
      if (status === 500) console.error('[marketing-spend]', e && e.message);   // a message of ours never carries a key: nothing secret is read here
      send(res, status, { error: status === 500 ? 'Internal error' : e.message });
    });
  };
};
module.exports.normalizeSource = normalizeSource;
module.exports.parseAmountCents = parseAmountCents;
module.exports.KNOWN = KNOWN;
