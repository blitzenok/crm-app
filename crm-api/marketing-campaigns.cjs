/**
 * BioLabs Research CRM — Campaigns (2026-10-02): what was sent and how it did, on one page. View only.
 *
 * Mounted by server_v14.cjs behind the session gate, next to the other marketing modules:
 *     app.use('/api/marketing/campaigns', requireAuth, require('./marketing-campaigns.cjs')({ DATA_DIR }));
 * One route, GET /. Role is not checked (EQUAL_RIGHTS), the same as the Journeys and Emails pages.
 *
 * Three sources, read independently, so one that is down is a gap on the page and not a dead page:
 *   - newsletters: the CRM's own record, data/marketing-newsletters.json (subject, segment, state, estimate of addresses),
 *     read from disk on every request, and the broadcasts of Customer.io with their 30-day numbers;
 *   - journeys: the campaigns of Customer.io with their 30-day numbers;
 *   - service letters: the transactional messages of Customer.io with their 30-day numbers.
 *
 * What it does NOT do, on purpose:
 *   - it sends nothing and changes nothing in Customer.io: the only HTTP method in this file is GET (a test reads the
 *     source and a local stand records every request). Track API and "Send event" are not used at all;
 *   - it writes nothing to disk: the newsletter file is only read, and an unreadable file is a gap, never "no issues";
 *   - it shares no code with marketing-journeys.cjs / marketing-routes.cjs / marketing-newsletter.cjs: those files are
 *     edited by other work, and a copy of a 60-line transport is cheaper than a change in one breaking the other.
 *
 * Rules kept (same as the neighbours):
 *   - the App API key never reaches the client or a log line;
 *   - a Customer.io failure is answered 200 with the reason per source: the shared api() of the pages replaces the body of
 *     a 503 with its own generic text;
 *   - a metric that could not be read is null, not 0 (a zero would read as "nobody opened it");
 *   - strings from Customer.io and from the newsletter file are cut and stripped of control characters here; the page
 *     escapes them on output;
 *   - one page load costs one list call per source plus one metrics call per item, one after another (a token bucket
 *     keeps it under 3 a second); the Customer.io part is cached 5 min (30 s when a piece failed for a reason that may pass: network, 5xx, 429, the deadline). ?fresh=1 (the Refresh
 *     button) reads past the cache, but not when the cache is younger than 30 s: it then answers the cached data marked
 *     throttled with refresh_in_s. The same key sends the order letters of products-api, so a Refresh held down must not
 *     turn into a read per click.
 *
 * Config (/opt/crm-api/.env, read into process.env at startup by server_v14.cjs): CIO_APP_API_KEY, CIO_REGION, CIO_API_BASE
 * (also the seam a local stand points at its stub), CIO_WORKSPACE_ID (only for "Open in Customer.io"),
 * CIO_NEWSLETTER_BROADCAST_ID (only to mark which broadcast is the CRM newsletter).
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const NEWSLETTER_FILE = 'marketing-newsletters.json';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 300 * 1000;
const PARTIAL_TTL_MS = 30 * 1000;      // an answer with a temporary failure in it is kept only briefly, so recovery shows soon
const OVERALL_DEADLINE_MS = 30 * 1000; // one page load, one budget: a provider gone quiet must not cost a timeout per piece
const MIN_FRESH_GAP_MS = 30 * 1000;    // ?fresh=1 inside this window of the last read answers from the cache
const MAX_JOURNEYS = 40;
const MAX_BROADCASTS = 10;
const MAX_TRANSACTIONAL = 30;
const MAX_ISSUES = 50;                 // newest issues shown; the file keeps 200
const OUTGOING_PER_SEC = 3;
const OUTGOING_BURST = 2;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // keeps the paths and links ours

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

// One read. Resolves { status, data } for any HTTP answer that could be read; throws Upstream otherwise.
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

// The honest reason Customer.io gave no data.
function failureText(r) {
  if (r.status === 401 || r.status === 403) return 'Customer.io rejected the API key (HTTP ' + r.status + ')';
  if (r.status === 429) return 'Customer.io is rate limiting us (HTTP 429), try again in a minute';
  if (r.status >= 500) return 'Customer.io is not answering (HTTP ' + r.status + ')';
  if (!r.status) return 'Customer.io could not be reached';
  return 'Customer.io refused the request (HTTP ' + r.status + ')';
}

/* ── shaping ──────────────────────────────────────────────────────────────────────────────── */

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
}
function asArray(v, ...keys) {
  if (Array.isArray(v)) return v;
  for (const k of keys.concat(['data', 'items', 'results'])) if (v && Array.isArray(v[k])) return v[k];
  return null;
}
function idOf(v) { const s = String(v === undefined || v === null ? '' : v); return ID_RE.test(s) ? s : ''; }
function numIds(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) { const s = String(x === undefined || x === null ? '' : x); if (/^[0-9]{1,12}$/.test(s) && out.indexOf(s) === -1 && out.length < 20) out.push(s); }
  return out;
}
function isoOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v > 1e12 ? v : v * 1000);   // Customer.io gives Unix seconds
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// Same aliases as the Marketing panel, so both pages show the same number for the same journey: "opened" and "clicked"
// prefer the counters of a person over those of a mail scanner, and a counter found nowhere stays null.
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

