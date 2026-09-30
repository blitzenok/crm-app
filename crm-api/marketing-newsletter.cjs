/**
 * BioLabs Research CRM — Newsletter (M3, 2026-09-08).
 *
 * One screen for a one-off letter to a list of people: write it, keep it as a draft, send a test to
 * yourself, then hand it to Customer.io. Mounted by server_v14.cjs as
 *
 *     app.use('/api/marketing/newsletter', requireAuth,
 *             require('./marketing-newsletter.cjs')({ lockedUpdate, DATA_DIR }));
 *
 * so every route below already has a live session behind it (role does not matter — phase 5, the
 * owner's decision that everyone signed in has the same rights).
 *
 * How the sending works, and why it is built this way:
 *   - the letter is NOT assembled here into recipients and messages. Customer.io holds one
 *     **API-triggered broadcast** ("CRM Newsletter", created by hand in the interface, see
 *     docs/customerio-journeys-en.md §7) whose subject, preheader and body are the Liquid values
 *     {{ trigger.subject }}, {{ trigger.preheader }}, {{ trigger.body_html }}. The CRM posts those
 *     three values to POST /v1/broadcasts/{id}/triggers and the provider does the delivery, the
 *     unsubscribe link, the suppression list and the reporting. Duplicating that here would be a
 *     second mail product;
 *   - the id of that broadcast lives in /opt/crm-api/.env as CIO_NEWSLETTER_BROADCAST_ID. Until the
 *     owner has created it, GET /status answers 200 { configured: false, hint } and the page says so
 *     in words. Drafts can still be written; only sending is closed. An empty channel must look like
 *     an empty channel, not like a broken page;
 *   - a draft that has been sent is frozen: PUT, DELETE and a second send are refused (409). There is
 *     no way to un-send an e-mail, so the record of what went out stays exactly as it went out;
 *   - sending takes a claim (state 'sending') inside the write queue before the provider is called, so
 *     two tabs pressing Send together mail the list once and the second one gets 409. A claim that was
 *     never released (a restart mid-send) expires after five minutes.
 *
 * ⚠️ NOT VERIFIED AGAINST THE LIVE ACCOUNT (2026-09-08): the request body of the trigger call and the
 * inline transactional test send. Nobody in this project has ever called either against Customer.io
 * (inventory §6: "код есть, живого вызова нет"). The trigger body is built in ONE place,
 * buildTriggerBody() below, so the panel from the broadcast's own "API trigger" tab can be matched
 * against it and corrected in one edit. A rejection by the provider is reported with its own status
 * and its own words — see fail() — because that message is the whole diagnosis.
 *
 * Rules kept throughout (the same ones M1 kept, arrived at again here):
 *   - the App API key never reaches the client and never reaches a log line;
 *   - the provider being unreachable (network, timeout, 429, 5xx) is 503 "unavailable"; the provider
 *     REFUSING what we sent (4xx) is 400 with its own text, because the page can read a 400 body and
 *     cannot read a 503 one (crm.js api() turns 502/503/504 into its own sentence without looking);
 *   - the local draft is only marked sent after the provider accepted it. A letter that went out and
 *     a record that says "draft" is recoverable; the reverse is not;
 *   - a person's address is masked before it is logged;
 *   - the newsletter file is written through lockedUpdate(), i.e. inside the same queue every other
 *     table of this server uses, so two people saving at once cannot lose each other's issue, and it is
 *     READ by this module itself: the server's readJSON() answers an unreadable file with the fallback
 *     it was handed, and a fallback of [] would let the next write replace the whole record of what has
 *     been sent (including the 'sent' that refuses a second send). Unreadable is 503 here, not empty;
 *   - the subject, the preheader and the body travel base64-encoded, because server_v14.cjs rewrites
 *     every string of every JSON body before a route sees it — see readIssueInput().
 *
 * Config (all from /opt/crm-api/.env, which server_v14.cjs loads into process.env at startup — so a
 * change to .env needs `pm2 restart blitz-api`):
 *   CIO_APP_API_KEY               Bearer key of the App API (the same key products-api sends order letters with)
 *   CIO_NEWSLETTER_BROADCAST_ID   id of the API-triggered broadcast; empty = sending is not configured
 *   CIO_REGION                    'eu' switches the default host to api-eu.customer.io
 *   CIO_API_BASE                  overrides the host outright; also the seam the local stand points at its stub
 *   CIO_NEWSLETTER_FROM           From: of the test letter (default BioLabs Research <admin@biolabsresearch.co>)
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/* ── configuration ───────────────────────────────────────────────────────────────────────── */

const FILE = 'marketing-newsletters.json';
const MAX_ISSUES = 200;                 // ring: the newest 200 issues are kept
const SUBJECT_MAX = 300;
const PREHEADER_MAX = 300;
const BODY_MAX = 300 * 1024;            // 300 KB of HTML
const NAME_MAX = 200;                   // segment name copied into the record
const REQUEST_TIMEOUT_MS = 10000;
const SEGMENTS_TTL_MS = 60 * 1000;
const DEFAULT_FROM = 'BioLabs Research <admin@biolabsresearch.co>';

const APP_KEY = String(process.env.CIO_APP_API_KEY || '').trim();
const REGION = String(process.env.CIO_REGION || 'us').trim().toLowerCase();
const BROADCAST_ID = String(process.env.CIO_NEWSLETTER_BROADCAST_ID || '').trim();
const FROM = String(process.env.CIO_NEWSLETTER_FROM || '').trim() || DEFAULT_FROM;

