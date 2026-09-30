'use strict';
// GET /api/unit-costs (blitz-api, behind requireAuth): hands the unit-cost list to the Finance Reports page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const unitCosts = require('../../unit-costs.cjs');

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end('next'); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: () => new Promise(r => server.close(r)) };
}

function tmpFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-costs-'));
  const file = path.join(dir, 'unit-costs.json');
  if (text !== undefined) fs.writeFileSync(file, text);
  return file;
}

test('GET returns the list as stored, read on every request (no restart after an update)', async () => {
  const file = tmpFile(JSON.stringify({ currency: 'USD', items: [{ id: 'A', cost: 5, match: [] }] }));
  const s = await serve(unitCosts({ file }));
  try {
    let r = await fetch(s.base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.deepEqual((await r.json()).items.map(i => i.id), ['A']);
    fs.writeFileSync(file, JSON.stringify({ currency: 'USD', items: [{ id: 'B', cost: 6, match: [] }] }));
    r = await fetch(s.base + '/');
    assert.deepEqual((await r.json()).items.map(i => i.id), ['B']);
  } finally { await s.close(); }
});

test('no file -> 404, broken file -> 500; the message does not show the path', async () => {
  const missing = tmpFile();
  let s = await serve(unitCosts({ file: missing }));
  try {
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 404);
    const body = await r.text();
    assert.equal(body.includes(missing), false);
    assert.match(body, /no unit cost list/);
  } finally { await s.close(); }
  const broken = tmpFile('{ half');
  s = await serve(unitCosts({ file: broken }));
  try {
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 500);
    const body = await r.text();
    assert.equal(body.includes(broken), false);
    assert.match(body, /unreadable/);
  } finally { await s.close(); }
});

test('a list without an items array is refused as unreadable', async () => {
  const s = await serve(unitCosts({ file: tmpFile(JSON.stringify({ items: 'x' })) }));
  try { assert.equal((await fetch(s.base + '/')).status, 500); } finally { await s.close(); }
});

test('only GET / is answered; other methods and paths go to next()', async () => {
  const s = await serve(unitCosts({ file: tmpFile(JSON.stringify({ items: [] })) }));
  try {
    let r = await fetch(s.base + '/', { method: 'POST', body: '{}' });
    assert.equal(await r.text(), 'next');
    r = await fetch(s.base + '/other');
    assert.equal(await r.text(), 'next');
    r = await fetch(s.base + '/?x=1');
    assert.equal(r.status, 200);
  } finally { await s.close(); }
});
