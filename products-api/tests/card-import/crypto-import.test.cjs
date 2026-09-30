'use strict';
// The crypto part of card-import: a record the payment module verified on the chain becomes (or confirms) a CRM order.
// Rules A-D of the 2026-09-30 brief, modes, SINCE, idempotency, alert dedupe. The end-to-end run against the module's own
// code is e2e-crypto.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../../card-import.cjs');
const f = require('./fixtures.cjs');

const SINCE = '2026-09-30T00:00:00.000Z';
const NOW = new Date('2026-09-30T11:00:00.000Z');
const REF = 'CR-ABCD2345';
const PAY_ID = 'crypto:' + REF;

// deps for a crypto-only tick (card off), plus what the callbacks and the seen journal saw.
function mk(records, crm, over) {
  const { deps, state } = f.deps(Object.assign({
    mode: 'off', cryptoMode: 'on', cryptoSince: SINCE, moneyDue: f.fakeMoneyDue, now: () => NOW,
    onCryptoPaid: (order, all, info) => { state.paid.push({ ref: order.ref, statusChanged: info.statusChanged, all: all.length }); },
    onCryptoCreated: (order, all) => { state.createdCb.push({ ref: order.ref, all: all.length }); },
    readSeen: () => JSON.parse(JSON.stringify(state.seen)),
    writeSeen: (list) => { state.seen = list.slice(); }
  }, over || {}));
  state.paid = []; state.createdCb = []; state.seen = [];
  state.source = f.storeText(records, []);
  state.orders = crm || [];
  return { deps, state, imp: ci.createCardImport(deps) };
}
const order = (state, ref) => state.orders.find(o => o.ref === (ref || REF));
const crmLines = (state) => state.errors.filter(l => l.startsWith('[card-import] CRYPTO '));

test('cryptoCandidate: the module\'s own conditions, a ref the shop issues, SINCE, an amount', () => {
  const since = Date.parse(SINCE);
  const c = (over, cpOver) => ci.cryptoCandidate(f.crypto(Object.assign({}, over, cpOver ? { cryptoPayment: Object.assign({}, f.crypto().cryptoPayment, cpOver) } : {})), since);
  assert.equal(c({}), '');
  assert.equal(c({}, { sanctions: { status: 'skipped_fail_open' } }), '');
  for (const [name, r] of [
    ['not crypto', c({ paymentMethod: 'card' })],
    ['in flight', c({ inFlight: true })],
    ['status not crypto_paid', c({ status: 'crypto_review' })],
    ['payment not confirmed', c({ paymentConfirmed: false })],
    ['cp not paid', c({}, { status: 'confirming' })],
    ['not verified on chain', c({}, { verifiedOnChain: false })],
    ['sanctions review', c({}, { sanctions: { status: 'match' } })],
    ['sanctions missing', c({}, { sanctions: null })],
    ['lower-case ref', c({ orderRef: 'CR-abcd2345' })],
    ['ref with a 0', c({ orderRef: 'CR-ABCD2340' })],
    ['ref with an O', c({ orderRef: 'CR-ABCD234O' })],
    ['ref with a 1 / I', c({ orderRef: 'CR-ABCD23I1' })],
    ['short ref', c({ orderRef: 'CR-ABCD234' })],
    ['a card ref', c({ orderRef: 'BLR-2101' })],
    ['verified before SINCE', c({}, { verifiedAt: '2026-09-29T23:59:59.000Z' })]
  ]) assert.equal(r, null, name);
  assert.equal(c({}, { verifiedAt: 'yesterday' }), 'bad verifiedAt');
  assert.equal(c({}, { receivedAmount: '0.00' }), 'bad receivedAmount');
  assert.equal(c({}, { receivedAmount: 'lots' }), 'bad receivedAmount');
  assert.equal(c({ items: [] }), 'bad items');
  assert.equal(c({ items: [{ sku: 'x', name: 'x', qty: 0, amount: '1' }] }), 'bad item qty');
  assert.equal(c({ customer: null }), 'bad customer');
  assert.equal(c({}, { token: 'DOGE' }), 'bad token');
  assert.equal(c({}, { network: 'btc' }), 'bad network');
});

