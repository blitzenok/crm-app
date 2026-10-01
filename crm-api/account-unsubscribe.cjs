'use strict';

/**
 * BioLabs CRM - "Stop marketing emails" from the customer account reaches the lead list.
 * Mounted from server_v14.cjs (deploy/patch-server.cjs). POST /api/internal/account-unsubscribe { email }.
 *
 * Who calls: only /opt/shop-account (127.0.0.1:4200) and deploy/reconcile.cjs, from this machine. Customer.io is already told
 * by the caller; this route only puts the same fact into data/leads.json, the way the Leads page does it (unsubscribed: true),
 * so the CRM stops showing the person as subscribed: cio-routes.cjs leaves marked leads out of a trigger, and products-api
 * counts "subscribed" for the Insiders segment from the same flag.
 *
 * Three gates, all of them, because nginx on both CRM hosts proxies every /api/ path of the internet to this process from
 * 127.0.0.1: (1) the socket peer is loopback, (2) the request carries no proxy header (nginx always adds X-Forwarded-For
 * and X-Real-IP, so a proxied request is never accepted), (3) the shared secret ACCOUNT_CRM_SYNC_SECRET (>= 32 chars,
 * /opt/crm-api/.env, read by both services). A failing gate is one and the same 403; the loopback and proxy-header gates come first, so a request from the internet gets 403 even when no secret is
 * configured. No secret configured = 503, told only to a caller from this machine.
 *
 * Writing: data/leads.json has more than one writer (this process: leads-store, chat-leads; products-api: insider and checkout
 * leads). The lock is the same file all of them already use (leads.json.lock, O_EXCL), the read is strict (an unreadable or
 * non-array file is a 503, never "no leads" written back over the list) and the write is temp file + rename. Nothing else of
 * a lead changes except the three keys below; an address that is on no lead answers { matched: 0 } - it is not an error and
 * no lead is created for it (an opt-out must not add a person to the Leads page).
 * The answer is idempotent: a lead already marked is matched, not changed, and the file is not rewritten.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROUTE = '/api/internal/account-unsubscribe';
const SECRET_HEADER = 'x-account-sync-secret';
const MIN_SECRET = 32;
const EMAIL_RE = /^[^\s@<>"'\\]{1,64}@[^\s@<>"'\\]{1,190}\.[^\s@<>"'\\]{2,}$/;
const SOURCES = new Set(['account', 'reconcile']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'];

const normEmail = v => {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return e.length <= 254 && EMAIL_RE.test(e) ? e : '';
};

const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

// Compared as digests: equal length for timingSafeEqual whatever the caller sent.
function secretMatches(given, secret) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function mountAccountUnsubscribe({ app, DATA_DIR, env = process.env, writeAuditLog, now = () => new Date() }) {
  if (!app || !DATA_DIR) throw new Error('account-unsubscribe: app and DATA_DIR required');
  const file = path.join(DATA_DIR, 'leads.json');
  const secret = String(env.ACCOUNT_CRM_SYNC_SECRET || '').trim();
  if (secret.length < MIN_SECRET) console.warn('[account-unsubscribe] ACCOUNT_CRM_SYNC_SECRET missing or shorter than ' + MIN_SECRET + ': route answers 503');

  // Same lock protocol as chat-leads.cjs and products-api (leads.json.lock, a stale one is taken over after 8 s).
  function withLock(fn) {
    const lockPath = file + '.lock';
    const started = Date.now();
    let fd = null;
    while (Date.now() - started < 2500) {
      try { fd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(fd, String(process.pid)); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lockPath).mtimeMs > 8000) fs.unlinkSync(lockPath); } catch (e2) { /* race */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      }
    }
    if (fd === null) throw new Error('leads_locked');
    try { return fn(); } finally { try { fs.closeSync(fd); } catch (e) { /* closed */ } try { fs.unlinkSync(lockPath); } catch (e) { /* gone */ } }
  }

  // A missing file is no leads at all; anything else that is not an array is an error (never written over).
  function readLeads() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('leads.json is not an array');
    return list;
  }

  function writeLeads(list) {
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch (e) { /* new file */ }
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  }

  // -> { matched, changed, ids }
  function markUnsubscribed(email, source) {
    return withLock(() => {
      const leads = readLeads();
      const stamp = now().toISOString();
      let matched = 0;
      const ids = [];
      for (const l of leads) {
        if (!l || typeof l !== 'object' || String(l.email || '').trim().toLowerCase() !== email) continue;
        matched++;
        if (l.unsubscribed) continue;
        l.unsubscribed = true;
        l.unsubscribed_at = stamp;
        l.unsubscribed_source = source;
        l.updated_at = stamp;
        ids.push(l.id);
      }
      if (ids.length) writeLeads(leads);
      return { matched, changed: ids.length, ids };
    });
  }

  app.post(ROUTE, (req, res) => {
    const h = req.headers || {};
    const peer = req.socket && req.socket.remoteAddress;
    // Order matters: what the internet can reach (a proxied request, a foreign peer) gets 403 and learns nothing about our configuration;
    // "not configured" is only ever told to a caller from this machine.
    if (!isLoopback(peer) || PROXY_HEADERS.some(k => h[k] !== undefined)) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (secret.length < MIN_SECRET) return res.status(503).json({ ok: false, error: 'not_configured' });
    if (!secretMatches(h[SECRET_HEADER], secret)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = normEmail(body.email);
    if (!email) return res.status(400).json({ ok: false, error: 'invalid_email' });
    const source = body.source === undefined ? 'account' : body.source;
    if (!SOURCES.has(source)) return res.status(400).json({ ok: false, error: 'invalid_source' });
    try {
      const out = markUnsubscribed(email, source);
      if (out.changed && typeof writeAuditLog === 'function') {
        try { writeAuditLog('leads', 'unsubscribed_from_account', 'account-service', 'leads ' + out.ids.join(',') + ' (' + source + ')', '127.0.0.1'); } catch (e) { /* audit is best effort */ }
      }
      return res.json({ ok: true, matched: out.matched, changed: out.changed });
    } catch (e) {
      // Not e.message: Node quotes a fragment of leads.json in a JSON.parse error, and a fragment can be a customer's address.
      const why = e && (e.code || (e.message === 'leads_locked' || e.message === 'leads.json is not an array' ? e.message : e.name)) || 'error';
      console.error('[account-unsubscribe] write failed: ' + why);
      return res.status(503).json({ ok: false, error: 'unavailable' });
    }
  });

  return { markUnsubscribed };
}

module.exports = mountAccountUnsubscribe;
module.exports.ROUTE = ROUTE;
module.exports.SECRET_HEADER = SECRET_HEADER;
module.exports.normEmail = normEmail;
