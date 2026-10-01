'use strict';
// reviews.cjs — the rules of "verified-buyer reviews" and of the hidden 1-5 rating of an order: who may write, what is
// accepted, what is published, what the moderator sees. No input or output here: products-api.cjs loads this file, hands in
// what it knows (the order, the catalog, the test-order check) and does the file, the routes and the letter field itself.
// Functions that take the data object change it in place; the caller reads reviews.json fresh, calls one, writes it back.
// Source of truth: services/reviews/ in biofirst-hosting; spec docs/superpowers/specs/2026-10-01-reviews.md; install
// deploy/INSTALL.md.
//
// Two things, never mixed:
//   rating  — "how was your order", 1-5 and an optional comment, one per order, NEVER shown on the site, only the CRM report;
//   review  — text about one product of the order, shown on the product card ONLY after a person approved it in the CRM.
// The link in the rating letter ("How was your order?", sent some days after delivery, see the section "the rating letter") carries an HMAC token of
// (order number, address): whoever holds it may write for that order.
// Opening the link writes nothing (mail scanners open links); only the POST of the page does.
const crypto = require('crypto');

const MODES = ['off', 'test', 'on'];
const SHOP = 'https://biolabsresearch.co';
const TOKEN_LEN = 32;                       // base64url characters kept of the 43 of a SHA-256 (192 bits)
const MIN_SECRET_LEN = 24;
const RATING_EDIT_MS = 14 * 86400 * 1000;   // a rating can be changed this long after it was first given
const TEXT_MIN = 20, TEXT_MAX = 1000, COMMENT_MAX = 1000;
const NAME_MIN = 2, NAME_MAX = 30;
const MAX_PENDING = 500;                    // pending reviews in the file: a flood stops here and the moderator is told
const MAX_REVIEWS = 5000, MAX_RATINGS = 20000;
const PUBLIC_LIMIT = 50;                    // reviews of one product sent to the page
const ADMIN_REVIEWS_LIMIT = 2000, ADMIN_RATINGS_LIMIT = 500;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