test('A: a new order that matches the record becomes paid with the payment crypto:<ref>, once', () => {
  const { imp, state } = mk([f.crypto()], [f.crmCrypto()]);
  const r = imp.tick();
  assert.equal(r.crypto.changed, 1);
  const o = order(state);
  assert.equal(o.status, 'paid');
  assert.equal(o.updated_at, NOW.toISOString());
  assert.deepEqual(o.payments, [{ id: PAY_ID, at: '2026-09-30T10:20:00.000Z', kind: 'payment', method: 'crypto', amount: 79.37,
    note: 'USDT trc20 tx a1b2c3d4e5… auto_onchain', by: 'card-import' }]);
  assert.deepEqual(state.paid, [{ ref: REF, statusChanged: true, all: 1 }]);
  assert.equal(state.writes, 1);
  // the second tick finds the payment and does nothing at all
  imp.tick();
  assert.equal(state.writes, 1);
  assert.equal(state.paid.length, 1);
  assert.equal(crmLines(state).length, 0);
});

test('A: status pending, and an order the page saved without any status, are open too', () => {
  for (const status of ['pending', 'PENDING ', undefined]) {
    const crm = f.crmCrypto(); if (status !== undefined) crm.status = status;
    const { imp, state } = mk([f.crypto()], [crm]);
    imp.tick();
    assert.equal(order(state).status, 'paid', String(status));
  }
});

test('A: e-mail is compared without case and spaces, mg without spaces and case, lines as a multiset', () => {
  const rec = f.crypto({ amount: '158.00', items: [{ sku: 'bpc-157-10mg', name: 'a', qty: 1, amount: '79.00' }, { sku: 'bpc-157-tb-500-blend-20mg', name: 'b', qty: 1, amount: '125.00' }],
    priceCheck: { shipping: '0.00' } });
  rec.cryptoPayment.receivedAmount = '204.10';
  const crm = f.crmCrypto({
    customer: { firstName: 'C', lastName: 'C', email: '  Cara.Coin@RealMail.net ' },
    items: [{ name: 'B', slug: 'bpc-157-tb-500-blend', mg: '20 MG', qty: 1, price: 125 }, { name: 'A', slug: 'bpc-157', mg: '10mg', qty: 1, price: 79 }],
    total_due_server: '204.00' });
  const { imp, state } = mk([rec], [crm]);
  imp.tick();
  assert.equal(order(state).status, 'paid');
  assert.equal(order(state).payments[0].amount, 204.1);
});

test('A: a manager was first (paid / payment-confirmed / processing): only the payment is added, the letter is asked for', () => {
  for (const status of ['paid', 'payment-confirmed', 'processing']) {
    const { imp, state } = mk([f.crypto()], [f.crmCrypto({ status, updated_at: '2026-09-30T10:30:00.000Z' })]);
    imp.tick();
    const o = order(state);
    assert.equal(o.status, status);
    assert.equal(o.updated_at, '2026-09-30T10:30:00.000Z', 'an open edit in the CRM must not turn into a conflict');
    assert.equal(o.payments.length, 1);
    assert.deepEqual(state.paid, [{ ref: REF, statusChanged: false, all: 1 }], status);
  }
});

test('A: shipped / in-transit / delivered get the payment and no callback at all', () => {
  for (const status of ['shipped', 'in-transit', 'delivered']) {
    const { imp, state } = mk([f.crypto()], [f.crmCrypto({ status })]);
    imp.tick();
    assert.equal(order(state).status, status);
    assert.equal(order(state).payments[0].id, PAY_ID);
    assert.deepEqual(state.paid, [], status);
    assert.deepEqual(state.createdCb, []);
  }
});

test('A: cancelled in the CRM - nothing is changed, one PAID-BUT-CANCELLED line for the life of the process', () => {
  const { imp, state } = mk([f.crypto()], [f.crmCrypto({ status: 'cancelled' })]);
  imp.tick(); imp.tick(); imp.tick();
  assert.equal(state.writes, 0);
  assert.deepEqual(crmLines(state), ['[card-import] CRYPTO PAID-BUT-CANCELLED ' + REF + ' received=79.37']);
});

