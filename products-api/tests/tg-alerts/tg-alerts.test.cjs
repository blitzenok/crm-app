'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const A = require('../../tg-alerts.cjs');

const SINCE = Date.parse('2026-09-30T12:00:00Z');
const ENV_ON = { TG_ALERTS_MODE: 'on', TG_ALERTS_SINCE: '2026-09-30T12:00:00Z', TG_ALERTS_BOT_TOKEN: '123:SECRETTOKEN', TG_ALERTS_CHAT_ID: '-100500' };
function cfgOn(extra) {
  const c = A.parseConfig(ENV_ON);
  c.isTestOrder = (o) => o.test === true;
  c.isExcluded = (email) => /@probe\.example$/.test(email);
  return Object.assign(c, extra || {});
}
function shopOrder(extra) {
  return Object.assign({
    ref: 'BF-AAA-111', channel: 'shop', paymentMethod: 'crypto', status: 'new', savedAt: '2026-09-30T13:00:00Z',
    customer: { firstName: 'Jane', lastName: 'Roe', email: 'jane.roe@mail.example', phone: '+1 555 0100' },
    shipping: { address1: '1 Secret Lane', city: 'Austin', state: 'TX', zip: '73301', country: 'US' },
    items: [{ name: 'R3TA', mg: '20mg', qty: 2, price: 139 }, { name: 'Research solvent (BAC water)', mg: '10mL', qty: 1, price: 0 }],
    total: '278.00', total_due_server: '208.50'
  }, extra || {});
}
function cardOrder(extra) {
  return shopOrder(Object.assign({ ref: 'BLR-1031', channel: undefined, source: 'card', paymentMethod: 'card', status: 'paid' }, extra || {}));
}

test('parseConfig: nothing set is off, quietly', () => {
  const c = A.parseConfig({});
  assert.strictEqual(c.mode, 'off');
  assert.deepStrictEqual(c.problems, []);
});
test('parseConfig: on needs since, token and chat id; each missing one turns it off with a reason', () => {
  for (const k of ['TG_ALERTS_SINCE', 'TG_ALERTS_BOT_TOKEN', 'TG_ALERTS_CHAT_ID']) {
    const env = Object.assign({}, ENV_ON); delete env[k];
    const c = A.parseConfig(env);
    assert.strictEqual(c.mode, 'off', k);
    assert.ok(c.problems.some(p => p.includes(k)), k);
  }
  assert.strictEqual(A.parseConfig(Object.assign({}, ENV_ON, { TG_ALERTS_MODE: 'yes' })).mode, 'off');
});
test('parseConfig: big-order threshold defaults to 500, a bad value keeps 500 and says so', () => {
  assert.strictEqual(A.parseConfig(ENV_ON).bigUsd, 500);
  assert.strictEqual(A.parseConfig(Object.assign({}, ENV_ON, { TG_ALERTS_BIG_USD: '750' })).bigUsd, 750);
  const bad = A.parseConfig(Object.assign({}, ENV_ON, { TG_ALERTS_BIG_USD: 'lots' }));
  assert.strictEqual(bad.bigUsd, 500);
  assert.ok(bad.problems.length);
});
test('parseConfig: the token never appears in problems', () => {
  const c = A.parseConfig(Object.assign({}, ENV_ON, { TG_ALERTS_SINCE: 'soon' }));
  assert.ok(!JSON.stringify(c.problems).includes('SECRETTOKEN'));
});

