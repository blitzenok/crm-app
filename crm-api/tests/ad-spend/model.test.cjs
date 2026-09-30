'use strict';
// adspend-model.js on the live OrdersModel / FinanceModel of the snapshot: the numbers of a small, fully hand-counted shop.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CRM_DIR, ADMODEL } = require('./helpers.cjs');
const { loadJs } = require('./helpers.cjs');

const OM = loadJs(path.join(CRM_DIR, 'orders-model.js'));
const FM = loadJs(path.join(CRM_DIR, 'finance-model.js'));
const AM = loadJs(ADMODEL);

const NOW = new Date('2026-10-01T12:00:00Z');
const costIdx = FM.costIndex({ items: [{ id: 'bpc', cost: 10, source: 'purchase', match: [{ slug: 'bpc-157', mg: '10mg' }] }] });

let n = 3000;
// One raw order in the shape orders.json has. paid: a payment for the full amount; source: attribution.source; bpc: qty of the costed item.
function order(o) {
  const ref = 'BLR-' + (++n);
  const raw = { ref, customer: { email: o.email === undefined ? '' : o.email }, savedAt: o.at, total_due_server: String(o.due.toFixed(2)),
    status: o.status || 'new', items: o.qty ? [{ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty: o.qty, price: o.due / o.qty }] : [] };
  if (o.source) raw.attribution = { source: o.source };
  if (o.coupon) raw.coupon = o.coupon;
  if (o.test) raw.test = true;
  if (o.paid !== false) raw.payments = [{ id: 'p' + n, at: o.at, kind: 'payment', method: 'card', amount: o.due }];
  return raw;
}
const raws = [
  order({ email: 'ann@x.com', at: '2026-09-10T10:00:00Z', source: 'facebook', due: 100, qty: 2 }),       // new customer, facebook; cost 20, profit 80
  order({ email: 'ann@x.com', at: '2026-09-20T10:00:00Z', source: 'facebook', due: 60, qty: 1 }),        // repeat; profit 50
  order({ email: 'bob@x.com', at: '2026-09-12T10:00:00Z', source: 'ram', due: 200, qty: 4 }),            // new, ram; cost 40, profit 160
  order({ email: 'cara@x.com', at: '2026-09-14T10:00:00Z', due: 50, qty: 1 }),                           // no trail at all: Direct / unknown; profit 40
  order({ email: 'dan@x.com', at: '2026-09-15T10:00:00Z', source: 'direct', due: 30, qty: 1, paid: false }), // unpaid
  order({ email: 'eve@x.com', at: '2026-08-01T10:00:00Z', source: 'facebook', due: 40, qty: 1 }),        // eve's first paid order: before the 30-day window
  order({ email: 'eve@x.com', at: '2026-09-18T10:00:00Z', source: 'ram', due: 80, qty: 1 }),             // so this one is not a new customer; profit 70
  order({ email: 'zed@x.com', at: '2026-09-18T10:00:00Z', source: 'facebook', due: 500, qty: 1, test: true }),   // test order, ignored
  order({ email: 'yan@x.com', at: '2026-09-18T10:00:00Z', source: 'facebook', due: 500, qty: 1, status: 'cancelled' }),
  order({ email: '', at: '2026-09-19T10:00:00Z', source: 'google', due: 25 })                             // no e-mail, no items: revenue yes, new customer no, no cost
];
const orders = OM.load(raws);
const spend = [
  { id: 'sp_1', date: '2026-09-11', source: 'facebook', amountCents: 10000 },
  { id: 'sp_2', date: '2026-09-25', source: 'meta', amountCents: 20000 },
  { id: 'sp_3', date: '2026-09-12', source: 'other:ram', amountCents: 14050 },
  { id: 'sp_4', date: '2026-09-20', source: 'tiktok', amountCents: 5000 },
  { id: 'sp_5', date: '2026-08-01', source: 'facebook', amountCents: 99900 },                      // outside 30d
  { id: 'sp_6', date: '2026-09-21', source: 'google', amountCents: 77700, deleted: { by: 'x', at: 'y' } }   // deleted: never counted
];
const byKey = (res, k) => res.rows.find(r => r.key === k);

test('sanity: the fixture orders are what the test thinks they are', () => {
  const sel = FM.select(orders, { period: 'all', paidOnly: true, now: NOW });
  assert.equal(sel.length, 7 + 1 - 1 + 0, 'paid, not test, not cancelled: ann x2, bob, cara, eve x2, no-email');
  assert.equal(FM.select(orders, { period: 'all', paidOnly: false, now: NOW }).length, 8);
});

