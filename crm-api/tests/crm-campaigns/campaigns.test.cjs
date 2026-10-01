'use strict';
// node --test test/*.test.cjs. Core of marketing-campaigns.cjs: the answer built from fixtures, a source that fails,
// the cache, the newsletter file, and the proof that nothing but GET leaves the module.
// No express and no real Customer.io: the stub is a function, the transport is tried against a server on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const mod = require('../../marketing-campaigns.cjs');
const { createCore, metricsFrom, readNewsletters } = mod;

const SRC = path.join(__dirname, '..', '..', 'marketing-campaigns.cjs');
const series = o => ({ metric: { series: o } });

const CAMPAIGNS = [
  { id: 4, name: 'Welcome', event_name: 'subscribed', state: 'running', active: true, updated: 1788800000 },
  { id: 10, name: 'Replenishment', trigger_segment_ids: [3, 'x', 3], state: 'draft', active: false },
  { id: 12, name: 'Delivered', type: 'event', state: 'stopped' }
];
const BROADCASTS = [{ id: 11, name: 'CRM Newsletter', updated: 1788800100 }, { id: 15, name: 'Other' }];
const TRANSACTIONAL = [{ id: 1, name: 'All uncategorized email messages' }, { id: 3, name: 'order-customer' }];

function liveMap() {
  const m = {
    '/v1/campaigns': { status: 200, data: { campaigns: CAMPAIGNS } },
    '/v1/broadcasts': { status: 200, data: { broadcasts: BROADCASTS } },
    '/v1/transactional': { status: 200, data: { messages: TRANSACTIONAL } }
  };
  const full = series({ created: [1, 2, 3], delivered: [1, 2], human_opened: [1], opened: [9], human_clicked: [0, 1], unsubscribed: [0], bounced: [0, 0] });
  for (const c of CAMPAIGNS) m['/v1/campaigns/' + c.id + '/metrics?period=days&steps=30&type=email'] = { status: 200, data: full };
  for (const b of BROADCASTS) m['/v1/broadcasts/' + b.id + '/metrics?period=days&steps=30&type=email'] = { status: 200, data: full };
  for (const t of TRANSACTIONAL) m['/v1/transactional/' + t.id + '/metrics?period=days&steps=30'] = { status: 200, data: series({ sent: [5], delivered: [4] }) };
  return m;
}
// A stub of Customer.io: exact path -> object | function; a missing path is 404. Every request is recorded.
function stub(map, calls) {
  return async (p) => {
    if (calls) calls.push(p);
    const v = map[p];
    if (v === undefined) return { status: 404, data: null };
    const out = typeof v === 'function' ? v() : v;
    if (out instanceof Error) throw out;
    return out;
  };
}
function tmpDir(issues) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-campaigns-'));
  if (issues !== undefined) fs.writeFileSync(path.join(d, 'marketing-newsletters.json'), typeof issues === 'string' ? issues : JSON.stringify(issues));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const ISSUES = [
  { id: 'nl_1', subject: 'Old one', state: 'sent', audience: { type: 'segment', segment_id: '3', segment_name: 'Buyers (CRM)' }, sent_at: '2026-09-14T10:00:00.000Z', sent_by: 'a@x.co', recipients_estimate: 120, created_at: '2026-09-13T10:00:00.000Z', body_html: '<p>SECRET BODY</p>', subject_b64: 'x' },
  { id: 'nl_2', subject: 'New draft', state: 'draft', audience: { type: 'all' }, created_at: '2026-09-30T10:00:00.000Z', body_html: '<p>SECRET BODY</p>' },
  { id: 'nl_3', subject: 'Newest sent', state: 'sent', audience: { type: 'segment', segment_id: '4', segment_name: 'VIP (CRM)' }, sent_at: '2026-09-29T10:00:00.000Z', created_at: '2026-09-28T10:00:00.000Z', recipients_estimate: 30 },
  { id: 'nl_4', subject: 'Stuck', state: 'sending', audience: { type: 'all' }, created_at: '2026-09-27T10:00:00.000Z', last_error: { message: 'timed out' } }
];
const core = (map, extra) => createCore(Object.assign({ get: stub(map), workspaceId: '231885', broadcastId: '11', DATA_DIR: tmpDir(ISSUES) }, extra || {}));

