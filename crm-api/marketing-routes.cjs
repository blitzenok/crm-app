/**
 * BioLabs Research CRM — Marketing panel (M1, 2026-09-08).
 *
 * A read-only window on the Customer.io account, mounted by server_v14.cjs as
 *     app.use('/api/marketing', requireAuth, require('./marketing-routes.cjs'));
 * so every route below already has a live session behind it (role does not matter — see phase 5,
 * EQUAL_RIGHTS: everyone signed in sees the same CRM).
 *
 * What it does NOT do, on purpose: nothing here writes to Customer.io. Journeys, their steps,
 * filters, start and pause live in the Customer.io interface — this module only reports what is
 * there, so the panel can never disagree with the provider about who is running what.
 *
 * Rules kept throughout:
 *   - the App API key never reaches the client and is never written to a log line;
 *   - 429 / 5xx / network from Customer.io answer 503, never zeros pretending to be data;
 *   - a metric that could not be read is null, not 0 (a zero would read as "nobody opened it");
 *   - answers are cached for 300 s in memory, except the letter feed, which keeps 60 s because it
 *     is what the page reads the test-mode evidence from; the Refresh button asks with ?fresh=1 and
 *     reads past the cache (the App API allows 10 requests a second, and one open panel makes about
 *     two dozen);
 *   - outgoing calls are rate-limited for the whole process: the same key sends the order letters
 *     from products-api, and a panel being refreshed must not spend a buyer's letter into a 429;
 *   - one page load has one deadline, so a provider that stopped answering costs the page a single
 *     timeout instead of one per section;
 *   - a person's address is masked before it reaches a log line.
 *
 * Config (all from /opt/crm-api/.env, read by server_v14.cjs into process.env at startup —
 * editing .env therefore needs `pm2 restart blitz-api`):
 *   CIO_APP_API_KEY     Bearer key of the App API (same key products-api uses for order letters)
 *   CIO_REGION          'eu' switches the default host to api-eu.customer.io
 *   CIO_API_BASE        overrides the host outright; also the seam the local test stand points at
 *                       its own stub (plain http only to this machine)
 *   CIO_WORKSPACE_ID    used to build the "Open in Customer.io" links (default 231885)
 *   MARKETING_ORDERS_BASE  where the readiness check reads orders from (default the local
 *                       products-api on 127.0.0.1:4000)
 */
'use strict';

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const authUtils = require('./auth-utils.cjs');   // normalizeEmail / isValidEmail (<= 254) — already here since phase 2

const router = express.Router();

/* ── configuration ───────────────────────────────────────────────────────────────────────── */

const APP_KEY = String(process.env.CIO_APP_API_KEY || '').trim();
const REGION = String(process.env.CIO_REGION || 'us').trim().toLowerCase();
const WORKSPACE_ID = String(process.env.CIO_WORKSPACE_ID || '231885').trim().replace(/[^0-9A-Za-z_-]/g, '');
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 300 * 1000;        // a 30-day metric is the same answer five minutes later
const FEED_TTL_MS = 60 * 1000;          // /v1/messages is not: see ttlFor()
const CACHE_MAX_ENTRIES = 200;
const MAX_INFLIGHT = 6;                 // how many campaign fan-out calls are in flight at once
const MAX_BODY_BYTES = 2 * 1024 * 1024; // an answer larger than this is a mistake, not data — drop it
const OUTGOING_PER_SEC = 5;             // process-wide brake on calls to Customer.io, see takeToken()
const OUTGOING_BURST = 2;               // and how many of them may leave at once
const OVERALL_DEADLINE_MS = 15000;      // one page load, one deadline
const FAIL_TTL_MS = 10 * 1000;          // how long a path that failed is remembered, see failCache

// The same rule products-api uses for its Customer.io hosts: https anywhere, plain http only to this
// machine. .env is edited by other root agents too, and one mistyped http:// host would put the key
// on the wire in clear text in an Authorization header.
function parseBase(raw, fallback) {
  try {
    const u = new URL(String(raw || fallback).trim().replace(/\/+$/, ''));
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u;
  } catch (e) { /* reported by the caller */ }
  return null;
}

const APP_URL = parseBase(
  process.env.CIO_API_BASE,
  REGION === 'eu' ? 'https://api-eu.customer.io' : 'https://api.customer.io'
);
const ORDERS_URL = parseBase(process.env.MARKETING_ORDERS_BASE, 'http://127.0.0.1:4000');
// M6 (2026-09-08): the consent line of the checklist is answered from the lead list itself — the file
// products-api writes a signup into — instead of a flag somebody sets by hand. Read only, one small file,
// never held open: nothing in this module has any business writing a lead. MARKETING_LEADS_FILE is the seam
// the local stand points at its own fixture.
const LEADS_FILE = String(process.env.MARKETING_LEADS_FILE || path.join(__dirname, 'data', 'leads.json'));
const LEADS_MAX_BYTES = 5 * 1024 * 1024;   // a lead list larger than this is a mistake, not data

const READY = !!(APP_KEY && APP_URL);
if (!APP_KEY) console.error('[marketing] CIO_APP_API_KEY missing — the Marketing panel answers 503 (put it in /opt/crm-api/.env and restart blitz-api)');
else if (!APP_URL) console.error('[marketing] CIO_API_BASE/CIO_REGION must be an https:// address (http:// only for 127.0.0.1) — the Marketing panel answers 503');
else console.log('[marketing] reads Customer.io at ' + APP_URL.host + ' (workspace ' + WORKSPACE_ID + ')');
if (!ORDERS_URL) console.error('[marketing] MARKETING_ORDERS_BASE is not a usable address — the readiness check cannot count order statuses');

/* ── transport ───────────────────────────────────────────────────────────────────────────── */

// Thrown when the provider could not answer at all (timeout, network, 429, 5xx) or answered in a way
// that makes the panel unable to show the truth. Routes turn it into 503 — never into zeros.
class Upstream extends Error {
  constructor(message, status) { super(message); this.name = 'Upstream'; this.upstreamStatus = status || 0; }
}