// ---- config ----
// REVIEWS_MODE off|test|on (nothing = off), REVIEWS_SECRET (>= 24 characters) signs the links. A missing or short secret,
// or a bad mode, never turns the feature on.
function parseConfig(env) {
  const e = env || {};
  const problems = [];
  let mode = String(e.REVIEWS_MODE || '').trim().toLowerCase();
  if (!mode) mode = 'off';
  if (!MODES.includes(mode)) { problems.push('unknown REVIEWS_MODE ' + JSON.stringify(mode.slice(0, 20)) + ', reviews are off'); mode = 'off'; }
  const secret = String(e.REVIEWS_SECRET || '').trim();
  if (mode !== 'off' && secret.length < MIN_SECRET_LEN) { problems.push('REVIEWS_SECRET is missing or shorter than ' + MIN_SECRET_LEN + ' characters, reviews are off'); mode = 'off'; }
  const testTo = new Set(String(e.ORDER_LETTERS_TEST_TO || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
  if (mode === 'test' && !testTo.size) problems.push('ORDER_LETTERS_TEST_TO is empty, no link will be sent and nobody can write in test mode');
  return { mode, secret, testTo, problems };
}

// ---- the link ----
function emailOf(order) {
  return order && order.customer && typeof order.customer.email === 'string' ? order.customer.email.trim().toLowerCase() : '';
}
function tokenFor(secret, ref, email) {
  return crypto.createHmac('sha256', String(secret)).update(String(ref) + '|' + String(email || '').trim().toLowerCase()).digest('base64url').slice(0, TOKEN_LEN);
}
function tokenOk(secret, ref, email, given) {
  if (typeof given !== 'string' || given.length !== TOKEN_LEN || !secret || !ref || !email) return false;
  const want = Buffer.from(tokenFor(secret, ref, email)), got = Buffer.from(given);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function reviewUrl(secret, ref, email) {
  // The token is in the fragment (#...): a browser never sends it, so it is not in access.log, error.log or any Referer. The page's script reads it from location.hash.
  return SHOP + '/review#o=' + encodeURIComponent(ref) + '&t=' + tokenFor(secret, ref, email);
}

// ---- who may write ----
// One answer for "may this order be written about": {ok:true} or {ok:false, reason}. ctx: isTestOrder(order), looksLikeEmail(v).
// Only a delivered order: the link goes out with the delivered letter, and "verified purchase" must mean the parcel arrived
// (a cancelled, refunded or still travelling order is not). A test order is never a verified purchase.
function orderAllowed(order, ctx) {
  const no = (reason) => ({ ok: false, reason });
  const c = ctx || {};
  if (!order || typeof order !== 'object') return no('no_order');
  if (typeof order.ref !== 'string' || !REF_RE.test(order.ref)) return no('bad_ref');
  if (String(order.status || '').trim().toLowerCase() !== 'delivered') return no('not_delivered');
  const isTest = typeof c.isTestOrder === 'function' ? c.isTestOrder : (o) => o.test === true;
  if (isTest(order)) return no('test_order');
  if (/TEST ORDER/i.test(String(order.notes || ''))) return no('test_order');
  const email = emailOf(order);
  const looks = typeof c.looksLikeEmail === 'function' ? c.looksLikeEmail : (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (!email || !looks(email)) return no('no_email');
  return { ok: true };
}
// cfg.mode test: only the addresses the operator listed. on: everybody who has a valid link.
function modeAllows(cfg, email) {
  if (!cfg || (cfg.mode !== 'test' && cfg.mode !== 'on')) return false;
  if (cfg.mode === 'test') return !!cfg.testTo && cfg.testTo.has(String(email || '').trim().toLowerCase());
  return true;
}
// The one extra field of message_data of the delivered letter. Empty when the feature is off, when this address is not
// allowed yet, or when the order is not one that may be written about: the letter then reads exactly as it did before.
function letterFields(order, cfg, ctx) {
  if (!cfg || !cfg.secret || !modeAllows(cfg, emailOf(order))) return {};
  if (!orderAllowed(order, ctx).ok) return {};
  return { review_url: reviewUrl(cfg.secret, order.ref, emailOf(order)) };
}

// ---- the rating letter ----
// A separate letter, REVIEWS_RATING_DELAY_DAYS (default 3) after the order was delivered; the delivered letter itself no longer carries the link.
// Which orders are due is decided here from data products-api hands in; products-api queues the letter (mail-outbox kind letter_rating), the
// queue's sender asks the same function again before it sends, and order.letters.rating.sentAt makes it one letter per order.
// The moment of delivery is the one the delivered letter went out (order.letters.delivered.sentAt): the order has no status history, and an
// order without that mark is skipped, never counted as "long ago".
const RATING_DELAY_DEFAULT_DAYS = 3;
const RATING_DELAY_MAX_DAYS = 60;
const RATING_SWEEP_MAX = 20;                // letters queued by one sweep; the rest wait for the next one
const RATING_STALE_QUEUE_MS = 2 * 3600 * 1000;   // queued (marked on the order) this long ago and still no sentAt: the pass says so once; it never queues again
const DAY_MS = 86400 * 1000;

// REVIEWS_RATING_SINCE (an ISO date) is required: without a moment to count from, every order delivered since the shop opened would get a
// letter on the first sweep. A missing or bad value, or a bad delay, switches the rating letter off (the rest of the feature is not touched).
function parseRatingConfig(env) {
  const e = env || {};
  const problems = [];
  let enabled = true, delayMs = RATING_DELAY_DEFAULT_DAYS * DAY_MS;
  const rawDelay = String(e.REVIEWS_RATING_DELAY_DAYS === undefined || e.REVIEWS_RATING_DELAY_DAYS === null ? '' : e.REVIEWS_RATING_DELAY_DAYS).trim();
  if (rawDelay) {
    const d = /^\d+(?:\.\d+)?$/.test(rawDelay) ? Number(rawDelay) : NaN;
    if (Number.isFinite(d) && d <= RATING_DELAY_MAX_DAYS) delayMs = d * DAY_MS;
    else { problems.push('REVIEWS_RATING_DELAY_DAYS is not a number from 0 to ' + RATING_DELAY_MAX_DAYS + ', the rating letter is off'); enabled = false; }
  }
  const rawSince = String(e.REVIEWS_RATING_SINCE === undefined || e.REVIEWS_RATING_SINCE === null ? '' : e.REVIEWS_RATING_SINCE).trim();
  const sinceMs = /^\d{4}-\d{2}-\d{2}/.test(rawSince) ? Date.parse(rawSince) : NaN;
  if (!Number.isFinite(sinceMs)) { problems.push('REVIEWS_RATING_SINCE missing or not a date, the rating letter is off'); enabled = false; }
  return { enabled, delayMs, sinceMs, problems };
}
function ratingRecord(order) {
  const l = order && order.letters;
  const r = l && typeof l === 'object' && !Array.isArray(l) ? l.rating : null;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}
// When the order was delivered, as far as we can tell: the moment its delivered letter went out. NaN = unknown.
function deliveredMs(order) {
  const l = order && order.letters;
  const d = l && typeof l === 'object' && !Array.isArray(l) ? l.delivered : null;
  const t = d && typeof d === 'object' ? Date.parse(d.sentAt) : NaN;
  return Number.isFinite(t) ? t : NaN;
}
// One answer for "is this order due its rating letter now": {ok:true} or {ok:false, reason}. ctx:
//   nowMs; cfg (reviews parseConfig: mode, testTo); rating (parseRatingConfig); ratedRefs (Set of order numbers that already have a rating);
//   lettersVerdict(order) -> {ok, reason}: the rules every order letter follows (order-letters.letterAllowed(order, 'rating'): shop orders only,
//   not cancelled, not our own probe addresses, the order date); isTestOrder and looksLikeEmail as for orderAllowed.
// At most once: the pass writes order.letters.rating.queuedAt BEFORE it queues the letter, and a queuedAt (like a sentAt) ends the pass's interest in the order for good. A letter
// that was accepted by Customer.io but whose sentAt could not be written, or a pass that died between the mark and the queue, therefore never produces a second letter; the cost is
// that in the second case the letter is simply not sent (the pass says "queued, never sent", see ratingSweep). ctx.sending = true is the check of the queue's sender, which is
// the one that acts on a queuedAt: it skips that refusal. The sender then writes order.letters.rating.tryAt BEFORE the HTTP call; an item that finds a tryAt (and no sentAt) is an
// attempt whose outcome nobody confirmed (timeout, crash, a lost answer): it is refused as 'unconfirmed_attempt' and never repeated. Only an explicit HTTP refusal clears the tryAt.
// 'rated' is the one refusal the caller writes down on the order (a rating was given before the letter was due). It is asked last, so that in
// test mode nothing is ever written on a real buyer's order.
function ratingLetterDecision(order, ctx) {
  const c = ctx || {}, cfg = c.cfg || {}, rc = c.rating || {};
  const no = (reason) => ({ ok: false, reason });
  if (cfg.mode !== 'test' && cfg.mode !== 'on') return no('mode_off');
  if (!rc.enabled) return no('rating_off');
  if (!(c.ratedRefs instanceof Set) || !Number.isFinite(c.nowMs)) return no('bad_context');
  const allowed = orderAllowed(order, c);
  if (!allowed.ok) return no(allowed.reason);
  const rec = ratingRecord(order);
  if (rec.sentAt) return no('already_sent');
  if (rec.skipped) return no('already_skipped');
  if (rec.queuedAt && !c.sending) return no('already_queued');
  if (rec.tryAt && c.sending) return no('unconfirmed_attempt');
  const at = deliveredMs(order);
  if (!Number.isFinite(at)) return no('no_delivery_moment');
  if (at < rc.sinceMs) return no('before_since');
  if (!(c.nowMs - at >= rc.delayMs)) return no('too_early');
  if (typeof c.lettersVerdict === 'function') { const v = c.lettersVerdict(order); if (!v || !v.ok) return no('letter_' + String((v && v.reason) || 'refused')); }
  if (!modeAllows(cfg, emailOf(order))) return no('not_test_recipient');
  if (c.ratedRefs.has(order.ref)) return no('rated');
  return { ok: true };
}
// What one pass does with the delivered orders of orders.json. Changes nothing: -> { examined, queue: [ref], markRated: [ref], counts: {reason: n} }.
function ratingSweep(orders, ctx, max) {
  const cap = Number.isInteger(max) && max > 0 ? max : RATING_SWEEP_MAX;
  const out = { examined: 0, queue: [], markRated: [], stale: [], counts: {} };
  const count = (k) => { out.counts[k] = (out.counts[k] || 0) + 1; };
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!o || typeof o !== 'object' || String(o.status || '').trim().toLowerCase() !== 'delivered') continue;
    out.examined++;
    let v;
    try { v = ratingLetterDecision(o, ctx); } catch (e) { v = { ok: false, reason: 'error' }; }
    if (v.ok) { if (out.queue.length < cap) out.queue.push(o.ref); else count('over_cap'); }
    else if (v.reason === 'rated') out.markRated.push(o.ref);
    else {
      count(v.reason);
      if (v.reason === 'already_queued' && Number.isFinite(ctx.nowMs) && ctx.nowMs - Date.parse(ratingRecord(o).queuedAt) > RATING_STALE_QUEUE_MS) out.stale.push(o.ref);
    }
  }
  return out;
}
// "This order's letter is being queued now": written (and the file saved) before the queue is asked, see ratingLetterDecision.
function markRatingQueued(order, nowMs) {
  const l = order.letters && typeof order.letters === 'object' && !Array.isArray(order.letters) ? order.letters : {};
  order.letters = Object.assign({}, l, { rating: { queuedAt: new Date(nowMs).toISOString() } });
  return order;
}
// The attempt mark (written and saved before the HTTP call) and its removal after an explicit HTTP refusal. The caller writes the file.
function markRatingTry(order, nowMs) {
  const l = order.letters && typeof order.letters === 'object' && !Array.isArray(order.letters) ? order.letters : {};
  order.letters = Object.assign({}, l, { rating: Object.assign({}, ratingRecord(order), { tryAt: new Date(nowMs).toISOString() }) });
  return order;
}
function clearRatingTry(order) {
  const l = order.letters && typeof order.letters === 'object' && !Array.isArray(order.letters) ? order.letters : {};
  const rec = Object.assign({}, ratingRecord(order)); delete rec.tryAt;
  order.letters = Object.assign({}, l, { rating: rec });
  return order;
}
// An HTTP answer that says for certain that Customer.io did NOT take the letter (3xx, 4xx except 408, 5xx): the attempt mark is removed and the queue decides whether to try again
// (it does for 401, 403, 429, 5xx; for the other 4xx it gives up and says so: dead list, [mail-alert]). Everything else that is not 2xx (a timeout, a network error, 408, no status at
// all) leaves it unknown whether the letter went out: the mark stays, nothing is repeated.
function ratingNotTaken(status) { return typeof status === 'number' && status >= 300 && status !== 408; }
// "No letter for this order, and why", written on the order so that the next pass does not look at it again. The caller writes the file.
function markRatingSkipped(order, reason, nowMs) {
  const l = order.letters && typeof order.letters === 'object' && !Array.isArray(order.letters) ? order.letters : {};
  order.letters = Object.assign({}, l, { rating: { skipped: String(reason), at: new Date(nowMs).toISOString() } });
  return order;
}
// For the report: letters sent, how many of those orders now have a rating, and how many orders had a rating before the letter was due.
function ratingLetterStats(orders, ratings) {
  const rated = new Set((Array.isArray(ratings) ? ratings : []).filter(x => x && typeof x.ref === 'string').map(x => x.ref));
  let sent = 0, answered = 0, skippedRated = 0;
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!o || typeof o !== 'object') continue;
    const rec = ratingRecord(o);
    if (Number.isFinite(Date.parse(rec.sentAt))) { sent++; if (rated.has(o.ref)) answered++; }
    else if (rec.skipped === 'rated') skippedRated++;
  }
  return { sent, answered, rate: sent ? Math.round(answered * 1000 / sent) / 10 : null, skippedRated };
}