/* ── the answer ───────────────────────────────────────────────────────────────────────────── */

test('the three Customer.io sources and the newsletter record are put together', async () => {
  const calls = [];
  const d = await createCore({ get: stub(liveMap(), calls), workspaceId: '231885', broadcastId: '11', DATA_DIR: tmpDir(ISSUES) }).load(false);
  assert.equal(d.ok, true);
  assert.deepEqual(d.cio, { ok: true, partial: false });
  assert.deepEqual(d.sources, { newsletters: { ok: true }, journeys: { ok: true }, broadcasts: { ok: true }, transactional: { ok: true } });

  // journeys: the numbers use the person counters first ("opened" 1, not the scanner's 9)
  assert.equal(d.journeys.length, 3);
  assert.deepEqual(d.journeys[0].metrics30d, { sent: 6, delivered: 3, opened: 1, clicked: 1, unsubscribed: 0, bounced: 0 });
  assert.equal(d.journeys[0].trigger.kind, 'event');
  assert.equal(d.journeys[0].running, true);
  assert.equal(d.journeys[0].updated, new Date(1788800000 * 1000).toISOString());
  assert.deepEqual(d.journeys[1].trigger, { kind: 'segment', event_name: '', segment_ids: ['3'], type: '' });
  assert.equal(d.journeys[1].running, false);
  assert.equal(d.journeys[2].state, 'stopped');
  assert.equal(d.journeys[0].edit_url, 'https://fly.customer.io/workspaces/231885/journeys/automations/4/setup/workflow/actions');

  // broadcasts: the one named in .env is marked as the CRM newsletter
  assert.deepEqual(d.broadcasts.map(b => [b.id, b.is_crm_newsletter]), [['11', true], ['15', false]]);
  assert.equal(d.broadcasts[0].edit_url, 'https://fly.customer.io/workspaces/231885/journeys/broadcasts/broadcast/11/overview');

  // service letters: only what the API has (no unsubscribed counter) stays null
  assert.deepEqual(d.transactional.map(t => t.name), ['All uncategorized email messages', 'order-customer']);
  assert.deepEqual(d.transactional[1].metrics30d, { sent: 5, delivered: 4, opened: null, clicked: null, unsubscribed: null, bounced: null });

  // the newsletter record: newest first, no body, the estimate and the audience words, the stuck send flagged
  assert.deepEqual(d.issues.map(i => i.id), ['nl_2', 'nl_3', 'nl_4', 'nl_1']);
  assert.equal(d.issues_total, 4);
  assert.equal(d.issues[1].audience, 'VIP (CRM)');
  assert.equal(d.issues[1].recipients_estimate, 30);
  assert.equal(d.issues[0].audience, 'the whole broadcast audience');
  assert.equal(d.issues[2].unconfirmed, true);
  assert.equal(d.issues[3].unconfirmed, false);
  assert.ok(!JSON.stringify(d).includes('SECRET BODY'), 'the body of a letter never reaches the page');
  assert.ok(!JSON.stringify(d).includes('subject_b64'));

  // the exact reads: three lists, then one metrics call per item, one after another
  assert.deepEqual(calls, [
    '/v1/campaigns', '/v1/campaigns/4/metrics?period=days&steps=30&type=email', '/v1/campaigns/10/metrics?period=days&steps=30&type=email', '/v1/campaigns/12/metrics?period=days&steps=30&type=email',
    '/v1/broadcasts', '/v1/broadcasts/11/metrics?period=days&steps=30&type=email', '/v1/broadcasts/15/metrics?period=days&steps=30&type=email',
    '/v1/transactional', '/v1/transactional/1/metrics?period=days&steps=30', '/v1/transactional/3/metrics?period=days&steps=30'
  ]);
});

test('requests go one after another, never in parallel', async () => {
  let open = 0, peak = 0;
  const map = liveMap();
  const get = async p => { open++; peak = Math.max(peak, open); await new Promise(r => setImmediate(r)); open--; const v = map[p]; return v || { status: 404, data: null }; };
  await createCore({ get, DATA_DIR: tmpDir([]) }).load(false);
  assert.equal(peak, 1);
});

