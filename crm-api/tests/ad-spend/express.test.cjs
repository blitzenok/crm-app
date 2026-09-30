'use strict';
// The same module mounted in a real Express 5 app the way server_v14.cjs mounts it (express.json, the server's own sanitizeValue over
// the body, requireAuth on the mount, global JSON error handler after it). express is not a dependency of this repo: the test runs when
// it can be resolved (EXPRESS_PATH = a node_modules dir with express 5, or a global one) and is skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SPEND, SERVER_FILE, extractFunction, makeServerWriters, tmpDir, call } = require('./helpers.cjs');
const marketingSpend = require(SPEND);

let express = null;
for (const base of [process.env.EXPRESS_PATH, __dirname]) {
  if (!base) continue;
  try { express = require(require.resolve('express', { paths: [base] })); break; } catch (e) { /* next */ }
}
const skip = express ? false : 'express is not installed (set EXPRESS_PATH to a node_modules dir with express 5)';

test('mounted in Express 5 behind express.json + the server sanitizer + requireAuth: create, list, delete, sanitized text, 401 without a session', { skip }, async () => {
  const dir = tmpDir('ad-spend-express-');
  const w = makeServerWriters(dir);
  const sanitizeValue = new Function(extractFunction(fs.readFileSync(SERVER_FILE, 'utf8'), 'function sanitizeValue(val)') + '\nreturn sanitizeValue;')();
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use((req, res, next) => { if (req.body && typeof req.body === 'object') req.body = sanitizeValue(req.body); next(); });
  const requireAuth = (req, res, next) => {
    if (!req.headers['x-user']) return res.status(401).json({ error: 'Authentication required' });
    req.userSession = { email: req.headers['x-user'] };
    next();
  };
  app.use('/api/marketing/spend', requireAuth, marketingSpend({ lockedUpdate: w.lockedUpdate, DATA_DIR: dir }));
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: 'handler' }); });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const body = { date: '2026-09-30', source: 'other:Ram', campaign: 'A<script>alert(1)</script>B', amount: '10.50', note: 'n' };
    const r = await call(server, 'POST', '', body);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.entry.campaign, 'AB', 'the server-wide sanitizer ran first; the stored text is what it left');
    assert.equal(r.body.entry.source, 'other:ram');
    assert.equal((await call(server, 'POST', '/', body)).status, 201, 'a trailing slash is the same route');
    const g = await call(server, 'GET', '?from=2026-09-01&to=2026-09-30');
    assert.equal(g.status, 200);
    assert.equal(g.body.entries.length, 2);
    assert.equal(g.body.totalCents, 2100);
    assert.equal((await call(server, 'GET', '', undefined, null)).status, 401);
    assert.equal((await call(server, 'POST', '', body, null)).status, 401);
    assert.equal((await call(server, 'DELETE', '/' + r.body.entry.id, undefined, 'bob@example.com')).status, 200);
    assert.equal((await call(server, 'GET', '')).body.entries.length, 1);
    assert.equal((await call(server, 'POST', '', '{ broken')).status, 400);
    assert.equal((await call(server, 'PUT', '', body)).status, 404, 'a method it does not own falls through to Express\' own 404');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'marketing-spend.json'), 'utf8'));
    assert.equal(onDisk.length, 2);
    assert.equal(onDisk.filter(e => e.deleted).length, 1);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
