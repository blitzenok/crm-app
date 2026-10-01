'use strict';
// The route in a real Express 5 app set up the way server_v14.cjs sets it up (trust proxy 1, express.json 512kb, a body sanitizer, the
// global JSON error handler after the mounts): real sockets from 127.0.0.1, with and without the proxy headers nginx adds.
// express is not a dependency of this repo: the test runs when it can be resolved (EXPRESS_PATH = a node_modules dir with express 5,
// e.g. .scratch/crm-nav-20260921/server-stand/node_modules) and is skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const mount = require('../../account-unsubscribe.cjs');

let express = null;
for (const base of [process.env.EXPRESS_PATH, __dirname, path.join(__dirname, '..', '..')]) {
  if (!base) continue;
  try { express = require(require.resolve('express', { paths: [base] })); break; } catch (e) { /* next */ }
}
const skip = express ? false : 'express is not installed (set EXPRESS_PATH to a node_modules dir with express 5)';
const SECRET = 'k'.repeat(48);

async function boot(leads) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsub-express-'));
  fs.writeFileSync(path.join(dir, 'leads.json'), JSON.stringify(leads));
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));
  app.use((req, res, next) => { if (req.body && typeof req.body === 'object') req.body = JSON.parse(JSON.stringify(req.body).replace(/javascript\s*:/gi, '')); next(); });
  mount({ app, DATA_DIR: dir, env: { ACCOUNT_CRM_SYNC_SECRET: SECRET }, writeAuditLog() {} });
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: 'handled' }); });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (headers, body, type = 'application/json') => new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body !== undefined) { h['content-type'] = type; h['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: mount.ROUTE, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return { dir, call, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'leads.json'), 'utf8')), close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}
const L = over => Object.assign({ id: 'lead_1', email: 'sam@example.com', unsubscribed: false, updated_at: 'x' }, over);
const ok = { 'x-account-sync-secret': SECRET };

test('express: the caller of this machine (no proxy headers, right secret) marks the lead; 200 JSON', { skip }, async () => {
  const s = await boot([L()]);
  try {
    const r = await s.call(ok, JSON.stringify({ email: 'Sam@Example.com' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, matched: 1, changed: 1 });
    assert.equal(s.read()[0].unsubscribed, true);
  } finally { await s.close(); }
});

test('express: the same request as nginx would forward it (X-Forwarded-For and X-Real-IP, which nginx always sets) is a 403 even with the right secret', { skip }, async () => {
  const s = await boot([L()]);
  try {
    for (const extra of [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-for': '127.0.0.1' }]) {
      const r = await s.call(Object.assign({}, ok, extra), JSON.stringify({ email: 'sam@example.com' }));
      assert.equal(r.status, 403);
    }
    assert.equal(s.read()[0].unsubscribed, false);
  } finally { await s.close(); }
});

test('express: no secret is a 403; a body that is not JSON or not an object is a 400, an oversized one a handled error, nothing is written', { skip }, async () => {
  const s = await boot([L()]);
  try {
    assert.equal((await s.call({}, JSON.stringify({ email: 'sam@example.com' }))).status, 403);
    assert.equal((await s.call(ok, 'email=sam@example.com', 'text/plain')).status, 400);
    assert.equal((await s.call(ok, '{"email": ', 'application/json')).body.error, 'handled');
    assert.equal((await s.call(ok, JSON.stringify({ email: 'sam@example.com', pad: 'x'.repeat(600 * 1024) }))).body.error, 'handled');
    assert.equal(s.read()[0].unsubscribed, false);
  } finally { await s.close(); }
});