test('a metric that is not there for good is null without "partial": a 404, a 2xx with no numbers, an empty series', async () => {
  const map = liveMap();
  map['/v1/campaigns/4/metrics?period=days&steps=30&type=email'] = { status: 200, data: series({ sent: [0], delivered: [0] }) };
  delete map['/v1/campaigns/10/metrics?period=days&steps=30&type=email'];                                             // 404
  map['/v1/campaigns/12/metrics?period=days&steps=30&type=email'] = { status: 200, data: { nothing: 'useful' } };     // a shape we cannot read
  map['/v1/broadcasts/15/metrics?period=days&steps=30&type=email'] = { status: 200, data: series({ created: [] }) };  // an empty series
  map['/v1/transactional/1/metrics?period=days&steps=30'] = { status: 200, data: {} };                               // 2xx, nothing in it
  const d = await core(map).load(false);
  assert.equal(d.journeys[0].metrics30d.sent, 0, 'a real zero stays 0');
  assert.equal(d.journeys[0].metrics30d.opened, null);
  assert.equal(d.journeys[1].metrics30d, null);
  assert.equal(d.journeys[2].metrics30d, null);
  assert.equal(d.broadcasts[1].metrics30d, null);
  assert.equal(d.transactional[0].metrics30d, null);
  assert.deepEqual(d.cio, { ok: true, partial: false });
});

test('a metric that fails for a temporary reason (5xx, network, 429) marks the answer partial', async () => {
  for (const bad of [{ status: 500, data: null }, () => new mod.Upstream('Customer.io could not be reached (ECONNRESET)'), { status: 429, data: null }]) {
    const map = liveMap();
    map['/v1/campaigns/10/metrics?period=days&steps=30&type=email'] = bad;
    const d = await core(map).load(false);
    assert.equal(d.journeys[1].metrics30d, null);
    assert.deepEqual(d.cio, { ok: true, partial: true });
  }
});

test('a permanent gap keeps the normal cache (5 min), a temporary one only 30 s', async () => {
  let t = 1000;
  const run = async (badMetric) => {
    const calls = [];
    const map = liveMap();
    map['/v1/campaigns/4/metrics?period=days&steps=30&type=email'] = badMetric;
    const c = createCore({ get: stub(map, calls), now: () => t, DATA_DIR: tmpDir([]) });
    await c.load(false);
    const n = calls.length;
    t += 60 * 1000;
    await c.load(false);
    return calls.length === n;   // true = the second load came from the cache
  };
  assert.equal(await run({ status: 404, data: null }), true, '404 on a metric is permanent');
  assert.equal(await run({ status: 200, data: { nothing: 1 } }), true, 'a 2xx without numbers is permanent');
  assert.equal(await run({ status: 503, data: null }), false, '5xx is temporary');
});

test('metricsFrom: null entries are skipped, totals as numbers are accepted, nothing readable is null', () => {
  assert.deepEqual(metricsFrom(series({ sent: [1, null, 2] })), { sent: 3, delivered: null, opened: null, clicked: null, unsubscribed: null, bounced: null });
  assert.equal(metricsFrom(series({ sent: [null, null] })), null);
  assert.equal(metricsFrom({ metric: { sent: 7 } }).sent, 7);
  assert.equal(metricsFrom(null), null);
  assert.equal(metricsFrom({ hello: 'world' }), null);
});

/* ── a source that fails ──────────────────────────────────────────────────────────────────── */

test('one source down: its reason is on the answer, the others are intact', async () => {
  const map = liveMap();
  map['/v1/broadcasts'] = { status: 500, data: null };
  const d = await core(map).load(false);
  assert.deepEqual(d.sources.broadcasts, { ok: false, error: 'Customer.io is not answering (HTTP 500)' });
  assert.equal(d.broadcasts, null);
  assert.equal(d.journeys.length, 3);
  assert.equal(d.transactional.length, 2);
  assert.equal(d.issues.length, 4);
  assert.equal(d.cio.ok, true);
  assert.equal(d.cio.partial, true);
});

