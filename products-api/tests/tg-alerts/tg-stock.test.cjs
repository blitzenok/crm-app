'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const S = require('../../tg-stock.cjs');

const OM = require('../load-crm-model.cjs')('orders-model.js');

// The agents' warehouse file (/opt/crm-umg/server/data/inventory.json), trimmed to what the table reads.
function inventory() {
  return {
    skus: [
      { id: 'sku:G3-R-10', code: 'G3-R-10', name: 'G3-R 10mg' },
      { id: 'sku:TES-10', code: 'TES-10', name: 'Tesamorelin 10mg' },
      { id: 'sku:RC02-500', code: 'RC02-500', name: 'RC-02 500mg' },
      { id: 'sku:WOL-10', code: 'WOL-10', name: 'Wolverine 10mg' },
      { id: 'sku:G1-S-10', code: 'G1-S-10', name: 'G1-S 10mg' }
    ],
    inventory_movements: [
      { sku_id: 'sku:G3-R-10', type: 'PO_INTAKE', qty: 100 },
      { sku_id: 'sku:TES-10', type: 'PO_INTAKE', qty: 5 },
      { sku_id: 'sku:RC02-500', type: 'PO_INTAKE', qty: 30 },
      { sku_id: 'sku:WOL-10', type: 'PO_INTAKE', qty: 100 }
    ]
  };
}
// The agents' map (config/rapid-sku-map.draft.json): inventory_code where they set one, product_id otherwise.
const MAP = {
  'g3-r-10mg': { product_id: 'G3-R-10', inventory_code: 'G3-R-10' },
  'tesamorelin-10mg': { product_id: 'RC17-10', inventory_code: 'TES-10' },
  'nad-plus-500mg': { product_id: 'RC02-500' },
  'bpc-157-10mg': { product_id: 'RC06-10' },
  'research-solvent-10ml': { gift: true, internal_id: 'GIFT-01' }
};
let n = 0;
function order(x) {
  n++;
  return Object.assign({ ref: 'BLR-' + (2000 + n), channel: 'shop', status: 'paid', savedAt: '2026-09-29T10:00:00Z',
    customer: { email: 'buyer' + n + '@mail.example' }, items: [{ slug: 'g3-r', name: 'G3-R', mg: '10mg', qty: 2, price: 99 }] }, x);
}
const run = (raws, extra) => S.compute(Object.assign({ inventory: inventory(), map: S.skuMap(MAP, inventory().skus), records: OM.load(raws) }, extra));
const row = (res, code) => res.rows.find(r => r.code === code);

test('skuMap: inventory_code first, product_id only when it is a warehouse SKU, gifts left out', () => {
  const m = S.skuMap(MAP, inventory().skus);
  assert.equal(m.codes.get('g3-r-10mg'), 'G3-R-10');
  assert.equal(m.codes.get('tesamorelin-10mg'), 'TES-10');
  assert.equal(m.codes.get('nad-plus-500mg'), 'RC02-500');
  assert.equal(m.codes.has('bpc-157-10mg'), false);        // RC06-10 is not in the warehouse: not guessed
  assert.ok(m.gifts.has('research-solvent-10ml'));
});

test('shopKey: slug and strength as the map keys them', () => {
  assert.equal(S.shopKey({ slug: 'G3-R', mg: '10 MG' }), 'g3-r-10mg');
  assert.equal(S.shopKey({ slug: 'glow-70', mg: '70mg' }), 'glow-70-70mg');
  assert.equal(S.shopKey({ slug: 'bpc-157', mg: '' }), 'bpc-157');
  assert.equal(S.shopKey({ slug: '', name: 'BPC-157' }), '');
});

test('compute: received from the warehouse, paid orders written off, left = received - sold', () => {
  const res = run([order(), order({ items: [{ slug: 'nad-plus', mg: '500mg', qty: 3 }] })]);
  assert.deepEqual(row(res, 'G3-R-10'), { code: 'G3-R-10', name: 'G3-R 10mg', received: 100, sold: 2, left: 98 });
  assert.deepEqual(row(res, 'RC02-500'), { code: 'RC02-500', name: 'RC-02 500mg', received: 30, sold: 3, left: 27 });
  assert.equal(row(res, 'WOL-10').left, 100);
  assert.equal(row(res, 'G1-S-10').received, 0);
  assert.equal(res.paidOrders, 2);
});