// The App API allows about ten requests a second per account — and this panel is not the only thing
// holding the key: products-api sends the order letters with it. Half the budget is kept for the
// letters, and the panel waits its turn rather than racing them into a 429. One bucket for the whole
// process, because that is where the key is shared.
let tokens = OUTGOING_BURST;
let tokensAt = Date.now();
function takeToken() {
  return new Promise(resolve => {
    const tick = () => {
      const now = Date.now();
      tokens = Math.min(OUTGOING_BURST, tokens + (now - tokensAt) * OUTGOING_PER_SEC / 1000);
      tokensAt = now;
      if (tokens >= 1) { tokens -= 1; return resolve(); }
      setTimeout(tick, Math.max(20, Math.ceil((1 - tokens) * 1000 / OUTGOING_PER_SEC)));
    };
    tick();
  });
}

// A path carries the person's address when the panel looks somebody up
// (/v1/customers/<address>/attributes). The log of blitz-api is read by more people than the panel
// is and is copied into the backups, so the address is cut down to the same ab***@domain the page
// shows. Everything else about the path is kept: it is what makes the line worth logging.
function safeLogPath(apiPath) {
  return String(apiPath).replace(/\/v1\/customers\/[^/?]+/, function (seg) {
    const raw = seg.slice('/v1/customers/'.length);
    let id = raw;
    try { id = decodeURIComponent(raw); } catch (e) { /* leave it encoded — it is about to be masked */ }
    return '/v1/customers/' + (maskEmail(id) || '***');
  });
}

function cioRequest(apiPath, timeoutMs) {
  const budget = Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    let req;
    try {
      req = (APP_URL.protocol === 'https:' ? https : http).request({
        protocol: APP_URL.protocol,
        hostname: APP_URL.hostname,
        port: APP_URL.port || undefined,
        path: APP_URL.pathname.replace(/\/+$/, '') + apiPath,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + APP_KEY, 'Accept': 'application/json' },
        timeout: budget
      }, resp => {
        let size = 0;
        const chunks = [];
        resp.on('data', c => {
          size += c.length;
          if (size > MAX_BODY_BYTES) { resp.destroy(); done(reject, new Upstream('answer too large', resp.statusCode)); return; }
          chunks.push(c);
        });
        resp.on('error', () => done(reject, new Upstream('answer interrupted', resp.statusCode)));
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }
          done(resolve, { status: resp.statusCode, json: json });
        });
      });
    } catch (e) { done(reject, new Upstream((e && e.message) || 'request failed', 0)); return; }
    req.on('timeout', () => req.destroy(new Error('timed out after ' + budget + ' ms')));
    req.on('error', e => done(reject, new Upstream((e && e.message) || 'request failed', 0)));
    req.end();
  });
}

/* ── cache ───────────────────────────────────────────────────────────────────────────────── */

// Only successful answers are cached. Caching a failure would keep the panel broken for a minute
// after Customer.io recovered, and caching a 404 would hide a person who was just created.
const cache = new Map();   // apiPath -> { at, value }

// Failures are remembered for ten seconds — not to hide them, but so that a provider which stopped
// answering costs this page one timeout instead of one per section. Ten seconds is shorter than the
// pause between two clicks on Refresh, so the next look is a real one.
const failCache = new Map();   // apiPath -> { at, message, status }

function noteFailure(apiPath, err) {
  failCache.set(apiPath, { at: Date.now(), message: err.message, status: err.upstreamStatus || 0 });
  while (failCache.size > CACHE_MAX_ENTRIES) failCache.delete(failCache.keys().next().value);
}

// Everything this panel reads is a 30-day metric or a journey definition, and neither changes
// between two minutes. Two things are the exception and keep the short life. The letter feed: it is
// the last letters that went out, and the evidence the readiness check reads the test mode off —
// five minutes of it would have the page swear the workspace is still in test mode after somebody
// turned it off. And one person's record: the Emails page unsubscribes and deletes people, and a
// card that still says "subscribed" five minutes after somebody unsubscribed them is the one lie
// that would be acted on.
function ttlFor(apiPath) {
  return (apiPath.startsWith('/v1/messages') || apiPath.startsWith('/v1/customers/')) ? FEED_TTL_MS : CACHE_TTL_MS;
}

function cachePrune(now) {
  for (const [k, v] of cache) if (now - v.at > ttlFor(k)) cache.delete(k);
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  for (const [k, v] of failCache) if (now - v.at > FAIL_TTL_MS) failCache.delete(k);
}

// Resolves { status, json } for 2xx and, when the caller asks for it, for 404. Anything else (and
// every transport failure) throws Upstream. The log gets the path and the status code, never the key
// and never the body.
//
// allow404 is passed only by the customer lookup, where "no such person" is an answer. A 404 from a
// list endpoint is not: it means the account or the plan has no such endpoint, and turning it into an
// empty array would print "no broadcasts" where the truth is "we could not look".
//
// fresh is what the Refresh button asks for: read past the cache and put the answer back into it, so
// that somebody who has just changed something in Customer.io sees it instead of a five-minute-old
// copy. It is a read, and only a read — nothing else about the call changes.
async function cioGet(apiPath, opts) {
  if (!READY) throw new Upstream('not configured', 0);
  const allow404 = !!(opts && opts.allow404);
  const fresh = !!(opts && opts.fresh);
  // Every route sets one deadline for its whole answer and hands it down; a call that arrives after
  // it is over does not start at all.
  const deadline = (opts && opts.deadline) || (Date.now() + OVERALL_DEADLINE_MS);
  const now = Date.now();
  const hit = cache.get(apiPath);
  if (!fresh && hit && now - hit.at <= ttlFor(apiPath)) return hit.value;

  // The ten-second memory of a failure is not skipped, Refresh or not: it is what keeps a provider
  // that has gone quiet costing this page one timeout instead of one per section. Skipping it would
  // turn a Refresh during an outage into the full fifteen-second deadline, every time.
  const bad = failCache.get(apiPath);
  if (bad && now - bad.at <= FAIL_TTL_MS) throw new Upstream(bad.message, bad.status);

  if (deadline - now <= 0) throw new Upstream('Customer.io unavailable', 0);
  await takeToken();

  let res;
  try {
    res = await cioRequest(apiPath, deadline - Date.now());
  } catch (e) {
    const err = e instanceof Upstream ? e : new Upstream((e && e.message) || 'request failed', 0);
    console.error('[marketing] GET ' + safeLogPath(apiPath) + ' failed: ' + ((e && e.message) || 'error'));
    noteFailure(apiPath, err);
    throw err;
  }
  const st = res.status;
  if (st === 404 && allow404) return { status: 404, json: res.json };
  if (st < 200 || st >= 300) {
    console.error('[marketing] GET ' + safeLogPath(apiPath) + ' → HTTP ' + st);
    const err = (st === 401 || st === 403)
      ? new Upstream('Customer.io rejected the API key (HTTP ' + st + ')', st)
      : new Upstream('Customer.io unavailable', st);
    noteFailure(apiPath, err);
    throw err;
  }
  if (res.json === null) {
    console.error('[marketing] GET ' + safeLogPath(apiPath) + ' → HTTP ' + st + ' with an unparsable body');
    const err = new Upstream('Customer.io unavailable', st);
    noteFailure(apiPath, err);
    throw err;
  }
  const value = { status: st, json: res.json };
  cache.set(apiPath, { at: now, value: value });
  cachePrune(now);
  return value;
}

