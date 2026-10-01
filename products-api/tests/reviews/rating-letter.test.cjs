'use strict';
// The rules of the rating letter (reviews.cjs, "the rating letter"): which delivered order is due, the boundaries of the delay, the moment REVIEWS_RATING_SINCE
// counts from, an order that was already rated, test mode, the cap of one pass, and the numbers of the report. Pure functions, no files, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../reviews.cjs');
const L = require('../../order-letters.cjs');

const DAY = 86400 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const SINCE = '2026-10-02T00:00:00.000Z';
const ANN = 'ann.lee@realmail.net', BOB = 'bob.reader@realmail.net';
const iso = (ms) => new Date(ms).toISOString();
// an order delivered `daysAgo` days before NOW (the delivered letter went out at that moment)
const order = (ref, daysAgo, over) => Object.assign({
  ref, channel: 'shop', status: 'delivered', savedAt: '2026-10-01T10:00:00.000Z', paymentMethod: 'crypto-usdt-trc', notes: '',
  customer: { firstName: 'Ann', lastName: 'Lee', email: ANN },
  letters: { delivered: { sentAt: iso(NOW - daysAgo * DAY) } }
}, over);
const LETTERS_CFG = { mode: 'on', sinceMs: Date.parse('2026-10-01T00:00:00.000Z'), testTo: new Set() };
function ctx(over) {
  return Object.assign({
    nowMs: NOW, cfg: { mode: 'on', testTo: new Set() }, rating: R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE }),
    ratedRefs: new Set(), lettersVerdict: (o) => L.letterAllowed(o, 'rating', LETTERS_CFG)
  }, over);
}
const reason = (o, c) => { const v = R.ratingLetterDecision(o, c || ctx()); return v.ok ? 'ok' : v.reason; };

test('parseRatingConfig: three days by default, the date is required, a bad delay or date switches the letter off', () => {
  const ok = R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE });
  assert.equal(ok.enabled, true);
  assert.equal(ok.delayMs, 3 * DAY);
  assert.equal(ok.sinceMs, Date.parse(SINCE));
  assert.deepEqual(ok.problems, []);
  assert.equal(R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE, REVIEWS_RATING_DELAY_DAYS: ' 5 ' }).delayMs, 5 * DAY);
  assert.equal(R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE, REVIEWS_RATING_DELAY_DAYS: '0' }).delayMs, 0, 'zero is allowed: the live check in test mode');
  assert.equal(R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE, REVIEWS_RATING_DELAY_DAYS: '0.5' }).delayMs, DAY / 2);
  for (const bad of ['abc', '-1', '61', '1e2', '0x10', '3 days']) {
    const c = R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE, REVIEWS_RATING_DELAY_DAYS: bad });
    assert.equal(c.enabled, false, bad);
    assert.match(c.problems.join(), /REVIEWS_RATING_DELAY_DAYS/, bad);
  }
  for (const missing of [undefined, '', '  ', 'soon', '3', '10/02/2026', '2026-13-45T00:00:00Z']) {
    const c = R.parseRatingConfig({ REVIEWS_RATING_SINCE: missing });
    assert.equal(c.enabled, false, String(missing));
    assert.match(c.problems.join(), /REVIEWS_RATING_SINCE/, String(missing));
  }
  assert.equal(R.parseRatingConfig(undefined).enabled, false);
  assert.equal(R.parseRatingConfig({ REVIEWS_RATING_SINCE: '2026-10-02' }).enabled, true, 'a plain date is a date');
});

test('the delay: exactly N days after delivery is due, a millisecond earlier is not', () => {
  const c = ctx();
  assert.equal(reason(order('BLR-1', 3), c), 'ok');
  assert.equal(reason(order('BLR-2', 3, { letters: { delivered: { sentAt: iso(NOW - 3 * DAY + 1) } } }), c), 'too_early');
  assert.equal(reason(order('BLR-3', 2.9), c), 'too_early');
  assert.equal(reason(order('BLR-4', 17), c), 'ok');
  const one = ctx({ rating: R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE, REVIEWS_RATING_DELAY_DAYS: '1' }) });
  assert.equal(reason(order('BLR-5', 1), one), 'ok');
  assert.equal(reason(order('BLR-6', 0.9), one), 'too_early');
  const zero = ctx({ rating: R.parseRatingConfig({ REVIEWS_RATING_SINCE: SINCE, REVIEWS_RATING_DELAY_DAYS: '0' }) });
  assert.equal(reason(order('BLR-7', 0), zero), 'ok');
});

