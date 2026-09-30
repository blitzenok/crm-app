/**
 * BioLabs Research CRM — letter texts and person actions in Customer.io (M4, 2026-09-08).
 *
 * Mounted by server_v14.cjs as two routers behind the session gate:
 *     const marketingEmails = require('./marketing-emails.cjs')({ DATA_DIR, lockedUpdate, writeAuditLog });
 *     app.use('/api/marketing/emails', requireAuth, marketingEmails.emails);
 *     app.use('/api/marketing/people', requireAuth, marketingEmails.people);
 * Role is not checked — phase 5 (EQUAL_RIGHTS): everyone signed in sees and does the same in the CRM.
 *
 * What it does: lists the letters of the Customer.io journeys, lets a letter's subject / preheader / body be
 * rewritten, keeps the previous versions so a bad edit can be taken back, sends a copy of a draft to the person
 * who is signed in, and marks a person unsubscribed or deletes them from Customer.io.
 *
 * What it deliberately does NOT do:
 *   - transactional messages (the order letters customers receive) are edited through marketing-emails-tx.cjs (stage 1 RET,
 *     2026-09-30): same version ring and audit as a journey letter, plus a check of the {{ trigger.* }} fields against the
 *     contract of the order letters. Their routes are mounted at the end of this module.
 *   - it never creates a person. The Track API's PUT is an upsert, so both person actions look the address up
 *     in the App API first and answer 404 when Customer.io has never seen it (see personIsKnown).
 *   - it never touches data/leads.json. Unsubscribing or deleting a person in Customer.io leaves the CRM lead
 *     exactly where it was — that file belongs to the boss's own module, and both routes say so in their answer.
 *   - it does not create, start, pause or delete journeys: that lives in the Customer.io interface.
 *
 * Rules kept throughout (same as the M1 panel):
 *   - neither API key ever reaches the client or a log line; a person's address is logged as 8 hex of its sha256,
 *     while the audit line (admin-only, /api/audit) carries the address itself — that is the convention of the
 *     rest of this server, and an audit that says only "a customer" cannot answer "who was deleted";
 *   - 429 / 5xx / network / timeout from Customer.io answer 503, never a pretend success;
 *   - a letter is backed up from the *live* values read a moment earlier, not from what the browser believed;
 *   - if the version history cannot be read, the letter is not overwritten at all (see readRing).
 *
 * Config (all from /opt/crm-api/.env, loaded into process.env by server_v14.cjs at startup, so a change there
 * needs `pm2 restart blitz-api`):
 *   CIO_APP_API_KEY       Bearer key of the App API — letters and the test send
 *   CIO_SITE_ID           Track API pair — unsubscribe / delete a person
 *   CIO_TRACKING_API_KEY
 *   CIO_REGION            'eu' switches both default hosts to their EU twins
 *   CIO_API_BASE          overrides the App API host; also the seam the local stand points at its stub
 *   CIO_TRACK_API_BASE    the same for the Track API
 *   CIO_TEST_FROM         From: of the test letter (default 'BioLabs Research <admin@biolabsresearch.co>')
 *
 * ⚠️ Shapes marked "verify on the live account" in the comments below are the ones no request of ours has yet
 * confirmed. Confirmed by our own 07.09 push and its saved copies: GET /v1/campaigns,
 * GET /v1/campaigns/{id}/actions -> { actions: [ {id, campaign_id, name, subject, preheader_text, body, from,
 * type, sending_state, created, updated, layout, ...} ] }, PUT /v1/campaigns/{id}/actions/{action_id}.
 */
'use strict';

const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const authUtils = require('./auth-utils.cjs');   // normalizeEmail / isValidEmail — here since phase 2
const txLetters = require('./marketing-emails-tx.cjs');   // order letters, stage 1 RET (2026-09-30)

/* ── configuration ───────────────────────────────────────────────────────────────────────── */

const APP_KEY = String(process.env.CIO_APP_API_KEY || '').trim();
const SITE_ID = String(process.env.CIO_SITE_ID || '').trim();
const TRACK_KEY = String(process.env.CIO_TRACKING_API_KEY || '').trim();
const REGION = String(process.env.CIO_REGION || 'us').trim().toLowerCase();
const TEST_FROM = String(process.env.CIO_TEST_FROM || 'BioLabs Research <admin@biolabsresearch.co>').trim();

const BACKUP_FILE = 'marketing-email-backups.json';
const RING_PER_ACTION = 20;                  // versions kept per letter
const RING_MAX_BYTES = 4 * 1024 * 1024;      // and a ceiling for the whole file, see trimRing()
const MAX_SUBJECT = 300;
const MAX_PREHEADER = 300;
const MAX_BODY_BYTES = 200 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;  // an answer larger than this is a mistake, not data
const LIST_CACHE_TTL_MS = 300 * 1000;        // subjects and sending states do not change between minutes;
                                             // the Refresh button asks with ?fresh=1 and reads past this
const MAX_CAMPAIGNS_FANOUT = 40;             // journeys whose letters are fetched on one list call
const FANOUT_PARALLEL = 6;
const OUTGOING_PER_SEC = 3;                  // process-wide brake, see takeToken()
const OUTGOING_BURST = 2;