test('A: a different e-mail, cart or amount changes nothing and says what differs, once per reason', () => {
  const cases = [
    ['email', { customer: { firstName: 'C', lastName: 'C', email: 'someone.else@realmail.net' } }, 'email'],
    ['qty', { items: [{ name: 'B', slug: 'bpc-157', mg: '10mg', qty: 2, price: 79 }] }, 'items'],
    ['mg', { items: [{ name: 'B', slug: 'bpc-157', mg: '20mg', qty: 1, price: 79 }] }, 'items'],
    ['product', { items: [{ name: 'B', slug: 'bpc-157-tb-500-blend', mg: '20mg', qty: 1, price: 125 }] }, 'items'],
    ['extra line', { items: [{ name: 'B', slug: 'bpc-157', mg: '10mg', qty: 1, price: 79 }, { name: 'B', slug: 'bpc-157', mg: '10mg', qty: 1, price: 79 }] }, 'items'],
    ['amount', { total_due_server: '200.00' }, 'amount'],
    ['no amount', { total_due_server: undefined, total_server: undefined, total: undefined }, 'amount']
  ];
  for (const [name, over, reason] of cases) {
    const crm = f.crmCrypto(over);
    if (name === 'no amount') { delete crm.total_due_server; delete crm.total_server; delete crm.total; }
    const { imp, state } = mk([f.crypto()], [crm]);
    imp.tick(); imp.tick();
    assert.equal(state.writes, 0, name);
    assert.equal(order(state).status, undefined, name);
    assert.equal(state.paid.length, 0, name);
    const lines = crmLines(state);
    assert.equal(lines.length, 1, name + ': ' + lines.join(' | '));
    assert.match(lines[0], new RegExp('^\\[card-import\\] CRYPTO MISMATCH ' + REF + ' ' + reason + ' received=79\\.37 due='), name);
    assert.ok(lines[0].length <= 160 && !lines[0].includes('@'), name);
  }
});

test('A: several reasons give one line each; a card sku the catalog does not know is an items mismatch', () => {
  const rec = f.crypto({ items: [{ sku: 'gone-product-5mg', name: 'x', qty: 1, amount: '79.00' }] });
  const { imp, state } = mk([rec], [f.crmCrypto({ customer: { email: 'x@realmail.net' }, total_due_server: '500.00' })]);
  imp.tick();
  assert.deepEqual(crmLines(state).map(l => l.split(' ')[4]).sort(), ['amount', 'email', 'items']);
});

test('A: received short of the amount due by a cent is a mismatch, equal is fine', () => {
  const rec = f.crypto(); rec.cryptoPayment.receivedAmount = '78.99';
  const a = mk([rec], [f.crmCrypto()]); a.imp.tick();
  assert.equal(a.state.writes, 0);
  const rec2 = f.crypto(); rec2.cryptoPayment.receivedAmount = '79.00';
  const b = mk([rec2], [f.crmCrypto()]); b.imp.tick();
  assert.equal(order(b.state).status, 'paid');
});

test('A: the ref stored twice in the CRM is reported and not touched', () => {
  const { imp, state } = mk([f.crypto()], [f.crmCrypto(), f.crmCrypto()]);
  imp.tick();
  assert.equal(state.writes, 0);
  assert.match(crmLines(state)[0], /MISMATCH CR-ABCD2345 duplicate/);
});

test('A: a record the module has not verified is never booked (review, confirming, awaiting, hold)', () => {
  for (const [st, cpst] of [['crypto_review', 'payment_review'], ['awaiting_crypto', 'confirming'], ['awaiting_crypto', 'awaiting_payment'], ['crypto_review', 'screening_hold']]) {
    const rec = f.crypto({ status: st, paymentConfirmed: false });
    rec.cryptoPayment.status = cpst; rec.cryptoPayment.verifiedOnChain = false;
    const { imp, state } = mk([rec], [f.crmCrypto()]);
    imp.tick();
    assert.equal(state.writes, 0, cpst);
    assert.equal(crmLines(state).length, 0);
  }
});

