'use strict';
// FinanceModel.costIndex / itemCost / margin: gross margin on the Finance Reports page from the unit-cost list
// (GET /api/unit-costs). The prices here are made up; the real list stays on the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../products-api/tests/load-crm-model.cjs');

const OM = load('orders-model.js');
const FM = load('finance-model.js');

const COSTS = {
  currency: 'USD',
  items: [
    { id: 'BC10', cost: 18, match: [{ slug: 'bpc-157', mg: '10mg' }] },
    { id: 'RT10', cost: 30, match: [{ slug: 'g3-r', mg: '10mg' }, { slug: 'retatrutide', mg: '10mg' }] },
    { id: 'WA10', cost: 10, match: [{ slug: 'research-solvent', mg: '10ml' }] },
    { id: 'DS5', cost: 11, match: [] }
  ]
};

function order(ref, items, extra) {
  return Object.assign({ ref, status: 'paid', created_at: '2026-09-20T10:00:00Z', customer: { email: ref.toLowerCase() + '@mail.com' }, items }, extra || {});
}
const records = raws => OM.load(raws);

test('costIndex: one entry per slug + strength, strengths compared without case and spaces', () => {
  const idx = FM.costIndex(COSTS);
  assert.equal(idx.size, 4);
  assert.deepEqual(FM.itemCost({ slug: 'bpc-157', mg: '10mg' }, idx), { unit: 18, id: 'BC10', source: '' });
  assert.deepEqual(FM.itemCost({ slug: 'BPC-157', mg: '10 MG' }, idx), { unit: 18, id: 'BC10', source: '' });
  assert.deepEqual(FM.itemCost({ slug: 'retatrutide', mg: '10mg' }, idx), { unit: 30, id: 'RT10', source: '' });
  assert.deepEqual(FM.itemCost({ slug: 'research-solvent', mg: '10mL' }, idx), { unit: 10, id: 'WA10', source: '' });
});

test('itemCost: an unknown strength, a missing slug or an empty index give null (no guessing)', () => {
  const idx = FM.costIndex(COSTS);
  assert.equal(FM.itemCost({ slug: 'bpc-157', mg: '20mg' }, idx), null);
  assert.equal(FM.itemCost({ slug: '', mg: '10mg', name: 'BPC-157' }, idx), null);
  assert.equal(FM.itemCost({ slug: 'bpc-157', mg: '10mg' }, FM.costIndex(null)), null);
});

test('costIndex: broken input is skipped, not thrown', () => {
  assert.equal(FM.costIndex(undefined).size, 0);
  assert.equal(FM.costIndex({ items: 'x' }).size, 0);
  const idx = FM.costIndex({ items: [null, { id: 'A', cost: 0, match: [{ slug: 'a', mg: '1mg' }] }, { id: 'B', cost: 'x', match: [{ slug: 'b', mg: '1mg' }] },
    { id: 'C', cost: 5, match: 'no' }, { id: 'D', cost: 7, match: [null, { slug: 'd' }, { slug: 'd', mg: '2mg' }] }] });
  assert.equal(idx.size, 1);
  assert.deepEqual(FM.itemCost({ slug: 'd', mg: '2mg' }, idx), { unit: 7, id: 'D', source: '' });
});

test('margin: product revenue = amount due minus shipping and card fee; cost = qty x unit cost; gift vial costs too', () => {
  const list = records([
    order('A-1', [{ slug: 'bpc-157', mg: '10mg', qty: 2, price: 88, name: 'BPC-157' },
      { slug: 'research-solvent', mg: '10mL', qty: 1, price: 0, name: 'Research solvent' }], { shippingCost: 18.99, total_due_server: 195 }),
    order('A-2', [{ slug: 'g3-r', mg: '10mg', qty: 1, price: 85, name: 'G3-R' }], { shippingCost: 0, cardFee: 2.5, total_due_server: 87.5 })
  ]);
  const m = FM.margin(list, FM.costIndex(COSTS));
  assert.equal(m.orders, 2);
  assert.equal(m.costed, 2);
  assert.equal(m.revenue, 261.01);          // (195 - 18.99) + (87.5 - 2.5)
  assert.equal(m.cost, 76);                 // 2*18 + 10 + 30
  assert.equal(m.profit, 185.01);
  assert.equal(Math.round(m.pct * 1000) / 1000, 0.709);
  const bpc = m.products.find(p => p.key === 'bpc-157|10mg');
  assert.deepEqual({ units: bpc.units, value: bpc.value, cost: bpc.cost, profit: bpc.profit }, { units: 2, value: 176, cost: 36, profit: 140 });
  const gift = m.products.find(p => p.key === 'research-solvent|10ml');
  assert.deepEqual({ units: gift.units, value: gift.value, cost: gift.cost, profit: gift.profit }, { units: 1, value: 0, cost: 10, profit: -10 });
  assert.equal(m.missing.length, 0);
});

