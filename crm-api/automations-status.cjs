/**
 * automations-status.cjs (2026-10-01) - one read-only answer to "which of our automations work, which are off, when did
 * each last run, is anything stuck" for the CRM page Automations.
 *
 *   GET /api/automations/status   { ok, generatedAt, cache, modes, since, jobs, tgDaily, stock, opsWatch, mailCheck,
 *                                   cardImport, queue, letters, alerts, restock, winback, errors }
 *
 * Mounted in server_v14.cjs behind requireAuth (staff only). It only reads; nothing is written or sent, and Customer.io
 * is not called (the journeys card reads what mail-chain-check already found). Every source is read in its own try: a
 * missing or broken file leaves that part null and puts a short code in `errors`, the rest of the answer stays.
 *
 * What may leave the server is decided here, not by the page:
 *   - .env: only the keys of ENV_KEYS below. Everything else in the file is never copied anywhere, not even parsed into
 *     a variable that could be logged. A value outside what the module accepts reads "unknown".
 *   - queue and dead list: counts and dates per kind. No order ref, address or error text.
 *   - orders.json / restock list / status files: dates and counts only.
 * Plain (req, res, next) handler, no express dependency, so it is testable with node:http. Source and install order:
 * biofirst-hosting services/automations-status/ (deploy/INSTALL.md).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_MS = 60 * 1000;
const FRESH_GAP_MS = 10 * 1000;          // ?fresh=1 reads past the cache, but not more often than this
const TAIL_BYTES = 8192;

// key -> the values the module that reads it accepts (anything else is shown as "unknown": that module treats it as off).
// Checked against the modules' own parsers on 2026-10-01; REVIEWS_MODE is the contract of services/reviews (off|test|on).
const OFF_TEST_ON = ['off', 'test', 'on'];
const OFF_ON = ['off', 'on'];
const OFF_DRY_ON = ['off', 'dry', 'on'];
const MODE_KEYS = {
  ORDER_LETTERS_MODE: OFF_TEST_ON,
  RESTOCK_MODE: OFF_TEST_ON,
  REVIEWS_MODE: OFF_TEST_ON,
  TG_ALERTS_MODE: OFF_ON,
  TG_DAILY_MODE: OFF_ON,
  TG_STOCK_MODE: OFF_ON,
  MAIL_OUTBOX_MODE: OFF_ON,
  CARD_IMPORT_MODE: OFF_DRY_ON,
  CRYPTO_IMPORT_MODE: OFF_DRY_ON,
  WINBACK_MODE: OFF_DRY_ON
};
const SINCE_KEYS = ['ORDER_LETTERS_SINCE', 'TG_ALERTS_SINCE', 'CRYPTO_IMPORT_SINCE', 'CARD_IMPORT_EVENTS_SINCE', 'REVIEWS_RATING_SINCE'];
const ENV_KEYS = new Set(Object.keys(MODE_KEYS).concat(SINCE_KEYS));

const LETTER_TYPES = ['confirmation', 'paid', 'shipped', 'in_transit', 'delivered', 'rating'];
const ALERT_TYPES = ['order', 'paid'];

function iso(ms) { return new Date(ms).toISOString(); }
// A date string from a file, normalized; anything that does not parse is null, never passed on as it was.
function toIso(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? iso(t) : null;
}
function later(a, b) { return !a || (b && b > a) ? b : a; }   // both are ISO strings: they compare as text
function int(v) { return Number.isInteger(v) && v >= 0 ? v : 0; }
function slug(v) { return typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v) ? v : null; }

// A file that is not there is `null` (the caller decides if that is an error); anything else that goes wrong throws.
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}
function readJson(file) {
  const t = readText(file);
  return t === null ? null : JSON.parse(t);
}
function mtimeIso(file) {
  try { return iso(fs.statSync(file).mtimeMs); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}
function tail(file, bytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/* ── .env: the white list ─────────────────────────────────────────────────────────────────────── */