test('B: no order in the CRM - the import creates it, paid, from the record', () => {
  const rec = f.crypto({ amount: '158.00', items: [{ sku: 'bpc-157-10mg', name: 'BPC-157 10mg', qty: 2, amount: '158.00' }],
    notes: 'coupon:INSIDER25', priceCheck: { shipping: '0.00', shipMethod: 'FedEx Ground', coupon: 'INSIDER25' } });
  rec.cryptoPayment.receivedAmount = '118.87';
  rec.cryptoPayment.token = 'USDC'; rec.cryptoPayment.network = 'erc20';
  const { imp, state } = mk([rec], []);
  imp.tick();
  const o = order(state);
  assert.equal(o.ref, REF);
  assert.equal(o.source, 'crypto'); assert.equal(o.source_ref, REF);
  assert.equal(o.source_created_at, rec.createdAt); assert.equal(o.source_updated_at, rec.updatedAt);
  assert.equal(o.channel, 'shop'); assert.equal(o.status, 'paid');
  assert.equal(o.paymentMethod, 'crypto-usdc-erc');
  assert.deepEqual(o.customer, { firstName: 'Cara', lastName: 'Coin', email: 'cara.coin@realmail.net', phone: '+15550111' });
  assert.deepEqual(o.shipping, { address1: '3 Main St', city: 'LA', state: 'CA', zip: '90001', country: 'US', method: 'FedEx Ground', cost: 0 });
  assert.deepEqual(o.items, [{ name: 'BPC-157 10mg', slug: 'bpc-157', mg: '10mg', qty: 2, price: 79 }], 'the line amount is the total, the unit price is amount / qty');
  assert.equal(o.coupon, 'INSIDER25');
  assert.equal(o.timestamp, rec.createdAt);
  assert.match(o.notes, /^Created by payment import: the shop page did not send this order/);
  assert.equal(o.total_due_server, '118.50', 'run through the same priceCheck and discountFields as a storefront order');
  assert.equal(o.payments.length, 1); assert.equal(o.payments[0].id, PAY_ID); assert.equal(o.payments[0].amount, 118.87);
  assert.equal(o.test, undefined);
  assert.deepEqual(state.createdCb, [{ ref: REF, all: 1 }]);
  assert.deepEqual(state.paid, []);
  assert.deepEqual(state.seen, [REF]);
  assert.deepEqual(crmLines(state), ['[card-import] CRYPTO CREATED ' + REF + ' amount=118.87']);
  // second tick: order is there with its payment, nothing again
  imp.tick();
  assert.equal(state.writes, 1); assert.equal(state.createdCb.length, 1); assert.equal(crmLines(state).length, 1);
});

test('B: the payment method names for trc and erc, and a shipping fallback when the module had no price check', () => {
  const trc = mk([f.crypto()], []); trc.imp.tick();
  assert.equal(order(trc.state).paymentMethod, 'crypto-usdt-trc');
  const erc = f.crypto(); erc.cryptoPayment.network = 'erc20';
  const e = mk([erc], []); e.imp.tick();
  assert.equal(order(e.state).paymentMethod, 'crypto-usdt-erc');
  const bare = f.crypto({ amount: '97.99', priceCheck: undefined }); bare.cryptoPayment.receivedAmount = '98.10';
  const b = mk([bare], []); b.imp.tick();
  assert.equal(order(b.state).shippingCost, 18.99);
});

test('B: an order deleted in the CRM after the import created it is not created again', () => {
  const { imp, state } = mk([f.crypto()], []);
  imp.tick();
  state.orders = [];
  imp.tick();
  assert.equal(state.orders.length, 0);
  assert.equal(state.writes, 1);
});

test('B: a deleted order stays deleted after a restart (the seen journal is read)', () => {
  const a = mk([f.crypto()], []);
  a.imp.tick();
  const journal = a.state.seen.slice();
  const b = mk([f.crypto()], [], { readSeen: () => journal });
  b.imp.tick();
  assert.equal(b.state.orders.length, 0);
  assert.equal(b.state.writes, 0);
  assert.ok(b.state.logs.some(l => l.includes('was removed in CRM, not recreated')));
});

test('B: a test record makes a test order - no callbacks, the line is a log not an error', () => {
  for (const [name, rec] of [
    ['test flag', f.crypto({ test: true })],
    ['dry run', f.crypto({ dryRun: true })],
    ['DRY key', f.crypto({ idempotencyKey: 'DRY-9' })],
    ['stub descriptor', f.crypto({ descriptor: 'STUB CARD' })],
    ['service sku', f.crypto({ items: [{ sku: 'DRY-RUN', name: 'x', qty: 1, amount: '79.00' }] })],
    ['shop address', f.crypto({ customer: Object.assign({}, f.crypto().customer, { email: 'qa+1@biolabsresearch.co' }) })]
  ]) {
    const { imp, state } = mk([rec], []);
    imp.tick();
    assert.equal(order(state).test, true, name);
    assert.deepEqual(state.createdCb, [], name);
    assert.equal(crmLines(state).length, 0, name);
    assert.ok(state.logs.some(l => l.startsWith('[card-import] crypto (test) CREATED')), name);
  }
});