// The rule products-api uses for its Customer.io hosts (products-api.cjs:52): https anywhere, plain
// http only to this machine. .env is edited by other root agents too, and one mistyped http:// host
// would put the key on the wire in clear text in an Authorization header.
function parseBase(raw, fallback) {
  try {
    const u = new URL(String(raw || fallback).trim().replace(/\/+$/, ''));
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u;
  } catch (e) { /* reported by the caller */ }
  return null;
}

const APP_URL = parseBase(process.env.CIO_API_BASE, REGION === 'eu' ? 'https://api-eu.customer.io' : 'https://api.customer.io');

// A broadcast id from .env is put into a URL path — accept only what a Customer.io id can be.
const BROADCAST_OK = /^[A-Za-z0-9_-]{1,64}$/.test(BROADCAST_ID);
const KEYS_PRESENT = !!(APP_KEY && APP_URL);
const CONFIGURED = !!(KEYS_PRESENT && BROADCAST_ID && BROADCAST_OK);

const HINT_NO_KEY = 'CIO_APP_API_KEY is missing from /opt/crm-api/.env (add it and restart blitz-api).';
const HINT_NO_BASE = 'CIO_API_BASE / CIO_REGION must be an https:// address (http:// only for 127.0.0.1).';
const HINT_NO_ID = 'Newsletter channel is not configured yet: create the API-triggered broadcast in Customer.io and add its id to the server settings (CIO_NEWSLETTER_BROADCAST_ID in /opt/crm-api/.env, then restart blitz-api).';
const HINT_BAD_ID = 'CIO_NEWSLETTER_BROADCAST_ID in /opt/crm-api/.env is not a usable id (letters, digits, - and _ only).';

function configHint() {
  if (!APP_KEY) return HINT_NO_KEY;
  if (!APP_URL) return HINT_NO_BASE;
  if (!BROADCAST_ID) return HINT_NO_ID;
  if (!BROADCAST_OK) return HINT_BAD_ID;
  return '';
}

if (!APP_KEY) console.error('[newsletter] CIO_APP_API_KEY missing — the Newsletter page keeps drafts but cannot send');
else if (!APP_URL) console.error('[newsletter] CIO_API_BASE/CIO_REGION must be an https:// address (http:// only for 127.0.0.1) — the Newsletter page cannot send');
else if (!BROADCAST_ID) console.log('[newsletter] CIO_NEWSLETTER_BROADCAST_ID not set — drafts only until the broadcast exists in Customer.io');
else if (!BROADCAST_OK) console.error('[newsletter] CIO_NEWSLETTER_BROADCAST_ID is not a usable id — the Newsletter page cannot send');
else console.log('[newsletter] broadcast ' + BROADCAST_ID + ' at ' + APP_URL.host);

/* ── errors and transport ────────────────────────────────────────────────────────────────── */

// The provider could not answer at all (network, timeout) or answered in a way that says "later"
// (429, 5xx). Routes turn this into 503: nothing is wrong with what the user typed.
class Upstream extends Error {
  // `code` is the transport's verdict (ECONNREFUSED, ETIMEDOUT, ECONNRESET, ERR_TLS_…). It is kept
  // because for a send it answers a different question than the message does: not "what went wrong" but
  // "is it certain that nothing left this machine" — see sendCertainlyDidNotHappen().
  constructor(message, status, code) {
    super(message);
    this.name = 'Upstream';
    this.upstreamStatus = status || 0;
    this.code = String(code || '');
  }
}
// A setting is missing — nothing is wrong with the provider or with the request. Still 503 (the route
// cannot do its job), but with the hint as its whole message: "unavailable" would send whoever reads it
// looking at Customer.io instead of at .env.
class NotConfigured extends Error {
  constructor(message) { super(message); this.name = 'NotConfigured'; }
}
// The provider answered, understood us, and said no (4xx). That verdict is the diagnosis and has to
// reach the screen — see the header note about 400 vs 503.
class Rejected extends Error {
  constructor(message, status, detail) { super(message); this.name = 'Rejected'; this.upstreamStatus = status; this.detail = detail || ''; }
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// Does this failure PROVE that the newsletter never went out? Two kinds do. The provider answered and
// refused (4xx): it read the request and did not act on it. And the conversation never started — the
// connection was refused, the name did not resolve, TLS did not come up — or the rate limiter turned it
// away before any work (429). A timeout, a connection cut mid-answer and a 5xx prove nothing: the
// trigger may have been accepted and only the answer lost. Anything this function does not recognise
// counts as "unknown" on purpose. The cost of that mistake is a five-minute wait; the cost of the other
// one is a newsletter delivered to the whole list twice, and there is no way to take an e-mail back.
function sendCertainlyDidNotHappen(err) {
  if (err instanceof Rejected) return true;
  if (!(err instanceof Upstream)) return false;
  if (err.upstreamStatus === 429) return true;
  const c = err.code;
  return c === 'ECONNREFUSED' || c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c.indexOf('ERR_TLS') === 0;
}

function maskEmail(value) {
  const s = String(value || '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? '***' : '';
  const name = s.slice(0, at), domain = s.slice(at);
  return (name.length <= 2 ? name.slice(0, 1) : name.slice(0, 2)) + '***' + domain;
}

// Customer.io wraps its complaint differently per endpoint; take the first human sentence we find and
// cut it short. It goes to the operator, so it must not carry a whole HTML error page into the toast.
function upstreamMessage(parsed, raw) {
  let text = '';
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.meta === 'object' && parsed.meta && typeof parsed.meta.error === 'string') text = parsed.meta.error;
    else if (typeof parsed.error === 'string') text = parsed.error;
    else if (Array.isArray(parsed.errors) && parsed.errors.length) {
      const first = parsed.errors[0];
      text = typeof first === 'string' ? first : (first && (first.detail || first.message || first.reason)) || '';
    } else if (typeof parsed.message === 'string') text = parsed.message;
  }
  if (!text && typeof raw === 'string') text = raw;
  return String(text || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 300);
}

