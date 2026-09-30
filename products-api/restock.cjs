'use strict';
// restock.cjs — the rules of "notify me when it is back in stock": what a subscription is, who may subscribe, which stock state
// counts, who gets the letter now, how a subscription ends. No input or output here: products-api.cjs loads this file, hands in
// what it knows (the catalog, the marketing exclusion list, the scrub) and does the file, the route and the sending itself —
// through the existing queue (mail-outbox, kind letter_restock) and cioSendEmail. The TEXT of the letter is a Customer.io
// transactional template (templates/, deploy/push-templates.cjs). Functions that take a list change it in place; the caller
// reads the file fresh, calls one, and writes the file back. Source of truth: services/restock/ in biofirst-hosting;
// spec docs/superpowers/specs/2026-09-30-restock-alerts.md; install — deploy/INSTALL.md.
const crypto = require('crypto');

const KIND = 'letter_restock';
const MODES = ['off', 'test', 'on'];
const MAX_PENDING_PER_EMAIL = 20;
const MAX_PENDING_TOTAL = 5000;
const STATUS_MAX_AGE_MS = 3 * 3600 * 1000;       // the stock file older than this is not believed
const EXPIRE_MS = 120 * 86400 * 1000;
const REQUEUE_AFTER_MS = 49 * 3600 * 1000;       // the queue gives up after 48 h: only then is a still pending subscription tried again
const MAX_PER_IP_24H = 10;                       // new subscriptions from one ip_hash in a rolling 24 hours
const RECENT_SENT_MS = 30 * 86400 * 1000;        // no new subscription for an address+key whose letter went out this recently
const MAX_LETTERS_PER_ADDRESS_24H = 3;
const PRUNE_MS = 60 * 86400 * 1000;              // finished records are dropped after this (a sent one outlives the 30-day window above)
const MAX_LETTERS_PER_ADDRESS_7D = 5;
const DAY_MS = 86400 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_PER_TICK = 30;                         // a restocked bestseller must not send every waiting letter in one second
const SHOP = 'https://biolabsresearch.co';
const TOKEN_RE = /^[0-9a-f]{32}$/;

// The same scrub products-api uses on everything that leaves for Customer.io; products-api passes its own in, this copy is the default for tests.
function defaultMailSafe(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .replace(/\b(javascript|vbscript)\s*:+/gi, '$1 ')
    .replace(/\bdata\s*:+\s*text\/html/gi, 'data text/html')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .trim();
}

// The key of the storefront and of the agents' SKU map: "<slug>-<strength>" lower case, no spaces (tg-stock shopKey, products-api normMgKey).
function normMg(v) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, '').toLowerCase(); }
function keyFor(slug, mg) {
  const s = String(slug === undefined || slug === null ? '' : slug).trim().toLowerCase();
  const m = normMg(mg);
  return m ? s + '-' + m : s;
}
function strengthsOf(product) {
  const own = Array.isArray(product.strengths) ? product.strengths.filter(s => typeof s === 'string' && s.trim()) : [];
  if (own.length) return own.map(s => s.trim());
  const sp = product.strength_prices;
  return sp && typeof sp === 'object' && !Array.isArray(sp) ? Object.keys(sp).map(s => s.trim()).filter(Boolean) : [];
}

