'use strict';
// The rating letter numbers on the CRM page (crm-web/reviews.html; the deploy patch is tested in biofirst-hosting): the page script
// run in a vm with the real crm-utils.js of the repo: the four numbers, escaping, and a page that has no numbers (older server) drawn as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// crm-app layout: the pages are crm-web/ (CRM_DIR points at fresh live copies before a deploy)
const CRM_DIR = process.env.CRM_DIR || path.join(__dirname, '..', '..', '..', 'crm-web');
const CRM_UTILS = fs.readFileSync(path.join(CRM_DIR, 'crm-utils.js'), 'utf8');
const PATCHED = fs.readFileSync(path.join(CRM_DIR, 'reviews.html'), 'utf8');

function makePage(html, apiImpl) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const els = {};
  const document = { getElementById(id) { return els[id] || (els[id] = { innerHTML: '', textContent: '', style: {}, value: '' }); } };
  const ctx = vm.createContext({ document, console, confirmDialog: async () => true, renderNav() {}, fmtDate: (v) => 'D(' + v + ')', toast() {}, api: async (p, o) => apiImpl(p, o) });
  vm.runInContext(CRM_UTILS, ctx);
  vm.runInContext(blocks[0][1], ctx);
  return { ctx, els };
}
const settle = () => new Promise(r => setImmediate(r));
const DIST = { 1: 0, 2: 0, 3: 1, 4: 2, 5: 3 };
const data = (over) => Object.assign({
  mode: 'on', reviews: [], ratings: [{ id: 'rt_1', ref: 'BLR-1', email: 'ann@realmail.net', rating: 5, comment: '', flags: [], createdAt: '2026-10-03T10:00:00.000Z', updatedAt: '2026-10-03T10:00:00.000Z' }],
  counts: { pending: 0, approved: 0, rejected: 0 }, stats: { count: 6, average: 4.3, distribution: DIST, byMonth: [{ month: '2026-10', count: 6, average: 4.3 }] }
}, over || {});

test('the page draws the four numbers above the ratings; a rate that is not known yet reads n/a; everything is escaped', async () => {
  const page = makePage(PATCHED, async () => data({ ratingLetters: { sent: 8, answered: 6, rate: 75, skippedRated: 2 } }));
  await settle();
  const h = page.els.ratingStats.innerHTML;
  assert.match(h, /Letters sent/);
  assert.match(h, /<div class="v">8<\/div><div class="l">Letters sent<\/div>/);
  assert.match(h, /<div class="v">6<\/div><div class="l">Of those orders rated<\/div>/);
  assert.match(h, /<div class="v">75%<\/div><div class="l">Response rate<\/div>/);
  assert.match(h, /<div class="v">2<\/div><div class="l">Rated before the letter was due/);
  assert.ok(h.indexOf('Letters sent') < h.indexOf('Average rating'), 'the letters come first, then the ratings');
  const none = makePage(PATCHED, async () => data({ ratingLetters: { sent: 0, answered: 0, rate: null, skippedRated: 0 } }));
  await settle();
  assert.match(none.els.ratingStats.innerHTML, /<div class="v">n\/a<\/div><div class="l">Response rate/);
  const evil = makePage(PATCHED, async () => data({ ratingLetters: { sent: '<img src=x onerror=alert(1)>', answered: 1, rate: '<b>', skippedRated: 0 } }));
  await settle();
  assert.equal(/<img/.test(evil.els.ratingStats.innerHTML), false);
  assert.match(evil.els.ratingStats.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(evil.els.ratingStats.innerHTML, /&lt;b&gt;%/);
});

test('an older server answer without the numbers draws the ratings and no letters row; letters show even before the first rating', async () => {
  const now = makePage(PATCHED, async () => data());
  await settle();
  assert.doesNotMatch(now.els.ratingStats.innerHTML, /Letters sent/);
  assert.match(now.els.ratingStats.innerHTML, /Average rating/);
  assert.ok(now.els.ratList.innerHTML.length > 0);
  const empty = makePage(PATCHED, async () => data({ ratings: [], stats: { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, byMonth: [] }, ratingLetters: { sent: 1, answered: 0, rate: 0, skippedRated: 0 } }));
  await settle();
  assert.match(empty.els.ratingStats.innerHTML, /Letters sent/, 'letters are shown even before the first rating');
  assert.match(empty.els.ratingStats.innerHTML, /No ratings yet/);
});