test('REVIEWS_RATING_SINCE: an order delivered before that moment gets nothing, however long ago; the moment itself counts', () => {
  const c = ctx();
  assert.equal(reason(order('BLR-1', 0, { letters: { delivered: { sentAt: SINCE } } }), c), 'ok', 'exactly at the moment');
  assert.equal(reason(order('BLR-2', 0, { letters: { delivered: { sentAt: iso(Date.parse(SINCE) - 1) } } }), c), 'before_since');
  assert.equal(reason(order('BLR-3', 19), c), 'before_since', 'delivered 19 days before NOW is 2026-10-01 12:00, half a day before the moment');
});

test('the moment of delivery is the delivered letter\'s sentAt: no mark, a broken mark, or a mark on another letter means skipped, never "long ago"', () => {
  const c = ctx();
  assert.equal(reason(order('BLR-1', 9, { letters: undefined }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-2', 9, { letters: {} }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-3', 9, { letters: { delivered: {} } }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-4', 9, { letters: { delivered: { sentAt: 'yesterday-ish' } } }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-5', 9, { letters: { delivered: 'x' } }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-6', 9, { letters: { shipped: { sentAt: iso(NOW - 9 * DAY) } } }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-7', 9, { letters: [] }), c), 'no_delivery_moment');
  assert.equal(reason(order('BLR-8', 9, { updated_at: iso(NOW - 9 * DAY), letters: undefined }), c), 'no_delivery_moment', 'updated_at is not a delivery date');
});

test('a delivered order must still be delivered: cancelled or refunded afterwards, or any other status, is not due', () => {
  for (const status of ['cancelled', 'refunded', 'shipped', 'paid', 'new', '', undefined]) assert.equal(R.ratingLetterDecision(order('BLR-1', 9, { status }), ctx()).ok, false, String(status));
  assert.equal(reason(order('BLR-1', 9, { status: 'cancelled' })), 'not_delivered');
  assert.equal(reason(order('BLR-2', 9, { status: ' Delivered ' })), 'ok', 'case and spaces do not matter');
});

test('who is left out: no address, a test order, a manager\'s wholesale order, our own probe address, an order that already has the letter or a mark', () => {
  assert.equal(reason(order('BLR-1', 9, { customer: { firstName: 'Ann' } })), 'no_email');
  assert.equal(reason(order('BLR-2', 9, { customer: { firstName: 'Ann', email: 'not-an-address' } })), 'no_email');
  assert.equal(reason(order('BF-QA-3', 9, { test: true })), 'test_order');
  assert.equal(reason(order('BLR-4', 9, { notes: 'TEST ORDER please' })), 'test_order');
  assert.equal(reason(order('MS-5', 9, { channel: undefined })), 'letter_not_shop');
  assert.equal(reason(order('BLR-6', 9), ctx({ lettersVerdict: (o) => L.letterAllowed(o, 'rating', Object.assign({}, LETTERS_CFG, { isExcluded: () => true })) })), 'letter_excluded');
  assert.equal(reason(order('BLR-7', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { sentAt: iso(NOW - DAY) } } })), 'already_sent');
  assert.equal(reason(order('BLR-8', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { skipped: 'rated', at: iso(NOW - DAY) } } })), 'already_skipped');
  assert.equal(reason(order('bad ref!', 9)), 'bad_ref');
});