// Returns only ENV_KEYS, raw strings. The last line for a key wins (how the modules' own readers behave).
function pickEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !ENV_KEYS.has(m[1])) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
// -> { modes: { KEY: 'off'|'test'|'dry'|'on'|'unknown'|null }, since: { KEY: iso|null } }; null = the key is not in the file
function envView(text) {
  const raw = pickEnv(text), modes = {}, since = {};
  for (const k of Object.keys(MODE_KEYS)) {
    if (raw[k] === undefined || raw[k].trim() === '') { modes[k] = null; continue; }
    const v = raw[k].trim().toLowerCase();
    modes[k] = MODE_KEYS[k].includes(v) ? v : 'unknown';
  }
  for (const k of SINCE_KEYS) since[k] = raw[k] === undefined ? null : toIso(raw[k].trim());
  return { modes, since };
}

/* ── the sources ──────────────────────────────────────────────────────────────────────────────── */

// /var/lib/biolabs-ops/<job>.ok.json = the last successful run, <job>.last.json = the last run of any outcome.
function readJobs(dir) {
  const jobs = {};
  for (const f of fs.readdirSync(dir)) {
    const m = /^([a-z0-9-]+)\.ok\.json$/.exec(f);
    if (!m) continue;
    // One broken .ok.json must not hide the other jobs: it becomes a job with no success date, which the page shows as overdue.
    const job = { finishedAt: null, ok: false, lastOk: null, lastFinishedAt: null };
    try {
      const ok = readJson(path.join(dir, f)) || {};
      job.finishedAt = toIso(ok.finishedAt); job.ok = ok.ok === true;
    } catch (e) { /* stays "never succeeded" */ }
    try {
      const last = readJson(path.join(dir, m[1] + '.last.json'));
      if (last) { job.lastOk = last.ok === true; job.lastFinishedAt = toIso(last.finishedAt); }
    } catch (e) { /* the .ok file alone is still an answer */ }
    jobs[m[1]] = job;
  }
  return jobs;
}

function readTgDaily(dir) {
  const d = readJson(path.join(dir, 'tg-daily.json'));
  if (!d) return null;
  return { sentAt: toIso(d.sentAt), lastDay: typeof d.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.lastDay) ? d.lastDay : null };
}
function readStock(dir) {
  const d = readJson(path.join(dir, 'stock-status.json'));
  return d ? { updatedAt: toIso(d.updatedAt) } : null;
}
// ops-watch keeps no status file of its own: its state file is rewritten on every run (every 5 minutes), so its mtime is
// the heartbeat. `announced` holds the problems it has told Telegram about and not yet closed.
function readOpsWatch(file) {
  const at = mtimeIso(file);
  if (at === null) return null;
  const s = readJson(file) || {};
  const probe = s.cioProbe && typeof s.cioProbe === 'object' ? s.cioProbe : null;
  return {
    lastRunAt: at,
    openProblems: s.announced && typeof s.announced === 'object' ? Object.keys(s.announced).length : 0,
    cioProbeAt: probe && Number.isFinite(probe.at) ? iso(probe.at) : null,
    cioProbeProblems: probe && Array.isArray(probe.problems) ? probe.problems.length : null
  };
}
function readMailCheck(file) {
  const s = readJson(file);
  if (!s) return null;
  return { checkedAt: Number.isFinite(s.checkedAt) ? iso(s.checkedAt) : null, problems: Array.isArray(s.problems) ? s.problems.length : 0 };
}
// card-import-seen.json is written when a payment is carried into the orders, so its mtime = the last import.
function readCardImport(file) { return { lastImportAt: mtimeIso(file) }; }

