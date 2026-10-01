'use strict';
// FinanceModel.repeatReport on hand-counted orders: the order number of a buyer runs over the whole history (across the period
// border), "Paid only" decides what a purchase is, cancelled / copies / test / no e-mail are out, week and month buckets on a
// continuous axis, an empty list. (The deploy patch of finance-model.js is tested in biofirst-hosting only.)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CRM_DIR, load, loadModel } = require('./helpers.cjs');

global.OrdersModel = load(path.join(CRM_DIR, 'orders-model.js'));
const OM = global.OrdersModel;
const FM = loadModel();

// date-only savedAt = a local calendar day, so the buckets do not depend on the machine's time zone
function raw(ref, email, day, due, over) {
  over = over || {};
  const o = { ref, customer: { email, firstName: 'N' + ref }, savedAt: day, total_due_server: due.toFixed(2), status: over.status || 'new',
    items: [{ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty: 1, price: due }] };
  if (over.paid !== false && over.status !== 'cancelled') o.payments = [{ id: 'p' + ref, at: day + 'T12:00:00.000Z', kind: 'payment', method: 'card', amount: due }];
  if (over.test) o.test = true;
  return o;
}
const NOW = new Date('2026-10-01T12:00:00');          // a Thursday; its week starts Monday Sep 28
const rep = (list, period, extra) => FM.repeatReport(OM.load(list), Object.assign({ period, paidOnly: true, now: NOW }, extra));
const bucketOf = (r, key) => r.buckets.find(b => b.key === key);

const BASE = () => [
  raw('1', 'a@x.com', '2026-07-15', 30),            // A: 1st (outside every period below but "all" and ytd)
  raw('2', ' A@X.com ', '2026-09-26', 100),         // A: 2nd, the e-mail is trimmed and lower-cased
  raw('3', 'a@x.com', '2026-09-29', 20),            // A: 3rd
  raw('4', 'b@x.com', '2026-08-20', 50),            // B: 1st, before the 30 days
  raw('5', 'b@x.com', '2026-09-10', 40),            // B: 2nd
  raw('6', 'c@x.com', '2026-09-03', 60),            // C: 1st
  raw('7', 'c@x.com', '2026-09-12', 10),            // C: 2nd, in the same period as its 1st
  raw('8', 'd@x.com', '2026-09-29', 70),            // D: 1st
  raw('9', 'f@x.com', '2026-09-06', 99, { status: 'cancelled' }),
  raw('10', '', '2026-09-07', 5)                    // no e-mail
];

test('30 days, Paid only: the number of an order comes from the whole history, hand-counted totals', () => {
  const r = rep(BASE(), '30d');
  assert.equal(r.bucket, 'week');
  assert.equal(r.customers, 4);                      // A, B, C, D
  assert.equal(r.newCustomers, 2);                   // C, D: B and A started before the 30 days
  assert.equal(r.returning, 3);                      // A, B, C
  assert.equal(r.ordersFirst, 2);
  assert.equal(r.ordersRepeat, 4);                   // A 2nd and 3rd, B 2nd, C 2nd
  assert.equal(r.revenueFirst, 130);
  assert.equal(r.revenueRepeat, 170);
  assert.equal(r.revenue, 300);
  assert.equal(r.repeatRevenueShare, 170 / 300);
  assert.equal(r.returningShare, 3 / 4);
});