// RESTOCK_MODE off|test|on (nothing = off). test sends only to ORDER_LETTERS_TEST_TO, the list the order letters use. A bad value never turns letters on.
function parseConfig(env) {
  const e = env || {};
  const problems = [];
  let mode = String(e.RESTOCK_MODE || '').trim().toLowerCase();
  if (!mode) mode = 'off';
  if (!MODES.includes(mode)) { problems.push('unknown RESTOCK_MODE ' + JSON.stringify(mode.slice(0, 20)) + ', letters are off'); mode = 'off'; }
  const testTo = new Set(String(e.ORDER_LETTERS_TEST_TO || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
  if (mode === 'test' && !testTo.size) problems.push('ORDER_LETTERS_TEST_TO is empty, no letter will be sent in test mode');
  return { mode, testTo, problems };
}
function templateId(env, procEnv) {
  return String((env && env.CIO_LETTER_RESTOCK_MSG_ID) || (procEnv && procEnv.CIO_LETTER_RESTOCK_MSG_ID) || '').trim();
}

// ---- the stock file (written hourly by tg-stock.cjs) ----
// raw: the file text. -> { ok:true, items, updatedAt } with items = { '<key>': 'in'|'out' }, or { ok:false, reason: unreadable|malformed|stale|future }.
function parseStatus(raw, nowMs) {
  let d;
  try { d = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'unreadable' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !d.items || typeof d.items !== 'object' || Array.isArray(d.items)) return { ok: false, reason: 'malformed' };
  const at = Date.parse(d.updatedAt);
  if (!Number.isFinite(at)) return { ok: false, reason: 'malformed' };
  const age = nowMs - at;
  if (age > STATUS_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  if (age < -5 * 60 * 1000) return { ok: false, reason: 'future' };
  const items = Object.create(null);
  for (const [k, v] of Object.entries(d.items)) if (v === 'in' || v === 'out') items[k] = v;
  return { ok: true, items, updatedAt: new Date(at).toISOString() };
}
// What the storefront may see: the list of keys that are out, no figures. A file that is not believed is an empty list (no button beats a false button).
function publicOut(status) {
  return { out: status && status.ok ? Object.keys(status.items).filter(k => status.items[k] === 'out').sort() : [] };
}

// ---- subscribe ----
// data: the parsed body. ctx: { products, status (parseStatus result), looksLikeEmail, isExcluded(email), isSuppressed(email), cfg }.
// -> { ok:false, error } (answer 400) | { ok:true, ignore:'trap'|'excluded'|'suppressed'|'not_out' } (answer 200, store nothing) | { ok:true, sub:{email,key,slug,mg,name} }.
function validateSubscribe(data, ctx) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Invalid request' };
  // The field no person sees: anything typed in it is a bot, and a bot gets the same answer as everyone (it learns nothing).
  if (data.website !== undefined && data.website !== null && String(data.website).trim() !== '') return { ok: true, ignore: 'trap' };
  if (typeof data.email !== 'string' || data.email.length > 200 || !ctx.looksLikeEmail(data.email)) return { ok: false, error: 'A valid email is required' };
  if (typeof data.slug !== 'string' || !data.slug.trim() || data.slug.length > 80) return { ok: false, error: 'Unknown product' };
  if (data.mg !== undefined && data.mg !== null && (typeof data.mg !== 'string' || data.mg.length > 20)) return { ok: false, error: 'Unknown strength' };
  const slug = data.slug.trim().toLowerCase();
  const product = (Array.isArray(ctx.products) ? ctx.products : []).find(p => p && typeof p.slug === 'string' && p.slug.toLowerCase() === slug && p.is_active !== false);
  if (!product) return { ok: false, error: 'Unknown product' };
  const strengths = strengthsOf(product);
  const want = normMg(data.mg);
  let mg;
  if (want) {
    mg = strengths.find(s => normMg(s) === want);
    if (!mg) return { ok: false, error: 'Unknown strength' };
  } else if (strengths.length > 1) {
    return { ok: false, error: 'Strength is required' };
  } else mg = strengths[0] || '';
  const email = data.email.trim().toLowerCase();
  // In test mode an address the operator listed on purpose is one of "ours": the exclusion list holds exactly those probes.
  const cfg = ctx.cfg || {};
  const listedForTest = cfg.mode === 'test' && !!cfg.testTo && cfg.testTo.has(email);
  if (!listedForTest && typeof ctx.isExcluded === 'function' && ctx.isExcluded(email)) return { ok: true, ignore: 'excluded' };
  // Only what is out of stock now can be waited for (the page shows the form only then): a script cannot fill the file with subscriptions for what is on the shelf,
  // which the next tick would mail at once. A stale or unreadable stock file counts as "not out". Test mode + a listed address is exempt (the live check).
  const key = keyFor(product.slug, mg);
  if (typeof ctx.isSuppressed === 'function' && ctx.isSuppressed(email)) return { ok: true, ignore: 'suppressed' };
  const isOut = !!(ctx.status && ctx.status.ok && ctx.status.items && ctx.status.items[key] === 'out');
  if (!isOut && !listedForTest) return { ok: true, ignore: 'not_out' };
  return { ok: true, sub: { email, key, slug: product.slug, mg, name: String(product.name || product.slug).replace(/\s+/g, ' ').trim().slice(0, 80) } };
}

// list: the parsed file, changed in place. -> { result: created|duplicate|recent_sent|cap_email|cap_ip|cap_total, sub? }. Nothing is changed unless created.
// fields.ipHash (optional) goes on the record as ip_hash and is what the per-IP limit counts.
function addSubscription(list, fields, nowMs, rnd) {
  const hex = rnd && rnd.randomHex ? rnd.randomHex : (b) => crypto.randomBytes(b).toString('hex');
  let perEmail = 0, total = 0, perIp = 0;
  for (const s of list) {
    if (!s) continue;
    if (s.status === 'sent' && s.email === fields.email && s.key === fields.key && nowMs - Date.parse(s.sentAt) < RECENT_SENT_MS) return { result: 'recent_sent' };
    if (fields.ipHash && s.ip_hash === fields.ipHash && nowMs - Date.parse(s.createdAt) < DAY_MS) perIp++;
    if (s.status !== 'pending') continue;
    total++;
    if (s.email === fields.email) { perEmail++; if (s.key === fields.key) return { result: 'duplicate' }; }
  }
  if (perEmail >= MAX_PENDING_PER_EMAIL) return { result: 'cap_email' };
  if (perIp >= MAX_PER_IP_24H) return { result: 'cap_ip' };
  if (total >= MAX_PENDING_TOTAL) return { result: 'cap_total' };
  const sub = { id: 'rs_' + hex(8), email: fields.email, key: fields.key, slug: fields.slug, mg: fields.mg, name: fields.name, token: hex(16), createdAt: new Date(nowMs).toISOString(), status: 'pending' };
  if (fields.ipHash) sub.ip_hash = fields.ipHash;
  list.push(sub);
  return { result: 'created', sub };
}
// sha256(salt + ip) in hex. The salt is random and kept 0600 next to the file, so the hash is a counter, not an address book.
// The same for an address that unsubscribed: the list of these hashes keeps the refusal without keeping the address.
function hashEmail(salt, email) {
  const e = String(email === undefined || email === null ? '' : email).trim().toLowerCase();
  if (!salt || !e) return undefined;
  return crypto.createHash('sha256').update(String(salt) + 'email:' + e).digest('hex');
}
function hashIp(salt, ip) {
  if (!salt || !ip) return undefined;
  return crypto.createHash('sha256').update(String(salt) + String(ip)).digest('hex');
}

// ---- end of a subscription ----
// The token of any record of the address (sent ones too: the link in an old letter keeps working) cancels every pending subscription of that address.
// -> how many were cancelled (0 for an unknown or malformed token).
function findByToken(list, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return list.find(x => x && x.token === token) || null;
}
function unsubscribe(list, token, nowMs) {
  const hit = findByToken(list, token);
  if (!hit) return 0;
  const at = new Date(nowMs === undefined ? Date.now() : nowMs).toISOString();
  let n = 0;
  for (const s of list) {
    if (s && s.email === hit.email && s.status === 'pending') { s.status = 'cancelled'; s.cancelledAt = at; n++; }
  }
  return n;
}
function expireOld(list, nowMs) {
  let n = 0;
  for (const s of list) {
    if (!s || s.status !== 'pending') continue;
    const made = Date.parse(s.createdAt);
    if (Number.isFinite(made) && nowMs - made > EXPIRE_MS) { s.status = 'expired'; s.expiredAt = new Date(nowMs).toISOString(); n++; }
  }
  return n;
}

// Finished records older than 60 days are dropped (the file would only grow). Age from sentAt / cancelledAt / expiredAt, else createdAt; sent ones live past the 30-day window.
function pruneFinished(list, nowMs) {
  const at = (s) => Date.parse(s.status === 'sent' ? s.sentAt : s.status === 'cancelled' ? s.cancelledAt : s.expiredAt);
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s || (s.status !== 'sent' && s.status !== 'cancelled' && s.status !== 'expired')) continue;
    const t = Number.isFinite(at(s)) ? at(s) : Date.parse(s.createdAt);
    if (Number.isFinite(t) && nowMs - t > PRUNE_MS) { list.splice(i, 1); n++; }
  }
  return n;
}

