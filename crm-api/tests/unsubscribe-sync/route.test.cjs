'use strict';
// The blitz-api route POST /api/internal/account-unsubscribe (crm/account-unsubscribe.cjs): its three gates, the strict read, the lock,
// what changes in a lead and what does not, idempotence. The handler is called with plain request objects; test/express.test.cjs
// mounts the same module in a real Express app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mount = require('../../account-unsubscribe.cjs');

const SECRET = 's'.repeat(40);
const ROUTE = mount.ROUTE;
const FIXED = new Date('2026-10-02T01:02:03.000Z');

function lead(over) {
  return Object.assign({
    id: 'lead_aaaaaaaaaaaa', status: 'Not Contacted', priority: 'High', company: 'Sam Rowe', country: 'US', city: 'Austin',
    email: 'sam@example.com', phone: '', notes: 'Source: Checkout inquiry.', coupon: '', last_email_sent_at: null, last_open_at: null,
    last_click_at: null, unsubscribed: false, cio_person_id: null, status_manual_override: false,
    created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z'
  }, over);
}

function setup({ leads, env = { ACCOUNT_CRM_SYNC_SECRET: SECRET }, raw } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsub-route-'));
  const file = path.join(dir, 'leads.json');
  if (raw !== undefined) fs.writeFileSync(file, raw, { mode: 0o640 });
  else if (leads !== undefined) fs.writeFileSync(file, JSON.stringify(leads, null, 2), { mode: 0o640 });
  const routes = {};
  const app = { post: (p, h) => { routes[p] = h; } };
  const audit = [];
  const api = mount({ app, DATA_DIR: dir, env, writeAuditLog: (...a) => audit.push(a), now: () => FIXED });
  const handler = routes[ROUTE];
  const call = ({ body, headers = { 'x-account-sync-secret': SECRET }, peer = '127.0.0.1' } = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    handler({ headers, body, socket: { remoteAddress: peer } }, res);
    return res;
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { dir, file, call, read, audit, api, routes };
}

// console.error / console.warn lines of one block of code
function captured(fn) {
  const lines = [];
  const e = console.error, w = console.warn;
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try { return { value: fn(), lines }; } finally { console.error = e; console.warn = w; }
}

test('the route is registered once, on the internal path, which is not an /admin or /backup path', () => {
  const s = setup({ leads: [] });
  assert.deepEqual(Object.keys(s.routes), [ROUTE]);
  assert.equal(ROUTE, '/api/internal/account-unsubscribe');
  assert.ok(!/\/(admin|backup)/i.test(ROUTE));
});

// ---- gates ----

test('no secret configured (or a short one): 503 for everybody, the file is not touched', () => {
  for (const env of [{}, { ACCOUNT_CRM_SYNC_SECRET: 'short' }, { ACCOUNT_CRM_SYNC_SECRET: '   ' }]) {
    const { value: s } = captured(() => setup({ leads: [lead()], env }));
    const before = fs.readFileSync(s.file, 'utf8');
    const r = s.call({ body: { email: 'sam@example.com' } });
    assert.equal(r.code, 503);
    assert.equal(r.body.error, 'not_configured');
    assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  }
});

test('no secret configured: a proxied request or a foreign peer still gets 403 (nothing about the configuration leaks to the internet), only the local caller hears 503', () => {
  for (const env of [{}, { ACCOUNT_CRM_SYNC_SECRET: 'short' }]) {
    const { value: s } = captured(() => setup({ leads: [lead()], env }));
    for (const headers of [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-real-ip': '203.0.113.9', 'x-account-sync-secret': SECRET }]) {
      const r = s.call({ body: { email: 'sam@example.com' }, headers });
      assert.equal(r.code, 403);
      assert.deepEqual(r.body, { ok: false, error: 'forbidden' });
    }
    const foreign = s.call({ body: { email: 'sam@example.com' }, peer: '10.0.0.5' });
    assert.equal(foreign.code, 403);
    assert.equal(s.call({ body: { email: 'sam@example.com' } }).code, 503);
  }
});

test('a missing, wrong or near-miss secret: 403, and nothing is written', () => {
  const s = setup({ leads: [lead()] });
  const before = fs.readFileSync(s.file, 'utf8');
  for (const headers of [{}, { 'x-account-sync-secret': '' }, { 'x-account-sync-secret': 'x'.repeat(40) }, { 'x-account-sync-secret': SECRET + ' ' }, { 'x-account-sync-secret': SECRET.slice(1) }, { authorization: 'Bearer ' + SECRET }]) {
    const r = s.call({ body: { email: 'sam@example.com' }, headers });
    assert.equal(r.code, 403);
    assert.deepEqual(r.body, { ok: false, error: 'forbidden' });
  }
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
});

test('a peer that is not loopback is refused even with the right secret', () => {
  const s = setup({ leads: [lead()] });
  for (const peer of ['10.0.0.5', '134.199.235.122', '::ffff:10.0.0.5', '', null]) {
    assert.equal(s.call({ body: { email: 'sam@example.com' }, peer }).code, 403, String(peer));
  }
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(s.call({ body: { email: 'sam@example.com' }, peer }).code, 200, peer);
});

test('a request that came through nginx (any proxy header) is refused even from 127.0.0.1 with the right secret', () => {
  const s = setup({ leads: [lead()] });
  const before = fs.readFileSync(s.file, 'utf8');
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto']) {
    const r = s.call({ body: { email: 'sam@example.com' }, headers: { 'x-account-sync-secret': SECRET, [h]: '203.0.113.9' } });
    assert.equal(r.code, 403, h);
  }
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
});

test('bad input: 400 for an address that is not one, for a non-object body and for an unknown source', () => {
  const s = setup({ leads: [lead()] });
  for (const body of [undefined, null, 'sam@example.com', [], {}, { email: '' }, { email: 5 }, { email: 'not-an-email' }, { email: 'a b@example.com' }, { email: '<x>@example.com' }, { email: 'x'.repeat(300) + '@example.com' }]) {
    const r = s.call({ body });
    assert.equal(r.code, 400, JSON.stringify(body));
    assert.equal(r.body.error, 'invalid_email');
  }
  for (const source of ['admin', 5, null, '']) assert.equal(s.call({ body: { email: 'sam@example.com', source } }).body.error, 'invalid_source');
  assert.equal(s.read()[0].unsubscribed, false);
});

// ---- what it does ----

test('marks the lead: unsubscribed true, when and where from, updated_at; every other field and every other lead is untouched', () => {
  const other = lead({ id: 'lead_bbbbbbbbbbbb', email: 'kim@example.com', notes: 'keep' });
  const sam = lead({ notes: 'VIP\nSource: Checkout inquiry.', coupon: 'SAVE10', custom_field: { a: 1 } });
  const s = setup({ leads: [other, sam] });
  const r = s.call({ body: { email: 'sam@example.com' } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, matched: 1, changed: 1 });
  const [o2, s2] = s.read();
  assert.deepEqual(o2, other);
  assert.equal(s2.unsubscribed, true);
  assert.equal(s2.unsubscribed_at, FIXED.toISOString());
  assert.equal(s2.unsubscribed_source, 'account');
  assert.equal(s2.updated_at, FIXED.toISOString());
  const { unsubscribed, unsubscribed_at, unsubscribed_source, updated_at, ...rest } = s2;
  const { unsubscribed: u0, updated_at: up0, ...rest0 } = sam;
  assert.deepEqual(rest, rest0);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o640, 'the file keeps its permissions');
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ['leads.json']);
});

