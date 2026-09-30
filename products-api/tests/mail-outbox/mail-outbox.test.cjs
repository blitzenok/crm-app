'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mo = require('../../mail-outbox.cjs');

const MIN = 60000, HOUR = 3600000;
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
const HOLD = Symbol('hold');
async function until(cond, ms) {
  const end = Date.now() + (ms || 5000);
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting for condition'); await new Promise(r => setTimeout(r, 10)); }
}

// In-memory files, a clock the test moves, and a sender whose answer the test scripts. Queue and dead-list contents
// are kept as JSON text, like the real files, so a test can also break them.
function harness(over) {
  const h = {
    T: T0, queueText: '[]', deadText: '[]', orders: [{ ref: 'A1' }, { ref: 'A2' }, { ref: 'x@y.com' }],
    logs: [], errors: [], calls: [], held: [], writes: 0, script: () => ({ ok: true, status: 200 })
  };
  Object.assign(h, over || {});
  const deps = {
    readQueue: () => JSON.parse(h.queueText),
    writeQueue: (l) => { if (h.failWrite) throw new Error('disk full'); h.writes++; h.queueText = JSON.stringify(l); },
    readDead: () => JSON.parse(h.deadText),
    writeDead: (l) => { h.deadText = JSON.stringify(l); },
    readOrders: () => { if (h.ordersBroken) throw new Error('bad json'); return h.orders; },
    send: (item, order, cb) => {
      h.calls.push({ kind: item.kind, ref: item.ref, data: item.data });
      const r = h.script(item, order);
      if (r === HOLD) h.held.push(cb); else cb(r);
    },
    log: (s) => h.logs.push(s), logError: (s) => h.errors.push(s), now: () => h.T
  };
  h.deps = deps;
  h.box = mo.createMailOutbox(deps);
  h.queue = () => JSON.parse(h.queueText);
  h.dead = () => JSON.parse(h.deadText);
  return h;
}
const REFUSED = { ok: false, status: 403, error: 'HTTP 403' };

test('enqueue puts the item on file and tries at once, without waiting for a tick', () => {
  const h = harness();
  assert.equal(h.box.enqueue('mail_manager', 'A1'), true);
  assert.deepEqual(h.calls, [{ kind: 'mail_manager', ref: 'A1', data: undefined }]);
  assert.deepEqual(h.queue(), [], 'a 2xx took it off the queue');
  assert.deepEqual(h.errors, []);
});

test('a skipped effect counts as done, not as a failure to retry', () => {
  const h = harness({ script: () => ({ ok: true, status: 'skipped' }) });
  h.box.enqueue('mail_customer', 'A1');
  assert.deepEqual(h.queue(), []);
});

test('the item on file carries kind/ref/times only — no order data', () => {
  const h = harness({ script: () => HOLD });
  h.box.enqueue('cio_order_status', 'A1', { status: 'shipped', email: 'leak@example.com', items: [1] });
  const [it] = h.queue();
  assert.deepEqual(Object.keys(it).sort(), ['attempts', 'createdAt', 'data', 'id', 'kind', 'lastError', 'lastStatus', 'nextAt', 'ref']);
  assert.deepEqual(it.data, { status: 'shipped' });
  assert.equal(it.createdAt, '2026-09-30T00:00:00.000Z');
});

test('dedup: mail_* and order_placed by (kind, ref); order_status by (ref, status)', () => {
  const h = harness({ script: () => HOLD });
  assert.equal(h.box.enqueue('mail_manager', 'A1'), true);
  assert.equal(h.box.enqueue('mail_manager', 'A1'), false);
  assert.equal(h.box.enqueue('mail_customer', 'A1'), true);
  assert.equal(h.box.enqueue('cio_order_placed', 'A1'), true);
  assert.equal(h.box.enqueue('cio_order_placed', 'A1'), false);
  assert.equal(h.box.enqueue('mail_manager', 'A2'), true);
  assert.equal(h.box.enqueue('cio_order_status', 'A1', { status: 'paid' }), true);
  assert.equal(h.box.enqueue('cio_order_status', 'A1', { status: 'paid' }), false);
  assert.equal(h.box.enqueue('cio_order_status', 'A1', { status: 'shipped' }), true);
  assert.equal(h.queue().length, 6);
  assert.equal(h.calls.length, 6, 'a duplicate is not sent either');
});