// ---- letters ----
// One answer to "may this subscription get the letter now": { ok:true } or { ok:false, reason }. ctx: looksLikeEmail, isExcluded(email).
function letterAllowed(sub, cfg, ctx) {
  const c = cfg || {};
  const no = (reason) => ({ ok: false, reason });
  if (c.mode !== 'test' && c.mode !== 'on') return no('mode_off');
  if (!sub || typeof sub !== 'object') return no('no_sub');
  if (sub.status !== 'pending') return no('not_pending');
  const email = typeof sub.email === 'string' ? sub.email.trim().toLowerCase() : '';
  if (!ctx.looksLikeEmail(email)) return no('no_email');
  if (typeof ctx.isSuppressed === 'function' && ctx.isSuppressed(email)) return no('suppressed');
  const listed = c.mode === 'test' && !!c.testTo && c.testTo.has(email);
  if (!listed && typeof ctx.isExcluded === 'function' && ctx.isExcluded(email)) return no('excluded');
  if (c.mode === 'test' && !listed) return no('not_test_recipient');
  return { ok: true };
}
// items: the parsed stock file's items. ctx: looksLikeEmail, isExcluded, sentIds (a Set of ids this process has sent: a record that failed to be marked must not go out again).
// -> { send: [sub], would: [sub] } — would: test mode, not a listed address.
function dueForLetter(list, items, cfg, nowMs, ctx) {
  const send = [], would = [];
  // Letters to one address in the last 24 hours, sent or already queued: a rolling window of 3; the rest stay pending for a later tick.
  // And 5 in 7 days (owner's reviewer 01.10): the two counters are kept per address.
  const recent = new Map(), weekly = new Map();
  const bump = (email) => { recent.set(email, (recent.get(email) || 0) + 1); weekly.set(email, (weekly.get(email) || 0) + 1); };
  for (const s of list) {
    if (!s) continue;
    const t = Date.parse(s.status === 'sent' ? s.sentAt : s.status === 'pending' ? s.queuedAt : NaN);
    if (!Number.isFinite(t)) continue;
    if (nowMs - t < WEEK_MS) weekly.set(s.email, (weekly.get(s.email) || 0) + 1);
    if (nowMs - t < DAY_MS) recent.set(s.email, (recent.get(s.email) || 0) + 1);
  }
  for (const s of list) {
    if (!s || s.status !== 'pending' || !items || items[s.key] !== 'in') continue;
    if (ctx.sentIds && ctx.sentIds.has(s.id)) continue;
    const q = Date.parse(s.queuedAt);
    if (Number.isFinite(q) && nowMs - q < REQUEUE_AFTER_MS) continue;
    const v = letterAllowed(s, cfg, ctx);
    if (v.ok) {
      if (send.length >= MAX_PER_TICK || (recent.get(s.email) || 0) >= MAX_LETTERS_PER_ADDRESS_24H || (weekly.get(s.email) || 0) >= MAX_LETTERS_PER_ADDRESS_7D) continue;
      send.push(s); bump(s.email);
    } else if (v.reason === 'not_test_recipient') would.push(s);
  }
  return { send, would };
}
function markQueued(list, ids, nowMs) {
  for (const s of list) if (s && ids.includes(s.id)) s.queuedAt = new Date(nowMs).toISOString();
}
function markSent(list, id, nowMs) {
  const s = list.find(x => x && x.id === id);
  if (!s) return false;
  s.status = 'sent';
  s.sentAt = new Date(nowMs).toISOString();
  return true;
}
// The name for the subject line: plain text, no entities (mailSafe would turn "&" into "&amp;", which a subject shows as it is). Control characters
// (a line break in a header) become spaces, Liquid braces are dropped so a catalog name cannot run a template.
function plainName(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\{\{|\}\}|\{%|%\}/g, ' ').replace(/\s+/g, ' ').trim();
}
// The fields of message_data: the contract, nothing else. Everything typed or catalog text goes through the scrub (the subject gets plainName instead).
function letterData(sub, opts) {
  const txt = opts && typeof opts.mailSafe === 'function' ? opts.mailSafe : defaultMailSafe;
  return {
    product_name: txt(sub.name),
    product_name_plain: plainName(sub.name),
    strength: txt(sub.mg),
    product_url: SHOP + '/products/' + encodeURIComponent(String(sub.slug)),
    unsubscribe_url: SHOP + '/api/restock-unsubscribe?t=' + encodeURIComponent(String(sub.token))
  };
}