// The same rule products-api uses for its Customer.io hosts: https anywhere, plain http only to this machine.
// .env is edited by other root agents too, and one mistyped http:// host would put a key on the wire in clear.
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

const APP_READY = !!(APP_KEY && APP_URL);
const TRACK_READY = !!(SITE_ID && TRACK_KEY && TRACK_URL);

/* ── small helpers ───────────────────────────────────────────────────────────────────────── */

// A person's address never goes into a log line — this does.
function mask(email) { return crypto.createHash('sha256').update(String(email || '')).digest('hex').slice(0, 8); }

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// Thrown when Customer.io could not answer at all (timeout, network, 429, 5xx) or answered in a way that leaves
// us unable to tell the truth. Routes turn it into 503 — never into a pretend success.
class Upstream extends Error {
  constructor(message, status) { super(message); this.name = 'Upstream'; this.upstreamStatus = status || 0; }
}

function fail(res, e, tag) {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  if (e instanceof Upstream) return res.status(503).json({ error: e.message });
  console.error('[marketing-emails] ' + (tag || 'request') + ' failed: ' + ((e && e.message) || 'error'));
  return res.status(500).json({ error: 'Internal server error' });
}

/* ── transport ───────────────────────────────────────────────────────────────────────────── */

// Both APIs are reached with the same key material the storefront uses for the order letters, and Customer.io
// allows roughly ten calls a second per account. Editing letters is a slow, human activity, so this module keeps
// a deliberately small share of that budget rather than racing a buyer's order letter into a 429.
let tokens = OUTGOING_BURST;
let tokensAt = Date.now();
function takeToken() {
  return new Promise(resolve => {
    const tick = () => {
      const now = Date.now();
      tokens = Math.min(OUTGOING_BURST, tokens + (now - tokensAt) * OUTGOING_PER_SEC / 1000);
      tokensAt = now;
      if (tokens >= 1) { tokens -= 1; return resolve(); }
      setTimeout(tick, Math.max(20, Math.ceil((1 - tokens) * 1000 / OUTGOING_PER_SEC))).unref?.();
    };
    tick();
  });
}

// One request to Customer.io. Resolves { status, data, raw } for any HTTP answer we managed to read; throws
// Upstream when there was no usable answer at all. The Authorization header is built here and nowhere else.
async function cioRequest(base, subPath, { method = 'GET', auth, payload, logTag } = {}) {
  await takeToken();
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = { 'Authorization': auth, 'Accept': 'application/json' };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(body.length); }
  const opts = {
    protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
    path: base.pathname.replace(/\/+$/, '') + subPath,
    method, headers, timeout: REQUEST_TIMEOUT_MS
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    let req;
    try {
      req = (base.protocol === 'https:' ? https : http).request(opts, resp => {
        const chunks = [];
        let size = 0;
        resp.on('data', c => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) { resp.destroy(); return done(reject, new Upstream('Customer.io sent more data than expected')); }
          chunks.push(c);
        });
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
          if (logTag) console.log('[marketing-emails] ' + logTag + ' → HTTP ' + resp.statusCode);
          done(resolve, { status: resp.statusCode || 0, data, raw });
        });
        resp.on('error', e => done(reject, new Upstream('Customer.io connection broke (' + ((e && e.message) || 'error') + ')')));
      });
    } catch (e) {
      return done(reject, new Upstream('Customer.io could not be reached (' + ((e && e.message) || 'error') + ')'));
    }
    req.on('timeout', () => req.destroy(new Error('timed out after ' + REQUEST_TIMEOUT_MS + ' ms')));
    req.on('error', e => done(reject, new Upstream('Customer.io could not be reached (' + ((e && e.message) || 'error') + ')')));
    if (body) req.write(body);
    req.end();
  });
}

const appAuth = () => 'Bearer ' + APP_KEY;
const trackAuth = () => 'Basic ' + Buffer.from(SITE_ID + ':' + TRACK_KEY).toString('base64');

// Turns an HTTP answer into data or into the honest reason we have none. allow404 is for the two places where a
// missing thing is an answer in itself (a letter that is not there, a person Customer.io never heard of).
function appResult(r, what, { allow404 = false } = {}) {
  if (r.status >= 200 && r.status < 300) return r.data;
  if (r.status === 404 && allow404) return null;
  if (r.status === 401 || r.status === 403) throw new Upstream('Customer.io rejected the API key (HTTP ' + r.status + ')', r.status);
  if (r.status === 429) throw new Upstream('Customer.io is rate limiting us (HTTP 429) — try again in a minute', 429);
  if (r.status >= 500) throw new Upstream('Customer.io is not answering (HTTP ' + r.status + ')', r.status);
  // 400/404/409 on a write: the provider's own words are the only useful diagnosis, so they are passed on.
  const detail = r.data && (r.data.meta && r.data.meta.error || r.data.error || r.data.message);
  throw httpError(r.status === 404 ? 404 : 400, 'Customer.io refused ' + what + ' (HTTP ' + r.status + (detail ? ': ' + String(detail).slice(0, 200) : '') + ')');
}