// Dead list: deadTotal / deadByKind = everything in the list (it keeps the last entries only); dead7d / dead7dByKind = those that
// died in the last 7 days. The page colours only the recent ones: an old failure that was looked at is not today's alarm.
// An entry whose date cannot be read counts as recent (hiding it would be worse than a false alarm).
const DEAD_RECENT_MS = 7 * 24 * 3600 * 1000;
function readQueue(queueFile, deadFile, nowMs) {
  const q = readJson(queueFile), d = readJson(deadFile);
  const queue = Array.isArray(q) ? q : [], dead = Array.isArray(d) ? d : [];
  const out = { waiting: 0, retrying: 0, oldestAt: null, byKind: {}, deadTotal: 0, deadByKind: {}, dead7d: 0, dead7dByKind: {}, lastDeadAt: null };
  for (const it of queue) {
    const kind = it && slug(it.kind);
    if (!kind) continue;
    out.waiting++;
    out.byKind[kind] = (out.byKind[kind] || 0) + 1;
    if (int(it.attempts) > 0) out.retrying++;
    const at = toIso(it.createdAt);
    if (at && (!out.oldestAt || at < out.oldestAt)) out.oldestAt = at;
  }
  for (const it of dead) {
    const kind = it && slug(it.kind);
    if (!kind) continue;
    out.deadTotal++;
    out.deadByKind[kind] = (out.deadByKind[kind] || 0) + 1;
    const at = toIso(it.diedAt);
    out.lastDeadAt = later(out.lastDeadAt, at);
    if (!at || nowMs - Date.parse(at) <= DEAD_RECENT_MS) {
      out.dead7d++;
      out.dead7dByKind[kind] = (out.dead7dByKind[kind] || 0) + 1;
    }
  }
  return out;
}

// Per letter / alert type: how many orders carry a sent mark and when the latest was sent. Nothing else is taken from an order.
function readOrderMarks(file) {
  const raw = readJson(file);
  const orders = Array.isArray(raw) ? raw : raw && Array.isArray(raw.orders) ? raw.orders : [];
  const letters = {}, alerts = {};
  for (const t of LETTER_TYPES) letters[t] = { count: 0, lastSentAt: null };
  for (const t of ALERT_TYPES) alerts[t] = { count: 0, lastSentAt: null };
  const mark = (into, holder, types) => {
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return;
    for (const t of types) {
      const r = holder[t], at = r && typeof r === 'object' ? toIso(r.sentAt) : null;
      if (!at) continue;
      into[t].count++;
      into[t].lastSentAt = later(into[t].lastSentAt, at);
    }
  };
  for (const o of orders) { if (o && typeof o === 'object') { mark(letters, o.letters, LETTER_TYPES); mark(alerts, o.alerts, ALERT_TYPES); } }
  return { letters, alerts };
}

function readRestock(file) {
  const list = readJson(file);
  const out = { pending: 0, sent: 0, lastSentAt: null };
  if (!Array.isArray(list)) return out;
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    if (s.status === 'pending') out.pending++;
    else if (s.status === 'sent') { out.sent++; out.lastSentAt = later(out.lastSentAt, toIso(s.sentAt)); }
  }
  return out;
}

// The win-back cron writes one line a run: "<iso> [winback] mode=dry days=90 eligible=0 (sent=N failed=N)". Numbers only.
function readWinback(file) {
  const t = tail(file, TAIL_BYTES);
  if (t === null) return null;
  const lines = t.split('\n').filter(l => / \[winback\] /.test(l));
  if (!lines.length) return { lastRunAt: null, eligible: null, sent: null, failed: null, error: false };
  const line = lines[lines.length - 1];
  const num = (k) => { const m = new RegExp('\\b' + k + '=(\\d{1,7})\\b').exec(line); return m ? Number(m[1]) : null; };
  const at = toIso(line.split(' ')[0]);
  const failed = num('failed');
  return { lastRunAt: at, eligible: num('eligible'), sent: num('sent'), failed, error: /\[winback\] ERROR\b/.test(line) || (failed !== null && failed > 0) };
}

/* ── collect + handler ────────────────────────────────────────────────────────────────────────── */

