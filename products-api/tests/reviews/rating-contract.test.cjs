'use strict';
// Contract of the rating letter with the real products-api (this repo's file, or PRODUCTS_API_FILE):
// runs on a free port in a temp dir with a fake Customer.io, the real mail-outbox.cjs / order-letters.cjs / reviews.cjs from this repo and an orders.json the test writes
// (marks of "delivered" some days ago). The hourly pass runs every 300 ms here (REVIEWS_RATING_INTERVAL_MS). Never touches live data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const R = require('../../reviews.cjs');

// crm-app layout: this file is products-api/tests/reviews/; products-api.cjs here already carries the rating letter (the deploy patch is tested in biofirst-hosting).
const S = path.join(__dirname, '..', '..');
const API_FILE = process.env.PRODUCTS_API_FILE || path.join(S, 'products-api.cjs');
const cif = require('../card-import/fixtures.cjs');
const SECRET = 'rating-contract-secret-abcdef0123456789';
const ANN = 'ann.lee@realmail.net', BOB = 'bob.reader@realmail.net';
const DAY = 86400 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const RAW = [{ id: 1, slug: 'bpc-157', name: 'BPC-157', price: 79, strengths: ['5mg'], strength_prices: { '5mg': 49 }, is_active: true }];
// a delivered shop order whose delivered letter went out `daysAgo` days ago
const order = (ref, daysAgo, over) => Object.assign({
  ref, channel: 'shop', status: 'delivered', savedAt: iso(Date.now() - 30 * DAY), paymentMethod: 'crypto-usdt-trc', notes: '',
  customer: { firstName: 'Alex', lastName: 'Kaplan', email: ANN },
  shipping: { address1: '1 Main St', city: 'LA', state: 'CA', zip: '90001', country: 'US', label: 'FedEx Ground' },
  items: [{ name: 'BPC-157', slug: 'bpc-157', mg: '5mg', qty: 1, price: 49 }], trackingNumber: '123456789012', carrier: 'FedEx',
  letters: { delivered: { sentAt: iso(Date.now() - daysAgo * DAY) } }
}, over);
const BASE_ENV = {
  MAIL_OUTBOX_MODE: 'on', MAIL_OUTBOX_INTERVAL_MS: '150', ORDER_LETTERS_MODE: 'on', ORDER_LETTERS_SINCE: '2026-01-01T00:00:00.000Z',
  CIO_LETTER_PAID_MSG_ID: '11', CIO_LETTER_SHIPPED_MSG_ID: '12', CIO_LETTER_IN_TRANSIT_MSG_ID: '13', CIO_LETTER_DELIVERED_MSG_ID: '14', CIO_LETTER_RATING_MSG_ID: '15',
  REVIEWS_MODE: 'on', REVIEWS_SECRET: SECRET, REVIEWS_RATING_SINCE: iso(Date.now() - 10 * DAY), REVIEWS_RATING_INTERVAL_MS: '300'
};
const ADMIN = { 'x-admin-secret': 'test-admin-secret' };
const API = '/msolpeptides-api/';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function rewire(src, dir, port, keepClamp, shortTimeout) {
  const swaps = [
    ['const PORT = 4000;', 'const PORT = ' + port + ';'],
    ["const ENV_FILE = '/opt/crm-api/.env';", 'const ENV_FILE = ' + JSON.stringify(path.join(dir, 'test.env')) + ';'],
    ["const CRM_LEADS_FILE = '/opt/crm-api/data/leads.json';", 'const CRM_LEADS_FILE = ' + JSON.stringify(path.join(dir, 'leads.json')) + ';'],
    ["const SESSION_CHECK = { host: '127.0.0.1', port: 3001, path: '/api/session' };", "const SESSION_CHECK = { host: '127.0.0.1', port: 1, path: '/api/session' };"],
    ["const CARD_IMPORT_SOURCE = '/var/lib/crm-umg/store.json';", 'const CARD_IMPORT_SOURCE = ' + JSON.stringify(path.join(dir, 'store.json')) + ';'],
    ["require('/opt/crm-api/leads-store.cjs')", 'require(' + JSON.stringify(path.join(dir, 'no-leads-store.cjs')) + ')'],
    ["require('/opt/shop-content/site-copy-lib.cjs')", 'require(' + JSON.stringify(path.join(dir, 'no-site-copy.cjs')) + ')']
  ];
  // the pass is never faster than once a minute in the real file; the tests run it every few hundred ms (one test keeps the clamp)
  if (shortTimeout) swaps.push(['const CIO_SEND_TIMEOUT_MS = 5000;', 'const CIO_SEND_TIMEOUT_MS = 400;']);
  if (!keepClamp) swaps.push(['const REVIEWS_RATING_MIN_INTERVAL_MS = 60000;', 'const REVIEWS_RATING_MIN_INTERVAL_MS = 100;']);
  for (const [from, to] of swaps) {
    if (!src.includes(from)) throw new Error('products-api changed: anchor not found: ' + from);
    src = src.split(from).join(to);
  }
  return src;
}
async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('timed out waiting for ' + (what || 'condition'));
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));
// script: what the n-th letter request gets: 'ok' (200), a status number, or 'slow' (200 after 1500 ms). Every request is recorded when it ARRIVES, with what it was answered.
function createCioStub(delayMs, script) {
  const stub = { hits: [] };
  let sends = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
      const plan = req.url === '/v1/send/email' && script ? script[Math.min(sends++, script.length - 1)] : 'ok';
      const code = typeof plan === 'number' ? plan : 200;
      stub.hits.push({ method: req.method, path: req.url, body, code });
      const answer = () => { res.writeHead(code, { 'content-type': 'application/json' }); res.end('{}'); };
      if (plan === 'slow') setTimeout(answer, 1500); else if (delayMs && req.url === '/v1/send/email') setTimeout(answer, delayMs); else answer();   // a slow answer: the file can be changed while the letter is in flight
    });
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { stub.port = srv.address().port; stub.close = () => srv.close(); resolve(stub); });
  });
}
function sanitizedEnv() {
  const out = {};
  for (const k of Object.keys(process.env)) { if (!/^CIO_|^ADMIN_SECRET$|^ORDER_NOTIFY_TO$|^MARKETING_|^ORDER_LETTERS_|^MAIL_OUTBOX_|^RESTOCK_|^TG_STOCK_|^REVIEWS_/.test(k)) out[k] = process.env[k]; }
  return out;
}
async function boot(env, orders, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-'));
  const port = await freePort();
  const cio = await createCioStub(opts.cioDelayMs, opts.cioScript);
  let child = null, out = '';
  const cleanup = () => {
    if (child) { try { child.kill(); } catch (e) { /* gone */ } }
    try { cio.close(); } catch (e) { /* gone */ }
    try { fs.chmodSync(path.join(dir, 'ord'), 0o755); } catch (e) { /* no such dir */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  };
  const start = async () => {
    child = spawn(process.execPath, [path.join(dir, 'products-api.cjs')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv() });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const mark = out.length;
    await waitFor(() => out.indexOf('Products API running on port', mark) >= 0, 6000, 'the server to start');
  };
  try {
    fs.writeFileSync(path.join(dir, 'products-api.cjs'), rewire(fs.readFileSync(API_FILE, 'utf8'), dir, port, opts.keepClamp, opts.shortTimeout));
    for (const [d, f] of [['mail-outbox', 'mail-outbox.cjs'], ['card-import', 'card-import.cjs'], ['order-letters', 'order-letters.cjs'], ['tg-alerts', 'tg-alerts.cjs'], ['restock', 'restock.cjs']]) fs.copyFileSync(path.join(S, f), path.join(dir, f));
    if (opts.fastRetry) {   // the queue's retries after 0.3 s, 0.6 s, ... instead of 1, 5, 15 ... minutes
      const mo = fs.readFileSync(path.join(dir, 'mail-outbox.cjs'), 'utf8'), from = 'const RETRY_MIN = [1, 5, 15, 60, 180, 360];';
      assert.ok(mo.includes(from));
      fs.writeFileSync(path.join(dir, 'mail-outbox.cjs'), mo.split(from).join('const RETRY_MIN = [0.005, 0.01, 0.01];'));
    }
    fs.copyFileSync(path.join(S, 'reviews.cjs'), path.join(dir, 'reviews.cjs'));
    fs.writeFileSync(path.join(dir, 'products-data.json'), JSON.stringify(RAW));
    if (opts.ordersInSubdir) {   // orders.json is a link to a file in a directory the test can lock: writing orders fails, the mail queue (in dir) keeps working
      fs.mkdirSync(path.join(dir, 'ord'));
      fs.writeFileSync(path.join(dir, 'ord', 'orders.json'), JSON.stringify(orders));
      fs.symlinkSync(path.join(dir, 'ord', 'orders.json'), path.join(dir, 'orders.json'));
    } else fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(orders));
    fs.writeFileSync(path.join(dir, 'leads.json'), '[]');
    fs.writeFileSync(path.join(dir, 'store.json'), cif.storeText([], []));
    if (opts.queue) fs.writeFileSync(path.join(dir, 'mail-outbox.json'), JSON.stringify(opts.queue.map((q, n) => ({ id: 'q' + n, kind: q.kind, ref: q.ref, createdAt: iso(Date.now()), attempts: 0, nextAt: iso(Date.now()), lastStatus: null, lastError: null }))), { mode: 0o600 });
    if (opts.ratings) fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ ratings: opts.ratings, reviews: [] }), { mode: 0o600 });
    const testEnv = Object.assign({}, {
      CIO_SITE_ID: 'test-site', CIO_TRACKING_API_KEY: 'test-key', CIO_APP_API_KEY: 'test-app-key',
      CIO_ORDER_MANAGER_MSG_ID: '2', CIO_ORDER_CUSTOMER_MSG_ID: '3', ORDER_NOTIFY_TO: 'boss@realmail.net', ADMIN_SECRET: 'test-admin-secret',
      CIO_TRACK_API_BASE: 'http://127.0.0.1:' + cio.port, CIO_API_BASE: 'http://127.0.0.1:' + cio.port
    }, env);
    fs.writeFileSync(path.join(dir, 'test.env'), Object.entries(testEnv).map(([k, v]) => k + '=' + v).join('\n') + '\n');
    if (opts.ordersLocked) fs.chmodSync(path.join(dir, 'ord'), 0o555);
    await start();
  } catch (e) { cleanup(); throw e; }
  const file = (n) => path.join(dir, n);
  const readJson = (n) => (fs.existsSync(file(n)) ? JSON.parse(fs.readFileSync(file(n), 'utf8')) : null);
  return {
    port, dir, cio, output: () => out, stop: cleanup, file,
    lockOrders: () => fs.chmodSync(path.join(dir, 'ord'), 0o555), unlockOrders: () => fs.chmodSync(path.join(dir, 'ord'), 0o755),
    orders: () => readJson('orders.json'), ratings: () => readJson('reviews.json'), queue: () => readJson('mail-outbox.json'),
    orderOf: (ref) => readJson('orders.json').find(o => o.ref === ref),
    restart: async () => { child.kill(); await pause(250); await start(); },
    ratingSends: () => cio.hits.filter(h => h.path === '/v1/send/email' && h.body && h.body.transactional_message_id === '15'),
    ratingAccepted: () => cio.hits.filter(h => h.path === '/v1/send/email' && h.body && h.body.transactional_message_id === '15' && h.code === 200),
    dead: () => readJson('mail-outbox-dead.json'),
    allSends: () => cio.hits.filter(h => h.path === '/v1/send/email')
  };
}
function request(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => { let json = null; try { json = s ? JSON.parse(s) : null; } catch (e) { /* not json */ } resolve({ status: res.statusCode, text: s, body: json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const adminGet = (s) => request(s.port, 'GET', API + 'reviews-admin', undefined, ADMIN);
const patchOrder = (s, ref, body) => request(s.port, 'PATCH', API + 'orders/' + encodeURIComponent(ref), body, ADMIN);
const rateIt = (s, ref, email, r) => request(s.port, 'POST', API + 'review/rating', { o: ref, t: R.tokenFor(SECRET, ref, email), r });
const ratedRow = (ref) => ({ id: 'rt_' + ref.replace(/[^0-9a-z]/gi, '').toLowerCase().slice(0, 14), ref, email: ANN, rating: 5, comment: '', flags: [], createdAt: iso(Date.now() - 6 * DAY), updatedAt: iso(Date.now() - 6 * DAY) });

test('on: one letter per due order and nothing for the rest, with the link in the data, a mark on the order, no second letter on later passes or after a restart, and no address in the log', async (t) => {
  const orders = [
    order('BLR-A', 4),                                                    // due
    order('BLR-B', 2),                                                    // delivered 2 days ago: not yet
    order('BLR-C', 4),                                                    // already rated: marked, no letter
    order('BLR-D', 12),                                                   // delivered before REVIEWS_RATING_SINCE
    order('BLR-E', 4, { letters: undefined }),                            // no delivered mark: no moment of delivery
    order('BLR-F', 4, { status: 'cancelled' }),                           // cancelled after delivery
    order('BLR-G', 4, { customer: { firstName: 'No', lastName: 'Mail' } }),   // no address
    order('BF-QA-H', 4, { test: true }),                                  // a sandbox order
    order('BLR-I', 4, { status: 'shipped' }),                             // not delivered
    order('MS-J', 4, { channel: undefined })                              // a wholesale order typed in the CRM
  ];
  const s = await boot(BASE_ENV, orders, { ratings: [ratedRow('BLR-C')] });
  t.after(() => s.stop());
  assert.match(s.output(), /\[rating\] on, 3 days after delivery, since /);
  await waitFor(() => s.ratingSends().length === 1, 8000, 'the letter');
  await waitFor(() => s.orderOf('BLR-A').letters.rating && s.orderOf('BLR-A').letters.rating.sentAt, 3000, 'the mark');
  const sent = s.ratingSends()[0].body;
  assert.equal(sent.to, ANN);
  assert.deepEqual(Object.keys(sent.message_data).sort(), ['first_name', 'ref', 'review_url']);
  assert.equal(sent.message_data.ref, 'BLR-A');
  assert.equal(sent.message_data.first_name, 'Alex');
  assert.equal(sent.message_data.review_url, R.reviewUrl(SECRET, 'BLR-A', ANN));
  assert.match(sent.message_data.review_url, /^https:\/\/biolabsresearch\.co\/review#o=BLR-A&t=/);
  await waitFor(() => s.orderOf('BLR-C').letters.rating, 3000, 'the rated mark');
  assert.equal(s.orderOf('BLR-C').letters.rating.skipped, 'rated');
  assert.equal(s.orderOf('BLR-C').letters.rating.sentAt, undefined);
  // several more passes and a restart: still one letter, and the other orders carry no mark
  await pause(1300);
  await s.restart();
  await pause(1300);
  assert.equal(s.ratingSends().length, 1, 'one letter per order, also across passes and a restart');
  for (const ref of ['BLR-B', 'BLR-D', 'BLR-E', 'BLR-F', 'BLR-G', 'BF-QA-H', 'BLR-I', 'MS-J']) assert.equal(s.orderOf(ref).letters && s.orderOf(ref).letters.rating, undefined, ref);
  assert.equal(s.orderOf('BLR-A').letters.delivered.sentAt, orders[0].letters.delivered.sentAt, 'the delivered mark is untouched');
  const log = s.output();
  assert.match(log, /\[rating\] queued BLR-A/);
  assert.match(log, /\[rating\] skip BLR-C: rated \(marked on the order\)/);
  assert.match(log, /\[rating\] pass: 8 delivered, 1 queued, 1 rated before the letter, too_early 1, before_since 1, no_delivery_moment 1, no_email 1, test_order 1, letter_not_shop 1\n/, log);
  assert.equal(log.includes(ANN), false, 'no address in the log');
  assert.equal(/\[rating\] ERROR/.test(log), false, log);
});

test('the delivered letter no longer carries review_url, and the rating letter follows it by the delay: delivered (marked) -> the pass -> the rating letter, end to end', async (t) => {
  const orders = [order('BLR-3005', 0, { status: 'shipped', letters: undefined })];
  const s = await boot(Object.assign({}, BASE_ENV, { REVIEWS_RATING_DELAY_DAYS: '0', REVIEWS_RATING_SINCE: iso(Date.now() - DAY) }), orders);
  t.after(() => s.stop());
  assert.match(s.output(), /\[rating\] on, 0 days after delivery/);
  await pause(800);
  assert.equal(s.ratingSends().length, 0, 'a shipped order gets nothing');
  assert.equal((await patchOrder(s, 'BLR-3005', { status: 'delivered' })).status, 200);
  await waitFor(() => s.allSends().some(h => h.body.transactional_message_id === '14'), 6000, 'the delivered letter');
  const delivered = s.allSends().find(h => h.body.transactional_message_id === '14').body;
  assert.equal('review_url' in delivered.message_data, false, 'no link in the delivered letter, with REVIEWS_MODE on');
  assert.deepEqual(Object.keys(delivered.message_data).sort(), ['carrier', 'first_name', 'paid_via', 'payment_state', 'ref', 'shipping_address', 'shipping_method', 'status', 'total_due_server', 'totals_available', 'tracking_number', 'tracking_url']);
  await waitFor(() => s.ratingSends().length === 1, 8000, 'the rating letter after the delivered one');
  assert.ok(s.orderOf('BLR-3005').letters.delivered.sentAt, 'the delivered letter marked the moment');
  assert.equal(s.ratingSends()[0].body.message_data.ref, 'BLR-3005');
  await pause(900);
  assert.equal(s.ratingSends().length, 1);
});

test('the cap of one pass: 25 due orders, 20 queued by the first pass, the rest by the next; all 25 get exactly one letter', async (t) => {
  const orders = []; for (let i = 1; i <= 25; i++) orders.push(order('BLR-' + String(i).padStart(3, '0'), 4));
  const s = await boot(Object.assign({}, BASE_ENV, { REVIEWS_RATING_INTERVAL_MS: '700' }), orders);
  t.after(() => s.stop());
  await waitFor(() => /\[rating\] pass: 25 delivered, 20 queued, over_cap 5/.test(s.output()), 6000, 'the first pass');
  await waitFor(() => s.ratingSends().length === 25, 12000, 'all letters');
  assert.match(s.output(), /\[rating\] pass: 25 delivered, 5 queued/, 'the second pass queued the other five');
  assert.equal(new Set(s.ratingSends().map(h => h.body.message_data.ref)).size, 25);
  await pause(1600);
  assert.equal(s.ratingSends().length, 25);
});

test('test mode: only the listed address gets the letter; another buyer\'s due order is neither sent nor marked, even when it has a rating', async (t) => {
  const orders = [order('BLR-ANN', 4), order('BLR-BOB', 4, { customer: { firstName: 'Bob', lastName: 'R', email: BOB } }), order('BLR-BOB2', 4, { customer: { firstName: 'Bob', lastName: 'R', email: BOB } })];
  const s = await boot(Object.assign({}, BASE_ENV, { REVIEWS_MODE: 'test', ORDER_LETTERS_TEST_TO: ANN }), orders, { ratings: [ratedRow('BLR-BOB2')] });
  t.after(() => s.stop());
  await waitFor(() => s.ratingSends().length === 1, 8000, 'the letter');
  await waitFor(() => /\[rating\] pass: 3 delivered, 1 queued, not_test_recipient 2/.test(s.output()), 4000, 'the pass line');
  assert.equal(s.ratingSends()[0].body.to, ANN);
  await pause(800);
  assert.equal(s.ratingSends().length, 1);
  assert.equal(s.orderOf('BLR-BOB').letters.rating, undefined);
  assert.equal(s.orderOf('BLR-BOB2').letters.rating, undefined, 'nothing is written on a real buyer\'s order in test mode');
  assert.match(s.output(), /\[rating\] test, 3 days after delivery/);
});

test('off: with REVIEWS_MODE not set the pass is idle: no letter, no mark, the log says off', async (t) => {
  const env = Object.assign({}, BASE_ENV); delete env.REVIEWS_MODE;
  const s = await boot(env, [order('BLR-A', 4)]);
  t.after(() => s.stop());
  await pause(1500);
  assert.match(s.output(), /\[rating\] off/);
  assert.equal(s.ratingSends().length, 0);
  assert.equal(s.orderOf('BLR-A').letters.rating, undefined);
  assert.equal(/\[rating\] (pass|queued)/.test(s.output()), false);
});

test('settings: no REVIEWS_RATING_SINCE or a bad delay switches only the rating letter off (an ERROR line), no template number waits with one line, nothing is sent', async (t) => {
  const noSince = Object.assign({}, BASE_ENV); delete noSince.REVIEWS_RATING_SINCE;
  const a = await boot(noSince, [order('BLR-A', 4)]);
  t.after(() => a.stop());
  await pause(1200);
  assert.match(a.output(), /\[rating\] ERROR REVIEWS_RATING_SINCE missing or not a date, the rating letter is off/);
  assert.match(a.output(), /\[rating\] off/);
  assert.equal(a.ratingSends().length, 0);
  assert.match(a.output(), /\[reviews\] on/, 'reviews themselves stay on');
  const badDelay = await boot(Object.assign({}, BASE_ENV, { REVIEWS_RATING_DELAY_DAYS: 'three' }), [order('BLR-A', 4)]);
  t.after(() => badDelay.stop());
  await pause(1000);
  assert.match(badDelay.output(), /\[rating\] ERROR REVIEWS_RATING_DELAY_DAYS is not a number/);
  assert.equal(badDelay.ratingSends().length, 0);
  const noId = Object.assign({}, BASE_ENV); delete noId.CIO_LETTER_RATING_MSG_ID;
  const b = await boot(noId, [order('BLR-A', 4)]);
  t.after(() => b.stop());
  await pause(2000);
  assert.match(b.output(), /\[rating\] ERROR no template id \(CIO_LETTER_RATING_MSG_ID\), the rating letter waits/);
  assert.equal((b.output().match(/\[rating\] pass skipped: no template id/g) || []).length, 1, 'said once, not at every pass');
  assert.equal(b.allSends().length, 0);
  assert.equal(b.orderOf('BLR-A').letters.rating, undefined);
  const noOutbox = Object.assign({}, BASE_ENV, { MAIL_OUTBOX_MODE: 'off' });
  const c = await boot(noOutbox, [order('BLR-A', 4)]);
  t.after(() => c.stop());
  await pause(1200);
  assert.equal(c.ratingSends().length, 0);
  assert.equal(c.orderOf('BLR-A').letters.rating, undefined);
});

test('a pass that fails (orders.json unreadable) says so and the server keeps answering; when the file is back the next pass sends', async (t) => {
  const s = await boot(Object.assign({}, BASE_ENV, { REVIEWS_RATING_INTERVAL_MS: '400' }), [order('BLR-A', 4)]);
  t.after(() => s.stop());
  await waitFor(() => s.ratingSends().length === 1, 8000, 'the first letter');
  const good = fs.readFileSync(s.file('orders.json'), 'utf8');
  fs.writeFileSync(s.file('orders.json'), '{ not json');
  await waitFor(() => /\[rating\] ERROR pass failed/.test(s.output()), 4000, 'the error line');
  const pub = await request(s.port, 'GET', API + 'reviews?slug=bpc-157');
  assert.equal(pub.status, 200, 'the server is alive');
  fs.writeFileSync(s.file('orders.json'), JSON.stringify([JSON.parse(good)[0], order('BLR-NEW', 5)]));
  await waitFor(() => s.ratingSends().length === 2, 8000, 'the letter after the file came back');
  assert.equal(s.ratingSends().length, 2);
});

test('the report counts the letters: sent, answered, the share, rated before the letter; the rating that comes after the letter is "answered"', async (t) => {
  const orders = [order('BLR-A', 4), order('BLR-K', 4), order('BLR-C', 4)];
  const s = await boot(BASE_ENV, orders, { ratings: [ratedRow('BLR-C')] });
  t.after(() => s.stop());
  await waitFor(() => s.ratingSends().length === 2, 8000, 'two letters');
  await waitFor(() => s.orderOf('BLR-C').letters && s.orderOf('BLR-C').letters.rating && s.orderOf('BLR-A').letters.rating && s.orderOf('BLR-K').letters.rating && s.orderOf('BLR-A').letters.rating.sentAt && s.orderOf('BLR-K').letters.rating.sentAt, 4000, 'the marks');
  let a = await adminGet(s);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.ratingLetters, { sent: 2, answered: 0, rate: 0, skippedRated: 1 });
  assert.equal((await rateIt(s, 'BLR-A', ANN, 4)).status, 200);
  a = await adminGet(s);
  assert.deepEqual(a.body.ratingLetters, { sent: 2, answered: 1, rate: 50, skippedRated: 1 });
  assert.equal(a.body.stats.count, 2, 'the ratings report itself still counts every rating');
});

test('the gate at the moment of sending: an item already in the queue for an order that has a rating meanwhile sends nothing, and is not marked sent', async (t) => {
  // enqueue() tries to send at once, so the gap between the pass and the sender is too short to hit from outside: the queue file is written before the start instead (the pass is an hour away)
  const orders = [order('BLR-A', 4), order('BLR-B', 4)];
  const s = await boot(Object.assign({}, BASE_ENV, { REVIEWS_RATING_INTERVAL_MS: '3600000' }), orders, {
    ratings: [ratedRow('BLR-A')],
    queue: [{ kind: 'letter_rating', ref: 'BLR-A' }, { kind: 'letter_rating', ref: 'BLR-B' }]
  });
  t.after(() => s.stop());
  await waitFor(() => s.ratingSends().length === 1, 6000, 'the letter that is still due');
  await waitFor(() => /\[rating\] skip BLR-A: rated/.test(s.output()), 3000, 'the gate');
  await pause(500);
  assert.equal(s.ratingSends().length, 1);
  assert.equal(s.ratingSends()[0].body.message_data.ref, 'BLR-B', 'only the order without a rating got the letter');
  assert.equal((s.orderOf('BLR-A').letters.rating || {}).sentAt, undefined, 'not marked sent');
  assert.ok(s.orderOf('BLR-B').letters.rating.sentAt);
  assert.deepEqual(s.queue(), [], 'both items are done: one sent, one skipped (no retry of a refusal)');
});

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;   // a directory lock does not stop root: those tests are skipped there

test('at most once: the letter is accepted but its sentAt cannot be written (orders.json locked while Customer.io answers): the passes that follow never send a second one, also after a restart', { skip: asRoot }, async (t) => {
  const s = await boot(BASE_ENV, [order('BLR-A', 4)], { ordersInSubdir: true, cioDelayMs: 1500 });
  t.after(() => s.stop());
  await waitFor(() => /\[rating\] queued BLR-A/.test(s.output()), 6000, 'the item in the queue');
  assert.ok(s.orderOf('BLR-A').letters.rating.queuedAt, 'queuedAt was saved before the queue was asked');
  s.lockOrders();                                          // the letter is on its way: from here the file cannot be written
  await waitFor(() => s.ratingSends().length === 1, 6000, 'the letter');
  await waitFor(() => /\[mail-alert\] LETTER NOT RECORDED rating BLR-A/.test(s.output()), 6000, 'the failed mark');
  await pause(1500);                                       // several passes
  assert.equal(s.ratingSends().length, 1, 'no second letter');
  const rec = s.orderOf('BLR-A').letters.rating;
  assert.ok(rec.queuedAt && rec.sentAt === undefined, 'queuedAt only: the file could not take the sentAt');
  assert.match(s.output(), /\[rating\] pass: 1 delivered, 0 queued, already_queued 1/);
  s.unlockOrders();
  await s.restart();
  await pause(1500);
  assert.equal(s.ratingSends().length, 1, 'nor after a restart and a writable file again');
});

test('at most once: when queuedAt cannot be written nothing is queued (an error line, no letter); when the file is writable again the next pass sends', { skip: asRoot }, async (t) => {
  const s = await boot(BASE_ENV, [order('BLR-A', 4)], { ordersInSubdir: true, ordersLocked: true });
  t.after(() => s.stop());
  await waitFor(() => /\[rating\] ERROR queue marks not written, nothing queued/.test(s.output()), 6000, 'the error');
  await pause(800);
  assert.equal(s.ratingSends().length, 0);
  assert.equal(/\[rating\] queued BLR-A/.test(s.output()), false);
  assert.equal((s.queue() || []).length, 0, 'the mail queue got nothing');
  assert.equal(s.orderOf('BLR-A').letters.rating, undefined);
  s.unlockOrders();
  await waitFor(() => s.ratingSends().length === 1, 6000, 'the letter once the file is writable');
});

test('at most once: a crash between the queuedAt and the queue leaves a mark and no letter; the pass says so once per process and never queues it again, also after a restart', async (t) => {
  const o = order('BLR-A', 4);
  o.letters.rating = { queuedAt: iso(Date.now() - 3 * 3600 * 1000) };
  const s = await boot(BASE_ENV, [o, order('BLR-B', 4)]);
  t.after(() => s.stop());
  await waitFor(() => s.ratingSends().length === 1, 6000, 'the letter of the other order');
  assert.equal(s.ratingSends()[0].body.message_data.ref, 'BLR-B');
  await pause(900);
  assert.equal((s.output().match(/\[rating\] queued, never sent BLR-A/g) || []).length, 1, 'said once');
  assert.equal(/\[rating\] queued BLR-A/.test(s.output()), false);
  await s.restart();
  await pause(900);
  assert.equal(s.ratingSends().length, 1, 'no letter for BLR-A after the restart either');
  assert.equal((s.output().match(/\[rating\] queued, never sent BLR-A/g) || []).length, 2, 'once more in the new process');
  assert.equal(s.output().includes(ANN), false);
});

test('the pass is never faster than once a minute: a shorter REVIEWS_RATING_INTERVAL_MS is raised, and said so', async (t) => {
  const s = await boot(Object.assign({}, BASE_ENV, { REVIEWS_RATING_INTERVAL_MS: '5' }), [order('BLR-A', 4)], { keepClamp: true });
  t.after(() => s.stop());
  assert.match(s.output(), /\[rating\] interval raised to 60000 ms/);
  await pause(1200);
  assert.equal(s.ratingSends().length, 0, 'the first pass comes after 45 s, not after 5 ms');
  assert.equal(/\[rating\] pass:/.test(s.output()), false);
});

test('at most once, the unconfirmed attempt: Customer.io takes the letter but answers too late (timeout), then the queue ticks for seconds: exactly one letter, one alert line, the item is done (skipped, not dead), the attempt mark stays', async (t) => {
  const s = await boot(BASE_ENV, [order('BLR-A', 4)], { cioScript: ['slow', 'ok', 'ok'], shortTimeout: true, fastRetry: true });
  t.after(() => s.stop());
  await waitFor(() => /\[mail-alert\] RATING UNCONFIRMED BLR-A/.test(s.output()), 6000, 'the timeout');
  await pause(2500);                                      // the late 200, many queue ticks and passes
  assert.equal(s.ratingSends().length, 1, 'one request at Customer.io, ever');
  assert.equal(s.ratingAccepted().length, 1);
  const rec = s.orderOf('BLR-A').letters.rating;
  assert.ok(rec.queuedAt && rec.tryAt && rec.sentAt === undefined, 'queuedAt and tryAt, no sentAt');
  assert.deepEqual(s.queue(), [], 'the item is gone (skipped), not waiting for a retry');
  assert.equal(/\[mail-alert\] DEAD/.test(s.output()), false, 'no dead-list alert');
  assert.match(s.output(), /HTTP|no answer/);
  await s.restart();
  await pause(1500);
  assert.equal(s.ratingSends().length, 1, 'nor after a restart');
});

test('at most once, an item that finds an attempt mark (a crash between the 2xx and the removal from the queue): no letter, a line, the item removed as skipped, also for the retries of a queue that outlived a restart', async (t) => {
  const o = order('BLR-A', 4);
  o.letters.rating = { queuedAt: iso(Date.now() - 60000), tryAt: iso(Date.now() - 50000) };
  const s = await boot(BASE_ENV, [o, order('BLR-B', 4)], { queue: [{ kind: 'letter_rating', ref: 'BLR-A' }], fastRetry: true, cioScript: ['ok'] });
  t.after(() => s.stop());
  await waitFor(() => /\[rating\] skip BLR-A: unconfirmed attempt, not retried/.test(s.output()), 6000, 'the refusal');
  await waitFor(() => s.ratingSends().some(h => h.body.message_data.ref === 'BLR-B'), 6000, 'the other order still gets its letter');
  await pause(800);
  assert.equal(s.ratingSends().filter(h => h.body.message_data.ref === 'BLR-A').length, 0, 'nothing for the order with the mark');
  assert.equal((s.queue() || []).length, 0);
  assert.equal(/\[mail-alert\] DEAD/.test(s.output()), false);
});

test('at most once, killed while the letter is in flight (accepted by Customer.io, the process dies before the answer): after the restart the queue item is still there and sends nothing', async (t) => {
  const s = await boot(BASE_ENV, [order('BLR-A', 4)], { cioScript: ['slow', 'ok', 'ok'], fastRetry: true });
  t.after(() => s.stop());
  await waitFor(() => s.ratingSends().length === 1, 6000, 'the request at Customer.io');
  await s.restart();                                      // the process is killed 250 ms later, before the answer of the slow letter came
  await pause(2500);
  assert.equal(s.ratingSends().length, 1, 'no second request after the restart');
  const rec = s.orderOf('BLR-A').letters.rating;
  assert.ok(rec.tryAt && rec.sentAt === undefined);
  assert.match(s.output(), /\[rating\] skip BLR-A: unconfirmed attempt, not retried/);
  assert.deepEqual(s.queue() || [], []);
});

test('an explicit HTTP refusal is repeated: 503 then 200 gives one letter in the end (two requests, one accepted, the attempt mark is taken off after the 503); 429 and 401 are repeated too', async (t) => {
  for (const code of [503, 429, 401]) {
    const s = await boot(BASE_ENV, [order('BLR-A', 4)], { cioScript: [code, 'ok'], fastRetry: true });
    try {
      await waitFor(() => s.ratingAccepted().length === 1, 8000, 'the letter after the ' + code);
      await pause(1500);
      assert.equal(s.ratingSends().length, 2, code + ': a refusal and the repeat');
      assert.equal(s.ratingAccepted().length, 1, code + ': one letter');
      const rec = s.orderOf('BLR-A').letters.rating;
      assert.ok(rec.sentAt && rec.tryAt === undefined, code + ': sentAt, and no attempt mark left');
      assert.equal(/unconfirmed attempt/.test(s.output()), false);
      assert.deepEqual(s.queue(), []);
    } finally { s.stop(); }
  }
});

test('another 4xx (400) is a refusal the queue gives up on: the mark is taken off, nothing repeated, the dead list and the alert say so; a mark that cannot be written means nothing is sent and the queue tries again', { skip: asRoot }, async (t) => {
  const s = await boot(BASE_ENV, [order('BLR-A', 4)], { cioScript: [400, 'ok'], fastRetry: true });
  t.after(() => s.stop());
  await waitFor(() => /\[mail-alert\] DEAD letter_rating BLR-A/.test(s.output()), 6000, 'the dead alert');
  await pause(800);
  assert.equal(s.ratingSends().length, 1);
  assert.equal(s.orderOf('BLR-A').letters.rating.tryAt, undefined, 'a certain refusal: the mark is off');
  assert.equal((s.dead() || []).length, 1);
  // the attempt mark cannot be written (orders.json locked, an item waiting in the queue whose order already has its queuedAt): no request, a line, the item stays and sends when the file is writable again
  const o = order('BLR-C', 4); o.letters.rating = { queuedAt: iso(Date.now() - 1000) };
  const l = await boot(BASE_ENV, [o], { ordersInSubdir: true, ordersLocked: true, queue: [{ kind: 'letter_rating', ref: 'BLR-C' }], cioScript: ['ok'], fastRetry: true });
  t.after(() => l.stop());
  await waitFor(() => /\[rating\] ERROR BLR-C: the attempt mark could not be written, nothing sent/.test(l.output()), 6000, 'the refusal to send');
  assert.equal(l.ratingSends().length, 0, 'nothing sent without the mark');
  l.unlockOrders();
  await waitFor(() => l.ratingAccepted().length === 1, 8000, 'the letter once the mark can be written');
  await pause(800);
  assert.equal(l.ratingSends().length, 1);
});