test('a refused attempt is retried at +1, +5, +15, +60, +180, +360 and then every 360 minutes', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  const seen = [];
  for (let n = 1; n <= 8; n++) {
    const it = h.queue()[0];
    assert.equal(it.attempts, n);
    assert.equal(it.lastStatus, 403);
    seen.push((Date.parse(it.nextAt) - h.T) / MIN);
    h.T = Date.parse(it.nextAt);
    await h.box.tick();
  }
  assert.deepEqual(seen, [1, 5, 15, 60, 180, 360, 360, 360]);
});
test('a tick before nextAt sends nothing', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  h.T += 30000;
  await h.box.tick();
  assert.equal(h.calls.length, 1);
});

test('the item that finally goes through is removed and the retry is logged', async () => {
  let ok = false;
  const h = harness({ script: () => (ok ? { ok: true, status: 200 } : REFUSED) });
  h.box.enqueue('mail_customer', 'A1');
  ok = true;
  h.T += MIN;
  await h.box.tick();
  assert.deepEqual(h.queue(), []);
  assert.ok(h.logs.some(l => /delivered mail_customer A1 after 1 failed/.test(l)));
});

test('48 hours after creation a failing item is dead: dead file, DEAD alert line, off the queue', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  h.T = T0 + 47 * HOUR;
  await h.box.tick();                                   // due long ago, fails again, still inside the window
  assert.equal(h.queue().length, 1);
  assert.deepEqual(h.errors.filter(l => l.includes('DEAD')), []);
  h.T = T0 + 48 * HOUR + MIN;
  await h.box.tick();
  assert.deepEqual(h.queue(), []);
  const [d] = h.dead();
  assert.equal(d.kind, 'mail_manager'); assert.equal(d.ref, 'A1');
  assert.equal(d.createdAt, '2026-09-30T00:00:00.000Z');
  assert.equal(d.lastStatus, 403);
  assert.equal(d.attempts, 2);
  assert.equal(d.lastError, 'expired before send', 'the tick after the window does not try again');
  assert.deepEqual(Object.keys(d).sort(), ['attempts', 'createdAt', 'diedAt', 'kind', 'lastError', 'lastStatus', 'ref']);
  const alerts = h.errors.filter(l => l.startsWith('[mail-alert] DEAD '));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^\[mail-alert\] DEAD mail_manager A1 after 2 attempts: expired before send/);
});

test('400, 404 and 422 are dead on the first attempt; other 4xx too, 401/403/408/429/5xx/network are not', () => {
  for (const st of [400, 404, 422, 410]) {
    const h = harness({ script: () => ({ ok: false, status: st, error: 'HTTP ' + st }) });
    h.box.enqueue('cio_order_placed', 'A1');
    assert.deepEqual(h.queue(), [], 'status ' + st);
    assert.equal(h.dead()[0].attempts, 1);
    assert.equal(h.dead()[0].lastStatus, st);
    assert.match(h.errors[0], /^\[mail-alert\] DEAD cio_order_placed A1 after 1 attempts: /);
  }
  for (const st of [401, 403, 408, 429, 500, 502, 503, undefined, 'timeout']) {
    const h = harness({ script: () => ({ ok: false, status: st, error: 'x' }) });
    h.box.enqueue('cio_order_placed', 'A1');
    assert.equal(h.queue().length, 1, 'status ' + st);
    assert.deepEqual(h.dead(), []);
  }
  const h = harness({ script: () => ({ ok: false, status: 'not_built', error: 'not built' }) });
  h.box.enqueue('mail_manager', 'A1');
  assert.deepEqual(h.queue(), [], 'a payload that cannot be built is not retried');
});

