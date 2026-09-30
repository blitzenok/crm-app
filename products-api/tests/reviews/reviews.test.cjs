'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../reviews.cjs');

const SECRET = 'test-reviews-secret-0123456789abcdef';
const ANN = 'ann.lee@realmail.net';
const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const DAY = 86400 * 1000;
const order = (over) => Object.assign({
  ref: 'BLR-1001', status: 'delivered', channel: 'shop', notes: '',
  customer: { firstName: 'alex', lastName: 'kaplan', email: ' Ann.Lee@RealMail.net ' },
  items: [{ name: 'BPC-157', slug: 'bpc-157', mg: '5mg', qty: 1 }, { name: 'TB-500', mg: '5mg', qty: 1 }, { name: 'BPC-157', slug: 'bpc-157', mg: '10mg', qty: 1 }, { name: 'Gone', slug: 'gone-1' }]
}, over);
const CATALOG = [
  { slug: 'bpc-157', name: 'BPC-157', is_active: true },
  { slug: 'tb-500', name: 'TB-500', is_active: true },
  { slug: 'ghk-cu', name: 'GHK-Cu', is_active: false }
];
const hex = () => ({ randomHex: (b) => '0'.repeat(b * 2) });

test('parseConfig: nothing is off; test and on need a secret of 24+ characters; a bad mode is off', () => {
  assert.equal(R.parseConfig({}).mode, 'off');
  assert.equal(R.parseConfig(undefined).mode, 'off');
  assert.equal(R.parseConfig({ REVIEWS_MODE: ' ON ', REVIEWS_SECRET: SECRET }).mode, 'on');
  assert.equal(R.parseConfig({ REVIEWS_MODE: 'test', REVIEWS_SECRET: SECRET, ORDER_LETTERS_TEST_TO: 'A@x.co, b@y.co' }).testTo.has('a@x.co'), true);
  const noSecret = R.parseConfig({ REVIEWS_MODE: 'on' });
  assert.equal(noSecret.mode, 'off'); assert.match(noSecret.problems.join(), /REVIEWS_SECRET/);
  assert.equal(R.parseConfig({ REVIEWS_MODE: 'on', REVIEWS_SECRET: 'short' }).mode, 'off');
  const bad = R.parseConfig({ REVIEWS_MODE: 'yes', REVIEWS_SECRET: SECRET });
  assert.equal(bad.mode, 'off'); assert.match(bad.problems.join(), /unknown REVIEWS_MODE/);
  assert.match(R.parseConfig({ REVIEWS_MODE: 'test', REVIEWS_SECRET: SECRET }).problems.join(), /ORDER_LETTERS_TEST_TO is empty/);
  assert.equal(R.parseConfig({ REVIEWS_MODE: 'off', REVIEWS_SECRET: SECRET }).problems.length, 0);
});