test('B: the catalog cannot price the order - nothing is written, the tick asks again next time', () => {
  const { imp, state } = mk([f.crypto()], [], { priceCheck: () => ({ price_check: 'skipped' }) });
  assert.deepEqual(imp.tick(), { error: 'catalog' });
  assert.equal(state.writes, 0);
});

test('D: the module refunds a booked payment - a refund line in the payment list and one CRYPTO REFUND alert', () => {
  const booked = f.crmCrypto({ status: 'paid', payments: [{ id: PAY_ID, kind: 'payment', method: 'crypto', amount: 79.37, by: 'card-import' }] });
  const rec = f.crypto();
  rec.cryptoPayment.refunds = [{ txHash: '0x' + 'ab'.repeat(32), amount: '79.37', network: 'trc20', actor: 'someone', at: '2026-09-30T12:00:00.000Z', note: null }];
  const { imp, state } = mk([rec], [booked]);
  imp.tick();
  const o = order(state);
  assert.equal(o.status, 'paid', 'the CRM status stays as the team left it');
  assert.equal(o.payments.length, 2);
  assert.deepEqual(o.payments[1], { id: 'crypto-refund:0x' + 'ab'.repeat(32), at: '2026-09-30T12:00:00.000Z', kind: 'refund', method: 'crypto',
    amount: 79.37, note: 'refund tx 0xabababab…', by: 'card-import' });
  assert.deepEqual(crmLines(state), ['[card-import] CRYPTO REFUND ' + REF + ' amount=79.37']);
  imp.tick();
  assert.equal(state.writes, 1); assert.equal(crmLines(state).length, 1);
  // a second refund is a second line
  rec.cryptoPayment.refunds.push({ txHash: 'cd'.repeat(32), amount: '5.00', network: 'trc20', at: '2026-09-30T13:00:00.000Z' });
  state.source = f.storeText([rec], []);
  imp.tick();
  assert.equal(order(state).payments.length, 3);
  assert.equal(crmLines(state).length, 2);
});

test('D: cancelled after paid - one CANCELLED-AFTER-PAID line, the CRM order is not touched', () => {
  const booked = f.crmCrypto({ status: 'paid', payments: [{ id: PAY_ID, kind: 'payment', by: 'card-import' }] });
  const rec = f.crypto({ status: 'crypto_cancelled', paymentConfirmed: false });
  rec.cryptoPayment.status = 'cancelled';
  const { imp, state } = mk([rec], [booked]);
  imp.tick(); imp.tick();
  assert.equal(state.writes, 0);
  assert.deepEqual(crmLines(state), ['[card-import] CRYPTO CANCELLED-AFTER-PAID ' + REF]);
});

test('D: a refund on a record the import never booked is not its business', () => {
  const rec = f.crypto(); rec.cryptoPayment.refunds = [{ txHash: 'ab'.repeat(32), amount: '5.00', at: '2026-09-30T12:00:00.000Z' }];
  rec.cryptoPayment.verifiedAt = '2026-09-01T00:00:00.000Z';   // before SINCE: not a candidate either
  const { imp, state } = mk([rec], [f.crmCrypto({ status: 'paid' })]);
  imp.tick();
  assert.equal(state.writes, 0);
});

test('D: a test order refund is logged, not sent to Telegram', () => {
  const booked = f.crmCrypto({ test: true, status: 'paid', payments: [{ id: PAY_ID, kind: 'payment', by: 'card-import' }] });
  const rec = f.crypto(); rec.cryptoPayment.refunds = [{ txHash: 'ab'.repeat(32), amount: '5.00', at: '2026-09-30T12:00:00.000Z' }];
  const { imp, state } = mk([rec], [booked]);
  imp.tick();
  assert.equal(order(state).payments.length, 2);
  assert.equal(crmLines(state).length, 0);
  assert.ok(state.logs.some(l => l.startsWith('[card-import] crypto (test) REFUND')));
});

test('SINCE: a record verified before CRYPTO_IMPORT_SINCE is not booked, one after it is', () => {
  const old = f.crypto(); old.cryptoPayment.verifiedAt = '2026-09-29T23:00:00.000Z';
  const a = mk([old], [f.crmCrypto()]); a.imp.tick();
  assert.equal(a.state.writes, 0);
  const b = mk([f.crypto()], [f.crmCrypto()]); b.imp.tick();
  assert.equal(b.state.writes, 1);
});

