'use strict';
// The text of the rating letter (templates/order-rating.*): five star links and a page link built from review_url, only the three fields the server sends,
// the checks the Emails page of the CRM makes on every letter (no long dash, no stop word, no unknown field), and the research-use tone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../../order-letters.cjs');
const tx = require('../../../crm-api/marketing-emails-tx.cjs');
const R = require('../../reviews.cjs');
const V = require('./fixtures/reviews-public.cjs')   // copy of the storefront's reviews.js (biofirst-hosting services/reviews/public), .cjs because of "type": "module";
const { render, readable } = require('../order-letters/liquid-lite.cjs');

const DIR = path.join(__dirname, '..', 'order-letters', 'templates');
const read = (ext) => fs.readFileSync(path.join(DIR, 'order-rating' + ext), 'utf8');
const SECRET = 'template-test-secret-0123456789abcdef';
const ORDER = {
  ref: 'BLR-1001', channel: 'shop', status: 'delivered', savedAt: '2026-10-02T10:00:00.000Z', paymentMethod: 'crypto-usdt-trc', notes: '',
  customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann.lee@realmail.net' }, letters: { delivered: { sentAt: '2026-10-05T10:00:00.000Z' } }
};
const data = () => Object.assign(L.letterData(ORDER, 'rating'), R.letterFields(ORDER, { mode: 'on', secret: SECRET, testTo: new Set() }));
const hrefs = (html) => [...html.matchAll(/<a href="([^"]*)"/g)].map(m => m[1]);

test('the data of the letter is exactly the contract: the number, the name and the link', () => {
  assert.deepEqual(Object.keys(data()).sort(), ['first_name', 'ref', 'review_url']);
  assert.deepEqual([...tx.CONTRACT['order-rating']].sort(), Object.keys(data()).sort());
  assert.deepEqual(Object.keys(tx.sampleData('order-rating')).sort(), ['first_name', 'ref', 'review_url'], 'the test send on the Emails page has the same fields');
});

test('five star links r=1..5 and one page link, all to this order with this address\'s token; no query string anywhere', () => {
  const body = render(read('.html'), data());
  const url = R.reviewUrl(SECRET, 'BLR-1001', 'ann.lee@realmail.net');
  const links = hrefs(body);
  assert.deepEqual(links, [1, 2, 3, 4, 5].map(n => url + '&r=' + n).concat([url]));
  assert.equal((body.match(/★/g) || []).length, 5);
  for (const h of links) {
    assert.equal(h.includes('?'), false);
    const u = new URL(h), f = new URLSearchParams(u.hash.slice(1));
    assert.equal(u.origin + u.pathname, 'https://biolabsresearch.co/review');
    assert.equal(f.get('o'), 'BLR-1001');
    assert.equal(R.tokenOk(SECRET, 'BLR-1001', 'ann.lee@realmail.net', f.get('t')), true);
  }
  // the page's own parser reads every link of the letter back
  links.slice(0, 5).forEach((h, i) => assert.equal(V.parseLink(new URL(h).hash).r, i + 1));
  assert.equal(V.parseLink(new URL(links[5]).hash).r, 0);
});

test('the words: the question, the greeting with a fallback name, the number, a private rating, a review that waits for a person, the research-use line', () => {
  const words = readable(render(read('.html'), data()));
  assert.match(words, /How was your order\?/);
  assert.match(words, /Hi Ann,/);
  assert.match(words, /Your order BLR-1001 was delivered a few days ago/);
  assert.match(words, /Your rating is private and only our team reads it/);
  assert.match(words, /write a review of the products you received/);
  assert.match(words, /appears on the product page only after our team has read it/);
  assert.match(words, /All products are supplied for laboratory research use only\. They are not medicines and are not for human or veterinary use\./);
  assert.match(readable(render(read('.html'), Object.assign(data(), { first_name: '' }))), /Hi there,/);
  assert.equal(render(read('.subject.txt'), data()).trim(), 'How was your order BLR-1001?');
  assert.equal(read('.subject.txt').trim().includes('\n'), false);
  assert.equal(read('.preheader.txt').trim().includes('\n'), false);
  assert.ok(read('.preheader.txt').trim().length > 10);
});

test('no promise or reward for a rating or a review, no urgency, no use or dosing words, no long dash', () => {
  const all = read('.html') + read('.subject.txt') + read('.preheader.txt');
  assert.equal(/[–—]|&mdash;|&#8212;/.test(all), false, 'no long dash');
  for (const re of [/\bdose\b/i, /\bdosage\b/i, /\binject/i, /\badminister/i, /\bper kg\b/i, /\bdaily\b/i]) assert.equal(re.test(all), false, String(re));
  for (const re of [/\bdiscount\b/i, /\bcoupon\b/i, /\bcode\b/i, /\bgift\b/i, /\breward\b/i, /\bfree\b/i, /\bwin\b/i, /\bpoints\b/i, /\boff your next\b/i, /\bhurry\b/i, /\blast chance\b/i, /\bresults?\b/i, /\beffects?\b/i])
    assert.equal(re.test(all), false, 'no incentive or claim: ' + String(re));
});

test('only fields the server sends, every Liquid tag closed, and the Emails page guard accepts the text', () => {
  const html = read('.html');
  const fields = new Set([...(html + read('.subject.txt') + read('.preheader.txt')).matchAll(/trigger\.([A-Za-z_]+)/g)].map(m => m[1]));
  assert.deepEqual([...fields].sort(), ['first_name', 'ref', 'review_url']);
  assert.equal((html.match(/\{%-?\s*if\s/g) || []).length, (html.match(/\{%-?\s*endif\s*-?%\}/g) || []).length);
  assert.deepEqual(tx.checkLetter('order-rating', { subject: read('.subject.txt'), preheader_text: read('.preheader.txt'), body: html }), { unknown: [], empty: [], style: [] });
  const bad = tx.checkLetter('order-rating', { subject: 's', body: html + '{{ trigger.tracking_number }}' });
  assert.equal(bad.unknown.length, 1, 'a field the rating letter does not get is still refused');
  assert.equal(tx.contractKey('order-rating'), 'order-rating');
});

test('the delivered letter text is untouched by this feature (tx 7 is not edited): its review block is still behind {% if trigger.review_url %}', () => {
  const delivered = fs.readFileSync(path.join(DIR, 'order-delivered.html'), 'utf8');
  assert.match(delivered, /\{% if trigger\.review_url %\}/);
  const without = render(delivered, L.letterData(Object.assign({}, ORDER), 'delivered'));
  assert.equal(without.includes('★'), false, 'with no review_url in the data the delivered letter has no stars');
});
