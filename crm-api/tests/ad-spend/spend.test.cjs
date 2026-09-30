'use strict';
// marketing-spend.cjs over node:http with the server's real lockedUpdate/writeJSONAtomic: validation, source normalization,
// atomic write, soft delete into the journal, audit, unreadable file = 503 (and untouched), concurrent writes, auth, pass-through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SPEND, makeServerWriters, tmpDir, listen, call } = require('./helpers.cjs');
const marketingSpend = require(SPEND);
const { normalizeSource, parseAmountCents } = marketingSpend;

const NOW = Date.parse('2026-10-01T12:00:00Z');
async function setup(opts) {
  const dir = tmpDir('ad-spend-');
  const w = makeServerWriters(dir);
  const handler = marketingSpend(Object.assign({ lockedUpdate: w.lockedUpdate, DATA_DIR: dir, now: () => NOW, readRawBody: !!(opts && opts.rawBody) }, opts));
  const server = await listen(handler, opts);
  const file = path.join(dir, 'marketing-spend.json');
  return { dir, server, file, audit: w.audit, stop: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const good = { date: '2026-09-30', source: 'facebook', campaign: 'Launch A', amount: '123.45', note: 'test' };

test('normalizeSource: known names and labels, other:<slug> by the products-api slug rule, no synonym table, direct refused', () => {
  assert.equal(normalizeSource('google'), 'google');
  assert.equal(normalizeSource('  Facebook '), 'facebook');
  assert.equal(normalizeSource('Meta'), 'meta');
  assert.equal(normalizeSource('TikTok'), 'tiktok');
  assert.equal(normalizeSource('other:Ram'), 'other:ram');
  assert.equal(normalizeSource('OTHER: Ram Affiliate!! '), 'other:ram-affiliate');
  assert.equal(normalizeSource('other:Google'), 'google');          // a known name typed as other lands on the known key
  assert.equal(normalizeSource('other:Facebook'), 'facebook');
  // no synonym table: what products-api would turn into a known source stays what was typed
  assert.equal(normalizeSource('other:FB'), 'other:fb');
  assert.equal(normalizeSource('other:Google Ads'), 'other:google-ads');
  assert.equal(normalizeSource('other:customer.io'), 'other:customer-io');
  assert.equal(normalizeSource('other:email'), 'other:email');
  assert.equal(normalizeSource('ram'), null);                       // a bare unknown name must say other:
  assert.equal(normalizeSource('fb'), null);
  assert.equal(normalizeSource('direct'), null);                    // nobody pays for direct
  assert.equal(normalizeSource('Direct / unknown'), null);
  assert.equal(normalizeSource('other:direct'), null);
  assert.equal(normalizeSource('other:'), null);
  assert.equal(normalizeSource('other:!!!'), null);
  assert.equal(normalizeSource(''), null);
  assert.equal(normalizeSource(undefined), null);
  assert.equal(normalizeSource({ toString: null }), null);
  assert.equal(normalizeSource('other:' + 'x'.repeat(80)), 'other:' + 'x'.repeat(40));
});

test('parseAmountCents: dollars with at most two decimals, > 0, <= 100000', () => {
  assert.equal(parseAmountCents('123.45'), 12345);
  assert.equal(parseAmountCents(5), 500);
  assert.equal(parseAmountCents('0.1'), 10);
  assert.equal(parseAmountCents('0.29'), 29);                       // 0.29 * 100 = 28.999... if done in floats
  assert.equal(parseAmountCents('100000'), 10000000);
  assert.equal(parseAmountCents('100000.00'), 10000000);
  for (const bad of ['100000.01', '100001', '0', '0.00', '-5', '12.345', '1e3', '', ' ', 'abc', '10.', '.5', NaN, Infinity, null, undefined, {}, [], true, '1,000'])
    assert.equal(parseAmountCents(bad), null, String(bad));
});

test('POST: stores cents, createdBy/createdAt, normalizes the source, answers 201 with the entry; GET returns it', async () => {
  const t = await setup();
  try {
    const r = await call(t.server, 'POST', '', Object.assign({}, good, { source: 'other:Ram' }), 'Ann@Example.com');
    assert.equal(r.status, 201, r.text);
    const e = r.body.entry;
    assert.match(e.id, /^sp_[0-9a-f]{12}$/);
    assert.deepEqual({ date: e.date, source: e.source, campaign: e.campaign, amountCents: e.amountCents, note: e.note, createdBy: e.createdBy, createdAt: e.createdAt },
      { date: '2026-09-30', source: 'other:ram', campaign: 'Launch A', amountCents: 12345, note: 'test', createdBy: 'Ann@Example.com', createdAt: '2026-10-01T12:00:00.000Z' });
    const onDisk = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].amountCents, 12345);
    assert.equal(typeof onDisk[0].amountCents, 'number');
    const g = await call(t.server, 'GET', '');
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.entries.map(x => x.id), [e.id]);
    assert.equal(g.body.totalCents, 12345);
    assert.deepEqual(t.audit, [{ table: 'marketing-spend', action: 'create', user: 'Ann@Example.com', details: e.id + ' 2026-09-30 other:ram 123.45' }]);
    // no temp or WAL file is left behind by the atomic write
    assert.deepEqual(fs.readdirSync(t.dir), ['marketing-spend.json']);
  } finally { t.stop(); }
});

