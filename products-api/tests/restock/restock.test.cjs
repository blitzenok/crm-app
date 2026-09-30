'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../restock.cjs');

const NOW = Date.parse('2026-09-30T12:00:00Z');
const CATALOG = [
  { slug: 'bpc-157', name: 'BPC-157', strengths: ['5mg', '10 mg'], is_active: true },
  { slug: 'glow-70', name: 'GLOW', strengths: ['70mg'], is_active: true },
  { slug: 'solvent', name: 'Solvent', is_active: true },
  { slug: 'old-one', name: 'Old', strengths: ['10mg'], is_active: false },
  { slug: 'px', name: 'PX', strengths: [], strength_prices: { '20mg': 50, '40mg': 90 } }
];
const looksLikeEmail = (v) => typeof v === 'string' && v.length <= 200 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v.trim());
// The stock file says every key of the catalog is out: a subscription is only taken for what is out (spec change 01.10).
const OUT_ALL = { ok: true, items: { 'bpc-157-5mg': 'out', 'bpc-157-10mg': 'out', 'glow-70-70mg': 'out', 'solvent': 'out', 'px-20mg': 'out', 'px-40mg': 'out' } };
const ctx = (over) => Object.assign({ products: CATALOG, status: OUT_ALL, looksLikeEmail, isExcluded: (e) => /@example\.com$/.test(e), cfg: { mode: 'off', testTo: new Set() } }, over);
let n = 0;
const ids = { randomHex: (b) => String(++n).padStart(b * 2, '0') };
const sub = (over) => Object.assign({ id: 'rs_0000000000000001', email: 'ann@mail.net', key: 'bpc-157-5mg', slug: 'bpc-157', mg: '5mg', name: 'BPC-157',
  token: 'a'.repeat(32), createdAt: '2026-09-29T00:00:00.000Z', status: 'pending' }, over);

test('keyFor: slug and strength as the agents\' map and the carts key them', () => {
  assert.equal(R.keyFor('BPC-157', '10 MG'), 'bpc-157-10mg');
  assert.equal(R.keyFor('solvent', ''), 'solvent');
  assert.equal(R.keyFor('solvent', undefined), 'solvent');
});

test('parseConfig: off unless test or on; junk is reported and means off; test needs a recipient list', () => {
  assert.equal(R.parseConfig({}).mode, 'off');
  assert.equal(R.parseConfig({ RESTOCK_MODE: 'ON' }).mode, 'on');
  const bad = R.parseConfig({ RESTOCK_MODE: 'maybe' });
  assert.equal(bad.mode, 'off'); assert.match(bad.problems.join(), /unknown RESTOCK_MODE/);
  const t = R.parseConfig({ RESTOCK_MODE: 'test', ORDER_LETTERS_TEST_TO: 'A@x.com, b@y.com ,' });
  assert.deepEqual([...t.testTo].sort(), ['a@x.com', 'b@y.com']); assert.deepEqual(t.problems, []);
  assert.match(R.parseConfig({ RESTOCK_MODE: 'test' }).problems.join(), /ORDER_LETTERS_TEST_TO is empty/);
});

test('templateId: from the env file, then the process, empty when neither', () => {
  assert.equal(R.templateId({ CIO_LETTER_RESTOCK_MSG_ID: ' 9 ' }, {}), '9');
  assert.equal(R.templateId({}, { CIO_LETTER_RESTOCK_MSG_ID: '7' }), '7');
  assert.equal(R.templateId({}, {}), '');
});

test('parseStatus: fresh file gives the items; older than 3 h, from the future, unreadable or malformed gives a reason', () => {
  const file = (over) => JSON.stringify(Object.assign({ updatedAt: new Date(NOW - 60000).toISOString(), items: { 'a-1mg': 'out', 'b-2mg': 'in', 'c-3mg': 'weird' } }, over));
  const ok = R.parseStatus(file(), NOW);
  assert.equal(ok.ok, true); assert.equal(ok.items['a-1mg'], 'out'); assert.equal(ok.items['b-2mg'], 'in'); assert.equal(ok.items['c-3mg'], undefined);
  assert.equal(R.parseStatus(file({ updatedAt: new Date(NOW - 3 * 3600 * 1000 - 1000).toISOString() }), NOW).reason, 'stale');
  assert.equal(R.parseStatus(file({ updatedAt: new Date(NOW - 3 * 3600 * 1000 + 5000).toISOString() }), NOW).ok, true);
  assert.equal(R.parseStatus(file({ updatedAt: new Date(NOW + 3600 * 1000).toISOString() }), NOW).reason, 'future');
  assert.equal(R.parseStatus(file({ updatedAt: 'yesterday' }), NOW).reason, 'malformed');
  assert.equal(R.parseStatus(file({ items: [] }), NOW).reason, 'malformed');
  assert.equal(R.parseStatus('{ half', NOW).reason, 'unreadable');
  assert.equal(R.parseStatus(undefined, NOW).reason, 'unreadable');
});

