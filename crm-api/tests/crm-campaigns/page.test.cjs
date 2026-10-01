'use strict';
// The page script of campaigns.html run in a vm with a fake document: escaping of everything that comes from the CRM record
// and from Customer.io, the four states (loading / empty / error / partial), the tiles, the sorting, the file's own rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createCore } = require('../../marketing-campaigns.cjs');

// crm-app layout: this file is crm-api/tests/crm-campaigns/, the pages are crm-web/. CRM_DIR points at fresh live copies before a deploy.
const CRM_DIR = process.env.CRM_DIR || path.join(__dirname, '..', '..', '..', 'crm-web');
const CRM_UTILS = fs.readFileSync(path.join(CRM_DIR, 'crm-utils.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(CRM_DIR, 'campaigns.html'), 'utf8');

function pageScript() {
  const blocks = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'one inline script');
  return blocks[0][1];
}

function makePage(apiImpl) {
  const els = {};
  const listeners = {};
  const document = {
    getElementById(id) { return els[id] || (els[id] = { innerHTML: '', textContent: '', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } }); },
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  const apiCalls = [];
  const ctx = vm.createContext({
    document, console,
    renderNav() {}, fmtDate(v) { return 'D(' + v + ')'; },
    api: async (p, o) => { apiCalls.push(p); return apiImpl(p, o); }
  });
  vm.runInContext(CRM_UTILS, ctx);
  vm.runInContext(pageScript(), ctx);
  return { ctx, els, listeners, apiCalls };
}
const settle = () => new Promise(r => setImmediate(r));
const all = page => Object.values(page.els).map(e => e.innerHTML).join('\n');
const m = (o) => Object.assign({ sent: null, delivered: null, opened: null, clicked: null, unsubscribed: null, bounced: null }, o);

const EVIL = '<img src=x onerror=alert(1)>';

function data(over) {
  const d = {
    ok: true, fetched_at: '2026-10-01T10:00:00.000Z',
    cio: { ok: true, partial: false },
    sources: { newsletters: { ok: true }, broadcasts: { ok: true }, journeys: { ok: true }, transactional: { ok: true } },
    issues: [
      { id: 'nl_1', subject: EVIL, state: 'sent', audience: '"><svg onload=1>', recipients_estimate: 120, sent_at: '2026-09-14T10:00:00.000Z', created_at: null, sent_by: EVIL, unconfirmed: false },
      { id: 'nl_2', subject: 'Draft one', state: 'draft', audience: 'the whole broadcast audience', recipients_estimate: null, sent_at: null, created_at: '2026-09-30T10:00:00.000Z', sent_by: null, unconfirmed: false },
      { id: 'nl_3', subject: 'Stuck', state: 'sending', audience: 'VIP (CRM)', recipients_estimate: 5, sent_at: null, created_at: '2026-09-29T10:00:00.000Z', sent_by: null, unconfirmed: true }
    ], issues_total: 3,
    broadcasts: [
      { id: '11', name: EVIL, state: '', is_crm_newsletter: true, updated: null, edit_url: 'javascript:alert(3)', metrics30d: m({ sent: 10, delivered: 9, opened: 4, clicked: 2, unsubscribed: 1, bounced: 1 }) },
      { id: '15', name: 'Other', state: '', is_crm_newsletter: false, updated: null, edit_url: 'https://fly.customer.io/workspaces/231885/journeys/broadcasts/broadcast/15/overview', metrics30d: null }
    ], broadcasts_total: 2,
    journeys: [
      { id: '4', name: 'Welcome', state: 'running', running: true, trigger: { kind: 'event', event_name: 'subscribed', segment_ids: [], type: '' }, updated: '2026-09-30T10:00:00.000Z', edit_url: 'https://fly.customer.io/workspaces/231885/journeys/automations/4/setup/workflow/actions', metrics30d: m({ sent: 0, delivered: 0 }) },
      { id: '10', name: 'Replenishment', state: 'draft', running: false, trigger: { kind: 'segment', event_name: '', segment_ids: ['3', '4'], type: '' }, updated: null, edit_url: null, metrics30d: m({ sent: 20, delivered: 18, opened: 6, clicked: 3, unsubscribed: 0, bounced: 2 }) },
      { id: '12', name: 'Other trigger', state: 'stopped', running: false, trigger: { kind: 'other', event_name: '', segment_ids: [], type: '"><script>alert(2)</script>' }, updated: null, edit_url: null, metrics30d: null }
    ], journeys_total: 3,
    transactional: [
      { id: '3', name: 'order-customer', metrics30d: m({ sent: 5, delivered: 4, opened: 3 }) },
      { id: '1', name: EVIL, metrics30d: null }
    ], transactional_total: 2
  };
  return Object.assign(d, over || {});
}

function rowsOf(html) { return [...html.matchAll(/<tr><td[^>]*>([\s\S]*?)<\/td>/g)].map(r => r[1].replace(/<[^>]*>/g, '')); }

test('everything from the CRM record and Customer.io is escaped; a javascript: link is dropped', async () => {
  const page = makePage(async () => data());
  await settle();
  const out = all(page);
  for (const bad of ['<img', '<script', '<svg', 'href="javascript', 'href=javascript', '"><svg', '"><script']) assert.ok(!out.includes(bad), 'raw ' + bad);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(out.includes('&lt;svg onload=1&gt;'));
  assert.ok(out.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
  // the link of the first broadcast was javascript: and is gone, the good one on the second row stays
  assert.equal((page.els.broadcasts.innerHTML.match(/Open in Customer\.io/g) || []).length, 1);
  assert.match(page.els.broadcasts.innerHTML, /href="https:\/\/fly\.customer\.io\/workspaces\/231885\/journeys\/broadcasts\/broadcast\/15\/overview" target="_blank" rel="noopener noreferrer">Open in Customer\.io/);
});

test('the four sections show what the brief asks for: names, state, trigger, numbers, links', async () => {
  const page = makePage(async () => data());
  await settle();
  const i = page.els.issues.innerHTML;
  assert.match(i, /<th[^>]*>Subject<\/th>/);
  assert.match(i, /Addresses \(estimate\)/);
  assert.match(i, /<span class="badge badge-sent">sent<\/span>/);
  assert.match(i, /not sent/);
  assert.match(i, /Customer\.io did not confirm this send/);
  assert.equal(page.els.issuesCount.textContent, '3');

  const b = page.els.broadcasts.innerHTML;
  assert.match(b, /CRM newsletter/);
  assert.equal(page.els.broadcastsCount.textContent, '2');

  const j = page.els.journeys.innerHTML;
  assert.match(j, /subscribed/);
  assert.match(j, /a person joins segment #3, segment #4/);
  assert.match(j, /href="https:\/\/fly\.customer\.io\/workspaces\/231885\/journeys\/automations\/4\/setup\/workflow\/actions"/);
  assert.match(j, /<span class="badge badge-sent">running<\/span>/);
  assert.match(j, /<span class="badge badge-none">draft<\/span>/);
  for (const col of ['Sent', 'Delivered', 'Opened', 'Clicked', 'Unsub', 'Bounced']) assert.match(j, new RegExp('>' + col + '<'));
  assert.equal(page.els.journeysCount.textContent, '3');

  const t = page.els.transactional.innerHTML;
  assert.equal((t.match(/href="marketing-emails\.html">Edit text/g) || []).length, 2);
  assert.equal(page.els.transactionalCount.textContent, '2');
  assert.equal(page.els.fetchedAt.textContent, 'Read D(2026-10-01T10:00:00.000Z)');
  // every cell of a body row carries its column name for the phone layout
  assert.match(j, /<td class="num" data-label="Sent">/);
});

test('a metric that is missing prints a dash, a real zero prints 0', async () => {
  const page = makePage(async () => data());
  await settle();
  const j = page.els.journeys.innerHTML;
  assert.match(j, /data-label="Sent">0<\/td><td class="num" data-label="Delivered">0<\/td><td class="num" data-label="Opened">—<\/td>/);
  assert.match(page.els.broadcasts.innerHTML, /data-label="Sent">—<\/td>/);
});

test('tiles: sums over what could be read, a dash when nothing was, rates under the numbers', async () => {
  const page = makePage(async () => data());
  await settle();
  const t = page.els.tiles.innerHTML;
  const tile = label => { const x = t.match(new RegExp('<div class="tv">([^<]*)</div><div class="tl">' + label + '</div><div class="ts">([^<]*)</div>')); assert.ok(x, label); return [x[1], x[2]]; };
  assert.deepEqual(tile('Newsletters sent'), ['1', 'all time']);
  assert.deepEqual(tile('Journeys running'), ['1', 'of 3']);
  assert.deepEqual(tile('Sent, 30 days'), ['35', '']);        // 10 + 0 + 20 + 5
  assert.deepEqual(tile('Delivered'), ['31', '88.6% of sent']); // 9 + 0 + 18 + 4
  assert.deepEqual(tile('Opened'), ['13', '41.9% of delivered']);
  assert.deepEqual(tile('Clicked'), ['5', '16.1% of delivered']);
  assert.deepEqual(tile('Unsubscribed'), ['1', '']);
  assert.deepEqual(tile('Bounced'), ['3', '8.6% of sent']);

  const none = makePage(async () => data({ journeys: [], broadcasts: [], transactional: [], issues: [], issues_total: 0 }));
  await settle();
  assert.match(none.els.tiles.innerHTML, /<div class="tv">—<\/div><div class="tl">Sent, 30 days<\/div>/);
  assert.match(none.els.tiles.innerHTML, /<div class="tv">—<\/div><div class="tl">Opened<\/div><div class="ts"><\/div>/);
});

test('one source down: the banner names it with the reason, its section says so, the others are shown', async () => {
  const d = data({ journeys: null, journeys_total: 0, sources: { newsletters: { ok: true }, broadcasts: { ok: true }, journeys: { ok: false, error: 'Customer.io is not answering (HTTP 500)' }, transactional: { ok: true } }, cio: { ok: true, partial: true } });
  const page = makePage(async () => d);
  await settle();
  assert.match(page.els.banner.innerHTML, /banner-error/);
  assert.match(page.els.banner.innerHTML, /One part could not be read/);
  assert.match(page.els.banner.innerHTML, /Journeys: Customer\.io is not answering \(HTTP 500\)/);
  assert.match(page.els.journeys.innerHTML, /gap bad">Not available: Customer\.io is not answering \(HTTP 500\)/);
  assert.equal(page.els.journeysCount.textContent, '—');
  assert.match(page.els.broadcasts.innerHTML, /CRM newsletter/);
  assert.match(page.els.transactional.innerHTML, /order-customer/);
  assert.match(page.els.issues.innerHTML, /Draft one/);
  assert.match(page.els.tiles.innerHTML, /without the sections not read/);
});

test('the newsletter record unreadable: that section says why, Customer.io sections stay', async () => {
  const d = data({ issues: null, issues_total: 0, sources: { newsletters: { ok: false, error: 'marketing-newsletters.json is not readable JSON' }, broadcasts: { ok: true }, journeys: { ok: true }, transactional: { ok: true } } });
  const page = makePage(async () => d);
  await settle();
  assert.match(page.els.banner.innerHTML, /Newsletters from the CRM: marketing-newsletters\.json is not readable JSON/);
  assert.match(page.els.issues.innerHTML, /Not available: marketing-newsletters\.json is not readable JSON/);
  assert.equal(page.els.issuesCount.textContent, '—');
  assert.match(page.els.journeys.innerHTML, /Welcome/);
});

test('Customer.io down entirely: three reasons in the banner, the CRM record still on the page', async () => {
  const why = 'Customer.io rejected the API key (HTTP 401)';
  const d = data({ cio: { ok: false, error: why }, broadcasts: null, journeys: null, transactional: null, sources: { newsletters: { ok: true }, broadcasts: { ok: false, error: why }, journeys: { ok: false, error: why }, transactional: { ok: false, error: why } } });
  const page = makePage(async () => d);
  await settle();
  assert.match(page.els.banner.innerHTML, /Some parts could not be read/);
  assert.equal((page.els.banner.innerHTML.match(/rejected the API key/g) || []).length, 3);
  assert.match(page.els.issues.innerHTML, /Draft one/);
  assert.match(page.els.journeys.innerHTML, /Not available/);
});

test('empty states: an honest empty list says so in words', async () => {
  const page = makePage(async () => data({ issues: [], issues_total: 0, broadcasts: [], broadcasts_total: 0, journeys: [], journeys_total: 0, transactional: [], transactional_total: 0 }));
  await settle();
  assert.match(page.els.issues.innerHTML, /No newsletter has been written yet\./);
  assert.match(page.els.broadcasts.innerHTML, /No broadcasts in this workspace\./);
  assert.match(page.els.journeys.innerHTML, /No journeys in this workspace yet\./);
  assert.match(page.els.transactional.innerHTML, /No service letters in this workspace\./);
  assert.equal(page.els.banner.innerHTML, '');
});

test('loading: the first paint says Loading, in every section, before the data comes', () => {
  assert.equal((PAGE.match(/<div class="gap">Loading&hellip;<\/div>/g) || []).length, 4);
  assert.match(PAGE, /<div class="tiles" id="tiles"><div class="muted">Loading&hellip;<\/div><\/div>/);
});

test('partial answer, throttled Refresh and lists cut at the limit get their notices', async () => {
  let page = makePage(async () => data({ cio: { ok: true, partial: true } }));
  await settle();
  assert.match(page.els.banner.innerHTML, /Some numbers could not be read from Customer\.io just now and show as a dash/);
  page = makePage(async () => data({ throttled: true, refresh_in_s: 17, journeys_total: 45, transactional_total: 31 }));
  await settle();
  assert.match(page.els.banner.innerHTML, /less than 30 seconds ago\. Refresh again in 17 s/);
  assert.match(page.els.banner.innerHTML, /Showing journeys: 3 of 45; service letters: 2 of 31/);
  const plain = makePage(async () => data());
  await settle();
  assert.equal(plain.els.banner.innerHTML, '');
});

test('a failed request to the CRM itself is a banner, not an empty page', async () => {
  const page = makePage(async () => { throw Object.assign(new Error('Session <b>gone</b>'), { status: 500 }); });
  await settle();
  assert.match(page.els.banner.innerHTML, /Session &lt;b&gt;gone&lt;\/b&gt;/);
});

test('a failed first request: tiles and every table say Not available, nobody is left on Loading', async () => {
  const page = makePage(async () => { throw new Error('Server unavailable'); });
  await settle();
  assert.match(page.els.tiles.innerHTML, /Not available: Server unavailable/);
  for (const id of ['issues', 'broadcasts', 'journeys', 'transactional']) {
    assert.match(page.els[id].innerHTML, /gap bad">Not available: Server unavailable/, id);
    assert.ok(!/Loading/.test(page.els[id].innerHTML), id);
  }
  assert.ok(!/Loading/.test(page.els.tiles.innerHTML));
  assert.match(page.els.banner.innerHTML, /Server unavailable/);
});

test('a failed first request does not cost the default sort: the first good Refresh sorts as it would have', async () => {
  let fail = true;
  const page = makePage(async () => { if (fail) throw new Error('Server unavailable'); return data(); });
  await settle();
  fail = false;
  await page.ctx.loadAll(true);
  assert.deepEqual(rowsOf(page.els.journeys.innerHTML), ['Replenishment', 'Welcome', 'Other trigger']);   // most sent first
  assert.match(page.els.journeys.innerHTML, /sort-desc" data-sort="sent"/);
  assert.deepEqual(rowsOf(page.els.issues.innerHTML).map(s => s.slice(0, 5)), ['&lt;i', 'Draft', 'Stuck']);
});

test('a failed Refresh after a good load keeps what was shown and says so in the banner', async () => {
  let fail = false;
  const page = makePage(async () => { if (fail) throw new Error('Session expired'); return data(); });
  await settle();
  fail = true;
  await page.ctx.loadAll(true);
  assert.match(page.els.banner.innerHTML, /Session expired/);
  assert.match(page.els.journeys.innerHTML, /Welcome series|Welcome/);
  assert.ok(!/Not available/.test(page.els.journeys.innerHTML));
});

test('the Refresh button is disabled while a request runs and enabled again after it, success or failure', async () => {
  let release;
  let page;
  const gate = () => new Promise(r => { release = r; });
  let mode = 'ok';
  page = makePage(async () => { await gate(); if (mode === 'fail') throw new Error('x'); return data(); });
  await settle();
  assert.equal(page.els.refreshBtn.disabled, true, 'disabled during the first load');
  release(); await settle();
  assert.equal(page.els.refreshBtn.disabled, false);
  mode = 'fail';
  const p = page.ctx.loadAll(true);
  assert.equal(page.els.refreshBtn.disabled, true);
  release(); await p;
  assert.equal(page.els.refreshBtn.disabled, false, 'also after a failure');
});

test('the first load is cached by the server, the Refresh button asks for ?fresh=1', async () => {
  const page = makePage(async () => data());
  await settle();
  page.els.refreshBtn.listeners.click();
  await settle();
  assert.deepEqual(page.apiCalls, ['/api/marketing/campaigns', '/api/marketing/campaigns?fresh=1']);
});

/* ── sorting ──────────────────────────────────────────────────────────────────────────────── */

function clickHeader(page, table, key) {
  const th = { getAttribute: k => ({ 'data-sort': key, 'data-table': table })[k] };
  page.listeners.click({ target: { closest: () => th } });
}

test('sorting: a click on a header sorts, a second click turns it round, empty values stay last either way', async () => {
  const page = makePage(async () => data());
  await settle();
  // default: most sent first, the row without numbers last
  assert.deepEqual(rowsOf(page.els.journeys.innerHTML), ['Replenishment', 'Welcome', 'Other trigger']);
  clickHeader(page, 'journeys', 'name');                       // first click: descending
  assert.deepEqual(rowsOf(page.els.journeys.innerHTML), ['Welcome', 'Replenishment', 'Other trigger']);
  clickHeader(page, 'journeys', 'name');                       // second: ascending
  assert.deepEqual(rowsOf(page.els.journeys.innerHTML), ['Other trigger', 'Replenishment', 'Welcome']);
  assert.match(page.els.journeys.innerHTML, /<th class="sortable sort-asc" data-sort="name"/);
  clickHeader(page, 'journeys', 'opened');                     // empty cells are last whatever the direction
  assert.deepEqual(rowsOf(page.els.journeys.innerHTML), ['Replenishment', 'Welcome', 'Other trigger']);
  clickHeader(page, 'journeys', 'opened');
  assert.deepEqual(rowsOf(page.els.journeys.innerHTML), ['Replenishment', 'Welcome', 'Other trigger']);
  // the other tables are not touched
  assert.deepEqual(rowsOf(page.els.transactional.innerHTML).slice(0, 1), ['order-customer']);
});

test('sorting: dates sort as dates, the estimate sorts as a number, and the order survives a Refresh', async () => {
  const page = makePage(async () => data());
  await settle();
  assert.deepEqual(rowsOf(page.els.issues.innerHTML).map(s => s.slice(0, 5)), ['&lt;i', 'Draft', 'Stuck']);   // sent date, newest first; the unsent keep the server's order (newest written first)
  clickHeader(page, 'issues', 'recipients_estimate');
  assert.deepEqual(rowsOf(page.els.issues.innerHTML).map(s => s.slice(0, 5)), ['&lt;i', 'Stuck', 'Draft']);   // 120, 5, none
  clickHeader(page, 'issues', 'recipients_estimate');
  assert.deepEqual(rowsOf(page.els.issues.innerHTML).map(s => s.slice(0, 5)), ['Stuck', '&lt;i', 'Draft']);   // 5, 120, none
  await page.ctx.loadAll(true);
  assert.deepEqual(rowsOf(page.els.issues.innerHTML).map(s => s.slice(0, 5)), ['Stuck', '&lt;i', 'Draft'], 'a Refresh keeps the chosen order');
});

test('sorting: a click that is not on a sortable header changes nothing; link columns are not sortable', async () => {
  const page = makePage(async () => data());
  await settle();
  const before = page.els.journeys.innerHTML;
  page.listeners.click({ target: { closest: () => null } });
  assert.equal(page.els.journeys.innerHTML, before);
  assert.match(before, /<th class=""><\/th>/);   // the link column: no data-sort
  assert.equal((before.match(/data-sort="/g) || []).length, 10);
});

/* ── the file's own rules ─────────────────────────────────────────────────────────────────── */

test('the file: no class or id starts with ad-/ads- (ad blockers hide them), no inline handlers but the phone button, no images, no emoji', () => {
  for (const m of PAGE.matchAll(/(?:class|id)="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) assert.ok(!/^ads?-/.test(c), c);
  for (const m of PAGE.matchAll(/\.(ads?-[\w-]*)\{/g)) assert.fail(m[1]);
  assert.deepEqual([...PAGE.matchAll(/\son[a-z]+="/g)].map(m => m[0].trim()), ['onclick="'], 'only the phone button of the neighbouring pages');
  assert.ok(!/<img\b/i.test(PAGE));
  assert.ok(!/url\((?!['"]?data:)/.test(PAGE), 'no images from outside');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(PAGE), 'no emoji');
  assert.ok(!/POST|PUT|DELETE|PATCH/.test(pageScript()), 'the page reads only');
  assert.equal((pageScript().match(/\bapi\(/g) || []).length, 1);
  assert.ok(pageScript().includes("api('/api/marketing/campaigns' + (fresh ? '?fresh=1' : ''), { toast: false })"));
  assert.ok(!/fetch\(|XMLHttpRequest/.test(pageScript()));
});

test('page and API fit together: the keys the script reads are the keys the module answers with', async () => {
  const get = async p => {
    const map = {
      '/v1/campaigns': { status: 200, data: { campaigns: [{ id: 4, name: 'Welcome', event_name: 'subscribed', state: 'running' }] } },
      '/v1/broadcasts': { status: 200, data: { broadcasts: [{ id: 11, name: 'CRM Newsletter' }] } },
      '/v1/transactional': { status: 200, data: { messages: [{ id: 3, name: 'order-customer' }] } }
    };
    const full = { metric: { series: { created: [4], delivered: [3], human_opened: [2], human_clicked: [1], unsubscribed: [0], bounced: [1] } } };
    return map[p] || { status: 200, data: full };
  };
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'crm-campaigns-page-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'marketing-newsletters.json'), JSON.stringify([{ id: 'nl_1', subject: 'Hello', state: 'sent', audience: { type: 'segment', segment_name: 'Buyers' }, sent_at: '2026-09-14T10:00:00.000Z', recipients_estimate: 7 }]));
  const real = JSON.parse(JSON.stringify(await createCore({ get, DATA_DIR: dir, broadcastId: '11', workspaceId: '231885' }).load(false)));
  const page = makePage(async () => real);
  await settle();
  assert.equal(page.els.banner.innerHTML, '');
  assert.match(page.els.issues.innerHTML, /Hello[\s\S]*Buyers[\s\S]*>7</);
  assert.match(page.els.broadcasts.innerHTML, /CRM newsletter/);
  assert.match(page.els.journeys.innerHTML, /subscribed[\s\S]*data-label="Sent">4</);
  assert.match(page.els.transactional.innerHTML, /order-customer/);
  assert.match(page.els.tiles.innerHTML, /<div class="tv">12<\/div><div class="tl">Sent, 30 days/);
});