// Same call, but a failure is a missing piece rather than a dead panel: used for metrics and for the
// side sections, so one broken endpoint cannot take the whole page down. The deadline of the page
// load is passed in, never invented here.
async function cioGetSoft(apiPath, deadline, fresh) {
  try { return await cioGet(apiPath, { deadline: deadline, fresh: fresh }); } catch (e) { return null; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/* ── shaping the provider's answers ──────────────────────────────────────────────────────── */

function asList(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of keys) if (Array.isArray(json[k])) return json[k];
  for (const k of ['data', 'items', 'results']) if (Array.isArray(json[k])) return json[k];
  return [];
}

// Customer.io timestamps come as Unix seconds (verified on the live account: campaign.created =
// 1788785388). Milliseconds and ISO strings are accepted too, because this is read from an API we
// do not control and a wrong unit would print the year 1970 on the page.
function toIso(v) {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function str(v, max) {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > (max || 200) ? s.slice(0, max || 200) : s;
}

// ab***@domain — enough to recognise a person you already know, useless to someone reading over a
// shoulder. Anything that is not an address is hidden completely.
function maskEmail(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return head + '***@' + domain;
}

// Metrics come back as one series per counter: { metric: { series: { created: [...31 numbers] } } },
// one number per day. The names are the account's own, and the live account (2026-09-08, App API
// snapshot in api_shapes_2026-09-08.md) answers with attempted, bounced, clicked, converted, created,
// deferred, delivered, drafted, end, failed, human_clicked, human_opened, link_untracked and the
// machine_* pair — there is no series called `sent` and none called `opened`.
//
// So: a letter that went out is `created`; an open or a click is counted twice over, once for the
// person (human_*) and once for whatever mail scanner touched the letter, and the human counters are
// what a marketer means by "opened" — hence they come first. The plain names are kept behind them for
// an account that does answer with them; a counter that is nowhere stays null, because a 0 would read
// as "nobody opened it" when the truth is "we could not read it".
const METRIC_ALIASES = {
  sent: ['sent', 'sends', 'created', 'attempted'],
  delivered: ['delivered', 'deliveries'],
  opened: ['human_opened', 'opened', 'opens', 'unique_opens'],
  clicked: ['human_clicked', 'clicked', 'clicks', 'unique_clicks'],
  unsubscribed: ['unsubscribed', 'unsubscribes', 'unsubscribe'],
  bounced: ['bounced', 'bounces']
};

function findSeries(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json.metric && json.metric.series, json.metrics && json.metrics.series, json.series,
    json.metric, json.metrics, json
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (Array.isArray(v) || typeof v === 'number') return c;   // series, or already-summed totals
    }
  }
  return null;
}

function sumOne(series, names) {
  for (const n of names) {
    const v = series[n];
    if (Array.isArray(v)) {
      let total = 0, seen = false;
      for (const x of v) { const n2 = Number(x); if (Number.isFinite(n2)) { total += n2; seen = true; } }
      if (seen) return total;
    } else if (Number.isFinite(Number(v)) && v !== null && v !== '') {
      return Number(v);
    }
  }
  return null;
}

function metricsFrom(answer) {
  if (!answer || !answer.json) return null;
  const series = findSeries(answer.json);
  if (!series) return null;
  const out = {};
  let any = false;
  for (const key of Object.keys(METRIC_ALIASES)) {
    out[key] = sumOne(series, METRIC_ALIASES[key]);
    if (out[key] !== null) any = true;
  }
  return any ? out : null;
}

// The deep link into the Customer.io interface is built from the workspace id, because the API hands
// out no address of its own. The shapes below were copied from the live interface on 2026-09-09 rather
// than guessed: the guesses that stood here before ('/journeys/campaigns/…', '/journeys/newsletters/…')
// were written without an example, and the sibling guess for segments answered "Page not found".
// A campaign points at its workflow, not an overview: the workflow address is the one that was seen
// working, and one verified address beats a prettier unverified one.
function campaignEditUrl(id) {
  return 'https://fly.customer.io/workspaces/' + encodeURIComponent(WORKSPACE_ID) +
         '/journeys/automations/' + encodeURIComponent(String(id)) + '/setup/workflow/actions';
}
function broadcastEditUrl(id) {
  return 'https://fly.customer.io/workspaces/' + encodeURIComponent(WORKSPACE_ID) +
         '/journeys/broadcasts/broadcast/' + encodeURIComponent(String(id)) + '/overview';
}