test('modes: no value is off in silence; a wrong value or a missing date is an ERROR and off; card off + crypto off skips the tick', () => {
  const none = mk([f.crypto()], [f.crmCrypto()], { cryptoMode: undefined });
  assert.deepEqual(none.imp.tick(), { skipped: 'off' });
  assert.equal(none.state.errors.length, 0);
  const bad = mk([f.crypto()], [f.crmCrypto()], { cryptoMode: 'yes' });
  assert.equal(bad.imp.cryptoMode(), 'off');
  assert.match(bad.state.errors[0], /^\[card-import\] ERROR unknown CRYPTO_IMPORT_MODE "yes", crypto import is off$/);
  for (const m of ['dry', 'on']) {
    const s = mk([f.crypto()], [f.crmCrypto()], { cryptoMode: m, cryptoSince: undefined });
    assert.equal(s.imp.cryptoMode(), 'off');
    assert.match(s.state.errors[0], /CRYPTO_IMPORT_SINCE is not a date/);
    assert.deepEqual(s.imp.tick(), { skipped: 'off' });
    const t = mk([f.crypto()], [f.crmCrypto()], { cryptoMode: m, moneyDue: undefined });
    assert.equal(t.imp.cryptoMode(), 'off');
  }
});

test('dry: not one write, not one callback; a DRY line per ref and action, once', () => {
  const { imp, state } = mk([f.crypto()], [f.crmCrypto()], { cryptoMode: 'dry' });
  imp.tick(); imp.tick();
  assert.equal(state.writes, 0); assert.deepEqual(state.paid, []); assert.deepEqual(state.orders.map(o => o.status), [undefined]);
  assert.deepEqual(state.logs.filter(l => l.includes('DRY crypto')), ['[card-import] DRY crypto would mark-paid ' + REF]);
  assert.deepEqual(state.errors, []);
  const b = mk([f.crypto()], [], { cryptoMode: 'dry' });
  b.imp.tick(); b.imp.tick();
  assert.deepEqual(b.state.logs.filter(l => l.includes('DRY crypto')), ['[card-import] DRY crypto would create ' + REF]);
  assert.deepEqual(b.state.seen, []); assert.equal(b.state.writes, 0);
  const c = mk([f.crypto()], [f.crmCrypto({ customer: { email: 'no@realmail.net' } })], { cryptoMode: 'dry' });
  c.imp.tick();
  assert.deepEqual(c.state.logs.filter(l => l.includes('DRY crypto')), ['[card-import] DRY crypto would mismatch email ' + REF]);
  assert.deepEqual(c.state.errors, [], 'dry never raises an alert');
  const d = mk([f.crypto()], [f.crmCrypto({ status: 'paid' })], { cryptoMode: 'dry' });
  d.imp.tick();
  assert.deepEqual(d.state.logs.filter(l => l.includes('DRY crypto')), ['[card-import] DRY crypto would payment-only ' + REF]);
});

test('independence: card off + crypto on ignores card records; card dry + crypto on writes only crypto; card on + crypto on is one write', () => {
  const src = f.storeText([f.card(), f.crypto()], [f.quote()]);
  // card off
  const a = mk([], [f.crmCrypto()]); a.state.source = src; a.imp.tick();
  assert.deepEqual(a.state.orders.map(o => o.ref), [REF]);
  assert.equal(order(a.state).status, 'paid');
  // card dry
  const b = mk([], [f.crmCrypto()], { mode: 'dry' }); b.state.source = src; b.imp.tick();
  assert.deepEqual(b.state.orders.map(o => o.ref), [REF], 'card records are only logged');
  assert.equal(b.state.writes, 1);
  assert.ok(b.state.logs.some(l => l.startsWith('[card-import] DRY would create BLR-2001')));
  assert.deepEqual(b.state.tracked, []);
  // card on: one write with both
  const c = mk([], [f.crmCrypto()], { mode: 'on' }); c.state.source = src; c.imp.tick();
  assert.equal(c.state.writes, 1);
  assert.deepEqual(c.state.orders.map(o => o.ref).sort(), ['BLR-2001', REF, 'QT-3001'].sort());
  assert.equal(order(c.state).status, 'paid');
  assert.deepEqual(c.state.tracked.sort(), ['BLR-2001', 'QT-3001'].sort());
  assert.deepEqual(c.state.paid.map(p => p.ref), [REF]);
  assert.deepEqual(c.state.seen.sort(), ['BLR-2001', 'QT-3001', REF].sort(), 'the booked crypto ref is remembered too');
});

