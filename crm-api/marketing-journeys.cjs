/**
 * BioLabs Research CRM — Journeys map (2026-09-30): which events the shop sends, which Customer.io journeys wait for
 * them and which letters go out. View only.
 *
 * Mounted by server_v14.cjs behind the session gate, next to the other marketing modules:
 *     app.use('/api/marketing/journeys', requireAuth, require('./marketing-journeys.cjs')({}));
 * One route, GET /. Role is not checked (phase 5, EQUAL_RIGHTS), the same as the Emails page.
 *
 * What it does NOT do, on purpose:
 *   - it writes nothing to Customer.io and nothing to disk. The App API cannot change a journey's trigger, delays
 *     or conditions (checked against the OpenAPI on 2026-09-30), so the page says where to look instead;
 *   - it shares no code with marketing-emails.cjs / marketing-routes.cjs: those files are edited by other work, and
 *     a copy of a 60-line transport is cheaper than a change in one breaking the other.
 *
 * Rules kept (same as the neighbours):
 *   - the App API key never reaches the client or a log line;
 *   - a Customer.io failure is answered 200 with cio:{ok:false,error:"…"}: the shared api() of the pages replaces the
 *     body of a 503 with its own generic text, and the store-event catalog needs no Customer.io to be shown;
 *   - a metric that could not be read is null, not 0 (a zero would read as "nobody opened it");
 *   - strings from Customer.io are cut and stripped of control characters here; the page escapes them on output;
 *   - one page load costs about 2 calls per journey; the answer is cached (5 min, 30 s when a part of it is missing).
 *     ?fresh=1 (the Refresh button) reads past the cache, but not when the cache is younger than 30 s: it then answers
 *     the cached data marked throttled with refresh_in_s. The brake on outgoing calls is per module (the neighbours
 *     have their own), so together they can reach the 10 requests a second the App API allows; the same key sends the
 *     order letters of products-api, which is why a Refresh held down must not turn into a read per click.
 *
 * Config (/opt/crm-api/.env, read into process.env at startup by server_v14.cjs): CIO_APP_API_KEY, CIO_REGION,
 * CIO_API_BASE (also the seam a local stand points at its stub), CIO_WORKSPACE_ID (only for "Open in Customer.io").
 */
'use strict';

const https = require('https');
const http = require('http');

/* ── the events the shop sends ────────────────────────────────────────────────────────────────
 * Read from the code, not from a plan (products-api.cjs as of the 2026-09-30 snapshot; test/journeys.test.cjs checks
 * the names and the data keys against that file, so a rename there fails a test here):
 *   subscribed                    products-api.cjs:1990   POST /subscribe, keys from the call itself
 *   cart_updated, checkout_started products-api.cjs:2028   POST /track -> cioTrackCart, keys from trackEventData (1215)
 *                                 browser side: var/www/biofirst/html/cart-vial.js:400-524 (5 s debounce; checkout once per 30 min)
 *   order_placed                  products-api.cjs:2177 (notify-order), :4056 (card-import track), :4100 (mail-outbox);
 *                                 keys from orderPlacedData (1152)
 *   order_status_changed          products-api.cjs:2719 (PATCH /orders), :4100 (mail-outbox); keys ref + status
 *   order_delivered               products-api.cjs PATCH /orders and mail-outbox, keys from orderDeliveredData (services/cio-events)
 *   user_inactive                 /opt/cio-winback/winback.cjs, daily cron (services/cio-events/winback.cjs)
 * The transactional letters: order-manager / order-customer are sent by products-api.cjs:2173 (mailOutboxSend 4080-4090);
 * order-paid / -shipped / -in-transit / -delivered by stage 1 of the order letters (contract 2026-09-30).
 * This list moves when the storefront does. A name added here without being sent shows "listened by" for nothing;
 * a name sent but missing here makes a journey look dead when it is not — keep both in step with SHOP_EVENTS of
 * marketing-routes.cjs (the test compares them). */