// ---- names and items ----
const NAME_RE = /^[\p{L}][\p{L}\p{M} .'\u2019-]*$/u;
function cleanLine(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function cleanText(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function validName(v) {
  const s = cleanLine(v);
  return s.length >= NAME_MIN && s.length <= NAME_MAX && NAME_RE.test(s) && (s.match(/\p{L}/gu) || []).length >= 2 ? s : '';
}
// "Alex K." from the order; what cannot be made into a valid name becomes "Verified buyer".
function defaultName(order) {
  const c = (order && order.customer) || {};
  const first = cleanLine(c.firstName).split(' ')[0];
  const last = cleanLine(c.lastName);
  const initial = last ? (last.match(/\p{L}/u) || [''])[0].toUpperCase() : '';
  const name = first ? first.charAt(0).toUpperCase() + first.slice(1) + (initial ? ' ' + initial + '.' : '') : '';
  return validName(name) || 'Verified buyer';
}
// The items of the order that have a product page: [{slug,name}], in order, once each. slug from the line, or found by name.
function itemsOf(order, products) {
  const list = Array.isArray(products) ? products : [];
  const bySlug = new Map(), byName = new Map();
  for (const p of list) {
    if (!p || typeof p.slug !== 'string') continue;
    bySlug.set(p.slug.toLowerCase(), p);
    if (typeof p.name === 'string') byName.set(p.name.trim().toLowerCase(), p);
  }
  const out = [], seen = new Set();
  for (const it of (order && Array.isArray(order.items) ? order.items : [])) {
    if (!it || typeof it !== 'object') continue;
    const s = typeof it.slug === 'string' ? it.slug.trim().toLowerCase() : '';
    const p = (s && SLUG_RE.test(s) && bySlug.get(s)) || byName.get(String(it.name || '').trim().toLowerCase());
    if (!p) continue;
    const slug = p.slug.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name: cleanLine(p.name || it.name || slug).slice(0, 80) });
  }
  return out;
}

// ---- words that send a text to the moderator's red list ----
// Stems and variants: the moderator decides, nothing is refused or published by this list. Research-use line of the shop:
// reviews may describe ordering, packaging, delivery and product quality, never use on a person, dosing or effects.
const STOP_PATTERNS = [
  'dos(?:e|es|ed|ing|age|ages)', 'inject\\w*', '(?:mg|mcg|iu|ug)\\s*/\\s*kg', 'per\\s+kg', 'sub-?q', 'subcutaneous\\w*', 'intramuscular\\w*', 'administer\\w*',
  'cycles?', 'stack(?:s|ed|ing)?', 'cures?', 'cured', 'curing', 'treat(?:s|ed|ing|ment|ments)?', 'therap\\w*', 'heal(?:s|ed|ing)?',
  'felt', 'feel(?:s|ing)?', 'my\\s+body', 'side[\\s-]+effects?', 'symptoms?', 'weight[\\s-]+loss', 'fat[\\s-]+loss', 'lose\\s+weight', 'lost\\s+\\d+\\s*(?:lbs?|pounds|kg)',
  'humans?', 'patients?', 'doctors?', 'physicians?', 'prescri\\w*', 'twice\\s+a\\s+day', 'per\\s+day', 'once\\s+daily',
  'daily', 'weekly', '\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|iu|ml|units?)',
  'i\\s+(?:took|take|taking|am\\s+taking|was\\s+taking)', 'started\\s+taking'
];
const STOP_RE = new RegExp('(?<![\\p{L}])(?:' + STOP_PATTERNS.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
// The address part is written as [^\s@]+@[^\s@]+\.[^\s@]+ (no \S+ on both sides of the @): a text of a thousand @ stays linear (test: under 50 ms).
const LINK_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|[^\s@]+@[^\s@]+\.[^\s@]+/gi;
// The distinct matches, lower case, in order of first appearance (the page highlights exactly these strings). Links and addresses count too.
function flagsOf(text) {
  const s = String(text === undefined || text === null ? '' : text);
  const hits = [];
  for (const m of s.matchAll(STOP_RE)) hits.push([m.index, m[0].toLowerCase().replace(/\s+/g, ' ')]);
  for (const m of s.matchAll(LINK_RE)) hits.push([m.index, m[0].toLowerCase().slice(0, 40)]);
  hits.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const h of hits) if (!out.includes(h[1])) out.push(h[1]);
  return out.slice(0, 20);
}

// ---- the file ----
function emptyData() { return { ratings: [], reviews: [] }; }
// raw: the parsed file or undefined (missing). A broken shape throws: the caller answers 500 and the file is never replaced by an empty one.
function normalizeData(raw) {
  if (raw === undefined || raw === null) return emptyData();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.ratings) || !Array.isArray(raw.reviews)) throw new Error('reviews.json is malformed');
  return raw;
}