test('the address is matched without regard to case and spaces, on both sides', () => {
  const s = setup({ leads: [lead({ email: '  Sam@Example.COM ' })] });
  const r = s.call({ body: { email: '  SAM@example.com  ' } });
  assert.deepEqual(r.body, { ok: true, matched: 1, changed: 1 });
  assert.equal(s.read()[0].unsubscribed, true);
  assert.equal(s.read()[0].email, '  Sam@Example.COM ', 'the stored address is left as it was');
});

test('two leads with the same address (the file is edited by hand): both are marked', () => {
  const s = setup({ leads: [lead(), lead({ id: 'lead_cccccccccccc', email: 'SAM@example.com' }), lead({ id: 'lead_dddddddddddd', email: 'kim@example.com' })] });
  assert.deepEqual(s.call({ body: { email: 'sam@example.com' } }).body, { ok: true, matched: 2, changed: 2 });
  assert.deepEqual(s.read().map(l => l.unsubscribed), [true, true, false]);
});

test('source reconcile is recorded as such', () => {
  const s = setup({ leads: [lead()] });
  s.call({ body: { email: 'sam@example.com', source: 'reconcile' } });
  assert.equal(s.read()[0].unsubscribed_source, 'reconcile');
});

test('idempotent: a second call matches and changes nothing, the file is not rewritten, the first stamp stays', () => {
  const s = setup({ leads: [lead()] });
  s.call({ body: { email: 'sam@example.com' } });
  const first = fs.readFileSync(s.file, 'utf8');
  const ino = fs.statSync(s.file).ino;
  const r = s.call({ body: { email: 'sam@example.com', source: 'reconcile' } });
  assert.deepEqual(r.body, { ok: true, matched: 1, changed: 0 });
  assert.equal(fs.readFileSync(s.file, 'utf8'), first);
  assert.equal(fs.statSync(s.file).ino, ino);
  assert.equal(s.audit.length, 1, 'audited once, for the change');
});

test('a lead that the CRM user already marked by hand (unsubscribed true) is matched and not rewritten', () => {
  const s = setup({ leads: [lead({ unsubscribed: true })] });
  const before = fs.readFileSync(s.file, 'utf8');
  assert.deepEqual(s.call({ body: { email: 'sam@example.com' } }).body, { ok: true, matched: 1, changed: 0 });
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
});