test('an order that already has a rating is "rated": no letter, and the caller marks it; the mark ends it for good', () => {
  const c = ctx({ ratedRefs: new Set(['BLR-1']) });
  assert.equal(reason(order('BLR-1', 9), c), 'rated');
  assert.equal(reason(order('BLR-2', 9), c), 'ok');
  assert.equal(reason(order('BLR-1', 1), c), 'too_early', 'a rated order that is not due yet is left alone until it is');
  const o = order('BLR-1', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, paid: { sentAt: 'x' } } });
  R.markRatingSkipped(o, 'rated', NOW);
  assert.deepEqual(o.letters.rating, { skipped: 'rated', at: iso(NOW) });
  assert.equal(o.letters.paid.sentAt, 'x', 'the other letters\' marks stay');
  assert.equal(reason(o, c), 'already_skipped');
  const fresh = { ref: 'BLR-9', letters: 'junk' };
  R.markRatingSkipped(fresh, 'rated', NOW);
  assert.deepEqual(fresh.letters, { rating: { skipped: 'rated', at: iso(NOW) } }, 'an order with junk in letters starts from an empty one');
});

test('modes: off and a switched-off rating letter send nothing; test mode only to the listed address and writes nothing on anybody else\'s order', () => {
  assert.equal(reason(order('BLR-1', 9), ctx({ cfg: { mode: 'off', testTo: new Set() } })), 'mode_off');
  assert.equal(reason(order('BLR-1', 9), ctx({ cfg: undefined })), 'mode_off');
  assert.equal(reason(order('BLR-1', 9), ctx({ rating: R.parseRatingConfig({}) })), 'rating_off');
  assert.equal(reason(order('BLR-1', 9), ctx({ ratedRefs: undefined })), 'bad_context');
  assert.equal(reason(order('BLR-1', 9), ctx({ nowMs: NaN })), 'bad_context');
  const test1 = { mode: 'test', testTo: new Set([ANN]) };
  assert.equal(reason(order('BLR-1', 9), ctx({ cfg: test1 })), 'ok');
  assert.equal(reason(order('BLR-2', 9, { customer: { firstName: 'Bob', email: BOB } }), ctx({ cfg: test1 })), 'not_test_recipient');
  // a rated order of somebody who is not on the list is "not_test_recipient", never "rated": the sweep must not mark a real buyer's order in test mode
  assert.equal(reason(order('BLR-3', 9, { customer: { firstName: 'Bob', email: BOB } }), ctx({ cfg: test1, ratedRefs: new Set(['BLR-3']) })), 'not_test_recipient');
  assert.equal(reason(order('BLR-4', 9), ctx({ cfg: { mode: 'test', testTo: new Set() } })), 'not_test_recipient', 'test mode with no listed address sends to nobody');
});

test('ratingSweep: due orders are queued, rated ones marked, everything else counted by reason; non-delivered orders are not even looked at', () => {
  const orders = [
    order('BLR-1', 9), order('BLR-2', 4), order('BLR-3', 1), order('BLR-4', 9, { letters: undefined }), order('BLR-5', 9, { status: 'cancelled' }),
    order('BLR-6', 9), order('BLR-7', 20), null, 'junk', { ref: 'BLR-8', status: 'shipped' }, order('BLR-9', 9, { customer: {} })
  ];
  const r = R.ratingSweep(orders, ctx({ ratedRefs: new Set(['BLR-6']) }));
  assert.deepEqual(r.queue, ['BLR-1', 'BLR-2']);
  assert.deepEqual(r.markRated, ['BLR-6']);
  assert.deepEqual(r.counts, { too_early: 1, no_delivery_moment: 1, before_since: 1, no_email: 1 });
  assert.equal(r.examined, 7, 'delivered ones only: 1,2,3,4,6,7,9');
  assert.deepEqual(R.ratingSweep(undefined, ctx()), { examined: 0, queue: [], markRated: [], stale: [], counts: {} });
});