// The deep links are built from the workspace id, the API hands out none. Both shapes were copied from the live
// interface (marketing-routes.cjs, 2026-09-09); a service letter has no link here because no address of its page was
// ever seen working, and a guessed one answered "Page not found" before.
function journeyUrl(ws, id) {
  return 'https://fly.customer.io/workspaces/' + encodeURIComponent(ws) + '/journeys/automations/' + encodeURIComponent(id) + '/setup/workflow/actions';
}
function broadcastUrl(ws, id) {
  return 'https://fly.customer.io/workspaces/' + encodeURIComponent(ws) + '/journeys/broadcasts/broadcast/' + encodeURIComponent(id) + '/overview';
}

function shapeJourney(item, ws) {
  const c = item.raw || {};
  const eventName = str(c.event_name, 120);
  const segIds = numIds(c.trigger_segment_ids);
  const state = str(c.state, 40) || (c.active === true ? 'running' : '');
  return {
    id: item.id,
    name: str(c.name, 160) || '(no name)',
    state,
    running: state === 'running',
    trigger: { kind: eventName ? 'event' : (segIds.length ? 'segment' : 'other'), event_name: eventName, segment_ids: segIds, type: str(c.event_type || c.type, 40) },
    updated: isoOf(c.updated),
    edit_url: item.id ? journeyUrl(ws, item.id) : null,
    metrics30d: item.metrics
  };
}
function shapeBroadcast(item, ws, crmBroadcastId) {
  const b = item.raw || {};
  return {
    id: item.id,
    name: str(b.name, 160) || '(no name)',
    state: str(b.state, 40),
    is_crm_newsletter: !!(item.id && crmBroadcastId && item.id === crmBroadcastId),
    updated: isoOf(b.updated),
    edit_url: item.id ? broadcastUrl(ws, item.id) : null,
    metrics30d: item.metrics
  };
}
function shapeTransactional(item) {
  const t = item.raw || {};
  return { id: item.id, name: str(t.name, 160) || '(no name)', metrics30d: item.metrics };
}

// One issue of the CRM newsletter, as the CRM recorded it. Never the body: 200 issues of up to 300 KB are not a list.
function shapeIssue(r) {
  if (!r || typeof r !== 'object') return null;
  const a = r.audience && typeof r.audience === 'object' ? r.audience : {};
  const state = r.state === 'sent' ? 'sent' : (r.state === 'sending' ? 'sending' : 'draft');
  return {
    id: str(r.id, 64),
    subject: str(r.subject, 300) || '(no subject)',
    state,
    audience: a.type === 'segment' ? (str(a.segment_name, 160) || 'a segment') : 'the whole broadcast audience',
    recipients_estimate: typeof r.recipients_estimate === 'number' && Number.isFinite(r.recipients_estimate) ? r.recipients_estimate : null,
    sent_at: typeof r.sent_at === 'string' ? str(r.sent_at, 40) : null,
    created_at: typeof r.created_at === 'string' ? str(r.created_at, 40) : null,
    sent_by: typeof r.sent_by === 'string' ? str(r.sent_by, 160) : null,
    // sending + an error note = the provider did not confirm; nobody knows whether the letter went out
    unconfirmed: state === 'sending' && !!(r.last_error && typeof r.last_error === 'object')
  };
}