test('an address with no lead: ok, matched 0, the file is not touched and no lead is created', () => {
  const s = setup({ leads: [lead()] });
  const before = fs.readFileSync(s.file, 'utf8');
  assert.deepEqual(s.call({ body: { email: 'nobody@example.com' } }).body, { ok: true, matched: 0, changed: 0 });
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.equal(s.audit.length, 0);
});

test('no leads.json at all: matched 0 and the file is not created', () => {
  const s = setup({});
  assert.deepEqual(s.call({ body: { email: 'sam@example.com' } }).body, { ok: true, matched: 0, changed: 0 });
  assert.equal(fs.existsSync(s.file), false);
});

test('rows that are not objects or have no address do not stop the match', () => {
  const s = setup({ leads: [null, 'x', 7, { id: 'l1' }, { id: 'l2', email: null }, lead()] });
  assert.deepEqual(s.call({ body: { email: 'sam@example.com' } }).body, { ok: true, matched: 1, changed: 1 });
  assert.deepEqual(s.read().slice(0, 5), [null, 'x', 7, { id: 'l1' }, { id: 'l2', email: null }]);
});

test('audit: one line with the lead ids and the source, never the address', () => {
  const s = setup({ leads: [lead()] });
  s.call({ body: { email: 'sam@example.com' } });
  assert.equal(s.audit.length, 1);
  const [table, action, user, details] = s.audit[0];
  assert.deepEqual([table, action, user], ['leads', 'unsubscribed_from_account', 'account-service']);
  assert.match(details, /lead_aaaaaaaaaaaa/);
  assert.ok(!JSON.stringify(s.audit).includes('sam@example.com'));
});

test('a failing audit log does not fail the call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsub-route-'));
  fs.writeFileSync(path.join(dir, 'leads.json'), JSON.stringify([lead()]));
  let h;
  mount({ app: { post: (p, fn) => { h = fn; } }, DATA_DIR: dir, env: { ACCOUNT_CRM_SYNC_SECRET: SECRET }, writeAuditLog: () => { throw new Error('disk full'); } });
  const res = { status() { return this; }, json(b) { this.b = b; return this; } };
  h({ headers: { 'x-account-sync-secret': SECRET }, body: { email: 'sam@example.com' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.b.changed, 1);
});

// ---- the file ----

test('an unreadable or non-array leads.json: 503, the file is left byte for byte, and the log has no fragment of it', () => {
  for (const raw of ['{"email": "sam@example.com", broken', '{"a":1}', '"sam@example.com"', '']) {
    const s = setup({ raw });
    const { value: r, lines } = captured(() => s.call({ body: { email: 'sam@example.com' } }));
    assert.equal(r.code, 503, raw);
    assert.equal(r.body.error, 'unavailable');
    assert.equal(fs.readFileSync(s.file, 'utf8'), raw);
    assert.ok(lines.length >= 1 && !lines.join('\n').includes('sam@example.com'), lines.join('|'));
    assert.deepEqual(fs.readdirSync(s.dir).sort(), ['leads.json']);
  }
});

test('the lock: a stale leads.json.lock (over 8 s) is taken over, and ours is gone after the write', () => {
  const s = setup({ leads: [lead()] });
  const lock = s.file + '.lock';
  fs.writeFileSync(lock, '99999');
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lock, old, old);
  assert.equal(s.call({ body: { email: 'sam@example.com' } }).code, 200);
  assert.equal(fs.existsSync(lock), false);
});

test('the lock: one that stays held (another writer) is a 503 after the wait, the file untouched and the other writer\'s lock not removed', () => {
  const s = setup({ leads: [lead()] });
  const lock = s.file + '.lock';
  fs.writeFileSync(lock, '99999');
  const before = fs.readFileSync(s.file, 'utf8');
  const t0 = Date.now();
  const { value: r } = captured(() => s.call({ body: { email: 'sam@example.com' } }));
  assert.equal(r.code, 503);
  assert.ok(Date.now() - t0 >= 2400, 'waited for the other writer');
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.equal(fs.existsSync(lock), true, 'not ours to remove');
});

test('the lock is released when the write fails too (a leads.json that cannot be replaced)', () => {
  const s = setup({ leads: [lead()] });
  fs.mkdirSync(s.file + '.tmp.' + process.pid);   // the temp name is taken by a directory: writeFileSync throws
  const { value: r } = captured(() => s.call({ body: { email: 'sam@example.com' } }));
  assert.equal(r.code, 503);
  assert.equal(fs.existsSync(s.file + '.lock'), false);
  assert.equal(s.read()[0].unsubscribed, false);
});

test('mounting without app or DATA_DIR throws (the server wraps the mount in try/catch)', () => {
  assert.throws(() => mount({ DATA_DIR: '/tmp' }), /required/);
  assert.throws(() => mount({ app: { post() {} } }), /required/);
});