test('compute: every paid status writes off; unpaid, cancelled, refunded, test, duplicate and own-address orders do not', () => {
  const paid = ['paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered', 'Delivered'].map(s => order({ status: s }));
  const not = [
    order({ status: 'new' }), order({ status: 'cancelled' }), order({ status: 'refunded' }), order({ status: 'awaiting payment' }),
    order({ test: true }), order({ ref: 'BF-CIO-TEST-1' }), order({ customer: { email: 'probe-1@biolabsresearch.co' } }),
    order({ customer: { email: 'me@own.example' } })
  ];
  const dup = order();
  const res = run(paid.concat(not, [dup, Object.assign({}, dup)]), { ownAddresses: new Set(['me@own.example']) });
  assert.equal(row(res, 'G3-R-10').sold, 2 * (paid.length + 1));
  assert.equal(res.paidOrders, paid.length + 1);
});

test('compute: a sale beyond the intake goes below zero and is flagged', () => {
  const res = run([order({ items: [{ slug: 'tesamorelin', mg: '10mg', qty: 7 }] })]);
  assert.equal(row(res, 'TES-10').left, -2);
  assert.deepEqual(res.negative, ['TES-10']);
});

test('compute: sold items with no warehouse SKU are listed apart, by item, not guessed; gifts are not stock', () => {
  const res = run([
    order({ items: [{ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty: 2 }, { slug: 'research-solvent', mg: '10ml', qty: 1 }] }),
    order({ items: [{ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty: 1 }, { name: 'Custom blend', qty: 4 }] })
  ]);
  assert.deepEqual(res.unmatched, [{ key: 'custom blend', label: 'Custom blend', sold: 4 }, { key: 'bpc-157-10mg', label: 'BPC-157 10mg', sold: 3 }]);
  assert.equal(res.rows.reduce((s, r) => s + r.sold, 0), 0);
});

test('compute: TG_STOCK_SALES_SINCE leaves out paid orders placed before it', () => {
  const res = run([order({ savedAt: '2026-07-01T00:00:00Z' }), order()], { sinceMs: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(row(res, 'G3-R-10').sold, 2);
});

test('message: title, the table, below zero marked, the unmatched block, update time, button; no note, no order count (owner 30.09)', () => {
  const res = run([order({ items: [{ slug: 'tesamorelin', mg: '10mg', qty: 7 }, { slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty: 1 }] })]);
  const m = S.message(res, { nowMs: Date.parse('2026-09-30T12:05:00Z'), tz: 'Asia/Jerusalem' });
  assert.equal(m.type, 'stock');
  assert.match(m.text, /Stock · calculated/);
  assert.match(m.text, /Tesamorelin 10mg: 5 in − 7 sold = ⚠ -2/);
  assert.match(m.text, /BPC-157 10mg ×1/);
  assert.match(m.text, /Updated Sep 30, 15:05\n/);
  assert.doesNotMatch(m.text, /Not a shelf count|paid order/);
  assert.equal(m.rich.blocks[0].size, 6);
  assert.equal(m.rich.blocks[1].type, 'table');
  const table = m.rich.blocks.find(b => b.type === 'table');
  assert.deepEqual(table.cells[0].map(c => c.text), ['Item', 'In', 'Sold', 'Left']);
  assert.ok(m.rich.blocks.some(b => b.type === 'buttons'));
  assert.equal(m.rich.skip_entity_detection, true);
  assert.ok(m.text.length <= 4096);
});

test('parseStock: off unless on; topic id checked; a bad since date is reported and ignored', () => {
  assert.equal(S.parseStock({}).mode, 'off');
  const c = S.parseStock({ TG_STOCK_MODE: 'on', TG_ALERTS_TOPIC_STOCK: '7', TG_STOCK_SALES_SINCE: '2026-09-01' });
  assert.equal(c.mode, 'on'); assert.equal(c.topic, 7); assert.equal(c.sinceMs, Date.parse('2026-09-01'));
  const bad = S.parseStock({ TG_STOCK_MODE: 'on', TG_ALERTS_TOPIC_STOCK: 'x', TG_STOCK_SALES_SINCE: 'soon' });
  assert.equal(bad.topic, null); assert.ok(Number.isNaN(bad.sinceMs)); assert.equal(bad.problems.length, 2);
});

// ---- publish: edit the pinned message; gone -> send a new one and pin it ----
function fakeTelegram(answer) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const method = req.url.split('/').pop();
        seen.push({ method, body: JSON.parse(body) });
        const [status, json] = answer(method, seen.length);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ seen, base: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() }));
  });
}
const msg = () => S.message(run([order()]), { nowMs: Date.now(), tz: 'Asia/Jerusalem' });
const cfgFor = (t) => ({ token: '123:T', chatId: '-100', apiBase: t.base, topics: { stock: 7 } });
const publishP = (cfg, state, m) => new Promise(r => S.publish(cfg, state, m, r));