test('publicOut: only the "out" keys, sorted, no numbers; anything not ok is an empty list', () => {
  const st = R.parseStatus(JSON.stringify({ updatedAt: new Date(NOW).toISOString(), items: { 'z-1mg': 'out', 'a-1mg': 'out', 'm-1mg': 'in' } }), NOW);
  assert.deepEqual(R.publicOut(st), { out: ['a-1mg', 'z-1mg'] });
  assert.deepEqual(R.publicOut({ ok: false, reason: 'stale' }), { out: [] });
});

test('validateSubscribe: a good body gives the record fields; the address is lower-cased, the catalog spelling of the strength kept', () => {
  const v = R.validateSubscribe({ email: ' Ann@Mail.NET ', slug: 'BPC-157', mg: '10mg', website: '' }, ctx());
  assert.deepEqual(v, { ok: true, sub: { email: 'ann@mail.net', key: 'bpc-157-10mg', slug: 'bpc-157', mg: '10 mg', name: 'BPC-157' } });
});

test('validateSubscribe: a product with one strength and no mg sent takes that strength; no strengths at all means no mg; several strengths need one', () => {
  assert.equal(R.validateSubscribe({ email: 'a@b.co', slug: 'glow-70' }, ctx()).sub.key, 'glow-70-70mg');
  assert.equal(R.validateSubscribe({ email: 'a@b.co', slug: 'solvent', mg: '' }, ctx()).sub.key, 'solvent');
  const many = R.validateSubscribe({ email: 'a@b.co', slug: 'bpc-157' }, ctx());
  assert.equal(many.ok, false); assert.match(many.error, /strength/i);
  assert.equal(R.validateSubscribe({ email: 'a@b.co', slug: 'px', mg: '40mg' }, ctx()).sub.key, 'px-40mg');   // strengths from strength_prices when the list is empty
});

test('validateSubscribe: the bot trap answers ok and stores nothing, whatever else is in the body', () => {
  assert.deepEqual(R.validateSubscribe({ email: 'nonsense', slug: 'nope', website: 'http://spam' }, ctx()), { ok: true, ignore: 'trap' });
  assert.deepEqual(R.validateSubscribe({ email: 'a@b.co', slug: 'glow-70', website: ['x'] }, ctx()), { ok: true, ignore: 'trap' });
  assert.equal(R.validateSubscribe({ email: 'a@b.co', slug: 'glow-70', website: '   ' }, ctx()).ok, true);
  assert.equal(R.validateSubscribe({ email: 'a@b.co', slug: 'glow-70', website: '   ' }, ctx()).ignore, undefined);
});

test('validateSubscribe: 400 for a bad body, address, slug (unknown or inactive) or strength (not the product\'s)', () => {
  const bad = (body) => { const r = R.validateSubscribe(body, ctx()); assert.equal(r.ok, false, JSON.stringify(body)); assert.equal(typeof r.error, 'string'); };
  bad(null); bad([]); bad('x'); bad({});
  bad({ email: 5, slug: 'glow-70' }); bad({ email: 'nope', slug: 'glow-70' }); bad({ email: 'a'.repeat(200) + '@b.co', slug: 'glow-70' });
  bad({ email: 'a@b.co' }); bad({ email: 'a@b.co', slug: 5 }); bad({ email: 'a@b.co', slug: 'nope' }); bad({ email: 'a@b.co', slug: 'old-one', mg: '10mg' });
  bad({ email: 'a@b.co', slug: 'bpc-157', mg: '99mg' }); bad({ email: 'a@b.co', slug: 'bpc-157', mg: 5 }); bad({ email: 'a@b.co', slug: 'bpc-157', mg: '5mg'.repeat(20) });
  bad({ email: 'a@b.co', slug: '__proto__' }); bad({ email: 'a@b.co', slug: 'constructor' });
});