test('30 days, paid only: per-source spend, orders, revenue, new customers, CAC, ROAS, margin, margin minus ads', () => {
  const res = AM.build({ orders, spend, period: '30d', paidOnly: true, now: NOW, costIdx });
  assert.deepEqual(res.rows.map(r => r.key), ['meta', 'ram', 'tiktok', 'direct', 'google'], 'by spend, then by revenue');
  const fb = byKey(res, 'meta');
  assert.equal(fb.label, 'Meta (facebook, instagram, fbclid)');
  assert.equal(fb.spendC, 30000, 'spend filed as facebook and as meta both land in the Meta group');
  assert.deepEqual([fb.spendC, fb.orders, fb.revenueC, fb.newCustomers, fb.cacC, fb.profitC, fb.afterAdsC], [30000, 2, 16000, 1, 30000, 13000, -17000]);
  assert.ok(Math.abs(fb.roas - 16000 / 30000) < 1e-12);
  const ram = byKey(res, 'ram');
  assert.equal(ram.label, 'Ram');
  assert.deepEqual([ram.spendC, ram.orders, ram.revenueC, ram.newCustomers, ram.cacC, ram.profitC, ram.afterAdsC], [14050, 2, 28000, 1, 14050, 23000, 8950]);
  assert.ok(Math.abs(ram.roas - 28000 / 14050) < 1e-12);
  const tk = byKey(res, 'tiktok');
  assert.deepEqual([tk.label, tk.spendC, tk.orders, tk.revenueC, tk.newCustomers, tk.cacC, tk.roas, tk.profitC, tk.afterAdsC], ['TikTok', 5000, 0, 0, 0, null, 0, 0, -5000], 'spend and no orders is still a row');
  const direct = byKey(res, 'direct');
  assert.deepEqual([direct.label, direct.spendC, direct.orders, direct.revenueC, direct.newCustomers, direct.cacC, direct.roas, direct.profitC, direct.afterAdsC], ['Direct / unknown', 0, 1, 5000, 1, null, null, 4000, 4000], 'no trail = Direct / unknown; no spend = no CAC / ROAS');
  const g = byKey(res, 'google');
  assert.deepEqual([g.spendC, g.orders, g.revenueC, g.newCustomers, g.profitC, g.afterAdsC], [0, 1, 2500, 0, null, null], 'orders with no cost for their items: margin unknown, not zero');
  const t = res.total;
  assert.deepEqual([t.spendC, t.orders, t.revenueC, t.newCustomers, t.cacC, t.profitC, t.afterAdsC], [49050, 6, 51500, 3, 16350, 40000, -9050]);
  assert.ok(Math.abs(t.roas - 51500 / 49050) < 1e-12);
  const pc = res.paidChannels;
  assert.deepEqual([pc.label, pc.spendC, pc.orders, pc.revenueC, pc.newCustomers, pc.cacC, pc.profitC, pc.afterAdsC, pc.costed], ['Paid channels', 49050, 4, 44000, 2, 24525, 36000, -13050, 4], 'sources with spend only: meta, ram, tiktok');
  assert.ok(Math.abs(pc.roas - 44000 / 49050) < 1e-12);
  assert.equal(t.costed, 5, 'costed orders: meta 2, ram 2, direct 1; the google order has none');
  assert.equal(res.marginOn, true);
  assert.equal(res.marginPartial, true, 'the google row has no costed order');
  assert.deepEqual(res.range, { from: '2026-09-01', to: '' });
});

test('a deleted entry and an entry outside the period are not counted; a bad amount is skipped', () => {
  const res = AM.build({ orders, spend: spend.concat([{ id: 'x', date: '2026-09-22', source: 'tiktok', amountCents: -500 }, { id: 'y', date: '2026-09-22', source: 'tiktok', amountCents: 10.5 },
    { id: 'z', date: 'bad', source: 'tiktok', amountCents: 500 }, null]), period: '30d', paidOnly: true, now: NOW, costIdx });
  assert.equal(byKey(res, 'tiktok').spendC, 5000);
  assert.equal(byKey(res, 'meta').spendC, 30000);
  assert.equal(byKey(res, 'google').spendC, 0);
});