test('at most once: a queuedAt ends the pass\'s interest like a sentAt, only the queue\'s sender (ctx.sending) looks past it; markRatingQueued keeps the other marks; a queuedAt that is old and never became a sentAt is reported as stale, once the order is looked at again', () => {
  const queued = (daysAgo, h) => order('BLR-Q', daysAgo, { letters: { delivered: { sentAt: iso(NOW - daysAgo * DAY) }, rating: { queuedAt: iso(NOW - h * 3600 * 1000) } } });
  assert.equal(reason(queued(9, 0.1)), 'already_queued');
  assert.equal(R.ratingLetterDecision(queued(9, 0.1), ctx({ sending: true })).ok, true, 'the sender lets its own queued item through');
  assert.equal(R.ratingLetterDecision(queued(9, 0.1), ctx({ sending: true, ratedRefs: new Set(['BLR-Q']) })).reason, 'rated', 'and still asks the other rules');
  const sentToo = order('BLR-S', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { queuedAt: iso(NOW), sentAt: iso(NOW) } } });
  assert.equal(R.ratingLetterDecision(sentToo, ctx({ sending: true })).reason, 'already_sent', 'a sent letter is never sent again, also by the sender');
  const o = order('BLR-1', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, paid: { sentAt: 'x' } } });
  R.markRatingQueued(o, NOW);
  assert.deepEqual(o.letters.rating, { queuedAt: iso(NOW) });
  assert.equal(o.letters.paid.sentAt, 'x');
  assert.equal(reason(o), 'already_queued');
  // the sweep: fresh queuedAt is waiting (no stale), an old one without sentAt is stale, a sent one is neither
  const orders = [queued(9, 0.5), queued(9, 5), order('BLR-OK', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { sentAt: iso(NOW - 8 * 3600 * 1000) } } })];
  orders[0].ref = 'BLR-FRESH'; orders[1].ref = 'BLR-OLD';
  const r = R.ratingSweep(orders, ctx());
  assert.deepEqual(r.queue, []);
  assert.deepEqual(r.stale, ['BLR-OLD']);
  assert.deepEqual(r.counts, { already_queued: 2, already_sent: 1 });
  assert.equal(R.RATING_STALE_QUEUE_MS, 2 * 3600 * 1000);
});

test('the attempt mark: the sender refuses an order with a tryAt and no sentAt (unconfirmed_attempt), the pass never gets that far; the mark goes on and off, keeping the others; only certain refusals count as \\"not taken\\"', () => {
  const o = order('BLR-T', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { queuedAt: iso(NOW - 1000), tryAt: iso(NOW - 500) } } });
  assert.equal(R.ratingLetterDecision(o, ctx({ sending: true })).reason, 'unconfirmed_attempt');
  assert.equal(R.ratingLetterDecision(o, ctx()).reason, 'already_queued', 'the pass sees only the queuedAt');
  o.letters.rating.sentAt = iso(NOW);
  assert.equal(R.ratingLetterDecision(o, ctx({ sending: true })).reason, 'already_sent', 'a sent letter is already_sent first');
  const p = order('BLR-P', 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { queuedAt: iso(NOW - 1000) } } });
  assert.equal(R.ratingLetterDecision(p, ctx({ sending: true })).ok, true, 'queuedAt alone lets the sender through');
  R.markRatingTry(p, NOW);
  assert.deepEqual(p.letters.rating, { queuedAt: iso(NOW - 1000), tryAt: iso(NOW) });
  assert.ok(p.letters.delivered.sentAt);
  R.clearRatingTry(p);
  assert.deepEqual(p.letters.rating, { queuedAt: iso(NOW - 1000) });
  const bare = { ref: 'X', letters: 'junk' }; R.markRatingTry(bare, NOW);
  assert.deepEqual(bare.letters, { rating: { tryAt: iso(NOW) } });
  for (const st of [401, 403, 429, 500, 503, 400, 404, 422, 301]) assert.equal(R.ratingNotTaken(st), true, String(st));
  for (const st of [200, 202, 408, undefined, null, 'timeout', 'not_built', NaN]) assert.equal(R.ratingNotTaken(st), false, String(st));
});

