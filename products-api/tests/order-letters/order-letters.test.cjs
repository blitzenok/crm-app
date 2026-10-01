'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../order-letters.cjs');

const SINCE = '2026-10-01T00:00:00.000Z';
const CFG = { mode: 'on', sinceMs: Date.parse(SINCE), testTo: new Set() };
const shopOrder = (over) => Object.assign({
  ref: 'BF-1001', channel: 'shop', savedAt: '2026-10-02T10:00:00.000Z', status: '', paymentMethod: 'crypto-usdt-trc', notes: '',
  customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann.lee@realmail.net' },
  shipping: { address1: '1 Main St', city: 'LA', state: 'CA', zip: '90001', country: 'US', label: 'FedEx Ground' },
  items: [{ name: 'BPC-157', mg: '10mg', qty: 2, price: 79 }],
  subtotal_server: '158.00', total_server: '168.00', discount_server: '0.00', discount_pct_server: 0, discount_source: 'none', total_due_server: '168.00'
}, over);
// The booking card-import writes for a crypto transfer the payment module verified on the chain (order ref BF-1001 here).
const cryptoProof = (over) => Object.assign({ id: 'crypto:BF-1001', at: '2026-10-02T11:00:00.000Z', kind: 'payment', method: 'crypto', amount: 168, by: 'card-import' }, over);
const cardOrder = (over) => shopOrder(Object.assign({ ref: 'BLR-2001', channel: undefined, source: 'card', paymentMethod: 'card', status: 'paid' }, over));

test('letterTypeForStatus: four statuses give a letter, the rest none; case and spaces do not matter', () => {
  assert.equal(L.letterTypeForStatus('paid'), 'paid');
  assert.equal(L.letterTypeForStatus('payment-confirmed'), 'paid');
  assert.equal(L.letterTypeForStatus('shipped'), 'shipped');
  assert.equal(L.letterTypeForStatus(' In-Transit '), 'in_transit');
  assert.equal(L.letterTypeForStatus('delivered'), 'delivered');
  for (const s of ['new', 'pending', 'processing', 'cancelled', '', undefined, null, 'toString', '__proto__']) assert.equal(L.letterTypeForStatus(s), null, String(s));
});

test('kinds: every type has its queue kind and back; confirmation keeps the old mail_customer kind', () => {
  assert.equal(L.kindForType('confirmation'), 'mail_customer');
  assert.deepEqual(['paid', 'shipped', 'in_transit', 'delivered', 'rating'].map(L.kindForType), ['letter_paid', 'letter_shipped', 'letter_in_transit', 'letter_delivered', 'letter_rating']);
  for (const t of L.TYPES) assert.equal(L.typeForKind(L.kindForType(t)), t);
  assert.equal(L.typeForKind('cio_order_status'), null);
  assert.deepEqual(L.LETTER_KINDS, ['letter_paid', 'letter_shipped', 'letter_in_transit', 'letter_delivered', 'letter_rating']);
});

test('paymentState: paid only for a card record the import wrote and the CRM has as paid; a crypto or wire order never reads as a card payment', () => {
  assert.equal(L.paymentState(cardOrder()), 'paid');
  for (const st of ['payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered']) assert.equal(L.paymentState(cardOrder({ status: st })), 'paid', st);
  assert.equal(L.paymentState(cardOrder({ status: 'new' })), 'pending');
  assert.equal(L.paymentState(shopOrder({ paymentMethod: 'card', status: '' })), 'pending');            // notify-order with method card
  assert.equal(L.paymentState(shopOrder({ paymentMethod: 'card-umg', status: 'paid' })), 'pending');    // a browser string plus a manager status is still not the import
  assert.equal(L.paymentState(shopOrder({ paymentMethod: 'crypto-usdt-trc', status: '' })), 'crypto_pending');
  assert.equal(L.paymentState(shopOrder({ paymentMethod: 'crypto-usdc-erc', status: 'new' })), 'crypto_pending');
  // a crypto order the manager has marked paid (the deferred confirmation of it): neutral text, not "card payment", not "send the amount"
  for (const st of ['paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered']) assert.equal(L.paymentState(shopOrder({ paymentMethod: 'crypto-usdt-trc', status: st })), 'pending', st);
  assert.equal(L.paymentState(shopOrder({ paymentMethod: 'crypto-usdt-trc', status: 'cancelled' })), 'pending');
  assert.equal(L.paymentState(shopOrder({ paymentMethod: '', status: 'pending' })), 'pending');
  assert.equal(L.paymentState(null), 'pending');
});