// The five events the storefront actually sends (products-api, phase 3 — the contract is
// .scratch/shop-stage3/contract_events.md §3). A journey waiting for anything else never starts, and
// the panel says so on its row: four of the eight journeys in the account wait for events nobody
// sends. This list moves when the storefront does — adding an event there without adding it here
// shows a warning that is not true, which is the safe way round of being wrong.
// order_delivered and user_inactive: services/cio-events, 2026-09-30.
const SHOP_EVENTS = ['subscribed', 'cart_updated', 'checkout_started', 'order_placed', 'order_status_changed', 'order_delivered', 'user_inactive'];

// Segment ids as the API hands them out. Anything that is not a number is dropped rather than
// printed: the page turns these into "joins segment #18".
function numIds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const n = Number(x);
    if (Number.isFinite(n) && out.length < 20) out.push(n);
  }
  return out;
}

function shapeCampaign(c, detail, metrics, editUrl) {
  const eventName = str(c && c.event_name, 120);
  return {
    id: c && c.id !== undefined ? c.id : null,
    name: str(c && c.name, 160) || '(no name)',
    state: str(c && c.state, 40),
    active: typeof (c && c.active) === 'boolean' ? c.active : null,
    trigger: {
      type: str(c && (c.event_type || c.type), 40),
      event_name: eventName,
      // A campaign entered by a segment carries no event name at all, only trigger_segment_ids in
      // its detail — without them the page had nothing to print but the provider's internal word
      // for that kind of trigger ("seg_attr"). Broadcasts come through here with detail = null, so
      // the list object is read as well.
      segment_ids: numIds((detail && detail.trigger_segment_ids) || (c && c.trigger_segment_ids)),
      // null for a segment campaign: "does the shop send it" is not a question about a segment.
      event_from_shop: eventName ? SHOP_EVENTS.indexOf(eventName) !== -1 : null
    },
    created_by: str(detail && detail.created_by, 160),
    updated: toIso(c && c.updated),
    edit_url: editUrl,
    metrics30d: metrics
  };
}

function shapeActivity(a) {
  if (!a || typeof a !== 'object') return null;
  const d = (a.data && typeof a.data === 'object') ? a.data : {};
  const person = a.customer_identifiers && typeof a.customer_identifiers === 'object'
    ? (a.customer_identifiers.email || a.customer_identifiers.id) : null;
  return {
    ts: toIso(a.timestamp !== undefined ? a.timestamp : (a.created_at !== undefined ? a.created_at : a.created)),
    name: str(a.name || a.type || a.metric, 120),
    email: str(person || a.customer_id || a.identifier || d.email || d.recipient, 200),
    email_masked: maskEmail(person || a.customer_id || a.identifier || d.email || d.recipient)
  };
}

/* ── GET /api/marketing/overview ─────────────────────────────────────────────────────────── */

router.get('/overview', async (req, res) => {
  try {
    // One deadline for the whole answer. The sections used to be read one after another, each with
    // its own eight seconds, so a provider that had gone quiet held the page for about forty.
    const deadline = Date.now() + OVERALL_DEADLINE_MS;
    // ?fresh=1 comes from the Refresh button and from nowhere else — the first load of the page does
    // not send it, so opening the panel is a cache hit whenever somebody looked in the last minutes.
    const fresh = req.query.fresh === '1';

    // The campaigns list is the one call the page cannot do without: if it fails, the panel says so
    // instead of drawing an empty table that looks like "no journeys".
    const campaignsAnswer = await cioGet('/v1/campaigns', { deadline: deadline, fresh: fresh });
    const rawCampaigns = asList(campaignsAnswer.json, ['campaigns']);

    const campaigns = await mapLimit(rawCampaigns, MAX_INFLIGHT, async c => {
      const id = c && c.id;
      if (id === undefined || id === null) return shapeCampaign(c, null, null, null);
      const enc = encodeURIComponent(String(id));
      // created_by lives only in the per-campaign answer (verified against the 07.09 snapshot: the
      // list has no such key), so it costs one extra call per campaign — a soft one.
      const [detailAnswer, metricsAnswer] = await Promise.all([
        cioGetSoft('/v1/campaigns/' + enc, deadline, fresh),
        cioGetSoft('/v1/campaigns/' + enc + '/metrics?period=days&steps=30&type=email', deadline, fresh)
      ]);
      const detail = detailAnswer && detailAnswer.json ? (detailAnswer.json.campaign || detailAnswer.json) : null;
      return shapeCampaign(c, detail, metricsFrom(metricsAnswer), campaignEditUrl(id));
    });

    // Everything below is a side section: if the account or the plan does not have it, the page shows
    // "unavailable" for that block only. They do not depend on one another, so they are read together
    // — four sections in a row used to add their timeouts up.
    const [transactionalAnswer, broadcastsAnswer, messagesAnswer, workspacesAnswer] = await Promise.all([
      cioGetSoft('/v1/transactional', deadline, fresh),
      cioGetSoft('/v1/broadcasts', deadline, fresh),
      cioGetSoft('/v1/messages?limit=20', deadline, fresh),
      cioGetSoft('/v1/workspaces', deadline, fresh)
    ]);

    let transactional = null;
    if (transactionalAnswer) {
      const rawT = asList(transactionalAnswer.json, ['transactional_messages', 'messages', 'transactional']);
      transactional = await mapLimit(rawT, MAX_INFLIGHT, async t => {
        const id = t && t.id;
        const m = id === undefined || id === null ? null
          : metricsFrom(await cioGetSoft('/v1/transactional/' + encodeURIComponent(String(id)) + '/metrics?period=days&steps=30', deadline, fresh));
        return { id: id === undefined ? null : id, name: str(t && t.name, 160) || '(no name)', metrics30d: m };
      });
    }

    let broadcasts = null;
    if (broadcastsAnswer) {
      const rawB = asList(broadcastsAnswer.json, ['broadcasts', 'newsletters']);
      broadcasts = await mapLimit(rawB, MAX_INFLIGHT, async b => {
        const id = b && b.id;
        const m = id === undefined || id === null ? null
          : metricsFrom(await cioGetSoft('/v1/broadcasts/' + encodeURIComponent(String(id)) + '/metrics?period=days&steps=30&type=email', deadline, fresh));
        return shapeCampaign(b, null, m, id === undefined || id === null ? null : broadcastEditUrl(id));
      });
    }

    // The feed is the last letters, not "activities": /v1/messages is the only activity-shaped
    // endpoint whose answer is confirmed against the live account (recipient, customer_identifiers,
    // failure_message), and what went out — and what failed — is what the panel is looked at for.
    const lastMessages = messagesAnswer
      ? asList(messagesAnswer.json, ['messages']).map(shapeMessage).filter(Boolean).slice(0, 20)
      : null;

    const ws = workspaceInfo(workspacesAnswer);

    res.json({
      workspace: { people: ws.people, messages_sent: ws.messages_sent },
      campaigns: campaigns,
      transactional: transactional,
      broadcasts: broadcasts,
      last_messages: lastMessages,
      fetched_at: new Date().toISOString()
    });
  } catch (e) { fail(res, e); }
});