test('publish: a known message is edited in place, rich, no new message and no pin', async () => {
  const t = await fakeTelegram(() => [200, { ok: true, result: { message_id: 55 } }]);
  const r = await publishP(cfgFor(t), { messageId: 55, chatId: '-100' }, msg());
  t.close();
  assert.equal(r.ok, true); assert.equal(r.action, 'edited'); assert.equal(r.messageId, 55);
  assert.deepEqual(t.seen.map(x => x.method), ['editMessageText']);
  assert.equal(t.seen[0].body.message_id, 55);
  assert.ok(t.seen[0].body.rich_message.blocks.length);
});

test('publish: "not modified" counts as done', async () => {
  const t = await fakeTelegram(() => [400, { ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' }]);
  const r = await publishP(cfgFor(t), { messageId: 55, chatId: '-100' }, msg());
  t.close();
  assert.equal(r.ok, true); assert.equal(r.action, 'unchanged');
});

test('publish: the message was deleted -> a new one in the stock topic, pinned silently', async () => {
  const t = await fakeTelegram((m) => m === 'editMessageText' ? [400, { ok: false, description: 'Bad Request: message to edit not found' }]
    : [200, { ok: true, result: m === 'pinChatMessage' ? true : { message_id: 77 } }]);
  const r = await publishP(cfgFor(t), { messageId: 55, chatId: '-100' }, msg());
  t.close();
  assert.deepEqual(t.seen.map(x => x.method), ['editMessageText', 'sendRichMessage', 'pinChatMessage']);
  assert.equal(t.seen[1].body.message_thread_id, 7);
  assert.deepEqual(t.seen[2].body, { chat_id: '-100', message_id: 77, disable_notification: true });
  assert.equal(r.ok, true); assert.equal(r.action, 'sent'); assert.equal(r.messageId, 77); assert.equal(r.pinned, true);
});

test('publish: no state, or another chat -> send and pin; a refused pin keeps the message and says so', async () => {
  const t = await fakeTelegram((m) => m === 'pinChatMessage' ? [400, { ok: false, description: 'Bad Request: not enough rights to manage pinned messages in the chat' }]
    : [200, { ok: true, result: { message_id: 90 } }]);
  const r = await publishP(cfgFor(t), { messageId: 55, chatId: '-999' }, msg());
  t.close();
  assert.deepEqual(t.seen.map(x => x.method), ['sendRichMessage', 'pinChatMessage']);
  assert.equal(r.ok, true); assert.equal(r.messageId, 90); assert.equal(r.pinned, false); assert.match(r.pinError, /not enough rights/);
});

test('publish: rich refused on edit -> the same edit as plain text', async () => {
  const t = await fakeTelegram((m, i) => i === 1 ? [400, { ok: false, description: 'Bad Request: can\'t parse rich message' }] : [200, { ok: true, result: { message_id: 55 } }]);
  const r = await publishP(cfgFor(t), { messageId: 55, chatId: '-100' }, msg());
  t.close();
  assert.deepEqual(t.seen.map(x => x.method), ['editMessageText', 'editMessageText']);
  assert.equal(typeof t.seen[1].body.text, 'string'); assert.equal(t.seen[1].body.rich_message, undefined);
  assert.equal(r.ok, true); assert.match(r.richRefused, /rich/);
});

test('publish: Telegram down -> not ok, state untouched by the caller', async () => {
  const t = await fakeTelegram(() => [502, { ok: false, description: 'Bad Gateway' }]);
  const r = await publishP(cfgFor(t), { messageId: 55, chatId: '-100' }, msg());
  t.close();
  assert.equal(r.ok, false); assert.equal(r.status, 502);
});

// ---- alerts: new stock, running low, out of stock ----
const R = (code, received, left) => ({ code, name: code + ' name', received, sold: received - left, left });

test('parseStock: low-stock percent, default 20, 0 turns low alerts off, junk reported', () => {
  assert.equal(S.parseStock({}).lowPct, 20);
  assert.equal(S.parseStock({ TG_STOCK_LOW_PCT: '10' }).lowPct, 10);
  assert.equal(S.parseStock({ TG_STOCK_LOW_PCT: '0' }).lowPct, 0);
  const bad = S.parseStock({ TG_STOCK_LOW_PCT: '150' });
  assert.equal(bad.lowPct, 20); assert.equal(bad.problems.length, 1);
});

test('stockEvents: the first run only remembers the figures, no alerts', () => {
  const e = S.stockEvents([R('A', 100, 10), R('B', 0, 0)], undefined, 20);
  assert.deepEqual(e.intakes, []); assert.deepEqual(e.low, []);
  assert.deepEqual(e.next.received, { A: 100, B: 0 });
  assert.deepEqual(e.next.peak, { A: 10, B: 0 });
  assert.deepEqual(e.next.level, { A: 'ok', B: 'none' });
});

test('stockEvents: an intake is announced with what came and what is there now; the level starts over', () => {
  const prev = S.stockEvents([R('A', 100, 5), R('B', 0, 0)], undefined, 20).next;
  prev.level.A = 'low';
  const e = S.stockEvents([R('A', 130, 35), R('B', 10, 10), R('C', 20, 20)], prev, 20);
  assert.deepEqual(e.intakes.map(x => [x.code, x.added, x.left]), [['A', 30, 35], ['B', 10, 10], ['C', 20, 20]]);
  assert.deepEqual(e.low, []);
  assert.equal(e.next.peak.A, 35); assert.equal(e.next.level.A, 'ok');
});

test('stockEvents: running low below the percent of what was there after the last intake, once; out of stock, once', () => {
  let st = S.stockEvents([R('A', 100, 100), R('B', 50, 50)], undefined, 20).next;
  let e = S.stockEvents([R('A', 100, 21), R('B', 50, 50)], st, 20);
  assert.deepEqual(e.low, []);
  e = S.stockEvents([R('A', 100, 20), R('B', 50, 50)], e.next, 20);
  assert.deepEqual(e.low.map(x => [x.code, x.left, x.peak, x.out]), [['A', 20, 100, false]]);
  e = S.stockEvents([R('A', 100, 12), R('B', 50, 50)], e.next, 20);
  assert.deepEqual(e.low, []);                                   // already told
  e = S.stockEvents([R('A', 100, 0), R('B', 50, -3)], e.next, 20);
  assert.deepEqual(e.low.map(x => [x.code, x.out]), [['A', true], ['B', true]]);
  e = S.stockEvents([R('A', 100, 0), R('B', 50, -3)], e.next, 20);
  assert.deepEqual(e.low, []);
});

test('stockEvents: a cancelled order brings stock back above the line -> it can warn again later', () => {
  let e = S.stockEvents([R('A', 100, 100)], undefined, 20);
  e = S.stockEvents([R('A', 100, 15)], e.next, 20);
  assert.equal(e.low.length, 1);
  e = S.stockEvents([R('A', 100, 60)], e.next, 20);
  assert.equal(e.next.level.A, 'ok'); assert.equal(e.next.peak.A, 100);
  e = S.stockEvents([R('A', 100, 10)], e.next, 20);
  assert.equal(e.low.length, 1);
});

test('stockEvents: percent 0 = no low alerts, out of stock still told', () => {
  let e = S.stockEvents([R('A', 100, 100)], undefined, 0);
  e = S.stockEvents([R('A', 100, 1)], e.next, 0);
  assert.deepEqual(e.low, []);
  e = S.stockEvents([R('A', 100, 0)], e.next, 0);
  assert.deepEqual(e.low.map(x => x.out), [true]);
});

test('alertMessage: nothing to say -> null; intake and low in one message, rich and plain', () => {
  assert.equal(S.alertMessage({ intakes: [], low: [] }), null);
  const m1 = S.alertMessage({ intakes: [{ code: 'A', name: 'G3-R 10mg', added: 30, left: 35 }], low: [] });
  assert.match(m1.text, /^📥 New stock/); assert.match(m1.text, /G3-R 10mg: \+30, now 35/);
  const m2 = S.alertMessage({ intakes: [], low: [{ code: 'B', name: 'GLOW', left: 8, peak: 50, out: false }, { code: 'C', name: 'TES', left: 0, peak: 100, out: true }] });
  assert.match(m2.text, /^⚠️ Stock running low/); assert.match(m2.text, /GLOW: 8 left of 50 \(16%\)/); assert.match(m2.text, /TES: out of stock/);
  const m3 = S.alertMessage({ intakes: [{ code: 'A', name: 'X', added: 1, left: 1 }], low: [{ code: 'B', name: 'Y', left: 0, peak: 5, out: true }] });
  assert.match(m3.text, /^📦 Stock update/);
  assert.equal(m3.type, 'stock'); assert.equal(m3.rich.skip_entity_detection, true); assert.equal(m3.rich.blocks[0].size, 6);
});