test('token: HMAC of ref and lower-cased address, 32 base64url characters, constant-time compare', () => {
  const t = R.tokenFor(SECRET, 'BLR-1001', ' Ann.Lee@RealMail.net ');
  assert.equal(t.length, 32); assert.match(t, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(t, R.tokenFor(SECRET, 'BLR-1001', ANN), 'the address is lower-cased and trimmed');
  assert.notEqual(t, R.tokenFor(SECRET, 'BLR-1002', ANN));
  assert.notEqual(t, R.tokenFor(SECRET, 'BLR-1001', 'bob@realmail.net'));
  assert.notEqual(t, R.tokenFor(SECRET + 'x', 'BLR-1001', ANN));
  assert.equal(R.tokenOk(SECRET, 'BLR-1001', ANN, t), true);
  assert.equal(R.tokenOk(SECRET, 'BLR-1001', ANN, t.slice(0, 31) + (t.endsWith('A') ? 'B' : 'A')), false);
  for (const bad of ['', undefined, null, 5, t.slice(0, 22), t + 'x', 'x'.repeat(32), {}]) assert.equal(R.tokenOk(SECRET, 'BLR-1001', ANN, bad), false, String(bad));
  assert.equal(R.tokenOk('', 'BLR-1001', ANN, t), false);
  assert.equal(R.tokenOk(SECRET, '', ANN, t), false);
  assert.equal(R.tokenOk(SECRET, 'BLR-1001', '', t), false);
});

test('reviewUrl: the shop page, the number and the token, encoded', () => {
  const u = R.reviewUrl(SECRET, 'BLR-1001', ANN);
  assert.equal(u, 'https://biolabsresearch.co/review#o=BLR-1001&t=' + R.tokenFor(SECRET, 'BLR-1001', ANN));
  assert.match(R.reviewUrl(SECRET, 'A&B=1', ANN), /#o=A%26B%3D1&t=/);
  for (const ref of ['BLR-1001', 'A&B=1', 'x y']) assert.equal(R.reviewUrl(SECRET, ref, ANN).includes('?'), false, 'the token is in the fragment, never in a query');
});

test('orderAllowed: only a delivered order that is not a test order and has an address', () => {
  assert.deepEqual(R.orderAllowed(order()), { ok: true });
  for (const st of ['', 'paid', 'shipped', 'in-transit', 'cancelled', 'refunded', 'processing']) assert.equal(R.orderAllowed(order({ status: st })).reason, 'not_delivered', st);
  assert.equal(R.orderAllowed(order({ status: ' Delivered ' })).ok, true, 'status case and spaces do not matter');
  assert.equal(R.orderAllowed(order({ test: true })).reason, 'test_order');
  assert.equal(R.orderAllowed(order({ notes: 'this is a TEST ORDER' })).reason, 'test_order');
  assert.equal(R.orderAllowed(order(), { isTestOrder: () => true }).reason, 'test_order');
  assert.equal(R.orderAllowed(order({ customer: { email: 'nope' } })).reason, 'no_email');
  assert.equal(R.orderAllowed(order({ customer: {} })).reason, 'no_email');
  assert.equal(R.orderAllowed(order({ ref: 'a b' })).reason, 'bad_ref');
  assert.equal(R.orderAllowed(order({ ref: undefined })).reason, 'bad_ref');
  assert.equal(R.orderAllowed(null).reason, 'no_order');
});

test('modeAllows / letterFields: off gives nothing, test only the listed address, on everybody; never for an order that may not be written about', () => {
  const on = { mode: 'on', secret: SECRET, testTo: new Set() };
  const tst = { mode: 'test', secret: SECRET, testTo: new Set([ANN]) };
  assert.deepEqual(R.letterFields(order(), { mode: 'off', secret: SECRET, testTo: new Set() }), {});
  assert.deepEqual(R.letterFields(order(), null), {});
  assert.deepEqual(Object.keys(R.letterFields(order(), on)), ['review_url']);
  assert.equal(R.letterFields(order(), on).review_url, R.reviewUrl(SECRET, 'BLR-1001', ANN));
  assert.deepEqual(Object.keys(R.letterFields(order(), tst)), ['review_url']);
  assert.deepEqual(R.letterFields(order({ customer: { firstName: 'Bob', email: 'bob@realmail.net' } }), tst), {}, 'test: not a listed address');
  assert.deepEqual(R.letterFields(order({ status: 'shipped' }), on), {});
  assert.deepEqual(R.letterFields(order({ test: true }), on), {});
  assert.deepEqual(R.letterFields(order(), { mode: 'on', secret: '', testTo: new Set() }), {}, 'no secret, no link');
});

test('names: "Alex K." from the order, what cannot be a name is refused, letters only', () => {
  assert.equal(R.defaultName(order()), 'Alex K.');
  assert.equal(R.defaultName(order({ customer: { firstName: 'Anne-Marie', lastName: 'de la Cruz', email: ANN } })), 'Anne-Marie D.');
  assert.equal(R.defaultName(order({ customer: { firstName: 'Zoe', email: ANN } })), 'Zoe');
  assert.equal(R.defaultName(order({ customer: { firstName: '<b>x', lastName: '1', email: ANN } })), 'Verified buyer');
  assert.equal(R.defaultName(order({ customer: { email: ANN } })), 'Verified buyer');
  for (const ok of ['Alex K.', 'Jo', "O'Neil", 'Zoe Ng', 'Jose Maria']) assert.equal(R.validName(ok), ok, ok);
  for (const bad of ['', 'A', 'a@b.co', '<script>', 'Alex 99', 'x'.repeat(31), '..', '  ', null, undefined, '1234']) assert.equal(R.validName(bad), '', String(bad));
  assert.equal(R.validName('  Alex   K. '), 'Alex K.');
});

test('itemsOf: the products of the order that the catalog knows, once each, by slug or by name', () => {
  assert.deepEqual(R.itemsOf(order(), CATALOG), [{ slug: 'bpc-157', name: 'BPC-157' }, { slug: 'tb-500', name: 'TB-500' }]);
  assert.deepEqual(R.itemsOf(order({ items: [{ name: 'ghk-cu' }, { slug: 'GHK-CU', name: 'x' }] }), CATALOG), [{ slug: 'ghk-cu', name: 'GHK-Cu' }], 'a retired product still counts');
  assert.deepEqual(R.itemsOf(order({ items: [] }), CATALOG), []);
  assert.deepEqual(R.itemsOf(order({ items: null }), CATALOG), []);
  assert.deepEqual(R.itemsOf(order({ items: [null, 5, { slug: '../x' }] }), CATALOG), []);
  assert.deepEqual(R.itemsOf(order(), []), []);
  assert.deepEqual(R.itemsOf(order(), undefined), []);
});

test('flagsOf: dosing, use and effect words, links and addresses; distinct, lower case, in order', () => {
  const hits = (t) => R.flagsOf(t);
  for (const w of ['dose', 'Dosing', 'dosage', 'DOSED', 'inject', 'injection', 'injected', 'injecting', '5 mg/kg', '2mcg / kg', 'per kg', 'subq', 'sub-q', 'subcutaneous', 'intramuscular',
    'cycle', 'cycles', 'stack', 'stacking', 'cure', 'cured', 'treat', 'treatment', 'therapy', 'healing', 'felt', 'feel', 'feeling', 'my body', 'side effect', 'side-effects',
    'weight loss', 'fat loss', 'lose weight', 'lost 10 lbs', 'human', 'humans', 'patient', 'doctor', 'prescription', 'prescribed', 'twice a day', 'per day', 'once daily',
    'I took', 'I am taking', 'started taking', 'symptoms', 'administered', 'daily', 'weekly', '5mg', '2.5 mg', '10 mcg', '100 iu', '3 ml', '2 units', '1 unit']) {
    assert.ok(hits('the word ' + w + ' here').length >= 1, 'should flag: ' + w);
  }
  assert.deepEqual(hits('Fast shipping, vial arrived intact, labels clear, purity report matched the page.'), []);
  assert.deepEqual(hits('The vial was sealed and the packaging was excellent'), []);
  assert.deepEqual(hits('See www.spam.example or http://x.y/z or mail me at bob@x.com'), ['www.spam.example', 'http://x.y/z', 'bob@x.com']);
  assert.deepEqual(hits('Dose. DOSE. dose'), ['dose'], 'distinct');
  assert.deepEqual(hits('felt then dose'), ['felt', 'dose']);
  assert.deepEqual(hits('The doctorate of shipping cycles'), ['cycles'], 'a stem inside a longer word is not a hit');
  assert.deepEqual(hits('humanely packed'), []);
  assert.deepEqual(hits('BPC-157 10mg vial'), ['10mg'], 'a strength named in a review goes to the moderator');
  assert.deepEqual(hits('dailyness of weeklies'), [], 'inside a longer word it is not a hit');
  assert.deepEqual(hits('a 5mgx thing and 5 mgs'), []);
  assert.deepEqual(hits('stackable boxes'), []);
  assert.deepEqual(hits(''), []); assert.deepEqual(hits(null), []); assert.deepEqual(hits(undefined), []);
  assert.ok(hits('dose '.repeat(40) + Array.from({ length: 30 }, (_, i) => 'http://a' + i + '.co').join(' ')).length <= 20, 'at most 20');
});

test('flagsOf stays fast on a text made for the regular expressions: a thousand @, a thousand a@, a long address-like run', () => {
  for (const t of ['@'.repeat(1000), 'a@'.repeat(500), 'a'.repeat(999) + '@', ('x@'.repeat(300) + ' ').repeat(2), 'a@b.'.repeat(250), '.'.repeat(1000), 'http://' + 'a'.repeat(990)]) {
    const t0 = process.hrtime.bigint();
    R.flagsOf(t);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, t.slice(0, 12) + '... took ' + ms.toFixed(1) + ' ms');
  }
  assert.deepEqual(R.flagsOf('write to a@b.co or @@@ or x@y'), ['a@b.co']);
});

test('validateRating: an integer 1 to 5 and an optional comment up to 1000 characters', () => {
  assert.deepEqual(R.validateRating({ r: 5 }), { ok: true, r: 5, comment: '' });
  assert.deepEqual(R.validateRating({ r: 3, comment: '  nice\r\nbox  ' }), { ok: true, r: 3, comment: 'nice\nbox' });
  for (const bad of [{ r: 0 }, { r: 6 }, { r: 2.5 }, { r: '4' }, { r: null }, {}, null, [], 'x', { r: 4, comment: 5 }, { r: 4, comment: 'x'.repeat(1001) }]) {
    assert.equal(R.validateRating(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(R.validateRating({ r: 4, comment: 'x'.repeat(1000) }).ok, true);
  assert.equal(R.validateRating({ r: 4, comment: null }).ok, true);
});

test('setRating: one per order, changed for 14 days, then locked; flags on the comment', () => {
  const d = R.emptyData();
  const a = R.setRating(d, { ref: 'BLR-1', email: ANN, r: 5, comment: '' }, NOW, hex());
  assert.equal(a.result, 'created');
  assert.deepEqual(d.ratings[0], { id: 'rt_0000000000000000', ref: 'BLR-1', email: ANN, rating: 5, comment: '', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), flags: [] });
  const b = R.setRating(d, { ref: 'BLR-1', email: ANN, r: 2, comment: 'my dose was fine' }, NOW + 13 * DAY, hex());
  assert.equal(b.result, 'updated'); assert.equal(d.ratings.length, 1);
  assert.equal(d.ratings[0].rating, 2); assert.deepEqual(d.ratings[0].flags, ['dose']);
  assert.equal(d.ratings[0].createdAt, new Date(NOW).toISOString(), 'the 14 days count from the first rating, not from the last change');
  assert.equal(R.setRating(d, { ref: 'BLR-1', email: ANN, r: 4, comment: '' }, NOW + 14 * DAY + 1000, hex()).result, 'locked');
  assert.equal(d.ratings[0].rating, 2, 'a locked rating is not changed');
  assert.equal(R.setRating(d, { ref: 'BLR-2', email: ANN, r: 4, comment: '' }, NOW, hex()).result, 'created');
  assert.equal(d.ratings.length, 2);
});

test('setRating: the file has a ceiling', () => {
  const d = R.emptyData();
  d.ratings = Array.from({ length: R.MAX_RATINGS }, (_, i) => ({ ref: 'R' + i, rating: 5, createdAt: new Date(NOW).toISOString() }));
  assert.equal(R.setRating(d, { ref: 'NEW', email: ANN, r: 5, comment: '' }, NOW, hex()).result, 'cap_total');
  assert.equal(R.setRating(d, { ref: 'R3', email: ANN, r: 4, comment: '' }, NOW, hex()).result, 'updated', 'a change of an existing one still works');
});

test('validateReview: consent, product of the order, 20 to 1000 characters in words, a valid or default name', () => {
  const items = R.itemsOf(order(), CATALOG);
  const good = { slug: 'BPC-157', text: '  Vial arrived sealed and well packed, labels were clear.  ', displayName: '', consent: true };
  assert.deepEqual(R.validateReview(good, items, order()), { ok: true, slug: 'bpc-157', text: 'Vial arrived sealed and well packed, labels were clear.', displayName: 'Alex K.' });
  assert.equal(R.validateReview(Object.assign({}, good, { displayName: 'Sam T.' }), items, order()).displayName, 'Sam T.');
  const bad = (over, re) => { const r = R.validateReview(Object.assign({}, good, over), items, order()); assert.equal(r.ok, false, JSON.stringify(over)); if (re) assert.match(r.error, re); };
  bad({ consent: false }, /agree/); bad({ consent: 'true' }, /agree/); bad({ consent: undefined }, /agree/);
  bad({ slug: 'ghk-cu' }, /Unknown product/); bad({ slug: '../x' }, /Unknown product/); bad({ slug: 5 }, /Unknown product/); bad({ slug: '' });
  bad({ text: 'too short' }, /too short/); bad({ text: 'x'.repeat(1001) }, /too long/); bad({ text: 5 }, /required/); bad({ text: undefined }, /required/);
  bad({ text: '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' }, /words/); bad({ text: '12345 67890 12345 67890 12345' }, /words/);
  bad({ displayName: 'a@b.co' }, /name/); bad({ displayName: 'x'.repeat(40) }, /name/); bad({ displayName: 7 }, /name/);
  assert.equal(R.validateReview(Object.assign({}, good, { text: 'y'.repeat(20) }), items, order()).ok, true, '20 letters is enough');
  assert.equal(R.validateReview(Object.assign({}, good, { text: 'y'.repeat(1000) }), items, order()).ok, true);
  for (const x of [null, [], 'x', 5]) assert.equal(R.validateReview(x, items, order()).ok, false);
});

test('cleanText: control and bidi characters go, line breaks stay, runs of blank lines shrink', () => {
  const dirty = 'a' + String.fromCharCode(0, 7, 0x202e, 0x200b) + 'b\r\n\r\n\r\n\r\nc  \nd';
  assert.equal(R.cleanText(dirty), 'ab\n\nc\nd');
});

test('addReview: pending with flags and product name; one per order and product in any status; ceilings', () => {
  const d = R.emptyData();
  const fields = { ref: 'BLR-1', email: ANN, slug: 'bpc-157', productName: 'BPC-157', displayName: 'Alex K.', text: 'Felt great after the dose, arrived fast.' };
  const a = R.addReview(d, fields, NOW, hex());
  assert.equal(a.result, 'created');
  assert.deepEqual(d.reviews[0], { id: 'rv_0000000000000000', ref: 'BLR-1', email: ANN, slug: 'bpc-157', productName: 'BPC-157', displayName: 'Alex K.', text: fields.text, consent: true, status: 'pending', flags: ['felt', 'dose'], createdAt: new Date(NOW).toISOString() });
  assert.equal(R.addReview(d, fields, NOW, hex()).result, 'duplicate');
  d.reviews[0].status = 'rejected';
  assert.equal(R.addReview(d, fields, NOW, hex()).result, 'duplicate', 'a rejected one is not sent again');
  assert.equal(R.addReview(d, Object.assign({}, fields, { slug: 'tb-500' }), NOW, hex()).result, 'created', 'another product of the same order');
  assert.equal(R.addReview(d, Object.assign({}, fields, { ref: 'BLR-2' }), NOW, hex()).result, 'created', 'the same product of another order');
  const full = R.emptyData();
  full.reviews = Array.from({ length: R.MAX_PENDING }, (_, i) => ({ ref: 'X' + i, slug: 's', status: 'pending' }));
  assert.equal(R.addReview(full, fields, NOW, hex()).result, 'cap_pending');
  const big = R.emptyData();
  big.reviews = Array.from({ length: R.MAX_REVIEWS }, (_, i) => ({ ref: 'X' + i, slug: 's', status: 'approved' }));
  assert.equal(R.addReview(big, fields, NOW, hex()).result, 'cap_total');
});

test('publicReviews: approved only, one product, newest first, nothing that identifies the order or the address', () => {
  const d = R.emptyData();
  const mk = (id, slug, status, at, extra) => Object.assign({ id, ref: 'BLR-' + id, email: ANN, slug, productName: slug, displayName: 'N' + id, text: 'text ' + id, status, flags: [], createdAt: at }, extra || {});
  d.reviews = [mk('a', 'bpc-157', 'approved', '2026-10-01T00:00:00.000Z'), mk('b', 'bpc-157', 'pending', '2026-10-02T00:00:00.000Z'), mk('c', 'bpc-157', 'approved', '2026-10-03T00:00:00.000Z'),
    mk('d', 'tb-500', 'approved', '2026-10-04T00:00:00.000Z'), mk('e', 'bpc-157', 'rejected', '2026-10-05T00:00:00.000Z'), null];
  const out = R.publicReviews(d, 'bpc-157');
  assert.deepEqual(out, [{ displayName: 'Nc', text: 'text c', date: '2026-10' }, { displayName: 'Na', text: 'text a', date: '2026-10' }]);
  assert.doesNotMatch(JSON.stringify(out), /BLR-|realmail|@/);
  assert.deepEqual(R.publicReviews(d, 'nothing-here'), []);
  for (const bad of ['', '../x', 'A B', null, undefined, 5]) assert.deepEqual(R.publicReviews(d, bad), [], String(bad));
  d.reviews = Array.from({ length: 80 }, (_, i) => mk('x' + i, 'bpc-157', 'approved', new Date(NOW + i * 1000).toISOString()));
  assert.equal(R.publicReviews(d, 'bpc-157').length, R.PUBLIC_LIMIT);
});

test('decide: approve and reject from any state, recorded; an unknown id or action changes nothing; the text is never edited', () => {
  const d = R.emptyData();
  R.addReview(d, { ref: 'BLR-1', email: ANN, slug: 'bpc-157', productName: 'BPC-157', displayName: 'Alex K.', text: 'Vial arrived sealed and well packed.' }, NOW, hex());
  const id = d.reviews[0].id;
  const a = R.decide(d, id, 'approve', 'sasha@biolabs.co', NOW + 1000);
  assert.equal(a.result, 'ok'); assert.equal(d.reviews[0].status, 'approved'); assert.equal(d.reviews[0].decidedBy, 'sasha@biolabs.co'); assert.equal(d.reviews[0].decidedAt, new Date(NOW + 1000).toISOString());
  assert.equal(R.decide(d, id, 'reject', 'x', NOW + 2000).result, 'ok'); assert.equal(d.reviews[0].status, 'rejected');
  assert.equal(R.decide(d, id, 'approve', undefined, NOW + 3000).result, 'ok'); assert.equal(d.reviews[0].status, 'approved'); assert.equal(d.reviews[0].decidedBy, '');
  const before = JSON.stringify(d);
  assert.equal(R.decide(d, 'rv_nope', 'approve', 'x', NOW).result, 'not_found');
  assert.equal(R.decide(d, id, 'delete', 'x', NOW).result, 'bad_action');
  assert.equal(R.decide(d, id, undefined, 'x', NOW).result, 'bad_action');
  assert.equal(R.decide(d, 5, 'approve', 'x', NOW).result, 'not_found');
  assert.equal(JSON.stringify(d), before);
  assert.equal(d.reviews[0].text, 'Vial arrived sealed and well packed.');
});

test('ratingStats: count, average, 1 to 5 distribution, by month (oldest first)', () => {
  const r = (n, at) => ({ rating: n, createdAt: at });
  const s = R.ratingStats([r(5, '2026-09-10T00:00:00Z'), r(4, '2026-09-11T00:00:00Z'), r(1, '2026-10-01T00:00:00Z'), r(5, '2026-10-02T00:00:00Z'), r(5, '2026-10-03T00:00:00Z'), null, { rating: 'x' }]);
  assert.equal(s.count, 5); assert.equal(s.average, 4);
  assert.deepEqual(s.distribution, { 1: 1, 2: 0, 3: 0, 4: 1, 5: 3 });
  assert.deepEqual(s.byMonth, [{ month: '2026-09', count: 2, average: 4.5 }, { month: '2026-10', count: 3, average: 3.67 }]);
  assert.deepEqual(R.ratingStats([]), { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, byMonth: [] });
});

test('adminView: all statuses newest first with flags and counts; the ratings with their stats', () => {
  const d = R.emptyData();
  R.addReview(d, { ref: 'BLR-1', email: ANN, slug: 'bpc-157', productName: 'BPC-157', displayName: 'Alex K.', text: 'A dose of patience was needed at customs.' }, NOW, hex());
  R.addReview(d, { ref: 'BLR-2', email: 'bob@realmail.net', slug: 'tb-500', productName: 'TB-500', displayName: 'Bob', text: 'Clean labels and careful packing.' }, NOW + 1000, hex());
  d.reviews[1].id = 'rv_1111111111111111';
  R.decide(d, d.reviews[1].id, 'approve', 'sasha', NOW + 5000);
  R.setRating(d, { ref: 'BLR-1', email: ANN, r: 2, comment: 'slow' }, NOW, hex());
  const v = R.adminView(d);
  assert.deepEqual(v.reviews.map(x => x.ref), ['BLR-2', 'BLR-1']);
  assert.deepEqual(v.reviews[1].flags, ['dose']);
  assert.equal(v.reviews[0].decidedBy, 'sasha');
  assert.deepEqual(v.counts, { pending: 1, approved: 1, rejected: 0 });
  assert.equal(v.ratings[0].comment, 'slow'); assert.equal(v.stats.count, 1); assert.equal(v.stats.average, 2);
});

test('normalizeData: a missing file is empty, a broken shape throws (never replaced by an empty one)', () => {
  assert.deepEqual(R.normalizeData(undefined), { ratings: [], reviews: [] });
  assert.deepEqual(R.normalizeData(null), { ratings: [], reviews: [] });
  const ok = { ratings: [1], reviews: [] };
  assert.equal(R.normalizeData(ok), ok);
  for (const bad of [[], 'x', 5, {}, { ratings: [] }, { ratings: {}, reviews: [] }]) assert.throws(() => R.normalizeData(bad), /malformed/, JSON.stringify(bad));
});

test('createLimiter: a rolling window per key', () => {
  const l = R.createLimiter(3, 1000);
  assert.equal(l.take('a', 0), true); assert.equal(l.take('a', 10), true); assert.equal(l.take('a', 20), true);
  assert.equal(l.take('a', 30), false, 'the 4th');
  assert.equal(l.take('b', 30), true, 'another key');
  assert.equal(l.take('a', 1005), true, 'the first fell out of the window');
  assert.equal(l.take('a', 1015), true);
  assert.equal(l.take('a', 1025), true, 'the one at 20 fell out too');
  assert.equal(l.take('a', 1026), false);
  const f = R.createLimiter(2, 1000);
  assert.equal(f.over('k', 0), false); f.take('k', 0); assert.equal(f.over('k', 1), false); f.take('k', 1);
  assert.equal(f.over('k', 2), true); assert.equal(f.over('k', 1002), false, 'window passed'); assert.equal(f.over('other', 2), false);
});

test('safeId never keeps an address', () => {
  assert.equal(R.safeId('rv_1 bob@realmail.net x'), 'rv_1 <addr> x');
  assert.equal(R.safeId(undefined), '');
  assert.equal(R.safeId('x'.repeat(100)).length, 64);
});