// One request to the App API. No retry: a newsletter that has to be sent twice by hand is cheaper
// than one sent twice by a retry loop.
function cioRequest(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    const bodyText = payload === undefined ? null : JSON.stringify(payload);
    const headers = { 'Authorization': 'Bearer ' + APP_KEY, 'Accept': 'application/json' };
    if (bodyText !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyText);
    }
    let req;
    try {
      req = (APP_URL.protocol === 'https:' ? https : http).request({
        protocol: APP_URL.protocol,
        hostname: APP_URL.hostname,
        port: APP_URL.port || undefined,
        path: APP_URL.pathname.replace(/\/+$/, '') + apiPath,
        method,
        headers,
        timeout: REQUEST_TIMEOUT_MS
      }, resp => {
        const chunks = [];
        let size = 0;
        resp.on('data', c => {
          size += c.length;
          if (size > 2 * 1024 * 1024) { resp.destroy(); return done(reject, new Upstream('Customer.io sent an answer too large to read', resp.statusCode)); }
          chunks.push(c);
        });
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
          const status = resp.statusCode || 0;
          console.log('[newsletter] ' + method + ' ' + apiPath + ' → HTTP ' + status);
          if (status >= 200 && status < 300) return done(resolve, { status, data: parsed, raw });
          if (status === 429 || status >= 500) return done(reject, new Upstream('Customer.io is not answering right now (HTTP ' + status + ')', status));
          return done(reject, new Rejected('Customer.io refused the request (HTTP ' + status + ')', status, upstreamMessage(parsed, raw)));
        });
        resp.on('error', e => done(reject, new Upstream('Customer.io cut the answer short (' + ((e && e.message) || 'error') + ')', 0, e && e.code)));
      });
    } catch (e) {
      return done(reject, new Upstream('Cannot reach Customer.io (' + ((e && e.message) || 'error') + ')', 0, e && e.code));
    }
    // ETIMEDOUT on purpose: a request that was sent and not answered is NOT proof that it was not acted on.
    req.on('timeout', () => req.destroy(new Upstream('Customer.io did not answer within ' + REQUEST_TIMEOUT_MS + ' ms', 0, 'ETIMEDOUT')));
    req.on('error', e => done(reject, e instanceof Upstream ? e : new Upstream('Cannot reach Customer.io (' + ((e && e.message) || 'error') + ')', 0, e && e.code)));
    if (bodyText !== null) req.end(bodyText); else req.end();
  });
}

// One place where an error becomes a response. Everything the operator needs is in the sentence; the
// key is never part of it, because the key is never part of any message built above.
function fail(res, err) {
  if (err instanceof NotConfigured) {
    return res.status(503).json({ error: err.message });
  }
  if (err instanceof Rejected) {
    return res.status(400).json({
      error: err.message + (err.detail ? ': ' + err.detail : ''),
      upstream_status: err.upstreamStatus
    });
  }
  if (err instanceof Upstream) {
    console.error('[newsletter] ' + err.message);
    return res.status(503).json({ error: 'Customer.io unavailable — ' + err.message });
  }
  // 5xx as well as 4xx: loadAll() raises a 503 whose message is the only instruction there is
  // ("restore it by hand"), and turning that into "Internal server error" would throw the instruction away.
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[newsletter] ' + ((err && err.message) || 'error'));
  return res.status(500).json({ error: 'Internal server error' });
}

/* ── the issue record ────────────────────────────────────────────────────────────────────── */