// ---- rating ----
// data: { r, comment } from the page. -> { ok:false, error } | { ok:true, r, comment }
function validateRating(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Invalid request' };
  if (!Number.isInteger(data.r) || data.r < 1 || data.r > 5) return { ok: false, error: 'Rating must be 1 to 5' };
  let comment = '';
  if (data.comment !== undefined && data.comment !== null) {
    if (typeof data.comment !== 'string') return { ok: false, error: 'Invalid comment' };
    comment = cleanText(data.comment);
    if (comment.length > COMMENT_MAX) return { ok: false, error: 'Comment is too long (most ' + COMMENT_MAX + ' characters)' };
  }
  return { ok: true, r: data.r, comment };
}
function findRating(data, ref) { return data.ratings.find(x => x && x.ref === ref) || null; }
function ratingLocked(rec, nowMs) {
  const made = Date.parse(rec && rec.createdAt);
  return Number.isFinite(made) && nowMs - made > RATING_EDIT_MS;
}
// -> { result: created|updated|locked|cap_total, rating? }. One per order; changed for 14 days after the first one.
function setRating(data, fields, nowMs, rnd) {
  const hex = rnd && rnd.randomHex ? rnd.randomHex : (b) => crypto.randomBytes(b).toString('hex');
  const at = new Date(nowMs).toISOString();
  const cur = findRating(data, fields.ref);
  if (cur) {
    if (ratingLocked(cur, nowMs)) return { result: 'locked', rating: cur };
    cur.rating = fields.r; cur.comment = fields.comment; cur.updatedAt = at;
    cur.flags = flagsOf(fields.comment);
    return { result: 'updated', rating: cur };
  }
  if (data.ratings.length >= MAX_RATINGS) return { result: 'cap_total' };
  const rec = { id: 'rt_' + hex(8), ref: fields.ref, email: fields.email, rating: fields.r, comment: fields.comment, createdAt: at, updatedAt: at, flags: flagsOf(fields.comment) };
  data.ratings.push(rec);
  return { result: 'created', rating: rec };
}