test('the dead list keeps the last 200', () => {
  const orders = []; for (let i = 0; i < 205; i++) orders.push({ ref: 'R' + i });
  const h = harness({ orders, script: () => ({ ok: false, status: 400, error: 'bad' }) });
  for (let i = 0; i < 205; i++) h.box.enqueue('mail_manager', 'R' + i);
  const dead = h.dead();
  assert.equal(dead.length, 200);
  assert.equal(dead[0].ref, 'R5'); assert.equal(dead[199].ref, 'R204');
});

test('STUCK: once when the oldest has waited over 30 minutes, again only after 6 hours; cleared logs once', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  h.T = T0 + 29 * MIN; await h.box.tick();
  assert.equal(h.errors.filter(l => l.includes('STUCK')).length, 0);
  h.T = T0 + 31 * MIN; await h.box.tick();
  let stuck = h.errors.filter(l => l.includes('STUCK'));
  assert.equal(stuck.length, 1);
  assert.match(stuck[0], /^\[mail-alert\] STUCK 1 waiting, oldest mail_manager A1 31m, last 403$/);
  h.T = T0 + 3 * HOUR; await h.box.tick();
  h.T = T0 + 5 * HOUR + 30 * MIN; await h.box.tick();
  assert.equal(h.errors.filter(l => l.includes('STUCK')).length, 1, 'not again before 6 hours');
  h.T = T0 + 6 * HOUR + 32 * MIN; await h.box.tick();
  assert.equal(h.errors.filter(l => l.includes('STUCK')).length, 2, 'repeats after 6 hours');
  h.script = () => ({ ok: true, status: 200 });
  h.T += 7 * HOUR; await h.box.tick();
  assert.deepEqual(h.queue(), []);
  assert.equal(h.logs.filter(l => l === '[mail-outbox] backlog cleared').length, 1);
  await h.box.tick();
  assert.equal(h.logs.filter(l => l === '[mail-outbox] backlog cleared').length, 1, 'only once');
});

test('an order that is no longer in orders.json takes its item off the queue', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  h.orders = [];
  h.T += MIN;
  await h.box.tick();
  assert.deepEqual(h.queue(), []);
  assert.equal(h.calls.length, 1, 'nothing was sent for it');
  assert.ok(h.logs.includes('[mail-outbox] dropped mail_manager A1: order gone'));
  assert.deepEqual(h.dead(), []);
});

test('an unreadable orders.json is a failed attempt, not a drop', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  h.ordersBroken = true;
  h.T += MIN;
  await h.box.tick();
  assert.equal(h.queue().length, 1);
  assert.equal(h.queue()[0].lastStatus, 'orders_unreadable');
  assert.equal(h.calls.length, 1);
});

test('a broken queue file is never written over: one alert, no sending from the queue; enqueue sends directly', async () => {
  const h = harness();
  h.queueText = '{not json';
  await h.box.tick(); await h.box.tick();
  assert.equal(h.errors.filter(l => l.startsWith('[mail-alert] QUEUE UNREADABLE') && l.includes('nothing is sent')).length, 1);
  assert.equal(h.writes, 0);
  assert.equal(h.queueText, '{not json');
  assert.equal(h.box.enqueue('mail_manager', 'A1'), false);
  assert.deepEqual(h.calls, [{ kind: 'mail_manager', ref: 'A1', data: undefined }], 'one direct attempt');
  assert.ok(h.errors.some(l => /^\[mail-alert\] QUEUE UNREADABLE, sent once without retry: mail_manager A1$/.test(l)));
  assert.equal(h.writes, 0);
  assert.equal(h.queueText, '{not json');
  h.queueText = '[]';                                   // fixed by hand
  h.box.enqueue('mail_customer', 'A1');
  assert.ok(h.logs.includes('[mail-outbox] queue readable again'));
  assert.equal(h.calls.length, 2);
});

