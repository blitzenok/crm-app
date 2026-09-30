'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../../order-letters.cjs');
const { render, readable } = require('./liquid-lite.cjs');

const DIR = path.join(__dirname, 'templates');
const NAMES = { confirmation: 'order-customer', paid: 'order-paid', shipped: 'order-shipped', in_transit: 'order-in-transit', delivered: 'order-delivered' };
const read = (name, ext) => fs.readFileSync(path.join(DIR, name + ext), 'utf8');
const COMMON = ['ref', 'first_name', 'status', 'payment_state', 'paid_via', 'totals_available', 'total_due_server', 'shipping_address', 'shipping_method'];
// The contract's field lists (contract.md), copied on purpose: a template must not read a field the server does not send.
const ALLOWED = {
  confirmation: COMMON.concat(['items', 'subtotal_server', 'shipping_server', 'discount_server', 'discount_pct_server', 'discount_source']),
  paid: COMMON,
  shipped: COMMON.concat(['carrier', 'tracking_number', 'tracking_url']),
  in_transit: COMMON.concat(['carrier', 'tracking_number', 'tracking_url']),
  delivered: COMMON.concat(['carrier', 'tracking_number', 'tracking_url'])
};
const STOP_WORDS = [/\bdose\b/i, /\bdosage\b/i, /\binject/i, /\badminister/i, /\bper kg\b/i, /\bdaily\b/i];

function order(over) {
  return Object.assign({
    ref: 'BF-1001', channel: 'shop', savedAt: '2026-10-02T10:00:00.000Z', status: '', paymentMethod: 'crypto-usdt-trc', notes: '',
    customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann.lee@realmail.net' },
    shipping: { address1: '1 Main St', city: 'LA', state: 'CA', zip: '90001', country: 'US', label: 'FedEx Ground' },
    items: [{ name: 'BPC-157', mg: '10mg', qty: 2, price: 79 }, { name: 'TB-500', mg: '5mg', qty: 1, price: 60 }],
    subtotal_server: '218.00', total_server: '228.00', discount_server: '0.00', discount_pct_server: 0, discount_source: 'none', total_due_server: '228.00'
  }, over);
}

test('every letter has a body, a subject and a preheader', () => {
  for (const name of Object.values(NAMES)) {
    for (const ext of ['.html', '.subject.txt', '.preheader.txt']) {
      const text = read(name, ext);
      assert.ok(text.trim().length > 10, name + ext);
    }
    assert.equal(read(name, '.subject.txt').trim().includes('\n'), false, name + ' subject is one line');
    assert.equal(read(name, '.preheader.txt').trim().includes('\n'), false, name + ' preheader is one line');
  }
});