function collect(cfg, nowMs) {
  const out = { ok: true, generatedAt: iso(nowMs), modes: {}, since: {}, errors: {} };
  const src = (name, fn) => {
    try { out[name] = fn(); if (out[name] === null) out.errors[name] = 'missing'; }
    catch (e) { out.errors[name] = e && e.code === 'ENOENT' ? 'missing' : 'unreadable'; out[name] = null; }
  };
  try {
    const text = readText(cfg.envFile);
    if (text === null) throw Object.assign(new Error('x'), { code: 'ENOENT' });
    const v = envView(text);
    out.modes = v.modes; out.since = v.since;
  } catch (e) { out.errors.env = e && e.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  src('jobs', () => readJobs(cfg.statusDir));
  src('tgDaily', () => readTgDaily(cfg.statusDir));
  src('stock', () => readStock(cfg.statusDir));
  src('opsWatch', () => readOpsWatch(cfg.opsWatchState));
  src('mailCheck', () => readMailCheck(cfg.mailCheckState));
  src('cardImport', () => readCardImport(cfg.cardImportSeen));
  src('queue', () => readQueue(cfg.outboxFile, cfg.deadFile, nowMs));
  const marks = (() => { try { return readOrderMarks(cfg.ordersFile); } catch (e) { out.errors.orders = e && e.code === 'ENOENT' ? 'missing' : 'unreadable'; return null; } })();
  out.letters = marks ? marks.letters : null;
  out.alerts = marks ? marks.alerts : null;
  src('restock', () => readRestock(cfg.restockFile));
  src('winback', () => readWinback(cfg.winbackLog));
  return out;
}

module.exports = function automationsStatus(opts) {
  const o = opts || {};
  const cfg = {
    envFile: o.envFile || '/opt/crm-api/.env',
    statusDir: o.statusDir || '/var/lib/biolabs-ops',
    opsWatchState: o.opsWatchState || '/opt/ops-watch/state.json',
    mailCheckState: o.mailCheckState || '/opt/mail-chain-check/state.json',
    outboxFile: o.outboxFile || '/var/www/mastersol/html/MSOLPEPTIDES/mail-outbox.json',
    deadFile: o.deadFile || '/var/www/mastersol/html/MSOLPEPTIDES/mail-outbox-dead.json',
    ordersFile: o.ordersFile || '/var/www/mastersol/html/MSOLPEPTIDES/orders.json',
    restockFile: o.restockFile || '/var/www/mastersol/html/MSOLPEPTIDES/restock-subscriptions.json',
    cardImportSeen: o.cardImportSeen || '/var/www/mastersol/html/MSOLPEPTIDES/card-import-seen.json',
    winbackLog: o.winbackLog || '/var/log/cio-winback.log'
  };
  const now = typeof o.now === 'function' ? o.now : Date.now;
  let cache = null;   // { at, data }
  return function automationsStatusHandler(req, res, next) {
    const pathname = String(req.url || '/').split('?')[0];
    if (req.method !== 'GET' || (pathname !== '/' && pathname !== '')) return next();
    const t = now();
    const fresh = /[?&]fresh=1(&|$)/.test(String(req.url || ''));
    const age = cache ? t - cache.at : Infinity;
    if (!cache || age >= CACHE_MS || (fresh && age >= FRESH_GAP_MS)) {
      let data;
      try { data = collect(cfg, t); } catch (e) { data = { ok: false, generatedAt: iso(t), errors: { collect: 'failed' } }; }
      cache = { at: t, data };
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(Object.assign({}, cache.data, { cache: { ageS: Math.round((t - cache.at) / 1000) } })));
  };
};
module.exports.collect = collect;
module.exports.pickEnv = pickEnv;
module.exports.envView = envView;
module.exports.ENV_KEYS = ENV_KEYS;
module.exports.MODE_KEYS = MODE_KEYS;
