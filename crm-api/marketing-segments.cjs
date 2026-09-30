/**
 * BioLabs Research CRM — marketing segments (M2, 2026-09-08).
 *
 * A segment is a set of rules over the attributes that already travel to Customer.io with every identify
 * (orders_count, orders_total, orders_paid_total, last_order_at, country, last_products, coupon, subscribed …).
 * They are counted by products-api — by orderAttributesFor(), the very function the order path uses — and read
 * here through GET /msolpeptides-api/marketing/profiles. That is the whole point of the phase: a segment in the
 * CRM and a filter in Customer.io must be talking about the same person, and two implementations of "how much
 * has this customer paid" would not be.
 *
 * In Customer.io a segment of ours is a *manual* segment: created once through the App API, its membership kept
 * in step through the Track API (add_customers / remove_customers, both with ?id_type=email). The person's
 * identifier is the e-mail in lower case — the same identifier the storefront has been writing profiles under
 * since shop stage 3, and in this workspace the only one people have besides cio_id: there is no `id` field at
 * all, so the same call without the parameter answers 200 and adds nobody (seen on the live account 2026-09-08).
 *
 * Mounted by server_v14.cjs as
 *     app.use('/api/marketing/segments', requireAuth, require('./marketing-segments.cjs')({ lockedUpdate, DATA_DIR }));
 * so auth stands at the mount and no route below can be published by accident. Role is not checked — phase 5,
 * the owner's decision: everyone signed in has the same rights in the CRM.
 *
 * Rules kept throughout:
 *   - no key (App API, Track API, ADMIN_SECRET) reaches the client or a log line;
 *   - 429 / 5xx / network / timeout from Customer.io answer 503 with a readable reason, never a false success;
 *   - a run that stopped half way writes what it managed into last_sync.error — silence would look like success;
 *   - membership is only *removed* for addresses we can read; an id we cannot recognise is reported, never deleted;
 *   - nobody is added to a segment before the account knows them: add_customers answers 200 and does nothing for
 *     an address Customer.io has never seen (M2d, 2026-09-08), so a missing profile is created with an identify
 *     first — only for addresses of our own profile list, and the number is reported as last_sync.identified;
 *   - the file data/marketing-segments.json is never rewritten from a list we could not read (see readSegments).
 *
 * Config (all from /opt/crm-api/.env, loaded into process.env by server_v14.cjs at startup — a change to .env
 * therefore needs `pm2 restart blitz-api`):
 *   CIO_APP_API_KEY            App API Bearer key: create the segment, list segments, read membership
 *   CIO_SITE_ID                Track API basic auth, first half
 *   CIO_TRACKING_API_KEY       Track API basic auth, second half: add_customers / remove_customers
 *   CIO_REGION                 'eu' switches both default hosts to their EU addresses
 *   CIO_API_BASE               overrides the App API host outright (the seam the local stand points at its stub)
 *   CIO_TRACK_API_BASE         the same for the Track API
 *   CIO_WORKSPACE_ID           builds the "open in Customer.io" link (default 231885)
 *   MARKETING_ORDERS_BASE      where the profiles come from (default the local products-api, 127.0.0.1:4000)
 *   ADMIN_SECRET               how the scheduler authenticates to products-api (a scheduled run has no session)
 *   MARKETING_SYNC_INTERVAL_MIN  minutes between scheduled runs; the default is 0 — off. A timer that starts
 *                              itself an hour after the deploy would create the three built-in segments in
 *                              the account and fill them before anyone had looked at the preview, and the
 *                              request shapes below are documented, not yet seen answering. Switch it on
 *                              (60 is the sensible value) after the first sync has been watched by hand.
 */
'use strict';

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ── configuration ───────────────────────────────────────────────────────────────────────── */

const APP_KEY = String(process.env.CIO_APP_API_KEY || '').trim();
const SITE_ID = String(process.env.CIO_SITE_ID || '').trim();
const TRACK_KEY = String(process.env.CIO_TRACKING_API_KEY || '').trim();
const REGION = String(process.env.CIO_REGION || 'us').trim().toLowerCase();
const WORKSPACE_ID = String(process.env.CIO_WORKSPACE_ID || '231885').trim().replace(/[^0-9A-Za-z_-]/g, '');
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || '').trim();
const SYNC_INTERVAL_MIN = (function () {
  const raw = process.env.MARKETING_SYNC_INTERVAL_MIN;
  if (raw === undefined || String(raw).trim() === '') return 0;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 24 * 60);
})();

const REQUEST_TIMEOUT_MS = 10000;
const PROFILES_CACHE_TTL_MS = 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // membership of a big account, and a ceiling against a broken answer
const MEMBER_BATCH = 1000;                 // add_customers / remove_customers take up to a thousand ids at a time
// Every Track call about membership carries ?id_type=email. Checked on the live account on 2026-09-08 against our
// own manual segment: the people in this workspace have cio_id and email and nothing else; add_customers with a
// list of addresses and no parameter answered 200 and added no one (the ids are read as `id`s, which nobody has),
// and the same call with ?id_type=email moved customer_count from 0 to 2. The App API has no route of that name —
// POST /v1/segments/{id}/add_customers there is a 404 — so add and remove stay on the Track API.
const TRACK_ID_TYPE = 'email';
// M2d (2026-09-08): add_customers only moves people Customer.io already knows. The first live sync said
// added:1 for VIP and added:2 for Customers, and customer_count there answered 0 and 1 — the addresses whose
// orders are older than the storefront's events of 07.09 have no profile in the account at all, and the Track
// API answers 200 {} to a list of strangers and does nothing with it. So before any batch goes out, every
// address is looked up through the App API (200 = there, 404 = not), and the ones that are missing are created
// with an identify — the same call and the same attributes the order path uses. Track is asynchronous: a 200 to
// identify means "queued", so a created profile is read back before it is put in a segment, up to three times.
const IDENTIFY_SETTLE_MS = 1500;           // waited only between looks, never before the first one
const IDENTIFY_CONFIRM_TRIES = 3;
// Exactly what the profile from products-api carries about the order history, and nothing else: no address, no
// phone, no note. `unsubscribed` is never among them — that flag belongs to Customer.io, and writing it back
// would raise somebody who opted out (the contract of shop stage 3, §2).
const IDENTIFY_FIELDS = ['orders_count', 'orders_total', 'orders_paid_total', 'last_order_at', 'last_order_ref',
  'first_order_at', 'country', 'last_products', 'subscribed'];
const MEMBERSHIP_PAGE = 1000;
const MAX_MEMBERSHIP_PAGES = 50;           // 50 000 people; past that the answer is a runaway, not a segment
const MAX_STORED_MEMBERS = 5000;           // what we keep in the file as "what was sent last time"
// Below this many people in the segment, the "do not take away more than half in one run" floor does not
// apply: today's segments hold three to eight people, where losing two of three is an ordinary re-rule and
// re-filling by hand costs one click. The floor is there for the segment that has grown — where a wrong
// answer from products-api would quietly unsubscribe hundreds from a campaign. Emptying a segment that had
// anybody in it is refused at every size (see runSync): that is the one that cannot be an ordinary re-rule.
const REMOVE_GUARD_MIN = 10;
const MAX_RULES = 20;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const SAMPLE_SIZE = 20;
// The members list (2026-09-09). SAMPLE_SIZE above answers "how many, and a few of them" for the row;
// these page a segment of three hundred. 200 is the ceiling a caller may ask for, so no single request can
// be made to read a whole account, and the page's own 100 leaves room to ask for more.
const MEMBERS_PAGE = 100;
const MEMBERS_PAGE_MAX = 200;
const MEMBERS_QUERY_MAX = 100;             // the search box sends a fragment of an address, never a document
const LOG_RING = 200;