test('paidVia: card only for a record the import wrote', () => {
  assert.equal(L.paidVia(cardOrder()), 'card');
  assert.equal(L.paidVia(shopOrder({ paymentMethod: 'card-umg' })), 'other');    // browser string, not evidence
  assert.equal(L.paidVia(shopOrder({ paymentMethod: 'crypto-usdt-trc' })), 'crypto');
  assert.equal(L.paidVia(shopOrder({ paymentMethod: 'zelle' })), 'other');
});

test('trackingUrl: built only from the carrier list and a plain number; Other and anything odd give no link', () => {
  assert.equal(L.trackingUrl('FedEx', '123456789012'), 'https://www.fedex.com/fedextrack/?trknbr=123456789012');
  assert.equal(L.trackingUrl('USPS', '9400 1111 2222'), 'https://tools.usps.com/go/TrackConfirmAction?tLabels=940011112222');
  assert.equal(L.trackingUrl('UPS', '1Z999AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(L.trackingUrl('DHL', '1234567890'), 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html?tracking-id=1234567890');
  assert.equal(L.trackingUrl('fedex', '123456789012'), 'https://www.fedex.com/fedextrack/?trknbr=123456789012');   // canonical carrier
  assert.equal(L.trackingUrl('Other', '123456789012'), '');
  assert.equal(L.trackingUrl('', '123456789012'), '');
  assert.equal(L.trackingUrl('evil.example', '123456789012'), '');
  assert.equal(L.trackingUrl('FedEx', ''), '');
  assert.equal(L.trackingUrl('FedEx', '123&x=<script>'), '');
  assert.equal(L.trackingUrl('FedEx', 'https://evil.example/x'), '');
  assert.equal(L.trackingUrl('FedEx', '12'), '');
});

test('canonicalCarrier: list members in their own spelling, anything else empty', () => {
  assert.deepEqual(L.CARRIERS, ['FedEx', 'USPS', 'UPS', 'DHL', 'Other']);
  assert.equal(L.canonicalCarrier(' fedex '), 'FedEx');
  assert.equal(L.canonicalCarrier('OTHER'), 'Other');
  assert.equal(L.canonicalCarrier('Royal Mail'), '');
  assert.equal(L.canonicalCarrier(undefined), '');
  assert.equal(L.canonicalCarrier(42), '');
});

test('trackingProblem: shipped and in-transit need a tracking number, in the body or already on the order', () => {
  assert.equal(L.trackingProblem('shipped', {}, {}), 'tracking number required');
  assert.equal(L.trackingProblem('in-transit', {}, { trackingNumber: '  ' }), 'tracking number required');
  assert.equal(L.trackingProblem('shipped', { trackingNumber: '1234567' }, {}), '');
  assert.equal(L.trackingProblem('in-transit', {}, { trackingNumber: '1234567' }), '');
  assert.equal(L.trackingProblem('shipped', { trackingNumber: '' }, { trackingNumber: '1234567' }), 'tracking number required');   // clearing it while shipping
  assert.equal(L.trackingProblem('delivered', {}, {}), '');
  assert.equal(L.trackingProblem('paid', {}, {}), '');
  assert.equal(L.trackingProblem(undefined, {}, {}), '');
});

test('parseConfig: nothing set = off; test and on need a valid SINCE, otherwise off with a problem', () => {
  assert.equal(L.parseConfig({}).mode, 'off');
  assert.deepEqual(L.parseConfig({}).problems, []);
  assert.equal(L.parseConfig({ ORDER_LETTERS_MODE: 'OFF' }).mode, 'off');
  const on = L.parseConfig({ ORDER_LETTERS_MODE: ' on ', ORDER_LETTERS_SINCE: SINCE });
  assert.equal(on.mode, 'on');
  assert.equal(on.sinceMs, Date.parse(SINCE));
  assert.deepEqual(on.problems, []);
  const bad = L.parseConfig({ ORDER_LETTERS_MODE: 'on', ORDER_LETTERS_SINCE: 'tomorrow' });
  assert.equal(bad.mode, 'off');
  assert.match(bad.problems.join('|'), /ORDER_LETTERS_SINCE/);
  const none = L.parseConfig({ ORDER_LETTERS_MODE: 'test' });
  assert.equal(none.mode, 'off');
  assert.match(none.problems.join('|'), /ORDER_LETTERS_SINCE/);
  const odd = L.parseConfig({ ORDER_LETTERS_MODE: 'yes' });
  assert.equal(odd.mode, 'off');
  assert.match(odd.problems.join('|'), /ORDER_LETTERS_MODE/);
  const t = L.parseConfig({ ORDER_LETTERS_MODE: 'test', ORDER_LETTERS_SINCE: SINCE, ORDER_LETTERS_TEST_TO: ' A@x.io, b@y.io ,, ' });
  assert.equal(t.mode, 'test');
  assert.deepEqual(Array.from(t.testTo).sort(), ['a@x.io', 'b@y.io']);
  assert.match(L.parseConfig({ ORDER_LETTERS_MODE: 'test', ORDER_LETTERS_SINCE: SINCE }).problems.join('|'), /ORDER_LETTERS_TEST_TO/);
});

test('templateIds: env names per type, the missing ones listed', () => {
  const r = L.templateIds({ CIO_ORDER_CUSTOMER_MSG_ID: '3', CIO_LETTER_PAID_MSG_ID: '11', CIO_LETTER_SHIPPED_MSG_ID: ' 12 ' }, { CIO_LETTER_DELIVERED_MSG_ID: '14' });
  assert.deepEqual(r.ids, { confirmation: '3', paid: '11', shipped: '12', in_transit: '', delivered: '14', rating: '' });
  assert.deepEqual(r.missing, ['in_transit', 'rating']);
  assert.deepEqual(L.ENV_ID, { confirmation: 'CIO_ORDER_CUSTOMER_MSG_ID', paid: 'CIO_LETTER_PAID_MSG_ID', shipped: 'CIO_LETTER_SHIPPED_MSG_ID', in_transit: 'CIO_LETTER_IN_TRANSIT_MSG_ID', delivered: 'CIO_LETTER_DELIVERED_MSG_ID', rating: 'CIO_LETTER_RATING_MSG_ID' });
});

test('letterAllowed: a live shop order may get any letter; every listed exclusion says why not', () => {
  for (const t of L.TYPES) {
    const o = shopOrder({ status: 'shipped', trackingNumber: '1234567890', carrier: 'FedEx' });
    assert.deepEqual(L.letterAllowed(o, t, CFG), { ok: true }, t);
  }
  const no = (order, type, reason, cfg) => assert.deepEqual(L.letterAllowed(order, type, cfg || CFG), { ok: false, reason }, reason);
  no(shopOrder(), 'confirmation', 'mode_off', Object.assign({}, CFG, { mode: 'off' }));
  no(shopOrder(), 'nonsense', 'bad_type');
  no(shopOrder({ test: true }), 'confirmation', 'test_order');
  no(shopOrder({ ref: 'PROBE-1' }), 'confirmation', 'test_order', Object.assign({}, CFG, { isTestOrder: (o) => /^PROBE/.test(o.ref) }));
  no(shopOrder({ notes: 'please TEST ORDER do not ship' }), 'confirmation', 'test_note');
  no(shopOrder({ customer: { email: 'not-an-address' } }), 'confirmation', 'no_email');
  no(shopOrder({ customer: {} }), 'confirmation', 'no_email');
  no(shopOrder(), 'confirmation', 'excluded', Object.assign({}, CFG, { isExcluded: () => true }));
  no(shopOrder({ savedAt: '2026-09-30T23:59:59.000Z' }), 'confirmation', 'before_since');
  no(shopOrder({ savedAt: undefined }), 'confirmation', 'no_date');
  no(shopOrder({ channel: undefined, ref: 'MS-004' }), 'confirmation', 'not_shop');            // CRM wholesale order
  no(shopOrder({ channel: 'other' }), 'confirmation', 'not_shop');
  for (const s of ['cancelled', 'canceled', 'refunded', 'chargeback']) no(shopOrder({ status: s }), 'shipped', 'cancelled');
  no(shopOrder({ letters: { shipped: { sentAt: '2026-10-03T10:00:00.000Z' } }, trackingNumber: '1234567890' }), 'shipped', 'already_sent');
  no(cardOrder(), 'paid', 'covered_by_confirmation');                                          // the card confirmation already says paid
  no(shopOrder({ status: 'shipped' }), 'shipped', 'no_tracking');
  no(shopOrder({ status: 'in-transit', trackingNumber: ' ' }), 'in_transit', 'no_tracking');
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'delivered' }), 'delivered', CFG), { ok: true });   // no tracking needed here
});