test('dry remembers nothing: a would-create ref is not put in the seen journal, so the real run creates the order', () => {
  // card on (so the tick writes and the journal is saved) + crypto dry with a record the CRM does not have
  const a = mk([], [], { mode: 'on', cryptoMode: 'dry' });
  a.state.source = f.storeText([f.card(), f.crypto()], []);
  a.imp.tick();
  assert.deepEqual(a.state.seen, ['BLR-2001'], 'only the card ref');
  assert.ok(a.state.logs.some(l => l.includes('DRY crypto would create ' + REF)));
  // switched to on with the journal the dry run left behind
  const b = mk([f.crypto()], [], { readSeen: () => a.state.seen });
  b.imp.tick();
  assert.equal(order(b.state).status, 'paid');
});

test('a callback that throws is reported and does not stop the rest; a failed write retries with no callback', () => {
  const t = mk([f.crypto()], [f.crmCrypto()], { onCryptoPaid: () => { throw new Error('queue down'); } });
  t.imp.tick();
  assert.equal(order(t.state).status, 'paid');
  assert.deepEqual(t.state.errors, ['[card-import] ERROR crypto onCryptoPaid ' + REF + ': queue down']);
  const w = mk([f.crypto()], [f.crmCrypto()], {});
  let fail = true;
  const realWrite = w.deps.writeOrders;
  w.deps.writeOrders = (list) => { if (fail) throw new Error('disk full'); realWrite(list); };
  assert.deepEqual(w.imp.tick(), { error: 'write' });
  assert.deepEqual(w.state.paid, []);
  fail = false;
  w.imp.tick();
  assert.equal(order(w.state).status, 'paid');
  assert.equal(w.state.paid.length, 1);
});

test('a test order gets the payment but no callback', () => {
  const { imp, state } = mk([f.crypto()], [f.crmCrypto({ test: true })]);
  imp.tick();
  assert.equal(order(state).status, 'paid');
  assert.deepEqual(state.paid, []);
});

test('two records with one orderRef: the first counts, the second is ignored', () => {
  const second = f.crypto({ id: 'BLR-2102' }); second.customer.email = 'other@realmail.net';
  const { imp, state } = mk([f.crypto(), second], [f.crmCrypto()]);
  imp.tick();
  assert.equal(order(state).status, 'paid');
  assert.equal(crmLines(state).length, 0);
});

test('a verified record that cannot be read is reported once and skipped', () => {
  const { imp, state } = mk([f.crypto({ items: [] })], [f.crmCrypto()]);
  imp.tick(); imp.tick();
  assert.equal(state.writes, 0);
  assert.deepEqual(state.errors, ['[card-import] ERROR skipped crypto record ' + REF + ': bad items']);
});

test('every CRYPTO line is at most 160 characters and carries no address, name or wallet', () => {
  const rec = f.crypto({ customer: Object.assign({}, f.crypto().customer, { first_name: 'Zed', email: 'zed.secret@realmail.net' }) });
  rec.cryptoPayment.refunds = [{ txHash: 'ab'.repeat(32), amount: '1.00', at: '2026-09-30T12:00:00.000Z' }];
  const booked = f.crmCrypto({ status: 'cancelled', payments: [{ id: PAY_ID, by: 'card-import' }] });
  const runs = [mk([rec], [f.crmCrypto({ customer: { email: 'zed.other@realmail.net' }, total_due_server: '900.00' })]), mk([rec], []), mk([rec], [booked])];
  for (const r of runs) { r.imp.tick(); for (const l of crmLines(r.state)) { assert.ok(l.length <= 160, l); assert.ok(!/@|Zed|zed/.test(l), l); } }
  assert.ok(runs.reduce((n, r) => n + crmLines(r.state).length, 0) >= 3);
});

