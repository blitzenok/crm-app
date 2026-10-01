'use strict';
// activeOrders in customer-timeline.cjs: the module is loaded with a stub "express" and run on fixture JSON files in a temp
// directory (the module reads its sources with fs, nothing else). CRM_API_DIR overrides the folder of the module (fresh live copy).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(process.env.CRM_API_DIR || path.join(__dirname, '..', '..'), 'customer-timeline.cjs'), 'utf8');   // the module already carries the activeOrders change
const PATCHED = { out: SRC };

function load(src, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-counter-'));
  const shop = path.join(dir, 'shop'), umg = path.join(dir, 'umg'), data = path.join(dir, 'data');
  [shop, umg, data].forEach(d => fs.mkdirSync(d));
  fs.writeFileSync(path.join(shop, 'orders.json'), JSON.stringify(files.orders || []));
  fs.writeFileSync(path.join(shop, 'messages.json'), '[]');
  fs.writeFileSync(path.join(umg, 'store.json'), JSON.stringify(files.store || {}));
  fs.writeFileSync(path.join(data, 'leads.json'), '[]');
  const handlers = {};
  const express = { Router: () => ({ use() {}, get(p, fn) { handlers[p] = fn; } }) };
  const mod = { exports: {} };
  vm.runInThisContext('(function (module, exports, require, __dirname) {' + src + '\n})')(mod, mod.exports, id => id === 'express' ? express : require(id), dir);
  const router = mod.exports({ shopDir: shop, umgDir: umg, dataDir: data });
  return { router, handlers, dir };
}
function summaryOf(files, email, showQa) {
  const { router } = load(PATCHED.out, files);
  const c = router._build().byEmail.get(email);
  return router._summarize(c, !!showQa).summary;
}
const shopOrder = (ref, email, status, extra) => Object.assign({ ref, customer: { email, firstName: 'A', lastName: 'B' }, items: [{ slug: 'bpc-157', qty: 1 }], status, total_due_server: 100, savedAt: '2026-09-20T10:00:00Z' }, extra || {});
const cardOrder = (id, email, status, extra) => Object.assign({ id, customer: { email }, status, amount: 100, createdAt: '2026-09-20T10:00:00Z', items: [] }, extra || {});

test('one real order: activeOrders 1, so no Repeat chip', () => {
  const s = summaryOf({ orders: [shopOrder('BF-1', 'one@buyer.com', 'paid')] }, 'one@buyer.com');
  assert.strictEqual(s.activeOrders, 1);
});

test('two real orders: activeOrders 2', () => {
  const s = summaryOf({ orders: [shopOrder('BF-1', 'two@buyer.com', 'delivered'), shopOrder('BF-2', 'Two@Buyer.com ', 'new', { savedAt: '2026-09-25T10:00:00Z' })] }, 'two@buyer.com');
  assert.strictEqual(s.activeOrders, 2);
  assert.strictEqual(s.orders, 2);
});

test('cancelled shop order is not counted: first purchase plus a cancelled record stays at 1 (orders says 2)', () => {
  const s = summaryOf({ orders: [shopOrder('BF-1', 'c@buyer.com', 'paid'), shopOrder('BF-2', 'c@buyer.com', 'cancelled', { savedAt: '2026-09-26T10:00:00Z' })] }, 'c@buyer.com');
  assert.strictEqual(s.orders, 2);
  assert.strictEqual(s.activeOrders, 1);
});

test('one card record with attempts[] (declined, then approved) is one order; a record whose attempts all failed is none', () => {
  const rec = cardOrder('C-8', 'f@buyer.com', 'approved', { attempts: [{ status: 'declined' }, { status: 'approved' }] });
  const s = summaryOf({ store: { orders: [rec, cardOrder('C-8b', 'f@buyer.com', 'declined', { attempts: [{ status: 'declined' }, { status: 'declined' }], createdAt: '2026-09-21T10:00:00Z' })] } }, 'f@buyer.com');
  assert.strictEqual(s.orders, 2);
  assert.strictEqual(s.activeOrders, 1);
});