const SHOP_EVENTS = [
  {
    name: 'subscribed',
    when: 'A visitor signs up for the newsletter or the welcome code on the site.',
    senders: ['products-api: POST /subscribe'],
    data: ['coupon', 'page', 'first_name'],
    note: 'Each field is left out when it is empty.'
  },
  {
    name: 'cart_updated',
    when: 'The cart of a visitor who left an address changes (sent 5 seconds after the last change).',
    senders: ['products-api: POST /track, called by the storefront script cart-vial.js'],
    data: ['items (slug, name, mg, qty, price)', 'total', 'item_count', 'cart_url'],
    note: 'Nothing is sent for a visitor without an address: the browser has no token for them.'
  },
  {
    name: 'checkout_started',
    when: 'A visitor who left an address opens the checkout page (at most once per 30 minutes).',
    senders: ['products-api: POST /track, called by the storefront script cart-vial.js'],
    data: ['items (slug, name, mg, qty, price)', 'total', 'item_count', 'cart_url'],
    note: 'Nothing is sent for a visitor without an address: the browser has no token for them.'
  },
  {
    name: 'order_placed',
    when: 'An order appears: submitted on the site (crypto or price request) or a card payment picked up into the CRM.',
    senders: ['products-api: POST /notify-order', 'products-api: card-import', 'products-api: mail-outbox (the same event, via the retry queue)'],
    data: ['ref', 'items (name, slug, qty, price, mg)', 'subtotal_server', 'discount_server', 'discount_source', 'total_due_server', 'coupon', 'payment_method', 'needs_review'],
    note: 'Test card payments are not sent. Fields other than ref, items and needs_review are left out when empty.'
  },
  {
    name: 'order_status_changed',
    when: 'A manager changes the status of an order in the CRM.',
    senders: ['products-api: PATCH /orders', 'products-api: mail-outbox (the same event, via the retry queue)'],
    data: ['ref', 'status'],
    statuses: ['new', 'pending', 'paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit (added by the order letters stage)', 'delivered', 'cancelled'],
    note: 'One event name for every status: a journey that wants only "delivered" has to filter on status inside Customer.io. Test orders are not sent.'
  },
  {
    name: 'order_delivered',
    when: 'A manager changes the status of an order to delivered in the CRM (sent next to order_status_changed).',
    senders: ['products-api: PATCH /orders', 'products-api: mail-outbox (via the retry queue)'],
    data: ['ref', 'order_number', 'status'],
    note: 'Added 2026-09-30 (services/cio-events) for the post-delivery journeys. order_number is the order ref. Test orders are not sent.'
  },
  {
    name: 'user_inactive',
    when: 'Once a day: a buyer whose last paid order is 90 or more days old (once per last order).',
    senders: ['cio-winback: daily job /opt/cio-winback/winback.cjs (cron 10:20 UTC)'],
    data: ['last_order_ref', 'days_since_last_order'],
    note: 'Added 2026-09-30 (services/cio-events). WINBACK_MODE in /opt/crm-api/.env: off, dry (counts only) or on. Test orders and test domains are skipped.'
  }
];

// Transactional messages by name (ids differ between accounts, names are what the code and the contract use).
const TRANSACTIONAL_SENDERS = {
  'order-customer': { role: 'Order letter to the customer', senders: ['products-api: order received (mail_customer)'] },
  'order-manager': { role: 'Order letter to the team', senders: ['products-api: order received (mail_manager)'] },
  'order-paid': { role: 'Status letter: paid', senders: ['products-api: status becomes paid / payment-confirmed (order letters stage)'] },
  'order-shipped': { role: 'Status letter: shipped', senders: ['products-api: status becomes shipped (order letters stage)'] },
  'order-in-transit': { role: 'Status letter: in transit', senders: ['products-api: status becomes in-transit (order letters stage)'] },
  'order-delivered': { role: 'Status letter: delivered', senders: ['products-api: status becomes delivered (order letters stage)'] }
};