test('a queue file that parses but is not a list is treated as broken too', async () => {
  const h = harness();
  h.queueText = '{"a":1}';
  await h.box.tick();
  assert.equal(h.writes, 0);
  assert.equal(h.errors.filter(l => l.includes('QUEUE UNREADABLE')).length, 1);
});

test('if the queue cannot be written the effect is sent directly, once, with an alert', () => {
  const h = harness({ failWrite: true, script: () => REFUSED });
  assert.equal(h.box.enqueue('mail_manager', 'A1'), false);
  assert.equal(h.calls.length, 1);
  assert.ok(h.errors.some(l => l.startsWith('[mail-alert] QUEUE WRITE FAILED')));
  assert.ok(h.errors.some(l => /QUEUE WRITE FAILED, sent once without retry: mail_manager A1/.test(l)));
});

test('a tick takes at most 20 items, oldest first', async () => {
  const orders = []; for (let i = 0; i < 30; i++) orders.push({ ref: 'R' + i });
  const h = harness({ orders, script: () => HOLD });
  for (let i = 0; i < 30; i++) { h.T = T0 + i; h.box.enqueue('mail_manager', 'R' + i); }
  assert.equal(h.calls.length, 30, 'the immediate attempts');
  h.held.length = 0; h.calls.length = 0;
  // the immediate attempts never answered: a new box on the same files stands for a restart
  const h2 = harness({ orders, queueText: h.queueText, script: () => ({ ok: true, status: 200 }), T: T0 + 60 * MIN });
  await h2.box.tick();
  assert.equal(h2.calls.length, 20);
  assert.deepEqual(h2.calls.map(c => c.ref), Array.from({ length: 20 }, (_, i) => 'R' + i));
  assert.equal(h2.queue().length, 10);
  await h2.box.tick();
  assert.equal(h2.queue().length, 0);
});

test('a pass is not started while the previous one is still running; items are sent one at a time', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1'); h.box.enqueue('mail_manager', 'A2');
  h.T += MIN;
  h.script = () => HOLD;
  h.calls.length = 0;
  const first = h.box.tick();
  assert.equal(h.calls.length, 1, 'the second item waits for the first');
  const second = h.box.tick();
  await second;                                          // returns at once: a pass is running
  assert.equal(h.calls.length, 1);
  h.held.shift()({ ok: true, status: 200 });
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.length, 2);
  h.held.shift()({ ok: true, status: 200 });
  await first;
  assert.deepEqual(h.queue(), []);
});

test('an attempt in flight is not started again by a tick', async () => {
  const h = harness({ script: () => HOLD });
  h.box.enqueue('mail_manager', 'A1');                   // immediate attempt never answers
  await h.box.tick();
  assert.equal(h.calls.length, 1);
});

test('a sender that never answers cannot block the queue: the watchdog records a timeout', async () => {
  const h = harness({ script: () => HOLD, sendTimeoutMs: 20 });
  h.box = mo.createMailOutbox(Object.assign({}, h.deps, { sendTimeoutMs: 20 }));
  h.box.enqueue('mail_manager', 'A1');
  await until(() => h.queue()[0] && h.queue()[0].lastStatus === 'timeout');
  assert.equal(h.queue()[0].lastStatus, 'timeout');
  assert.equal(h.queue()[0].attempts, 1);
  h.held[0]({ ok: true, status: 200 });                  // a late answer changes nothing
  assert.equal(h.queue().length, 1);
});

test('a sender that throws is a failed attempt', () => {
  const h = harness({ script: () => { throw new Error('boom'); } });
  h.box.enqueue('mail_manager', 'A1');
  assert.equal(h.queue()[0].lastStatus, 'send_threw');
});

test('answering twice counts once', () => {
  const h = harness({ script: () => HOLD });
  h.box.enqueue('mail_manager', 'A1');
  h.held[0](REFUSED); h.held[0](REFUSED);
  assert.equal(h.queue()[0].attempts, 1);
});