test('letterAllowed: a card order the import wrote is a shop order; a sentAt of another type does not block', () => {
  assert.deepEqual(L.letterAllowed(cardOrder(), 'confirmation', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(cardOrder({ status: 'shipped', trackingNumber: '1234567890', letters: { confirmation: { sentAt: 'x' } } }), 'shipped', CFG), { ok: true });
  // a quote request is not a shop order, even though the import wrote it
  assert.deepEqual(L.letterAllowed(cardOrder({ ref: 'QT-3001', source: 'quote', status: 'new', paymentMethod: 'quote-request' }), 'confirmation', CFG), { ok: false, reason: 'not_shop' });
});

test('letterAllowed in test mode: only the listed addresses; the rest is reported as would-send, not sent', () => {
  const cfg = { mode: 'test', sinceMs: Date.parse(SINCE), testTo: new Set(['me@ours.io']) };
  assert.deepEqual(L.letterAllowed(shopOrder({ customer: { email: ' Me@Ours.io ' } }), 'confirmation', cfg), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder(), 'confirmation', cfg), { ok: false, reason: 'not_test_recipient' });
});

test('letterAllowed: an old order with no letters field reads as nothing sent', () => {
  const o = shopOrder(); delete o.letters;
  assert.deepEqual(L.letterAllowed(o, 'confirmation', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ letters: 'garbage' }), 'confirmation', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ letters: { confirmation: null } }), 'confirmation', CFG), { ok: true });
});