const SEGMENTS_FILE = 'marketing-segments.json';
const LOG_FILE = 'marketing-log.json';

// The same rule products-api uses for its Customer.io hosts (products-api.cjs:52): https anywhere, plain http only
// to this machine. .env is edited by other root agents too, and one mistyped http:// host would put the key on the
// wire in clear text in an Authorization header.
function parseBase(raw, fallback) {
  try {
    const u = new URL(String(raw || fallback).trim().replace(/\/+$/, ''));
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u;
  } catch (e) { /* reported by the caller */ }
  return null;
}
const APP_URL = parseBase(process.env.CIO_API_BASE, REGION === 'eu' ? 'https://api-eu.customer.io' : 'https://api.customer.io');
const TRACK_URL = parseBase(process.env.CIO_TRACK_API_BASE, REGION === 'eu' ? 'https://track-eu.customer.io' : 'https://track.customer.io');
const ORDERS_URL = parseBase(process.env.MARKETING_ORDERS_BASE, 'http://127.0.0.1:4000');

const APP_READY = !!(APP_KEY && APP_URL);
const TRACK_READY = !!(SITE_ID && TRACK_KEY && TRACK_URL);

/* ── the fields a rule may talk about ────────────────────────────────────────────────────── */

// Exactly the attributes products-api puts on a Customer.io profile, plus the two the CRM adds from its own lead
// list (subscribed, lead_created_at) and first_order_at, which identify never needed. A field that is not here
// cannot be segmented on — a rule over an attribute nobody sends would quietly match nobody.
const FIELDS = {
  orders_count:      { type: 'number', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], label: 'Orders' },
  orders_total:      { type: 'number', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], label: 'Ordered, $' },
  orders_paid_total: { type: 'number', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], label: 'Paid, $' },
  // Carts live in the browser and on the Customer.io profile; the CRM never stores one, so no profile coming back
  // from products-api carries this field and every rule over it matches nobody here. It is offered all the same
  // because the attribute does exist in Customer.io: build cart filters there (Shop Abandonment already does).
  cart_item_count:   { type: 'number', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], label: 'Items in cart', warn: 'not_stored' },
  last_order_at:     { type: 'date', ops: ['older_than_days', 'newer_than_days', 'is_set'], label: 'Last order' },
  first_order_at:    { type: 'date', ops: ['older_than_days', 'newer_than_days', 'is_set'], label: 'First order' },
  lead_created_at:   { type: 'date', ops: ['older_than_days', 'newer_than_days', 'is_set'], label: 'Lead created' },
  country:           { type: 'string', ops: ['eq', 'ne', 'in'], label: 'Country' },
  last_products:     { type: 'list', ops: ['contains', 'not_contains'], label: 'Last order contains' },
  subscribed:        { type: 'bool', ops: ['is'], label: 'Subscribed' },
  coupon:            { type: 'string', ops: ['eq'], label: 'Coupon' }
};
const OP_WORDS = {
  eq: 'is', ne: 'is not', gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most',
  older_than_days: 'more than N days ago', newer_than_days: 'within the last N days', is_set: 'is known',
  in: 'is one of', contains: 'includes', not_contains: 'does not include', is: 'is'
};

/* ── built-in segments ───────────────────────────────────────────────────────────────────── */

// Created once, when the file does not exist yet. builtin: their name is fixed (a campaign in Customer.io is wired
// to the segment by name, and renaming here would leave the campaign pointing at a segment nobody fills any more);
// rules and thresholds are the owner's to change, which is why VIP is a normal editable rule set and not a constant.
const BUILTINS = [
  {
    id: 'mseg_vip', name: 'VIP (CRM)',
    description: 'Paid $200 or more in total, or ordered three times and more.',
    match: 'any',
    rules: [{ field: 'orders_paid_total', op: 'gte', value: 200 }, { field: 'orders_count', op: 'gte', value: 3 }]
  },
  {
    id: 'mseg_customers', name: 'Customers (CRM)',
    description: 'Everyone with at least one order that was not cancelled.',
    match: 'all',
    rules: [{ field: 'orders_count', op: 'gte', value: 1 }]
  },
  {
    id: 'mseg_insiders', name: 'Insiders (CRM)',
    description: 'On the CRM lead list and not marked unsubscribed.',
    match: 'all',
    rules: [{ field: 'subscribed', op: 'is', value: true }]
  }
];

/* ── small helpers ───────────────────────────────────────────────────────────────────────── */

function apiError(status, message) { const e = new Error(message); e.status = status; return e; }
// lockedUpdate answers { ok:false } when the atomic write fails (a full disk, a read-only mount) — it does not
// throw. Answering 201/200 on top of that is how a segment nobody saved comes back as "saved". The convention
// of server_v14.cjs is 500 { error: 'Write failed' }; `expose` lets that one message through fail() below,
// which otherwise turns every 500 into "Internal server error".
function writeFailed() { const e = apiError(500, 'Write failed'); e.expose = true; return e; }
function assertWritten(r) { if (!r || (r.ok === false)) throw writeFailed(); return r; }
function nowIso() { return new Date().toISOString(); }
function normEmail(v) { return String(v === undefined || v === null ? '' : v).trim().toLowerCase(); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function looksLikeEmail(v) { return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v); }
// ab***@domain — enough to recognise someone you already know, useless to a reader over the shoulder. Everything
// that leaves this module for a screen or a log line goes through it: a preview is a list of customers.
function maskEmail(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '***';
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '***';
  const local = s.slice(0, at);
  return (local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2)) + '***@' + s.slice(at + 1);
}
// For a log line about one person: the same eight hex digits products-api writes (cioTrackId), so a line here and
// a line there can be matched up without an address appearing in either.
function emailTag(v) {
  return crypto.createHash('sha256').update(String(v === undefined || v === null ? '' : v)).digest('hex').slice(0, 8);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cleanText(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}
// A number out of a query string, clamped rather than refused: ?limit=5000 means "as much as you will give"
// and ?offset=-1 means the first page. Anything that is not a number falls back to the default instead of
// reaching slice() as NaN — a repeated parameter arrives as an array, and String(['1','2']) is '1,2'.
function intParam(raw, dflt, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.floor(n), min), max);
}
function segmentUrl(cioId) {
  if (cioId === null || cioId === undefined || cioId === '') return null;
  // Copied from the live interface on 2026-09-09. The address that stood here before was a guess without
  // the '/journeys/' section and answered "Page not found" on every row of the Segments page.
  return 'https://fly.customer.io/workspaces/' + WORKSPACE_ID + '/journeys/segments/' +
         encodeURIComponent(String(cioId)) + '/overview';
}

/* ── rule validation ─────────────────────────────────────────────────────────────────────── */