test('malformed items on file are moved to the dead list, the rest still goes', async () => {
  const h = harness();
  h.queueText = JSON.stringify([null, { kind: 'nope', ref: 'A1', id: 'x' }, { id: 'ok1', kind: 'mail_manager', ref: 'A1', createdAt: new Date(T0).toISOString(), attempts: 0, nextAt: new Date(T0).toISOString() }]);
  await h.box.tick();
  assert.deepEqual(h.queue(), []);
  assert.equal(h.dead().length, 2);
  assert.equal(h.calls.length, 1);
});

test('logs and files carry no addresses, even when a ref or an error text has one', async () => {
  const h = harness({ script: () => ({ ok: false, status: undefined, error: 'not sent (connect ECONNREFUSED for https://api/x/buyer@example.org/events)' }) });
  h.box.enqueue('mail_customer', 'x@y.com');
  h.T = T0 + 31 * MIN; await h.box.tick();
  h.T = T0 + 49 * HOUR; await h.box.tick();
  const all = h.logs.concat(h.errors).join('\n') + h.queueText + h.deadText;
  assert.equal(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/.test(all), false, all);
  assert.ok(all.includes('<addr>'));
});

test('a bad enqueue (unknown kind, no ref) is refused without throwing', () => {
  const h = harness();
  assert.equal(h.box.enqueue('mail_boss', 'A1'), false);
  assert.equal(h.box.enqueue('mail_manager', ''), false);
  assert.equal(h.box.enqueue('mail_manager', undefined), false);
  assert.equal(h.calls.length, 0);
});

test('restart: items on file are picked up by a fresh module when due', async () => {
  const h = harness({ script: () => REFUSED });
  h.box.enqueue('mail_manager', 'A1');
  const h2 = harness({ queueText: h.queueText, T: T0 + 2 * MIN, script: () => ({ ok: true, status: 200 }) });
  await h2.box.tick();
  assert.deepEqual(h2.queue(), []);
  assert.equal(h2.calls.length, 1);
});

test('start() and stop() run the timer without keeping the process alive', async () => {
  const h = harness({ script: () => REFUSED });
  h.box = mo.createMailOutbox(Object.assign({}, h.deps, { intervalMs: 30 }));
  h.box.enqueue('mail_manager', 'A1');
  h.T += MIN;
  h.script = () => ({ ok: true, status: 200 });
  h.box.start();
  await until(() => h.queue().length === 0);
  h.box.stop();
  assert.deepEqual(h.queue(), []);
  assert.ok(h.logs.some(l => /^\[mail-outbox\] on, every 30 ms, 1 waiting$/.test(l)));
});

// ---- review round 2 ---------------------------------------------------------------------------------------------
const stored = (over) => Object.assign({ id: 'i1', kind: 'mail_customer', ref: 'A1', createdAt: new Date(T0).toISOString(), attempts: 0, nextAt: new Date(T0).toISOString(), lastStatus: null, lastError: null }, over);

test('an item older than 48 hours is never sent: it goes dead as "expired before send" (restart after a long stop, on-off-on)', async () => {
  for (const attempts of [0, 3]) {
    const h = harness({ T: T0 + 49 * HOUR });
    h.queueText = JSON.stringify([stored({ attempts, lastStatus: attempts ? 403 : null })]);
    await h.box.tick();
    assert.equal(h.calls.length, 0, 'nothing sent, attempts ' + attempts);
    assert.deepEqual(h.queue(), []);
    assert.equal(h.dead().length, 1);
    assert.equal(h.dead()[0].lastError, 'expired before send');
    assert.equal(h.dead()[0].attempts, attempts);
    assert.ok(h.errors.some(l => /^\[mail-alert\] DEAD mail_customer A1 after \d+ attempts: expired before send$/.test(l)), h.errors.join('|'));
  }
});