test('paid only off: unpaid orders join orders and revenue, never the new customers', () => {
  const res = AM.build({ orders, spend, period: '30d', paidOnly: false, now: NOW, costIdx });
  const d = byKey(res, 'direct');
  assert.deepEqual([d.orders, d.revenueC, d.newCustomers], [2, 8000, 1]);
  assert.equal(res.total.orders, 7);
});

test('all time: the old entry counts, and eve\'s first paid order makes her a new customer of facebook', () => {
  const res = AM.build({ orders, spend, period: 'all', paidOnly: true, now: NOW, costIdx });
  const fb = byKey(res, 'meta');
  assert.equal(fb.spendC, 30000 + 99900);
  assert.equal(fb.orders, 3);
  assert.equal(fb.newCustomers, 2);
  assert.equal(fb.cacC, Math.round(129900 / 2));
  assert.equal(res.range.from, '');
});

test('an empty shop and an empty spend list: no rows, zeros, dashes (no NaN, no division by zero)', () => {
  const res = AM.build({ orders: [], spend: [], period: '30d', paidOnly: true, now: NOW, costIdx });
  assert.deepEqual(res.rows, []);
  assert.deepEqual([res.total.spendC, res.total.orders, res.total.revenueC, res.total.newCustomers, res.total.cacC, res.total.roas, res.total.profitC, res.total.afterAdsC], [0, 0, 0, 0, null, null, 0, 0]);
  const only = AM.build({ orders: [], spend: [{ id: 'a', date: '2026-09-20', source: 'google', amountCents: 1234 }], period: '30d', paidOnly: true, now: NOW, costIdx });
  assert.equal(only.rows.length, 1);
  assert.deepEqual([only.rows[0].roas, only.rows[0].cacC, only.total.roas, only.total.cacC], [0, null, 0, null]);
  assert.deepEqual(AM.build({ now: NOW }).rows, [], 'no options at all');
});

test('no cost list (it failed to load): spend, revenue, CAC, ROAS still work; margin columns are unknown', () => {
  const res = AM.build({ orders, spend, period: '30d', paidOnly: true, now: NOW, costIdx: null });
  assert.equal(res.marginOn, false);
  assert.equal(res.total.profitC, null);
  assert.equal(res.total.afterAdsC, null);
  assert.ok(res.rows.every(r => r.profitC === null && r.afterAdsC === null));
  assert.equal(byKey(res, 'meta').cacC, 30000);
});

test('the same source under the order\'s label and the spend\'s key lands on one row (case, other:)', () => {
  const o = OM.load([order({ email: 'k@x.com', at: '2026-09-10T10:00:00Z', source: 'ram-affiliate', due: 10, qty: 1 }),
    order({ email: 'l@x.com', at: '2026-09-10T10:00:00Z', source: 'TikTok', due: 10, qty: 1 }), order({ email: 'm@x.com', at: '2026-09-10T10:00:00Z', source: 'meta', due: 10, qty: 1 })]);
  const s = [{ date: '2026-09-11', source: 'other:ram-affiliate', amountCents: 100 }, { date: '2026-09-11', source: 'tiktok', amountCents: 200 }, { date: '2026-09-11', source: 'meta', amountCents: 300 }];
  const res = AM.build({ orders: o, spend: s, period: 'all', paidOnly: true, now: NOW, costIdx });
  assert.deepEqual(res.rows.map(r => [r.key, r.label, r.spendC, r.orders]).sort(), [['meta', 'Meta (facebook, instagram, fbclid)', 300, 1], ['ram-affiliate', 'Ram-affiliate', 100, 1], ['tiktok', 'TikTok', 200, 1]]);
});

test('a coupon-based source has its own row and never takes the direct row\'s spend', () => {
  const o = OM.load([order({ email: 'k@x.com', at: '2026-09-10T10:00:00Z', coupon: 'WELCOME10', due: 10, qty: 1 })]);
  const res = AM.build({ orders: o, spend: [{ date: '2026-09-11', source: 'direct', amountCents: 100 }], period: 'all', paidOnly: true, now: NOW, costIdx });
  assert.deepEqual(res.rows.map(r => [r.key, r.label, r.spendC, r.orders]).sort(), [['direct', 'Direct / unknown', 100, 0], ['newsletter-signup', 'Newsletter signup', 0, 1]]);
});