test('a list in a shape nobody knows is a failed source, not an empty one', async () => {
  const map = liveMap();
  map['/v1/transactional'] = { status: 200, data: { surprise: true } };
  const d = await core(map).load(false);
  assert.equal(d.sources.transactional.ok, false);
  assert.match(d.sources.transactional.error, /shape this page does not understand/);
  assert.equal(d.transactional, null);
  // while an honest empty list is empty
  map['/v1/transactional'] = { status: 200, data: { messages: [] } };
  const d2 = await core(map).load(true);
  assert.deepEqual(d2.transactional, []);
  assert.equal(d2.sources.transactional.ok, true);
});

test('a network error on one source does not stop the next one', async () => {
  const map = liveMap();
  map['/v1/campaigns'] = () => new mod.Upstream('Customer.io could not be reached (ECONNRESET)');
  const d = await core(map).load(false);
  assert.equal(d.sources.journeys.error, 'Customer.io could not be reached (ECONNRESET)');
  assert.equal(d.journeys, null);
  assert.equal(d.broadcasts.length, 2);
});

test('a refused key stops the reading at once: no more calls, the reason on every source', async () => {
  const calls = [];
  const d = await createCore({ get: stub({ '/v1/campaigns': { status: 401, data: null } }, calls), DATA_DIR: tmpDir(ISSUES) }).load(false);
  assert.deepEqual(calls, ['/v1/campaigns']);
  for (const k of ['journeys', 'broadcasts', 'transactional']) assert.equal(d.sources[k].error, 'Customer.io rejected the API key (HTTP 401)');
  assert.deepEqual(d.cio, { ok: false, error: 'Customer.io rejected the API key (HTTP 401)' });
  assert.equal(d.issues.length, 4, 'the CRM record is still shown');
});

test('a limit hit in the middle ends the reading and leaves the rest as gaps', async () => {
  const map = liveMap();
  map['/v1/campaigns/10/metrics?period=days&steps=30&type=email'] = { status: 429, data: null };
  const calls = [];
  const d = await createCore({ get: stub(map, calls), DATA_DIR: tmpDir([]) }).load(false);
  assert.equal(d.journeys[0].metrics30d.sent, 6);
  assert.equal(d.journeys[1].metrics30d, null);
  assert.equal(d.journeys[2].metrics30d, null);
  assert.deepEqual(calls.slice(-1), ['/v1/campaigns/10/metrics?period=days&steps=30&type=email']);
  assert.equal(d.sources.broadcasts.ok, false);
  assert.match(d.sources.broadcasts.error, /rate limiting/);
});

test('no key in .env: every Customer.io source says so, no request is made, the CRM record still shows', async () => {
  const keep = process.env.CIO_APP_API_KEY;
  delete process.env.CIO_APP_API_KEY;
  const err = console.error; console.error = () => {};
  try {
    const d = await createCore({ DATA_DIR: tmpDir(ISSUES) }).load(false);
    assert.equal(d.cio.ok, false);
    assert.match(d.cio.error, /CIO_APP_API_KEY is missing/);
    assert.equal(d.journeys, null);
    assert.equal(d.issues.length, 4);
  } finally { console.error = err; if (keep !== undefined) process.env.CIO_APP_API_KEY = keep; }
});

test('a deadline that is over stops new calls', async () => {
  let t = 1000;
  const calls = [];
  const get = async p => { calls.push(p); t += 40000; return liveMap()[p] || { status: 404, data: null }; };
  const d = await createCore({ get, now: () => t, DATA_DIR: tmpDir([]) }).load(false);
  assert.equal(calls.length, 1);
  assert.equal(d.sources.journeys.ok, true);
  assert.equal(d.cio.partial, true);
  assert.match(d.sources.broadcasts.error, /did not answer in time/);
});

/* ── the cache ────────────────────────────────────────────────────────────────────────────── */