test('an item just inside 48 hours is still sent', async () => {
  const h = harness({ T: T0 + 48 * HOUR - MIN });
  h.queueText = JSON.stringify([stored()]);
  await h.box.tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.dead(), []);
});

test('orders.json missing, unreadable or not a list is a failed attempt to retry, never "order gone"', async () => {
  const cases = [
    () => { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; },
    () => { throw new SyntaxError('Unexpected end of JSON input'); },
    () => null,
    () => ({ not: 'a list' })
  ];
  for (const bad of cases) {
    const h = harness({ script: () => REFUSED });
    h.box.enqueue('mail_manager', 'A1');
    h.T += MIN;
    const good = h.deps.readOrders;
    h.box = mo.createMailOutbox(Object.assign({}, h.deps, { readOrders: bad }));
    await h.box.tick();
    assert.equal(h.queue().length, 1);
    assert.equal(h.queue()[0].lastStatus, 'orders_unreadable');
    assert.equal(h.logs.some(l => /order gone/.test(l)), false);
    assert.equal(h.calls.length, 1, 'nothing sent while orders are unreadable');
    // the file comes back: the same item goes out
    h.script = () => ({ ok: true, status: 200 });
    h.box = mo.createMailOutbox(Object.assign({}, h.deps, { readOrders: good }));
    h.T += 10 * MIN;
    await h.box.tick();
    assert.deepEqual(h.queue(), []);
  }
});

test('a direct send that cannot read orders says so instead of dropping silently', () => {
  const h = harness();
  h.queueText = '{broken';
  h.ordersBroken = true;
  h.box.enqueue('mail_manager', 'A1');
  assert.equal(h.calls.length, 0);
  assert.ok(h.errors.some(l => /^\[mail-alert\] .*not sent.*mail_manager A1/.test(l) || /orders unreadable.*mail_manager A1/.test(l)), h.errors.join('|'));
});

test('items with an unparsable createdAt or nextAt are malformed: dead, not retried for ever', async () => {
  const h = harness();
  h.queueText = JSON.stringify([stored({ id: 'b1', createdAt: 'garbage' }), stored({ id: 'b2', nextAt: 'soon' }), stored({ id: 'b3', createdAt: null }), stored({ id: 'ok', ref: 'A2' })]);
  await h.box.tick();
  assert.equal(h.dead().length, 3);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].ref, 'A2');
  assert.equal(h.errors.filter(l => /DEAD .* malformed queue item/.test(l)).length, 3);
  assert.deepEqual(h.queue(), []);
});

test('a refusal that comes back after the window closed mid-attempt is dead with its own status', async () => {
  const h = harness({ T: T0 + 48 * HOUR - MIN, script: () => { h.T = T0 + 48 * HOUR + MIN; return REFUSED; } });
  h.queueText = JSON.stringify([stored({ attempts: 2, lastStatus: 403 })]);
  await h.box.tick();
  assert.deepEqual(h.queue(), []);
  assert.equal(h.dead()[0].lastStatus, 403);
  assert.equal(h.dead()[0].attempts, 3);
});

// Stage 1 RET (30.09): the four status letters of services/order-letters are queue kinds of their own.
test('letter_* kinds: valid, one item per (kind, ref), a different letter for the same order is a different item, 48 h applies', async () => {
  for (const k of ['letter_paid', 'letter_shipped', 'letter_in_transit', 'letter_delivered']) assert.ok(mo.KINDS.includes(k), k);
  const h = harness({ script: () => REFUSED });
  assert.equal(h.box.enqueue('letter_shipped', 'A1'), true);
  assert.equal(h.box.enqueue('letter_shipped', 'A1'), false, 'the same letter for the same order is queued once');
  assert.equal(h.box.enqueue('letter_in_transit', 'A1'), true);
  assert.equal(h.box.enqueue('letter_delivered', 'A1'), true);
  assert.equal(h.box.enqueue('letter_paid', 'A1'), true);
  assert.deepEqual(h.queue().map(x => x.kind).sort(), ['letter_delivered', 'letter_in_transit', 'letter_paid', 'letter_shipped']);
  assert.equal(h.queue().every(x => x.data === undefined), true, 'no order data on file');
  h.T += 49 * HOUR;
  await h.box.tick();
  assert.deepEqual(h.queue(), [], 'stale letters are buried unsent');
  assert.equal(h.dead().length, 4);
  assert.ok(h.errors.some(e => e.includes('[mail-alert] DEAD letter_shipped A1')), h.errors.join('\n'));
});