test('POST: validation answers 400 and writes nothing', async () => {
  const t = await setup();
  try {
    const bad = [
      { date: '2026-02-30' }, { date: '30.09.2026' }, { date: '' }, { date: undefined }, { date: '2019-12-31' }, { date: '2026-10-03' },   // tomorrow (UTC) is allowed, two days ahead is not
      { source: 'ram' }, { source: '' }, { source: 5 },
      { amount: '0' }, { amount: '-1' }, { amount: '100000.01' }, { amount: '1.234' }, { amount: 'ten' }, { amount: undefined }, { amount: 1e21 },
      { campaign: 5 }, { note: { a: 1 } }
    ];
    for (const patch of bad) {
      const r = await call(t.server, 'POST', '', Object.assign({}, good, patch));
      assert.equal(r.status, 400, JSON.stringify(patch) + ' -> ' + r.text);
      assert.ok(r.body && typeof r.body.error === 'string');
    }
    assert.equal(fs.existsSync(t.file), false);
    assert.equal((await call(t.server, 'POST', '', Object.assign({}, good, { date: '2026-10-02' }))).status, 201);   // tomorrow is fine
  } finally { t.stop(); }
});

test('POST: optional fields, text is cleaned (control characters, length), not escaped (the page escapes)', async () => {
  const t = await setup();
  try {
    const r = await call(t.server, 'POST', '', { date: '2026-09-30', source: 'google', amount: 10 });
    assert.equal(r.status, 201);
    assert.equal(r.body.entry.campaign, ''); assert.equal(r.body.entry.note, '');
    const r2 = await call(t.server, 'POST', '', Object.assign({}, good, { campaign: 'a\u0000b\nc  d<b>x</b>' + 'y'.repeat(200), note: 'n'.repeat(500) }));
    assert.equal(r2.status, 201);
    assert.ok(r2.body.entry.campaign.startsWith('a b c d<b>x</b>y'));
    assert.equal(r2.body.entry.campaign.length, 80);
    assert.equal(r2.body.entry.note.length, 200);
  } finally { t.stop(); }
});

test('GET: from / to are inclusive, bad dates are 400, deleted entries are hidden, newest day first', async () => {
  const t = await setup();
  try {
    const ids = {};
    for (const d of ['2026-09-01', '2026-09-15', '2026-09-30']) ids[d] = (await call(t.server, 'POST', '', Object.assign({}, good, { date: d }))).body.entry.id;
    const days = async q => (await call(t.server, 'GET', q)).body.entries.map(e => e.date);
    assert.deepEqual(await days(''), ['2026-09-30', '2026-09-15', '2026-09-01']);
    assert.deepEqual(await days('?from=2026-09-15'), ['2026-09-30', '2026-09-15']);
    assert.deepEqual(await days('?to=2026-09-15'), ['2026-09-15', '2026-09-01']);
    assert.deepEqual(await days('?from=2026-09-15&to=2026-09-15'), ['2026-09-15']);
    assert.equal((await call(t.server, 'GET', '?from=yesterday')).status, 400);
    assert.equal((await call(t.server, 'GET', '?to=2026-13-01')).status, 400);
    assert.equal((await call(t.server, 'DELETE', '/' + ids['2026-09-15'])).status, 200);
    assert.deepEqual(await days(''), ['2026-09-30', '2026-09-01']);
    const total = (await call(t.server, 'GET', '')).body.totalCents;
    assert.equal(total, 2 * 12345);
  } finally { t.stop(); }
});