// ---- review ----
// data: the parsed body, order: the order (for the default name), items: itemsOf(order, catalog).
// -> { ok:false, error } | { ok:true, slug, text, displayName }
function validateReview(data, items, order) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Invalid request' };
  if (data.consent !== true) return { ok: false, error: 'Please agree that the review may be published' };
  if (typeof data.slug !== 'string' || !SLUG_RE.test(data.slug.trim().toLowerCase())) return { ok: false, error: 'Unknown product' };
  const slug = data.slug.trim().toLowerCase();
  if (!(items || []).some(i => i.slug === slug)) return { ok: false, error: 'Unknown product' };
  if (typeof data.text !== 'string') return { ok: false, error: 'Review text is required' };
  const text = cleanText(data.text);
  if (text.length < TEXT_MIN) return { ok: false, error: 'Review is too short (at least ' + TEXT_MIN + ' characters)' };
  if (text.length > TEXT_MAX) return { ok: false, error: 'Review is too long (most ' + TEXT_MAX + ' characters)' };
  if ((text.match(/\p{L}/gu) || []).length < 10) return { ok: false, error: 'Please write the review in words' };
  let displayName;
  if (data.displayName === undefined || data.displayName === null || String(data.displayName).trim() === '') displayName = defaultName(order);
  else {
    if (typeof data.displayName !== 'string') return { ok: false, error: 'Invalid name' };
    displayName = validName(data.displayName);
    if (!displayName) return { ok: false, error: 'Please use letters only for the name (2 to ' + NAME_MAX + ' characters, like "Alex K.")' };
  }
  return { ok: true, slug, text, displayName };
}
// -> { result: created|duplicate|cap_pending|cap_total, review? }. One review per order and product, in any status (a rejected one is not sent again).
function addReview(data, fields, nowMs, rnd) {
  const hex = rnd && rnd.randomHex ? rnd.randomHex : (b) => crypto.randomBytes(b).toString('hex');
  let pending = 0;
  for (const r of data.reviews) {
    if (!r) continue;
    if (r.ref === fields.ref && r.slug === fields.slug) return { result: 'duplicate' };
    if (r.status === 'pending') pending++;
  }
  if (pending >= MAX_PENDING) return { result: 'cap_pending' };
  if (data.reviews.length >= MAX_REVIEWS) return { result: 'cap_total' };
  const rec = {
    id: 'rv_' + hex(8), ref: fields.ref, email: fields.email, slug: fields.slug, productName: fields.productName, displayName: fields.displayName, text: fields.text,
    consent: true, status: 'pending', flags: flagsOf(fields.text), createdAt: new Date(nowMs).toISOString()
  };
  data.reviews.push(rec);
  return { result: 'created', review: rec };
}