test('alertAllowed: a real shop order and a card import get the new-order alert', () => {
  assert.deepStrictEqual(A.alertAllowed(shopOrder(), 'order', cfgOn()), { ok: true });
  assert.deepStrictEqual(A.alertAllowed(cardOrder(), 'order', cfgOn()), { ok: true });
  assert.deepStrictEqual(A.alertAllowed(shopOrder({ ref: 'QT-5022', channel: undefined, source: 'quote', paymentMethod: 'quote-request' }), 'order', cfgOn()), { ok: true });
});
test('alertAllowed: off, tests, our probe addresses, old orders and repeats never go', () => {
  const reason = (o, t, c) => A.alertAllowed(o, t, c || cfgOn()).reason;
  assert.strictEqual(reason(shopOrder(), 'order', A.parseConfig({})), 'mode_off');
  assert.strictEqual(reason(shopOrder({ test: true }), 'order'), 'test_order');
  assert.strictEqual(reason(shopOrder({ notes: 'TEST ORDER please ignore' }), 'order'), 'test_note');
  assert.strictEqual(reason(shopOrder({ customer: { email: 'x@probe.example' } }), 'order'), 'excluded');
  assert.strictEqual(reason(shopOrder({ savedAt: '2026-09-30T11:59:59Z' }), 'order'), 'before_since');
  assert.strictEqual(reason(shopOrder({ savedAt: undefined }), 'order'), 'no_date');
  assert.strictEqual(reason(shopOrder({ alerts: { order: { sentAt: '2026-09-30T13:01:00Z' } } }), 'order'), 'already_sent');
  assert.strictEqual(reason(shopOrder(), 'nope'), 'bad_type');
});
test('alertAllowed: an order without an address is not treated as excluded', () => {
  assert.deepStrictEqual(A.alertAllowed(shopOrder({ customer: {} }), 'order', cfgOn()), { ok: true });
});
test('alertAllowed: a wholesale order typed into the CRM gets no new-order alert, but its payment does', () => {
  const ms = shopOrder({ ref: 'MS-77', channel: undefined, paymentMethod: 'wire', status: 'paid' });
  assert.strictEqual(A.alertAllowed(ms, 'order', cfgOn()).reason, 'not_shop');
  assert.deepStrictEqual(A.alertAllowed(ms, 'paid', cfgOn()), { ok: true });
});
test('alertAllowed: a cancelled order gets no new-order alert', () => {
  assert.strictEqual(A.alertAllowed(shopOrder({ status: 'cancelled' }), 'order', cfgOn()).reason, 'cancelled');
});
test('alertAllowed paid: only in a paid status; never left to the order alert (that one may never go: review 30.09)', () => {
  assert.strictEqual(A.alertAllowed(shopOrder({ status: 'new' }), 'paid', cfgOn()).reason, 'not_paid');
  assert.deepStrictEqual(A.alertAllowed(shopOrder({ status: 'paid' }), 'paid', cfgOn()), { ok: true });
  assert.strictEqual(A.alertAllowed(shopOrder({ status: 'paid', alerts: { paid: { sentAt: 'x' } } }), 'paid', cfgOn()).reason, 'already_sent');
  const announced = shopOrder({ status: 'paid', alerts: { order: { sentAt: '2026-09-30T13:01:00Z' } } });
  assert.deepStrictEqual(A.alertAllowed(announced, 'paid', cfgOn()), { ok: true });
  for (const s of ['payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered']) {
    assert.deepStrictEqual(A.alertAllowed(Object.assign({}, announced, { status: s }), 'paid', cfgOn()), { ok: true }, s);
  }
});
test('coveredTypes: a new-order alert for an order already paid (card import) is its payment alert too: one message', () => {
  assert.deepStrictEqual(A.coveredTypes(cardOrder(), 'order'), ['order', 'paid']);
  assert.deepStrictEqual(A.coveredTypes(shopOrder(), 'order'), ['order']);
  assert.deepStrictEqual(A.coveredTypes(shopOrder({ status: 'paid' }), 'paid'), ['paid']);
});
test('markAlert keeps other marks and survives junk in the field', () => {
  const o = shopOrder({ alerts: 'junk' });
  A.markAlert(o, 'order', { sentAt: 'T1' });
  A.markAlert(o, 'paid', { sentAt: 'T2' });
  assert.deepStrictEqual(o.alerts, { order: { sentAt: 'T1' }, paid: { sentAt: 'T2' } });
});

test('priorPaidCount: same address, paid, real, earlier, not itself', () => {
  const me = shopOrder({ ref: 'BF-NOW', savedAt: '2026-09-30T13:00:00Z' });
  const all = [
    me,
    shopOrder({ ref: 'BF-1', status: 'delivered', savedAt: '2026-09-01T00:00:00Z', customer: { email: 'JANE.ROE@mail.example ' } }),
    shopOrder({ ref: 'BF-2', status: 'paid', savedAt: '2026-09-02T00:00:00Z' }),
    shopOrder({ ref: 'BF-3', status: 'cancelled', savedAt: '2026-09-03T00:00:00Z' }),
    shopOrder({ ref: 'BF-4', status: 'paid', test: true, savedAt: '2026-09-04T00:00:00Z' }),
    shopOrder({ ref: 'BF-5', status: 'paid', savedAt: '2026-10-01T00:00:00Z' }),
    shopOrder({ ref: 'BF-6', status: 'paid', savedAt: '2026-09-05T00:00:00Z', customer: { email: 'other@mail.example' } }),
    null, 'junk'
  ];
  assert.strictEqual(A.priorPaidCount(me, all, (o) => o.test === true), 2);
  assert.strictEqual(A.priorPaidCount(shopOrder({ customer: {} }), all, (o) => o.test === true), 0);
});