test('cache: 5 minutes for a whole answer, 30 seconds for a partial one, nothing for a total failure', async () => {
  let t = 1000;
  const calls = [];
  const map = liveMap();
  const c = createCore({ get: stub(map, calls), now: () => t, DATA_DIR: tmpDir([]) });
  await c.load(false);
  const n = calls.length;
  t += 299 * 1000; await c.load(false);
  assert.equal(calls.length, n, 'inside 5 minutes: from the cache');
  t += 2 * 1000; await c.load(false);
  assert.equal(calls.length, 2 * n, 'after 5 minutes: read again');

  // partial: one metric failed with a 5xx
  const calls2 = [];
  const map2 = liveMap();
  map2['/v1/campaigns/4/metrics?period=days&steps=30&type=email'] = { status: 500, data: null };
  const c2 = createCore({ get: stub(map2, calls2), now: () => t, DATA_DIR: tmpDir([]) });
  await c2.load(false);
  const m = calls2.length;
  t += 20 * 1000; await c2.load(false);
  assert.equal(calls2.length, m, 'a partial answer holds for 30 seconds');
  t += 11 * 1000; await c2.load(false);
  assert.equal(calls2.length, 2 * m, 'then it is read again so that recovery shows');

  // total failure: not kept
  const calls3 = [];
  const c3 = createCore({ get: stub({ '/v1/campaigns': { status: 500, data: null }, '/v1/broadcasts': { status: 500, data: null }, '/v1/transactional': { status: 500, data: null } }, calls3), now: () => t, DATA_DIR: tmpDir([]) });
  await c3.load(false);
  await c3.load(false);
  assert.equal(calls3.length, 6);
});

test('Refresh reads past the cache, but not when the cache is younger than 30 s (it says when to come back)', async () => {
  let t = 1000;
  const calls = [];
  const c = createCore({ get: stub(liveMap(), calls), now: () => t, DATA_DIR: tmpDir([]) });
  const first = await c.load(false);
  const n = calls.length;
  assert.equal(first.throttled, undefined);
  t += 10 * 1000;
  const r = await c.load(true);
  assert.equal(calls.length, n);
  assert.equal(r.throttled, true);
  assert.equal(r.refresh_in_s, 20);
  t += 25 * 1000;
  const r2 = await c.load(true);
  assert.equal(calls.length, 2 * n);
  assert.equal(r2.throttled, undefined);
});

test('two requests together share one read', async () => {
  const calls = [];
  const c = createCore({ get: stub(liveMap(), calls), DATA_DIR: tmpDir([]) });
  const [a, b] = await Promise.all([c.load(false), c.load(false)]);
  assert.equal(calls.length, 10);
  assert.deepEqual(a.journeys, b.journeys);
});

test('the newsletter record is read on every request, a cached Customer.io part does not hide a new issue', async () => {
  const dir = tmpDir([]);
  const calls = [];
  const c = createCore({ get: stub(liveMap(), calls), DATA_DIR: dir });
  assert.deepEqual((await c.load(false)).issues, []);
  fs.writeFileSync(path.join(dir, 'marketing-newsletters.json'), JSON.stringify(ISSUES));
  const n = calls.length;
  assert.equal((await c.load(false)).issues.length, 4);
  assert.equal(calls.length, n);
});

/* ── the newsletter file ──────────────────────────────────────────────────────────────────── */

test('newsletter file: missing = no issues, unreadable = a gap with its reason, never "no issues"', () => {
  assert.deepEqual(readNewsletters(tmpDir()), { ok: true, issues: [], total: 0 });
  assert.deepEqual(readNewsletters(tmpDir('{not json')), { ok: false, error: 'marketing-newsletters.json is not readable JSON' });
  assert.deepEqual(readNewsletters(tmpDir('{"a":1}')), { ok: false, error: 'marketing-newsletters.json is not a list' });
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'marketing-newsletters.json'));   // a directory where the file should be: EISDIR
  const r = readNewsletters(dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot be read \(EISDIR\)/);
});

test('newsletter file down: the source is a gap on the answer and Customer.io is unaffected', async () => {
  const d = await createCore({ get: stub(liveMap()), DATA_DIR: tmpDir('garbage') }).load(false);
  assert.deepEqual(d.sources.newsletters, { ok: false, error: 'marketing-newsletters.json is not readable JSON' });
  assert.equal(d.issues, null);
  assert.equal(d.journeys.length, 3);
});