// ---- the public list and the moderator ----
// Only approved ones, newest first, nothing that identifies the order or the buyer beyond the name they chose; the date is the month only.
function publicReviews(data, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return [];
  return data.reviews
    .filter(r => r && r.status === 'approved' && r.slug === slug)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, PUBLIC_LIMIT)
    .map(r => ({ displayName: r.displayName, text: r.text, date: String(r.createdAt).slice(0, 7) }));   // YYYY-MM: a month, not a day
}
// action approve|reject, from any state (a published review can be taken down; a rejected one put back). Text is never edited.
function decide(data, id, action, by, nowMs) {
  if (action !== 'approve' && action !== 'reject') return { result: 'bad_action' };
  const r = typeof id === 'string' ? data.reviews.find(x => x && x.id === id) : null;
  if (!r) return { result: 'not_found' };
  r.status = action === 'approve' ? 'approved' : 'rejected';
  r.decidedAt = new Date(nowMs).toISOString();
  r.decidedBy = String(by || '').slice(0, 120);
  return { result: 'ok', review: r };
}
function ratingStats(ratings) {
  const list = ratings.filter(x => x && Number.isInteger(x.rating));
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const months = new Map();
  let sum = 0;
  for (const x of list) {
    dist[x.rating]++;
    sum += x.rating;
    const m = String(x.createdAt || '').slice(0, 7);
    const cur = months.get(m) || { month: m, count: 0, sum: 0 };
    cur.count++; cur.sum += x.rating;
    months.set(m, cur);
  }
  return {
    count: list.length,
    average: list.length ? Math.round((sum / list.length) * 100) / 100 : null,
    distribution: dist,
    byMonth: [...months.values()].filter(m => m.month).sort((a, b) => (a.month < b.month ? -1 : 1)).map(m => ({ month: m.month, count: m.count, average: Math.round((m.sum / m.count) * 100) / 100 }))
  };
}
// Everything the CRM page needs. The buyer's address is shown to staff (they see it on the order anyway); the public list never has it.
function adminView(data, orders) {
  const reviews = data.reviews.filter(Boolean).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, ADMIN_REVIEWS_LIMIT)
    .map(r => ({ id: r.id, ref: r.ref, email: r.email, slug: r.slug, productName: r.productName || r.slug, displayName: r.displayName, text: r.text, status: r.status, flags: Array.isArray(r.flags) ? r.flags : [], createdAt: r.createdAt, decidedAt: r.decidedAt || null, decidedBy: r.decidedBy || null }));
  const ratings = data.ratings.filter(Boolean).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, ADMIN_RATINGS_LIMIT)
    .map(x => ({ id: x.id, ref: x.ref, email: x.email, rating: x.rating, comment: x.comment || '', flags: Array.isArray(x.flags) ? x.flags : [], createdAt: x.createdAt, updatedAt: x.updatedAt || x.createdAt }));
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const r of data.reviews) if (r && Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status]++;
  const view = { reviews, ratings, counts, stats: ratingStats(data.ratings) };
  if (Array.isArray(orders)) view.ratingLetters = ratingLetterStats(orders, data.ratings);   // the orders are another file, read by the caller; without them the report has no letter numbers
  return view;
}

