'use strict';
// Test data for card-import: payment-module records in the exact shape /var/lib/crm-umg/store.json holds them
// (checked 2026-09-27) and stand-ins for the products-api functions the import borrows. The contract test runs the
// real products-api instead; these fakes only have to be simple and predictable.

const CATALOG = [
  { slug: 'bpc-157', name: 'BPC-157' },
  { slug: 'bpc-157-tb-500-blend', name: 'BPC-157 / TB-500 Blend' }
];
// Unit prices by "<slug> <mg>"; no volume tiers here, INSIDER25 = 25% as in products-api COUPONS.
const PRICES = { 'bpc-157 10mg': 79, 'bpc-157 20mg': 84, 'bpc-157-tb-500-blend 20mg': 125 };

function attempt(over) {
  return Object.assign({
    attemptId: 'a1', processor: 'umg', priority: 1, mode: 'live', startedAt: '2026-09-28T10:00:00.000Z',
    finishedAt: '2026-09-28T10:00:02.000Z', httpStatus: 201, processorTxnId: 'TX123', processorStatus: 'APPROVED',
    cardLast4: '4242', cardBrand: 'visa'
  }, over);
}
function card(over) {
  return Object.assign({
    id: 'BLR-2001', idempotencyKey: 'k-2001', createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:02.000Z',
    status: 'approved', inFlight: false, amount: '158.00', currency: 'USD',
    customer: { first_name: 'Ann', last_name: 'Lee', email: 'ann.lee@realmail.net', phone: '+15550100', country: 'US',
      state: 'CA', city: 'LA', zip: '90001', address: '1 Main St' },
    items: [{ sku: 'bpc-157-10mg', name: 'BPC-157', qty: 2, amount: '79.00' }],
    notes: '', winningProcessor: 'umg', winningTxnId: 'TX123', attempts: [attempt()]
  }, over);
}
function quote(over) {
  return Object.assign({
    id: 'QT-3001', type: 'quote', status: 'quote_requested', crmStatus: 'new', idempotencyKey: 'q-3001',
    createdAt: '2026-09-28T11:00:00.000Z', updatedAt: '2026-09-28T11:00:00.000Z', amount: '125.00', currency: 'USD',
    customer: { first_name: 'Bob', last_name: 'Ray', email: 'bob.ray@realmail.net', phone: '', country: 'US', state: '',
      city: '', zip: '', address: '' },
    items: [{ sku: 'bpc-157-tb-500-blend-20mg', name: 'BPC-157 / TB-500 Blend', qty: 1, amount: '125.00' }],
    notes: '', emailSent: true, session_id: 's1'
  }, over);
}
function storeText(orders, quotes) {
  return JSON.stringify({ settings: {}, orders: orders || [], quotes: quotes || [], abandoned_checkouts: {}, seq: 1, quoteSeq: 1 });
}
function fakePriceCheck(order) {
  let sum = 0; const unknown = [];
  for (const it of order.items) {
    const p = PRICES[it.slug + ' ' + it.mg];
    if (p === undefined) { unknown.push(it.slug || it.name); continue; }
    sum += p * it.qty;
  }
  const ship = Number(order.shippingCost) || 0;
  const out = { subtotal_server: sum.toFixed(2), total_server: (sum + ship).toFixed(2), price_mismatch: unknown.length > 0 };
  if (unknown.length) out.unknown_items = unknown;
  return out;
}
function fakeDiscountFields(order, check) {
  const pct = String(order.coupon || '').toUpperCase() === 'INSIDER25' ? 25 : 0;
  const sub = Math.round(Number(check.subtotal_server) * 100), tot = Math.round(Number(check.total_server) * 100);
  const d = Math.round(sub * pct / 100);
  return { discount_server: (d / 100).toFixed(2), discount_pct_server: pct, discount_source: pct ? 'coupon:INSIDER25' : 'none',
    total_due_server: ((tot - d) / 100).toFixed(2) };
}
function fakeSanitize(od, paymentMethod) {
  return Object.assign(JSON.parse(JSON.stringify(od)), { paymentMethod, savedAt: '2026-09-28T12:00:00.000Z' });
}
function fakeExcluded(email) {
  const e = String(email || '').toLowerCase();
  return e.indexOf('@') <= 0 || e === 'admin@biolabsresearch.co' || e.endsWith('@example.com');
}
// A crypto record the payment module has verified on the chain (checked against lib/crypto-checkout.js createCryptoCheckout
// and lib/crypto-verify.js markPaid, 2026-09-30). `amount` of a line is the line total; `amount` of the record is the
// server price, `cryptoPayment.receivedAmount` what the chain showed (base + the unique cents).
const TX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
function crypto(over) {
  return Object.assign({
    id: 'BLR-2101', orderRef: 'CR-ABCD2345', idempotencyKey: 'ck-2101', paymentMethod: 'crypto',
    createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:20:00.000Z',
    status: 'crypto_paid', paymentConfirmed: true, inFlight: false, amount: '79.00', amountDue: '79.37', currency: 'USD', payAsset: 'USDT',
    customer: { first_name: 'Cara', last_name: 'Coin', email: 'cara.coin@realmail.net', phone: '+15550111', country: 'US',
      state: 'CA', city: 'LA', zip: '90001', address: '3 Main St' },
    items: [{ sku: 'bpc-157-10mg', name: 'BPC-157 10mg', qty: 1, amount: '79.00' }],
    notes: '',
    priceCheck: { source: 'coupon-quote', serverAmount: '79.00', subtotal: '79.00', shipping: '0.00', shipMethod: 'FedEx Ground', coupon: '', lines: [] },
    crypto: { network: 'trc20', txHash: TX, amountReceived: '79.37', markedPaidVia: 'onchain' },
    cryptoPayment: {
      version: 1, status: 'paid', network: 'trc20', token: 'USDT', baseAmount: '79.00', payAmount: '79.37', receivedAmount: '79.37',
      verifiedOnChain: true, verifiedAt: '2026-09-30T10:20:00.000Z', verifiedVia: 'auto_onchain', sanctions: { status: 'clear' },
      transfers: [{ txHash: TX, success: true, network: 'trc20', token: 'USDT' }], refunds: [], staffActions: []
    }
  }, over);
}
// The order the browser's notify-order leaves in the CRM for the record above (sanitizeOrder + priceCheck + discountFields).
function crmCrypto(over) {
  return Object.assign({
    ref: 'CR-ABCD2345', channel: 'shop', paymentMethod: 'crypto-usdt-trc', savedAt: '2026-09-30T10:00:05.000Z',
    customer: { firstName: 'Cara', lastName: 'Coin', email: 'cara.coin@realmail.net', phone: '+15550111', company: '' },
    shipping: { address1: '3 Main St', city: 'LA', state: 'CA', zip: '90001', country: 'US', method: 'FedEx Ground', cost: 0 },
    items: [{ name: 'BPC-157', slug: 'bpc-157', mg: '10mg', qty: 1, price: 79 }],
    subtotal: 79, total: 79.37, notes: '', coupon: '',
    subtotal_server: '79.00', total_server: '79.00', price_mismatch: false,
    discount_server: '0.00', discount_pct_server: 0, discount_source: 'none', total_due_server: '79.00'
  }, over);
}
// products-api moneyDue, copied: the amount the buyer owes as the CRM order stands.
function fakeMoneyDue(order) {
  const v = (order && (order.total_due_server !== undefined ? order.total_due_server
    : (order.total_server !== undefined ? order.total_server : order.total)));
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v == null ? '0.00' : v);
}
function deps(over) {
  const state = { source: storeText([card()], [quote()]), orders: [], writes: 0, tracked: [], logs: [], errors: [] };
  const d = {
    mode: 'on', eventsSince: '2026-09-28T00:00:00.000Z', intervalMs: 60000,
    readSource: () => { if (state.source instanceof Error) throw state.source; return state.source; },
    readOrders: () => JSON.parse(JSON.stringify(state.orders)),
    writeOrders: (list) => { state.writes++; state.orders = JSON.parse(JSON.stringify(list)); },
    readProducts: () => CATALOG,
    sanitizeOrder: fakeSanitize, priceCheck: fakePriceCheck, discountFields: fakeDiscountFields, isExcludedAddress: fakeExcluded,
    track: (order) => { state.tracked.push(order.ref); },
    log: (s) => state.logs.push(s), logError: (s) => state.errors.push(s)
  };
  return { deps: Object.assign(d, over), state };
}
module.exports = { CATALOG, PRICES, TX, attempt, card, quote, crypto, crmCrypto, fakeMoneyDue, storeText, fakePriceCheck, fakeDiscountFields, fakeSanitize, fakeExcluded, deps };