const COMMON = ['first_name', 'paid_via', 'payment_state', 'ref', 'shipping_address', 'shipping_method', 'status', 'total_due_server', 'totals_available'];
test('letterData: exactly the contract fields per type', () => {
  const o = shopOrder({ status: 'shipped', trackingNumber: '123456789012', carrier: 'FedEx' });
  const keys = (t) => Object.keys(L.letterData(o, t)).sort();
  assert.deepEqual(keys('paid'), COMMON);
  assert.deepEqual(keys('confirmation'), COMMON.concat(['discount_pct_server', 'discount_server', 'discount_source', 'items', 'shipping_server', 'subtotal_server']).sort());
  for (const t of ['shipped', 'in_transit', 'delivered']) assert.deepEqual(keys(t), COMMON.concat(['carrier', 'tracking_number', 'tracking_url']).sort(), t);
  assert.deepEqual(keys('rating'), ['first_name', 'ref'], 'the rating letter reads the number and the name only (review_url is added by products-api)');
});

test('rating letter (services/reviews): no status means it, it has its own queue kind, and its data carries no money, address or tracking', () => {
  for (const s of ['rating', 'delivered-rating', 'letter_rating']) assert.equal(L.letterTypeForStatus(s), null, s);
  assert.equal(L.typeForKind('letter_rating'), 'rating');
  const d = L.letterData(shopOrder({ status: 'delivered', trackingNumber: '123456789012', carrier: 'FedEx', customer: { firstName: '<b>Ann</b>', email: 'ann.lee@realmail.net' } }), 'rating');
  assert.deepEqual(d, { ref: 'BF-1001', first_name: '&lt;b&gt;Ann&lt;/b&gt;' }, 'typed text goes through the same scrub');
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'delivered' }), 'rating', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'cancelled' }), 'rating', CFG), { ok: false, reason: 'cancelled' });
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'delivered', letters: { rating: { sentAt: '2026-10-09T10:00:00.000Z' } } }), 'rating', CFG), { ok: false, reason: 'already_sent' });
});