test('30 days: week buckets on a continuous axis (Monday starts), the same numbers per bucket, empty weeks are zeros', () => {
  const r = rep(BASE(), '30d');
  assert.deepEqual(r.buckets.map(b => b.key), ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  assert.deepEqual(r.buckets.map(b => b.label), ['Aug 31', 'Sep 7', 'Sep 14', 'Sep 21', 'Sep 28']);
  const pick = b => [b.customers, b.newCustomers, b.returning, b.ordersFirst, b.ordersRepeat, b.revenueFirst, b.revenueRepeat];
  assert.deepEqual(pick(bucketOf(r, '2026-08-31')), [1, 1, 0, 1, 0, 60, 0]);      // C's first
  assert.deepEqual(pick(bucketOf(r, '2026-09-07')), [2, 0, 2, 0, 2, 0, 50]);      // B's 2nd, C's 2nd
  assert.deepEqual(pick(bucketOf(r, '2026-09-14')), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(pick(bucketOf(r, '2026-09-21')), [1, 0, 1, 0, 1, 0, 100]);     // A's 2nd (Saturday)
  assert.deepEqual(pick(bucketOf(r, '2026-09-28')), [2, 1, 1, 1, 1, 70, 20]);     // D's first, A's 3rd
  assert.equal(r.buckets.reduce((s, b) => s + b.revenueRepeat, 0), r.revenueRepeat, 'the buckets add up to the period');
  assert.equal(r.buckets.reduce((s, b) => s + b.ordersFirst + b.ordersRepeat, 0), r.ordersFirst + r.ordersRepeat);
  assert.equal(bucketOf(r, '2026-09-14').repeatRevenueShare, 0);
  assert.equal(bucketOf(r, '2026-09-14').returningShare, 0);
  assert.equal(bucketOf(r, '2026-09-21').repeatRevenueShare, 1);
});

test('Paid only off: an unpaid order is a purchase and shifts the numbers; on: it is not', () => {
  const list = () => [raw('20', 'h@x.com', '2026-08-01', 10, { paid: false }), raw('21', 'h@x.com', '2026-09-15', 20)];
  const on = rep(list(), '30d');
  assert.deepEqual([on.customers, on.newCustomers, on.returning, on.revenueFirst, on.revenueRepeat], [1, 1, 0, 20, 0]);
  const off = rep(list(), '30d', { paidOnly: false });
  assert.deepEqual([off.customers, off.newCustomers, off.returning, off.revenueFirst, off.revenueRepeat], [1, 0, 1, 0, 20]);
  assert.equal(off.ordersRepeat, 1, 'the 2nd order is a repeat one although the 1st is outside the period');
});

test('cancelled, test orders and orders without an e-mail are not purchases and do not shift the numbers of others', () => {
  const list = [raw('30', 'k@x.com', '2026-08-01', 10, { status: 'cancelled' }), raw('31', 'k@x.com', '2026-08-05', 10, { test: true }),
    raw('32', '', '2026-08-06', 10), raw('33', 'k@x.com', '2026-09-15', 25)];
  const r = rep(list, '30d', { paidOnly: false });
  assert.deepEqual([r.customers, r.newCustomers, r.returning, r.revenueFirst], [1, 1, 0, 25], 'k@x.com has one real purchase: it is the first');
});

test('all time: month buckets from the first order to this month; matches the old repeat() on the same list', () => {
  const list = OM.load(BASE());
  const r = FM.repeatReport(list, { period: 'all', paidOnly: true, now: NOW });
  assert.equal(r.bucket, 'month');
  assert.deepEqual(r.buckets.map(b => b.key), ['2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(r.buckets.map(b => b.label), ['Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026']);
  assert.deepEqual([r.customers, r.newCustomers, r.returning, r.ordersFirst, r.ordersRepeat], [4, 4, 3, 4, 4]);
  assert.equal(r.revenueFirst, 30 + 50 + 60 + 70);
  assert.equal(r.revenueRepeat, 100 + 20 + 40 + 10);
  assert.equal(bucketOf(r, '2026-10').customers, 0);
  const old = FM.repeat(FM.select(list, { period: 'all', paidOnly: true, now: NOW }));
  assert.equal(r.customers, old.customers, 'same buyers as the old table');
  assert.equal(r.returning, old.repeat, 'over all time "ordered again" is "bought twice or more"');
});

test('year to date: months from January; 90 days: weeks; an explicit bucket wins', () => {
  const y = rep(BASE(), 'ytd');
  assert.equal(y.bucket, 'month');
  assert.equal(y.buckets.length, 10);                 // Jan .. Oct
  assert.equal(y.buckets[0].key, '2026-01');
  assert.equal(bucketOf(y, '2026-03').customers, 0);
  const n = rep(BASE(), '90d');
  assert.equal(n.bucket, 'week');
  assert.equal(n.buckets[0].key, '2026-06-29');       // 90 days before Oct 1 is Jul 3 (Friday): its Monday
  assert.equal(n.buckets[n.buckets.length - 1].key, '2026-09-28');
  assert.deepEqual([n.newCustomers, n.returning], [4, 3]);   // the firsts of A (Jul 15) and B (Aug 20) are inside now: all four are new; A, B, C came back
  const m = rep(BASE(), '30d', { bucket: 'month' });
  assert.deepEqual(m.buckets.map(b => b.key), ['2026-09', '2026-10']);
});

test('the week of a boundary: a Sunday order is in the week that started the Monday before', () => {
  const r = rep([raw('40', 'z@x.com', '2026-09-27', 10)], '30d');       // Sunday
  assert.equal(bucketOf(r, '2026-09-21').customers, 1);
  assert.equal(bucketOf(r, '2026-09-28').customers, 0);
});

test('an empty list, or nothing in the period: zeros and no buckets, never NaN', () => {
  for (const r of [rep([], 'all'), rep([], '30d'), rep([raw('50', 'q@x.com', '2025-01-05', 10)], '30d')]) {
    assert.deepEqual([r.customers, r.newCustomers, r.returning, r.ordersFirst, r.ordersRepeat, r.revenue, r.repeatRevenueShare, r.returningShare], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(r.buckets, []);
  }
  assert.deepEqual(FM.repeatReport(null, {}).buckets, []);
  assert.equal(FM.repeatReport(undefined).customers, 0);
});

test('an order dated in the future goes into the last bucket: the axis ends with today, not with a typo in the year', () => {
  const list = [raw('80', 'w@x.com', '2026-09-20', 10), raw('81', 'w@x.com', '2027-03-01', 40), raw('82', 'w@x.com', '2126-03-01', 5)];
  for (const period of ['30d', 'all']) {
    const r = rep(list, period, { bucket: 'month' });
    assert.equal(r.buckets[r.buckets.length - 1].key, '2026-10', period + ': Oct 2026 is the last month');
    assert.ok(r.buckets.length <= 4, period + ': ' + r.buckets.length + ' buckets');
    assert.equal(r.ordersFirst + r.ordersRepeat, 3, 'the orders are still counted');
    assert.equal(r.buckets.reduce((s, b) => s + b.ordersFirst + b.ordersRepeat, 0), 3, 'and each sits in a bucket');
    assert.equal(r.buckets[r.buckets.length - 1].ordersRepeat, 2);
  }
  const w = rep(list, '30d', { bucket: 'week' });
  assert.equal(w.buckets[w.buckets.length - 1].key, '2026-09-28');
  assert.equal(w.buckets[w.buckets.length - 1].ordersRepeat, 2);
  const only = rep([raw('83', 'v@x.com', '2027-03-01', 40)], 'all');       // nothing but a future order
  assert.deepEqual(only.buckets.map(b => b.key), ['2026-10']);
  assert.equal(only.buckets[0].newCustomers, 1);
});

test('an order without a readable date: counted over all time, sits in no bucket, numbered after the dated ones', () => {
  const r = rep([raw('60', 'u@x.com', 'not a date', 10), raw('61', 'u@x.com', '2026-09-15', 30)], 'all');
  assert.deepEqual([r.customers, r.ordersFirst, r.ordersRepeat, r.revenueFirst, r.revenueRepeat], [1, 1, 1, 30, 10]);
  assert.equal(r.buckets.reduce((s, b) => s + b.ordersFirst + b.ordersRepeat, 0), 1);
  assert.equal(rep([raw('62', 'u@x.com', 'not a date', 10)], '30d').customers, 0, 'outside "all" an undated order is in no period');
});

test('money is summed in cents: ten orders of $0.10 are $1, not $0.9999999', () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(raw('7' + i, 'm@x.com', '2026-09-' + String(10 + i), 0.1));
  const r = rep(list, '30d');
  assert.equal(r.revenueFirst, 0.1);
  assert.equal(r.revenueRepeat, 0.9);
  assert.equal(r.revenue, 1);
});

test('repeat() and the rest of the model are untouched', () => {
  const list = FM.select(OM.load(BASE()), { period: 'all', paidOnly: true, now: NOW });
  const old = FM.repeat(list);
  assert.deepEqual([old.customers, old.repeat], [4, 3]);
  for (const name of ['select', 'aov', 'products', 'sources', 'sourceOf', 'repeat', 'whenOf', 'costIndex', 'itemCost', 'margin']) assert.equal(typeof FM[name], 'function', name);
});