test('validateSubscribe: a marketing-excluded address is answered like success and stored nowhere; in test mode a listed address is not excluded', () => {
  assert.deepEqual(R.validateSubscribe({ email: 'x@example.com', slug: 'glow-70' }, ctx()), { ok: true, ignore: 'excluded' });
  const listed = ctx({ cfg: { mode: 'test', testTo: new Set(['x@example.com']) } });
  assert.equal(R.validateSubscribe({ email: 'x@example.com', slug: 'glow-70' }, listed).sub.email, 'x@example.com');
  const offList = ctx({ cfg: { mode: 'off', testTo: new Set(['x@example.com']) } });
  assert.equal(R.validateSubscribe({ email: 'x@example.com', slug: 'glow-70' }, offList).ignore, 'excluded');
});

test('addSubscription: a new pending record with id, token and time; the same pair again is a duplicate and changes nothing', () => {
  const f = { email: 'ann@mail.net', key: 'glow-70-70mg', slug: 'glow-70', mg: '70mg', name: 'GLOW' };
  const list = [];
  const r = R.addSubscription(list, f, NOW, ids);
  assert.equal(r.result, 'created'); assert.equal(list.length, 1);
  assert.match(list[0].id, /^rs_[0-9a-f]{16}$/); assert.match(list[0].token, /^[0-9a-f]{32}$/);
  assert.equal(list[0].status, 'pending'); assert.equal(list[0].createdAt, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'email', 'id', 'key', 'mg', 'name', 'slug', 'status', 'token']);
  assert.equal(R.addSubscription(list, f, NOW, ids).result, 'duplicate'); assert.equal(list.length, 1);
  // another strength, another address: new records; a sent or cancelled one does not block a new subscription
  assert.equal(R.addSubscription(list, Object.assign({}, f, { key: 'glow-70-90mg' }), NOW, ids).result, 'created');
  list[0].status = 'sent';
  assert.equal(R.addSubscription(list, f, NOW, ids).result, 'created');
});

test('addSubscription: at most 20 pending per address and 5000 in all; past that nothing is written', () => {
  const list = [];
  for (let i = 0; i < R.MAX_PENDING_PER_EMAIL; i++) R.addSubscription(list, { email: 'ann@mail.net', key: 'k' + i, slug: 's', mg: '', name: 'N' }, NOW, ids);
  assert.equal(R.addSubscription(list, { email: 'ann@mail.net', key: 'other', slug: 's', mg: '', name: 'N' }, NOW, ids).result, 'cap_email');
  assert.equal(list.length, 20);
  list[0].status = 'cancelled';
  assert.equal(R.addSubscription(list, { email: 'ann@mail.net', key: 'other', slug: 's', mg: '', name: 'N' }, NOW, ids).result, 'created');
  const big = Array.from({ length: R.MAX_PENDING_TOTAL }, (_, i) => sub({ id: 'rs_' + i, email: 'u' + i + '@mail.net' }));
  assert.equal(R.addSubscription(big, { email: 'new@mail.net', key: 'k', slug: 's', mg: '', name: 'N' }, NOW, ids).result, 'cap_total');
  assert.equal(big.length, R.MAX_PENDING_TOTAL);
});

test('unsubscribe: the token (of a record in any status) cancels every pending subscription of that address; unknown or malformed tokens change nothing', () => {
  const list = [sub(), sub({ id: 'rs_2', key: 'glow-70-70mg', token: 'b'.repeat(32) }), sub({ id: 'rs_3', token: 'c'.repeat(32), status: 'sent', key: 'x-1mg' }),
    sub({ id: 'rs_4', email: 'bob@mail.net', token: 'd'.repeat(32) })];
  assert.equal(R.unsubscribe(list, 'nonsense'), 0);
  assert.equal(R.unsubscribe(list, 'e'.repeat(32)), 0);
  assert.equal(R.unsubscribe(list, undefined), 0);
  assert.equal(R.unsubscribe(list, 'c'.repeat(32), NOW), 2, 'a used (sent) link still works: it finds the address');
  assert.deepEqual(list.map(s => s.status), ['cancelled', 'cancelled', 'sent', 'pending']);
  assert.equal(list[0].cancelledAt, new Date(NOW).toISOString());
  assert.equal(R.unsubscribe(list, 'a'.repeat(32), NOW), 0, 'nothing pending is left');
});