test('ratingSweep: the cap of one pass (20 by default); the rest wait for the next pass, which does not repeat the marks', () => {
  assert.equal(R.RATING_SWEEP_MAX, 20);
  const orders = [];
  for (let i = 1; i <= 25; i++) orders.push(order('BLR-' + i, 9));
  const r = R.ratingSweep(orders, ctx());
  assert.equal(r.queue.length, 20);
  assert.deepEqual(r.queue.slice(0, 2), ['BLR-1', 'BLR-2']);
  assert.deepEqual(r.counts, { over_cap: 5 });
  assert.equal(R.ratingSweep(orders, ctx(), 3).queue.length, 3, 'an explicit cap');
  // the letters of the first twenty went out: the next pass sees only the other five
  for (const o of orders.slice(0, 20)) o.letters.rating = { sentAt: iso(NOW) };
  const r2 = R.ratingSweep(orders, ctx());
  assert.deepEqual(r2.queue, ['BLR-21', 'BLR-22', 'BLR-23', 'BLR-24', 'BLR-25']);
  assert.deepEqual(r2.counts, { already_sent: 20 });
  // rated marks are not capped by the letters' cap, and a second pass over marked orders asks nothing again
  const rated = []; for (let i = 1; i <= 30; i++) rated.push(order('R-' + i, 9));
  const rr = R.ratingSweep(rated, ctx({ ratedRefs: new Set(rated.map(o => o.ref)) }));
  assert.equal(rr.markRated.length, 30);
  for (const o of rated) R.markRatingSkipped(o, 'rated', NOW);
  assert.deepEqual(R.ratingSweep(rated, ctx({ ratedRefs: new Set(rated.map(o => o.ref)) })).markRated, []);
});

test('ratingSweep: one broken order does not stop the pass', () => {
  const evil = order('BLR-1', 9);
  Object.defineProperty(evil, 'customer', { get() { throw new Error('boom'); }, enumerable: true });
  const r = R.ratingSweep([evil, order('BLR-2', 9)], ctx());
  assert.deepEqual(r.queue, ['BLR-2']);
  assert.deepEqual(r.counts, { error: 1 });
});

test('ratingLetterStats and the report: letters sent, orders that answered, the share, and how many were rated before the letter was due', () => {
  const sent = (ref) => order(ref, 9, { letters: { delivered: { sentAt: iso(NOW - 9 * DAY) }, rating: { sentAt: iso(NOW - 5 * DAY) } } });
  const orders = [sent('A-1'), sent('A-2'), sent('A-3'), sent('A-4'), order('B-1', 9, { letters: { rating: { skipped: 'rated', at: iso(NOW) } } }), order('C-1', 9), null, 'junk'];
  const ratings = [{ ref: 'A-1', rating: 5 }, { ref: 'A-3', rating: 2 }, { ref: 'B-1', rating: 4 }, null, { rating: 3 }];
  assert.deepEqual(R.ratingLetterStats(orders, ratings), { sent: 4, answered: 2, rate: 50, skippedRated: 1 });
  assert.deepEqual(R.ratingLetterStats([], []), { sent: 0, answered: 0, rate: null, skippedRated: 0 });
  assert.deepEqual(R.ratingLetterStats(undefined, undefined), { sent: 0, answered: 0, rate: null, skippedRated: 0 });
  assert.equal(R.ratingLetterStats([sent('A-1'), sent('A-2'), sent('A-3')], [{ ref: 'A-1' }]).rate, 33.3);
  const data = { ratings: [{ id: 'rt_1', ref: 'A-1', email: ANN, rating: 5, comment: '', flags: [], createdAt: iso(NOW), updatedAt: iso(NOW) }], reviews: [] };
  assert.equal('ratingLetters' in R.adminView(data), false, 'without the orders the report has no letter numbers');
  assert.equal('ratingLetters' in R.adminView(data, null), false);
  assert.deepEqual(R.adminView(data, orders).ratingLetters, { sent: 4, answered: 1, rate: 25, skippedRated: 1 });
});

test('the letter\'s link: review_url for a delivered order of an allowed address, nothing in test mode for anybody else', () => {
  const SECRET = 'rating-test-secret-0123456789abcdef';
  const o = order('BLR-1', 9);
  assert.match(R.letterFields(o, { mode: 'on', secret: SECRET, testTo: new Set() }).review_url, /^https:\/\/biolabsresearch\.co\/review#o=BLR-1&t=[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(R.letterFields(o, { mode: 'test', secret: SECRET, testTo: new Set([BOB]) }), {});
});
