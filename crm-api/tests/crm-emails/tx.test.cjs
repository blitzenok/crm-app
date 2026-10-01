'use strict';
// Unit tests of the contract check (marketing-emails-tx.cjs): no server, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const tx = require('../../marketing-emails-tx.cjs');

// The field lists of contract.md (stage 1), written out by hand here on purpose: the module keeps its own copy, and this
// second copy is what makes a slip in either of them visible.
const COMMON = ['ref', 'first_name', 'status', 'payment_state', 'paid_via', 'totals_available', 'total_due_server', 'shipping_address', 'shipping_method'];
const ITEMS = ['items', 'subtotal_server', 'shipping_server', 'discount_server', 'discount_pct_server', 'discount_source'];
const TRACK = ['carrier', 'tracking_number', 'tracking_url'];
const EXPECTED = {
  'order-customer': COMMON.concat(ITEMS), 'order-paid': COMMON,
  'order-shipped': COMMON.concat(TRACK), 'order-in-transit': COMMON.concat(TRACK), 'order-delivered': COMMON.concat(TRACK, ['review_url']),
  'order-rating': ['ref', 'first_name', 'review_url']   // services/reviews, 02.10
};

test('contract: six letters, fields exactly as in contract.md (the sixth is the rating letter of services/reviews)', () => {
  assert.deepEqual(Object.keys(tx.CONTRACT).sort(), Object.keys(EXPECTED).sort());
  for (const k of Object.keys(EXPECTED)) assert.deepEqual([...tx.CONTRACT[k]].sort(), [...EXPECTED[k]].sort(), k);
});

test('contractKey: by template name, tolerant of case, spaces and underscores; anything else is null', () => {
  assert.equal(tx.contractKey('order-customer'), 'order-customer');
  assert.equal(tx.contractKey(' Order_Paid '), 'order-paid');
  assert.equal(tx.contractKey('order in transit'), 'order-in-transit');
  assert.equal(tx.contractKey('order-manager'), null);
  assert.equal(tx.contractKey('All uncategorized email messages'), null);
  assert.equal(tx.contractKey(undefined), null);
  assert.equal(tx.contractKey('constructor'), null);
});

test('sample data: exactly the fields of each letter, no more and no fewer', () => {
  for (const k of Object.keys(EXPECTED)) assert.deepEqual(Object.keys(tx.sampleData(k)).sort(), [...EXPECTED[k]].sort(), k);
  assert.deepEqual(tx.sampleData('order-manager'), {});
  assert.deepEqual(tx.sampleData(null), {});
  assert.equal(tx.sampleData('order-customer').items.length, 1);
  // a fresh copy each time: a caller must not be able to change the next sample
  tx.sampleData('order-customer').items.push('x');
  assert.equal(tx.sampleData('order-customer').items.length, 1);
});

test('triggerFields: reads Liquid tags only, in every spelling', () => {
  const names = t => tx.triggerFields(t).map(f => f.name).sort();
  assert.deepEqual(names('<p>{{ trigger.ref }}</p>'), ['ref']);
  assert.deepEqual(names('{% if trigger.items.size > 0 %}{% for i in trigger.items %}{{ i.name }}{% endfor %}{% endif %}'), ['items', 'items']);
  assert.deepEqual(names('{{trigger.ref|upcase}}{{ trigger . first_name }}'), ['first_name', 'ref']);
  assert.deepEqual(names('{{ trigger["ref"] }}{{ trigger[\'carrier\'] }}'), ['carrier', 'ref']);
  assert.deepEqual(names('{% assign x = trigger.ref %}{{ x }}'), ['ref']);
  // not a trigger read
  assert.deepEqual(names('The trigger.ref word in prose, and {{ customer.first_name }} and {{ event.trigger.ref }}'), []);
  assert.deepEqual(names('{{ customer.trigger.zzz }}'), []);
  // dynamic access cannot be checked, so it is reported as unknown
  const dyn = tx.triggerFields('{{ trigger[name] }}');
  assert.equal(dyn.length, 1);
  assert.ok(dyn[0].dynamic);
  assert.ok(tx.triggerFields('{% for x in trigger %}{% endfor %}')[0].dynamic);
});

test('checkLetter: unknown template is not checked at all', () => {
  const r = tx.checkLetter(null, { subject: '', body: '{{ trigger.nothing }} — dose' });
  assert.deepEqual(r, { unknown: [], empty: [], style: [] });
  assert.deepEqual(tx.checkLetter('order-manager', { subject: '', body: '' }), { unknown: [], empty: [], style: [] });
});