test('review 1: a ref the import booked (mark-paid, payment-paid, payment-only) is remembered; deleted in the CRM it is not created again, also after a restart', () => {
  for (const status of [undefined, 'paid', 'shipped']) {
    const crm = f.crmCrypto(); if (status) crm.status = status;
    const a = mk([f.crypto()], [crm]);
    a.imp.tick();
    assert.deepEqual(a.state.seen, [REF], String(status));
    // the manager deletes the order in the CRM: same process
    a.state.orders = [];
    a.imp.tick();
    assert.deepEqual(a.state.orders, [], String(status) + ': not created again');
    assert.equal(a.state.writes, 1);
    assert.equal(a.state.createdCb.length, 0);
    assert.ok(a.state.logs.some(l => l.includes('was removed in CRM, not recreated')));
    // and after a restart: a new instance reads the journal; orders.json is empty (deleted, or ENOENT read as [])
    const b = mk([f.crypto()], [], { readSeen: () => a.state.seen });
    b.imp.tick();
    assert.deepEqual(b.state.orders, [], String(status) + ': restart');
    assert.equal(b.state.writes, 0);
    assert.equal(b.state.createdCb.length, 0);
    assert.deepEqual(crmLines(b.state), []);
  }
});

test('review 1: dry does not put a booked ref in the journal either', () => {
  const a = mk([f.crypto()], [f.crmCrypto()], { cryptoMode: 'dry', mode: 'on' });
  a.state.source = f.storeText([f.card(), f.crypto()], []);
  a.imp.tick();
  assert.deepEqual(a.state.seen, ['BLR-2001']);
});

test('review 2: a test record on a CRM order without the flag - no callback, no logError, still booked', () => {
  const cases = [f.crypto({ test: true }), f.crypto({ dryRun: true }), f.crypto({ descriptor: 'STUB CARD' }),
    f.crypto({ customer: Object.assign({}, f.crypto().customer, { email: 'qa+1@biolabsresearch.co' }) })];
  for (const rec of cases) {
    const crm = f.crmCrypto({ customer: { firstName: 'C', lastName: 'C', email: rec.customer.email } });
    const { imp, state } = mk([rec], [crm]);
    imp.tick();
    assert.equal(order(state).status, 'paid');
    assert.deepEqual(state.paid, []);
    assert.deepEqual(crmLines(state), []);
  }
  // a mismatch of a probe is a log line, not Telegram
  const probe = f.crypto({ test: true });
  const m = mk([probe], [f.crmCrypto({ customer: { email: 'other@realmail.net' } })]);
  m.imp.tick();
  assert.deepEqual(crmLines(m.state), []);
  assert.ok(m.state.logs.some(l => l.startsWith('[card-import] crypto (test) MISMATCH')));
  // a payment-paid booking on a test record does not ask for a letter either
  const p = mk([f.crypto({ test: true })], [f.crmCrypto({ status: 'paid' })]);
  p.imp.tick();
  assert.deepEqual(p.state.paid, []);
});

test('review 6: a CRM status outside the known sets is a MISMATCH status, not silence', () => {
  const { imp, state } = mk([f.crypto()], [f.crmCrypto({ status: 'refunded' })]);
  imp.tick(); imp.tick();
  assert.equal(state.writes, 0);
  assert.deepEqual(crmLines(state), ['[card-import] CRYPTO MISMATCH ' + REF + ' status received=79.37 due=79.00']);
});

test('review 6: the cart is compared without the catalog - a product gone from the catalog does not make a mismatch', () => {
  const rec = f.crypto({ items: [{ sku: 'Gift-Solvent-5 Mg', name: 'x', qty: 1, amount: '0.00' }, { sku: 'bpc-157-10mg', name: 'y', qty: 1, amount: '79.00' }] });
  const crm = f.crmCrypto({ items: [{ name: 'BPC-157', slug: 'bpc-157', mg: '10 mg', qty: 1, price: 79 }, { name: 'Gift', slug: 'gift-solvent', mg: '5mg', qty: 1, price: 0 }] });
  const { imp, state } = mk([rec], [crm]);
  imp.tick();
  assert.equal(order(state).status, 'paid');
  // a bare slug (no mg) on both sides
  const bare = mk([f.crypto({ items: [{ sku: 'bpc-157', name: 'y', qty: 1, amount: '79.00' }] })], [f.crmCrypto({ items: [{ name: 'B', slug: 'bpc-157', mg: '', qty: 1, price: 79 }] })]);
  bare.imp.tick();
  assert.equal(order(bare.state).status, 'paid');
  // a different strength or qty is still a mismatch
  const diff = mk([f.crypto()], [f.crmCrypto({ items: [{ name: 'B', slug: 'bpc-157', mg: '20mg', qty: 1, price: 79 }] })]);
  diff.imp.tick();
  assert.equal(diff.state.writes, 0);
});