test('periodRange: local days, no upper bound', () => {
  const now = new Date(2026, 9, 1, 12, 0, 0);
  assert.deepEqual(AM.periodRange('30d', now), { from: '2026-09-01', to: '' });
  assert.deepEqual(AM.periodRange('90d', now), { from: '2026-07-03', to: '' });
  assert.deepEqual(AM.periodRange('ytd', now), { from: '2026-01-01', to: '' });
  assert.deepEqual(AM.periodRange('all', now), { from: '', to: '' });
  assert.deepEqual(AM.periodRange(undefined, now), { from: '', to: '' });
});

test('the model never changes its inputs', () => {
  const before = JSON.stringify([orders, spend]);
  AM.build({ orders, spend, period: '30d', paidOnly: true, now: NOW, costIdx });
  assert.equal(JSON.stringify([orders, spend]), before);
});

test('source options: real names only (Meta carries facebook and instagram), no Direct, each one is a label finance-model gives or a group it forms', () => {
  assert.deepEqual(AM.SOURCE_OPTIONS.map(o => o.value), ['google', 'meta', 'tiktok', 'newsletter']);
  for (const o of AM.SOURCE_OPTIONS) if (o.value !== 'meta') assert.equal(FM.sourceOf({ attribution: { source: o.value } }), o.label, o.value);
  assert.equal(AM.orderKey({ attribution: { source: 'instagram' } }), 'meta');
  assert.equal(AM.orderKey({ attribution: { source: 'facebook' } }), 'meta');
  assert.equal(AM.orderKey({ attribution: { source: 'google' } }), 'google');
  assert.equal(AM.spendKey({ source: 'instagram' }), 'meta');
  assert.equal(AM.spendKey({ source: 'other:ram' }), 'ram');
});

test('Meta group: orders of meta, facebook and instagram (and a bare fbclid) meet the spend filed under meta or under the legacy facebook / instagram', () => {
  const o = OM.load([order({ email: 'a@x.com', at: '2026-09-10T10:00:00Z', source: 'meta', due: 10, qty: 1 }), order({ email: 'b@x.com', at: '2026-09-10T10:00:00Z', source: 'facebook', due: 20, qty: 1 }),
    order({ email: 'c@x.com', at: '2026-09-10T10:00:00Z', source: 'instagram', due: 30, qty: 1 }), order({ email: 'd@x.com', at: '2026-09-10T10:00:00Z', source: 'google', due: 5, qty: 1 })]);
  const s = [{ date: '2026-09-11', source: 'meta', amountCents: 100 }, { date: '2026-09-11', source: 'facebook', amountCents: 200 }, { date: '2026-09-11', source: 'other:instagram', amountCents: 300 }];
  const res = AM.build({ orders: o, spend: s, period: 'all', paidOnly: true, now: NOW, costIdx });
  assert.deepEqual(res.rows.map(r => [r.key, r.spendC, r.orders, r.revenueC, r.newCustomers]), [['meta', 600, 3, 6000, 3], ['google', 0, 1, 500, 1]]);
  assert.equal(res.rows[0].label, 'Meta (facebook, instagram, fbclid)');
});

test('partial cost coverage in a row: profit and profit after ads are of the costed orders and the row says how many (costed < orders)', () => {
  const o = OM.load([order({ email: 'a@x.com', at: '2026-09-10T10:00:00Z', source: 'ram', due: 100, qty: 2 }), order({ email: 'b@x.com', at: '2026-09-10T10:00:00Z', source: 'ram', due: 50 })]);   // the second has no items: no cost
  const res = AM.build({ orders: o, spend: [{ date: '2026-09-11', source: 'other:ram', amountCents: 1000 }], period: 'all', paidOnly: true, now: NOW, costIdx });
  const r = res.rows[0];
  assert.deepEqual([r.orders, r.costed, r.profitC, r.afterAdsC], [2, 1, 8000, 7000]);
  assert.equal(res.marginPartial, true);
  assert.deepEqual([res.total.orders, res.total.costed, res.paidChannels.orders, res.paidChannels.costed], [2, 1, 2, 1]);
});

test('paid channels with no spend anywhere: zeros and dashes, no NaN', () => {
  const res = AM.build({ orders, spend: [], period: '30d', paidOnly: true, now: NOW, costIdx });
  assert.deepEqual([res.paidChannels.spendC, res.paidChannels.orders, res.paidChannels.cacC, res.paidChannels.roas], [0, 0, null, null]);
});