/* ── configuration and transport ──────────────────────────────────────────────────────────── */

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 300 * 1000;
const PARTIAL_TTL_MS = 30 * 1000;      // an answer with a missing piece is kept only briefly, so recovery shows soon
const OVERALL_DEADLINE_MS = 25 * 1000; // one page load, one budget: a provider gone quiet must not cost a timeout per piece
const MAX_JOURNEYS = 40;
const MIN_FRESH_GAP_MS = 30 * 1000;   // ?fresh=1 inside this window of the last read answers from the cache
const MAX_SEGMENTS = 30;
const FANOUT_PARALLEL = 6;
const OUTGOING_PER_SEC = 5;
const OUTGOING_BURST = 2;
const ID_RE = /^[0-9]{1,12}$/;         // Customer.io ids are numbers; this also keeps the paths and links ours

class Upstream extends Error {
  constructor(message, status) { super(message); this.name = 'Upstream'; this.upstreamStatus = status || 0; }
}

// The same rule the neighbours use: https anywhere, plain http only to this machine (.env is edited by other agents too).
function parseBase(raw, fallback) {
  try {
    const u = new URL(String(raw || fallback).trim().replace(/\/+$/, ''));
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u;
  } catch (e) { /* reported by the caller */ }
  return null;
}

let tokens = OUTGOING_BURST;
let tokensAt = Date.now();
function takeToken() {
  return new Promise(resolve => {
    const tick = () => {
      const now = Date.now();
      tokens = Math.min(OUTGOING_BURST, tokens + (now - tokensAt) * OUTGOING_PER_SEC / 1000);
      tokensAt = now;
      if (tokens >= 1) { tokens -= 1; return resolve(); }
      const t = setTimeout(tick, Math.max(20, Math.ceil((1 - tokens) * 1000 / OUTGOING_PER_SEC)));
      if (t.unref) t.unref();
    };
    tick();
  });
}

// One GET. Resolves { status, data } for any HTTP answer that could be read; throws Upstream otherwise.
async function httpGet(base, key, subPath) {
  await takeToken();
  const opts = {
    protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
    path: base.pathname.replace(/\/+$/, '') + subPath,
    method: 'GET', headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }, timeout: REQUEST_TIMEOUT_MS
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
          let data = null;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
          done(resolve, { status: resp.statusCode || 0, data });
        });
        resp.on('error', e => done(reject, new Upstream('Customer.io connection broke (' + ((e && e.message) || 'error') + ')')));
      });
    } catch (e) {
      return done(reject, new Upstream('Customer.io could not be reached (' + ((e && e.message) || 'error') + ')'));
    }
    req.on('timeout', () => req.destroy(new Error('timed out after ' + REQUEST_TIMEOUT_MS + ' ms')));
    req.on('error', e => done(reject, new Upstream('Customer.io could not be reached (' + ((e && e.message) || 'error') + ')')));
    req.end();
  });
}

// The honest reason Customer.io gave no data. Only the essential call turns this into the page banner.
function failureText(r) {
  if (r.status === 401 || r.status === 403) return 'Customer.io rejected the API key (HTTP ' + r.status + ')';
  if (r.status === 429) return 'Customer.io is rate limiting us (HTTP 429), try again in a minute';
  if (r.status >= 500) return 'Customer.io is not answering (HTTP ' + r.status + ')';
  return 'Customer.io refused the request (HTTP ' + r.status + ')';
}

/* ── shaping ──────────────────────────────────────────────────────────────────────────────── */

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
}
function asArray(v, ...keys) {
  if (Array.isArray(v)) return v;
  for (const k of keys) if (v && Array.isArray(v[k])) return v[k];
  return null;
}
function cidOf(v) { const s = String(v === undefined || v === null ? '' : v); return ID_RE.test(s) ? s : ''; }
function numIds(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) { const s = cidOf(x); if (s && out.indexOf(s) === -1 && out.length < 20) out.push(s); }
  return out;
}