function requireAppKeys() {
  if (APP_KEY && !APP_URL) throw httpError(503, 'CIO_API_BASE/CIO_REGION is not a usable address — see the blitz-api log');
  if (!APP_READY) throw httpError(503, 'Customer.io not configured (CIO_APP_API_KEY missing in /opt/crm-api/.env)');
}
function requireTrackKeys() {
  if (SITE_ID && TRACK_KEY && !TRACK_URL) throw httpError(503, 'CIO_TRACK_API_BASE/CIO_REGION is not a usable address — see the blitz-api log');
  if (!TRACK_READY) throw httpError(503, 'Customer.io tracking not configured (CIO_SITE_ID / CIO_TRACKING_API_KEY missing in /opt/crm-api/.env)');
}

/* ── validation ──────────────────────────────────────────────────────────────────────────── */

const ID_RE = /^[0-9]{1,12}$/;                       // Customer.io ids are numbers; this also keeps the path ours
// Control characters that have no business in a letter. \t \n \r are allowed in a body (HTML files are full of
// them); a subject or a preheader gets none at all — a newline there is the classic mail-header injection.
const CTRL_BODY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CTRL_LINE = /[\x00-\x1f\x7f]/;

function readId(v, what) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!ID_RE.test(s)) throw httpError(400, what + ' must be a number');
  return s;
}