// ---- a small in-memory counter: attempts per key in a rolling window (kept per process, never written) ----
function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    // true = this attempt is within the limit (and is counted), false = over it
    take(key, nowMs) {
      const from = nowMs - windowMs;
      let list = (hits.get(key) || []).filter(t => t > from);
      const ok = list.length < max;
      if (ok) list.push(nowMs);
      hits.set(key, list);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= from) hits.delete(k);
      return ok;
    },
    // true = the key has used up its attempts (nothing is counted): for a limit that counts only failures
    over(key, nowMs) {
      const from = nowMs - windowMs;
      return (hits.get(key) || []).filter(t => t > from).length >= max;
    }
  };
}

// An id goes into log lines; a line never carries an address.
function safeId(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[^\s@,;]+@[^\s@,;]+/g, '<addr>').replace(/\s+/g, ' ').trim().slice(0, 64);
}

module.exports = {
  MODES, SHOP, TOKEN_LEN, MIN_SECRET_LEN, RATING_EDIT_MS, TEXT_MIN, TEXT_MAX, COMMENT_MAX, MAX_PENDING, MAX_REVIEWS, MAX_RATINGS, PUBLIC_LIMIT, STOP_PATTERNS,
  parseConfig, tokenFor, tokenOk, reviewUrl, emailOf, orderAllowed, modeAllows, letterFields, cleanLine, cleanText, validName, defaultName, itemsOf, flagsOf,
  RATING_DELAY_DEFAULT_DAYS, RATING_SWEEP_MAX, RATING_STALE_QUEUE_MS, parseRatingConfig, ratingRecord, deliveredMs, ratingLetterDecision, ratingSweep, markRatingSkipped, markRatingQueued, markRatingTry, clearRatingTry, ratingNotTaken, ratingLetterStats,
  emptyData, normalizeData, validateRating, findRating, ratingLocked, setRating, validateReview, addReview, publicReviews, decide, ratingStats, adminView, createLimiter, safeId
};
