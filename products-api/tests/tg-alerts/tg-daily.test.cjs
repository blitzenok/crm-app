'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../tg-daily.cjs');

// The CRM's own models (orders-model.js, finance-model.js as on the server 30.09): the summary counts the way Finance Reports does.
const OM = require('../load-crm-model.cjs')('orders-model.js');
const FM = require('../load-crm-model.cjs')('finance-model.js');
const TZ = 'Asia/Jerusalem';

function raw(x) {
  return Object.assign({ ref: 'BF-' + Math.random().toString(36).slice(2, 8), channel: 'shop', paymentMethod: 'crypto', status: 'new',
    customer: { email: 'a@mail.example', firstName: 'Jane' }, shipping: { country: 'US' },
    items: [{ name: 'BPC-157', mg: '10mg', qty: 1, price: 89 }], total: '89.00', subtotal_server: '89.00', total_server: '89.00', total_due_server: '89.00' }, x);
}
function paid(x) {
  const r = raw(Object.assign({ status: 'paid' }, x));
  r.payments = [{ id: 'p-' + r.ref, kind: 'payment', method: 'crypto', amount: Number(r.total_due_server), at: r.savedAt }];
  return r;
}
// 29.09 in Jerusalem (UTC+3) runs from 28.09 21:00Z to 29.09 21:00Z.
const DAY = '2026-09-29';

test('localYmd: the calendar day in the owner\'s time zone, not UTC', () => {
  assert.equal(D.localYmd(Date.parse('2026-09-28T21:30:00Z'), TZ), '2026-09-29');
  assert.equal(D.localYmd(Date.parse('2026-09-29T20:59:00Z'), TZ), '2026-09-29');
  assert.equal(D.localYmd(Date.parse('2026-09-29T21:01:00Z'), TZ), '2026-09-30');
});

test('dueDay: from the set hour, once per day, for the day before; before the hour or already sent: nothing', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(D.dueDay(at('2026-09-30T05:59:00Z'), {}, { tz: TZ, hour: 9 }), null);          // 08:59 local
  assert.equal(D.dueDay(at('2026-09-30T06:20:00Z'), {}, { tz: TZ, hour: 9 }), '2026-09-29');  // 09:20 local
  assert.equal(D.dueDay(at('2026-09-30T15:20:00Z'), { lastDay: '2026-09-29' }, { tz: TZ, hour: 9 }), null);
  assert.equal(D.dueDay(at('2026-09-30T15:20:00Z'), { lastDay: '2026-09-28' }, { tz: TZ, hour: 9 }), '2026-09-29');
});

test('stats: orders, requests, cancelled, paid revenue (Finance Reports rules), new and returning, methods, top items, month', () => {
  const list = [
    paid({ ref: 'BF-OLD', savedAt: '2026-09-10T10:00:00Z', customer: { email: 'ret@mail.example' } }),
    paid({ ref: 'BF-1', savedAt: '2026-09-29T08:00:00Z', customer: { email: 'ret@mail.example' }, total_due_server: '200.00', total: '200.00',
      items: [{ name: 'R3TA', mg: '20mg', qty: 2, price: 100 }] }),
    raw({ ref: 'BF-2', savedAt: '2026-09-28T22:00:00Z', customer: { email: 'new@mail.example' } }),                 // 29.09 01:00 local
    raw({ ref: 'QT-5100', source: 'quote', paymentMethod: 'quote-request', channel: undefined, savedAt: '2026-09-29T12:00:00Z', customer: { email: 'q@mail.example' } }),
    raw({ ref: 'BF-3', status: 'cancelled', savedAt: '2026-09-29T13:00:00Z', customer: { email: 'c@mail.example' } }),
    paid({ ref: 'BLR-1100', source: 'card', paymentMethod: 'card', channel: undefined, test: true, savedAt: '2026-09-29T14:00:00Z' }),   // test: out
    raw({ ref: 'BF-LATE', savedAt: '2026-09-29T21:30:00Z' }),                                                       // 30.09 local: out
    raw({ ref: 'BF-OWN', savedAt: '2026-09-29T10:00:00Z', customer: { email: 'me@team.example' } })                  // our own address: out
  ];
  const s = D.stats(OM.load(list), { day: DAY, tz: TZ, OM, FM, ownAddresses: new Set(['me@team.example']) });
  assert.equal(s.day, DAY);
  assert.equal(s.orders, 3, 'BF-1, BF-2, QT-5100');
  assert.equal(s.requests, 1);
  assert.equal(s.cancelled, 1);
  assert.deepEqual([s.paidOrders, s.revenue, s.average], [1, 200, 200]);
  assert.deepEqual([s.newCustomers, s.returning], [2, 1]);
  assert.deepEqual(s.methods, { crypto: 2, quote: 1 });
  assert.equal(s.top[0].name, 'R3TA 20mg'); assert.equal(s.top[0].units, 2);
  assert.deepEqual([s.month.paidOrders, s.month.revenue], [2, 289]);
});

test('message: small heading, a table, no address or name, a Finance Reports button; an empty day says so', () => {
  const s = { day: DAY, orders: 3, requests: 1, cancelled: 1, paidOrders: 1, revenue: 1200, average: 1200, newCustomers: 2, returning: 1,
    methods: { crypto: 2, quote: 1 }, top: [{ name: 'R3TA 20mg', units: 2 }], month: { paidOrders: 2, revenue: 1289, label: 'September' } };
  const m = D.message(s);
  assert.equal(m.type, 'daily');
  const all = JSON.stringify(m.rich);
  assert.ok(m.rich.blocks[0].type === 'heading' && m.rich.blocks[0].size === 5);
  assert.match(all, /Tue, Sep 29/); assert.match(all, /\$1,200\.00/); assert.match(all, /R3TA 20mg/); assert.match(all, /September/);
  assert.ok(m.rich.blocks.some(b => b.type === 'table' && b.is_compact));
  assert.match(all, /finance-reports\.html/);
  assert.ok(!/mail\.example|Jane/.test(all + m.text));
  assert.match(m.text, /Revenue \(paid\): \$1,200\.00/);
  const empty = D.message(Object.assign({}, s, { orders: 0, requests: 0, cancelled: 0, paidOrders: 0, revenue: 0, average: 0, newCustomers: 0, returning: 0, methods: {}, top: [] }));
  assert.match(JSON.stringify(empty.rich), /No orders/);
});

test('parseDaily: off unless TG_DAILY_MODE=on; hour and zone with defaults; a bad value keeps the default and says so', () => {
  assert.equal(D.parseDaily({}).mode, 'off');
  const c = D.parseDaily({ TG_DAILY_MODE: 'on' });
  assert.deepEqual([c.mode, c.hour, c.tz], ['on', 9, 'Asia/Jerusalem']);
  const bad = D.parseDaily({ TG_DAILY_MODE: 'on', TG_DAILY_HOUR: '25', TG_DAILY_TZ: 'Mars/Base' });
  assert.deepEqual([bad.hour, bad.tz], [9, 'Asia/Jerusalem']);
  assert.equal(bad.problems.length, 2);
});