// cio-events (30.09): order_delivered is a queue kind of its own, one per order, next to the status event.
test('cio_order_delivered: valid kind, one item per order, independent of the status event', () => {
  assert.ok(mo.KINDS.includes('cio_order_delivered'));
  const h = harness({ script: () => REFUSED });
  assert.equal(h.box.enqueue('cio_order_status', 'A1', { status: 'delivered' }), true);
  assert.equal(h.box.enqueue('cio_order_delivered', 'A1'), true);
  assert.equal(h.box.enqueue('cio_order_delivered', 'A1'), false, 'queued once per order');
});

// tg-alerts (30.09): the Telegram business alerts ride the same queue, one item per alert type and order.
test('tg_order / tg_paid: valid kinds, one item per order each', () => {
  for (const k of ['tg_order', 'tg_paid']) assert.ok(mo.KINDS.includes(k), k);
  const h = harness({ script: () => REFUSED });
  assert.equal(h.box.enqueue('tg_order', 'A1'), true);
  assert.equal(h.box.enqueue('tg_paid', 'A1'), true);
  assert.equal(h.box.enqueue('tg_order', 'A1'), false, 'queued once per order');
});

// restock (30.09): letter_restock has no order: its ref is a subscription id, found by deps.findRecord, handed to send() where an order goes.
test('letter_restock: valid kind, one item per subscription, looked up with findRecord (not orders.json), gone when the record is gone', async () => {
  assert.ok(mo.KINDS.includes('letter_restock'));
  const subs = [{ id: 'rs_1', status: 'pending' }];
  const h = harness({ script: () => REFUSED, orders: [] });
  const seen = [];
  const box = mo.createMailOutbox(Object.assign({}, h.deps, {
    findRecord: (kind, ref) => { seen.push(kind + ' ' + ref); return subs.find(s => s.id === ref) || null; },
    send: (item, rec, cb) => { h.calls.push({ kind: item.kind, ref: item.ref, rec }); cb({ ok: false, status: 503 }); }
  }));
  assert.equal(box.enqueue('letter_restock', 'rs_1'), true);
  assert.equal(box.enqueue('letter_restock', 'rs_1'), false, 'queued once per subscription');
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].rec, subs[0]);
  assert.deepEqual(seen, ['letter_restock rs_1']);
  assert.equal(h.queue().length, 1, 'refused: stays for a retry');
  subs.length = 0;
  h.T += 10 * MIN;
  await box.tick();
  assert.deepEqual(h.queue(), [], 'the subscription is gone: dropped, not buried');
  assert.ok(h.logs.some(l => /dropped letter_restock rs_1/.test(l)), h.logs.join('\n'));
  assert.equal(h.dead().length, 0);
});

test('letter_restock without a findRecord reader is a failed attempt to retry, never "gone"; order kinds are unaffected by findRecord', async () => {
  const h = harness({ script: () => ({ ok: true, status: 200 }) });
  h.box.enqueue('letter_restock', 'rs_1');
  assert.equal(h.queue().length, 1);
  assert.match(h.queue()[0].lastError || '', /record/);
  const box2 = mo.createMailOutbox(Object.assign({}, h.deps, { findRecord: () => { throw new Error('must not be asked'); } }));
  assert.equal(box2.enqueue('mail_manager', 'A1'), true, 'an order kind still reads orders.json');
});