const PAGE_HEAD = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Back-in-stock emails</title>' +
  '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:48px 20px;text-align:center;color:#222}p{max-width:30em;margin:0 auto 20px;font-size:18px;line-height:1.5}' +
  'button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#18181B;color:#fff;cursor:pointer}</style></head><body>';
// GET of the link in the letter: a page with one button. A mail scanner that only fetches the link cancels nothing; the POST below does.
// The token is echoed only when it has the shape of one, so nothing typed into the address can land in the page.
function unsubscribePage(token) {
  const t = typeof token === 'string' && TOKEN_RE.test(token) ? token : '';
  return PAGE_HEAD + '<p>Stop back-in-stock emails from BioLabs Research?</p>' +
    '<form method="post" action="/api/restock-unsubscribe"><input type="hidden" name="t" value="' + t + '"><button type="submit">Stop back-in-stock emails</button></form></body></html>\n';
}
// The answer of the POST, the same for a known, an unknown and a used token.
function unsubscribedPage() {
  return PAGE_HEAD + '<p>You will not get this notification.</p></body></html>\n';
}

// An id goes into log lines and alerts; a line never carries an address.
function safeId(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[^\s@,;]+@[^\s@,;]+/g, '<addr>').replace(/\s+/g, ' ').trim().slice(0, 64);
}

module.exports = {
  KIND, MODES, MAX_PENDING_PER_EMAIL, MAX_PENDING_TOTAL, MAX_PER_IP_24H, MAX_LETTERS_PER_ADDRESS_24H, MAX_LETTERS_PER_ADDRESS_7D, STATUS_MAX_AGE_MS, EXPIRE_MS, REQUEUE_AFTER_MS, MAX_PER_TICK, SHOP,
  normMg, keyFor, strengthsOf, parseConfig, templateId, parseStatus, publicOut, validateSubscribe, addSubscription,
  findByToken, unsubscribe, expireOld, pruneFinished, hashEmail, hashIp, plainName, letterAllowed, dueForLetter, markQueued, markSent, letterData, unsubscribePage, unsubscribedPage, safeId, defaultMailSafe
};