// /v1/workspaces carries the account's own counters: people, messages_sent, billable_messages_sent.
// messages_sent is the workspace total the provider itself shows, not a 30-day figure — the card on
// the page says so. Adding up 30 days of campaign metrics instead (what this used to do) produced a
// number that matched nothing anybody could check.
function workspaceInfo(answer) {
  const out = { people: null, messages_sent: null };
  if (!answer || !answer.json) return out;
  const j = answer.json;
  const list = asList(j, ['workspaces']);
  const mine = list.find(w => w && String(w.id) === String(WORKSPACE_ID)) || (list.length === 1 ? list[0] : null);
  for (const src of [mine, j]) {
    if (!src || typeof src !== 'object') continue;
    if (out.people === null) {
      for (const k of ['people', 'people_count', 'customer_count', 'customers']) {
        const v = Number(src[k]);
        if (Number.isFinite(v)) { out.people = v; break; }
      }
    }
    if (out.messages_sent === null) {
      for (const k of ['messages_sent', 'billable_messages_sent']) {
        const v = Number(src[k]);
        if (Number.isFinite(v)) { out.messages_sent = v; break; }
      }
    }
  }
  return out;
}

/* ── GET /api/marketing/customer?email= ──────────────────────────────────────────────────── */

// The attribute bag of a real profile is small, but it is written by other people's integrations —
// a cap keeps one oversized value from filling the page and the response.
//
// `envelope` is what decides found/not-found, not the number of attributes: a profile created by an
// identify that carried nothing but the address has an empty bag, and reporting that person as "not
// in Customer.io" would send someone hunting for a bug that is not there.
function shapeAttributes(json) {
  const envelope = json && typeof json === 'object' && (json.customer || json.person);
  const src = envelope || json || {};
  const bag = (src.attributes && typeof src.attributes === 'object') ? src.attributes : src;
  const out = {};
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    let n = 0;
    for (const k of Object.keys(bag)) {
      if (n >= 60) break;
      const v = bag[k];
      if (v === null || v === undefined || typeof v === 'function') continue;
      out[String(k).slice(0, 80)] = str(v, 200);
      n++;
    }
  }
  return { found: !!envelope || Object.keys(out).length > 0, attributes: out };
}

// GET /v1/messages and the per-person list answer with created, type ('email'), recipient, subject,
// customer_identifiers.email, failure_message, campaign_id, transactional_message_id.
//
// `type` is deliberately not a fallback for `state`: it is the channel the letter went out on, and
// using it put the word "email" in the State column of every row. When the account says nothing about
// the state but did report why the letter failed, "failed" is the state.
function shapeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const ids = (m.customer_identifiers && typeof m.customer_identifiers === 'object') ? m.customer_identifiers : {};
  const failure = str(m.failure_message, 200);
  return {
    ts: toIso(m.created !== undefined ? m.created : (m.created_at !== undefined ? m.created_at : m.timestamp)),
    subject: str(m.subject, 200),
    // Full address, not the masked one (2026-09-09). This is a screen behind the CRM login, and the same
    // addresses are printed in full two tabs away in Orders, Leads and Customers; hiding them here only
    // stopped a manager finding the person a letter went to. maskEmail() stays where it belongs: log
    // lines and the audit trail, which outlive the screen and are read by other tools.
    recipient: str(m.recipient || m.to || ids.email || (m.identifiers && m.identifiers.email), 200),
    recipient_masked: maskEmail(m.recipient || m.to || ids.email || (m.identifiers && m.identifiers.email)),
    type: str(m.type, 40),
    state: str(m.state || m.status, 40) || (failure ? 'failed' : null),
    failure_message: failure || null
  };
}

router.get('/customer', async (req, res) => {
  try {
    const raw = typeof req.query.email === 'string' ? req.query.email : '';
    const email = authUtils.normalizeEmail(raw);
    if (!email || !authUtils.isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid e-mail address is required' });
    }
    const enc = encodeURIComponent(email);
    const deadline = Date.now() + OVERALL_DEADLINE_MS;

    const attrAnswer = await cioGet('/v1/customers/' + enc + '/attributes?id_type=email', { allow404: true, deadline: deadline });
    if (attrAnswer.status === 404) {
      return res.json({ found: false, attributes: null, last_messages: [], last_events: [] });
    }
    // An account can answer 200 with nothing in it for someone it has never seen; that is "not found"
    // to the person looking at the page, not an empty card.
    const shaped = shapeAttributes(attrAnswer.json);
    if (!shaped.found) {
      return res.json({ found: false, attributes: null, last_messages: [], last_events: [] });
    }
    const attributes = shaped.attributes;

    const [msgAnswer, actAnswer] = await Promise.all([
      cioGetSoft('/v1/customers/' + enc + '/messages?id_type=email&limit=20', deadline),
      cioGetSoft('/v1/customers/' + enc + '/activities?id_type=email&limit=50', deadline)
    ]);

    res.json({
      found: true,
      attributes: attributes,
      last_messages: msgAnswer ? asList(msgAnswer.json, ['messages']).map(shapeMessage).filter(Boolean).slice(0, 20) : null,
      last_events: actAnswer ? asList(actAnswer.json, ['activities']).map(shapeActivity).filter(Boolean).slice(0, 50) : null,
      fetched_at: new Date().toISOString()
    });
  } catch (e) { fail(res, e); }
});