test('two store records with the same id (declined, then approved) are one order; a declined attempt alone: none', () => {
  const both = summaryOf({ store: { orders: [cardOrder('C-9', 'd@buyer.com', 'declined', { createdAt: '2026-09-20T10:00:00Z' }), cardOrder('C-9', 'd@buyer.com', 'approved', { createdAt: '2026-09-20T10:05:00Z' })] } }, 'd@buyer.com');
  assert.strictEqual(both.activeOrders, 1);
  const first = cardOrder('C-1', 'e@buyer.com', 'approved');
  const declined = cardOrder('C-2', 'e@buyer.com', 'declined', { createdAt: '2026-09-21T10:00:00Z' });
  const pending = cardOrder('C-3', 'e@buyer.com', 'pending', { createdAt: '2026-09-22T10:00:00Z' });
  const s = summaryOf({ store: { orders: [first, declined, pending] } }, 'e@buyer.com');
  assert.strictEqual(s.orders, 3);          // the old field keeps counting attempts
  assert.strictEqual(s.activeOrders, 1);    // the new one does not
  assert.strictEqual(summaryOf({ store: { orders: [declined] } }, 'e@buyer.com').activeOrders, 0);
});

test('a refunded or charged-back card order was a real order and is counted', () => {
  const s = summaryOf({ store: { orders: [cardOrder('C-1', 'r@buyer.com', 'refunded'), cardOrder('C-2', 'r@buyer.com', 'chargeback', { createdAt: '2026-09-22T10:00:00Z' })] } }, 'r@buyer.com');
  assert.strictEqual(s.activeOrders, 2);
});

test('QA addresses and test refs are never active, with and without ?qa=1', () => {
  const files = { orders: [shopOrder('BF-1', 'qa-test1@biolabsresearch.co', 'paid'), shopOrder('BF-2', 'qa-test1@biolabsresearch.co', 'paid'),
    shopOrder('PROBE-7', 'real@buyer.com', 'paid'), shopOrder('bf-smoke-2', 'real@buyer.com', 'paid'), shopOrder('BF-4', 'real@buyer.com', 'paid'),
    shopOrder('BF-5', 'flag@buyer.com', 'paid', { test: true }), shopOrder('BF-6', 'flag@buyer.com', 'paid')] };
  assert.strictEqual(summaryOf(files, 'qa-test1@biolabsresearch.co').activeOrders, 0);
  assert.strictEqual(summaryOf(files, 'qa-test1@biolabsresearch.co', true).activeOrders, 0);
  assert.strictEqual(summaryOf(files, 'real@buyer.com').activeOrders, 1);
  assert.strictEqual(summaryOf(files, 'real@buyer.com', true).activeOrders, 1);
  assert.strictEqual(summaryOf(files, 'flag@buyer.com').activeOrders, 1);        // the order marked test: true is out
  assert.strictEqual(summaryOf(files, 'flag@buyer.com', true).activeOrders, 1);
});

test('a card order and its mirror in orders.json are one ref (source_ref), counted once; two mirrored cards are two', () => {
  const card = cardOrder('C-1', 'm@buyer.com', 'approved');
  const mirror = shopOrder('C-1', 'm@buyer.com', 'paid', { source_ref: 'C-1' });
  const same = summaryOf({ orders: [mirror], store: { orders: [card] } }, 'm@buyer.com');
  assert.strictEqual(same.orders, 1);
  assert.strictEqual(same.activeOrders, 1);
  const card2 = cardOrder('C-2', 'm@buyer.com', 'approved', { createdAt: '2026-09-28T10:00:00Z' });
  const mirror2 = shopOrder('BF-22', 'm@buyer.com', 'shipped', { source_ref: 'C-2', savedAt: '2026-09-28T10:00:00Z' });
  const two = summaryOf({ orders: [mirror, mirror2], store: { orders: [card, card2] } }, 'm@buyer.com');
  assert.strictEqual(two.orders, 2);
  assert.strictEqual(two.activeOrders, 2);
  // the same ref stored twice in orders.json (a copy) is still one order
  assert.strictEqual(summaryOf({ orders: [shopOrder('BF-1', 'k@buyer.com', 'paid'), shopOrder('BF-1', 'k@buyer.com', 'paid')] }, 'k@buyer.com').activeOrders, 1);
  // a mirror cancelled in the shop book cancels the card order's count too
  assert.strictEqual(summaryOf({ orders: [shopOrder('C-5', 'x@buyer.com', 'cancelled', { source_ref: 'C-5' })], store: { orders: [cardOrder('C-5', 'x@buyer.com', 'approved')] } }, 'x@buyer.com').activeOrders, 0);
});