test('expireOld: pending older than 120 days is expired without a letter; younger and other statuses stay', () => {
  const old = new Date(NOW - 121 * 86400000).toISOString(), young = new Date(NOW - 119 * 86400000).toISOString();
  const list = [sub({ id: 'a', createdAt: old }), sub({ id: 'b', createdAt: young }), sub({ id: 'c', createdAt: old, status: 'sent' }), sub({ id: 'd', createdAt: 'garbage' })];
  assert.equal(R.expireOld(list, NOW), 1);
  assert.deepEqual(list.map(s => s.status), ['expired', 'pending', 'sent', 'pending']);
  assert.equal(list[0].expiredAt, new Date(NOW).toISOString());
});

const CFG_ON = { mode: 'on', testTo: new Set() };
const C = (over) => Object.assign({ looksLikeEmail, isExcluded: () => false, sentIds: new Set() }, over);

test('letterAllowed: only a pending subscription with a usable, not excluded address, and only with the mode on or test', () => {
  assert.deepEqual(R.letterAllowed(sub(), CFG_ON, C()), { ok: true });
  assert.equal(R.letterAllowed(sub(), { mode: 'off' }, C()).reason, 'mode_off');
  assert.equal(R.letterAllowed(sub({ status: 'sent' }), CFG_ON, C()).reason, 'not_pending');
  assert.equal(R.letterAllowed(sub({ status: 'cancelled' }), CFG_ON, C()).reason, 'not_pending');
  assert.equal(R.letterAllowed(sub({ email: 'nope' }), CFG_ON, C()).reason, 'no_email');
  assert.equal(R.letterAllowed(sub(), CFG_ON, C({ isExcluded: () => true })).reason, 'excluded');
  assert.equal(R.letterAllowed(null, CFG_ON, C()).reason, 'no_sub');
});

test('letterAllowed: test mode sends only to the listed addresses (which are not "excluded" then); everyone else is "would send"', () => {
  const cfg = { mode: 'test', testTo: new Set(['ann@mail.net']) };
  assert.deepEqual(R.letterAllowed(sub(), cfg, C({ isExcluded: () => true })), { ok: true });
  assert.equal(R.letterAllowed(sub({ email: 'bob@mail.net' }), cfg, C()).reason, 'not_test_recipient');
  assert.equal(R.letterAllowed(sub({ email: 'bob@mail.net' }), cfg, C({ isExcluded: () => true })).reason, 'excluded');
});

test('dueForLetter: pending subscriptions whose key is "in" are sent; "out", unknown keys and already queued ones are not', () => {
  const items = { 'bpc-157-5mg': 'in', 'glow-70-70mg': 'out', 'x-1mg': 'in' };
  const list = [sub({ id: 'a' }), sub({ id: 'b', key: 'glow-70-70mg' }), sub({ id: 'c', key: 'unknown-1mg' }), sub({ id: 'd', status: 'sent' }), sub({ id: 'e', key: 'x-1mg', email: 'eve@mail.net' })];
  const r = R.dueForLetter(list, items, CFG_ON, NOW, C());
  assert.deepEqual(r.send.map(s => s.id), ['a', 'e']); assert.deepEqual(r.would, []);
});

test('dueForLetter: a subscription queued less than 49 h ago (or sent by this process) is left alone; after that it is tried again', () => {
  const items = { 'bpc-157-5mg': 'in' };
  const fresh = sub({ id: 'a', queuedAt: new Date(NOW - 3600 * 1000).toISOString() });
  const stale = sub({ id: 'b', queuedAt: new Date(NOW - 50 * 3600 * 1000).toISOString() });
  const mine = sub({ id: 'c' });
  const r = R.dueForLetter([fresh, stale, mine], items, CFG_ON, NOW, C({ sentIds: new Set(['c']) }));
  assert.deepEqual(r.send.map(s => s.id), ['b']);
});