/* ── GET /api/marketing/readiness ────────────────────────────────────────────────────────── */

// The orders live in products-api, not here. The caller's own Bearer is passed through, so this
// route can never read more than the person asking for it could read themselves.
function ordersStatusFill(authHeader) {
  return new Promise(resolve => {
    if (!ORDERS_URL || !authHeader) return resolve({ with_status: null, total: null });
    let settled = false;
    const done = v => { if (settled) return; settled = true; resolve(v); };
    let req;
    try {
      req = (ORDERS_URL.protocol === 'https:' ? https : http).request({
        protocol: ORDERS_URL.protocol,
        hostname: ORDERS_URL.hostname,
        port: ORDERS_URL.port || undefined,
        path: ORDERS_URL.pathname.replace(/\/+$/, '') + '/msolpeptides-api/orders',
        method: 'GET',
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        timeout: REQUEST_TIMEOUT_MS
      }, resp => {
        let size = 0;
        const chunks = [];
        resp.on('data', c => {
          size += c.length;
          if (size > MAX_BODY_BYTES) { resp.destroy(); done({ with_status: null, total: null }); return; }
          chunks.push(c);
        });
        resp.on('error', () => done({ with_status: null, total: null }));
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            console.error('[marketing] orders for readiness → HTTP ' + resp.statusCode);
            return done({ with_status: null, total: null });
          }
          let list;
          try { list = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { list = null; }
          if (!Array.isArray(list)) return done({ with_status: null, total: null });
          // orders.json is not a list of orders: insider signups live in the same file (no ref, no items), and one
          // basket can be written twice under the same ref (two channels, July 2026). Counting every record made the
          // line read "5 of 24" — a wall of work that is not there. A record is an order when it carries a ref and
          // items; a ref seen twice is the same order, so the first record wins. `skipped` is what was dropped as
          // not-an-order, so the line can say why the total is smaller than the file.
          // Our own probe runs (BF-SMOKE…, PROBE…) are deliberately left in the count: which prefix a probe uses is
          // our choice today and can be another one tomorrow, and filtering someone else's data by name is how a
          // real order goes missing.
          // The ref alone decides. Requiring items as well would drop the orders typed into the CRM by hand: those
          // carry a server-made ref and a single product in `product`/`qty`, never an `items` array, and dropping
          // them would hide exactly the orders a person entered on purpose.
          const seen = new Set();
          let withStatus = 0, counted = 0, skipped = 0;
          for (const o of list) {
            const ref = o && typeof o.ref === 'string' ? o.ref.trim() : '';
            if (ref === '') { skipped++; continue; }
            if (seen.has(ref)) continue;
            seen.add(ref);
            counted++;
            if (typeof o.status === 'string' && o.status.trim() !== '') withStatus++;
          }
          done({ with_status: withStatus, total: counted, skipped: skipped });
        });
      });
    } catch (e) { return done({ with_status: null, total: null }); }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', () => done({ with_status: null, total: null }));
    req.end();
  });
}

// In test mode (or with a sandbox address set) Customer.io hands a letter to somebody other than
// the person it is about: in /v1/messages the `recipient` is then not that person's own address
// (`customer_identifiers.email`). The rule this replaces asked whether the last ten letters all went
// to one and the same address, and on the live account (2026-09-08) it answered "no" while test mode
// was on: one order sends two letters, the manager's copy — which does reach its own addressee — and
// the buyer's, which is the redirected one, so the addresses are never all the same.
//
// One mismatch on its own is not proof: a person can forward their own mail. The same foreign
// address used more than once inside the window is.
//
//   null  — the letters could not be read, there was nothing to judge by, or the only sign is a
//           single mismatch that never repeats (that is "cannot tell", not "all clear")
//   false — letters were read and every one of them went to its own addressee
//   true  — a foreign recipient that repeats; `evidence` says which address, how many of the letters
//           went there and when the last one did
function testModeCheck(messagesAnswer) {
  const unknown = () => ({ suspected: null, evidence: null });
  if (!messagesAnswer || !messagesAnswer.json) return unknown();
  // The newest few letters only. A wider window describes the past, not the switch as it stands: on
  // 2026-09-09 sixteen redirected letters sat in the account, and with a window of twenty this line
  // would have stayed red for days after the switch was actually turned off — a checklist that lies
  // in the safe direction is still a checklist nobody trusts. Eight is two orders' worth of mail
  // (each order sends two), so the line follows the setting within a couple of sends either way.
  const TEST_MODE_WINDOW = 8;
  // A broadcast is left out of this entirely: its message keeps the address it was aimed at in
  // `recipient` even when the sandbox took the delivery. Seen live on 2026-09-09 — the newsletter to
  // yaniv@mastersol-ltd.com read as delivered to that address while the sandbox was on, and the same
  // address bounced with "no such user" once the sandbox was off. Judging the switch by a broadcast
  // says the opposite of the truth, which is how this line came to claim that test mode does not
  // cover newsletters.
  const items = asList(messagesAnswer.json, ['messages'])
    .filter(m => m && (m.broadcast_id === undefined || m.broadcast_id === null))
    .slice(0, TEST_MODE_WINDOW);
  const norm = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const seen = new Map();   // recipient -> { count, last_at }
  const foreign = [];       // recipients that were handed a letter about somebody else
  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const recipient = norm(m.recipient);
    if (!recipient) continue;
    const ids = m.customer_identifiers && typeof m.customer_identifiers === 'object' ? m.customer_identifiers : {};
    const person = norm(ids.email);
    const row = seen.get(recipient) || { count: 0, last_at: null };
    row.count++;
    // toIso answers with UTC strings of one shape, so the newest is simply the largest one and the
    // order the provider sent the list in is not relied on.
    const at = toIso(m.created !== undefined ? m.created : (m.created_at !== undefined ? m.created_at : m.timestamp));
    if (at && (row.last_at === null || at > row.last_at)) row.last_at = at;
    seen.set(recipient, row);
    if (person && person !== recipient && foreign.indexOf(recipient) === -1) foreign.push(recipient);
  }
  if (seen.size === 0) return unknown();

  // The newest letter decides when it reached its own addressee. The sandbox redirects every letter
  // it touches, so one letter at its own address is proof the switch is off — and it is proof the
  // minute after somebody flips it, which a rule counting redirects in a window can never be: the
  // window still holds yesterday's redirected mail and keeps the line red for days.
  let newest = null;
  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const recipient = norm(m.recipient);
    const person = norm((m.customer_identifiers || {}).email);
    if (!recipient || !person) continue;
    const at = toIso(m.created !== undefined ? m.created : (m.created_at !== undefined ? m.created_at : m.timestamp));
    if (!newest || (at || '') > (newest.at || '')) newest = { at: at, matched: recipient === person };
  }
  if (newest && newest.matched) return { suspected: false, evidence: null };

  let best = null;
  for (const recipient of foreign) {
    const row = seen.get(recipient);
    if (row.count < 2) continue;   // a lone forwarded letter is not a redirect
    if (!best || row.count > best.count ||
        (row.count === best.count && (row.last_at || '') > (best.last_at || ''))) {
      best = { recipient: recipient, count: row.count, last_at: row.last_at };
    }
  }
  if (best) {
    return {
      suspected: true,
      // masked, like every other address this module puts on the page or in a log
      // The address here is the workspace's own test inbox, not a customer's, and the line is useless
      // without it: "mail is going to bl***@proton.me" tells a manager nothing they can act on.
      evidence: { recipient: str(best.recipient, 200), recipient_masked: maskEmail(best.recipient), count: best.count, last_at: best.last_at }
    };
  }
  return foreign.length ? unknown() : { suspected: false, evidence: null };
}