test('DELETE: the entry goes to the journal (deleted: by/at) in the same file, audit line, second delete and unknown id are 404', async () => {
  const t = await setup();
  try {
    const id = (await call(t.server, 'POST', '', good, 'ann@example.com')).body.entry.id;
    const other = (await call(t.server, 'POST', '', good, 'ann@example.com')).body.entry.id;
    const r = await call(t.server, 'DELETE', '/' + id, undefined, 'bob@example.com');
    assert.deepEqual(r.body, { ok: true, id });
    const onDisk = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.equal(onDisk.length, 2, 'nothing is removed from the file');
    const gone = onDisk.find(e => e.id === id), kept = onDisk.find(e => e.id === other);
    assert.deepEqual(gone.deleted, { by: 'bob@example.com', at: '2026-10-01T12:00:00.000Z' });
    assert.equal(gone.amountCents, 12345, 'the record itself is intact');
    assert.equal(kept.deleted, undefined);
    assert.deepEqual(t.audit[t.audit.length - 1], { table: 'marketing-spend', action: 'delete', user: 'bob@example.com', details: id });
    assert.equal((await call(t.server, 'DELETE', '/' + id)).status, 404);
    assert.equal((await call(t.server, 'DELETE', '/sp_000000000000')).status, 404);
    assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).find(e => e.id === id).deleted.by, 'bob@example.com', 'a second delete does not rewrite who deleted');
    const auditLen = t.audit.length;
    await call(t.server, 'DELETE', '/' + id);
    assert.equal(t.audit.length, auditLen, 'a 404 delete writes no audit line');
    // a malformed id is not ours: pass-through (the test server answers 404 like the mounted express would)
    assert.equal((await call(t.server, 'DELETE', '/..%2Fusers')).status, 404);
    assert.equal((await call(t.server, 'DELETE', '/not-an-id')).status, 404);
  } finally { t.stop(); }
});

test('an unreadable file is 503 and is never overwritten; a missing file is an empty list', async () => {
  const t = await setup();
  try {
    assert.deepEqual((await call(t.server, 'GET', '')).body, { entries: [], totalCents: 0 });
    for (const junk of ['{ not json', '{"a":1}', '']) {
      fs.writeFileSync(t.file, junk);
      assert.equal((await call(t.server, 'GET', '')).status, 503, junk);
      assert.equal((await call(t.server, 'POST', '', good)).status, 503, junk);
      assert.equal((await call(t.server, 'DELETE', '/sp_000000000000')).status, 503, junk);
      assert.equal(fs.readFileSync(t.file, 'utf8'), junk, 'the damaged file is left exactly as it was');
    }
  } finally { t.stop(); }
});

test('concurrent POSTs and a DELETE in flight: nothing is lost (the write queue of lockedUpdate)', async () => {
  const t = await setup();
  try {
    const first = (await call(t.server, 'POST', '', good)).body.entry.id;
    const results = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) => call(t.server, 'POST', '', Object.assign({}, good, { amount: String(i + 1) }))),
      call(t.server, 'DELETE', '/' + first)
    ]);
    assert.ok(results.slice(0, 12).every(r => r.status === 201));
    assert.equal(results[12].status, 200);
    const onDisk = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.equal(onDisk.length, 13);
    assert.equal(new Set(onDisk.map(e => e.id)).size, 13);
    assert.equal(onDisk.filter(e => e.deleted).length, 1);
    assert.deepEqual(onDisk.filter(e => !e.deleted).map(e => e.amountCents).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => (i + 1) * 100));
  } finally { t.stop(); }
});

test('routes it does not own go to next(); no session is the mount\'s 401, not ours', async () => {
  const t = await setup();
  try {
    assert.equal((await call(t.server, 'PUT', '', good)).status, 404);
    assert.equal((await call(t.server, 'PATCH', '/sp_000000000000', {})).status, 404);
    assert.equal((await call(t.server, 'GET', '/sp_000000000000')).status, 404);
    assert.equal((await call(t.server, 'GET', '', undefined, null)).status, 401);
    assert.equal((await call(t.server, 'POST', '', good, null)).status, 401);
    assert.equal(fs.existsSync(t.file), false);
  } finally { t.stop(); }
});

test('a body the module reads itself (no express.json in front): bad JSON is 400, an oversized body is 413, an array is treated as empty', async () => {
  const t = await setup({ rawBody: true });
  try {
    assert.equal((await call(t.server, 'POST', '', '{ nope')).status, 400);
    assert.equal((await call(t.server, 'POST', '', '[1,2]')).status, 400);
    const r = await call(t.server, 'POST', '', JSON.stringify(Object.assign({}, good, { note: 'x'.repeat(20000) })));
    assert.equal(r.status, 413);
    assert.equal((await call(t.server, 'POST', '', JSON.stringify(good))).status, 201);
  } finally { t.stop(); }
});

test('no parsed body (not JSON, or no parser in front) is 415 unless the test-only readRawBody is on; GET and DELETE need no body', async () => {
  const t = await setup({ noParse: true });
  try {
    const r = await call(t.server, 'POST', '', good);
    assert.equal(r.status, 415, r.text);
    assert.equal(fs.existsSync(t.file), false);
    assert.equal((await call(t.server, 'GET', '')).status, 200);
    assert.equal((await call(t.server, 'DELETE', '/sp_000000000000')).status, 404);
  } finally { t.stop(); }
});

test('the constructor refuses to run without the server\'s lockedUpdate and DATA_DIR', () => {
  assert.throws(() => marketingSpend({}), /needs/);
  assert.throws(() => marketingSpend({ lockedUpdate() {} }), /needs/);
});