test('newsletter file: junk entries are dropped, text is cleaned and cut, only 50 newest are shown', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ id: 'nl_' + i, subject: 's' + i, state: 'sent', sent_at: '2026-09-' + String(1 + (i % 28)).padStart(2, '0') + 'T10:00:00.000Z' });
  many.push(null, 5, 'x', { id: 'nl_x', subject: 'a\u0000b\u001fc' + 'z'.repeat(400), state: 'weird', audience: { type: 'segment' }, recipients_estimate: 'many' });
  const r = readNewsletters(tmpDir(many));
  assert.equal(r.total, 61);
  assert.equal(r.issues.length, 50);
  const weird = readNewsletters(tmpDir(many.slice(60))).issues[0];
  assert.equal(weird.subject.length, 300);
  assert.ok(!/[\x00-\x1f]/.test(weird.subject));
  assert.equal(weird.state, 'draft');
  assert.equal(weird.audience, 'a segment');
  assert.equal(weird.recipients_estimate, null);
});

test('text from Customer.io is stripped of control characters and cut', async () => {
  const map = liveMap();
  map['/v1/campaigns'] = { status: 200, data: { campaigns: [{ id: 4, name: 'A\u0007B' + 'n'.repeat(300), state: 'running', event_name: 'e\nv' }, { id: '../x', name: 'bad id' }] } };
  const d = await core(map).load(false);
  assert.ok(!/[\x00-\x1f]/.test(d.journeys[0].name));
  assert.equal(d.journeys[0].name.length, 160);
  assert.equal(d.journeys[0].trigger.event_name, 'e v');
  // an id that is not ours is not put into a path or a link
  assert.equal(d.journeys[1].id, '');
  assert.equal(d.journeys[1].edit_url, null);
  assert.equal(d.journeys[1].metrics30d, null);
});

test('the broadcast of the CRM newsletter is read first, so the cap cannot cut it off', async () => {
  const map = liveMap();
  const many = [];
  for (let i = 20; i < 32; i++) { many.push({ id: i, name: 'b' + i }); map['/v1/broadcasts/' + i + '/metrics?period=days&steps=30&type=email'] = { status: 200, data: series({ sent: [1] }) }; }
  many.push({ id: 11, name: 'CRM Newsletter' });   // last of 13, the cap is 10
  map['/v1/broadcasts'] = { status: 200, data: { broadcasts: many } };
  const d = await core(map).load(false);
  assert.equal(d.broadcasts.length, 10);
  assert.equal(d.broadcasts_total, 13);
  assert.equal(d.broadcasts[0].id, '11');
  assert.equal(d.broadcasts[0].is_crm_newsletter, true);
  // without an id in .env the order is the provider's
  const d2 = await createCore({ get: stub(map), broadcastId: '', DATA_DIR: tmpDir([]) }).load(false);
  assert.equal(d2.broadcasts[0].id, '20');
});

test('the list is cut at the limits and the total is kept', async () => {
  const map = liveMap();
  const many = [];
  for (let i = 1; i <= 45; i++) { many.push({ id: i, name: 'c' + i, state: 'running' }); map['/v1/campaigns/' + i + '/metrics?period=days&steps=30&type=email'] = { status: 200, data: series({ sent: [i] }) }; }
  map['/v1/campaigns'] = { status: 200, data: { campaigns: many } };
  const d = await core(map).load(false);
  assert.equal(d.journeys.length, 40);
  assert.equal(d.journeys_total, 45);
});

/* ── nothing but GET ──────────────────────────────────────────────────────────────────────── */

test('the source has one HTTP method, GET, and no way to write: no other verbs, no Track API, no file writes', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.deepEqual([...src.matchAll(/method:\s*([^,\s}]+)/g)].map(m => m[1]), ["'GET'"]);
  for (const bad of ['POST', 'PUT', 'DELETE', 'PATCH', 'track.customer.io', '/v1/send', '/triggers', 'req.write', 'writeFile', 'appendFile', 'createWriteStream', 'unlink', 'rename', 'mkdir', 'lockedUpdate']) {
    assert.ok(!src.includes(bad), 'found ' + bad);
  }
  assert.deepEqual([...src.matchAll(/router\.(\w+)\(/g)].map(m => m[1]), ['get']);
  for (const m of src.matchAll(/'(\/v1\/[^']*)'/g)) assert.match(m[1], /^\/v1\/(campaigns|broadcasts|transactional)/);
});