// The newsletter record, read only. A file that does not exist is a new installation (no issues); one that cannot be
// read is a gap with its reason: showing "no issues" for a damaged record would hide that letters were sent.
function readNewsletters(dir) {
  const file = path.join(String(dir || ''), NEWSLETTER_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, issues: [], total: 0 };
    return { ok: false, error: NEWSLETTER_FILE + ' cannot be read (' + ((e && e.code) || 'error') + ')' };
  }
  let list;
  try { list = JSON.parse(raw); } catch (e) { return { ok: false, error: NEWSLETTER_FILE + ' is not readable JSON' }; }
  if (!Array.isArray(list)) return { ok: false, error: NEWSLETTER_FILE + ' is not a list' };
  const issues = list.map(shapeIssue).filter(Boolean);
  const stamp = i => i.sent_at || i.created_at || '';
  issues.sort((a, b) => stamp(b).localeCompare(stamp(a)));
  return { ok: true, issues: issues.slice(0, MAX_ISSUES), total: issues.length };
}

/* ── the loader with its cache ────────────────────────────────────────────────────────────── */

function createCore(deps) {
  deps = deps || {};
  const now = deps.now || Date.now;
  const dataDir = deps.DATA_DIR || deps.dataDir || '';
  const workspaceId = String(deps.workspaceId || process.env.CIO_WORKSPACE_ID || '231885').trim().replace(/[^0-9A-Za-z_-]/g, '');
  const crmBroadcastId = String(deps.broadcastId !== undefined ? deps.broadcastId : (process.env.CIO_NEWSLETTER_BROADCAST_ID || '')).trim();
  let get = deps.get;
  let configProblem = '';
  if (!get) {
    const key = String(process.env.CIO_APP_API_KEY || '').trim();
    const region = String(process.env.CIO_REGION || 'us').trim().toLowerCase();
    const base = parseBase(process.env.CIO_API_BASE, region === 'eu' ? 'https://api-eu.customer.io' : 'https://api.customer.io');
    if (!key) configProblem = 'Customer.io is not configured (CIO_APP_API_KEY is missing in /opt/crm-api/.env)';
    else if (!base) configProblem = 'CIO_API_BASE / CIO_REGION is not a usable address, see the blitz-api log';
    else get = subPath => httpGet(base, key, subPath);
    if (configProblem) console.error('[marketing-campaigns] ' + configProblem);
  }

  let cache = null;      // { at, ttl, data }: the Customer.io part only
  let inflight = null;

  const failedPart = reason => ({
    fetched_at: new Date(now()).toISOString(),
    partial: false,
    sources: { journeys: { ok: false, error: reason }, broadcasts: { ok: false, error: reason }, transactional: { ok: false, error: reason } },
    journeys: null, journeys_total: 0, broadcasts: null, broadcasts_total: 0, transactional: null, transactional_total: 0
  });

  async function readCio() {
    const deadline = now() + OVERALL_DEADLINE_MS;
    let retry = false;   // something failed for a reason that may pass: only then is the answer short-lived ("partial")
    let halted = '';     // a key that is refused or a limit that is hit ends the reading: more calls would only repeat it
    // -> { data } or { error, temporary }. Temporary: network, timeout, 5xx, 429, a refused key, the deadline. Everything
    // else (a 404, a 2xx that carries no numbers) is a standing property of that object and does not shorten the cache.
    const call = async subPath => {
      if (halted) return { error: halted, temporary: true };
      if (now() > deadline) return { error: 'Customer.io did not answer in time', temporary: true };
      let r;
      try { r = await get(subPath); } catch (e) { return { error: (e && e.message) || 'Customer.io could not be reached', temporary: true }; }
      if (!r || r.status < 200 || r.status >= 300) {
        const text = failureText(r || { status: 0 });
        const st = r ? r.status : 0;
        if (st === 401 || st === 403 || st === 429) halted = text;
        return { error: text, temporary: !st || st >= 500 || st === 429 || st === 401 || st === 403 };
      }
      if (!r.data) return { error: 'Customer.io sent an answer this page cannot read', temporary: false };
      return { data: r.data };
    };
    // The CRM newsletter broadcast goes first, so that the cap can never cut it off.
    const pinFirst = (list, id) => id ? list.filter(x => idOf(x && x.id) === id).concat(list.filter(x => idOf(x && x.id) !== id)) : list;
    const readSource = async (listPath, keys, cap, metricsPath, pinId) => {
      const r = await call(listPath);
      if (r.error) { if (r.temporary) retry = true; return { ok: false, error: r.error }; }
      const list = asArray(r.data, ...keys);
      if (!list) return { ok: false, error: 'Customer.io answered the list in a shape this page does not understand' };
      const items = [];
      for (const raw of pinFirst(list, pinId).slice(0, cap)) {
        const id = idOf(raw && raw.id);
        let metrics = null;
        if (id) {
          const m = await call(metricsPath(id));
          if (m.error) { if (m.temporary) retry = true; } else metrics = metricsFrom(m.data);
        }
        items.push({ raw, id, metrics });
      }
      return { ok: true, items, total: list.length };
    };

    // Sequential on purpose. Metrics paths are the ones the Marketing panel already uses against the live account.
    const j = await readSource('/v1/campaigns', ['campaigns'], MAX_JOURNEYS, id => '/v1/campaigns/' + encodeURIComponent(id) + '/metrics?period=days&steps=30&type=email');
    const b = await readSource('/v1/broadcasts', ['broadcasts', 'newsletters'], MAX_BROADCASTS, id => '/v1/broadcasts/' + encodeURIComponent(id) + '/metrics?period=days&steps=30&type=email', crmBroadcastId);
    const t = await readSource('/v1/transactional', ['transactional_messages', 'messages', 'transactional'], MAX_TRANSACTIONAL, id => '/v1/transactional/' + encodeURIComponent(id) + '/metrics?period=days&steps=30');

    const src = s => s.ok ? { ok: true } : { ok: false, error: s.error };
    return {
      fetched_at: new Date(now()).toISOString(),
      partial: retry,
      sources: { journeys: src(j), broadcasts: src(b), transactional: src(t) },
      journeys: j.ok ? j.items.map(i => shapeJourney(i, workspaceId)) : null, journeys_total: j.ok ? j.total : 0,
      broadcasts: b.ok ? b.items.map(i => shapeBroadcast(i, workspaceId, crmBroadcastId)) : null, broadcasts_total: b.ok ? b.total : 0,
      transactional: t.ok ? t.items.map(shapeTransactional) : null, transactional_total: t.ok ? t.total : 0,
      _allFailed: !j.ok && !b.ok && !t.ok
    };
  }

  function assemble(nl, part, extra) {
    const s = part.sources;
    const anyCio = s.journeys.ok || s.broadcasts.ok || s.transactional.ok;
    const out = {
      ok: true,
      fetched_at: part.fetched_at,
      cio: anyCio ? { ok: true, partial: part.partial === true } : { ok: false, error: s.journeys.error || 'Customer.io could not be read' },
      sources: Object.assign({ newsletters: nl.ok ? { ok: true } : { ok: false, error: nl.error } }, s),
      issues: nl.ok ? nl.issues : null, issues_total: nl.ok ? nl.total : 0,
      broadcasts: part.broadcasts, broadcasts_total: part.broadcasts_total,
      journeys: part.journeys, journeys_total: part.journeys_total,
      transactional: part.transactional, transactional_total: part.transactional_total
    };
    return extra ? Object.assign(out, extra) : out;
  }

  async function load(fresh) {
    const nl = readNewsletters(dataDir);    // cheap and local: a newly sent issue shows at once, whatever the cache holds
    if (configProblem) return assemble(nl, failedPart(configProblem));
    if (!fresh && cache && now() - cache.at < cache.ttl) return assemble(nl, cache.data);
    if (fresh && cache && now() - cache.at < MIN_FRESH_GAP_MS) {
      return assemble(nl, cache.data, { throttled: true, refresh_in_s: Math.ceil((MIN_FRESH_GAP_MS - (now() - cache.at)) / 1000) });
    }
    if (!inflight) {
      inflight = (async () => {
        const part = await readCio();
        // Not cached when nothing at all could be read: caching a failure would keep the page broken after Customer.io is back.
        if (!part._allFailed) cache = { at: now(), ttl: part.partial ? PARTIAL_TTL_MS : CACHE_TTL_MS, data: part };
        return part;
      })();
      inflight.then(() => { inflight = null; }, () => { inflight = null; });
    }
    return assemble(nl, await inflight);
  }

  return { load };
}

module.exports = function createMarketingCampaigns(deps) {
  deps = deps || {};
  const express = deps.express || require('express');
  const core = createCore(deps);
  const router = express.Router();
  // Reads only, on purpose: nothing here changes anything.
  router.get('/', async (req, res) => {
    try {
      res.json(await core.load(req.query && req.query.fresh === '1'));
    } catch (e) {
      console.error('[marketing-campaigns] GET / failed: ' + ((e && e.message) || 'error'));
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  return router;
};
module.exports.createCore = createCore;
module.exports.metricsFrom = metricsFrom;
module.exports.readNewsletters = readNewsletters;
module.exports.shapeIssue = shapeIssue;
module.exports.Upstream = Upstream;