test('dueForLetter: test mode splits listed recipients (send) from the rest (would); at most 30 a tick', () => {
  const items = { 'bpc-157-5mg': 'in' };
  const cfg = { mode: 'test', testTo: new Set(['ann@mail.net']) };
  const r = R.dueForLetter([sub({ id: 'a' }), sub({ id: 'b', email: 'bob@mail.net' })], items, cfg, NOW, C());
  assert.deepEqual(r.send.map(s => s.id), ['a']); assert.deepEqual(r.would.map(s => s.id), ['b']);
  const many = Array.from({ length: 45 }, (_, i) => sub({ id: 'm' + i, email: 'u' + i + '@mail.net' }));
  assert.equal(R.dueForLetter(many, items, CFG_ON, NOW, C()).send.length, R.MAX_PER_TICK);
});

test('markQueued and markSent: the times go on the record; markSent leaves no pending behind', () => {
  const list = [sub({ id: 'a' }), sub({ id: 'b' })];
  R.markQueued(list, ['a'], NOW);
  assert.equal(list[0].queuedAt, new Date(NOW).toISOString()); assert.equal(list[1].queuedAt, undefined);
  assert.equal(R.markSent(list, 'a', NOW + 1000), true);
  assert.equal(list[0].status, 'sent'); assert.equal(list[0].sentAt, new Date(NOW + 1000).toISOString());
  assert.equal(R.markSent(list, 'nope', NOW), false);
});

test('letterData: exactly the five fields of the contract, everything typed goes through the scrub, links built from the record', () => {
  const d = R.letterData(sub({ name: 'A "B" <i>', mg: '5mg', slug: 'bpc-157', token: 'f'.repeat(32) }), {});
  assert.deepEqual(Object.keys(d).sort(), ['product_name', 'product_name_plain', 'product_url', 'strength', 'unsubscribe_url']);
  assert.equal(d.product_name, 'A &quot;B&quot; &lt;i&gt;');
  assert.equal(d.strength, '5mg');
  assert.equal(d.product_url, 'https://biolabsresearch.co/products/bpc-157');
  assert.equal(d.unsubscribe_url, 'https://biolabsresearch.co/api/restock-unsubscribe?t=' + 'f'.repeat(32));
  assert.equal(R.letterData(sub({ mg: '' }), {}).strength, '');
  assert.equal(R.letterData(sub({ slug: 'a b/c' }), {}).product_url, 'https://biolabsresearch.co/products/a%20b%2Fc');
  const custom = R.letterData(sub({ name: 'X' }), { mailSafe: (v) => 'S:' + v });
  assert.equal(custom.product_name, 'S:X');
});

test('unsubscribePage: a small English page with a POST form to the same route, the token in a hidden field, no external resource and no address', () => {
  const html = R.unsubscribePage('a'.repeat(32));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<form method="post" action="\/api\/restock-unsubscribe">/);
  assert.match(html, /<input type="hidden" name="t" value="a{32}">/);
  assert.match(html, /<button[^>]*>Stop back-in-stock emails<\/button>/);
  assert.doesNotMatch(html, /https?:\/\/|<script|<img|<link|@/i);
  assert.doesNotMatch(html, /\u2014|\u2013/);
  assert.match(R.unsubscribePage('<script>x</script>'), /name="t" value=""/, 'a token that is not 32 hex is never echoed');
  assert.match(R.unsubscribePage(undefined), /name="t" value=""/);
});

test('unsubscribedPage: the answer of the POST: a small page, no form, same text for every outcome', () => {
  const html = R.unsubscribedPage();
  assert.match(html, /You will not get this notification/);
  assert.doesNotMatch(html, /<form|https?:\/\/|<script|<img|<link|@/i);
  assert.doesNotMatch(html, /\u2014|\u2013/);
});

test('safeId: a subscription id in a log line never carries an address', () => {
  assert.equal(R.safeId('rs_0123456789abcdef'), 'rs_0123456789abcdef');
  assert.equal(R.safeId('ann@mail.net'), '<addr>');
});