test('checkLetter: unknown field in subject, preheader and body, named with its place', () => {
  const r = tx.checkLetter('order-paid', { subject: 'Order {{ trigger.ref }} {{ trigger.bogus }}', preheader_text: '{{ trigger.tracking_number }}', body: '<p>{{ trigger.ref }} {% if trigger.payment_method == "x" %}y{% endif %}</p>' });
  assert.deepEqual(r.unknown.map(u => u.where + ':' + u.field).sort(), ['body:payment_method', 'preheader:tracking_number', 'subject:bogus']);
});

test('checkLetter: tracking fields are allowed only for the three shipping letters (shipped, in-transit, delivered)', () => {
  const body = '<p>{{ trigger.carrier }} {{ trigger.tracking_url }}</p>';
  assert.equal(tx.checkLetter('order-shipped', { subject: 's', body }).unknown.length, 0);
  assert.equal(tx.checkLetter('order-in-transit', { subject: 's', body }).unknown.length, 0);
  assert.equal(tx.checkLetter('order-delivered', { subject: 's', body }).unknown.length, 0);
  assert.equal(tx.checkLetter('order-paid', { subject: 's', body }).unknown.length, 2);
  assert.equal(tx.checkLetter('order-customer', { subject: 's', body: '{{ trigger.subtotal_server }}' }).unknown.length, 0);
  assert.equal(tx.checkLetter('order-shipped', { subject: 's', body: '{{ trigger.subtotal_server }}' }).unknown.length, 1);
});

test('checkLetter: long dash in every spelling; hyphen and en dash are fine', () => {
  const dash = body => tx.checkLetter('order-paid', { subject: 's', body }).style.filter(s => s.kind === 'dash').length;
  assert.equal(dash('a — b'), 1);
  assert.equal(dash('a &mdash; b'), 1);
  assert.equal(dash('a &#8212; b'), 1);
  assert.equal(dash('a &#x2014; b'), 1);
  assert.equal(dash('a - b – c'), 0);
  assert.equal(tx.checkLetter('order-paid', { subject: 'Paid — thanks', body: 'x' }).style[0].where, 'subject');
});

test('checkLetter: stop words, as stems, whole words only', () => {
  const stop = body => tx.checkLetter('order-paid', { subject: 's', body }).style.filter(s => s.kind === 'stop').map(s => s.word);
  assert.deepEqual(stop('<th>Dose</th>'), ['dose']);
  assert.deepEqual(stop('the dosage and DOSING'), ['dose']);
  assert.deepEqual(stop('injection, injected'), ['inject']);
  assert.deepEqual(stop('to be administered'), ['administer']);
  assert.deepEqual(stop('5 mg per kg'), ['per kg']);
  assert.deepEqual(stop('sent Daily'), ['daily']);
  assert.deepEqual(stop('overdose? closed, dosed'), ['dose']);        // "dosed" is a stem hit; "overdose" is not a whole word
  assert.deepEqual(stop('Size, Qty, Price, administrative office, a kilogram'), []);
});

test('checkLetter: empty subject or body of a known letter', () => {
  assert.deepEqual(tx.checkLetter('order-paid', { subject: '  ', body: 'x' }).empty, ['subject']);
  assert.deepEqual(tx.checkLetter('order-paid', { subject: 's', body: '' }).empty, ['body']);
  assert.deepEqual(tx.checkLetter('order-paid', { subject: 's', preheader_text: '', body: 'x' }).empty, []);
});