function newId() {
  return 'nl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// A "sending" claim that nobody released — the process was restarted between the claim and the
// provider's answer. After this long the issue can be claimed again. Long enough that a slow provider
// answer never collides with it (the request itself times out after 10 s), short enough that a
// newsletter is not stuck for an afternoon.
const CLAIM_STALE_MS = 5 * 60 * 1000;
function staleClaim(sendingAt) {
  if (!sendingAt) return true;
  const t = Date.parse(sendingAt);
  return !Number.isFinite(t) || (Date.now() - t) > CLAIM_STALE_MS;
}
const ID_RE = /^nl_[0-9a-z_]{1,60}$/;

// The subject, the preheader and the body arrive base64-encoded, and that is not decoration.
// server_v14.cjs runs every JSON body through sanitizeValue() before any route sees it: it deletes
// <script> blocks and javascript: URIs, trims the ends, and removes everything matching on\w+\s*=\s*"…"
// — a rule with no word boundary in front of it, so an ordinary <meta name="description" content="…">
// loses everything from content= onwards. For a CRM form that filter is a sensible guard; for the text
// of a letter it is silent damage that the writer would discover from the letter that went out.
// Base64 carries none of those patterns (no <, no :, no quotes; = only as padding), so what was typed is
// what is stored. Same decision, and the same reason, as marketing-emails.cjs (M4).
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function decodeB64(field, value, maxBytes) {
  if (typeof value !== 'string') throw httpError(400, field + ' must be a string of base64');
  const clean = value.replace(/\s+/g, '');
  if (!B64_RE.test(clean) || clean.length % 4 !== 0) throw httpError(400, field + ' is not valid base64');
  const buf = Buffer.from(clean, 'base64');
  if (buf.length > maxBytes) throw httpError(400, field + ' is larger than ' + Math.floor(maxBytes / 1024) + ' KB');
  return buf.toString('utf8');
}

function cleanLine(value, max) {
  // A subject and a preheader end up in mail headers. Control characters there are the classic header
  // injection, and Liquid does not clean anything it renders (docs §7), so they are cut here.
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .trim()
    .slice(0, max);
}

// Records written by an older version of this module (or by hand) must still open in the editor.
function normalizeRecord(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const a = r.audience && typeof r.audience === 'object' ? r.audience : {};
  const type = a.type === 'segment' ? 'segment' : 'all';
  return {
    id: typeof r.id === 'string' && r.id ? r.id : '',
    subject: typeof r.subject === 'string' ? r.subject : '',
    preheader: typeof r.preheader === 'string' ? r.preheader : '',
    body_html: typeof r.body_html === 'string' ? r.body_html : '',
    audience: {
      type,
      segment_id: type === 'segment' && (typeof a.segment_id === 'string' || typeof a.segment_id === 'number') ? String(a.segment_id) : null,
      segment_name: type === 'segment' && typeof a.segment_name === 'string' ? a.segment_name : null
    },
    // 'sending' is the claim taken just before the provider is called — see POST /:id/send.
    state: r.state === 'sent' ? 'sent' : (r.state === 'sending' ? 'sending' : 'draft'),
    sending_at: typeof r.sending_at === 'string' ? r.sending_at : null,
    created_by: typeof r.created_by === 'string' ? r.created_by : '',
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
    sent_at: typeof r.sent_at === 'string' ? r.sent_at : null,
    sent_by: typeof r.sent_by === 'string' ? r.sent_by : null,
    cio_response: r.cio_response && typeof r.cio_response === 'object' ? r.cio_response : null,
    recipients_estimate: typeof r.recipients_estimate === 'number' ? r.recipients_estimate : null,
    last_test_at: typeof r.last_test_at === 'string' ? r.last_test_at : null,
    last_test_to: typeof r.last_test_to === 'string' ? r.last_test_to : null,
    // Set when a send left the provider's answer unknown (see POST /:id/send); cleared by the next claim.
    last_error: r.last_error && typeof r.last_error === 'object' && !Array.isArray(r.last_error) ? r.last_error : null
  };
}

// What the screen gets: the stored record plus one field that is worked out, never written down. A claim
// nobody released (the process was restarted between the claim and the provider's answer, or the answer
// never came) leaves an issue at 'sending' for good, and the page would hide Save, Send and Delete on it
// for good with it. After CLAIM_STALE_MS the server lets it be claimed again — the page has to be able
// to see that too, and to say why it is offering the button.
function forClient(rec) {
  const r = normalizeRecord(rec);
  r.sending_stale = r.state === 'sending' && staleClaim(r.sending_at);
  return r;
}

// The list screen shows what an issue is, not what is in it: 200 issues × 300 KB of HTML is not a
// list, it is a download. The body is fetched one issue at a time by GET /:id.
function summary(rec) {
  const r = forClient(rec);
  return {
    id: r.id, subject: r.subject, state: r.state, audience: r.audience, sending_at: r.sending_at,
    sending_stale: r.sending_stale, last_error: r.last_error,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
    sent_at: r.sent_at, sent_by: r.sent_by, recipients_estimate: r.recipients_estimate,
    last_test_at: r.last_test_at, body_bytes: Buffer.byteLength(r.body_html, 'utf8')
  };
}

// What the editor may send. `partial` is the PUT case: a field left out keeps its old value, a field
// present is validated exactly as on create.
function readIssueInput(body, partial) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};

  const has = k => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;

  // A plain field is refused rather than quietly accepted: accepting it would mean storing whatever the
  // shared sanitiser left of it, which is the whole reason the encoded form exists (see decodeB64).
  const PLAIN = [['subject', 'subject_b64'], ['preheader', 'preheader_b64'], ['body_html', 'body_b64']];
  for (let i = 0; i < PLAIN.length; i++) {
    if (b[PLAIN[i][0]] !== undefined) {
      throw httpError(400, 'Send ' + PLAIN[i][0] + ' as ' + PLAIN[i][1] + ' (base64 of the UTF-8 text). A plain "' +
        PLAIN[i][0] + '" field is rewritten by the shared input filter of this server before this route sees it, ' +
        'which would silently change the letter.');
    }
  }

  if (has('subject_b64') || !partial) {
    if (typeof b.subject_b64 !== 'string') throw httpError(400, 'Subject is required');
    const subject = cleanLine(decodeB64('subject_b64', b.subject_b64, SUBJECT_MAX * 4 + 64), SUBJECT_MAX + 1);
    if (!subject) throw httpError(400, 'Subject is required');
    if (subject.length > SUBJECT_MAX) throw httpError(400, 'Subject is longer than ' + SUBJECT_MAX + ' characters');
    out.subject = subject;
  }
  if (has('preheader_b64') || !partial) {
    const raw = b.preheader_b64 === undefined || b.preheader_b64 === null ? '' : b.preheader_b64;
    if (typeof raw !== 'string') throw httpError(400, 'Preheader must be text');
    const preheader = cleanLine(decodeB64('preheader_b64', raw, PREHEADER_MAX * 4 + 64), PREHEADER_MAX + 1);
    if (preheader.length > PREHEADER_MAX) throw httpError(400, 'Preheader is longer than ' + PREHEADER_MAX + ' characters');
    out.preheader = preheader;
  }
  if (has('body_b64') || !partial) {
    if (typeof b.body_b64 !== 'string') throw httpError(400, 'Body is required');
    // The body is HTML written by the team, so tags stay. Control characters other than the three that
    // belong in a document do not: they are invisible in the editor and visible in the letter.
    const body_html = decodeB64('body_b64', b.body_b64, BODY_MAX).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (!body_html.trim()) throw httpError(400, 'Body is required');
    if (Buffer.byteLength(body_html, 'utf8') > BODY_MAX) throw httpError(400, 'Body is larger than ' + Math.floor(BODY_MAX / 1024) + ' KB');
    out.body_html = body_html;
  }
  if (has('audience') || !partial) {
    const a = b.audience && typeof b.audience === 'object' && !Array.isArray(b.audience) ? b.audience : {};
    if (a.type !== 'all' && a.type !== 'segment') throw httpError(400, 'Audience must be "all" or "segment"');
    if (a.type === 'all') {
      out.audience = { type: 'all', segment_id: null, segment_name: null };
    } else {
      const id = String(a.segment_id === null || a.segment_id === undefined ? '' : a.segment_id).trim();
      if (!/^[0-9]{1,12}$/.test(id)) throw httpError(400, 'Choose a segment');
      out.audience = { type: 'segment', segment_id: id, segment_name: cleanLine(a.segment_name, NAME_MAX) || null };
    }
  }
  return out;
}