// ---- spec change 01.10: review fixes ----
test('validateSubscribe: only for a key that is out now; in, unknown, a stale or unreadable file all answer ok and store nothing; test mode + a listed address is exempt', () => {
  const body = { email: 'a@b.co', slug: 'glow-70' };
  assert.deepEqual(R.validateSubscribe(body, ctx({ status: { ok: true, items: { 'glow-70-70mg': 'in' } } })), { ok: true, ignore: 'not_out' });
  assert.deepEqual(R.validateSubscribe(body, ctx({ status: { ok: true, items: {} } })), { ok: true, ignore: 'not_out' });
  assert.deepEqual(R.validateSubscribe(body, ctx({ status: { ok: false, reason: 'stale' } })), { ok: true, ignore: 'not_out' });
  assert.deepEqual(R.validateSubscribe(body, ctx({ status: undefined })), { ok: true, ignore: 'not_out' });
  assert.equal(R.validateSubscribe(body, ctx({ status: { ok: true, items: { 'glow-70-70mg': 'out' } } })).sub.key, 'glow-70-70mg');
  const cfg = { mode: 'test', testTo: new Set(['a@b.co']) };
  assert.equal(R.validateSubscribe(body, ctx({ cfg, status: { ok: true, items: { 'glow-70-70mg': 'in' } } })).sub.key, 'glow-70-70mg');
  assert.equal(R.validateSubscribe(body, ctx({ cfg, status: undefined })).ok, true);
  assert.equal(R.validateSubscribe({ email: 'other@b.co', slug: 'glow-70' }, ctx({ cfg, status: { ok: true, items: {} } })).ignore, 'not_out', 'another address in test mode is not exempt');
  assert.equal(R.validateSubscribe(body, ctx({ cfg: { mode: 'on', testTo: new Set(['a@b.co']) }, status: { ok: true, items: {} } })).ignore, 'not_out', 'on mode: no exemption');
  assert.equal(R.validateSubscribe({ email: 'a@b.co', slug: 'nope' }, ctx({ status: undefined })).ok, false, 'a bad body is still 400');
});

const F = { email: 'ann@mail.net', key: 'glow-70-70mg', slug: 'glow-70', mg: '70mg', name: 'GLOW' };
test('addSubscription: no new subscription for an address+key whose letter went out in the last 30 days; after that, yes', () => {
  const DAY = 86400000;
  const list = [sub({ key: 'glow-70-70mg', status: 'sent', sentAt: new Date(NOW - 29 * DAY).toISOString() })];
  assert.equal(R.addSubscription(list, F, NOW, ids).result, 'recent_sent'); assert.equal(list.length, 1);
  list[0].sentAt = new Date(NOW - 31 * DAY).toISOString();
  assert.equal(R.addSubscription(list, F, NOW, ids).result, 'created');
  const other = [sub({ key: 'glow-70-70mg', email: 'bob@mail.net', status: 'sent', sentAt: new Date(NOW - DAY).toISOString() }), sub({ key: 'other-1mg', status: 'sent', sentAt: new Date(NOW - DAY).toISOString() })];
  assert.equal(R.addSubscription(other, F, NOW, ids).result, 'created', 'another address or another key does not count');
});

test('addSubscription: ip_hash goes on the record; at most 10 new subscriptions from one ip_hash in 24 hours; other hashes and older ones do not count', () => {
  const DAY = 86400000;
  const list = [];
  for (let i = 0; i < R.MAX_PER_IP_24H; i++) assert.equal(R.addSubscription(list, Object.assign({}, F, { email: 'u' + i + '@mail.net', ipHash: 'h1' }), NOW, ids).result, 'created');
  assert.equal(list[0].ip_hash, 'h1');
  assert.equal(R.addSubscription(list, Object.assign({}, F, { email: 'new@mail.net', ipHash: 'h1' }), NOW, ids).result, 'cap_ip'); assert.equal(list.length, 10);
  assert.equal(R.addSubscription(list, Object.assign({}, F, { email: 'new@mail.net', ipHash: 'h2' }), NOW, ids).result, 'created');
  assert.equal(R.addSubscription(list, Object.assign({}, F, { email: 'later@mail.net', ipHash: 'h1' }), NOW + DAY + 1000, ids).result, 'created', 'after 24 h');
  assert.equal(R.addSubscription([], F, NOW, ids).result, 'created');
  assert.equal('ip_hash' in R.addSubscription([], F, NOW, ids).sub, false, 'no ip given: no field');
});