// M6: has a signup ever recorded consent? The honest answer is in the lead list. products-api stamps
// marketing_consent_at on every signup since M6, so a single lead carrying it proves the whole path at once
// — the storefront sends the flag, the server stamps it, the lead keeps it — which is more than a flag in
// .env could ever say. A file that cannot be read answers "no", never "yes": this checklist is read before a
// launch, and it must not tick a line because a file was missing.
async function consentCapture() {
  try {
    const st = await fs.promises.stat(LEADS_FILE);
    if (!st.isFile() || st.size > LEADS_MAX_BYTES) return { supported: false, since: null, count: 0, readable: false };
    const list = JSON.parse(await fs.promises.readFile(LEADS_FILE, 'utf8'));
    if (!Array.isArray(list)) return { supported: false, since: null, count: 0, readable: false };
    let count = 0, since = null;
    for (const lead of list) {
      if (!lead || typeof lead !== 'object') continue;
      const at = typeof lead.marketing_consent_at === 'string' ? lead.marketing_consent_at.trim() : '';
      if (!at) continue;
      count++;
      // ISO 8601 in UTC is the only shape products-api writes, and text order is date order for it.
      if (since === null || at < since) since = at;
    }
    return { supported: count > 0, since: since, count: count, readable: true };
  } catch (e) {
    console.error('[marketing] the lead list could not be read for the consent check: ' + ((e && e.message) || 'error'));
    return { supported: false, since: null, count: 0, readable: false };
  }
}

// The hint under that line. The page hides a hint on a line that is already green; the answer still carries
// it, so anyone reading /readiness sees since when consent has been recorded rather than an empty field.
function consentHint(c) {
  if (c.supported) {
    const since = c.since ? String(str(c.since, 40)).slice(0, 10) : '';
    return 'Recorded at signup' + (since ? ' since ' + since : '') + ' (' + c.count + ' so far). Nothing to do.';
  }
  if (!c.readable) return 'The lead list could not be read just now, so consent capture cannot be confirmed — look at /opt/crm-api/data/leads.json.';
  return 'No signup has recorded consent yet. The storefront form sends it and /subscribe stamps it (phase M6): this line ticks with the first new subscriber.';
}

/* ── the trigger filter of the abandonment journey ───────────────────────────────────────── */

// The attribute the storefront keeps on the profile for exactly this filter (phase 3 delta, cart
// attributes): order_placed resets it to 0, which is what makes it the one safe thing to filter on.
const CART_ATTRIBUTE = 'cart_item_count';

