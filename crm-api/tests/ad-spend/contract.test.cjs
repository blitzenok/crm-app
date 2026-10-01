'use strict';
// The places this feature must agree with code it does not own: the alias table and slug rule of products-api attributionSource, the
// source labels of finance-model, and the server's write path and mount point.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CRM_DIR, PRODUCTS_API, SERVER_FILE, SPEND, ADMODEL, extractFunction, loadOrdersModel, loadJs } = require('./helpers.cjs');
const spendModule = require(SPEND);
const { KNOWN, normalizeSource } = spendModule;
loadOrdersModel();   // crm-app: finance-model.js reaches OrdersModel through the global that orders-model.js sets, so it goes first
const FM = loadJs(path.join(CRM_DIR, 'finance-model.js'));   // first: it registers global.FinanceModel, which adspend-model reads
const AM = loadJs(ADMODEL);

const products = fs.readFileSync(PRODUCTS_API, 'utf8');
const server = fs.readFileSync(SERVER_FILE, 'utf8');

function literalOf(src, name) {
  const at = src.indexOf('const ' + name + ' = Object.assign(Object.create(null), {');
  assert.ok(at !== -1, name + ' not found in products-api.cjs');
  const open = src.indexOf('{', src.indexOf('Object.create(null)', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return new Function('return ' + src.slice(open, i + 1))();
  }
  throw new Error('unbalanced ' + name);
}

test('the spend module carries no synonym table of its own (products-api owns the one for orders)', () => {
  assert.equal(spendModule.ALIAS, undefined);
  assert.equal(/ALIAS|googleads|customerio/.test(fs.readFileSync(SPEND, 'utf8')), false);
});

test('the slug rule equals products-api attrSlug', () => {
  const attrStr = new Function(extractFunction(products, 'function attrStr(v)') + '\nreturn attrStr;')();
  const attrSlug = new Function('attrStr', extractFunction(products, 'function attrSlug(v)') + '\nreturn attrSlug;')(attrStr);
  for (const t of ['Ram', 'Ram Affiliate!!', '  --x--  ', 'a_b.c', 'ÄÖ', 'x'.repeat(60), 'TikTok 2', '', '---', 'a--b', 'FB', 'google ads']) {
    const key = normalizeSource('other:' + t);
    const slug = attrSlug(t);
    if (!slug || slug === 'direct') assert.equal(key, null, JSON.stringify(t));
    else assert.equal(key, KNOWN.includes(slug) ? slug : 'other:' + slug, JSON.stringify(t));
  }
});

test('an order\'s source as products-api writes it lands on the option that collects it: fb / ig / fbclid -> meta, gads / adwords -> google, tt -> tiktok, email -> newsletter', () => {
  const attributionSource = new Function('ATTR_SOURCE_ALIAS', 'ATTR_CLICK', 'ATTR_HOST', 'ATTR_HOST_PREFIX', 'ATTR_PSL', 'ATTR_OWN_HOST', 'ATTR_GOOGLE', 'attrStr', 'attrSlug', 'attrHostStrip', 'attrSecondLabel',
    extractFunction(products, 'function attributionSource(raw)') + '\nreturn attributionSource;');
  const attrStr = new Function(extractFunction(products, 'function attrStr(v)') + '\nreturn attrStr;')();
  const attrSlug = new Function('attrStr', extractFunction(products, 'function attrSlug(v)') + '\nreturn attrSlug;')(attrStr);
  const attrHostStrip = new Function('ATTR_HOST_PREFIX', extractFunction(products, 'function attrHostStrip(host)') + '\nreturn attrHostStrip;')(['mobile.', 'www.', 'lm.', 'm.', 'l.']);
  const attrSecondLabel = new Function('ATTR_PSL', extractFunction(products, 'function attrSecondLabel(host)') + '\nreturn attrSecondLabel;')({});
  const fn = attributionSource(literalOf(products, 'ATTR_SOURCE_ALIAS'), literalOf(products, 'ATTR_CLICK'), {}, [], {}, /$^/, /$^/, attrStr, attrSlug, attrHostStrip, attrSecondLabel);
  const expect = { fb: 'meta', Facebook: 'meta', IG: 'meta', insta: 'meta', instagram: 'meta', meta: 'meta', 'google-ads': 'google', GAds: 'google', adwords: 'google', google: 'google',
    tt: 'tiktok', TIKTOK: 'tiktok', email: 'newsletter', mail: 'newsletter', 'customer.io': 'newsletter', newsletter: 'newsletter' };
  for (const [utm, option] of Object.entries(expect)) {
    const orderSource = fn({ utm_source: utm });
    assert.equal(AM.orderKey({ attribution: { source: orderSource } }), option, 'utm_source=' + utm + ' -> ' + orderSource);
    assert.equal(AM.spendKey({ source: normalizeSource(option) }), option);
  }
  assert.equal(AM.orderKey({ attribution: { source: fn({ click: 'fbclid' }) } }), 'meta', 'a bare fbclid');
  assert.equal(AM.orderKey({ attribution: { source: fn({ click: 'gclid' }) } }), 'google', 'a bare gclid');
  // any other utm_source is its own slug, and other:<the same text> lands on it
  for (const utm of ['ram', 'Ram Affiliate', 'influencer-7']) {
    assert.equal(AM.orderKey({ attribution: { source: fn({ utm_source: utm }) } }), AM.spendKey({ source: normalizeSource('other:' + utm) }), utm);
  }
});

test('every source the form offers is accepted by the server; every finance-model known source is offered, folded into Meta, or refused on purpose (direct)', () => {
  for (const o of AM.SOURCE_OPTIONS) { assert.ok(KNOWN.includes(o.value), o.value + ' is offered by the page but refused by the server'); assert.equal(normalizeSource(o.value), o.value); }
  assert.equal(normalizeSource('direct'), null);
  assert.ok(!AM.SOURCE_OPTIONS.some(o => o.value === 'direct'));
  // finance-model KNOWN_SOURCE is not exported: read its keys from the file text
  const fmText = fs.readFileSync(path.join(CRM_DIR, 'finance-model.js'), 'utf8');
  const keys = [...fmText.slice(fmText.indexOf('var KNOWN_SOURCE = {'), fmText.indexOf('};', fmText.indexOf('var KNOWN_SOURCE = {'))).matchAll(/^\s+(\w+):/gm)].map(m => m[1]);
  assert.ok(keys.length >= 6, 'KNOWN_SOURCE keys found: ' + keys);
  for (const k of keys) {
    if (k === 'direct') continue;
    assert.ok(KNOWN.includes(k), 'finance-model knows ' + k + ' but the spend module does not');
    assert.ok(AM.SOURCE_OPTIONS.some(o => o.value === AM.spendKey({ source: k })), k + ' reaches no offered option');
  }
});

test('the server writes through lockedUpdate(filename, fn, meta) with arrays, and the mount anchor and DATA_DIR are where the patch expects them', () => {
  assert.match(server, /async function lockedUpdate\(filename, fn, meta\) \{/);
  assert.match(server, /fn must return an array/);
  assert.match(server, /if \(success && m\) writeAuditLog\(key, m\.action \|\| "update", m\.user \|\| "system", m\.details/);
  assert.match(server, /const DATA_DIR = path\.join\(__dirname, "data"\);/);
  assert.match(server, /function requireAuth\(req, res, next\) \{/);
  assert.match(server, /req\.userSession = session;/);
  assert.match(server, /app\.use\('\/api\/unit-costs', requireAuth,/, 'the sibling mount the new one copies');
});

test('STAFF_WRITES: no role check exists on the sibling marketing mounts (the owner\'s equal-rights decision), so none is added here', () => {
  assert.match(server, /app\.use\('\/api\/marketing\/journeys', requireAuth, /);
  assert.match(server, /app\.use\('\/api\/marketing\/emails', requireAuth, /);
});

// The real path of a trail: what the storefront's attribution.js sends -> products-api attributionOf (cut out of the file by name, with the
// tables it reads) -> the order record in orders.json -> OrdersModel.load (the patched line of orders-model.js) -> fromPaidLink.
test('contract: attributionOf (products-api) -> OrdersModel.load -> fromPaidLink for what the storefront really sends', () => {
  const tables = products.slice(products.indexOf('const ATTR_SOURCE_ALIAS'), products.indexOf('// Only strings are read from the trail'));
  assert.ok(tables.includes('const ATTR_LANDING'), 'the table block is cut at the right place');
  const code = [tables, 'stripControls(text, keepLineBreaks)', 'cleanStr(v, max)', 'attrStr(v)', 'attrSlug(v)', 'attrHostStrip(host)', 'attrSecondLabel(host)', 'attributionSource(raw)', 'attributionOf(raw)']
    .map((h, i) => i === 0 ? h : extractFunction(products, 'function ' + h)).join('\n');
  const attributionOf = new Function(code + '\nreturn attributionOf;')();
  const OM = loadOrdersModel();
  const AMx = loadJs(ADMODEL);
  const through = trail => {
    const raw = { ref: 'BLR-9001', customer: { email: 'a@x.com' }, savedAt: '2026-09-10T10:00:00Z', total_due_server: '10.00', status: 'new', items: [], attribution: attributionOf(trail),
      payments: [{ id: 'p', at: '2026-09-10T10:00:00Z', kind: 'payment', method: 'card', amount: 10 }] };
    return OM.load([JSON.parse(JSON.stringify(raw))])[0];
  };
  const cases = [
    [{ utm_source: 'fb', utm_medium: 'Paid_Social', utm_campaign: 'x' }, true],
    [{ utm_source: 'google', utm_medium: 'CPC' }, true],
    [{ click: 'fbclid', click_id: 'IwAR0abc' }, true],
    [{ click: 'gclid', click_id: 'Cj0KCQ' }, true],
    [{ click: 'ttclid', click_id: 'E.C.P' }, true],
    [{ click: 'msclkid', click_id: 'abc123' }, true],
    [{ referrer: 'l.facebook.com' }, false],
    [{ utm_source: 'google', utm_medium: 'organic' }, false],
    [{ utm_source: 'newsletter', utm_medium: 'email' }, false],
    [{ utm_source: 'ig', utm_medium: 'non-paid' }, false],
    [{}, false],
    [null, false]
  ];
  for (const [trail, want] of cases) {
    const r = through(trail);
    assert.equal(AMx.fromPaidLink(r), want, JSON.stringify(trail));
  }
  const r = through({ utm_source: 'fb', utm_medium: 'Paid_Social', click: 'fbclid', click_id: 'IwAR0abc' });
  assert.deepEqual([r.attribution.source, r.attribution.medium, r.attribution.click, r.attribution.click_id], ['facebook', 'paid-social', 'fbclid', 'IwAR0abc']);
});