test('a template reads only the fields agreed for its letter (no customer.* attribute either)', () => {
  for (const [type, name] of Object.entries(NAMES)) {
    const all = ['.html', '.subject.txt', '.preheader.txt'].map(e => read(name, e)).join('\n');
    const used = new Set(Array.from(all.matchAll(/trigger\.([A-Za-z_]+)/g)).map(m => m[1]));
    for (const f of used) {
      if (f === 'size') continue;                                  // trigger.items.size
      assert.ok(ALLOWED[type].includes(f), name + ' reads trigger.' + f + ' which is not in the contract for ' + type);
    }
    assert.equal(/customer\./.test(all.replace(/\{\{\s*i\./g, '')), false, name + ' must not read profile attributes');
    assert.ok(used.has('ref'), name + ' names the order');
  }
});

test('no long dash, no dose or usage words, research-use line and the signature are there', () => {
  for (const name of Object.values(NAMES)) {
    const all = ['.html', '.subject.txt', '.preheader.txt'].map(e => read(name, e)).join('\n');
    assert.equal(/[—–]/.test(all), false, name + ' has a dash the owner does not want');
    for (const re of STOP_WORDS) assert.equal(re.test(all), false, name + ' has ' + re);
    const html = read(name, '.html');
    assert.match(html, /research use only/i, name);
    assert.match(html, /The BioLabs Research Team/, name);
    assert.match(html, /Questions about this order\? Reply to this email and include your order number, \{\{ trigger\.ref \}\}\./, name);
  }
});

test('Liquid tags are balanced and no tag is left open', () => {
  for (const name of Object.values(NAMES)) {
    for (const ext of ['.html', '.subject.txt', '.preheader.txt']) {
      const t = read(name, ext);
      const count = (re) => (t.match(re) || []).length;
      assert.equal(count(/\{%-?\s*if\s/g), count(/\{%-?\s*endif\s*-?%\}/g), name + ext + ' if/endif');
      assert.equal(count(/\{%-?\s*for\s/g), count(/\{%-?\s*endfor\s*-?%\}/g), name + ext + ' for/endfor');
      assert.equal(count(/\{\{/g), count(/\}\}/g), name + ext + ' braces');
    }
  }
});

test('confirmation for a card order says payment is received, and never the old "not a payment" lines', () => {
  const t = L.letterData(order({ source: 'card', paymentMethod: 'card', status: 'paid' }), 'confirmation');
  const body = readable(render(read('order-customer', '.html'), t));
  assert.match(body, /Thank you, your payment is received/);
  assert.match(body, /We have received your card payment/);
  assert.equal(/does not constitute payment|No credit card or bank details|separate email with payment instructions/.test(body), false);
  assert.equal(render(read('order-customer', '.subject.txt'), t).trim(), 'Payment received for order BF-1001');
  assert.match(body, /Hi Ann,/);
  assert.match(body, /BPC-157 10mg 2 \$79\.00/);
  assert.match(body, /Subtotal: \$218\.00 Shipping: \$10\.00 Total: \$228\.00/);
  assert.match(body, /Ship to: 1 Main St, LA CA 90001, US Shipping method: FedEx Ground/);
});

test('a deferred confirmation of a crypto order that a manager has already marked paid never says "card payment"', () => {
  for (const status of ['paid', 'processing', 'shipped', 'delivered']) {
    const body = readable(render(read('order-customer', '.html'), L.letterData(order({ status }), 'confirmation')));
    assert.equal(/card payment/i.test(body), false, status);
    assert.equal(/send the exact amount/i.test(body), false, status + ': no request to pay again');
    assert.match(body, /Our team will review your order/);
    assert.equal(render(read('order-customer', '.subject.txt'), L.letterData(order({ status }), 'confirmation')).trim(), 'We received your order BF-1001');
  }
});

test('confirmation for crypto waits for payment without a wallet in the letter; other methods get the plain review text', () => {
  const crypto = L.letterData(order(), 'confirmation');
  const body = readable(render(read('order-customer', '.html'), crypto));
  assert.match(body, /Thank you for your order/);
  assert.match(body, /send the exact amount shown on the checkout page to the wallet address shown there, within 60 minutes/);
  assert.match(body, /Unpaid orders are cancelled automatically/);
  assert.equal(/0x[0-9a-f]{6}|T[A-Za-z0-9]{33}/.test(body), false, 'no wallet address');
  assert.equal(render(read('order-customer', '.subject.txt'), crypto).trim(), 'We received your order BF-1001');
  const other = readable(render(read('order-customer', '.html'), L.letterData(order({ paymentMethod: 'wire' }), 'confirmation')));
  assert.match(other, /Our team will review your order and contact you shortly/);
  assert.equal(/wallet/.test(other), false);
});

test('confirmation without server totals promises an invoice, with a discount shows the code', () => {
  const none = readable(render(read('order-customer', '.html'), L.letterData(order({ price_check: 'skipped' }), 'confirmation')));
  assert.match(none, /We will confirm the total in the invoice/);
  const disc = readable(render(read('order-customer', '.html'), L.letterData(order({ discount_server: '54.50', discount_pct_server: 25, discount_source: 'coupon:INSIDER25', total_due_server: '173.50' }), 'confirmation')));
  assert.match(disc, /Discount: -\$54\.50 \(25%, code INSIDER25\)/);
  assert.match(disc, /Total: \$173\.50/);
});

test('paid letter: crypto is confirmed on the blockchain, the total shows only when the server has it', () => {
  const crypto = readable(render(read('order-paid', '.html'), L.letterData(order({ status: 'paid' }), 'paid')));
  assert.match(crypto, /We have received your payment for order BF-1001, confirmed on the blockchain\. Total paid: \$228\.00\./);
  assert.match(crypto, /we will email you the tracking number as soon as it ships/);
  const other = readable(render(read('order-paid', '.html'), L.letterData(order({ status: 'paid', paymentMethod: 'wire', price_check: 'skipped' }), 'paid')));
  assert.match(other, /We have received your payment for order BF-1001\./);
  assert.equal(/blockchain|Total paid/.test(other), false);
  assert.equal(render(read('order-paid', '.subject.txt'), {ref: 'BF-1001'}).trim(), 'Payment received for order BF-1001');
});

test('shipped letter: carrier, number, a link for a known carrier and none for Other', () => {
  const fedex = L.letterData(order({ status: 'shipped', trackingNumber: '123456789012', carrier: 'FedEx' }), 'shipped');
  const html = render(read('order-shipped', '.html'), fedex);
  assert.match(html, /<a href="https:\/\/www\.fedex\.com\/fedextrack\/\?trknbr=123456789012"/);
  const text = readable(html);
  assert.match(text, /Your order BF-1001 is on its way\./);
  assert.match(text, /Carrier: FedEx Tracking number: 123456789012/);
  assert.match(text, /Tracking can take up to 24 hours to show the first update\./);
  assert.match(text, /Shipping to: 1 Main St, LA CA 90001, US/);
  assert.equal(render(read('order-shipped', '.subject.txt'), fedex).trim(), 'Your order BF-1001 has shipped');
  const other = render(read('order-shipped', '.html'), L.letterData(order({ status: 'shipped', trackingNumber: 'ABC-99', carrier: 'Other' }), 'shipped'));
  assert.equal(/<a href/.test(other), false);
  assert.match(readable(other), /Carrier: Other Tracking number: ABC-99/);
});

test('in-transit letter: same tracking block, its own words and subject', () => {
  const data = L.letterData(order({ status: 'in-transit', trackingNumber: '1Z999AA10123456784', carrier: 'UPS' }), 'in_transit');
  const html = render(read('order-in-transit', '.html'), data);
  assert.match(readable(html), /Your order BF-1001 is moving through the carrier network\./);
  assert.match(html, /href="https:\/\/www\.ups\.com\/track\?tracknum=1Z999AA10123456784"/);
  assert.equal(render(read('order-in-transit', '.subject.txt'), data).trim(), 'Your order BF-1001 is in transit');
});

test('delivered letter asks to check the parcel and has no catalogue push', () => {
  const data = L.letterData(order({ status: 'delivered', trackingNumber: '123456789012', carrier: 'FedEx' }), 'delivered');
  const text = readable(render(read('order-delivered', '.html'), data));
  assert.match(text, /Your order BF-1001 has been marked as delivered\./);
  assert.match(text, /Please check that everything arrived complete and intact\. If anything is missing or damaged, reply to this email and include your order number\./);
  assert.match(text, /Thank you for choosing BioLabs Research\./);
  assert.equal(/catalog|shop now|% off/i.test(text), false);
  assert.equal(render(read('order-delivered', '.subject.txt'), data).trim(), 'Your order BF-1001 has been delivered');
  const noTrack = readable(render(read('order-delivered', '.html'), L.letterData(order({ status: 'delivered' }), 'delivered')));
  assert.equal(/Tracking number/.test(noTrack), false, 'a delivered order with no number does not show an empty line');
});

test('a hostile first name and product name arrive escaped and cannot open a tag', () => {
  const evil = order({ customer: { firstName: '<img src=x onerror=alert(1)>', email: 'a@b.co' }, items: [{ name: '<script>alert(1)</script>', mg: '"><b>', qty: 1, price: 1 }] });
  const html = render(read('order-customer', '.html'), L.letterData(evil, 'confirmation'));
  assert.equal(/<script|<img|<b>/.test(html), false);
  assert.match(html, /&lt;script&gt;/);
});

test('every letter renders with no Liquid left over and no undefined/nil text', () => {
  const o = order({ status: 'shipped', trackingNumber: '123456789012', carrier: 'DHL' });
  for (const [type, name] of Object.entries(NAMES)) {
    const data = L.letterData(o, type);
    for (const ext of ['.html', '.subject.txt', '.preheader.txt']) {
      const out = render(read(name, ext), data);
      assert.equal(/\{\{|\}\}|\{%|%\}|undefined|\bnil\b|null/.test(out), false, name + ext);
    }
  }
});