test('hashIp: sha256(salt + ip) in hex; the same pair gives the same value, another salt another value; no ip gives nothing', () => {
  const crypto = require('crypto');
  assert.equal(R.hashIp('salt', '203.0.113.7'), crypto.createHash('sha256').update('salt203.0.113.7').digest('hex'));
  assert.notEqual(R.hashIp('salt2', '203.0.113.7'), R.hashIp('salt', '203.0.113.7'));
  assert.equal(R.hashIp('salt', ''), undefined); assert.equal(R.hashIp('', '1.2.3.4'), undefined);
});

test('dueForLetter: at most 3 letters per address in a rolling 24 hours (sent or queued counted); the rest stay pending and go when the window opens', () => {
  const HOURS = 3600000;
  const items = { k1: 'in', k2: 'in', k3: 'in', k4: 'in', k5: 'in' };
  const mk = (id, key, over) => sub(Object.assign({ id, key }, over));
  const list = [mk('a', 'k1'), mk('b', 'k2'), mk('c', 'k3'), mk('d', 'k4'), mk('e', 'k5', { email: 'eve@mail.net' })];
  const r = R.dueForLetter(list, items, CFG_ON, NOW, C());
  assert.deepEqual(r.send.map(s => s.id), ['a', 'b', 'c', 'e']);
  const busy = [mk('s1', 'x', { status: 'sent', sentAt: new Date(NOW - 2 * HOURS).toISOString() }), mk('q1', 'x2', { queuedAt: new Date(NOW - HOURS).toISOString() }), mk('a', 'k1'), mk('b', 'k2')];
  assert.deepEqual(R.dueForLetter(busy, items, CFG_ON, NOW, C()).send.map(s => s.id), ['a'], 'one sent and one queued already count');
  const later = [mk('s1', 'x', { status: 'sent', sentAt: new Date(NOW - 25 * HOURS).toISOString() }), mk('a', 'k1'), mk('b', 'k2'), mk('c', 'k3'), mk('d', 'k4')];
  assert.deepEqual(R.dueForLetter(later, items, CFG_ON, NOW, C()).send.map(s => s.id), ['a', 'b', 'c'], 'older than 24 h does not count');
});

test('pruneFinished: sent / cancelled / expired older than 60 days go; pending and younger ones stay; a sent record is never dropped inside the 30-day window', () => {
  const DAY = 86400000, d = (n) => new Date(NOW - n * DAY).toISOString();
  const list = [sub({ id: 'a', status: 'sent', sentAt: d(61), createdAt: d(90) }), sub({ id: 'b', status: 'sent', sentAt: d(40), createdAt: d(90) }), sub({ id: 'c', status: 'sent', sentAt: d(10), createdAt: d(90) }),
    sub({ id: 'd', status: 'cancelled', cancelledAt: d(61), createdAt: d(90) }), sub({ id: 'e', status: 'cancelled', cancelledAt: d(5), createdAt: d(90) }),
    sub({ id: 'f', status: 'expired', createdAt: d(185), expiredAt: d(61) }), sub({ id: 'g', status: 'expired', createdAt: d(130), expiredAt: d(10) }),
    sub({ id: 'h', status: 'pending', createdAt: d(119) }), sub({ id: 'i', status: 'sent', createdAt: d(100) })];   // no sentAt: the age falls back to createdAt
  assert.equal(R.pruneFinished(list, NOW), 4);
  assert.deepEqual(list.map(s => s.id), ['b', 'c', 'e', 'g', 'h']);
});

test('plainName: for the subject: no entities, no control characters, no Liquid braces; the readable name stays', () => {
  assert.equal(R.plainName('GHK-Cu & "Friends" <X>'), 'GHK-Cu & "Friends" <X>');
  assert.equal(R.plainName('A\r\nBcc: x@y.z'), 'A Bcc: x@y.z');
  assert.equal(R.plainName('A {{ trigger.ref }} B {% if %}'), 'A trigger.ref B if');
  assert.equal(R.plainName('  a \t b  '), 'a b');
  assert.equal(R.plainName(undefined), '');
  assert.equal(R.letterData(sub({ name: 'A & B' }), {}).product_name_plain, 'A & B');
  assert.equal(R.letterData(sub({ name: 'A & B' }), {}).product_name, 'A &amp; B');
});

