'use strict';
// tg-alerts.cjs — business alerts for the team's Telegram group: a new order (shop, card import, price request, crypto)
// and a payment received. The rules (which order, when, once) and the message text live here; products-api.cjs loads
// this file, hands in what it knows (is this a test order, is this address one of ours) and sends through the existing
// queue (mail-outbox, kinds tg_order / tg_paid), so a Telegram outage is retried and ends in the dead list like a letter.
// Technical alerts (server, backups, money-import trouble) stay with ops-watch in its own group; nothing here is technical.
// Source of truth: services/tg-alerts/ in biofirst-hosting; install — deploy/INSTALL.md.
//
// Owner's choice (30.09): no name, e-mail, phone or address in the group — the order number, sum, method, country and
// items, plus a link into the CRM, where the rest sits behind a login. Plain text, no parse_mode: nothing needs escaping.
const http = require('http');
const https = require('https');

const TYPES = ['order', 'paid'];
const KIND = { order: 'tg_order', paid: 'tg_paid' };
const KINDS = [KIND.order, KIND.paid];
// Same list as products-api ORDER_PAID_STATUSES (the money Finance Reports counts as received).
const PAID_STATUSES = ['paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered'];
const CANCELLED_RE = /^(cancelled|canceled|refunded|chargeback)$/;
const MODES = ['off', 'on'];
const DEFAULT_BIG_USD = 500;
const CRM_ORDERS_URL = 'https://crm.biolabsresearch.co/crm/orders.html#q=';
const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 5000;
const MAX_TEXT = 4096;

// TG_ALERTS_MODE off|on (nothing = off). on needs a start moment (TG_ALERTS_SINCE: without it the first status change on a
// July order would announce a "payment" from two months ago), the bot token and the group id. A bad value never turns it on.
function parseConfig(env) {
  const e = env || {};
  const problems = [];
  let mode = String(e.TG_ALERTS_MODE || '').trim().toLowerCase() || 'off';
  if (!MODES.includes(mode)) { problems.push('unknown TG_ALERTS_MODE ' + JSON.stringify(mode.slice(0, 20)) + ', alerts are off'); mode = 'off'; }
  const token = String(e.TG_ALERTS_BOT_TOKEN || '').trim();
  const chatId = String(e.TG_ALERTS_CHAT_ID || '').trim();
  let sinceMs = NaN;
  if (mode === 'on') {
    sinceMs = Date.parse(String(e.TG_ALERTS_SINCE || '').trim());
    if (!Number.isFinite(sinceMs)) { problems.push('TG_ALERTS_SINCE missing or not a date, alerts are off'); mode = 'off'; }
    if (!token) { problems.push('TG_ALERTS_BOT_TOKEN missing, alerts are off'); mode = 'off'; }
    if (!chatId) { problems.push('TG_ALERTS_CHAT_ID missing, alerts are off'); mode = 'off'; }
  }
  let bigUsd = DEFAULT_BIG_USD;
  const rawBig = String(e.TG_ALERTS_BIG_USD || '').trim();
  if (rawBig) {
    const n = Number(rawBig);
    if (Number.isFinite(n) && n > 0) bigUsd = n;
    else problems.push('TG_ALERTS_BIG_USD is not a positive number, using ' + DEFAULT_BIG_USD);
  }
  // Topics of the forum group, one per alert type (owner 30.09); none set = the General chat. A bad id is left out, the rest works.
  const topics = {};
  // contact has no General fallback (contactAllowed): a message nobody made a topic for is not announced.
  for (const [type, key] of [['order', 'TG_ALERTS_TOPIC_ORDER'], ['paid', 'TG_ALERTS_TOPIC_PAID'], ['daily', 'TG_ALERTS_TOPIC_DAILY'], ['contact', 'TG_ALERTS_TOPIC_CONTACT']]) {
    const raw = String(e[key] || '').trim();
    if (!raw) continue;
    if (/^[1-9][0-9]{0,9}$/.test(raw)) topics[type] = Number(raw);
    else problems.push(key + ' is not a topic id, that alert goes to General');
  }
  // Our own test recipients (letters and e-mail probes): an order placed from one of them is our check, not a sale.
  const ownAddresses = new Set(['ORDER_LETTERS_TEST_TO', 'EMAIL_TEST_TO'].flatMap(k => String(e[k] || '').split(','))
    .map(a => a.trim().toLowerCase()).filter(Boolean));
  return { mode, sinceMs, token, chatId, bigUsd, topics, ownAddresses, apiBase: API_BASE, problems };
}

