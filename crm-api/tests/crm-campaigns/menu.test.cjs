'use strict';
// The Campaigns menu item of crm.js (default menu, layouts saved before it still read, the saved layout passes the server's check
// of prefs) and the mount of the module in server_v14.cjs. The deploy patches themselves are tested in biofirst-hosting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// crm-app layout: this file is crm-api/tests/crm-campaigns/. SERVER_FILE / CRM_DIR point at fresh live copies before a deploy.
const SERVER = process.env.SERVER_FILE || path.join(__dirname, '..', '..', 'server_v14.cjs');
const CRM_DIR = process.env.CRM_DIR || path.join(__dirname, '..', '..', '..', 'crm-web');
const CRMJS = path.join(CRM_DIR, 'crm.js');

test('server_v14.cjs: one mount, right after the Journeys block, requireAuth in front, DATA_DIR defined above, nothing but GET in the module', () => {
  const b = fs.readFileSync(SERVER, 'utf8');
  const mount = "app.use('/api/marketing/campaigns', requireAuth, require('./marketing-campaigns.cjs')({ DATA_DIR }));";
  assert.equal(b.split(mount).length, 2);
  assert.ok(b.indexOf("app.use('/api/marketing/journeys'") < b.indexOf(mount));
  assert.ok(b.indexOf(mount) < b.indexOf("app.use('/api/customers'"));
  assert.ok(b.indexOf(mount) < b.indexOf("app.use('/api/unit-costs'"));
  assert.ok(b.indexOf(mount) < b.indexOf("app.use('/api/tasks'"));
  assert.ok(b.indexOf(mount) < b.indexOf('GLOBAL ERROR HANDLER'));
  assert.ok(b.indexOf('const DATA_DIR') < b.indexOf(mount));
  const mod = fs.readFileSync(path.join(__dirname, '..', '..', 'marketing-campaigns.cjs'), 'utf8');
  assert.ok(!/\.(post|put|patch|delete)\(/.test(mod), 'the module registers no write route');
});

// The navigation block of crm.js evaluated on its own: from MSG_BADGE_HTML to `global.CrmNav = CrmNav;`.
function loadNav(src) {
  const a = src.indexOf('var MSG_BADGE_HTML'), endMark = 'global.CrmNav = CrmNav;';
  const b = src.indexOf(endMark);
  assert.ok(a > 0 && b > a);
  const g = {};
  vm.runInNewContext('(function (global) {\n' + src.slice(a, b + endMark.length) + '\n})(g);', { g });
  return g.CrmNav;
}
// "before" is the same file without the Campaigns line: what the menu was before this change
const CAMPAIGNS_LINE = "{ key: 'campaigns', icon: '📣', label: 'Campaigns', m: 1 },";
function patched() {
  const after = fs.readFileSync(CRMJS, 'utf8');
  assert.equal(after.split(CAMPAIGNS_LINE).length, 2, 'crm.js carries the Campaigns menu line once');
  return { before: loadNav(after.replace(CAMPAIGNS_LINE, '')), after: loadNav(after) };
}
// arrays made inside the vm have another realm's prototype; a JSON round trip makes them comparable
const plain = (x) => JSON.parse(JSON.stringify(x));
const keysOf = (layout, id) => plain(layout.groups.find(g => g.id === id).items.map(i => i.key));
const allKeys = (layout) => plain(layout.groups.flatMap(g => g.items.map(i => i.key)));

test('menu: the new item is in the Marketing group of the default menu, after Newsletter', () => {
  const { before, after } = patched();
  const l = after.layout(null);
  const old = keysOf(before.layout(null), 'marketing');
  const now = keysOf(l, 'marketing');
  assert.deepEqual(now.filter(k => k !== 'campaigns'), old, 'the neighbours and their order are as before');
  assert.equal(now[now.indexOf('marketing-newsletter') + 1], 'campaigns');
  const item = l.groups.find(g => g.id === 'marketing').items.find(i => i.key === 'campaigns');
  assert.equal(item.label, 'Campaigns');
  assert.equal(item.m, true);
});

test('menu: a layout saved before the patch still reads, and the new item appears in Marketing once', () => {
  const { before, after } = patched();
  let saved = before.layout(null);
  saved = before.move(saved, 'reports', 'sales', 0);
  saved = before.setHidden(saved, 'store', true);
  saved = before.setCollapsed(saved, 'marketing', false);
  const prefs = JSON.parse(JSON.stringify(before.toPrefs(saved)));
  assert.ok(!JSON.stringify(prefs).includes('campaigns'));
  const l = after.layout(prefs);
  assert.equal(allKeys(l).filter(k => k === 'campaigns').length, 1);
  const m = keysOf(l, 'marketing');
  assert.equal(m.indexOf('campaigns'), m.length - 1, 'a saved order is kept, the newcomer goes last in its group');
  assert.equal(keysOf(l, 'sales')[0], 'reports');
  assert.equal(l.groups.find(g => g.id === 'store').hidden, true);
  assert.equal(l.groups.find(g => g.id === 'marketing').collapsed, false);
  assert.deepEqual(allKeys(l).filter(k => k !== 'campaigns').sort(), allKeys(saved).sort());
});

test('menu: the saved layout of the new menu passes the server check for prefs (key shape and size)', () => {
  const { after } = patched();
  const src = fs.readFileSync(SERVER, 'utf8');
  const i = src.indexOf('function cleanUiNav(');
  assert.ok(i > 0);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  const fn = vm.runInNewContext('(' + src.slice(i, j + 1).replace(/^function cleanUiNav/, 'function') + ')', { Buffer });
  const res = fn(after.toPrefs(after.layout(null)));
  assert.ok(res.nav, JSON.stringify(res));
  assert.ok(res.nav.groups.find(g => g.id === 'marketing').items.includes('campaigns'));
});

test('the menu key is the page name: renderNav("campaigns") in the page and campaigns.html on the server', () => {
  const page = fs.readFileSync(path.join(CRM_DIR, 'campaigns.html'), 'utf8');
  assert.match(page, /renderNav\('campaigns'\);/);
  });
