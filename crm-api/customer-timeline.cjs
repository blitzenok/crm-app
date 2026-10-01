/**
 * customer-timeline.cjs (2026-09-30) - one read-only customer timeline across both order books.
 *
 *   GET /api/customers            list of customers (merged by lower-cased, trimmed e-mail)
 *        ?q=<text>                 filter on e-mail / name / company
 *        ?qa=1                     include QA/test customers and QA/test rows (hidden by default)
 *   GET /api/customers/:email     one customer: summary + chronological event list (?qa=1 as above)
 *
 * Mounted in server_v14.cjs behind requireAuth (CRM staff session) - the data is PII.
 * READ ONLY: every source is read with fs.readFileSync; nothing here writes, renames or migrates a source file.
 * Sources:
 *   orders.json / messages.json   products-api (/var/www/mastersol/html/MSOLPEPTIDES)
 *   store.json                    crm-umg (quotes, orders = card orders, abandoned_checkouts)
 *   consent-log.jsonl             crm-umg consent log
 *   leads.json                    this server (data/leads.json)
 * Card data never leaves this module: a card order carries processor, status and attempt count only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

module.exports = function customerTimeline(opts) {
  opts = opts || {};
  const SHOP_DIR = opts.shopDir || '/var/www/mastersol/html/MSOLPEPTIDES';
  const UMG_DIR = opts.umgDir || '/var/lib/crm-umg';
  const DATA_DIR = opts.dataDir || path.join(__dirname, 'data');
  const FILES = {
    orders: path.join(SHOP_DIR, 'orders.json'),
    messages: path.join(SHOP_DIR, 'messages.json'),
    store: path.join(UMG_DIR, 'store.json'),
    consent: path.join(UMG_DIR, 'consent-log.jsonl'),
    leads: path.join(DATA_DIR, 'leads.json')
  };
  // Same set as orders-model.js PAID_GROUPS (products-api ORDER_PAID_STATUSES).
  const SHOP_PAID = ['paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered'];
  const UMG_PAID = ['approved', 'paid', 'captured', 'settled'];
  const MAX_AMOUNT = 1e9;

  const text = v => typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const arr = v => Array.isArray(v) ? v : [];
  const keyOf = e => text(e).toLowerCase();
  function num(v) {
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= MAX_AMOUNT ? Math.round(n * 100) / 100 : null;
  }
  function iso(...vals) {
    for (const v of vals) { const s = text(v); if (s && !Number.isNaN(Date.parse(s))) return new Date(Date.parse(s)).toISOString(); }
    return null;
  }
  // QA/test addresses. The brief: qa-test*, qa-*, *@example.com. Added on top (2026-09-30, same data):
  //  - qa followed by + . _ @ (qa+probe@, qa@...), and a qa/softqa/probe/smoke/dry-run/test token in the local part
  //  - the rule the CRM Orders page already applies (orders-model.js isTestAddress: example.* / test.com / .invalid /
  //    localhost domains, smoke-/probe-/qa.test prefixes, admin@biolabsresearch.co) - "rows already marked QA"
  //  - internal welcome-mail test aliases (admin+..., insider-welcome-...@biolabsresearch.co) and malformed addresses.
  const TEST_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.co', 'test.com', 'test', 'invalid', 'localhost'];
  const TEST_LOCAL_PREFIXES = ['smoke-', 'checkout-smoke', 'merge-smoke', 'vip-smoke', 'coupon-only', 'qa-cart', 'qa.test', 'qa-test',
    'probe-', 'probe.', 'probe_', 'render-check', 'text-check'];
  function isQaEmail(email) {
    const addr = keyOf(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return true;              // malformed ("x@y.com or 1=1")
    if (/^qa-test|^qa-|@example\.com$/.test(addr)) return true;               // the brief
    const at = addr.lastIndexOf('@'), local = addr.slice(0, at), domain = addr.slice(at + 1);
    if (/^qa([+._-]|$)/.test(local)) return true;
    if (/(^|[+._-])(qa|softqa|probe|smoke|dry-run|dryrun|test)([+._\d-]|$)/.test(local)) return true;
    if (addr === 'admin@biolabsresearch.co') return true;
    if (TEST_DOMAINS.some(d => domain === d || domain.endsWith('.' + d)) || TEST_LOCAL_PREFIXES.some(p => local.startsWith(p))) return true;
    if (domain === 'biolabsresearch.co' && /^(admin\+|insider-welcome-)/.test(local)) return true;
    return false;
  }
  function qaMarked(raw) {
    raw = obj(raw);
    return raw.test === true || raw.qa === true || raw.isTest === true || raw.dryRun === true
      || /^qa[-_]/i.test(text(raw.idempotencyKey)) || /^qa[-_]/i.test(text(raw.session_id));
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  }
  function readJsonl(file) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    return raw.split('\n').map((l, i) => { try { return l.trim() ? { line: i + 1, rec: JSON.parse(l) } : null; } catch (e) { return null; } }).filter(Boolean);
  }
  function mtimes() {
    return Object.values(FILES).map(f => { try { const s = fs.statSync(f); return s.mtimeMs + ':' + s.size; } catch (e) { return 'x'; } }).join('|');
  }

  function umgItems(items) {
    return arr(items).filter(i => i && typeof i === 'object').map(i => ({ sku: text(i.sku) || null, name: text(i.name), qty: num(i.qty) || 1 }));
  }
  function shopItems(items) {
    return arr(items).filter(i => i && typeof i === 'object').map(i => {
      const slug = text(i.slug), mg = text(i.mg) || text(i.strength);
      return { sku: text(i.sku) || (slug ? (mg ? slug + '-' + mg : slug) : null), name: (text(i.name) || slug) + (mg ? ' ' + mg : ''), qty: num(i.qty) || 1 };
    });
  }
  function nameOf(c) {
    c = obj(c);
    return ((text(c.firstName) || text(c.first_name)) + ' ' + (text(c.lastName) || text(c.last_name))).trim();
  }

  // Builds every event from the sources; returns { byEmail: Map(email -> {events, profile}), unkeyed }.
  function build() {
    const byEmail = new Map();
    let unkeyed = 0;
    function add(email, ev, profile) {
      const k = keyOf(email);
      if (!k || k.indexOf('@') <= 0) { unkeyed++; return; }
      let c = byEmail.get(k);
      if (!c) { c = { email: k, events: [], profile: {} }; byEmail.set(k, c); }
      ev.qa = !!ev.qa || isQaEmail(k);
      c.events.push(ev);
      profile = obj(profile);
      for (const f of ['name', 'company', 'country']) if (text(profile[f]) && (!c.profile[f] || (ev.date && ev.date >= (c.profile[f + 'At'] || '')))) { c.profile[f] = text(profile[f]); c.profile[f + 'At'] = ev.date || ''; }
    }

    // 1. shop / ops orders (products-api orders.json)
    arr(readJson(FILES.orders, [])).forEach((o, idx) => {
      if (!o || typeof o !== 'object') return;
      const cust = obj(o.customer), ship = obj(o.shipping);
      const email = text(cust.email) || text(o.email);
      const ref = text(o.ref) || text(o.id);
      const pm = text(o.paymentMethod);
      let type = 'shop_order';
      if (o.type === 'insider-signup' || (!ref && !arr(o.items).length)) type = 'signup';
      else if (text(o.source) === 'quote' || pm === 'quote-request' || pm === 'quote') type = 'shop_quote';
      const status = text(o.status).toLowerCase();
      const amount = type === 'signup' ? null : [num(o.total_due_server), num(o.total_server), num(o.total)].find(v => v !== null && v >= 0);
      add(email, {
        type, date: iso(o.savedAt, o.timestamp, o.created_at, o.date, o.createdAt), ref: ref || null,
        amount: amount === undefined ? null : amount, currency: 'USD', status: status || null,
        paid: type === 'shop_order' && SHOP_PAID.includes(status), processor: pm || null,
        items: shopItems(o.items), linkedRef: text(o.source_ref) || null,
        book: 'shop', source: { file: 'orders.json', id: ref || ('#' + idx) }, qa: qaMarked(o)
      }, { name: nameOf(cust) || nameOf(o), company: text(cust.company) || text(o.company), country: text(ship.country) || text(o.country) });
    });

    // 2. contact messages (products-api messages.json)
    arr(readJson(FILES.messages, [])).forEach((m, idx) => {
      if (!m || typeof m !== 'object') return;
      add(m.email, {
        type: 'contact_message', date: iso(m.receivedAt), ref: null, amount: null, currency: null,
        status: text(m.status) || null, paid: false, processor: null, items: [], subject: text(m.subject).slice(0, 120) || null,
        book: 'shop', source: { file: 'messages.json', id: text(m.id) || ('#' + idx) }, qa: qaMarked(m)
      }, { name: nameOf(m), company: text(m.org) });
    });

    // 3. crm-umg store.json
    const store = obj(readJson(FILES.store, {}));
    arr(store.quotes).forEach((q, idx) => {
      if (!q || typeof q !== 'object') return;
      const cust = obj(q.customer);
      add(cust.email, {
        type: 'umg_quote', date: iso(q.createdAt), ref: text(q.id) || null, amount: num(q.amount), currency: text(q.currency) || 'USD',
        status: text(q.status) || null, crmStatus: text(q.crmStatus) || null, paid: false, processor: null, items: umgItems(q.items),
        book: 'umg', source: { file: 'store.json', id: 'quotes/' + (text(q.id) || idx) }, qa: qaMarked(q)
      }, { name: nameOf(cust), country: text(cust.country) });
    });
    arr(store.orders).forEach((o, idx) => {
      if (!o || typeof o !== 'object') return;
      const cust = obj(o.customer), status = text(o.status).toLowerCase();
      add(cust.email, {
        type: 'card_order', date: iso(o.createdAt), ref: text(o.id) || null, amount: num(o.amount), currency: text(o.currency) || 'USD',
        status: status || null, paid: UMG_PAID.includes(status),
        processor: text(o.winningProcessor) || text(o.lastProcessor) || text(o.paymentProcessor) || null,
        attempts: arr(o.attempts).length, items: umgItems(o.items),
        book: 'umg', source: { file: 'store.json', id: 'orders/' + (text(o.id) || idx) }, qa: qaMarked(o)
      }, { name: nameOf(cust), country: text(cust.country) });
    });
    const ab = store.abandoned_checkouts;
    const abList = Array.isArray(ab) ? ab.map((v, i) => [String(i), v]) : Object.entries(obj(ab));
    abList.forEach(([sid, a]) => {
      if (!a || typeof a !== 'object') return;
      const cust = obj(a.customer);
      add(cust.email, {
        type: 'abandoned_checkout', date: iso(a.first_seen, a.seen_at, a.last_seen), lastSeen: iso(a.last_seen, a.seen_at),
        ref: text(a.converted_id) || null, amount: num(a.subtotal), currency: 'USD',
        status: [text(a.status), text(a.stage)].filter(Boolean).join(' / ') || null, paid: false, processor: text(a.converted_via) || null,
        items: umgItems(a.items), book: 'umg', source: { file: 'store.json', id: 'abandoned_checkouts/' + (text(a.session_id) || sid) }, qa: qaMarked(a)
      }, { name: nameOf(cust), country: text(cust.country) });
    });

    // 4. consent log (crm-umg consent-log.jsonl) - no IP / user agent / hash in the output
    readJsonl(FILES.consent).forEach(({ line, rec }) => {
      const r = obj(rec);
      add(r.email, {
        type: 'consent', date: iso(r.receivedAt), ref: text(r.orderId) || null, amount: num(r.amount), currency: text(r.currency) || null,
        status: r.missing ? 'missing' : 'recorded', paid: false, processor: text(r.channel) || null, items: [],
        book: 'umg', source: { file: 'consent-log.jsonl', id: 'line ' + line }, qa: qaMarked(r) || /QA/i.test(text(r.userAgent))
      });
    });

    // 5. leads (this server, data/leads.json)
    arr(readJson(FILES.leads, [])).forEach((l, idx) => {
      if (!l || typeof l !== 'object') return;
      add(l.email, {
        type: 'lead', date: iso(l.created_at), ref: null, amount: null, currency: null, status: text(l.status) || null, paid: false,
        processor: null, items: [], coupon: text(l.coupon) || null,
        book: 'leads', source: { file: 'leads.json', id: text(l.id) || ('#' + idx) }, qa: qaMarked(l)
      }, { company: text(l.company), country: text(l.country) });
    });

    for (const c of byEmail.values()) c.events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return { byEmail, unkeyed };
  }

  let cache = { stamp: '', data: null };
  function data() {
    const stamp = mtimes();
    if (!cache.data || cache.stamp !== stamp) cache = { stamp, data: build() };
    return cache.data;
  }

  // Summary over the events that are visible (QA rows dropped unless showQa or the customer is QA itself).
  function summarize(c, showQa) {
    const custQa = isQaEmail(c.email) || c.events.every(e => e.qa);
    const events = showQa || custQa ? c.events : c.events.filter(e => !e.qa);
    // One order is one ref: a card order that products-api mirrored into orders.json is counted once.
    const orders = new Map();
    const quoteRefs = new Set(); // paid price-request records (not part of "orders": that field keeps its meaning)
    for (const e of events) {
      if (e.type === 'shop_quote' && !e.qa && SHOP_PAID.includes(e.status)) quoteRefs.add(e.linkedRef || e.ref || (e.source.file + ':' + e.source.id));
      if (e.type !== 'shop_order' && e.type !== 'card_order') continue;
      const k = e.linkedRef || e.ref || (e.source.file + ':' + e.source.id);
      const o = orders.get(k) || { umgPaid: null, shopPaid: null, cancelled: false, active: false, qa: false };
      if (e.type === 'card_order' && e.paid) o.umgPaid = e.amount || 0;
      if (e.type === 'shop_order' && e.paid) o.shopPaid = e.amount || 0;
      if (e.type === 'shop_order' && e.status === 'cancelled') o.cancelled = true; // cancelled in the shop book: not revenue
      // activeOrders: a shop record that is not cancelled, or a card order that was paid (a declined or open attempt is not an order)
      if (e.qa) o.qa = true;
      if ((e.type === 'shop_order' && e.status !== 'cancelled') || (e.type === 'card_order' && (e.paid || e.status === 'refunded' || e.status === 'chargeback'))) o.active = true;
      orders.set(k, o);
    }
    let revenue = 0, paidOrders = 0;
    for (const o of orders.values()) {
      const v = o.cancelled ? null : (o.umgPaid !== null ? o.umgPaid : o.shopPaid);
      if (v !== null) { paidOrders++; revenue += v; }
    }
    // Same test refs as orders-model.js TEST_REF; QA e-mails and rows already marked QA are o.qa.
    // A paid quote and its mirror share a key (source_ref), so the set counts them once; cancelled / QA in the shop book wins.
    const activeRefs = new Set(quoteRefs);
    for (const [k, o] of orders) if (o.active) activeRefs.add(k);
    let activeOrders = 0;
    for (const k of activeRefs) {
      const o = orders.get(k);
      if ((!o || (!o.cancelled && !o.qa)) && !/^(PROBE|BF-SMOKE|BF-MERGE|BF-CIO-TEST|BF-RENDER|BF-TEXT|BF-QA)/i.test(k)) activeOrders++;
    }
    const books = [...new Set(events.map(e => e.book))];
    const types = {};
    events.forEach(e => { types[e.type] = (types[e.type] || 0) + 1; });
    const dates = events.map(e => e.date).filter(Boolean);
    return {
      summary: {
        email: c.email, name: c.profile.name || null, company: c.profile.company || null, country: c.profile.country || null,
        qa: custQa, books, inBothBooks: books.includes('shop') && books.includes('umg') && events.some(e => e.source.file === 'orders.json') && events.some(e => e.source.file === 'store.json'),
        eventCount: events.length, orders: orders.size, activeOrders, paidOrders, paidRevenue: Math.round(revenue * 100) / 100,
        firstSeen: dates.length ? dates[0] : null, lastSeen: dates.length ? dates[dates.length - 1] : null, types,
        hiddenQaEvents: c.events.length - events.length
      },
      events
    };
  }

  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/', (req, res) => {
    const showQa = req.query.qa === '1' || req.query.qa === 'true';
    const q = text(req.query.q).toLowerCase().slice(0, 100);
    const { byEmail, unkeyed } = data();
    const all = [...byEmail.values()].map(c => summarize(c, showQa).summary);
    const real = all.filter(s => !s.qa);
    let list = showQa ? all : real;
    if (q) list = list.filter(s => [s.email, s.name, s.company].some(v => v && v.toLowerCase().includes(q)));
    list.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    const scope = showQa ? all : real;
    res.json({
      customers: list,
      meta: {
        total: all.length, real: real.length, qa: all.length - real.length, shown: list.length, showQa,
        inBothBooks: scope.filter(s => s.inBothBooks).length,
        events: scope.reduce((n, s) => n + s.eventCount, 0),
        orders: scope.reduce((n, s) => n + s.orders, 0),
        paidRevenue: Math.round(scope.reduce((n, s) => n + s.paidRevenue, 0) * 100) / 100,
        rowsWithoutEmail: unkeyed, generatedAt: new Date().toISOString()
      }
    });
  });

  router.get('/:email', (req, res) => {
    const showQa = req.query.qa === '1' || req.query.qa === 'true';
    const k = keyOf(req.params.email);
    const c = data().byEmail.get(k);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const { summary, events } = summarize(c, showQa);
    res.json({ customer: summary, events });
  });

  router._build = build; // for local tests
  router._summarize = summarize;
  return router;
};