// ---- second review 01.10 ----
test('hashEmail: sha256(salt + "email:" + the address lower-cased); the same address in another spelling gives the same value; no salt or address gives nothing', () => {
  const crypto = require('crypto');
  assert.equal(R.hashEmail('salt', ' Ann@Mail.NET '), crypto.createHash('sha256').update('saltemail:ann@mail.net').digest('hex'));
  assert.equal(R.hashEmail('salt', 'ann@mail.net'), R.hashEmail('salt', 'ANN@mail.net'));
  assert.notEqual(R.hashEmail('salt', 'ann@mail.net'), R.hashIp('salt', 'ann@mail.net'));
  assert.equal(R.hashEmail('', 'a@b.co'), undefined); assert.equal(R.hashEmail('salt', ''), undefined);
});

test('validateSubscribe: an address that unsubscribed is answered ok and never stored again, in test mode too', () => {
  const body = { email: 'Gone@b.co', slug: 'glow-70' };
  const isSuppressed = (e) => e === 'gone@b.co';
  assert.deepEqual(R.validateSubscribe(body, ctx({ isSuppressed })), { ok: true, ignore: 'suppressed' });
  assert.equal(R.validateSubscribe({ email: 'fine@b.co', slug: 'glow-70' }, ctx({ isSuppressed })).ok, true);
  const cfg = { mode: 'test', testTo: new Set(['gone@b.co']) };
  assert.equal(R.validateSubscribe(body, ctx({ isSuppressed, cfg })).ignore, 'suppressed');
});

test('letterAllowed: a suppressed address gets nothing, whatever the mode; dueForLetter leaves its subscriptions pending', () => {
  const isSuppressed = (e) => e === 'ann@mail.net';
  assert.equal(R.letterAllowed(sub(), CFG_ON, C({ isSuppressed })).reason, 'suppressed');
  assert.equal(R.letterAllowed(sub(), { mode: 'test', testTo: new Set(['ann@mail.net']) }, C({ isSuppressed })).reason, 'suppressed');
  assert.deepEqual(R.dueForLetter([sub()], { 'bpc-157-5mg': 'in' }, CFG_ON, NOW, C({ isSuppressed })), { send: [], would: [] });
});

test('dueForLetter: at most 5 letters per address in 7 days on top of 3 a day (sent or queued counted)', () => {
  const DAY = 86400000;
  const items = {}; for (let i = 0; i < 9; i++) items['k' + i] = 'in';
  const mk = (id, key, over) => sub(Object.assign({ id, key }, over));
  const past = [mk('s1', 'x', { status: 'sent', sentAt: new Date(NOW - 2 * DAY).toISOString() }), mk('s2', 'x', { status: 'sent', sentAt: new Date(NOW - 3 * DAY).toISOString() }),
    mk('s3', 'x', { status: 'sent', sentAt: new Date(NOW - 4 * DAY).toISOString() }), mk('q1', 'x', { queuedAt: new Date(NOW - 5 * DAY).toISOString() })];
  const fresh = [mk('a', 'k1'), mk('b', 'k2'), mk('c', 'k3')];
  assert.deepEqual(R.dueForLetter(past.concat(fresh), items, CFG_ON, NOW, C()).send.map(s => s.id), ['a'], '4 in the week already: one more fits');
  const old = [mk('s1', 'x', { status: 'sent', sentAt: new Date(NOW - 8 * DAY).toISOString() })];
  assert.deepEqual(R.dueForLetter(old.concat(fresh), items, CFG_ON, NOW, C()).send.map(s => s.id), ['a', 'b', 'c'], 'older than 7 days does not count');
  const week = [mk('s1', 'k0', { status: 'sent', sentAt: new Date(NOW - 2 * DAY).toISOString() }), mk('s2', 'k0', { status: 'sent', sentAt: new Date(NOW - 3 * DAY).toISOString() }),
    mk('s3', 'k0', { status: 'sent', sentAt: new Date(NOW - 4 * DAY).toISOString() }), mk('s4', 'k0', { status: 'sent', sentAt: new Date(NOW - 5 * DAY).toISOString() }),
    mk('s5', 'k0', { status: 'sent', sentAt: new Date(NOW - 6 * DAY).toISOString() })];
  assert.deepEqual(R.dueForLetter(week.concat(fresh), items, CFG_ON, NOW, C()).send, [], 'five in the week: none');
});