/* ── the body of the trigger call — the one place to correct after seeing the live panel ──── */

// docs/customerio-journeys-en.md §7: an API-triggered broadcast takes the Liquid values under `data`
// (the template reads them as {{ trigger.subject }} and so on) and, optionally, its recipients under
// `recipients`. Leaving `recipients` out means "the audience saved in the broadcast itself", which is
// what audience "all" is: the CRM does not decide who the whole list is, the broadcast does.
//
// ⚠️ Never called against the live account. The broadcast's own "API trigger" tab shows the exact
// body; when it arrives, this function is the only thing to change.
function buildTriggerBody(rec) {
  const r = normalizeRecord(rec);
  const out = {
    data: {
      subject: r.subject,
      preheader: r.preheader,
      body_html: r.body_html
    }
  };
  if (r.audience.type === 'segment' && r.audience.segment_id) {
    // A numeric id is what /v1/segments returns and what the documented example carries; a segment id
    // that is not a number is passed through as it came, rather than turned into NaN.
    const n = Number(r.audience.segment_id);
    out.recipients = { segment: { id: Number.isFinite(n) ? n : r.audience.segment_id } };
  }
  return out;
}

/* ── the router ──────────────────────────────────────────────────────────────────────────── */

module.exports = function createNewsletterRouter(deps) {
  const d = deps || {};
  if (typeof d.lockedUpdate !== 'function' || !d.DATA_DIR) {
    throw new Error('marketing-newsletter.cjs needs { lockedUpdate, DATA_DIR } from server_v14.cjs');
  }
  const lockedUpdate = d.lockedUpdate;
  const FILE_PATH = path.join(String(d.DATA_DIR), FILE);

  const router = express.Router();

  const whoami = req => String((req.userSession && req.userSession.email) || '').trim();

  // Read the file, or do nothing at all. The server's readJSON() answers an unreadable file with the
  // fallback it was given — [] here — and the very next write would replace the record of every issue
  // ever sent, and with it the 'sent' flag that is the only thing refusing a second send. Same reasoning,
  // and the same shape, as marketing-segments.cjs (M2). A file that does not exist yet is [], because
  // that is a new installation and not damage.
  function loadAll() {
    let raw;
    try { raw = fs.readFileSync(FILE_PATH, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw httpError(503, FILE + ' cannot be read (' + ((e && e.code) || 'error') + ') — restore it by hand before saving anything');
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw httpError(503, FILE + ' is not readable JSON — restore it by hand before saving anything'); }
    if (!Array.isArray(parsed)) throw httpError(503, FILE + ' is not a list — restore it by hand before saving anything');
    return parsed;
  }

  // Every write reads the file through loadAll(), inside the queue, and ignores the list lockedUpdate
  // hands in: that one comes from readJSON() and would be [] for a file this module refuses to read.
  function update(fn, meta) {
    return lockedUpdate(FILE, () => fn(loadAll()), meta);
  }
  function findIn(list, id) {
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return i;
    return -1;
  }
  // Newest first for the screen; the file itself keeps insertion order.
  function byNewest(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); }

  /* status ------------------------------------------------------------------------------- */
  // 200 even when nothing is configured: this is the answer the page needs in order to explain
  // itself, and an explanation delivered as 503 would never reach it (crm.js api() replaces the body
  // of 502/503/504 with its own sentence).
  router.get('/status', (req, res) => {
    res.json({
      configured: CONFIGURED,
      keys_present: KEYS_PRESENT,
      broadcast_id: CONFIGURED ? BROADCAST_ID : null,
      from: FROM,
      limits: { subject: SUBJECT_MAX, preheader: PREHEADER_MAX, body_bytes: BODY_MAX, keep: MAX_ISSUES },
      hint: configHint()
    });
  });

  /* segments (audience picker) ------------------------------------------------------------ */
  // Infra 2026-09-22: who a newsletter may go to — a segment the CRM keeps: manual (filled from CRM order
  // and lead data) and not one of the examples Customer.io ships, which carry the tag "Sample". Issues of
  // 14.09 and 18.09 went to the example "All Users": every profile, test addresses and buyers who never
  // subscribed included, and 32 of 49 letters bounced.
  function sendableSegment(s) {
    if (!s || typeof s !== 'object') return false;
    const tags = Array.isArray(s.tags) ? s.tags : [];
    return String(s.type || '') === 'manual' && !tags.some(t => /^sample$/i.test(String(t).trim()));
  }

  // Registered before /:id on purpose: express matches in registration order, and "segments" must
  // never be read as an issue id. (Ids are nl_… by construction, so this is a belt on top of braces.)
  let segCache = null;   // { at, payload } — 60 s, successes only
  router.get('/segments', async (req, res) => {
    try {
      if (!KEYS_PRESENT) throw new NotConfigured(configHint());
      if (segCache && Date.now() - segCache.at < SEGMENTS_TTL_MS) return res.json(segCache.payload);
      const r = await cioRequest('GET', '/v1/segments');
      // An answer without a segments array is an answer we cannot read — not an account without
      // segments. Turning one into the other is how a picker ends up quietly offering "everyone".
      if (!r.data || !Array.isArray(r.data.segments)) {
        throw new Upstream('Customer.io answered the segment list in a shape this page does not understand', r.status);
      }
      const raw = r.data.segments;
      // Infra 2026-09-22: only segments a newsletter may go to (sendableSegment). Examples used to be shown
      // with a label picked by name; the list of names missed "All Users", and it received two issues.
      const segments = raw.filter(sendableSegment).map(s => ({
        id: s.id !== undefined && s.id !== null ? String(s.id) : '',
        name: String(s.name || ''),
        type: String(s.type || ''),
        state: String(s.state || '')
      })).filter(s => s.id);
      const payload = { segments, fetched_at: new Date().toISOString() };
      segCache = { at: Date.now(), payload };
      res.json(payload);
    } catch (e) { fail(res, e); }
  });

  router.get('/segments/:id/count', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!/^[0-9]{1,12}$/.test(id)) throw httpError(400, 'Bad segment id');
      if (!KEYS_PRESENT) throw new NotConfigured(configHint());
      const r = await cioRequest('GET', '/v1/segments/' + id + '/customer_count');
      const count = r.data && Number.isFinite(Number(r.data.count)) ? Number(r.data.count) : null;
      res.json({ segment_id: id, count });
    } catch (e) { fail(res, e); }
  });

  /* issues -------------------------------------------------------------------------------- */
  router.get('/', (req, res) => {
    try {
      res.json({ issues: loadAll().map(summary).sort(byNewest) });
    } catch (e) { fail(res, e); }
  });

  router.get('/:id', (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) throw httpError(404, 'Newsletter not found');
      const list = loadAll();
      const i = findIn(list, id);
      if (i < 0) throw httpError(404, 'Newsletter not found');
      res.json({ issue: forClient(list[i]) });
    } catch (e) { fail(res, e); }
  });

  router.post('/', async (req, res) => {
    try {
      const input = readIssueInput(req.body, false);
      const now = new Date().toISOString();
      const rec = normalizeRecord(Object.assign({
        id: newId(), state: 'draft', created_by: whoami(req), created_at: now, updated_at: now
      }, input));
      const r = await update(list => {
        const next = Array.isArray(list) ? list.slice() : [];
        next.push(rec);
        // Ring: the newest MAX_ISSUES stay. Sorting by created_at rather than by position, because the
        // file is also editable by hand and its order is not a promise.
        if (next.length > MAX_ISSUES) {
          next.sort(byNewest);
          next.length = MAX_ISSUES;
        }
        return next;
      }, { action: 'create', user: whoami(req), details: 'newsletter ' + rec.id + ' created' });
      if (!r || !r.ok) throw new Error('write failed');
      res.status(201).json({ issue: forClient(rec) });
    } catch (e) { fail(res, e); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) throw httpError(404, 'Newsletter not found');
      const input = readIssueInput(req.body, true);
      if (!Object.keys(input).length) throw httpError(400, 'Nothing to change');
      let saved = null;
      // The whole read-modify-write happens inside the queue: "is it still a draft" is decided on the
      // list as it is at the moment of writing, not on the copy the browser had a minute ago.
      const r = await update(list => {
        const next = Array.isArray(list) ? list.slice() : [];
        const i = findIn(next, id);
        if (i < 0) throw httpError(404, 'Newsletter not found');
        const current = normalizeRecord(next[i]);
        if (current.state === 'sent') throw httpError(409, 'This newsletter has been sent and cannot be changed');
        if (current.state === 'sending' && !staleClaim(current.sending_at)) throw httpError(409, 'This newsletter is being sent right now');
        // Editing a claim nobody released takes the issue over: only 'draft' and a stale 'sending' can
        // reach this line, and an issue somebody is editing is not one that is being sent. last_error
        // stays, because it is the only record of the send whose outcome is unknown.
        saved = normalizeRecord(Object.assign({}, current, input, { state: 'draft', sending_at: null, updated_at: new Date().toISOString() }));
        next[i] = saved;
        return next;
      }, { action: 'update', user: whoami(req), details: 'newsletter ' + id + ' edited' });
      if (!r || !r.ok) throw new Error('write failed');
      res.json({ issue: forClient(saved) });
    } catch (e) { fail(res, e); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) throw httpError(404, 'Newsletter not found');
      const r = await update(list => {
        const next = Array.isArray(list) ? list.slice() : [];
        const i = findIn(next, id);
        if (i < 0) throw httpError(404, 'Newsletter not found');
        const st = normalizeRecord(next[i]).state;
        const cur = normalizeRecord(next[i]);
        if (st === 'sent') throw httpError(409, 'This newsletter has been sent and is kept as a record');
        if (st === 'sending' && !staleClaim(cur.sending_at)) throw httpError(409, 'This newsletter is being sent right now');
        next.splice(i, 1);
        return next;
      }, { action: 'delete', user: whoami(req), details: 'newsletter ' + id + ' deleted' });
      if (!r || !r.ok) throw new Error('write failed');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /* test send ----------------------------------------------------------------------------- */
  // POST /v1/send/email with the letter inline instead of a transactional_message_id.
  // ⚠️ The inline form is NOT verified against the live account: products-api sends order letters
  // through the same endpoint, but always with a template id (products-api.cjs:394). Verify on the
  // live account. The preheader is deliberately not sent: an unknown field would be rejected with the
  // whole letter, and a test is about layout and links.
  router.post('/:id/test', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) throw httpError(404, 'Newsletter not found');
      if (!KEYS_PRESENT) throw new NotConfigured(configHint());
      const to = whoami(req);
      if (!to || to.indexOf('@') < 1) throw httpError(400, 'Your account has no e-mail address to send the test to');
      const list = loadAll();
      const i = findIn(list, id);
      if (i < 0) throw httpError(404, 'Newsletter not found');
      const rec = normalizeRecord(list[i]);

      const r = await cioRequest('POST', '/v1/send/email', {
        to,
        identifiers: { email: to },
        from: FROM,
        subject: '[TEST] ' + rec.subject,
        body: rec.body_html
      });
      console.log('[newsletter] test of ' + id + ' sent to ' + maskEmail(to));

      const stamp = new Date().toISOString();
      // Best effort: the letter is already gone, so a failure to write the note must not be reported
      // as a failure to send.
      try {
        await update(l => {
          const next = Array.isArray(l) ? l.slice() : [];
          const j = findIn(next, id);
          if (j < 0) return null;
          next[j] = normalizeRecord(Object.assign({}, normalizeRecord(next[j]), { last_test_at: stamp, last_test_to: maskEmail(to) }));
          return next;
        });
      } catch (e) { console.error('[newsletter] test note not saved: ' + ((e && e.message) || 'error')); }

      res.json({ ok: true, to: maskEmail(to), delivery_id: (r.data && (r.data.delivery_id || r.data.id)) || null, sent_at: stamp });
    } catch (e) { fail(res, e); }
  });

  /* send ---------------------------------------------------------------------------------- */
  router.post('/:id/send', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) throw httpError(404, 'Newsletter not found');
      if (!CONFIGURED) throw new NotConfigured(configHint());

      // The claim. Two people (or two tabs, or a double click) reaching this route together would
      // otherwise both read a draft, both call the provider and mail the whole list twice — the worst
      // thing this feature can do. Taking the state inside the write queue makes exactly one of them
      // the sender; the other gets the same 409 a repeat send gets.
      let rec = null;
      const claimed_at = new Date().toISOString();
      const claim = await update(list => {
        const next = Array.isArray(list) ? list.slice() : [];
        const i = findIn(next, id);
        if (i < 0) throw httpError(404, 'Newsletter not found');
        const cur = normalizeRecord(next[i]);
        if (cur.state === 'sent') throw httpError(409, 'This newsletter has already been sent');
        if (cur.state === 'sending' && !staleClaim(cur.sending_at)) throw httpError(409, 'This newsletter is being sent right now');
        if (!cur.subject || !cur.body_html) throw httpError(400, 'A newsletter needs a subject and a body before it can be sent');
        rec = cur;
        // last_error is cleared here: this attempt has not failed yet, and a note from the previous one
        // would read as if it had.
        next[i] = normalizeRecord(Object.assign({}, cur, { state: 'sending', sending_at: claimed_at, last_error: null }));
        return next;
      }, { action: 'send-start', user: whoami(req), details: 'newsletter ' + id + ' claimed for sending' });

      // A claim that could not be written down is not a claim: the same disk would fail to record the
      // send afterwards, and a second Send would go out beside this one. A newsletter nobody can prove
      // was sent is worse than one that has to wait for the disk to be fixed.
      if (!claim || !claim.ok) {
        console.error('[newsletter] ' + id + ': the claim could not be saved — nothing was sent');
        throw new Error('the newsletter could not be marked as sending');
      }

      // A claim is given back ONLY when it is certain that nothing went out — see
      // sendCertainlyDidNotHappen(). Handing it back after a timeout would let the next Send mail the
      // whole list a second time for a letter that may already be on its way.
      const release = async () => {
        try {
          await update(list => {
            const next = Array.isArray(list) ? list.slice() : [];
            const i = findIn(next, id);
            if (i < 0) return null;
            const cur = normalizeRecord(next[i]);
            if (cur.state !== 'sending' || cur.sending_at !== claimed_at) return null;  // somebody else's claim: leave it
            next[i] = normalizeRecord(Object.assign({}, cur, { state: 'draft', sending_at: null }));
            return next;
          });
        } catch (e) { console.error('[newsletter] claim on ' + id + ' not released: ' + ((e && e.message) || 'error')); }
      };

      // Infra 2026-09-22: the audience is checked here, after the claim, so it cannot change between the
      // check and the trigger; a refusal gives the claim back at once, since nothing has gone out. "Everyone
      // in the broadcast audience" is refused too: that audience lives in Customer.io's own interface and
      // the CRM cannot see who is in it.
      if (rec.audience.type !== 'segment' || !rec.audience.segment_id) {
        await release();
        throw httpError(400, 'Choose a segment kept by the CRM before sending');
      }
      let seg;
      try {
        seg = await cioRequest('GET', '/v1/segments/' + rec.audience.segment_id);
      } catch (e) {
        await release();
        throw e;
      }
      if (!sendableSegment(seg.data && seg.data.segment)) {
        await release();
        throw httpError(400, 'This segment is not kept by the CRM (a Customer.io example or a journey filter); choose one marked (CRM)');
      }

      // How many people this is about. Best effort on purpose: the number is for the record, and a
      // count endpoint that is slow or missing must not stand between the team and their newsletter.
      let estimate = null;
      if (rec.audience.type === 'segment' && rec.audience.segment_id) {
        try {
          const c = await cioRequest('GET', '/v1/segments/' + rec.audience.segment_id + '/customer_count');
          if (c.data && Number.isFinite(Number(c.data.count))) estimate = Number(c.data.count);
        } catch (e) { console.error('[newsletter] recipient count for segment ' + rec.audience.segment_id + ' not read: ' + ((e && e.message) || 'error')); }
      }

      // Built before the try, so that everything inside the try is the wire and nothing else: cioRequest
      // rejects with Upstream or Rejected only, which is what sendCertainlyDidNotHappen() reads.
      const triggerBody = buildTriggerBody(rec);
      let r;
      try {
        r = await cioRequest('POST', '/v1/broadcasts/' + BROADCAST_ID + '/triggers', triggerBody);
      } catch (e) {
        if (sendCertainlyDidNotHappen(e)) {
          await release();   // it never left: the issue is a draft again and can be sent later
          throw e;
        }
        // Everything else leaves the question open. The claim STAYS, so a second Send within the
        // stale-claim window gets 409 instead of mailing the list twice, and the record carries what
        // happened. The answer is 200 and not 503 because crm.js api() replaces the body of a 502/503/504
        // with "Server unavailable — please try again in a minute" without reading it, and the one thing
        // that must reach the screen here is that nobody knows whether the letter went out.
        const at = new Date().toISOString();
        const last_error = {
          at: at,
          message: String((e && e.message) || 'error'),
          code: String((e && e.code) || ''),
          http_status: (e && e.upstreamStatus) || 0
        };
        try {
          await update(list => {
            const next = Array.isArray(list) ? list.slice() : [];
            const i = findIn(next, id);
            if (i < 0) return null;
            const cur = normalizeRecord(next[i]);
            if (cur.state !== 'sending' || cur.sending_at !== claimed_at) return null;   // somebody else's claim
            next[i] = normalizeRecord(Object.assign({}, cur, { last_error: last_error }));
            return next;
          }, { action: 'send-unknown', user: whoami(req), details: 'newsletter ' + id + ': no confirmation from Customer.io (' + last_error.message + ')' });
        } catch (e2) {
          console.error('[newsletter] ' + id + ': the unfinished send could not be written down: ' + ((e2 && e2.message) || 'error'));
        }
        console.error('[newsletter] ' + id + ': no confirmation from Customer.io (' + last_error.message + ') — the claim is kept');
        return res.status(200).json({
          ok: false, sent: 'unknown', delivery_unknown: true, state: 'sending',
          error: last_error.message,
          warning: 'Customer.io did not confirm this send (' + last_error.message + '). It is not known whether the letter ' +
            'went out — open Deliveries in Customer.io and check before sending it again. The issue stays marked as being ' +
            'sent; this page offers it again after five minutes.'
        });
      }

      // Only now. Everything above can fail and leave a draft; below this line the letter is out and
      // the record has to say so.
      const sent_at = new Date().toISOString();
      const cio_response = {
        http_status: r.status,
        // The documented answer is a trigger id; whatever it is called, keep the id and nothing else.
        id: (r.data && (r.data.id || r.data.trigger_id || r.data.delivery_id)) || null,
        received_at: sent_at
      };
      let saved = null;
      let w = null;
      try {
        w = await update(l => {
          const next = Array.isArray(l) ? l.slice() : [];
          const j = findIn(next, id);
          if (j < 0) return null;            // deleted while the provider was answering: nothing to mark
          saved = normalizeRecord(Object.assign({}, normalizeRecord(next[j]), {
            state: 'sent', sending_at: null, sent_at, sent_by: whoami(req), cio_response, recipients_estimate: estimate, updated_at: sent_at
          }));
          next[j] = saved;
          return next;
        }, { action: 'send', user: whoami(req), details: 'newsletter ' + id + ' sent to ' + (rec.audience.type === 'segment' ? 'segment ' + rec.audience.segment_id : 'the broadcast audience') });
      } catch (e) {
        // The letter is already with the provider. A file that cannot be read here must not come out as
        // "restore it by hand": the only thing that has to reach the screen now is that it went out and
        // was not written down. Fall into the same answer a failed write gets.
        console.error('[newsletter] ' + id + ' was triggered but the record could not be read back: ' + ((e && e.message) || 'error'));
        w = null;
      }

      if (!w || !w.ok || !saved) {
        // The letter is with the provider; the file did not take the note. Say both things.
        console.error('[newsletter] ' + id + ' was triggered but the record could not be updated');
        return res.status(200).json({
          ok: true, sent: true, record_updated: false, recipients_estimate: estimate, cio_response,
          warning: 'The newsletter was handed to Customer.io, but this CRM could not update its record. Do not send it again.'
        });
      }
      res.json({ ok: true, sent: true, record_updated: true, issue: forClient(saved), recipients_estimate: estimate, cio_response });
    } catch (e) { fail(res, e); }
  });

  // Test seam: the stand pins the shape of the trigger body without going through the network.
  router.buildTriggerBody = buildTriggerBody;
  return router;
};

// The same seam for the stand's static checks, without building a router.
module.exports.buildTriggerBody = buildTriggerBody;
module.exports._internals = { cleanLine, normalizeRecord, forClient, readIssueInput, decodeB64, maskEmail, upstreamMessage, sendCertainlyDidNotHappen, staleClaim, Upstream, Rejected };