test('quotes, signups and abandoned checkouts are not orders', () => {
  const files = {
    orders: [{ type: 'insider-signup', email: 'q@buyer.com', savedAt: '2026-09-20T10:00:00Z' }, shopOrder('BF-Q', 'q@buyer.com', 'new', { source: 'quote', paymentMethod: 'quote-request' })],
    store: { quotes: [{ id: 'Q-1', customer: { email: 'q@buyer.com' }, status: 'new', createdAt: '2026-09-20T10:00:00Z' }], abandoned_checkouts: { s1: { customer: { email: 'q@buyer.com' }, status: 'abandoned', first_seen: '2026-09-20T10:00:00Z' } } }
  };
  assert.strictEqual(summaryOf(files, 'q@buyer.com').activeOrders, 0);
});

test('GET /api/customers and GET /api/customers/:email both carry activeOrders', () => {
  const { handlers } = load(PATCHED.out, { orders: [shopOrder('BF-1', 'l@buyer.com', 'paid'), shopOrder('BF-2', 'l@buyer.com', 'paid')] });
  let list, one;
  handlers['/']({ query: {} }, { json: v => { list = v; } });
  handlers['/:email']({ query: {}, params: { email: 'L@buyer.com' } }, { json: v => { one = v; }, status: () => ({ json: v => { one = v; } }) });
  assert.strictEqual(list.customers.find(c => c.email === 'l@buyer.com').activeOrders, 2);
  assert.strictEqual(one.customer.activeOrders, 2);
  assert.strictEqual(list.meta.orders, 2);   // the totals tile keeps its meaning
});

test('price request (shop_quote) counts once its status is a paid one, under the same key as its mirror; unpaid or cancelled does not', () => {
  const quote = (ref, status, extra) => shopOrder(ref, 'qq@buyer.com', status, Object.assign({ source: 'quote', paymentMethod: 'quote-request' }, extra || {}));
  assert.strictEqual(summaryOf({ orders: [quote('BF-Q1', 'new')] }, 'qq@buyer.com').activeOrders, 0);          // an open price request is not an order
  assert.strictEqual(summaryOf({ orders: [quote('BF-Q1', 'cancelled')] }, 'qq@buyer.com').activeOrders, 0);
  const paid = summaryOf({ orders: [quote('BF-Q1', 'shipped')] }, 'qq@buyer.com');
  assert.strictEqual(paid.activeOrders, 1);
  assert.strictEqual(paid.orders, 0);                                                                          // the old field still does not count quotes
  assert.strictEqual(summaryOf({ orders: [quote('BF-Q1', 'delivered'), quote('BF-Q2', 'paid', { savedAt: '2026-09-25T10:00:00Z' })] }, 'qq@buyer.com').activeOrders, 2);
  // the same paid quote mirrored as a shop order or a card order (source_ref) is one
  const mirrored = summaryOf({ orders: [quote('BF-Q1', 'paid', { source_ref: 'C-7' }), shopOrder('C-7', 'qq@buyer.com', 'paid', { source_ref: 'C-7' })], store: { orders: [cardOrder('C-7', 'qq@buyer.com', 'approved')] } }, 'qq@buyer.com');
  assert.strictEqual(mirrored.activeOrders, 1);
  // cancelled in the shop book wins over a paid quote with the same key; QA and test refs stay out
  assert.strictEqual(summaryOf({ orders: [quote('BF-Q1', 'paid', { source_ref: 'C-7' }), shopOrder('C-7', 'qq@buyer.com', 'cancelled', { source_ref: 'C-7' })] }, 'qq@buyer.com').activeOrders, 0);
  assert.strictEqual(summaryOf({ orders: [shopOrder('BF-Q3', 'qa-test9@biolabsresearch.co', 'paid', { source: 'quote', paymentMethod: 'quote-request' })] }, 'qa-test9@biolabsresearch.co', true).activeOrders, 0);
  assert.strictEqual(summaryOf({ orders: [quote('PROBE-1', 'paid')] }, 'qq@buyer.com').activeOrders, 0);
});