test('checkLetter: the live tx 3 text of 30.09 reads only fields of the contract (its dash and "Dose" are style findings)', () => {
  const live = [
    '<h2 style="margin:0 0 12px">Thank you — we have your request</h2>',
    '<p>Hi {{ customer.first_name | default: "there" }},</p>',
    '<p>Your order number is <strong>{{ trigger.ref }}</strong>.</p>',
    '{% if trigger.items.size > 0 %}<tr><th>Dose</th></tr>{% for i in trigger.items %}<tr><td>{{ i.name }}</td><td>{{ i.mg }}</td><td>{{ i.qty }}</td><td>${{ i.price }}</td></tr>{% endfor %}{% endif %}',
    '{% if trigger.totals_available %}Subtotal: ${{ trigger.subtotal_server }} Shipping: ${{ trigger.shipping_server }}',
    '{% if trigger.discount_server != "0.00" %}{{ trigger.discount_pct_server }}%{% if trigger.discount_source contains "coupon:" %}{{ trigger.discount_source | remove: "coupon:" }}{% endif %}{% endif %}',
    '<strong>Total: ${{ trigger.total_due_server }}</strong>{% endif %}',
    '{% if trigger.shipping_address != "" %}{{ trigger.shipping_address }}{% if trigger.shipping_method != "" %}{{ trigger.shipping_method }}{% endif %}{% endif %}'
  ].join('\n');
  const r = tx.checkLetter('order-customer', { subject: 'We received your order {{ trigger.ref }}', body: live });
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.style.map(s => s.kind + ':' + s.word).sort(), ['dash:—', 'stop:dose']);
});

test('refusalMessage: names the field first; then empty; then dash; then the stop word', () => {
  const m = r => tx.refusalMessage('order-paid', Object.assign({ unknown: [], empty: [], style: [] }, r));
  assert.match(m({ unknown: [{ field: 'bogus', where: 'body' }] }), /trigger\.bogus \(body\)/);
  assert.match(m({ unknown: [{ field: 'bogus', where: 'body' }] }), /ref, first_name/);
  assert.match(m({ empty: ['body'] }), /body of this letter is empty/);
  assert.match(m({ style: [{ kind: 'dash', word: '—', where: 'subject' }] }), /long dash/);
  assert.match(m({ style: [{ kind: 'stop', word: 'daily', where: 'body' }] }), /"daily" is in the body/);
});

test('contentPayload: the live content goes back whole; read-only parts and nulls do not; our three fields win', () => {
  const live = { id: 3, created: 1, updated: 2, name: 'n', type: 'email', from: 'a@b.c', from_id: null, reply_to_id: null, bcc: '', fake_bcc: true, headers: '[]', subject: 'old', preheader_text: '', body: 'old' };
  const p = tx.contentPayload(live, { subject: 'S', preheader_text: 'P', body: 'B' });
  assert.deepEqual(p, { name: 'n', type: 'email', from: 'a@b.c', bcc: '', fake_bcc: true, headers: '[]', subject: 'S', preheader_text: 'P', body: 'B' });
});

test('triggerFields: a hyphen belongs to the name (trigger.ref-number is not trigger.ref)', () => {
  assert.deepEqual(tx.triggerFields('{{ trigger.ref-number }}').map(f => f.name), ['ref-number']);
  assert.deepEqual(tx.checkLetter('order-paid', { subject: 's', body: '{{ trigger.ref-number }}' }).unknown.map(u => u.field), ['ref-number']);
  assert.deepEqual(tx.triggerFields('{{ trigger.ref | upcase }}').map(f => f.name), ['ref']);
});

test('letterKey: the number in .env wins over the name; without a number the name decides', () => {
  const env = tx.ENV_IDS;
  const saved = {};
  for (const v of Object.values(env)) saved[v] = process.env[v];
  try {
    for (const v of Object.values(env)) delete process.env[v];
    assert.equal(tx.letterKey({ id: 4, name: 'order-paid' }), 'order-paid');
    assert.equal(tx.letterKey({ id: 4, name: 'Some other' }), null);
    process.env[env['order-shipped']] = '4';
    assert.equal(tx.letterKey({ id: 4, name: 'Some other' }), 'order-shipped');
    assert.equal(tx.letterKey({ id: '4', name: 'order-paid' }), 'order-shipped', 'the number is what the shop sends to');
    assert.equal(tx.letterKey({ id: 9, name: 'order-paid' }), 'order-paid');
    assert.equal(tx.letterKey(null), null);
    assert.equal(tx.letterWarnings({ id: 4, name: 'Some other' }).length, 1);
    assert.deepEqual(tx.letterWarnings({ id: 4, name: 'order-shipped' }), []);
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('contentSha: subject, preheader and body all count, and the parts do not run into each other', () => {
  assert.notEqual(tx.contentSha('a', 'b', 'c'), tx.contentSha('a', 'bc', ''));
  assert.notEqual(tx.contentSha('a', 'b', 'c'), tx.contentSha('x', 'b', 'c'));
  assert.equal(tx.contentSha('a', 'b', 'c'), tx.contentSha('a', 'b', 'c'));
});