const PII = ['Jane', 'Roe', 'jane.roe', 'mail.example', '555', 'Secret Lane', 'Austin', '73301'];
test('orderText: no name, address, phone or e-mail; number, sum, method, country, items and a CRM link', () => {
  const t = A.orderText(shopOrder(), { priorPaid: 0, bigUsd: 500 });
  for (const p of PII) assert.ok(!t.includes(p), 'leaks ' + p + ':\n' + t);
  assert.match(t, /New order BF-AAA-111/);
  assert.match(t, /crypto, waiting for the transfer/);
  assert.match(t, /\$208\.50/);
  assert.match(t, /\bUS\b/);
  assert.match(t, /R3TA 20mg ×2/);
  assert.match(t, /https:\/\/crm\.biolabsresearch\.co\/crm\/orders\.html#q=BF-AAA-111/);
  assert.ok(!/Returning|Big order/.test(t));
});
test('orderText: card import says paid; a price request says so; crypto from the import says verified', () => {
  assert.match(A.orderText(cardOrder(), {}), /New order BLR-1031 · paid by card/);
  assert.match(A.orderText(shopOrder({ ref: 'QT-5022', channel: undefined, source: 'quote', paymentMethod: 'quote-request' }), {}), /Price request QT-5022/);
  const cr = shopOrder({ ref: 'CR-ABCD1234', source: 'crypto', status: 'paid', payments: [{ id: 'crypto:CR-ABCD1234', by: 'card-import', kind: 'payment' }] });
  assert.match(A.orderText(cr, {}), /paid in crypto, verified on the chain/);
});
test('orderText: returning customer and big order tags', () => {
  const t = A.orderText(shopOrder({ total_due_server: '1250.00' }), { priorPaid: 2, bigUsd: 500 });
  assert.match(t, /Returning customer · 2 paid orders before/);
  assert.match(t, /Big order · \$1,250\.00/);
  assert.match(A.orderText(shopOrder(), { priorPaid: 1 }), /1 paid order before/);
});
test('orderText: the amount falls back from a zero server figure to the order total', () => {
  assert.match(A.orderText(shopOrder({ total_due_server: '0.00', total: '158' }), {}), /\$158\.00/);
});
test('orderText: text from the order cannot break lines, carry an address or run on', () => {
  const o = shopOrder({ ref: 'BF-X\nFAKE: paid', shipping: { country: 'US\u0000\nPAID' },
    items: [{ name: 'Evil\nline mail me@evil.example', qty: 1 }].concat(Array.from({ length: 40 }, (_, i) => ({ name: 'Peptide number ' + i, mg: '5mg', qty: 1 }))) });
  const t = A.orderText(o, {});
  assert.ok(!t.includes('evil.example'));
  assert.ok(!/\u0000/.test(t));
  assert.ok(t.split('\n').every(l => l.length <= 400), t);
  assert.ok(!/^FAKE/m.test(t) && !/^PAID/m.test(t), t);
  assert.ok(t.length < 1200);
});
test('paidText: says who confirmed the money', () => {
  const manual = A.paidText(shopOrder({ status: 'paid', paymentMethod: 'crypto' }), {});
  assert.match(manual, /Payment received · BF-AAA-111 · \$208\.50/);
  assert.match(manual, /marked paid in CRM/);
  for (const p of PII) assert.ok(!manual.includes(p), p);
  const shipped = A.paidText(shopOrder({ status: 'shipped' }), {});
  assert.match(shipped, /marked shipped in CRM/);
  const verified = A.paidText(shopOrder({ status: 'paid', payments: [{ id: 'crypto:BF-AAA-111', by: 'card-import', kind: 'payment' }] }), {});
  assert.match(verified, /verified on the chain/);
});

function fakeTelegram(handler) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push({ url: req.url, body: JSON.parse(raw) });
        const [status, json] = handler(seen.length, req.url, JSON.parse(raw));
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}
const sendP = (cfg, msg) => new Promise(r => A.send(cfg, msg, r));
const MSG = { type: 'order', text: 'hello <b>&', rich: { blocks: [{ type: 'paragraph', text: 'hello' }], skip_entity_detection: true } };