// The subject and the preheader travel base64 for the same reason the body does, and it is not symmetry for
// its own sake: the shared sanitizer trims both ends of every string it sees. A subject saved with a
// deliberate trailing space would reach Customer.io without it, and the "nothing changed" test below would
// then compare a trimmed line with an untrimmed one, burn a version and write the letter again on every
// Save. The plain field is refused rather than quietly repaired, exactly like a plain body.
function readLineB64(obj, plainField, b64Field, max) {
  if (obj[plainField] !== undefined) {
    throw httpError(400, 'Send ' + plainField + ' as ' + b64Field + ' (base64 of the UTF-8 text). A plain "' + plainField + '" field is trimmed and filtered by the shared input sanitizer before this route sees it, which would save a quietly different line.');
  }
  const raw = obj[b64Field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw httpError(400, b64Field + ' must be a string');
  const clean = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw httpError(400, b64Field + ' is not valid base64');
  const v = Buffer.from(clean, 'base64').toString('utf8');
  if (CTRL_LINE.test(v)) throw httpError(400, plainField + ' must not contain line breaks or control characters');
  if (v.length > max) throw httpError(400, plainField + ' is longer than ' + max + ' characters');
  return v;
}

// The letter body arrives base64-encoded, and that is not decoration. server_v14.cjs runs every JSON body through
// sanitizeValue() before any route sees it: it deletes <script> blocks, on…="…" attributes and javascript: URIs
// and trims the ends. For ordinary CRM forms that is a sensible guard; for an e-mail template it is silent damage
// — an edit would save a quietly different letter over the live one, and nobody would see it until it was sent.
// Base64 has none of those patterns, so what the browser typed is what this module PUTs.
function readBody(obj) {
  if (obj.body !== undefined) {
    throw httpError(400, 'Send the letter as body_b64 (base64 of the UTF-8 text). A plain "body" field is filtered by the shared input sanitizer before this route sees it, which would silently change the template.');
  }
  if (obj.body_b64 === undefined || obj.body_b64 === null) return undefined;
  if (typeof obj.body_b64 !== 'string') throw httpError(400, 'body_b64 must be a string');
  const clean = obj.body_b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw httpError(400, 'body_b64 is not valid base64');
  const buf = Buffer.from(clean, 'base64');
  if (buf.length > MAX_BODY_BYTES) throw httpError(400, 'body is larger than ' + Math.round(MAX_BODY_BYTES / 1024) + ' KB');
  const text = buf.toString('utf8');
  if (CTRL_BODY.test(text)) throw httpError(400, 'body contains control characters (only tab and newline are allowed)');
  return text;
}

function readEmailParam(raw) {
  const email = authUtils.normalizeEmail(String(raw === undefined || raw === null ? '' : raw));
  if (!authUtils.isValidEmail(email)) throw httpError(400, 'A valid e-mail address is required');
  return email;
}

/* ── module ──────────────────────────────────────────────────────────────────────────────── */

module.exports = function createMarketingEmails(deps) {
  const DATA_DIR = deps && deps.DATA_DIR;
  const lockedUpdate = deps && deps.lockedUpdate;
  const writeAuditLog = (deps && deps.writeAuditLog) || function () {};
  if (!DATA_DIR || typeof lockedUpdate !== 'function') {
    throw new Error('marketing-emails.cjs needs { DATA_DIR, lockedUpdate, writeAuditLog }');
  }
  const ringPath = path.join(DATA_DIR, BACKUP_FILE);

  if (!APP_KEY) console.error('[marketing-emails] CIO_APP_API_KEY missing — letter editing answers 503 (put it in /opt/crm-api/.env and restart blitz-api)');
  else if (!APP_URL) console.error('[marketing-emails] CIO_API_BASE/CIO_REGION must be an https:// address (http:// only for 127.0.0.1) — letter editing answers 503');
  else console.log('[marketing-emails] letters are read and written at ' + APP_URL.host);
  if (!TRACK_READY) console.error('[marketing-emails] CIO_SITE_ID / CIO_TRACKING_API_KEY missing or unusable — unsubscribe and delete answer 503');
  else console.log('[marketing-emails] person actions go to ' + TRACK_URL.host);

  /* ── version ring ──────────────────────────────────────────────────────────────────────── */

  const ringKey = (cid, aid) => 'campaign:' + cid + ':' + aid;

  // readJSON() inside lockedUpdate falls back to [] for an unreadable file, and the next write would then save
  // that empty list over the history — the same defect we found in the boss's readLeads(). So the file is read
  // here first: unreadable and non-empty means the save is refused outright, because a letter must not be
  // overwritten when its previous version cannot be kept.
  function readRing() {
    let raw;
    try { raw = fs.readFileSync(ringPath, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw httpError(500, 'The letter version history cannot be read (' + (e.message || 'error') + ') — nothing was changed in Customer.io');
    }
    if (!raw.trim()) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      throw httpError(500, 'The letter version history (data/' + BACKUP_FILE + ') is not readable JSON — nothing was changed in Customer.io; restore or move that file aside');
    }
    if (!Array.isArray(parsed)) throw httpError(500, 'The letter version history (data/' + BACKUP_FILE + ') is not a list — nothing was changed in Customer.io');
    return parsed;
  }

  // Reading the history must never take a page down: a listing shows "0 versions" instead of an error page.
  // Writing is the opposite — see readRing above.
  function tryRing() {
    try { return readRing(); } catch (e) {
      console.error('[marketing-emails] version history unreadable: ' + ((e && e.message) || 'error'));
      return [];
    }
  }

  function versionsFor(list, key) {
    return list.filter(v => v && v.key === key).sort((a, b) => (a.version || 0) - (b.version || 0));
  }

  // 20 versions per letter, and a ceiling for the file as a whole: a 200 KB template kept twenty times over for
  // every letter of every journey would turn one save into a multi-megabyte rewrite. Oldest goes first, and the
  // newest version of every letter is never dropped.
  function trimRing(list) {
    const byKey = new Map();
    for (const v of list) {
      if (!v || !v.key) continue;
      if (!byKey.has(v.key)) byKey.set(v.key, []);
      byKey.get(v.key).push(v);
    }
    let out = [];
    for (const [, versions] of byKey) {
      versions.sort((a, b) => (a.version || 0) - (b.version || 0));
      out = out.concat(versions.slice(-RING_PER_ACTION));
    }
    out.sort((a, b) => (a.saved_at || '') < (b.saved_at || '') ? -1 : 1);
    // Since the entry also carries `raw`, the body is in it twice and the layout once more, so the body size
    // alone is no longer what a version costs. Entries written before that have no entry_bytes and are
    // measured the old way — an old ring file stays readable and keeps trimming.
    const cost = v => (v.entry_bytes || v.bytes || 0) + 400;
    let bytes = out.reduce((n, v) => n + cost(v), 0);
    while (bytes > RING_MAX_BYTES && out.length > 1) {
      const idx = out.findIndex(v => versionsFor(out, v.key).length > 1);
      if (idx === -1) break;                                  // one version each left: keep them
      bytes -= cost(out[idx]);
      out.splice(idx, 1);
    }
    return out;
  }

  // Saves the values a letter has right now. Returns the version number written.
  // The strict read happens *inside* the write queue, not before it: reading first and writing afterwards
  // would leave a window in which the file could become unreadable between the two, and lockedUpdate's own
  // read would then hand the callback an empty list and quietly replace the history with it.
  async function pushVersion(key, live, user, source) {
    let version = 0;
    const entry = {
      key,
      saved_at: new Date().toISOString(),
      saved_by: user || 'system',
      source: source || 'pre-save',
      subject: typeof live.subject === 'string' ? live.subject : '',
      preheader_text: typeof live.preheader_text === 'string' ? live.preheader_text : '',
      body: typeof live.body === 'string' ? live.body : '',
      bytes: Buffer.byteLength(typeof live.body === 'string' ? live.body : '', 'utf8'),
      // The three fields above are the ones Restore puts back, because they are the only three this module
      // ever writes. `raw` is the letter as Customer.io handed it over a second ago — all twenty-odd fields,
      // including `layout` (which carries the Unsubscribe link), `from`, `reply_to`, `bcc`, `headers`,
      // `sending_state`, `deduplicate_id`. We send three fields in a PUT and do not know for certain whether
      // the provider merges them into the letter or replaces the letter with them; if it replaces, this copy
      // is the only place the rest still exists. Nothing reads it automatically — putting a field back is a
      // decision for a person looking at the letter (deploy/compare_action_raw.js lays the two side by side).
      raw: (live && typeof live === 'object') ? live : null
    };
    const r = await lockedUpdate(BACKUP_FILE, () => {
      const current = readRing();                            // throws, and then nothing is written at all
      const existing = versionsFor(current, key);
      version = (existing.length ? existing[existing.length - 1].version || 0 : 0) + 1;
      const stored = Object.assign({ version }, entry);
      stored.entry_bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');   // what it really costs, see trimRing
      return trimRing(current.concat([stored]));
    }, () => ({ action: 'email_version_saved', user: user || 'system', details: key + ' v' + version + ' (' + entry.bytes + ' bytes, ' + entry.source + ')' }));
    if (!r || !r.ok) throw httpError(500, 'The previous version of this letter could not be saved — nothing was changed in Customer.io');
    return version;
  }

  /* ── reading letters ───────────────────────────────────────────────────────────────────── */

  let listCache = null;                                       // { at, data } — the letter list only

  function invalidateList() { listCache = null; }

  const asArray = (v, ...keys) => {
    if (Array.isArray(v)) return v;
    for (const k of keys) if (v && Array.isArray(v[k])) return v[k];
    return null;
  };

  // Verified shape (our own 07.09 push and its saved copies): { actions: [ … ] }, each action flat.
  async function fetchActions(cid) {
    const r = await cioRequest(APP_URL, '/v1/campaigns/' + cid + '/actions', { auth: appAuth(), logTag: 'GET /v1/campaigns/' + cid + '/actions' });
    const data = appResult(r, 'the letters of journey ' + cid, { allow404: true });
    if (data === null) return null;
    return asArray(data, 'actions', 'data');
  }

  // A journey step that is not a letter (a delay, a webhook) has no subject and no body; only letters are listed.
  function isLetter(a) {
    if (!a || typeof a !== 'object') return false;
    if (a.type && a.type !== 'email') return false;
    return typeof a.body === 'string' || typeof a.subject === 'string';
  }

  function letterSummary(a, cid, versionCount) {
    return {
      campaign_id: String(cid),
      id: String(a.id === undefined || a.id === null ? '' : a.id),
      name: typeof a.name === 'string' ? a.name : '',
      type: typeof a.type === 'string' ? a.type : '',
      subject: typeof a.subject === 'string' ? a.subject : '',
      preheader_text: typeof a.preheader_text === 'string' ? a.preheader_text : '',
      from: typeof a.from === 'string' ? a.from : '',
      sending_state: typeof a.sending_state === 'string' ? a.sending_state : '',
      updated: typeof a.updated === 'number' ? a.updated : null,
      body_bytes: typeof a.body === 'string' ? Buffer.byteLength(a.body, 'utf8') : null,
      versions: versionCount,
      editable: true
    };
  }

  async function fanOut(items, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = [];
    for (let i = 0; i < Math.min(FANOUT_PARALLEL, items.length); i++) {
      runners.push((async () => {
        while (true) {
          const idx = next++;
          if (idx >= items.length) return;
          out[idx] = await worker(items[idx]);
        }
      })());
    }
    await Promise.all(runners);
    return out;
  }

  const emails = express.Router();

  /**
   * GET /api/marketing/emails
   * The letters of every journey, plus the transactional messages, editable through marketing-emails-tx.cjs.
   * Bodies are not in this answer on purpose: six templates of up to 200 KB would be sent on every page load,
   * and the page needs a body only when a letter is opened (GET .../campaigns/:cid/actions/:aid below).
   */
  emails.get('/', async (req, res) => {
    try {
      requireAppKeys();
      // ?fresh=1 is the Refresh button and nothing else: read past the cache, then fill it again below.
      // The first load of the page does not send it, and a save invalidates the cache on its own.
      const fresh = req.query.fresh === '1';
      if (!fresh && listCache && Date.now() - listCache.at < LIST_CACHE_TTL_MS) return res.json(listCache.data);

      const cr = await cioRequest(APP_URL, '/v1/campaigns', { auth: appAuth(), logTag: 'GET /v1/campaigns' });
      const campaignsRaw = asArray(appResult(cr, 'the journey list'), 'campaigns', 'data');
      if (!campaignsRaw) throw new Upstream('Customer.io answered the journey list in a shape this panel does not understand');

      const ring = tryRing();
      const wanted = campaignsRaw.slice(0, MAX_CAMPAIGNS_FANOUT);
      const letterLists = await fanOut(wanted, async c => {
        const cid = String(c && c.id !== undefined ? c.id : '');
        if (!ID_RE.test(cid)) return null;
        try { return await fetchActions(cid); } catch (e) { return undefined; }   // undefined = could not read
      });

      const campaigns = wanted.map((c, i) => {
        const cid = String(c && c.id !== undefined ? c.id : '');
        const actions = letterLists[i];
        let letters;
        if (actions === undefined) letters = null;                                 // Customer.io did not answer
        else if (actions === null) letters = [];                                   // journey has no actions
        else letters = actions.filter(isLetter).map(a => letterSummary(a, cid, versionsFor(ring, ringKey(cid, String(a.id))).length));
        return {
          id: cid,
          name: typeof c.name === 'string' ? c.name : '',
          state: typeof c.state === 'string' ? c.state : (c.active ? 'running' : ''),
          type: typeof c.type === 'string' ? c.type : '',
          letters
        };
      });

      // Transactional messages are listed here; their editing is in marketing-emails-tx.cjs.
      let transactional = null;
      try {
        const tr = await cioRequest(APP_URL, '/v1/transactional', { auth: appAuth(), logTag: 'GET /v1/transactional' });
        const list = asArray(appResult(tr, 'the transactional message list', { allow404: true }), 'transactional_messages', 'messages', 'data');
        transactional = list === null ? null : list.map(t => ({
          id: String(t && t.id !== undefined ? t.id : ''),
          name: (t && typeof t.name === 'string') ? t.name : '',
          subject: (t && typeof t.subject === 'string') ? t.subject : '',
          editable: true,
          checked: txLetters.letterKey(t) !== null   // true: its {{ trigger.* }} fields are checked on save (found by its number in .env or by its name)
        }));
      } catch (e) { transactional = null; }

      const data = {
        fetched_at: new Date().toISOString(),
        campaigns,
        transactional,
        limits: { subject: MAX_SUBJECT, preheader_text: MAX_PREHEADER, body_bytes: MAX_BODY_BYTES, versions_per_letter: RING_PER_ACTION }
      };
      listCache = { at: Date.now(), data };
      res.json(data);
    } catch (e) { fail(res, e, 'GET /'); }
  });

  /** GET /api/marketing/emails/campaigns/:cid/actions/:aid — one letter with its body and its saved versions. */
  emails.get('/campaigns/:cid/actions/:aid', async (req, res) => {
    try {
      requireAppKeys();
      const cid = readId(req.params.cid, 'campaign id'), aid = readId(req.params.aid, 'action id');
      const actions = await fetchActions(cid);
      const a = (actions || []).find(x => x && String(x.id) === aid);
      if (!a) throw httpError(404, 'No such letter in this journey');
      const ring = tryRing();
      res.json({
        letter: Object.assign(letterSummary(a, cid, versionsFor(ring, ringKey(cid, aid)).length), {
          body: typeof a.body === 'string' ? a.body : '',
          layout_present: typeof a.layout === 'string' && a.layout.length > 0
        }),
        versions: versionsFor(ring, ringKey(cid, aid)).slice().reverse().map(v => ({
          version: v.version, saved_at: v.saved_at, saved_by: v.saved_by, source: v.source,
          subject: v.subject, bytes: v.bytes,
          // How many fields of the letter that version holds. Restore uses three of them; the number is here
          // so that a version kept before M4 (no raw at all) can be told apart from a full copy.
          raw_fields: (v.raw && typeof v.raw === 'object') ? Object.keys(v.raw).length : 0
        })),
        fetched_at: new Date().toISOString()
      });
    } catch (e) { fail(res, e, 'GET letter'); }
  });

  /**
   * PUT /api/marketing/emails/campaigns/:cid/actions/:aid  { subject_b64?, preheader_b64?, body_b64? }
   * The letter as it is right now is read first, kept in the version ring, and only then overwritten. All three
   * fields are always sent to Customer.io (the omitted ones filled from the live letter), so the result does not
   * depend on whether the provider treats PUT as a merge or as a replacement.
   */
  emails.put('/campaigns/:cid/actions/:aid', async (req, res) => {
    try {
      requireAppKeys();
      const cid = readId(req.params.cid, 'campaign id'), aid = readId(req.params.aid, 'action id');
      const src = (req.body && typeof req.body === 'object') ? req.body : {};
      const subject = readLineB64(src, 'subject', 'subject_b64', MAX_SUBJECT);
      const preheader = readLineB64(src, 'preheader_text', 'preheader_b64', MAX_PREHEADER);
      const body = readBody(src);
      if (subject === undefined && preheader === undefined && body === undefined) {
        throw httpError(400, 'Nothing to save: send subject_b64, preheader_b64 or body_b64');
      }

      const actions = await fetchActions(cid);
      const live = (actions || []).find(x => x && String(x.id) === aid);
      if (!live) throw httpError(404, 'No such letter in this journey');
      if (live.type && live.type !== 'email') throw httpError(400, 'This journey step is not a letter');

      const next = {
        subject: subject === undefined ? (typeof live.subject === 'string' ? live.subject : '') : subject,
        preheader_text: preheader === undefined ? (typeof live.preheader_text === 'string' ? live.preheader_text : '') : preheader,
        body: body === undefined ? (typeof live.body === 'string' ? live.body : '') : body
      };
      const same = next.subject === (live.subject || '') && next.preheader_text === (live.preheader_text || '') && next.body === (live.body || '');
      if (same) return res.json({ ok: true, unchanged: true, letter: letterSummary(live, cid, versionsFor(tryRing(), ringKey(cid, aid)).length) });

      const user = (req.userSession && req.userSession.email) || 'system';
      const version = await pushVersion(ringKey(cid, aid), live, user, 'pre-save');

      const r = await cioRequest(APP_URL, '/v1/campaigns/' + cid + '/actions/' + aid, {
        method: 'PUT', auth: appAuth(), payload: next, logTag: 'PUT /v1/campaigns/' + cid + '/actions/' + aid
      });
      appResult(r, 'the change to this letter');
      invalidateList();

      writeAuditLog('marketing_emails', 'email_updated', user,
        'campaign ' + cid + ' action ' + aid + ': subject ' + next.subject.length + ' chars, body ' + Buffer.byteLength(next.body, 'utf8') + ' bytes; previous kept as v' + version,
        req.ip);
      res.json({
        ok: true,
        saved_version: version,
        letter: letterSummary(Object.assign({}, live, next), cid, versionsFor(tryRing(), ringKey(cid, aid)).length)
      });
    } catch (e) { fail(res, e, 'PUT letter'); }
  });

  /**
   * POST /api/marketing/emails/campaigns/:cid/actions/:aid/restore  { version }
   * Puts a kept version back. The letter as it is now is kept first, so a restore can itself be taken back.
   */
  emails.post('/campaigns/:cid/actions/:aid/restore', async (req, res) => {
    try {
      requireAppKeys();
      const cid = readId(req.params.cid, 'campaign id'), aid = readId(req.params.aid, 'action id');
      const src = (req.body && typeof req.body === 'object') ? req.body : {};
      const wanted = Number(src.version);
      if (!Number.isInteger(wanted) || wanted < 1) throw httpError(400, 'version must be a whole number');

      const key = ringKey(cid, aid);
      const stored = versionsFor(tryRing(), key).find(v => v.version === wanted);
      if (!stored) throw httpError(404, 'Version ' + wanted + ' is not in the history of this letter');

      const actions = await fetchActions(cid);
      const live = (actions || []).find(x => x && String(x.id) === aid);
      if (!live) throw httpError(404, 'No such letter in this journey');

      const next = { subject: stored.subject || '', preheader_text: stored.preheader_text || '', body: stored.body || '' };
      const user = (req.userSession && req.userSession.email) || 'system';
      const version = await pushVersion(key, live, user, 'pre-restore');

      const r = await cioRequest(APP_URL, '/v1/campaigns/' + cid + '/actions/' + aid, {
        method: 'PUT', auth: appAuth(), payload: next, logTag: 'PUT /v1/campaigns/' + cid + '/actions/' + aid + ' (restore)'
      });
      appResult(r, 'the restore of this letter');
      invalidateList();

      writeAuditLog('marketing_emails', 'email_restored', user,
        'campaign ' + cid + ' action ' + aid + ': restored v' + wanted + ' (' + (stored.bytes || 0) + ' bytes); previous kept as v' + version, req.ip);
      res.json({ ok: true, restored_version: wanted, saved_version: version, letter: letterSummary(Object.assign({}, live, next), cid, versionsFor(tryRing(), key).length) });
    } catch (e) { fail(res, e, 'restore letter'); }
  });

  /**
   * POST /api/marketing/emails/test  { subject_b64, body_b64 }
   * One copy of the draft to the person who is signed in. The recipient comes from the session and cannot be
   * chosen by the caller — this route must never become a way to send mail from the shop's domain to anyone.
   * ⚠️ Verify on the live account: an inline send (no transactional_message_id) is documented but has not been
   * made from this account yet; every send we have made carried a template id.
   */
  emails.post('/test', async (req, res) => {
    try {
      requireAppKeys();
      const src = (req.body && typeof req.body === 'object') ? req.body : {};
      const subject = readLineB64(src, 'subject', 'subject_b64', MAX_SUBJECT);
      const body = readBody(src);
      if (!subject || !body) throw httpError(400, 'subject_b64 and body_b64 are both required for a test letter');
      const to = authUtils.normalizeEmail(txLetters.testRecipient(req.userSession && req.userSession.email));   // EMAIL_TEST_TO, else the signed-in user
      if (!authUtils.isValidEmail(to)) throw httpError(400, 'Your account has no usable e-mail address');

      const r = await cioRequest(APP_URL, '/v1/send/email', {
        method: 'POST', auth: appAuth(),
        payload: { to, identifiers: { email: to }, from: TEST_FROM, subject, body },
        logTag: 'POST /v1/send/email (test to ' + mask(to) + ')'
      });
      const data = appResult(r, 'the test letter');
      const deliveryId = data && (data.delivery_id || data.deliveryId || (data.meta && data.meta.delivery_id)) || null;
      writeAuditLog('marketing_emails', 'test_email_sent', to, 'subject ' + subject.length + ' chars, body ' + Buffer.byteLength(body, 'utf8') + ' bytes, delivery ' + (deliveryId || 'unknown'), req.ip);
      res.json({
        ok: true, to, delivery_id: deliveryId,
        note: 'While the workspace is in test mode Customer.io delivers this to the test address configured there, not to you.'
      });
    } catch (e) { fail(res, e, 'test send'); }
  });

  /* ── people ────────────────────────────────────────────────────────────────────────────── */

  const people = express.Router();

  const LEAD_NOTE = 'The CRM lead is left untouched — this changes the person in Customer.io only.';

  // Both person actions look the address up before they touch anything. The Track API's PUT is an upsert:
  // an unsubscribe typed with a typo would CREATE that person in Customer.io — a profile the account is
  // billed for, carrying an `unsubscribed` flag for somebody who was never there. A 404 costs one read and
  // is the honest answer. Delete goes through the same door: Customer.io answers 200 for a person it never
  // had, so without this check the page would report "deleted" for a mistyped address.
  async function personIsKnown(email) {
    const r = await cioRequest(APP_URL, '/v1/customers/' + encodeURIComponent(email) + '/attributes?id_type=email', {
      auth: appAuth(), logTag: 'GET /v1/customers/' + mask(email) + '/attributes'
    });
    const data = appResult(r, 'the profile of this person', { allow404: true });
    if (data === null) return false;
    // An account answers 200 with an empty shape for someone it has never seen, so the envelope is what says
    // "this profile exists" — the same rule the Marketing panel uses for the same endpoint.
    return !!(data && typeof data === 'object' && (data.customer || data.person));
  }

  const NOT_IN_CIO = ' is not in Customer.io — nothing was changed. Check the spelling; a person appears there' +
    ' after their first order, subscription or cart event.';

  /**
   * POST /api/marketing/people/:email/unsubscribe
   * Track API PUT with the reserved attribute. The storefront never sends `unsubscribed` in its own identify
   * calls (checked in products-api), so a later order or cart event will not quietly switch this back on.
   */
  people.post('/:email/unsubscribe', async (req, res) => {
    try {
      requireAppKeys();                                     // the lookup below is an App API call
      requireTrackKeys();
      const email = readEmailParam(req.params.email);
      if (!(await personIsKnown(email))) throw httpError(404, email + NOT_IN_CIO);
      const r = await cioRequest(TRACK_URL, '/api/v1/customers/' + encodeURIComponent(email), {
        method: 'PUT', auth: trackAuth(), payload: { unsubscribed: true },
        logTag: 'PUT track customer ' + mask(email) + ' (unsubscribe)'
      });
      if (r.status === 401 || r.status === 403) throw new Upstream('Customer.io rejected the tracking credentials (HTTP ' + r.status + ')', r.status);
      if (r.status === 429) throw new Upstream('Customer.io is rate limiting us (HTTP 429) — try again in a minute', 429);
      if (r.status >= 500) throw new Upstream('Customer.io is not answering (HTTP ' + r.status + ')', r.status);
      if (r.status < 200 || r.status >= 300) throw httpError(400, 'Customer.io refused the unsubscribe (HTTP ' + r.status + ')');
      writeAuditLog('marketing_people', 'person_unsubscribed', (req.userSession && req.userSession.email) || 'system', 'customer ' + email, req.ip);
      res.json({ ok: true, email, unsubscribed: true, note: LEAD_NOTE });
    } catch (e) { fail(res, e, 'unsubscribe'); }
  });

  /**
   * DELETE /api/marketing/people/:email
   * Track API delete, after the same lookup as unsubscribe. Customer.io answers 200 for a person it does not
   * know, which on its own would make a mistyped address look like a successful delete; the lookup is what
   * makes a success here mean "this person existed and is gone".
   */
  people.delete('/:email', async (req, res) => {
    try {
      requireAppKeys();                                     // the lookup below is an App API call
      requireTrackKeys();
      const email = readEmailParam(req.params.email);
      if (!(await personIsKnown(email))) throw httpError(404, email + NOT_IN_CIO);
      const r = await cioRequest(TRACK_URL, '/api/v1/customers/' + encodeURIComponent(email), {
        method: 'DELETE', auth: trackAuth(), logTag: 'DELETE track customer ' + mask(email)
      });
      if (r.status === 401 || r.status === 403) throw new Upstream('Customer.io rejected the tracking credentials (HTTP ' + r.status + ')', r.status);
      if (r.status === 429) throw new Upstream('Customer.io is rate limiting us (HTTP 429) — try again in a minute', 429);
      if (r.status >= 500) throw new Upstream('Customer.io is not answering (HTTP ' + r.status + ')', r.status);
      if (r.status < 200 || r.status >= 300) throw httpError(400, 'Customer.io refused the delete (HTTP ' + r.status + ')');
      writeAuditLog('marketing_people', 'person_deleted', (req.userSession && req.userSession.email) || 'system', 'customer ' + email, req.ip);
      res.json({ ok: true, email, deleted: true, note: LEAD_NOTE + ' Their history in Customer.io (messages, events) goes with the profile.' });
    } catch (e) { fail(res, e, 'delete person'); }
  });

  // Order letters (transactional messages), stage 1 RET 2026-09-30: routes, contract check and saved-sha ledger.
  txLetters.mount(emails, {
    httpError, fail, readId, readLineB64, readBody, requireAppKeys, cioRequest, appAuth, appResult, asArray,
    pushVersion, tryRing, versionsFor, invalidateList, writeAuditLog, lockedUpdate, authUtils, mask,
    APP_URL, TEST_FROM, MAX_SUBJECT, MAX_PREHEADER, Upstream
  });

  return { emails, people };
};