// The attribute is looked for by an exact value match anywhere in the condition tree, so a
// neighbouring "cart_item_count_30d" is not taken for it. The object it was found in is what comes
// back, so the line on the page can name the operator too. Depth is capped because this is a shape
// we do not control.
function findCartCondition(node, depth) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (!Array.isArray(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && v.trim().toLowerCase() === CART_ATTRIBUTE) return node;
    }
  }
  for (const k of Object.keys(node)) {
    const hit = findCartCondition(node[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Does the abandonment journey only let in people who still have something in the cart? The
// checklist used to answer "the API does not report trigger filters" — it does: the campaign detail
// carries filter_segment_ids and the segment behind it carries the condition (both read off the live
// account on 2026-09-09, campaign 7 → segment 20 → cart_item_count gt 0).
//
//   true  — one of the filter segments tests cart_item_count; the sentence names it
//   false — the journey has no trigger filter at all, or the ones it has test something else
//   null  — nothing could be read: no journey with that name, or the provider did not answer. A
//           refusal from Customer.io must never come out as "no filter", which would send somebody
//           to add a filter that is already there.
async function abandonmentFilterCheck(campaigns, deadline, fresh) {
  const out = (state, text) => ({ state: state, detail: str(text, 240) });
  const c = (campaigns || []).find(x => x && String(x.name || '').toLowerCase().includes('abandon'));
  if (!c || c.id === undefined || c.id === null) {
    return out(null, 'No journey with "abandon" in its name — nothing to check here yet.');
  }
  const name = str(c.name, 160) || '(no name)';
  const answer = await cioGetSoft('/v1/campaigns/' + encodeURIComponent(String(c.id)), deadline, fresh);
  if (!answer) return out(null, 'Customer.io did not answer for "' + name + '" just now.');
  const detail = answer.json && (answer.json.campaign || answer.json);
  const ids = numIds(detail && detail.filter_segment_ids);
  if (!ids.length) {
    return out(false, '"' + name + '" has no trigger filter: everyone the trigger event reaches enters it.');
  }
  let unreadable = 0;
  const others = [];
  for (const id of ids) {
    const seg = await cioGetSoft('/v1/segments/' + encodeURIComponent(String(id)), deadline, fresh);
    if (!seg) { unreadable++; continue; }
    const s = seg.json && (seg.json.segment || seg.json);
    const segName = str(s && s.name, 120) || ('segment #' + id);
    const hit = findCartCondition(s && s.conditions, 0);
    if (hit) {
      const op = str(hit.operator, 24);
      const val = str(hit.value, 24);
      return out(true, 'Filtered by "' + segName + '" (#' + id + ')' +
        (op ? ': ' + CART_ATTRIBUTE + ' ' + op + (val === null ? '' : ' ' + val) : '') + '.');
    }
    others.push('"' + segName + '" (#' + id + ')');
  }
  if (unreadable) return out(null, 'The filter segments of "' + name + '" could not be read just now.');
  return out(false, '"' + name + '" is filtered by ' + others.join(', ') + ', which does not test ' + CART_ATTRIBUTE + '.');
}

const HINTS = {
  keys_present: 'Customer.io → Account Settings → API Credentials: put CIO_APP_API_KEY in /opt/crm-api/.env and restart blitz-api.',
  test_mode_suspected: 'Customer.io → Workspace settings → test/sandbox address: turn off before launch.',
  campaigns_draft: 'Customer.io → Journeys: open each campaign listed here and press Start — a draft never sends.',
  abandonment_filter: 'Customer.io → Shop Abandonment → trigger filter: add Profile attribute cart_item_count greater than 0, or the journey chases people whose cart is already empty.',
  replenishment_exists: 'Customer.io → Journeys → New campaign, trigger order_placed, a delay, exit on a new order. Name it so it contains "replenishment".',
  vip_exists: 'Customer.io → Journeys → New campaign entered by the manual segment "VIP (CRM)". Name it so it contains "VIP".',
  broadcast_exists: 'Customer.io → Newsletters → API-triggered broadcast "CRM Newsletter" — the CRM needs one to send from (phase M3).',
  orders_status_fill: 'CRM → Orders: set a real status on each order. Journeys that branch on order status stay silent while the field is empty.',
  // replaced per answer by consentHint(); this line is what a caller sees if that ever fails to run
  consent_field_supported: 'The signup form records marketing consent (phase M6); this line ticks once a lead carries it.'
};

router.get('/readiness', async (req, res) => {
  try {
    const deadline = Date.now() + OVERALL_DEADLINE_MS;
    const fresh = req.query.fresh === '1';   // the Refresh button, same as /overview
    const orders = await ordersStatusFill(req.headers.authorization);
    const consent = await consentCapture();

    if (!READY) {
      return res.json({
        keys_present: false,
        test_mode_suspected: null,
        test_mode_evidence: null,
        campaigns_draft: null,
        abandonment_filter: null,
        abandonment_filter_detail: null,
        replenishment_exists: null,
        vip_exists: null,
        broadcast_exists: null,
        orders_status_fill: orders,
        consent_field_supported: consent.supported,
        hints: Object.assign({}, HINTS, { consent_field_supported: consentHint(consent) }),
        fetched_at: new Date().toISOString()
      });
    }

    const campaignsAnswer = await cioGet('/v1/campaigns', { deadline: deadline, fresh: fresh });
    const list = asList(campaignsAnswer.json, ['campaigns']);
    const names = list.map(c => str(c && c.name, 160) || '').filter(Boolean);
    const draft = list
      .filter(c => c && (c.active === false || String(c.state || '').toLowerCase() !== 'running'))
      .map(c => str(c.name, 160) || '(no name)');

    // The filter check reads the abandonment campaign and its segments; it rides in the same
    // Promise.all and on the same deadline as the side sections, so it costs the page no extra wait.
    const [broadcastsAnswer, messagesAnswer, abandonment] = await Promise.all([
      cioGetSoft('/v1/broadcasts', deadline, fresh),
      cioGetSoft('/v1/messages?limit=50', deadline, fresh),
      abandonmentFilterCheck(list, deadline, fresh)
    ]);

    // "exists" is a name match, and that is all it can be: the API says nothing about what a journey
    // does inside. Naming is part of the recipe the owner follows (see hints).
    const has = word => names.some(n => n.toLowerCase().includes(word));
    const testMode = testModeCheck(messagesAnswer);

    res.json({
      keys_present: true,
      test_mode_suspected: testMode.suspected,
      test_mode_evidence: testMode.evidence,
      campaigns_draft: draft,
      abandonment_filter: abandonment.state,
      abandonment_filter_detail: abandonment.detail,
      replenishment_exists: has('replenish'),
      vip_exists: has('vip'),
      broadcast_exists: broadcastsAnswer ? asList(broadcastsAnswer.json, ['broadcasts', 'newsletters']).length > 0 : null,
      orders_status_fill: orders,
      consent_field_supported: consent.supported,
      hints: Object.assign({}, HINTS, { consent_field_supported: consentHint(consent) }),
      fetched_at: new Date().toISOString()
    });
  } catch (e) { fail(res, e); }
});

/* ── failure shaping ─────────────────────────────────────────────────────────────────────── */

// Every handler catches its own throw: express 5 would forward a rejected promise to the error
// middleware, but nothing here should ever reach it, and the message the client sees is ours, never
// the provider's body.
function fail(res, e) {
  if (res.headersSent) return;
  if (e instanceof Upstream) {
    if (!READY) return res.status(503).json({ error: 'Customer.io not configured' });
    // Three sentences can reach a browser and no more: a message thrown by Node ("connect ECONNREFUSED
    // 10.0.0.1:443") would put the provider's address on the page. The detail stays in the log.
    return res.status(503).json({
      error: /rejected the API key/.test(e.message) ? e.message : 'Customer.io unavailable'
    });
  }
  console.error('[marketing] handler failed: ' + ((e && e.message) || 'error'));
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = router;