function validateRule(raw, index) {
  const where = 'rule ' + (index + 1) + ': ';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw apiError(400, where + 'must be an object');
  const field = String(raw.field || '').trim();
  const spec = Object.prototype.hasOwnProperty.call(FIELDS, field) ? FIELDS[field] : null;
  if (!spec) throw apiError(400, where + 'unknown field "' + cleanText(field, 40) + '"');
  const op = String(raw.op || '').trim();
  if (spec.ops.indexOf(op) === -1) throw apiError(400, where + '"' + cleanText(op, 40) + '" cannot be used with ' + field);
  const out = { field: field, op: op, value: null };

  if (spec.type === 'number') {
    const n = Number(raw.value);
    if (!Number.isFinite(n)) throw apiError(400, where + 'a number is required');
    if (Math.abs(n) > 1e9) throw apiError(400, where + 'number out of range');
    out.value = Math.round(n * 100) / 100;
  } else if (spec.type === 'date') {
    if (op === 'is_set') {
      if (typeof raw.value !== 'boolean') throw apiError(400, where + '"is known" takes true or false');
      out.value = raw.value;
    } else {
      const n = Number(raw.value);
      if (!Number.isInteger(n) || n < 0 || n > 3650) throw apiError(400, where + 'days must be a whole number from 0 to 3650');
      out.value = n;
    }
  } else if (spec.type === 'bool') {
    if (typeof raw.value !== 'boolean') throw apiError(400, where + 'true or false is required');
    out.value = raw.value;
  } else if (spec.type === 'list') {
    const s = cleanText(raw.value, 64).toLowerCase();
    if (!s) throw apiError(400, where + 'a product slug is required');
    out.value = s;
  } else {                                            // string: country, coupon
    if (op === 'in') {
      const list = (Array.isArray(raw.value) ? raw.value : String(raw.value === undefined || raw.value === null ? '' : raw.value).split(','))
        .map(v => cleanText(v, 80)).filter(Boolean);
      if (!list.length) throw apiError(400, where + 'at least one value is required');
      if (list.length > 50) throw apiError(400, where + 'no more than 50 values');
      out.value = list;
    } else {
      const s = cleanText(raw.value, 80);
      if (!s) throw apiError(400, where + 'a value is required');
      out.value = s;
    }
  }
  return out;
}

function validateBody(body, existing) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, 'Body must be a JSON object');
  const out = {};
  if (body.name !== undefined || !existing) {
    const name = cleanText(body.name, MAX_NAME + 1);
    if (!name) throw apiError(400, 'Name is required');
    if (name.length > MAX_NAME) throw apiError(400, 'Name must be ' + MAX_NAME + ' characters or fewer');
    out.name = name;
  }
  if (body.description !== undefined) out.description = cleanText(body.description, MAX_DESCRIPTION);
  if (body.match !== undefined || !existing) {
    const match = String(body.match || 'all').trim();
    if (match !== 'all' && match !== 'any') throw apiError(400, 'match must be "all" or "any"');
    out.match = match;
  }
  if (body.rules !== undefined || !existing) {
    if (!Array.isArray(body.rules)) throw apiError(400, 'rules must be an array');
    if (body.rules.length > MAX_RULES) throw apiError(400, 'No more than ' + MAX_RULES + ' rules');
    out.rules = body.rules.map(validateRule);
  }
  return out;
}

/* ── matching ────────────────────────────────────────────────────────────────────────────── */

// A rule can only be true about a value we have. A profile with no country is not "not from Italy" — it is a
// profile we know nothing about, and letting it fall through "country ne IT" would put strangers into a segment
// built to exclude them. "is known" (is_set) is the one operator that talks about the absence itself.
function matchRule(profile, rule) {
  const spec = FIELDS[rule.field];
  if (!spec) return false;
  const raw = profile ? profile[rule.field] : undefined;

  if (spec.type === 'number') {
    const n = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return false;
    switch (rule.op) {
      case 'eq': return n === rule.value;
      case 'ne': return n !== rule.value;
      case 'gt': return n > rule.value;
      case 'gte': return n >= rule.value;
      case 'lt': return n < rule.value;
      case 'lte': return n <= rule.value;
      default: return false;
    }
  }
  if (spec.type === 'date') {
    const t = typeof raw === 'string' && raw ? Date.parse(raw) : NaN;
    const known = Number.isFinite(t);
    if (rule.op === 'is_set') return rule.value === true ? known : !known;
    if (!known) return false;
    const edge = Date.now() - rule.value * 86400000;
    return rule.op === 'older_than_days' ? t <= edge : t > edge;
  }
  if (spec.type === 'bool') {
    if (typeof raw !== 'boolean') return false;
    return raw === rule.value;
  }
  if (spec.type === 'list') {
    // last_products travels as a comma-joined string of slugs (see the contract: an array would be dropped in
    // silence by identify), so it is read back the same way here.
    const items = String(raw === undefined || raw === null ? '' : raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!items.length) return false;
    const has = items.indexOf(rule.value) !== -1;
    return rule.op === 'contains' ? has : !has;
  }
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s) return false;
  if (rule.op === 'in') return rule.value.some(v => String(v).trim().toLowerCase() === s);
  const one = String(rule.value).trim().toLowerCase();
  return rule.op === 'eq' ? s === one : s !== one;
}

// No rules means nobody. The other reading — "no conditions, so everybody" — is how a mistyped segment becomes a
// mailing to the whole customer base; the CRM's older segment builder chose the same side (cio-routes.cjs:212).
function matchProfile(profile, segment) {
  const rules = Array.isArray(segment.rules) ? segment.rules : [];
  if (!rules.length) return false;
  return segment.match === 'any' ? rules.some(r => matchRule(profile, r)) : rules.every(r => matchRule(profile, r));
}

function membersOf(segment, profiles) {
  const seen = new Set();
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const email = normEmail(p.email);
    if (!looksLikeEmail(email) || seen.has(email)) continue;
    if (matchProfile(p, segment)) seen.add(email);
  }
  return Array.from(seen).sort();
}

// The rule as a sentence, so the table can say what a segment is without the reader decoding field names.
function ruleWords(rule) {
  const spec = FIELDS[rule.field] || { label: rule.field, type: 'string' };
  if (spec.type === 'date') {
    if (rule.op === 'is_set') return spec.label + (rule.value ? ' is known' : ' is unknown');
    return spec.label + (rule.op === 'older_than_days' ? ' more than ' : ' within ') + rule.value + ' days ago';
  }
  if (spec.type === 'bool') return spec.label + ' is ' + (rule.value ? 'yes' : 'no');
  if (spec.type === 'list') return spec.label + (rule.op === 'contains' ? ' ' : ' no ') + rule.value;
  if (rule.op === 'in') return spec.label + ' is one of ' + rule.value.join(', ');
  return spec.label + ' ' + (OP_WORDS[rule.op] || rule.op) + ' ' + rule.value;
}

/* ── HTTP to the outside ─────────────────────────────────────────────────────────────────── */

