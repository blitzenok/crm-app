'use strict';
// Contract with the real products-api (this repo's file, or PRODUCTS_API_FILE) runs on a free port in a temp dir with a fake Customer.io and files the test writes. Never touches
// live data. The addresses are the ones the page decides on (checkout-validate.js): same list as checkout-email.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// crm-app layout: this file is products-api/tests/checkout-email/, the module and the other products-api modules are in products-api/.
// products-api.cjs here already carries the checkout e-mail check (the deploy patch is tested in biofirst-hosting).
const S = path.join(__dirname, '..', '..');
const API_FILE = process.env.PRODUCTS_API_FILE || path.join(S, 'products-api.cjs');
const API = '/msolpeptides-api/';
const PUBLIC = { 'x-forwarded-for': '203.0.113.9' };   // what nginx adds to every storefront request
const RAW = [{ id: 1, slug: 'bpc-157', name: 'BPC-157', price: 79, strengths: ['5mg', '10mg'], strength_prices: { '5mg': 49, '10mg': 79 }, is_active: true }];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function rewire(src, dir, port) {
  const swaps = [
    ['const PORT = 4000;', 'const PORT = ' + port + ';'],
    ["const ENV_FILE = '/opt/crm-api/.env';", 'const ENV_FILE = ' + JSON.stringify(path.join(dir, 'test.env')) + ';'],
    ["const CRM_LEADS_FILE = '/opt/crm-api/data/leads.json';", 'const CRM_LEADS_FILE = ' + JSON.stringify(path.join(dir, 'leads.json')) + ';'],
    ["const SESSION_CHECK = { host: '127.0.0.1', port: 3001, path: '/api/session' };", "const SESSION_CHECK = { host: '127.0.0.1', port: 1, path: '/api/session' };"],
    ["const CARD_IMPORT_SOURCE = '/var/lib/crm-umg/store.json';", 'const CARD_IMPORT_SOURCE = ' + JSON.stringify(path.join(dir, 'store.json')) + ';'],
    ["require('/opt/crm-api/leads-store.cjs')", 'require(' + JSON.stringify(path.join(dir, 'no-leads-store.cjs')) + ')'],
    ["require('/opt/shop-content/site-copy-lib.cjs')", 'require(' + JSON.stringify(path.join(dir, 'no-site-copy.cjs')) + ')'],
    // the shared lower-48 rule of the payment module is not on this machine: a stand-in that takes every address
    ["require('/opt/crm-umg/server/lib/ship-region.cjs')", 'require(' + JSON.stringify(path.join(dir, 'ship-region.cjs')) + ')']
  ];
  for (const [from, to] of swaps) {
    // this repo's file has no ship48 rule yet (it is not committed), so its require is absent here and present in the live file
    if (from.includes('ship-region') && !src.includes(from)) continue;
    if (!src.includes(from)) throw new Error('products-api changed: anchor not found: ' + from);
    src = src.split(from).join(to);
  }
  return src;
}
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('timed out');
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));
function createCioStub() {
  const stub = { hits: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
      stub.hits.push({ method: req.method, path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
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
async function boot(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-email-'));
  const port = await freePort();
  const cio = await createCioStub();
  let child = null, out = '';
  const cleanup = () => {
    if (child) { try { child.kill(); } catch (e) { /* gone */ } }
    try { cio.close(); } catch (e) { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  };
  try {
    fs.writeFileSync(path.join(dir, 'products-api.cjs'), rewire(fs.readFileSync(API_FILE, 'utf8'), dir, port));
    for (const [d, f] of [['mail-outbox', 'mail-outbox.cjs'], ['card-import', 'card-import.cjs'], ['order-letters', 'order-letters.cjs'], ['tg-alerts', 'tg-alerts.cjs'], ['restock', 'restock.cjs'], ['reviews', 'reviews.cjs']]) fs.copyFileSync(path.join(S, f), path.join(dir, f));
    if (opts.moduleSource !== undefined) fs.writeFileSync(path.join(dir, 'checkout-email.cjs'), opts.moduleSource);
    else if (!opts.noModule) fs.copyFileSync(path.join(S, 'checkout-email.cjs'), path.join(dir, 'checkout-email.cjs'));
    fs.writeFileSync(path.join(dir, 'ship-region.cjs'), 'module.exports = { checkShipRegion: () => ({ ok: true }) };');
    fs.writeFileSync(path.join(dir, 'products-data.json'), JSON.stringify(RAW));
    fs.writeFileSync(path.join(dir, 'orders.json'), '[]');
    fs.writeFileSync(path.join(dir, 'leads.json'), '[]');
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ orders: [], quotes: [] }));
    const testEnv = {
      CIO_SITE_ID: 'test-site', CIO_TRACKING_API_KEY: 'test-key', CIO_APP_API_KEY: 'test-app-key',
      CIO_ORDER_MANAGER_MSG_ID: '2', CIO_ORDER_CUSTOMER_MSG_ID: '3', ORDER_NOTIFY_TO: 'boss@realmail.net', ADMIN_SECRET: 'test-admin-secret',
      CIO_TRACK_API_BASE: 'http://127.0.0.1:' + cio.port, CIO_API_BASE: 'http://127.0.0.1:' + cio.port
    };
    fs.writeFileSync(path.join(dir, 'test.env'), Object.entries(testEnv).map(([k, v]) => k + '=' + v).join('\n') + '\n');
    child = spawn(process.execPath, [path.join(dir, 'products-api.cjs')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv() });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    await waitFor(() => out.includes('Products API running on port'), 5000);
  } catch (e) { cleanup(); throw e; }
  const file = (n) => path.join(dir, n);
  return { port, cio, output: () => out, stop: cleanup, orders: () => JSON.parse(fs.readFileSync(file('orders.json'), 'utf8')), leads: () => JSON.parse(fs.readFileSync(file('leads.json'), 'utf8')) };
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
const orderBody = (ref, email, over) => ({
  subject: 'New order', body: 'Order ' + ref, paymentMethod: 'crypto',
  orderData: Object.assign({
    ref, paymentMethod: 'crypto',
    customer: { firstName: 'Ann', lastName: 'Lee', email, phone: '' },
    shipping: { address1: '1 Main St', city: 'Los Angeles', state: 'CA', zip: '90001', country: 'US' },
    items: [{ name: 'BPC-157', slug: 'bpc-157', mg: '5mg', qty: 1, price: 49 }], subtotal: '49.00', shippingCost: '18.99', total: '67.99'
  }, over || {})
});
const notify = (s, ref, email, headers, over) => request(s.port, 'POST', API + 'notify-order', orderBody(ref, email, over), headers);
const identify = (s, email) => request(s.port, 'POST', API + 'checkout-identify', { email, firstName: 'Ann', page: 'https://example.test/checkout' });
const MSG = 'Enter a valid email, like you@lab.org.';

test('notify-order, public request: an address the page would refuse gets 400 invalid_email, nothing is stored and nothing leaves', async () => {
  const s = await boot();
  try {
    for (const [i, bad] of ['a@b', 'a@b.c', '', '   ', 'a b@x.com', 'a@x_y.com', 'plain', '.a@x.com'].entries()) {
      const r = await notify(s, 'BF-BAD-' + i, bad, PUBLIC);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.deepEqual(r.body, { ok: false, error: 'invalid_email', field: 'email', charged: false, message: MSG }, JSON.stringify(bad));
    }
    const noCustomer = await request(s.port, 'POST', API + 'notify-order', { subject: 's', body: 'b', orderData: { ref: 'BF-NOCUST', items: [{ name: 'BPC-157', slug: 'bpc-157', mg: '5mg', qty: 1, price: 49 }], shipping: { country: 'US' } } }, PUBLIC);
    assert.equal(noCustomer.status, 400);
    assert.equal(noCustomer.body.error, 'invalid_email');
    const tooLong = await notify(s, 'BF-LONG', 'a'.repeat(64) + '@' + ('x'.repeat(63) + '.').repeat(2) + 'x'.repeat(8) + '.com', PUBLIC);
    assert.equal(tooLong.status, 400, 'longer than the 200 characters an order keeps');
    await pause(300);
    assert.deepEqual(s.orders(), [], 'no order written');
    assert.deepEqual(s.leads(), [], 'no lead written');
    assert.equal(s.cio.hits.length, 0, 'nothing sent to Customer.io: no letter, no profile, no event');
    assert.match(s.output(), /\[checkout-email\] refused notify-order/);
    assert.doesNotMatch(s.output(), /a@b|x_y\.com|a b@/, 'the address is never logged');
  } finally { s.stop(); }
});

test('notify-order, public request: an address the page takes is stored, answered 200 and a resent ref is still a duplicate', async () => {
  const s = await boot();
  try {
    for (const [i, good] of ['you@lab.org', 'first.last+tag@sub.example.co.uk', 'a@münchen.de', ' you@lab.org '].entries()) {
      const r = await notify(s, 'BF-OK-' + i, good, PUBLIC);
      assert.equal(r.status, 200, JSON.stringify(good) + ' ' + r.text);
      assert.equal(r.body.ok, true);
    }
    const again = await notify(s, 'BF-OK-0', 'you@lab.org', PUBLIC);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(s.orders().length, 4);
    assert.equal(s.orders()[3].customer.email, 'you@lab.org');
  } finally { s.stop(); }
});

test('notify-order, store-forward path (no X-Forwarded-For, 127.0.0.1): never refused for its address, as for the other two public checks', async () => {
  const s = await boot();
  try {
    const r = await notify(s, 'BF-FWD-1', 'a@b.c', undefined);
    assert.equal(r.status, 200, r.text);
    assert.equal(s.orders().length, 1, 'an approved card order is always recorded');
    assert.doesNotMatch(s.output(), /\[checkout-email\] refused/);
  } finally { s.stop(); }
});

test('notify-order, insider signup: not an order, not gated here (it never reaches orders.json)', async () => {
  const s = await boot();
  try {
    const r = await request(s.port, 'POST', API + 'notify-order', { subject: 'Insider signup', body: 'Page: /', orderData: { type: 'insider-signup', email: 'you@lab.org', coupon: 'INSIDER25' } }, PUBLIC);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(s.orders(), []);
  } finally { s.stop(); }
});

test('checkout-identify: the page rule on top of the loose one; no profile for an address the page would refuse', async () => {
  const s = await boot();
  try {
    for (const bad of ['a@b.c', 'a@x_y.com', 'a@x..com', '.a@x.com', 'a@x.c0m']) {
      const r = await identify(s, bad);
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error, 'invalid_email', bad);
    }
    const markup = await identify(s, '<b>@x.co');
    assert.equal(markup.status, 400);
    assert.equal(markup.body.error, 'A valid email is required (max 200)', 'the older check still answers first for markup');
    const notString = await request(s.port, 'POST', API + 'checkout-identify', { email: 42 });
    assert.equal(notString.status, 400);
    await pause(300);
    assert.equal(s.cio.hits.length, 0, 'no Customer.io profile for any of them');
    const ok = await identify(s, 'you@lab.org');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.ok, true);
    await waitFor(() => s.cio.hits.some(h => h.method === 'PUT' && /\/customers\//.test(h.path)), 3000);
  } finally { s.stop(); }
});

test('module missing: the routes behave as before (loose checks), the log names the problem once, nothing crashes', async () => {
  const s = await boot({ noModule: true });
  try {
    assert.match(s.output(), /\[checkout-email\] ERROR module not loaded/);
    const r = await notify(s, 'BF-NOMOD-1', 'a@b.c', PUBLIC);
    assert.equal(r.status, 200, 'as before the patch');
    const id = await identify(s, 'a@b.c');
    assert.equal(id.status, 200);
    assert.equal(s.orders().length, 1);
  } finally { s.stop(); }
});

test('module present but empty or broken: both routes behave as before, the log says ERROR, nothing crashes', async () => {
  for (const [name, src, log] of [
    ['empty', 'module.exports = {};', /ERROR module not loaded.*no problem\(\)/],
    ['problem is not a function', 'module.exports = { problem: 42 };', /ERROR module not loaded.*no problem\(\)/],
    ['throws on load', 'throw new Error("broken module");', /ERROR module not loaded.*broken module/]
  ]) {
    const s = await boot({ moduleSource: src });
    try {
      assert.match(s.output(), log, name);
      const r = await notify(s, 'BF-EMPTY-' + name.length, 'a@b.c', PUBLIC);
      assert.equal(r.status, 200, name + ' ' + r.text);
      const id = await identify(s, 'a@b.c');
      assert.equal(id.status, 200, name);
      assert.equal(s.orders().length, 1, name);
    } finally { s.stop(); }
  }
});

test('the check itself throws: the request goes through as before and the log says ERROR', async () => {
  const s = await boot({ moduleSource: 'module.exports = { problem() { throw new Error("boom"); } };' });
  try {
    const r = await notify(s, 'BF-THROW-1', 'a@b.c', PUBLIC);
    assert.equal(r.status, 200, r.text);
    const id = await identify(s, 'a@b.c');
    assert.equal(id.status, 200);
    assert.match(s.output(), /\[checkout-email\] ERROR check failed, request let through: boom/);
  } finally { s.stop(); }
});

test('"public" is our own test: X-Real-IP alone counts, and the patch needs no viaPublicProxy anywhere in the file', async () => {
  const s = await boot();
  try {
    const r = await notify(s, 'BF-REALIP-1', 'a@b', { 'x-real-ip': '203.0.113.9' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_email');
  } finally { s.stop(); }
});