test('send: the rich message to the configured chat, ok on 200', async () => {
  const t = await fakeTelegram(() => [200, { ok: true, result: {} }]);
  try {
    const r = await sendP(Object.assign(cfgOn(), { apiBase: t.base }), MSG);
    assert.deepStrictEqual(r, { ok: true, status: 200, messageId: undefined, topic: null });
    assert.strictEqual(t.seen.length, 1);
    assert.strictEqual(t.seen[0].url, '/bot123:SECRETTOKEN/sendRichMessage');
    assert.deepStrictEqual(t.seen[0].body, { chat_id: '-100500', rich_message: MSG.rich });
  } finally { t.srv.close(); }
});
test('send: a rich message Telegram refuses (400) goes out as plain text and says why', async () => {
  const t = await fakeTelegram((n, url) => url.endsWith('/sendRichMessage') ? [400, { ok: false, description: 'Bad Request: can\'t parse rich message' }] : [200, { ok: true }]);
  try {
    const r = await sendP(Object.assign(cfgOn(), { apiBase: t.base }), MSG);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.status, 200);
    assert.match(r.richRefused, /can't parse rich message/);
    assert.strictEqual(t.seen[1].url, '/bot123:SECRETTOKEN/sendMessage');
    assert.deepStrictEqual(t.seen[1].body, { chat_id: '-100500', text: 'hello <b>&', link_preview_options: { is_disabled: true } });
  } finally { t.srv.close(); }
});
test('send: 429 and 5xx are failures the queue retries, no plain-text second try; the token is never in the error', async () => {
  const t = await fakeTelegram(n => n === 1 ? [429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } }] : [502, { ok: false }]);
  try {
    const cfg = Object.assign(cfgOn(), { apiBase: t.base });
    const a = await sendP(cfg, MSG);
    assert.strictEqual(a.ok, false); assert.strictEqual(a.status, 429);
    const b = await sendP(cfg, MSG);
    assert.strictEqual(b.status, 502);
    assert.strictEqual(t.seen.length, 2);
    assert.ok(!JSON.stringify([a, b]).includes('SECRETTOKEN'));
  } finally { t.srv.close(); }
});
test('send: a group that became a supergroup names the new id, no plain-text try', async () => {
  const t = await fakeTelegram(() => [400, { ok: false, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100777 } }]);
  try {
    const r = await sendP(Object.assign(cfgOn(), { apiBase: t.base }), MSG);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 400);
    assert.match(r.error, /TG_ALERTS_CHAT_ID=-100777/);
    assert.strictEqual(t.seen.length, 1);
  } finally { t.srv.close(); }
});
test('send: a 200 whose body cannot be read is still delivered (never retried into a duplicate)', async () => {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('not json'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await sendP(Object.assign(cfgOn(), { apiBase: 'http://127.0.0.1:' + srv.address().port }), MSG);
    assert.strictEqual(r.ok, true);
  } finally { srv.close(); }
});
test('send: nobody listening is a failure with no status, token not in the error', async () => {
  const r = await sendP(Object.assign(cfgOn(), { apiBase: 'http://127.0.0.1:1' }), MSG);
  assert.strictEqual(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('SECRETTOKEN'));
});