// One request, one answer, no retries: a retry against a segment endpoint can add the same batch twice, and the
// caller (a person watching a button, or the scheduler an hour before the next run) is better served by an honest
// error than by a silent second attempt. Key material never appears in a log line here or anywhere below.
function httpJson(base, apiPath, method, headers, body, tag) {
  return new Promise((resolve, reject) => {
    if (!base) return reject(apiError(503, 'Customer.io address is not configured'));
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({ 'Accept': 'application/json' }, headers);
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    let settled = false;
    const fail = e => { if (!settled) { settled = true; reject(e); } };
    const ok = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = (base.protocol === 'https:' ? https : http).request({
        protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
        path: base.pathname.replace(/\/+$/, '') + apiPath, method: method, headers: h, timeout: REQUEST_TIMEOUT_MS
      }, resp => {
        let size = 0; const chunks = [];
        resp.on('data', c => {
          size += c.length;
          if (size > MAX_BODY_BYTES) { resp.destroy(); fail(apiError(503, tag + ': the answer was too large to read')); return; }
          chunks.push(c);
        });
        resp.on('error', e => fail(apiError(503, tag + ': ' + (e && e.message ? e.message : 'connection error'))));
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          ok({ status: resp.statusCode, json: json, text: text });
        });
      });
    } catch (e) { return fail(apiError(503, tag + ': ' + ((e && e.message) || 'request failed'))); }
    req.on('timeout', () => req.destroy(apiError(503, tag + ': no answer in ' + REQUEST_TIMEOUT_MS + ' ms')));
    req.on('error', e => fail(e && e.status ? e : apiError(503, tag + ': ' + ((e && e.message) || 'connection error'))));
    if (payload) req.write(payload);
    req.end();
  });
}

// 401/403 are named for what they are: the difference between "the key is wrong" and "the provider is down" is the
// difference between five minutes and five hours of looking for the reason. The key itself is never in the text.
function checkStatus(answer, tag) {
  const st = answer.status;
  if (st >= 200 && st < 300) return answer;
  console.error('[segments] ' + tag + ' → HTTP ' + st);
  if (st === 401 || st === 403) throw apiError(503, 'Customer.io rejected the API key (HTTP ' + st + ')');
  if (st === 404) throw apiError(503, tag + ': Customer.io answered 404 — the segment may have been deleted there');
  if (st === 429) throw apiError(503, 'Customer.io is rate limiting us (HTTP 429) — try again in a minute');
  throw apiError(503, tag + ': Customer.io answered HTTP ' + st);
}

function appGet(apiPath, tag) {
  if (!APP_READY) throw apiError(503, APP_KEY ? 'CIO_API_BASE is not a usable address' : 'Customer.io App API key is not configured');
  return httpJson(APP_URL, apiPath, 'GET', { 'Authorization': 'Bearer ' + APP_KEY }, undefined, tag).then(a => checkStatus(a, tag));
}
function appPost(apiPath, body, tag) {
  if (!APP_READY) throw apiError(503, APP_KEY ? 'CIO_API_BASE is not a usable address' : 'Customer.io App API key is not configured');
  return httpJson(APP_URL, apiPath, 'POST', { 'Authorization': 'Bearer ' + APP_KEY }, body, tag).then(a => checkStatus(a, tag));
}
function trackPost(apiPath, body, tag) {
  if (!TRACK_READY) throw apiError(503, (SITE_ID && TRACK_KEY) ? 'CIO_TRACK_API_BASE is not a usable address' : 'Customer.io Track API keys are not configured');
  const basic = Buffer.from(SITE_ID + ':' + TRACK_KEY).toString('base64');
  return httpJson(TRACK_URL, apiPath, 'POST', { 'Authorization': 'Basic ' + basic }, body, tag).then(a => checkStatus(a, tag));
}
// identify — the same call, the same auth and the same address form the storefront has been writing profiles with
// since shop stage 3 (products-api.cjs, cioTrackIdentify).
function trackPut(apiPath, body, tag) {
  if (!TRACK_READY) throw apiError(503, (SITE_ID && TRACK_KEY) ? 'CIO_TRACK_API_BASE is not a usable address' : 'Customer.io Track API keys are not configured');
  const basic = Buffer.from(SITE_ID + ':' + TRACK_KEY).toString('base64');
  return httpJson(TRACK_URL, apiPath, 'PUT', { 'Authorization': 'Basic ' + basic }, body, tag).then(a => checkStatus(a, tag));
}

/* ── who exists in Customer.io, and creating the ones who do not ─────────────────────────── */

// 200 = the account knows this address, 404 = it does not. The 404 is answered before checkStatus sees it: there,
// 404 means "the segment is gone", which is a different thing and a 503.
function personExists(email) {
  if (!APP_READY) return Promise.reject(apiError(503, APP_KEY ? 'CIO_API_BASE is not a usable address' : 'Customer.io App API key is not configured'));
  const tag = 'check person';
  return httpJson(APP_URL, '/v1/customers/' + encodeURIComponent(email) + '/attributes?id_type=' + TRACK_ID_TYPE,
    'GET', { 'Authorization': 'Bearer ' + APP_KEY }, undefined, tag)
    .then(answer => {
      if (answer.status === 404) return false;
      checkStatus(answer, tag);
      return true;
    });
}

// The profile we create is the profile the order path would have created: the attributes come from
// GET /marketing/profiles, which counts them with orderAttributesFor — the very function identify uses. Nothing
// is invented here and nothing is added to the list.
function identifyBody(email, profile) {
  const body = { email: email };
  for (const key of IDENTIFY_FIELDS) {
    const v = profile ? profile[key] : undefined;
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number') { if (Number.isFinite(v)) body[key] = v; continue; }
    if (typeof v === 'boolean') { body[key] = v; continue; }
    // 1000 is a ceiling against a broken answer, not a limit of its own: products-api has already clipped every
    // one of these fields (the longest, last_products, is ten slugs of at most 64), and cutting one here would
    // send a different value than the order path sends for the same person.
    if (typeof v === 'string') { const s = cleanText(v, 1000); if (s) body[key] = s; }
  }
  return body;
}

// Everybody about to be put into a segment has to exist in Customer.io first, or the add is a no-op nobody is told
// about. `known` is the memory of one run: sync-all walks three segments over the same people, and asking the
// provider three times about the same address is three times the rate limit for the same answer.
// Only addresses that came from our own profile list are ever created — the caller passes exactly those, and the
// lookup below is what refuses anything else. Removing someone never comes through here at all.
async function ensureProfiles(emails, byEmail, known) {
  let identified = 0;
  const created = [];
  try {
    for (const email of emails) {
      let exists = known.get(email);
      if (exists === undefined) { exists = await personExists(email); known.set(email, exists); }
      if (exists) continue;
      const profile = byEmail.get(email);
      if (!profile) continue;                       // not one of ours: never invent a person out of an address
      await identifyPerson(email, profile);
      known.set(email, true);                       // created once per run, whatever the other segments say
      created.push(email);
      identified++;
    }
  } catch (e) {
    e.identified = identified;                      // how many profiles were created before the provider stopped
    throw e;
  }
  if (identified) {
    console.log('[segments] created ' + identified + ' Customer.io profile(s): ' +
      created.slice(0, 20).map(emailTag).join(' ') + (identified > 20 ? ' …' : ''));
  }
  // Read them back before the batch goes out. A profile that is still not there after three looks is reported, not
  // hidden: add_customers would answer 200 for that person and put nobody anywhere.
  // The first look is taken straight away — when the provider has already caught up there is nothing to wait for —
  // and only a profile that is still missing costs the pause before the next look.
  let pending = created.slice();
  for (let attempt = 0; attempt < IDENTIFY_CONFIRM_TRIES && pending.length; attempt++) {
    if (attempt > 0) await sleep(IDENTIFY_SETTLE_MS);
    const left = [];
    for (const email of pending) {
      let there = false;
      try { there = await personExists(email); }
      catch (e) { e.identified = identified; throw e; }
      if (!there) left.push(email);
    }
    pending = left;
  }
  return { identified: identified, pending: pending.length };
}