test('on the wire every request is a GET with the key in the header, nothing in the body, and the key is not in the answer', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const u = new URL(req.url, 'http://x');
      const map = liveMap();
      const hit = map[u.pathname + u.search] || (u.pathname === '/v1/campaigns' ? map['/v1/campaigns'] : null);
      res.writeHead(hit ? hit.status : 404, { 'Content-Type': 'application/json' });
      res.end(hit && hit.data ? JSON.stringify(hit.data) : '{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const keep = { k: process.env.CIO_APP_API_KEY, b: process.env.CIO_API_BASE };
  process.env.CIO_APP_API_KEY = 'KEY-for-test-0123456789';
  process.env.CIO_API_BASE = 'http://127.0.0.1:' + server.address().port;
  try {
    const d = await createCore({ DATA_DIR: tmpDir(ISSUES) }).load(false);
    assert.equal(d.journeys.length, 3);
    assert.equal(d.journeys[0].metrics30d.sent, 6);
    assert.equal(seen.length, 10);
    assert.ok(seen.every(s => s.method === 'GET' && s.body === ''), 'only GET without a body');
    assert.ok(seen.every(s => s.auth === 'Bearer KEY-for-test-0123456789'));
    assert.ok(!JSON.stringify(d).includes('KEY-for-test'));
  } finally {
    server.close();
    for (const [name, v] of [['CIO_APP_API_KEY', keep.k], ['CIO_API_BASE', keep.b]]) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  }
});

test('plain http to a host that is not this machine is not used (the key would travel in the clear)', async () => {
  const keep = { k: process.env.CIO_APP_API_KEY, b: process.env.CIO_API_BASE };
  process.env.CIO_APP_API_KEY = 'KEY-for-test';
  process.env.CIO_API_BASE = 'http://example.com';
  const err = console.error; console.error = () => {};
  try {
    const d = await createCore({ DATA_DIR: tmpDir([]) }).load(false);
    assert.match(d.cio.error, /not a usable address/);
  } finally {
    console.error = err;
    for (const [name, v] of [['CIO_APP_API_KEY', keep.k], ['CIO_API_BASE', keep.b]]) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  }
});

test('the newsletter record on disk is not touched by a read', async () => {
  const dir = tmpDir(ISSUES);
  const file = path.join(dir, 'marketing-newsletters.json');
  const before = fs.readFileSync(file);
  const m1 = fs.statSync(file).mtimeMs;
  await createCore({ get: stub(liveMap()), DATA_DIR: dir }).load(false);
  assert.ok(before.equals(fs.readFileSync(file)));
  assert.equal(fs.statSync(file).mtimeMs, m1);
  assert.deepEqual(fs.readdirSync(dir), ['marketing-newsletters.json']);
});

/* ── the router ───────────────────────────────────────────────────────────────────────────── */

function fakeExpress() {
  const routes = [];
  return { routes, Router() { return { get(p, fn) { routes.push(['get', p, fn]); }, post() { routes.push(['post']); }, put() { routes.push(['put']); }, delete() { routes.push(['delete']); }, patch() { routes.push(['patch']); }, use() { routes.push(['use']); } }; } };
}
function call(route, query) {
  return new Promise(resolve => {
    const res = { code: 200, json(b) { resolve({ code: this.code, body: b }); }, status(c) { this.code = c; return this; } };
    route[2]({ query: query || {} }, res);
  });
}

test('the router has one route, GET /, and ?fresh=1 is the only switch', async () => {
  const ex = fakeExpress();
  mod({ express: ex, get: stub(liveMap()), DATA_DIR: tmpDir([]) });
  assert.deepEqual(ex.routes.map(r => r.slice(0, 2)), [['get', '/']]);
  const r = await call(ex.routes[0]);
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.journeys.length, 3);
});

test('an unexpected failure is a plain 500 without the details', async () => {
  const ex = fakeExpress();
  const err = console.error; console.error = () => {};
  try {
    mod({ express: ex, get: async () => { throw new TypeError('secret detail Bearer abc'); }, DATA_DIR: { toString() { throw new Error('boom Bearer abc'); } } });
    const r = await call(ex.routes[0]);
    assert.equal(r.code, 500);
    assert.deepEqual(r.body, { error: 'Internal server error' });
  } finally { console.error = err; }
});