test('letterData: values are the server figures, escaped strings and a link only for a known carrier', () => {
  const o = shopOrder({ status: 'shipped', trackingNumber: ' 123456789012 ', carrier: 'FedEx', customer: { firstName: '<b>Ann</b>', email: 'a@b.co' },
    shipping: { address1: '1 "Main" St', city: 'LA', state: 'CA', zip: '90001', country: 'US', label: 'FedEx Ground' },
    items: [{ name: '<script>alert(1)</script>', mg: '10mg', qty: 2, price: 79 }] });
  const d = L.letterData(o, 'shipped');
  assert.equal(d.ref, 'BF-1001');
  assert.equal(d.first_name, '&lt;b&gt;Ann&lt;/b&gt;');
  assert.equal(d.status, 'shipped');
  assert.equal(d.payment_state, 'pending');
  assert.equal(d.paid_via, 'crypto');
  assert.equal(d.totals_available, true);
  assert.equal(d.total_due_server, '168.00');
  assert.equal(d.shipping_address, '1 &quot;Main&quot; St, LA CA 90001, US');
  assert.equal(d.shipping_method, 'FedEx Ground');
  assert.equal(d.carrier, 'FedEx');
  assert.equal(d.tracking_number, '123456789012');
  assert.equal(d.tracking_url, 'https://www.fedex.com/fedextrack/?trknbr=123456789012');
  const c = L.letterData(o, 'confirmation');
  assert.deepEqual(c.items, [{ name: '&lt;script&gt;alert(1)&lt;/script&gt;', mg: '10mg', qty: 2, price: '79.00' }]);
  assert.equal(c.subtotal_server, '158.00');
  assert.equal(c.shipping_server, '10.00');
  assert.equal(c.discount_server, '0.00');
  assert.equal(c.discount_source, 'none');
});

test('letterData: an unknown or missing carrier becomes Other with no link; totals off means no total', () => {
  const o = shopOrder({ status: 'shipped', trackingNumber: '123456789012' });
  for (const carrier of [undefined, '', 'Royal Mail']) {
    const d = L.letterData(Object.assign({}, o, { carrier }), 'shipped');
    assert.equal(d.carrier, 'Other');
    assert.equal(d.tracking_url, '');
  }
  const noTotals = L.letterData(shopOrder({ price_check: 'skipped' }), 'paid');
  assert.equal(noTotals.totals_available, false);
  assert.equal(noTotals.total_due_server, '');
  const noServer = shopOrder(); delete noServer.subtotal_server; delete noServer.total_due_server;
  const d2 = L.letterData(noServer, 'paid');
  assert.equal(d2.totals_available, false);
  assert.equal(d2.total_due_server, '');
});

test('letterData: a coupon code typed by the customer is escaped in discount_source', () => {
  const d = L.letterData(shopOrder({ discount_source: 'coupon:<i>X</i>', discount_server: '5.00', discount_pct_server: 3 }), 'confirmation');
  assert.equal(d.discount_source, 'coupon:&lt;i&gt;X&lt;/i&gt;');
  assert.equal(d.discount_pct_server, 3);
});

test('letterData: an injected mailSafe is the one used', () => {
  const d = L.letterData(shopOrder(), 'paid', { mailSafe: (v) => 'S(' + v + ')' });
  assert.equal(d.ref, 'S(BF-1001)');
  assert.equal(d.first_name, 'S(Ann)');
});

test('letterData: a bad type throws, it never invents a payload', () => {
  assert.throws(() => L.letterData(shopOrder(), 'nonsense'));
});

test('safeRef: an address-like ref is masked for the log', () => {
  assert.equal(L.safeRef('BF-1001'), 'BF-1001');
  assert.equal(L.safeRef('victim@x.io'), '<addr>');
  assert.equal(L.safeRef('a'.repeat(200)).length, 64);
});

test('letterAllowed in test mode: a listed address is never "excluded", in on mode the exclusion still applies', () => {
  const excluded = () => true;
  const cfg = { mode: 'test', sinceMs: Date.parse(SINCE), testTo: new Set(['me@ours.io']), isExcluded: excluded };
  assert.deepEqual(L.letterAllowed(shopOrder({ customer: { email: 'me@ours.io' } }), 'confirmation', cfg), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ customer: { email: 'other@ours.io' } }), 'confirmation', cfg), { ok: false, reason: 'excluded' });
  assert.deepEqual(L.letterAllowed(shopOrder({ customer: { email: 'me@ours.io' } }), 'confirmation', Object.assign({}, CFG, { isExcluded: excluded })), { ok: false, reason: 'excluded' });
});

test('markLetter: records on the order, keeps the other letters, starts from nothing on an old or junk field', () => {
  const o = shopOrder({ letters: { confirmation: { sentAt: 'a' } } });
  L.markLetter(o, 'shipped', { sentAt: 'b' });
  assert.deepEqual(o.letters, { confirmation: { sentAt: 'a' }, shipped: { sentAt: 'b' } });
  const old = shopOrder(); delete old.letters;
  L.markLetter(old, 'paid', { sentAt: 'c' });
  assert.deepEqual(old.letters, { paid: { sentAt: 'c' } });
  const junk = shopOrder({ letters: 'garbage' });
  L.markLetter(junk, 'paid', { sentAt: 'd' });
  assert.deepEqual(junk.letters, { paid: { sentAt: 'd' } });
  assert.equal(L.alreadySent(junk, 'paid'), true);
  assert.equal(L.alreadySent(junk, 'shipped'), false);
});