// Rich layout: blocks only (no html/markdown string), so text from the order is data and never markup.
function allText(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(allText).join(' ');
  if (node && typeof node === 'object') return Object.keys(node).filter(k => k !== 'type' && k !== 'align' && k !== 'valign' && k !== 'style').map(k => allText(node[k])).join(' ');
  return '';
}
test('richFor order: heading, status, a compact table, the items, tags and a CRM button', () => {
  const card = cardOrder({ total_due_server: '640.00' });
  const m = A.richFor(card, 'order', { priorPaid: 2, bigUsd: 500 });
  assert.deepStrictEqual(Object.keys(m).sort(), ['blocks', 'skip_entity_detection']);
  assert.strictEqual(m.skip_entity_detection, true);
  const types = m.blocks.map(b => b.type);
  assert.strictEqual(types[0], 'heading');
  assert.ok(types.includes('table'));
  assert.strictEqual(types[types.length - 1], 'buttons');
  const all = allText(m);
  assert.match(all, /New order/); assert.match(all, /BLR-1031/); assert.match(all, /paid by card/);
  assert.match(all, /\$640\.00/); assert.match(all, /R3TA 20mg/); assert.match(all, /×2/);
  assert.match(all, /Returning customer · 2 paid orders before/); assert.match(all, /Big order/);
  const btn = m.blocks[m.blocks.length - 1].buttons[0];
  assert.strictEqual(btn.url, 'https://crm.biolabsresearch.co/crm/orders.html#q=BLR-1031');
  for (const p of PII) assert.ok(!all.includes(p), 'leaks ' + p);
  for (const b of m.blocks.filter(x => x.type === 'table')) {
    assert.strictEqual(b.is_compact, true);
    for (const row of b.cells) for (const c of row) { assert.ok(['left', 'center', 'right'].includes(c.align)); assert.ok(['top', 'middle', 'bottom'].includes(c.valign)); }
  }
});
test('richFor paid: says who confirmed the money; many items are cut with a count', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: 'Peptide ' + i, mg: '5mg', qty: 1 }));
  const m = A.richFor(shopOrder({ status: 'paid', items: many }), 'paid', {});
  const all = allText(m);
  assert.match(all, /Payment received/); assert.match(all, /marked paid in CRM/);
  assert.match(all, /\+15 more/);
  assert.ok(!all.includes('Peptide 12'));
  assert.ok(JSON.stringify(m).length < 8000);
});
test('richFor: order text cannot inject markup or addresses (blocks carry plain strings)', () => {
  const m = A.richFor(shopOrder({ items: [{ name: '<b>x</b> [a](https://evil.example) me@evil.example', qty: 1 }] }), 'order', {});
  const all = allText(m);
  assert.ok(!all.includes('evil.example/') && !all.includes('me@evil'));
  assert.ok(!JSON.stringify(m).includes('"html"') && !JSON.stringify(m).includes('"markdown"'));
});
test('message: both forms for one alert, and its type (it picks the topic)', () => {
  const msg = A.messageFor(cardOrder(), 'order', {});
  assert.strictEqual(msg.type, 'order');
  assert.strictEqual(A.messageFor(cardOrder(), 'paid', {}).type, 'paid');
  assert.match(msg.text, /New order BLR-1031/);
  assert.ok(Array.isArray(msg.rich.blocks));
});

test('kinds: one queue kind per alert type, and back', () => {
  assert.deepStrictEqual(A.KINDS, ['tg_order', 'tg_paid']);
  assert.strictEqual(A.typeForKind('tg_paid'), 'paid');
  assert.strictEqual(A.typeForKind('mail_manager'), null);
});

// Review 30.09: the sum and the "big order" tag must not rest on a figure the browser made up.
test('amount: a price the catalog could not confirm gets no big tag and a warning instead', () => {
  for (const x of [{ price_mismatch: true }, { unknown_items: ['Fake'] }, { price_check: 'skipped' }]) {
    const t = A.orderText(shopOrder(Object.assign({ total_due_server: '0.00', total: '99999' }, x)), { bigUsd: 500 });
    assert.ok(!/Big order/.test(t), t);
    assert.match(t, /Amount not verified/);
  }
  assert.ok(!/Amount not verified/.test(A.orderText(shopOrder(), {})));
});
test('amount: a card order shows what was charged, and says so when it differs from what was due', () => {
  const ok = cardOrder({ total_due_server: '120.00', charge_check: { charged: '120.00', expected: '120.00', diff: '0.00', result: 'match' } });
  assert.match(A.orderText(ok, {}), /\$120\.00/);
  assert.ok(!/Charged/.test(A.orderText(ok, {})));
  const under = cardOrder({ total_due_server: '120.00', charge_check: { charged: '80.00', expected: '120.00', diff: '40.00', result: 'under' } });
  const t = A.orderText(under, { bigUsd: 50 });
  assert.match(t, /\$80\.00/);
  assert.match(t, /Card charge under: charged \$80\.00, due \$120\.00/);
  assert.ok(!/Big order/.test(t));
});
test('text: the order number keeps only order-number characters; direction-flipping characters are gone', () => {
  const t = A.orderText(shopOrder({ ref: 'BF-1 https://evil.example/x\u202e' }), {});
  assert.match(t, /New order BF-1httpsevil\.examplex/);
  assert.ok(!/\u202e|\u2066/.test(A.orderText(shopOrder({ items: [{ name: 'A\u202eB\u2066C', qty: 1 }] }), {})));
});

