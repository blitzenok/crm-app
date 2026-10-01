'use strict';
// order-letters.cjs — the rules for the letters the buyer gets about an order: which letter a status means, who may
// get it, what data goes into its Customer.io template. No input or output here: products-api.cjs loads this file,
// hands in what it knows (is this a test order, is this address one of ours) and does the sending through the
// existing queue (mail-outbox) and cioSendEmail. The TEXT of every letter lives in a Customer.io transactional
// template that the team edits from the CRM Emails page; this module only decides whether, when and with which
// fields. Source of truth: services/order-letters/ in biofirst-hosting; install — deploy/INSTALL.md.
//
// The template fields are the contract of stage 1 (.scratch/stage1-order-letters-2026-09-30/contract.md): a field that
// is not listed there is not sent, and a template that reads one that is not listed there renders it empty.

// rating (2026-10-02, services/reviews): "How was your order?", a letter of its own some days after delivery. No status means it (it is not in
// STATUS_TYPE): products-api queues it from an hourly pass, and the rules of services/reviews/reviews.cjs decide whether the order is due.
const TYPES = ['confirmation', 'paid', 'shipped', 'in_transit', 'delivered', 'rating'];
// confirmation keeps the queue kind it always had (mail_customer); the status letters and the rating letter have kinds of their own.
const KIND = { confirmation: 'mail_customer', paid: 'letter_paid', shipped: 'letter_shipped', in_transit: 'letter_in_transit', delivered: 'letter_delivered', rating: 'letter_rating' };
const LETTER_KINDS = ['letter_paid', 'letter_shipped', 'letter_in_transit', 'letter_delivered', 'letter_rating'];
const ENV_ID = { confirmation: 'CIO_ORDER_CUSTOMER_MSG_ID', paid: 'CIO_LETTER_PAID_MSG_ID', shipped: 'CIO_LETTER_SHIPPED_MSG_ID', in_transit: 'CIO_LETTER_IN_TRANSIT_MSG_ID', delivered: 'CIO_LETTER_DELIVERED_MSG_ID', rating: 'CIO_LETTER_RATING_MSG_ID' };
// Lookup tables are looked up by own keys only: a status such as "constructor" must not reach Object.prototype.
const STATUS_TYPE = Object.assign(Object.create(null), { 'paid': 'paid', 'payment-confirmed': 'paid', 'shipped': 'shipped', 'in-transit': 'in_transit', 'delivered': 'delivered' });
// Same list as products-api ORDER_PAID_STATUSES after this stage (in-transit counts as money received, like shipped).
const PAID_STATUSES = ['paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered'];
const NO_MAIL_STATUS_RE = /^(cancelled|canceled|refunded|chargeback)$/;
const CARRIERS = ['FedEx', 'USPS', 'UPS', 'DHL', 'Other'];
// Tracking links are built from this list and a plain number only; there is no free URL a manager could type in.
const TRACK_URL = { FedEx: 'https://www.fedex.com/fedextrack/?trknbr=', USPS: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=', UPS: 'https://www.ups.com/track?tracknum=', DHL: 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html?tracking-id=' };
const TRACKING_RE = /^[A-Za-z0-9-]{3,60}$/;
const MODES = ['off', 'test', 'on'];

// The same scrub products-api uses on everything that leaves for Customer.io (Liquid does not escape). products-api
// passes its own function in; this copy is the default for tests, and a contract test pins the two to the same output.
function defaultMailSafe(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .replace(/\b(javascript|vbscript)\s*:+/gi, '$1 ')
    .replace(/\bdata\s*:+\s*text\/html/gi, 'data text/html')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .trim();
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function defaultLooksLikeEmail(v) { return typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v.trim()); }

function statusOf(order) { return String((order && order.status) || '').trim().toLowerCase(); }
function letterTypeForStatus(status) {
  const s = String(status === undefined || status === null ? '' : status).trim().toLowerCase();
  return STATUS_TYPE[s] || null;
}
function kindForType(type) { return Object.prototype.hasOwnProperty.call(KIND, type) ? KIND[type] : null; }
function typeForKind(kind) {
  for (const t of TYPES) if (KIND[t] === kind) return t;
  return null;
}

// paid only for a record the payment import wrote (source 'card') that the CRM has as paid: the words "we have received your card
// payment" must be true. The status alone is not enough: a manager sets paid on a crypto or wire order too, and the deferred
// confirmation of such an order would otherwise claim a card payment. A payment-method string sent by a page never counts:
// anyone who knows an address could otherwise send that person "your payment is received". Everything else that is not waiting
// for a crypto transfer is "pending" (the neutral "our team will review your order" text).
function paymentState(order) {
  if (!order || typeof order !== 'object') return 'pending';
  const paidStatus = PAID_STATUSES.includes(statusOf(order));
  if (order.source === 'card' && paidStatus) return 'paid';
  if (!paidStatus && /^crypto-/i.test(String(order.paymentMethod || '').trim())) return statusOf(order) === 'cancelled' ? 'pending' : 'crypto_pending';
  return 'pending';
}
function paidVia(order) {
  if (order && order.source === 'card') return 'card';
  if (order && /^crypto/i.test(String(order.paymentMethod || '').trim())) return 'crypto';
  return 'other';
}

// The booking card-import.cjs writes when the payment module verified a crypto transfer. Its id has a colon, which no
// route of products-api accepts in a payment id (POST /orders/:ref/payments takes [A-Za-z0-9._-] only, notify-order and
// POST /orders drop the payments field), so nobody but the import can write it.
function hasCryptoProof(order) {
  const pays = order && Array.isArray(order.payments) ? order.payments : [];
  return pays.some(p => p && typeof p === 'object' && p.id === 'crypto:' + order.ref && p.by === 'card-import' && p.kind === 'payment');
}

function canonicalCarrier(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  return CARRIERS.find(c => c.toLowerCase() === s) || '';
}
function trackingUrl(carrier, number) {
  const c = canonicalCarrier(carrier);
  if (!c || !Object.prototype.hasOwnProperty.call(TRACK_URL, c)) return '';
  const n = String(number === undefined || number === null ? '' : number).replace(/\s+/g, '');
  if (!TRACKING_RE.test(n)) return '';
  return TRACK_URL[c] + encodeURIComponent(n);
}
// PATCH /orders/:ref: a manager cannot move an order to shipped or in-transit without a number the buyer can follow.
// The number in the request wins over the stored one, so clearing it in the same request is refused too.
function trackingProblem(status, update, order) {
  const s = String(status === undefined || status === null ? '' : status).trim().toLowerCase();
  if (s !== 'shipped' && s !== 'in-transit') return '';
  const body = update && typeof update === 'object' ? update : {};
  const stored = order && typeof order === 'object' ? order : {};
  const number = body.trackingNumber !== undefined ? body.trackingNumber : stored.trackingNumber;
  return String(number === undefined || number === null ? '' : number).trim() ? '' : 'tracking number required';
}

// ORDER_LETTERS_MODE off|test|on (nothing = off). test and on need ORDER_LETTERS_SINCE: without a moment to count from,
// the first status change on a July order would write to a person who never asked. A bad value never turns letters on.
function parseConfig(env) {
  const e = env || {};
  const problems = [];
  let mode = String(e.ORDER_LETTERS_MODE || '').trim().toLowerCase();
  if (!mode) mode = 'off';
  if (!MODES.includes(mode)) { problems.push('unknown ORDER_LETTERS_MODE ' + JSON.stringify(mode.slice(0, 20)) + ', letters are off'); mode = 'off'; }
  let sinceMs = NaN;
  if (mode !== 'off') {
    sinceMs = Date.parse(String(e.ORDER_LETTERS_SINCE || '').trim());
    if (!Number.isFinite(sinceMs)) { problems.push('ORDER_LETTERS_SINCE missing or not a date, letters are off'); mode = 'off'; }
  }
  const testTo = new Set(String(e.ORDER_LETTERS_TEST_TO || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
  if (mode === 'test' && !testTo.size) problems.push('ORDER_LETTERS_TEST_TO is empty, no letter will be sent in test mode');
  return { mode, sinceMs, testTo, problems };
}
function templateIds(env, procEnv) {
  const e = env || {}, p = procEnv || {};
  const ids = {}, missing = [];
  for (const t of TYPES) {
    ids[t] = String(e[ENV_ID[t]] || p[ENV_ID[t]] || '').trim();
    if (!ids[t]) missing.push(t);
  }
  return { ids, missing };
}

function lettersOf(order) {
  const l = order && order.letters;
  return l && typeof l === 'object' && !Array.isArray(l) ? l : {};
}
function alreadySent(order, type) {
  const rec = lettersOf(order)[type];
  return !!rec && typeof rec === 'object' && !!rec.sentAt;
}
function createdMs(order) {
  for (const k of ['savedAt', 'created_at', 'timestamp']) {
    const t = Date.parse(order && order[k]);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}
// Test mode: is this order's address one of ORDER_LETTERS_TEST_TO? (products-api sends everyone else the old letter.)
function recipientListed(order, cfg) {
  const email = order && order.customer && typeof order.customer.email === 'string' ? order.customer.email.trim().toLowerCase() : '';
  return !!email && !!cfg && !!cfg.testTo && cfg.testTo.has(email);
}
// One answer to "may this order get this letter now": {ok:true} or {ok:false, reason}. cfg: mode, sinceMs, testTo (a Set
// of lower-case addresses) and, from products-api, isTestOrder(order), isExcluded(email), looksLikeEmail(v).
function letterAllowed(order, type, cfg) {
  const c = cfg || {};
  const no = (reason) => ({ ok: false, reason });
  if (c.mode !== 'test' && c.mode !== 'on') return no('mode_off');
  if (!TYPES.includes(type)) return no('bad_type');
  if (!order || typeof order !== 'object') return no('no_order');
  const isTest = typeof c.isTestOrder === 'function' ? c.isTestOrder : (o) => o.test === true;
  if (isTest(order)) return no('test_order');
  if (/TEST ORDER/i.test(String(order.notes || ''))) return no('test_note');
  const email = order.customer && typeof order.customer.email === 'string' ? order.customer.email.trim() : '';
  if (!(typeof c.looksLikeEmail === 'function' ? c.looksLikeEmail : defaultLooksLikeEmail)(email)) return no('no_email');
  // An address listed in ORDER_LETTERS_TEST_TO is one the operator chose on purpose: in test mode it is not "excluded"
  // (the exclusion list holds our own probe addresses, which are exactly what a live check is sent to).
  const listedForTest = c.mode === 'test' && !!c.testTo && c.testTo.has(email.toLowerCase());
  if (!listedForTest && typeof c.isExcluded === 'function' && c.isExcluded(email)) return no('excluded');
  const made = createdMs(order);
  if (!Number.isFinite(made)) return no('no_date');
  if (!(made >= c.sinceMs)) return no('before_since');
  // Only what the shop or the payment import wrote: a wholesale order typed into the CRM (MS-…) or a price request
  // has a customer address on it, but nobody asked that person for a letter. The shop marks its orders itself.
  if (order.source !== 'card' && order.channel !== 'shop') return no('not_shop');
  if (NO_MAIL_STATUS_RE.test(statusOf(order))) return no('cancelled');
  if (alreadySent(order, type)) return no('already_sent');
  if (type === 'paid' && order.source === 'card') return no('covered_by_confirmation');   // the card confirmation already says paid
  // While the crypto import runs, "confirmed on the blockchain" must be true: only the payment import writes crypto:<ref> (card-import.cjs), and only for a
  // transfer the payment module verified on the chain. A manager's status change alone (or any route) never makes this letter.
  // Only where the import is running (cfg.requireCryptoProof, set by products-api while CRYPTO_IMPORT_MODE is on): with the import
  // off or in dry nobody would ever book the payment, so a manager's paid keeps sending the letter as it did before.
  if (type === 'paid' && c.requireCryptoProof === true && paidVia(order) === 'crypto' && !hasCryptoProof(order)) return no('crypto_not_verified');
  if ((type === 'shipped' || type === 'in_transit') && !String(order.trackingNumber || '').trim()) return no('no_tracking');
  if (c.mode === 'test' && !(c.testTo && c.testTo.has(email.toLowerCase()))) return no('not_test_recipient');
  return { ok: true };
}

function money2(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}
// The fields of message_data for one letter: the contract, nothing else. Everything typed by the buyer goes through
// mailSafe; the money is the server's own figure (total_due_server), never the browser's.
function letterData(order, type, opts) {
  if (!TYPES.includes(type)) throw new Error('unknown letter type');
  const txt = (opts && typeof opts.mailSafe === 'function') ? opts.mailSafe : defaultMailSafe;
  const o = order || {};
  const c = o.customer || {}, s = o.shipping || {};
  // The rating letter reads three fields: the number, the name and (added by products-api, services/reviews) review_url. No money, address or tracking.
  if (type === 'rating') return { ref: txt(o.ref), first_name: txt(c.firstName) };
  const cityLine = [s.city, s.state, s.zip].map(txt).filter(Boolean).join(' ');
  const totalsAvailable = o.price_check !== 'skipped' && o.subtotal_server !== undefined;
  const data = {
    ref: txt(o.ref),
    first_name: txt(c.firstName),
    status: txt(o.status),
    payment_state: paymentState(o),
    paid_via: paidVia(o),
    totals_available: totalsAvailable,
    total_due_server: totalsAvailable ? money2(o.total_due_server) : '',
    shipping_address: [s.address1, s.address2, cityLine, s.country].map(txt).filter(Boolean).join(', '),
    shipping_method: txt(s.label) || txt(s.method)
  };
  if (type === 'confirmation') {
    data.items = (Array.isArray(o.items) ? o.items : []).map(i => ({
      name: txt(i && i.name), mg: txt(i && i.mg), qty: Number(i && i.qty) || 0, price: money2(i && i.price)
    }));
    // Server figures as the letter has always had them (tx 3 compares discount_server with "0.00" as text).
    for (const k of ['subtotal_server', 'discount_server', 'discount_pct_server']) {
      if (o[k] !== undefined) data[k] = o[k];
    }
    if (o.discount_source !== undefined) data.discount_source = txt(o.discount_source);
    if (o.subtotal_server !== undefined && o.total_server !== undefined) {
      data.shipping_server = ((Math.round(Number(o.total_server) * 100) - Math.round(Number(o.subtotal_server) * 100)) / 100).toFixed(2);
    }
  } else if (type !== 'paid') {
    const carrier = canonicalCarrier(o.carrier) || 'Other';
    const number = String(o.trackingNumber === undefined || o.trackingNumber === null ? '' : o.trackingNumber).trim();
    data.carrier = carrier;
    data.tracking_number = txt(number);
    data.tracking_url = trackingUrl(carrier, number);
  }
  return data;
}

// Records that a letter went out (or is covered by another) on the order object; an old order without the field, or
// with junk in it, starts from an empty one. The caller writes the file.
function markLetter(order, type, rec) {
  order.letters = Object.assign({}, lettersOf(order), { [type]: rec });
  return order;
}

// A ref is client text and can look like an address; log lines and alerts never carry an address.
function safeRef(ref) {
  return String(ref === undefined || ref === null ? '' : ref).replace(/[^\s@,;]+@[^\s@,;]+/g, '<addr>').replace(/\s+/g, ' ').trim().slice(0, 64);
}

module.exports = {
  TYPES, KIND, LETTER_KINDS, ENV_ID, PAID_STATUSES, CARRIERS, TRACK_URL,
  letterTypeForStatus, kindForType, typeForKind, paymentState, paidVia, hasCryptoProof, canonicalCarrier, trackingUrl, trackingProblem,
  parseConfig, templateIds, letterAllowed, recipientListed, letterData, markLetter, safeRef, alreadySent, defaultMailSafe
};