test('recipientListed: test mode compares the address without case or spaces; nothing listed means nobody', () => {
  const cfg = { testTo: new Set(['me@ours.io']) };
  assert.equal(L.recipientListed(shopOrder({ customer: { email: ' Me@Ours.io ' } }), cfg), true);
  assert.equal(L.recipientListed(shopOrder(), cfg), false);
  assert.equal(L.recipientListed(shopOrder({ customer: {} }), cfg), false);
  assert.equal(L.recipientListed(shopOrder(), { testTo: new Set() }), false);
  assert.equal(L.recipientListed(shopOrder(), {}), false);
});

test('letterAllowed: with the crypto import on, the paid letter of a crypto order needs the blockchain booking the import writes, and nothing else will do', () => {
  // import off or dry (no flag): a manager's paid sends the letter, as before
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'paid' }), 'paid', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'paid' }), 'paid', Object.assign({}, CFG, { requireCryptoProof: false })), { ok: true });
  const CFGC = Object.assign({}, CFG, { requireCryptoProof: true });   // products-api sets it while CRYPTO_IMPORT_MODE is on
  const paid = (over) => L.letterAllowed(shopOrder(Object.assign({ status: 'paid' }, over)), 'paid', CFGC);
  assert.deepEqual(paid({}), { ok: false, reason: 'crypto_not_verified' }, 'a manager set paid: the status changes, the letter does not go');
  assert.deepEqual(paid({ payments: [] }), { ok: false, reason: 'crypto_not_verified' });
  assert.deepEqual(paid({ payments: [cryptoProof()] }), { ok: true });
  for (const [name, p] of [
    ['other author', cryptoProof({ by: 'boss@realmail.net' })],
    ['no author', cryptoProof({ by: undefined })],
    ['other id', cryptoProof({ id: 'pay-1a2b3c4d' })],
    ['id of another order', cryptoProof({ id: 'crypto:BF-9999' })],
    ['id without the colon', cryptoProof({ id: 'crypto-BF-1001' })],
    ['a refund', cryptoProof({ kind: 'refund' })]
  ]) assert.deepEqual(paid({ payments: [p] }), { ok: false, reason: 'crypto_not_verified' }, name);
  assert.deepEqual(paid({ payments: 'crypto:BF-1001' }), { ok: false, reason: 'crypto_not_verified' }, 'a payments field that is not a list');
  // every crypto method name the shop uses
  for (const m of ['crypto-usdt-trc', 'crypto-usdt-erc', 'crypto-usdc-erc', 'crypto']) {
    assert.equal(paid({ paymentMethod: m }).reason, 'crypto_not_verified', m);
    assert.equal(paid({ paymentMethod: m, payments: [cryptoProof()] }).ok, true, m);
  }
  // an order created by the import itself
  assert.equal(paid({ source: 'crypto', payments: [cryptoProof()] }).ok, true);
  // the other letters of a crypto order do not ask for it, and the other payment methods are not asked at all
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'shipped', trackingNumber: '1234567890' }), 'shipped', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'delivered' }), 'delivered', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'paid', paymentMethod: 'wire' }), 'paid', CFG), { ok: true });
  assert.deepEqual(L.letterAllowed(shopOrder({ status: 'paid', paymentMethod: '' }), 'paid', CFG), { ok: true });
  // the card path is as it was: the confirmation covers paid, and the confirmation of a card order is allowed
  assert.deepEqual(L.letterAllowed(cardOrder(), 'paid', CFG), { ok: false, reason: 'covered_by_confirmation' });
  assert.deepEqual(L.letterAllowed(cardOrder(), 'confirmation', CFG), { ok: true });
  // already sent still wins over the missing booking (one reason, the earlier rule)
  assert.equal(paid({ letters: { paid: { sentAt: 'x' } } }).reason, 'already_sent');
});

test('hasCryptoProof reads the booking for this order only', () => {
  assert.equal(L.hasCryptoProof(shopOrder({ payments: [cryptoProof()] })), true);
  assert.equal(L.hasCryptoProof(shopOrder({ ref: 'BF-2', payments: [cryptoProof()] })), false);
  assert.equal(L.hasCryptoProof(null), false);
  assert.equal(L.hasCryptoProof({}), false);
});