function identifyPerson(email, profile) {
  return trackPut('/api/v1/customers/' + encodeURIComponent(email), identifyBody(email, profile), 'create profile');
}

/* ── the profiles, from products-api ─────────────────────────────────────────────────────── */

// One list for everybody: the answer does not depend on who asked (every signed-in user sees the same CRM), so a
// preview of six segments costs one read of orders.json instead of six. Only a successful read is cached — caching
// a failure would keep the panel broken for another minute after products-api recovered.
let profilesCache = { at: 0, data: null };
let profilesInflight = null;

function requestProfiles(authHeader) {
  const tag = 'profiles';
  if (!ORDERS_URL) return Promise.reject(apiError(503, 'MARKETING_ORDERS_BASE is not a usable address'));
  const headers = {};
  if (authHeader) headers['Authorization'] = authHeader;
  else if (ADMIN_SECRET) headers['X-Admin-Secret'] = ADMIN_SECRET;
  else return Promise.reject(apiError(503, 'ADMIN_SECRET is not configured — a scheduled run cannot read the orders'));
  return httpJson(ORDERS_URL, '/msolpeptides-api/marketing/profiles', 'GET', headers, undefined, tag).then(a => {
    if (a.status === 401 || a.status === 403) throw apiError(503, 'products-api refused the request (HTTP ' + a.status + ')');
    if (a.status < 200 || a.status >= 300) throw apiError(503, 'products-api answered HTTP ' + a.status);
    const list = a.json && Array.isArray(a.json.profiles) ? a.json.profiles : null;
    if (!list) throw apiError(503, 'products-api answered with something other than a profile list');
    return list;
  });
}

function getProfiles(authHeader, opts) {
  const fresh = !!(opts && opts.fresh);
  if (!fresh && profilesCache.data && Date.now() - profilesCache.at < PROFILES_CACHE_TTL_MS) {
    return Promise.resolve(profilesCache.data);
  }
  // Single flight: six previews rendered at once must not become six reads of orders.json.
  if (profilesInflight) return profilesInflight;
  profilesInflight = requestProfiles(authHeader)
    .then(list => { profilesCache = { at: Date.now(), data: list }; return list; })
    .finally(() => { profilesInflight = null; });
  return profilesInflight;
}

/* ── storage ─────────────────────────────────────────────────────────────────────────────── */