// Same aliases as the Marketing panel, so both pages show the same number for the same journey: "opened" prefers the
// counters of a person over those of a mail scanner, and a counter found nowhere stays null.
const METRIC_ALIASES = {
  sent: ['sent', 'sends', 'created', 'attempted'],
  delivered: ['delivered', 'deliveries'],
  opened: ['human_opened', 'opened', 'opens', 'unique_opens'],
  bounced: ['bounced', 'bounces']
};
function findSeries(json) {
  if (!json || typeof json !== 'object') return null;
  for (const c of [json.metric && json.metric.series, json.metrics && json.metrics.series, json.series, json.metric, json.metrics, json]) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    for (const k of Object.keys(c)) if (Array.isArray(c[k]) || typeof c[k] === 'number') return c;
  }
  return null;
}
function sumOne(series, names) {
  for (const n of names) {
    const v = series[n];
    if (Array.isArray(v)) {
      let total = 0, seen = false;
      for (const x of v) { const y = Number(x); if (x !== null && x !== '' && Number.isFinite(y)) { total += y; seen = true; } }
      if (seen) return total;
    } else if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}
function metricsFrom(json) {
  const series = findSeries(json);
  if (!series) return null;
  const out = {};
  let any = false;
  for (const k of Object.keys(METRIC_ALIASES)) { out[k] = sumOne(series, METRIC_ALIASES[k]); if (out[k] !== null) any = true; }
  return any ? out : null;
}

function journeyUrl(workspaceId, id) {
  return 'https://fly.customer.io/workspaces/' + encodeURIComponent(workspaceId) + '/journeys/automations/' + encodeURIComponent(id) + '/setup/workflow/actions';
}

function isRunning(state, active) { return state === 'running' || (!state && active === true); }

/**
 * The whole answer from what was read. Pure: no requests, no clock.
 *   raw = { campaigns: [list items], actions: {id: [action]|null}, metrics: {id: json|null},
 *           segmentNames: {id: name|null}, transactional: [..]|null }
 * null under actions / metrics / transactional means "could not be read" (shown as such, never as zero or empty).
 */
function build(raw, workspaceId) {
  const campaigns = raw.campaigns || [];
  const journeys = campaigns.slice(0, MAX_JOURNEYS).map(c => {
    const id = cidOf(c && c.id);
    const eventName = str(c && c.event_name, 120);
    const segIds = numIds(c && c.trigger_segment_ids);
    const filterIds = numIds(c && c.filter_segment_ids);
    const state = str(c && c.state, 40) || ((c && c.active === true) ? 'running' : '');
    const segName = sid => ({ id: sid, name: str(raw.segmentNames && raw.segmentNames[sid], 160) || null });
    const kind = eventName ? 'event' : (segIds.length ? 'segment' : 'other');
    const steps = {};
    if (c && Array.isArray(c.actions)) for (const a of c.actions) { const t = str(a && a.type, 30) || 'unknown'; steps[t] = (steps[t] || 0) + 1; }
    const acts = id && raw.actions ? raw.actions[id] : null;
    let letters = null;
    const lettersMore = !!(id && raw.actionsMore && raw.actionsMore[id] === true);
    if (Array.isArray(acts)) {
      letters = acts.filter(a => a && typeof a === 'object' && (!a.type || a.type === 'email')).map(a => ({
        id: cidOf(a.id),
        name: str(a.name, 160),
        subject: str(a.subject, 300),
        sending_state: str(a.sending_state, 40)
      }));
    }
    return {
      id,
      name: str(c && c.name, 160) || '(no name)',
      state,
      running: isRunning(state, c && c.active),
      trigger: {
        kind,
        type: str(c && (c.event_type || c.type), 40),
        event_name: eventName,
        segments: segIds.map(segName),
        filter_segments: filterIds.map(segName),
        // null when the trigger is not an event: "does the shop send it" is not a question about a segment
        shop_sends: kind === 'event' ? SHOP_EVENTS.some(e => e.name === eventName) : null
      },
      steps,
      letters,
      letters_more: lettersMore,   // Customer.io says there is another page of steps: this list is not the whole journey
      metrics30d: id && raw.metrics && raw.metrics[id] ? metricsFrom(raw.metrics[id]) : null,
      edit_url: id ? journeyUrl(workspaceId, id) : null,
      updated: typeof (c && c.updated) === 'number' ? new Date(c.updated * 1000).toISOString() : null
    };
  });

  const events = SHOP_EVENTS.map(e => {
    const listeners = journeys.filter(j => j.trigger.kind === 'event' && j.trigger.event_name === e.name)
      .map(j => ({ id: j.id, name: j.name, state: j.state, running: j.running }));
    let status = 'no_listener';
    if (listeners.length) status = listeners.some(l => l.running) ? 'listened' : 'listeners_not_running';
    return Object.assign({}, e, { senders: e.senders.slice(), data: e.data.slice(), listeners, status });
  });

  const dead = journeys.filter(j => j.trigger.shop_sends === false).map(j => ({ id: j.id, name: j.name, event_name: j.trigger.event_name }));
  const silent = events.filter(e => e.status === 'no_listener').map(e => e.name);

  const transactional = raw.transactional === null || raw.transactional === undefined ? null : raw.transactional.map(t => {
    const name = str(t && t.name, 160);
    const known = Object.prototype.hasOwnProperty.call(TRANSACTIONAL_SENDERS, name) ? TRANSACTIONAL_SENDERS[name] : null;
    return {
      id: cidOf(t && t.id),
      name,
      role: known ? known.role : '',
      senders: known ? known.senders.slice() : [],
      sent_by_shop: !!known
    };
  });

  return {
    journeys, events, summary: { dead_journeys: dead, silent_events: silent }, transactional,
    journeys_shown: journeys.length,
    journeys_total: Number.isFinite(raw.total) ? raw.total : campaigns.length   // more than MAX_JOURNEYS are not read
  };
}

/* ── the loader with its cache ────────────────────────────────────────────────────────────── */

function createCore(deps) {
  deps = deps || {};
  const now = deps.now || Date.now;
  const workspaceId = String(deps.workspaceId || process.env.CIO_WORKSPACE_ID || '231885').trim().replace(/[^0-9A-Za-z_-]/g, '');
  let get = deps.get;
  let configProblem = '';
  if (!get) {
    const key = String(process.env.CIO_APP_API_KEY || '').trim();
    const region = String(process.env.CIO_REGION || 'us').trim().toLowerCase();
    const base = parseBase(process.env.CIO_API_BASE, region === 'eu' ? 'https://api-eu.customer.io' : 'https://api.customer.io');
    if (!key) configProblem = 'Customer.io is not configured (CIO_APP_API_KEY is missing in /opt/crm-api/.env)';
    else if (!base) configProblem = 'CIO_API_BASE / CIO_REGION is not a usable address, see the blitz-api log';
    else get = subPath => httpGet(base, key, subPath);
    if (configProblem) console.error('[marketing-journeys] ' + configProblem);
  }

  let cache = null;      // { at, ttl, data }
  let inflight = null;

  const staticPart = () => ({ events: build({}, workspaceId).events.map(e => Object.assign({}, e, { status: null })) });

  async function readAll() {
    const deadline = now() + OVERALL_DEADLINE_MS;
    let partial = false;
    // A piece that cannot be read is a gap on the page, not a dead page. The deadline stops a quiet provider from
    // costing a timeout per piece.
    const soft = async subPath => {
      if (now() > deadline) { partial = true; return null; }
      try {
        const r = await get(subPath);
        if (r && r.status >= 200 && r.status < 300 && r.data) return r.data;
      } catch (e) { /* a gap */ }
      partial = true;
      return null;
    };
    async function fanOut(items, worker) {
      const out = new Array(items.length);
      let next = 0;
      const runners = [];
      for (let i = 0; i < Math.min(FANOUT_PARALLEL, items.length); i++) {
        runners.push((async () => { while (true) { const i2 = next++; if (i2 >= items.length) return; out[i2] = await worker(items[i2]); } })());
      }
      await Promise.all(runners);
      return out;
    }

    // The journey list is the one call the page cannot do without.
    let list;
    try {
      const r = await get('/v1/campaigns');
      if (!r || r.status < 200 || r.status >= 300) return { fail: failureText(r || { status: 0 }) };
      list = asArray(r.data, 'campaigns', 'data');
      if (!list) return { fail: 'Customer.io answered the journey list in a shape this page does not understand' };
    } catch (e) {
      return { fail: (e && e.message) || 'Customer.io could not be reached' };
    }
    const wanted = list.slice(0, MAX_JOURNEYS);

    const per = await fanOut(wanted, async c => {
      const id = cidOf(c && c.id);
      if (!id) return { actions: null, more: false, metrics: null };
      const [a, m] = await Promise.all([
        soft('/v1/campaigns/' + id + '/actions'),
        soft('/v1/campaigns/' + id + '/metrics?period=days&steps=30&type=email')
      ]);
      return { actions: a ? asArray(a, 'actions', 'data') : null, more: !!(a && a.next), metrics: m };
    });
    const actions = {}, metrics = {}, actionsMore = {};
    wanted.forEach((c, i) => { const id = cidOf(c && c.id); if (id) { actions[id] = per[i].actions; metrics[id] = per[i].metrics; actionsMore[id] = per[i].more; } });

    const segIds = [];
    for (const c of wanted) for (const s of numIds(c && c.trigger_segment_ids).concat(numIds(c && c.filter_segment_ids))) if (segIds.indexOf(s) === -1) segIds.push(s);
    const segNames = {};
    await fanOut(segIds.slice(0, MAX_SEGMENTS), async sid => {
      const d = await soft('/v1/segments/' + sid);
      segNames[sid] = d && d.segment ? str(d.segment.name, 160) : null;
    });

    const trAnswer = await soft('/v1/transactional');
    const transactional = trAnswer ? asArray(trAnswer, 'messages', 'transactional_messages', 'data') : null;

    return { campaigns: wanted, total: list.length, actions, actionsMore, metrics, segmentNames: segNames, transactional, partial };
  }

  async function load(fresh) {
    if (configProblem) return Object.assign({ ok: true, fetched_at: new Date(now()).toISOString(), cio: { ok: false, error: configProblem }, journeys: null, summary: null, transactional: null }, staticPart());
    if (!fresh && cache && now() - cache.at < cache.ttl) return cache.data;
    if (fresh && cache && now() - cache.at < MIN_FRESH_GAP_MS) {
      return Object.assign({}, cache.data, { throttled: true, refresh_in_s: Math.ceil((MIN_FRESH_GAP_MS - (now() - cache.at)) / 1000) });
    }
    if (inflight) return inflight;
    inflight = (async () => {
      const raw = await readAll();
      if (raw.fail) {
        // Not cached: caching a failure would keep the page broken after Customer.io is back.
        return Object.assign({ ok: true, fetched_at: new Date(now()).toISOString(), cio: { ok: false, error: raw.fail }, journeys: null, summary: null, transactional: null }, staticPart());
      }
      const built = build(raw, workspaceId);
      const data = {
        ok: true,
        fetched_at: new Date(now()).toISOString(),
        cio: { ok: true, partial: raw.partial === true },
        events: built.events,
        journeys: built.journeys,
        summary: built.summary,
        transactional: built.transactional,
        journeys_shown: built.journeys_shown,
        journeys_total: built.journeys_total
      };
      cache = { at: now(), ttl: raw.partial ? PARTIAL_TTL_MS : CACHE_TTL_MS, data };
      return data;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  return { load, build: (raw) => build(raw, workspaceId) };
}

module.exports = function createMarketingJourneys(deps) {
  deps = deps || {};
  const express = deps.express || require('express');
  const core = createCore(deps);
  const router = express.Router();
  // GET only, on purpose: nothing here writes anything.
  router.get('/', async (req, res) => {
    try {
      res.json(await core.load(req.query && req.query.fresh === '1'));
    } catch (e) {
      console.error('[marketing-journeys] GET / failed: ' + ((e && e.message) || 'error'));
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  return router;
};
module.exports.createCore = createCore;
module.exports.build = build;
module.exports.metricsFrom = metricsFrom;
module.exports.SHOP_EVENTS = SHOP_EVENTS;
module.exports.TRANSACTIONAL_SENDERS = TRANSACTIONAL_SENDERS;
module.exports.Upstream = Upstream;