test('margin: an order with one line without cost stays out of the totals and its line is listed as missing', () => {
  const list = records([
    order('B-1', [{ slug: 'bpc-157', mg: '10mg', qty: 1, price: 88, name: 'BPC-157' }], { total_due_server: 88 }),
    order('B-2', [{ slug: 'bpc-157', mg: '10mg', qty: 1, price: 88, name: 'BPC-157' },
      { slug: 'bpc-157', mg: '20mg', qty: 3, price: 150, name: 'BPC-157' }], { total_due_server: 538 }),
    order('B-3', [{ name: 'Custom blend', qty: 2, price: 40 }], { total_due_server: 80 })
  ]);
  const m = FM.margin(list, FM.costIndex(COSTS));
  assert.equal(m.orders, 3);
  assert.equal(m.costed, 1);
  assert.equal(m.revenue, 88);
  assert.equal(m.cost, 18);
  assert.deepEqual(m.missing.map(x => [x.key, x.units, x.orders]), [['bpc-157|20mg', 3, 1], ['custom blend', 2, 1]]);
  // product rows count every costed line, also from orders that are out of the totals
  assert.equal(m.products.find(p => p.key === 'bpc-157|10mg').units, 2);
});

test('margin: revenue never below zero, empty list and no costs give zeros and pct null', () => {
  const neg = records([order('C-1', [{ slug: 'bpc-157', mg: '10mg', qty: 1, price: 0, name: 'BPC-157' }], { shippingCost: 20, total_due_server: 10 })]);
  const m = FM.margin(neg, FM.costIndex(COSTS));
  assert.equal(m.revenue, 0);
  assert.equal(m.profit, -18);
  assert.equal(m.pct, null);
  const e = FM.margin([], FM.costIndex(COSTS));
  assert.deepEqual([e.orders, e.costed, e.revenue, e.cost, e.profit, e.pct, e.products.length, e.missing.length], [0, 0, 0, 0, 0, null, 0, 0]);
  const none = FM.margin(neg, FM.costIndex(null));
  assert.equal(none.costed, 0);
  assert.equal(none.missing.length, 1);
});

test('margin: does not change its input', () => {
  const list = records([order('D-1', [{ slug: 'g3-r', mg: '10mg', qty: 1, price: 85, name: 'G3-R' }], { total_due_server: 85 })]);
  const before = JSON.stringify(list);
  FM.margin(list, FM.costIndex(COSTS));
  assert.equal(JSON.stringify(list), before);
});

test('cost basis: itemCost and product rows carry the source of the cost (purchase average or POD price)', () => {
  const idx = FM.costIndex({ items: [
    { id: 'PUR:bpc-157|10mg', cost: 12.5, source: 'purchase', match: [{ slug: 'bpc-157', mg: '10mg' }] },
    { id: 'RT10', cost: 30, source: 'pod', match: [{ slug: 'g3-r', mg: '10mg' }] },
    { id: 'OLD', cost: 9, match: [{ slug: 'semax', mg: '10mg' }] }
  ] });
  assert.deepEqual(FM.itemCost({ slug: 'bpc-157', mg: '10mg' }, idx), { unit: 12.5, id: 'PUR:bpc-157|10mg', source: 'purchase' });
  assert.equal(FM.itemCost({ slug: 'semax', mg: '10mg' }, idx).source, '');
  const m = FM.margin(records([order('E-1', [{ slug: 'bpc-157', mg: '10mg', qty: 2, price: 88, name: 'BPC-157' },
    { slug: 'g3-r', mg: '10mg', qty: 1, price: 85, name: 'G3-R' }], { total_due_server: 261 })]), idx);
  assert.equal(m.products.find(p => p.key === 'bpc-157|10mg').source, 'purchase');
  assert.equal(m.products.find(p => p.key === 'g3-r|10mg').source, 'pod');
  assert.equal(m.cost, 55);
});