module.exports = function createSegmentsRouter(deps) {
  const lockedUpdate = deps && deps.lockedUpdate;
  const DATA_DIR = deps && deps.DATA_DIR;
  if (typeof lockedUpdate !== 'function' || !DATA_DIR) throw new Error('marketing-segments.cjs needs { lockedUpdate, DATA_DIR }');
  const SEG_PATH = path.join(DATA_DIR, SEGMENTS_FILE);
  const LOG_PATH = path.join(DATA_DIR, LOG_FILE);
  const router = express.Router();

  // Read straight from disk rather than through the server's readJSON(): that one answers an unreadable file with
  // the fallback, and a fallback of [] handed to a write would replace every segment with nothing. Here a file that
  // exists but cannot be read is an error, and no writer runs.
  function readList(file, what) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw apiError(503, what + ' cannot be read (' + e.code + ')'); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw apiError(503, what + ' is not readable JSON — restore it by hand before saving anything'); }
    if (!Array.isArray(parsed)) throw apiError(503, what + ' is not a list — restore it by hand before saving anything');
    return parsed;
  }
  const readSegments = () => readList(SEG_PATH, 'marketing-segments.json');

  // Every write goes through the server's lockedUpdate: one queue per file, an atomic write and an audit line. The
  // list handed to fn comes from readSegments() and not from lockedUpdate's own argument for the reason above.
  function updateSegments(fn, meta) {
    return lockedUpdate(SEGMENTS_FILE, () => fn(readSegments()), meta);
  }
  function appendLog(entry) {
    return lockedUpdate(LOG_FILE, () => {
      let list;
      try { list = readList(LOG_PATH, 'marketing-log.json'); }
      catch (e) { list = []; }                          // the log is a diary, not data: a broken one starts again
      list.push(entry);
      return list.slice(-LOG_RING);
    }).then(r => { if (r && r.ok === false) console.error('[segments] the run log could not be written'); })
      .catch(e => { console.error('[segments] could not write the run log:', e.message); });
  }

  function findSegment(list, id) {
    const seg = list.find(s => s && s.id === id);
    if (!seg) throw apiError(404, 'No such segment');
    return seg;
  }

  // What the client sees. cio_segment_id is not a secret (it is in the interface URL), the stored member list is
  // not sent: it is a list of customer addresses and the page has no use for it.
  function view(seg) {
    return {
      id: seg.id, name: seg.name, description: seg.description || '', match: seg.match, rules: seg.rules || [],
      builtin: !!seg.builtin, cio_segment_id: seg.cio_segment_id === undefined ? null : seg.cio_segment_id,
      cio_url: segmentUrl(seg.cio_segment_id),
      last_sync: seg.last_sync || null,
      rule_words: (seg.rules || []).map(ruleWords),
      created_at: seg.created_at || null, updated_at: seg.updated_at || null
    };
  }

  /* ── seeding the built-ins ─────────────────────────────────────────────────────────────── */

  // Only when the file is not there at all. A file that exists is never touched by this — including a file that
  // cannot be parsed, where "seed the defaults" would mean "throw the owner's segments away".
  if (!fs.existsSync(SEG_PATH)) {
    const stamp = nowIso();
    lockedUpdate(SEGMENTS_FILE, list => {
      if (fs.existsSync(SEG_PATH) || (Array.isArray(list) && list.length)) return null;   // someone got there first
      return BUILTINS.map(b => Object.assign({}, b, {
        rules: b.rules.map(r => Object.assign({}, r)),
        builtin: true, cio_segment_id: null, last_sync: null, created_at: stamp, updated_at: stamp
      }));
    }, { action: 'marketing_segments_seed', user: 'system', details: 'built-in segments created' })
      .then(r => {
        if (r && r.ok === false) console.error('[segments] the built-in segments could not be written to disk');
        else if (r && !r.skipped) console.log('✅ marketing-segments: created ' + BUILTINS.length + ' built-in segments');
      })
      .catch(e => console.error('[segments] could not create the built-in segments:', e.message));
  }

  /* ── syncing one segment ───────────────────────────────────────────────────────────────── */

  // The manual segment in Customer.io, created once. A segment with the same name that is already there is adopted
  // instead of creating a second one: the previous run may have created it and lost the answer on the way back, and
  // two segments called "VIP (CRM)" would leave the owner's campaign wired to the one nobody fills.
  async function ensureCioSegment(seg) {
    const listed = await appGet('/v1/segments', 'list segments');
    const all = (listed.json && (listed.json.segments || listed.json.data)) || [];
    const wanted = String(seg.name || '').trim().toLowerCase();
    const found = Array.isArray(all) ? all.find(s => s && String(s.name || '').trim().toLowerCase() === wanted) : null;
    if (found && (found.id !== undefined && found.id !== null)) {
      console.log('[segments] adopted an existing Customer.io segment for "' + seg.name + '"');
      return found.id;
    }
    // Documented shape of "create a manual segment": { segment: { name, description } }. Not verified on the live
    // account — the first live run is the one to watch (see the report). A flat { name, description } is the
    // fallback if this ever answers 400.
    const made = await appPost('/v1/segments', { segment: { name: seg.name, description: seg.description || '' } }, 'create segment');
    const id = made.json && ((made.json.segment && made.json.segment.id) !== undefined ? made.json.segment.id : made.json.id);
    if (id === undefined || id === null || id === '') throw apiError(503, 'Customer.io created the segment but did not say which one');
    return id;
  }

  // Who Customer.io thinks is in the segment. The live answer (our manual segment, 2026-09-08) is
  //     {"segment_id":17,"ids":["",""],"identifiers":[{"cio_id":"…","email":"a@b"},…],"next":""}
  // — the ids are empty strings and the addresses live in identifiers[]. identifiers is therefore the membership;
  // an empty id is not a person we failed to recognise but a field this workspace does not fill, and a record with
  // no address of any kind is counted as unknown and left exactly where it is: removing someone we cannot name is
  // the one mistake in this file that cannot be undone from here.
  // `next` came back as an empty string there, which is the ordinary end of the list; the name of the request
  // parameter (?start=) is still the documented one and has not been seen answering. If it is wrong, `next` never
  // moves us on and one page is all we read (harmless); if it came back unchanged we would ask for the same page
  // until MAX_MEMBERSHIP_PAGES — fifty identical requests per segment. A cursor that does not move ends the loop
  // and the run says so, because a membership we only half read is exactly the state in which "who is missing"
  // must not be trusted.
  async function readMembership(cioId) {
    const emails = new Set();
    const seenCursors = new Set();
    let unknown = 0, start = '', pages = 0, warn = null;
    for (;;) {
      const q = '?limit=' + MEMBERSHIP_PAGE + (start ? '&start=' + encodeURIComponent(start) : '');
      const answer = await appGet('/v1/segments/' + encodeURIComponent(String(cioId)) + '/membership' + q, 'read membership');
      const json = answer.json || {};
      const idents = json.identifiers;
      const identList = Array.isArray(idents) ? idents : (idents && typeof idents === 'object' ? Object.values(idents) : []);
      for (const one of identList) {
        const v = normEmail(one && typeof one === 'object' ? one.email : one);
        if (looksLikeEmail(v)) emails.add(v); else unknown++;   // a member with no address: reported, never removed
      }
      // Only when the answer carries no identifiers at all — an older shape, or a workspace that does put the
      // addresses in ids. An empty id is skipped rather than counted: this account sends one for every member.
      if (!identList.length) {
        for (const raw of (Array.isArray(json.ids) ? json.ids : [])) {
          const v = normEmail(typeof raw === 'object' && raw ? (raw.email || raw.id) : raw);
          if (!v) continue;
          if (looksLikeEmail(v)) emails.add(v); else unknown++;
        }
      }
      pages++;
      const next = typeof json.next === 'string' ? json.next : '';
      if (!next) break;                                  // the ordinary end of the list
      if (next === start || seenCursors.has(next)) {
        warn = 'the membership pages stopped moving after ' + pages + ' (the cursor came back the same) — ' +
               emails.size + ' addresses were read, so who is missing from the segment is not known';
        break;
      }
      seenCursors.add(next);
      start = next;
      if (pages >= MAX_MEMBERSHIP_PAGES) {
        warn = 'the membership is longer than ' + (MAX_MEMBERSHIP_PAGES * MEMBERSHIP_PAGE) + ' people — only the first ' +
               emails.size + ' addresses were read';
        break;
      }
    }
    return { emails: emails, unknown: unknown, source: 'customer.io', warn: warn };
  }

  async function membershipOrLastSent(seg, cioId) {
    try {
      return await readMembership(cioId);
    } catch (e) {
      const stored = Array.isArray(seg.last_members) ? seg.last_members.filter(looksLikeEmail) : null;
      if (!stored) throw e;                              // nothing to fall back on: refuse rather than guess
      console.error('[segments] membership of "' + seg.name + '" unavailable (' + e.message + ') — using the last list we sent');
      return { emails: new Set(stored), unknown: 0, source: 'last sent list' };
    }
  }

  async function pushBatches(cioId, list, what) {
    let done = 0;
    for (let i = 0; i < list.length; i += MEMBER_BATCH) {
      const chunk = list.slice(i, i + MEMBER_BATCH);
      try {
        await trackPost('/api/v1/segments/' + encodeURIComponent(String(cioId)) + '/' + what + '_customers?id_type=' + TRACK_ID_TYPE,
          { ids: chunk }, what + ' customers');
      } catch (e) {
        e.partial = done;                                // how many made it before the provider stopped answering
        throw e;
      }
      done += chunk.length;
    }
    return done;
  }

  // Result: { size, added, removed, identified, unknown, source, error }. Never throws for a Customer.io failure — the
  // caller has to write last_sync first and answer 503 second, or a half-finished run would leave no trace at all.
  async function runSync(seg, profiles, opts, known) {
    const force = !!(opts && opts.force);
    const seen = known instanceof Map ? known : new Map();     // who Customer.io already knew, within this run
    const out = { size: 0, added: 0, removed: 0, identified: 0, unknown: 0, source: null, error: null, members: null };
    const members = membersOf(seg, profiles);
    out.size = members.length;
    out.members = members;
    try {
      let cioId = seg.cio_segment_id;
      if (cioId === null || cioId === undefined || cioId === '') {
        cioId = await ensureCioSegment(seg);
        // Written down before a single member is sent: if the process dies here, the next run adopts this id
        // instead of creating a second segment.
        const linked = await updateSegments(list => {
          const s = list.find(x => x && x.id === seg.id);
          if (!s) return null;
          s.cio_segment_id = cioId; s.updated_at = nowIso();
          return list;
        }, { action: 'marketing_segment_linked', user: 'system', details: seg.id + ' → Customer.io segment ' + cioId });
        if (linked && linked.ok === false) {
          throw apiError(503, 'Customer.io segment ' + cioId + ' was created but could not be written into marketing-segments.json — ' +
            'fix the file, put cio_segment_id ' + cioId + ' on ' + seg.id + ' by hand, then sync again (a run now would create a second segment of the same name)');
        }
        seg.cio_segment_id = cioId;
      }
      const remote = await membershipOrLastSent(seg, cioId);
      out.source = remote.source;
      out.unknown = remote.unknown;
      const wanted = new Set(members);
      const toAdd = members.filter(e => !remote.emails.has(e));
      const toRemove = Array.from(remote.emails).filter(e => !wanted.has(e));
      const refuse = (why) => {
        out.error = why + (remote.warn ? ' (' + remote.warn + ')' : '') +
          ' Nothing was sent, in either direction. Look at the preview first; if this really is what the rules now say, sync again with {"force":true}.';
        out.members = null;                            // nothing went out: last_members must keep the real list
        return out;
      };
      if (!force && !members.length && remote.emails.size > 0) {
        return refuse('Refusing to empty this segment: nobody matches the rules now, ' + remote.emails.size +
          ' people are in it. Check the order history — a truncated orders.json reads as "nobody ordered anything".');
      }
      if (!force && remote.emails.size >= REMOVE_GUARD_MIN && toRemove.length > Math.floor(remote.emails.size / 2)) {
        return refuse('Refusing to take ' + toRemove.length + ' of ' + remote.emails.size + ' people out of this segment in one run.');
      }
      // Before the batch: everyone in it has to be somebody Customer.io knows, or the add is a silent no-op. This
      // creates profiles in the account — deliberately, and only for addresses of our own list — so the number is
      // reported as `identified` and written into last_sync.
      let notConfirmed = 0;
      if (toAdd.length) {
        const byEmail = new Map();
        for (const p of profiles) {
          if (!p || typeof p !== 'object') continue;
          const addr = normEmail(p.email);
          if (addr) byEmail.set(addr, p);
        }
        try {
          const ensured = await ensureProfiles(toAdd, byEmail, seen);
          out.identified = ensured.identified;
          notConfirmed = ensured.pending;
        } catch (e) {
          out.identified = e.identified || 0;
          out.error = 'created ' + out.identified + ' of the missing profiles, then ' + e.message +
            ' — nobody was added or removed in this run.';
          return out;
        }
      }
      try {
        out.added = await pushBatches(cioId, toAdd, 'add');
      } catch (e) {
        out.added = e.partial || 0;
        out.error = 'added ' + out.added + ' of ' + toAdd.length + ', then ' + e.message;
        return out;
      }
      try {
        out.removed = await pushBatches(cioId, toRemove, 'remove');
      } catch (e) {
        out.removed = e.partial || 0;
        out.error = 'added ' + out.added + ', removed ' + out.removed + ' of ' + toRemove.length + ', then ' + e.message;
        return out;
      }
      // Both batches went out, but the list we compared them against was not the whole segment. The numbers
      // above are honest about what we sent and this says what we could not see — a run that looks clean here
      // and leaves strangers in the segment is the kind of silence this module exists to avoid.
      const notes = [];
      if (notConfirmed) {
        notes.push(notConfirmed + ' of the ' + out.identified + ' profiles created here could not be read back after ' +
          IDENTIFY_CONFIRM_TRIES + ' checks — Customer.io may not have them yet, and those people are probably not in the ' +
          'segment. The next sync adds them.');
      }
      if (remote.warn) notes.push(remote.warn);
      if (notes.length) out.error = notes.join(' ');
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }

  // last_sync and the run log are written whatever happened, including the failures — an owner looking at the page
  // has to be able to tell "nothing changed" from "we could not talk to Customer.io".
  async function recordSync(segId, result, actor) {
    const at = nowIso();
    const last = {
      at: at, size: result.size, added: result.added, removed: result.removed,
      identified: result.identified || 0,          // profiles this run created in Customer.io (M2d)
      error: result.error || null
    };
    if (result.unknown) last.unknown_members = result.unknown;
    if (result.source) last.source = result.source;
    let name = segId;
    const written = await updateSegments(list => {
      const s = list.find(x => x && x.id === segId);
      if (!s) return null;
      name = s.name;
      s.last_sync = last;
      // What was sent, so a run whose membership read fails still has something to diff against. A list longer
      // than MAX_STORED_MEMBERS is not kept: the file is read on every request, and at that size an unreadable
      // membership means an honest refusal, not a diff against a truncated list.
      if (!result.error && Array.isArray(result.members)) {
        if (result.members.length <= MAX_STORED_MEMBERS) { s.last_members = result.members; delete s.last_members_truncated; }
        else { delete s.last_members; s.last_members_truncated = true; }
      }
      s.updated_at = at;
      return list;
    }, { action: 'marketing_segment_synced', user: actor || 'system', details: segId + ': ' + result.size + ' members, +' + result.added + ' -' + result.removed + (result.identified ? ', ' + result.identified + ' new in Customer.io' : '') + (result.error ? ' (error)' : '') });
    if (written && written.ok === false) {
      last.error = (last.error ? last.error + '; ' : '') + 'the result of this run could not be written to marketing-segments.json';
    }
    await appendLog({
      at: at, segment_id: segId, name: name, size: result.size, added: result.added,
      removed: result.removed, identified: result.identified || 0, error: result.error || null, actor: actor || 'system'
    });
    return last;
  }

  async function syncOne(segId, authHeader, actor, opts) {
    const profiles = await getProfiles(authHeader);      // a 503 here stops before anything is written
    const seg = findSegment(readSegments(), segId);
    const result = await runSync(seg, profiles, opts, new Map());
    const last = await recordSync(seg.id, result, actor);
    return { id: seg.id, name: seg.name, last_sync: last, cio_segment_id: seg.cio_segment_id === undefined ? null : seg.cio_segment_id };
  }

  /* ── the scheduler ─────────────────────────────────────────────────────────────────────── */

  let syncRunning = false;
  async function runAll(authHeader, actor, opts) {
    if (syncRunning) throw apiError(409, 'A sync is already running — try again in a moment');
    syncRunning = true;
    try {
      const profiles = await getProfiles(authHeader, { fresh: true });
      const list = readSegments();
      const results = [];
      const known = new Map();                            // one memory of "who is in the account" for the whole run
      for (const seg of list) {
        const result = await runSync(seg, profiles, opts, known);
        const last = await recordSync(seg.id, result, actor);
        results.push({ id: seg.id, name: seg.name, size: last.size, added: last.added, removed: last.removed, identified: last.identified, error: last.error });
      }
      return results;
    } finally {
      syncRunning = false;
    }
  }

  if (SYNC_INTERVAL_MIN > 0) {
    const timer = setInterval(() => {
      // No session behind a scheduled run: it authenticates to products-api with the shared ADMIN_SECRET, the same
      // secret products-api already accepts from the CRM (products-api.cjs, secretMatches).
      // Never with force: a floor that a timer can step over is not a floor.
      runAll(null, 'scheduler', { force: false }).then(results => {
        const bad = results.filter(r => r.error);
        console.log('[segments] scheduled sync: ' + results.length + ' segments, ' + bad.length + ' with errors');
      }).catch(e => {
        // An hourly timer must never be the thing that takes blitz-api down: every failure ends here, in a line.
        console.error('[segments] scheduled sync failed:', e.message);
      });
    }, SYNC_INTERVAL_MIN * 60 * 1000);
    if (timer.unref) timer.unref();                      // the HTTP server keeps the process alive; this must not
    console.log('[segments] scheduled sync every ' + SYNC_INTERVAL_MIN + ' min');
  } else {
    console.log('[segments] scheduled sync is off (MARKETING_SYNC_INTERVAL_MIN=0)');
  }

  /* ── routes ────────────────────────────────────────────────────────────────────────────── */

  function fail(res, e) {
    const status = Number.isInteger(e && e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
    const message = (status === 500 && !(e && e.expose)) ? 'Internal server error' : (e && e.message ? e.message : 'Request failed');
    if (status === 500) console.error('[segments] ' + (e && e.stack ? e.stack : e));
    res.status(status).json({ error: message });
  }
  function idOf(req) {
    const id = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw apiError(404, 'No such segment');
    return id;
  }
  const actorOf = req => (req.userSession && req.userSession.email) || 'unknown';

  // GET / — the list, plus what the page needs to build a rule editor and to tell the user what is configured.
  router.get('/', (req, res) => {
    try {
      const list = readSegments();
      res.json({
        segments: list.map(view),
        count: list.length,
        fields: Object.keys(FIELDS).map(k => ({ field: k, label: FIELDS[k].label, type: FIELDS[k].type, ops: FIELDS[k].ops, warn: FIELDS[k].warn || null })),
        config: {
          app_key_present: !!APP_KEY, track_keys_present: !!(SITE_ID && TRACK_KEY),
          sync_interval_min: SYNC_INTERVAL_MIN, workspace_id: WORKSPACE_ID
        }
      });
    } catch (e) { fail(res, e); }
  });

  // GET /log — the last runs, newest first. The file is a ring of 200; the page shows a page of it.
  router.get('/log', (req, res) => {
    try {
      let list;
      try { list = readList(LOG_PATH, 'marketing-log.json'); } catch (e) { list = []; }
      res.json({ entries: list.slice(-50).reverse() });
    } catch (e) { fail(res, e); }
  });

  router.post('/', async (req, res) => {
    try {
      const fields = validateBody(req.body, null);
      const stamp = nowIso();
      const id = 'mseg_' + crypto.randomBytes(6).toString('hex');
      let created = null;
      await updateSegments(list => {
        if (list.length >= 100) throw apiError(400, 'No more than 100 segments');
        if (list.some(s => s && String(s.name || '').trim().toLowerCase() === fields.name.toLowerCase())) {
          throw apiError(409, 'A segment with that name already exists');
        }
        created = {
          id: id, name: fields.name, description: fields.description || '', match: fields.match,
          rules: fields.rules, builtin: false, cio_segment_id: null, last_sync: null,
          created_at: stamp, updated_at: stamp
        };
        list.push(created);
        return list;
      }, { action: 'marketing_segment_created', user: actorOf(req), details: id + ' "' + fields.name + '"' }).then(assertWritten);
      res.status(201).json({ segment: view(created) });
    } catch (e) { fail(res, e); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const before = findSegment(readSegments(), id);
      const fields = validateBody(req.body, before);
      // A built-in keeps its name: a campaign in Customer.io is wired to the segment by the name the owner saw
      // when building it, and the segment there is not renamed by this route either.
      if (before.builtin && fields.name !== undefined && fields.name !== before.name) {
        throw apiError(400, 'A built-in segment keeps its name; its rules can be changed');
      }
      let updated = null;
      await updateSegments(list => {
        const s = findSegment(list, id);
        if (fields.name !== undefined && !s.builtin) {
          if (list.some(x => x && x.id !== id && String(x.name || '').trim().toLowerCase() === fields.name.toLowerCase())) {
            throw apiError(409, 'A segment with that name already exists');
          }
          s.name = fields.name;
        }
        if (fields.description !== undefined) s.description = fields.description;
        if (fields.match !== undefined) s.match = fields.match;
        if (fields.rules !== undefined) s.rules = fields.rules;
        s.updated_at = nowIso();
        updated = s;
        return list;
      }, { action: 'marketing_segment_updated', user: actorOf(req), details: id }).then(assertWritten);
      res.json({ segment: view(updated) });
    } catch (e) { fail(res, e); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = idOf(req);
      let removed = null;
      await updateSegments(list => {
        const s = findSegment(list, id);
        if (s.builtin) throw apiError(400, 'A built-in segment cannot be deleted; empty its rules if it is in the way');
        removed = s;
        return list.filter(x => x !== s);
      }, { action: 'marketing_segment_deleted', user: actorOf(req), details: id }).then(assertWritten);
      // The manual segment in Customer.io is left where it is. Deleting it from here would break whatever campaign
      // the owner has pointed at it, and the API gives us no way to know what that is.
      res.json({
        ok: true, id: id,
        note: removed && removed.cio_segment_id ? 'The segment in Customer.io was left in place — delete it there if it is no longer needed.' : null
      });
    } catch (e) { fail(res, e); }
  });

  router.get('/:id/preview', async (req, res) => {
    try {
      const id = idOf(req);
      const seg = findSegment(readSegments(), id);
      const profiles = await getProfiles(req.headers.authorization);
      const members = membersOf(seg, profiles);
      res.json({
        id: seg.id, count: members.length, total_profiles: profiles.length,
        // Full addresses (2026-09-09, owner's decision). A preview exists to answer "who exactly gets this
        // letter" before a send, and masked addresses could not answer it; the same people are listed in
        // full on Orders, Leads and Customers, two tabs away, so nothing was being protected. Log lines
        // and the audit trail keep maskEmail()/emailTag().
        sample: members.slice(0, SAMPLE_SIZE),
        sample_masked: members.slice(0, SAMPLE_SIZE).map(maskEmail),
        computed_at: nowIso()
      });
    } catch (e) { fail(res, e); }
  });

  // GET /:id/members — the same membership as the preview, page by page and searchable. A preview says "three
  // hundred" and shows twenty; that is an answer about the size of a segment and no answer at all about who is in
  // it. Read-only: nothing here writes a file and nothing here talks to Customer.io — this is the CRM's own reading
  // of the orders, i.e. exactly the list Sync would send.
  router.get('/:id/members', async (req, res) => {
    try {
      const id = idOf(req);
      const seg = findSegment(readSegments(), id);
      const offset = intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(req.query.limit, MEMBERS_PAGE, 1, MEMBERS_PAGE_MAX);
      // Lower case, because membersOf() normalises every address it returns: a search typed in capitals would
      // otherwise match nobody. The answer echoes the fragment that was actually applied, not the raw parameter.
      const q = normEmail(cleanText(req.query.q, MEMBERS_QUERY_MAX));
      const profiles = await getProfiles(req.headers.authorization);
      // Sorted and de-duplicated by membersOf. That order is what makes paging safe: an unordered list read twice
      // would hand the second page a different arrangement, and the reader would see some people twice and miss
      // others. The recount per request is deliberate — the profiles behind it are a minute old at most.
      const all = membersOf(seg, profiles);
      const matched = q ? all.filter(e => e.indexOf(q) !== -1) : all;
      // The addresses are the point of this route, so they are the one thing this line must not carry. The length
      // of the query says a search happened without repeating what was typed — a fragment of an address is one too.
      console.log('[segments] members ' + id + ': ' + matched.length + ' of ' + all.length +
                  ', offset ' + offset + ', limit ' + limit + ', query ' + q.length + ' chars');
      res.json({
        id: seg.id,
        count: matched.length,                 // the size after the filter: what the reader is paging through
        total_profiles: profiles.length,
        offset: offset, limit: limit, q: q,
        members: matched.slice(offset, offset + limit),
        computed_at: nowIso()
      });
    } catch (e) { fail(res, e); }
  });

  const forceOf = req => !!(req.body && req.body.force === true);

  router.post('/sync-all', async (req, res) => {
    try {
      const results = await runAll(req.headers.authorization, actorOf(req), { force: forceOf(req) });
      res.json({ results: results, ok_count: results.filter(r => !r.error).length, error_count: results.filter(r => r.error).length });
    } catch (e) { fail(res, e); }
  });

  router.post('/:id/sync', async (req, res) => {
    try {
      const id = idOf(req);
      if (syncRunning) throw apiError(409, 'A sync is already running — try again in a moment');
      syncRunning = true;
      let answer;
      try { answer = await syncOne(id, req.headers.authorization, actorOf(req), { force: forceOf(req) }); }
      finally { syncRunning = false; }
      // The run is on record either way; the status code says whether it finished.
      if (answer.last_sync && answer.last_sync.error) {
        res.status(503).json({ error: answer.last_sync.error, result: answer });
        return;
      }
      res.json({ result: answer });
    } catch (e) { fail(res, e); }
  });

  return router;
};

// Exported for the local test stand only: the matcher and the rule validator are the part worth testing without a
// server around them. Nothing on the server requires this file for these.
module.exports._internals = { FIELDS, BUILTINS, matchRule, matchProfile, membersOf, validateRule, validateBody, maskEmail, ruleWords };