function statusOf(order) { return String((order && order.status) || '').trim().toLowerCase(); }
function isPaid(order) { return PAID_STATUSES.includes(statusOf(order)); }
function emailOf(order) {
  const c = order && order.customer;
  return c && typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
}
function createdMs(order) {
  for (const k of ['savedAt', 'created_at', 'timestamp']) {
    const t = Date.parse(order && order[k]);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}
function alertsOf(order) {
  const a = order && order.alerts;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
}
function alreadySent(order, type) {
  const rec = alertsOf(order)[type];
  return !!rec && typeof rec === 'object' && !!rec.sentAt;
}
// Orders the shop or the payment import wrote. A wholesale order typed into the CRM (MS-…) is the team's own news.
function fromShop(order) {
  return order.channel === 'shop' || ['card', 'quote', 'crypto'].includes(order.source);
}

// One answer to "may this alert go now": {ok:true} or {ok:false, reason}. Asked when queueing and again when sending (the
// order may have been cancelled or announced meanwhile). cfg: parseConfig's result plus, from products-api,
// isTestOrder(order) and isExcluded(email) — the marketing exclusion list, which holds our probe addresses.
function alertAllowed(order, type, cfg) {
  const c = cfg || {};
  const no = (reason) => ({ ok: false, reason });
  if (c.mode !== 'on') return no('mode_off');
  if (!TYPES.includes(type)) return no('bad_type');
  if (!order || typeof order !== 'object') return no('no_order');
  const isTest = typeof c.isTestOrder === 'function' ? c.isTestOrder : (o) => o.test === true;
  if (isTest(order)) return no('test_order');
  if (/TEST ORDER/i.test(String(order.notes || ''))) return no('test_note');
  const email = emailOf(order);
  if (email && typeof c.isExcluded === 'function' && c.isExcluded(email)) return no('excluded');
  if (email && c.ownAddresses instanceof Set && c.ownAddresses.has(email)) return no('own_test_address');
  const made = createdMs(order);
  if (!Number.isFinite(made)) return no('no_date');
  if (!(made >= c.sinceMs)) return no('before_since');
  if (alreadySent(order, type)) return no('already_sent');
  if (type === 'order') {
    if (!fromShop(order)) return no('not_shop');
    if (CANCELLED_RE.test(statusOf(order))) return no('cancelled');
    return { ok: true };
  }
  if (!isPaid(order)) return no('not_paid');
  // Not left to a new-order alert still in the queue (it may be skipped or die there, review 30.09): that alert, if it
  // goes out after the payment, marks the payment as announced and this one then answers already_sent.
  return { ok: true };
}
// What one sent alert stands for: a new-order alert for an order that is already paid (a card import) says "paid" itself and
// is its payment alert too — one message, not two (owner 30.09, option B). A payment after that is a reply to it.
function coveredTypes(order, type) {
  return type === 'order' && isPaid(order) ? ['order', 'paid'] : [type];
}
// The mark of a sent alert: when, and where the message is, so a payment can reply to its order's message.
function sentRecord(r, cfg) {
  const rec = { sentAt: new Date().toISOString() };
  if (r && Number.isInteger(r.messageId)) rec.messageId = r.messageId;
  if (cfg && cfg.chatId) rec.chatId = String(cfg.chatId);
  if (r && Number.isInteger(r.topic)) rec.topic = r.topic;
  return rec;
}
// The order's own alert message, if we know it.
function replyTarget(order) {
  const rec = alertsOf(order).order;
  if (!rec || typeof rec !== 'object' || !Number.isInteger(rec.messageId)) return undefined;
  const t = { messageId: rec.messageId, chatId: String(rec.chatId || '') };
  if (Number.isInteger(rec.topic)) t.topic = rec.topic;
  return t;
}
// Records a sent alert on the order; an old order without the field, or with junk in it, starts from an empty one.
function markAlert(order, type, rec) {
  order.alerts = Object.assign({}, alertsOf(order), { [type]: rec });
  return order;
}

// Paid orders of the same address before this one — "a returning customer" for the RET work. Test orders do not count.
function priorPaidCount(order, all, isTestOrder) {
  const email = emailOf(order);
  if (!email || !Array.isArray(all)) return 0;
  const isTest = typeof isTestOrder === 'function' ? isTestOrder : (o) => o.test === true;
  const made = createdMs(order);
  let n = 0;
  for (const o of all) {
    if (!o || typeof o !== 'object' || o === order || o.ref === order.ref) continue;
    if (emailOf(o) !== email || !isPaid(o) || isTest(o)) continue;
    const t = createdMs(o);
    if (Number.isFinite(made) && Number.isFinite(t) && t > made) continue;
    n++;
  }
  return n;
}

// Text from the order is one line, no control characters, no e-mail address, bounded.
function plain(v, max) {
  const s = String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/[^\s@,;]+@[^\s@,;]+/g, '<addr>')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// A card order shows what the provider actually charged; everything else the server's figure (the browser's total only
// when the server has none, and then amountVerified says so).
function amountOf(order) {
  const cc = order && order.source === 'card' && order.charge_check;
  const charged = cc && typeof cc === 'object' ? Number(cc.charged) : NaN;
  if (Number.isFinite(charged) && charged > 0) return charged;
  for (const k of ['total_due_server', 'total_server', 'total']) {
    const n = Number(order && order[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
// The catalog confirmed the prices (anyone can post a shop order with made-up items and totals), and a card charged what was due.
function amountVerified(order) {
  const o = order || {};
  if (o.price_check === 'skipped' || o.price_mismatch === true || (Array.isArray(o.unknown_items) && o.unknown_items.length)) return false;
  if (o.source === 'card' && o.charge_check && typeof o.charge_check === 'object' && o.charge_check.result !== 'match') return false;
  return true;
}
function amountWarning(order) {
  const o = order || {};
  const cc = o.charge_check;
  if (o.source === 'card' && cc && typeof cc === 'object' && cc.result !== 'match') {
    const c = Number(cc.charged), e = Number(cc.expected);
    return '⚠ Card charge ' + plain(cc.result, 12) + ': charged ' + (Number.isFinite(c) ? usd(c) : '?') + ', due ' + (Number.isFinite(e) ? usd(e) : '?');
  }
  return amountVerified(o) ? '' : '⚠ Amount not verified: prices differ from the catalog or items are unknown';
}
function usd(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function hasCryptoProof(order) {
  const pays = order && Array.isArray(order.payments) ? order.payments : [];
  return pays.some(p => p && typeof p === 'object' && p.id === 'crypto:' + order.ref && p.by === 'card-import' && p.kind === 'payment');
}
function methodOf(order) {
  const m = String(order.paymentMethod || '').trim().toLowerCase();
  if (order.source === 'quote' || /^quote/.test(m)) return 'quote';
  if (order.source === 'card' || /^card/.test(m)) return 'card';
  if (order.source === 'crypto' || /crypto/.test(m)) return 'crypto';
  return m;
}
function methodLabel(order) {
  const m = methodOf(order);
  if (m === 'inquiry') return 'no payment yet (inquiry)';
  return plain(m, 30) || 'payment method not set';
}
function itemsLine(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const parts = items.filter(i => i && typeof i === 'object').map(i =>
    plain([plain(i.name, 60), plain(i.mg, 12)].filter(Boolean).join(' '), 80) + ' ×' + (Number(i.qty) || 0));
  return plain(parts.join('; '), 300);
}
function tagLines(order, ctx) {
  const c = ctx || {};
  const out = [];
  if (c.compact) { const w = amountWarning(order); return w ? [w] : []; }   // a reply: the order message above has the rest
  const prior = Number(c.priorPaid) || 0;
  if (prior > 0) out.push('⭐ Returning customer · ' + prior + ' paid order' + (prior === 1 ? '' : 's') + ' before');
  const big = Number(c.bigUsd) > 0 ? Number(c.bigUsd) : DEFAULT_BIG_USD;
  const sum = amountOf(order);
  const warn = amountWarning(order);
  if (warn) out.push(warn);
  else if (sum >= big) out.push('🔥 Big order · ' + usd(sum));
  return out;
}
// The order number as shown and linked: order-number characters only (notify-order takes any text up to 64 characters).
function refOf(order) { return String((order && order.ref) || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || '?'; }
function tail(order, ctx) {
  const ref = refOf(order);
  if (ctx && ctx.compact) return tagLines(order, ctx);
  return tagLines(order, ctx).concat(['CRM: ' + CRM_ORDERS_URL + encodeURIComponent(ref)]);
}
function sumLine(order) {
  const sum = amountOf(order);
  return [sum > 0 ? usd(sum) : 'sum not set', plain(order.shipping && order.shipping.country, 20)].filter(Boolean).join(' · ');
}

// The first line of a new-order alert: icon, what it is, and the state of the money.
function orderHead(o) {
  const ref = refOf(o);
  const m = methodOf(o);
  if (m === 'quote') return { icon: '📝', title: 'Price request ' + ref, status: '' };
  if (m === 'card') return { icon: '💳', title: 'New order ' + ref, status: isPaid(o) ? 'paid by card' : 'card' };
  if (m === 'crypto') return { icon: '🪙', title: 'New order ' + ref, status: isPaid(o) ? (hasCryptoProof(o) ? 'paid in crypto, verified on the chain' : 'crypto, marked paid') : 'crypto, waiting for the transfer' };
  return { icon: '🛒', title: 'New order ' + ref, status: methodLabel(o) };
}
// Who says the money is there: the payment import (card, crypto on the chain) or a manager's status in the CRM.
function paidHow(o) {
  if (o.source === 'card') return 'card payment approved';
  if (hasCryptoProof(o)) return 'crypto, verified on the chain';
  const m = plain(methodOf(o), 30);
  return (m ? m + ' · ' : '') + 'marked ' + plain(statusOf(o), 20) + ' in CRM';
}

// Plain text: the form Telegram shows if it refuses the rich one (see send).
function orderText(order, ctx) {
  const o = order || {};
  const h = orderHead(o);
  const head = h.icon + ' ' + h.title + (h.status ? ' · ' + h.status : '');
  return [head, sumLine(o), itemsLine(o)].filter(Boolean).concat(tail(o, ctx)).join('\n');
}
function paidText(order, ctx) {
  const o = order || {};
  const sum = amountOf(o);
  return ['💰 Payment received · ' + refOf(o) + ' · ' + (sum > 0 ? usd(sum) : 'sum not set'), paidHow(o), ctx && ctx.compact ? '' : itemsLine(o)]
    .filter(Boolean).concat(tail(o, ctx)).join('\n');
}
function textFor(order, type, ctx) { return type === 'order' ? orderText(order, ctx) : paidText(order, ctx); }

// Rich message (Bot API 10.3, sendRichMessage): blocks only, never the html/markdown forms, so text from the order is a
// plain string inside a block and cannot become markup; entity detection is off, so nothing in it turns into a link.
const MAX_ITEM_ROWS = 10;
const HEADING_SIZE = 5;   // 1 is the largest; 3 read too big on a phone (owner 30.09)
function cell(text, align, header) {
  const c = { text, align: align || 'left', valign: 'middle' };
  if (header) c.is_header = true;
  return c;
}
function richFor(order, type, ctx) {
  const o = order || {};
  const ref = refOf(o);
  const sum = amountOf(o);
  const blocks = [];
  if (type === 'order') {
    const h = orderHead(o);
    blocks.push({ type: 'heading', size: HEADING_SIZE, text: [h.icon + ' ', { type: 'bold', text: h.title }] });
    if (h.status) blocks.push({ type: 'paragraph', text: { type: 'italic', text: h.status } });
  } else {
    blocks.push({ type: 'heading', size: HEADING_SIZE, text: ['💰 ', { type: 'bold', text: 'Payment received · ' + ref }] });
    blocks.push({ type: 'paragraph', text: { type: 'italic', text: paidHow(o) } });
  }
  const facts = [[cell('Total'), cell({ type: 'bold', text: sum > 0 ? usd(sum) : 'not set' }, 'right')]];
  if (type === 'order') facts.push([cell('Payment'), cell(methodLabel(o), 'right')]);
  const country = plain(o.shipping && o.shipping.country, 20);
  if (country) facts.push([cell('Country'), cell(country, 'right')]);
  blocks.push({ type: 'table', is_compact: true, is_striped: true, cells: facts });
  const items = (Array.isArray(o.items) ? o.items : []).filter(i => i && typeof i === 'object');
  if (items.length && !(ctx && ctx.compact)) {
    const rows = [[cell('Item', 'left', true), cell('Qty', 'right', true)]];
    for (const i of items.slice(0, MAX_ITEM_ROWS)) rows.push([cell(plain([plain(i.name, 60), plain(i.mg, 12)].filter(Boolean).join(' '), 80) || '—'), cell('×' + (Number(i.qty) || 0), 'right')]);
    if (items.length > MAX_ITEM_ROWS) rows.push([Object.assign(cell('+' + (items.length - MAX_ITEM_ROWS) + ' more'), { colspan: 2 })]);
    blocks.push({ type: 'table', is_compact: true, is_bordered: true, cells: rows });
  }
  for (const t of tagLines(o, ctx)) blocks.push({ type: 'paragraph', text: { type: 'bold', text: t } });
  // A payment reply has no button: the order message it answers has one (owner 30.09).
  if (!(ctx && ctx.compact)) blocks.push({ type: 'buttons', buttons: [{ text: 'Open in CRM', url: CRM_ORDERS_URL + encodeURIComponent(ref), style: 'primary' }] });
  return { blocks, skip_entity_detection: true };
}
// A payment whose order message we know is a reply to it, and short: the order message above carries the items and the tags.
function messageFor(order, type, ctx) {
  const replyTo = type === 'paid' ? replyTarget(order) : undefined;
  const c = replyTo ? Object.assign({}, ctx, { compact: true }) : ctx;
  const msg = { type, text: textFor(order, type, c), rich: richFor(order, type, c) };
  if (replyTo) msg.replyTo = replyTo;
  return msg;
}

// ---- Contact form (30.09, ad readiness): "a new message on the website", once per message, into its own topic ----
// The queue item is {kind: tg_contact, ref: <message id in messages.json>}; the message record goes where an order goes
// (mail-outbox RECORD_KINDS). Mark: message.alerts.contact = {sentAt, messageId...} or {suppressedAt} (over the hourly limit).
// Owner's rule as for orders: no name, e-mail, organisation, subject or text in the group, only when and where to read it.
const CONTACT_KIND = 'tg_contact';
const CONTACT_PER_HOUR = 20;
const CONTACT_REPLY_HOURS = 12;   // the contact page promises "within 12 hours"
const HOUR_MS = 3600 * 1000;
const CRM_MESSAGES_URL = 'https://crm.biolabsresearch.co/crm/store-messages.html';

function contactAllowed(msg, cfg) {
  const c = cfg || {};
  const no = (reason) => ({ ok: false, reason });
  if (c.mode !== 'on') return no('mode_off');
  if (!c.topics || !Number.isInteger(c.topics.contact)) return no('no_topic');
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !msg.id) return no('no_message');
  const email = typeof msg.email === 'string' ? msg.email.trim().toLowerCase() : '';
  if (email && typeof c.isExcluded === 'function' && c.isExcluded(email)) return no('excluded');
  if (email && c.ownAddresses instanceof Set && c.ownAddresses.has(email)) return no('own_test_address');
  const made = Date.parse(msg.receivedAt);
  if (!Number.isFinite(made)) return no('no_date');
  if (!(made >= c.sinceMs)) return no('before_since');
  const rec = alertsOf(msg).contact;
  if (rec && typeof rec === 'object' && (rec.sentAt || rec.suppressedAt)) return no('already_sent');
  return { ok: true };
}
function contactWithin(all, field, nowMs) {
  let n = 0;
  for (const m of Array.isArray(all) ? all : []) {
    if (!m || typeof m !== 'object') continue;
    const rec = alertsOf(m).contact;
    const t = rec && typeof rec === 'object' ? Date.parse(rec[field]) : NaN;
    if (Number.isFinite(t) && t > nowMs - HOUR_MS && t <= nowMs) n++;
  }
  return n;
}
function contactSentLastHour(all, nowMs) { return contactWithin(all, 'sentAt', nowMs); }
function contactSuppressedLastHour(all, nowMs) { return contactWithin(all, 'suppressedAt', nowMs); }
// The message that carries this hour's "+K more" line: the newest suppressed one with a count. Later suppressed messages
// raise its count (and the Telegram message is edited) instead of sending another line.
function contactOverflowHolder(all, nowMs) {
  let best = null, bestAt = -Infinity;
  for (const m of Array.isArray(all) ? all : []) {
    if (!m || typeof m !== 'object') continue;
    const rec = alertsOf(m).contact;
    const t = rec && typeof rec === 'object' ? Date.parse(rec.suppressedAt) : NaN;
    if (Number.isFinite(t) && t > nowMs - HOUR_MS && t <= nowMs && Number.isInteger(rec.count) && rec.count > 0 && t > bestAt) { best = m; bestAt = t; }
  }
  return best;
}
function utcMinute(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
function contactMessage(msg) {
  const made = Date.parse(msg && msg.receivedAt);
  const facts = Number.isFinite(made) ? [['Received', utcMinute(made)], ['Reply promised by', utcMinute(made + CONTACT_REPLY_HOURS * HOUR_MS)]] : [];
  const title = 'New website contact message';
  const blocks = [{ type: 'heading', size: HEADING_SIZE, text: ['✉️ ', { type: 'bold', text: title }] }];
  if (facts.length) blocks.push({ type: 'table', is_compact: true, is_striped: true, cells: facts.map(([k, v]) => [cell(k), cell(v, 'right')]) });
  blocks.push({ type: 'buttons', buttons: [{ text: 'Open Messages in CRM', url: CRM_MESSAGES_URL, style: 'primary' }] });
  const text = ['✉️ ' + title].concat(facts.map(([k, v]) => k + ': ' + v), 'CRM: ' + CRM_MESSAGES_URL).join('\n');
  return { type: 'contact', text, rich: { blocks, skip_entity_detection: true } };
}
// Over the hourly limit: one line for the rest of the hour instead of a message each (a flood of the form must not bury the group).
function contactOverflowMessage(k) {
  const n = Math.max(1, Math.floor(Number(k) || 1));
  const title = '+' + n + ' more contact message' + (n === 1 ? '' : 's');
  const note = 'Alert limit reached (' + CONTACT_PER_HOUR + ' per hour); the rest are not announced here. Open Messages in CRM.';
  return {
    type: 'contact', text: '✉️ ' + title + '\n' + note + '\nCRM: ' + CRM_MESSAGES_URL,
    rich: { blocks: [{ type: 'heading', size: HEADING_SIZE, text: ['✉️ ', { type: 'bold', text: title }] }, { type: 'paragraph', text: note },
      { type: 'buttons', buttons: [{ text: 'Open Messages in CRM', url: CRM_MESSAGES_URL, style: 'primary' }] }], skip_entity_detection: true }
  };
}

function typeForKind(kind) {
  for (const t of TYPES) if (KIND[t] === kind) return t;
  return null;
}
// A ref is client text and can look like an address; log lines never carry one.
function safeRef(ref) {
  return String(ref === undefined || ref === null ? '' : ref).replace(/[^\s@,;]+@[^\s@,;]+/g, '<addr>').replace(/\s+/g, ' ').trim().slice(0, 64);
}

// One Bot API call. cb({ok, status, error, migrate}); the token is part of the URL, so no URL and no raw error goes into
// the result without it cut out.
function post(c, method, payload, cb) {
  let done = false;
  const finish = (r) => { if (!done) { done = true; cb(r); } };
  const scrub = (s) => (c.token ? String(s).split(c.token).join('<token>') : String(s)).slice(0, 200);
  let url;
  try { url = new URL((c.apiBase || API_BASE) + '/bot' + c.token + '/' + method); }
  catch (e) { return finish({ ok: false, status: 'not_built', error: 'bad api address' }); }
  const lib = url.protocol === 'http:' ? http : https;
  const body = JSON.stringify(payload);
  let req;
  try {
    req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (raw.length < 65536) raw += d; });
      res.on('error', e => finish({ ok: false, error: scrub((e && e.message) || e) }));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* not JSON: the status alone decides */ }
        // 200 means Telegram took it, whatever the body: a retry would post the alert twice.
        if (res.statusCode === 200) return finish({ ok: true, status: 200, messageId: json && json.result ? json.result.message_id : undefined });
        const params = (json && json.parameters) || {};
        if (params.migrate_to_chat_id) return finish({ ok: false, status: res.statusCode, migrate: true, error: 'group became a supergroup: set TG_ALERTS_CHAT_ID=' + scrub(params.migrate_to_chat_id) + ' in the env file and restart' });
        finish({ ok: false, status: res.statusCode, error: scrub((json && json.description) || ('HTTP ' + res.statusCode)) });
      });
    });
  } catch (e) { return finish({ ok: false, error: scrub((e && e.message) || e) }); }
  req.on('timeout', () => req.destroy(new Error('no answer in ' + TIMEOUT_MS + ' ms')));
  req.on('error', e => finish({ ok: false, error: scrub((e && e.message) || e) }));
  req.end(body);
}
// msg = messageFor(...), sent to the topic of its type — or, for a reply, next to the message it answers (same chat only: a
// group turned into a supergroup gets a new id, and a message id of the old one means nothing there). allow_sending_without_reply:
// the order message may have been deleted, the payment then goes as a plain message instead of failing (partner-radar W60).
// The rich form first; a 400 on it means Telegram does not accept our layout (a new API rule, a client-side limit), not that the
// group is gone, so the same alert goes as plain text; a 400 on that too, with a topic set, is a topic that was deleted or
// closed: once more to General, without the reply. richRefused says what happened — the caller turns it into a [mail-alert]
// line. 429/5xx/network are left to the queue's retries (401/403 too: bot removed). cb gets the sent message id and topic.
function send(cfg, msg, cb) {
  const c = cfg || {};
  const m = msg || {};
  const reply = m.replyTo && Number.isInteger(m.replyTo.messageId) && String(m.replyTo.chatId) === String(c.chatId) ? m.replyTo : null;
  const typeTopic = c.topics && m.type && Object.prototype.hasOwnProperty.call(c.topics, m.type) ? c.topics[m.type] : null;
  const topic = reply ? (Number.isInteger(reply.topic) ? reply.topic : null) : typeTopic;
  const where = (payload, inPlace) => Object.assign({ chat_id: c.chatId },
    inPlace && topic ? { message_thread_id: topic } : {},
    inPlace && reply ? { reply_parameters: { message_id: reply.messageId, allow_sending_without_reply: true } } : {}, payload);
  const done = (r, usedTopic, note) => cb(Object.assign({ ok: true, status: 200, messageId: r.messageId, topic: usedTopic }, note ? { richRefused: note } : {}));
  const plainText = { text: String(m.text || '').slice(0, MAX_TEXT), link_preview_options: { is_disabled: true } };
  post(c, 'sendRichMessage', where({ rich_message: m.rich }, true), r => {
    if (r.ok) return done(r, topic);
    if (r.status !== 400 || r.migrate) return cb({ ok: false, status: r.status, error: r.error });
    post(c, 'sendMessage', where(plainText, true), p => {
      if (p.ok) return done(p, topic, r.error);
      if (p.status !== 400 || p.migrate || !topic) return cb({ ok: false, status: p.status, error: p.error });
      post(c, 'sendMessage', where(plainText, false), g => {
        if (g.ok) return done(g, null, 'topic ' + topic + ' refused (' + p.error + '), sent as plain text to General');
        cb({ ok: false, status: g.status, error: g.error });
      });
    });
  });
}

module.exports = {
  TYPES, KIND, KINDS, PAID_STATUSES, CRM_ORDERS_URL,
  parseConfig, alertAllowed, coveredTypes, sentRecord, markAlert, alreadySent, priorPaidCount,
  orderText, paidText, textFor, richFor, messageFor, typeForKind, safeRef, send,
  post,   // tg-stock edits and pins its table with it
  CONTACT_KIND, CONTACT_PER_HOUR, CRM_MESSAGES_URL,
  contactAllowed, contactMessage, contactOverflowMessage, contactSentLastHour, contactSuppressedLastHour, contactOverflowHolder
};