test('our own test recipients (ORDER_LETTERS_TEST_TO, EMAIL_TEST_TO) are never announced', () => {
  const c = A.parseConfig(Object.assign({}, ENV_ON, { ORDER_LETTERS_TEST_TO: 'Me@Team.example, x@y.example', EMAIL_TEST_TO: 'qa@team.example' }));
  assert.strictEqual(A.alertAllowed(shopOrder({ customer: { email: 'me@team.example' } }), 'order', c).reason, 'own_test_address');
  assert.strictEqual(A.alertAllowed(shopOrder({ customer: { email: 'QA@team.example' } }), 'order', c).reason, 'own_test_address');
  assert.deepStrictEqual(A.alertAllowed(shopOrder(), 'order', c), { ok: true });
});

// Topics (30.09): each alert type goes to its own topic of the forum group; no topic set = the General chat, as before.
test('parseConfig: topic ids per type; a bad one is ignored with a reason', () => {
  const c = A.parseConfig(Object.assign({}, ENV_ON, { TG_ALERTS_TOPIC_ORDER: '12', TG_ALERTS_TOPIC_PAID: ' 34 ' }));
  assert.deepStrictEqual(c.topics, { order: 12, paid: 34 });
  assert.deepStrictEqual(A.parseConfig(ENV_ON).topics, {});
  const bad = A.parseConfig(Object.assign({}, ENV_ON, { TG_ALERTS_TOPIC_PAID: 'payments' }));
  assert.deepStrictEqual(bad.topics, {});
  assert.ok(bad.problems.some(p => p.includes('TG_ALERTS_TOPIC_PAID')));
  assert.strictEqual(bad.mode, 'on', 'a bad topic does not switch alerts off');
});
test('send: the message goes to the topic of its type, both forms', async () => {
  const t = await fakeTelegram((n, url) => url.endsWith('/sendRichMessage') ? [400, { ok: false, description: 'Bad Request: rich' }] : [200, { ok: true }]);
  try {
    const cfg = Object.assign(cfgOn(), { apiBase: t.base, topics: { order: 12, paid: 34 } });
    const r = await sendP(cfg, Object.assign({}, MSG, { type: 'paid' }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(t.seen[0].body.message_thread_id, 34);
    assert.strictEqual(t.seen[1].body.message_thread_id, 34);
  } finally { t.srv.close(); }
});
test('send: a topic Telegram no longer knows still delivers the alert, to General, and says so', async () => {
  const t = await fakeTelegram((n, url, body) => (body.message_thread_id ? [400, { ok: false, description: 'Bad Request: message thread not found' }] : [200, { ok: true }]));
  try {
    const r = await sendP(Object.assign(cfgOn(), { apiBase: t.base, topics: { order: 12 } }), MSG);
    assert.strictEqual(r.ok, true);
    assert.match(r.richRefused, /topic 12/);
    assert.match(r.richRefused, /message thread not found/);
    const last = t.seen[t.seen.length - 1];
    assert.strictEqual(last.body.message_thread_id, undefined);
  } finally { t.srv.close(); }
});
test('send: without a topic nothing about threads is sent', async () => {
  const t = await fakeTelegram(() => [200, { ok: true }]);
  try {
    await sendP(Object.assign(cfgOn(), { apiBase: t.base }), MSG);
    assert.ok(!('message_thread_id' in t.seen[0].body));
  } finally { t.srv.close(); }
});

// Option B (owner 30.09): orders and payments share a topic; a payment is a reply to its order's message.
test('sentRecord: what a sent alert keeps for the reply: message id, chat, topic', () => {
  const rec = A.sentRecord({ ok: true, status: 200, messageId: 77, topic: 2 }, { chatId: '-100500' });
  assert.ok(rec.sentAt);
  assert.deepStrictEqual(Object.assign({}, rec, { sentAt: 'x' }), { sentAt: 'x', messageId: 77, chatId: '-100500', topic: 2 });
  const general = A.sentRecord({ ok: true, messageId: 5, topic: null }, { chatId: '-1' });
  assert.ok(!('topic' in general));
});
test('messageFor paid: a reply to the order message when there is one; compact (no items, no tags)', () => {
  const o = shopOrder({ status: 'paid', alerts: { order: { sentAt: 'x', messageId: 77, chatId: '-100500', topic: 2 } } });
  const m = A.messageFor(o, 'paid', { priorPaid: 3, bigUsd: 1 });
  assert.deepStrictEqual(m.replyTo, { messageId: 77, chatId: '-100500', topic: 2 });
  const all = JSON.stringify(m.rich);
  assert.match(all, /Payment received/);
  assert.ok(!/R3TA|Returning|Big order/.test(all), all);
  assert.ok(!/Returning|R3TA/.test(m.text));
  const alone = A.messageFor(shopOrder({ status: 'paid' }), 'paid', { priorPaid: 3 });
  assert.strictEqual(alone.replyTo, undefined);
  assert.match(JSON.stringify(alone.rich), /R3TA/, 'without an order message the payment alert carries the whole order');
});
test('send: a reply goes to its order message, in that message\'s topic; the id of the sent message comes back', async () => {
  const t = await fakeTelegram(() => [200, { ok: true, result: { message_id: 91 } }]);
  try {
    const cfg = Object.assign(cfgOn(), { apiBase: t.base, topics: { order: 2, paid: 9 } });
    const r = await sendP(cfg, Object.assign({}, MSG, { type: 'paid', replyTo: { messageId: 77, chatId: '-100500', topic: 2 } }));
    assert.deepStrictEqual(r, { ok: true, status: 200, messageId: 91, topic: 2 });
    assert.deepStrictEqual(t.seen[0].body.reply_parameters, { message_id: 77, allow_sending_without_reply: true });
    assert.strictEqual(t.seen[0].body.message_thread_id, 2);
  } finally { t.srv.close(); }
});
test('send: an order message from another chat (the group was re-created) is not replied to', async () => {
  const t = await fakeTelegram(() => [200, { ok: true, result: { message_id: 92 } }]);
  try {
    const cfg = Object.assign(cfgOn(), { apiBase: t.base, topics: { paid: 2 } });
    const r = await sendP(cfg, Object.assign({}, MSG, { type: 'paid', replyTo: { messageId: 77, chatId: '-5416544093' } }));
    assert.strictEqual(r.topic, 2);
    assert.ok(!('reply_parameters' in t.seen[0].body));
  } finally { t.srv.close(); }
});
test('send: the plain-text fallback keeps the reply; the General fallback drops it (the order message is in the topic)', async () => {
  const t = await fakeTelegram((n, url, body) => url.endsWith('/sendRichMessage') ? [400, { ok: false, description: 'rich' }]
    : body.message_thread_id ? [400, { ok: false, description: 'Bad Request: message thread not found' }] : [200, { ok: true, result: { message_id: 93 } }]);
  try {
    const cfg = Object.assign(cfgOn(), { apiBase: t.base, topics: { paid: 2 } });
    const r = await sendP(cfg, Object.assign({}, MSG, { type: 'paid', replyTo: { messageId: 77, chatId: '-100500', topic: 2 } }));
    assert.deepStrictEqual([r.ok, r.messageId, r.topic], [true, 93, null]);
    assert.deepStrictEqual(t.seen[1].body.reply_parameters, { message_id: 77, allow_sending_without_reply: true });
    assert.ok(!('reply_parameters' in t.seen[2].body));
  } finally { t.srv.close(); }
});

// Owner 30.09 (screenshot): headings were too big; the payment reply needs no CRM button (the order message above has one).
test('layout: headings are small (size 5); a payment reply has no button, a full payment alert keeps it', () => {
  for (const [o, type] of [[cardOrder(), 'order'], [shopOrder({ status: 'paid' }), 'paid']]) {
    const heads = A.richFor(o, type, {}).blocks.filter(b => b.type === 'heading');
    assert.ok(heads.length && heads.every(h => h.size === 5), type);
  }
  const reply = A.messageFor(shopOrder({ status: 'paid', alerts: { order: { sentAt: 'x', messageId: 7, chatId: '-1' } } }), 'paid', {});
  assert.ok(!reply.rich.blocks.some(b => b.type === 'buttons'));
  assert.ok(!/CRM: https/.test(reply.text));
  const alone = A.messageFor(shopOrder({ status: 'paid' }), 'paid', {});
  assert.ok(alone.rich.blocks.some(b => b.type === 'buttons'));
});
